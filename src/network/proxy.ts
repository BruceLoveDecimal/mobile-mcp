/**
 * An HTTP proxy that records what passes through it, for one device.
 *
 * The device is pointed at it (android-proxy.ts), so every request an app makes through the system proxy is
 * seen here. Plain HTTP is recorded in full: method, URL, headers, and bounded request and response bodies.
 * HTTPS arrives as CONNECT: by default it is tunnelled as is and only the host, port, bytes and timing are
 * recorded; with `decryptHttps` the proxy terminates TLS with a certificate from the capture CA and records
 * the requests inside like plain HTTP. That only works for apps that trust the CA (installed on the device
 * and, on Android 7+, allowed by the app's network security config); an app that does not trust it fails
 * its TLS handshakes, which is recorded too.
 *
 * Entries follow opencli-mcp's network capture (`network_inspect`): the same summary and detail shape, so a
 * caller reads both the same way. Forwarded requests ask for identity encoding so bodies are readable; the
 * app sees the same content, only uncompressed.
 */

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { CertificateAuthority } from "./ca";

export interface NetworkEntry {
	seq: number;
	requestId: string;
	url: string;
	method: string;
	status?: number;
	contentType?: string;
	/** `http` for a request seen in full (plain or decrypted), `tls` for an opaque HTTPS tunnel. */
	resourceType: "http" | "tls";
	/** Milliseconds since the epoch when the request started. */
	timestamp: number;
	completed: boolean;
	durationMs?: number;
	requestHeaders: Record<string, string>;
	responseHeaders: Record<string, string>;
	requestBodyPreview: string;
	requestBodyFullSize: number;
	requestBodyTruncated: boolean;
	responsePreview: string;
	responseBodyFullSize: number;
	responseBodyTruncated: boolean;
	/** Why the request did not complete normally: an upstream error, or a TLS handshake the app refused. */
	error?: string;
}

export interface ProxyOptions {
	/** Terminate TLS with certificates from `ca` and record HTTPS requests in full. */
	decryptHttps?: boolean;
	ca?: CertificateAuthority;
	/** Oldest entries are dropped past this many. */
	maxEntries?: number;
	/** Bytes of each body kept for the preview. */
	maxBodyBytes?: number;
	/** CA certificates (PEM) to trust for upstream HTTPS besides the system's; tests use it for a local server. */
	upstreamCa?: string[];
}

export interface ListOptions {
	filter?: string;
	afterSequence?: number;
	limit?: number;
}

export interface DetailOptions {
	seq: number;
	part?: "request" | "response";
	start?: number;
	maxChars?: number;
}

export interface ProxyStats {
	entries: number;
	/** HTTPS connections passed through without decryption. */
	tlsTunnels: number;
	/** Decrypted HTTPS connections the app closed during the handshake: it does not trust the CA. */
	tlsHandshakeFailures: number;
}

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const HOP_BY_HOP = new Set(["proxy-connection", "proxy-authorization", "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade"]);
const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql|problem\+json|ld\+json|x-ndjson)|.*\+(json|xml)$)/i;

/** opencli-mcp's `networkSummary`, so a caller reads both captures the same way. */
export function networkSummary(e: NetworkEntry) {
	return {
		seq: e.seq,
		requestId: e.requestId,
		url: e.url,
		method: e.method,
		status: e.status,
		contentType: e.contentType,
		resourceType: e.resourceType,
		timestamp: e.timestamp,
		completed: e.completed,
		durationMs: e.durationMs,
		requestBytes: e.requestBodyFullSize,
		responseBytes: e.responseBodyFullSize,
		responseTruncated: e.responseBodyTruncated,
		requestTruncated: e.requestBodyTruncated,
		...(e.error && { error: e.error }),
	};
}

/** opencli-mcp's `networkDetail`: headers and one bounded body, paged with `start` / `nextStart`. */
export function networkDetail(e: NetworkEntry, opts: Omit<DetailOptions, "seq"> = {}) {
	const part = opts.part ?? "response";
	const raw = part === "request" ? e.requestBodyPreview : e.responsePreview;
	const fullSize = part === "request" ? e.requestBodyFullSize : e.responseBodyFullSize;
	const start = Math.min(Math.max(0, opts.start ?? 0), raw.length);
	const maxChars = Math.min(Math.max(200, opts.maxChars ?? 8_000), 100_000);
	const nextStart = start + maxChars < raw.length ? start + maxChars : undefined;
	return {
		...networkSummary(e),
		requestHeaders: e.requestHeaders,
		responseHeaders: e.responseHeaders,
		body: {
			part,
			text: raw.slice(start, start + maxChars),
			start,
			...(nextStart !== undefined && { nextStart }),
			fullSize,
			captureTruncated: part === "request" ? e.requestBodyTruncated : e.responseBodyTruncated,
		},
	};
}

const flatHeaders = (headers: http.IncomingHttpHeaders): Record<string, string> => {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined) {
			continue;
		}

		out[name] = Array.isArray(value) ? value.join(", ") : String(value);
	}

	return out;
};

/** Collects a body up to a cap and renders the preview once it is complete. */
class BodyCollector {
	private chunks: Buffer[] = [];
	private kept = 0;
	size = 0;

	constructor(private readonly cap: number) {}

	push(chunk: Buffer): void {
		this.size += chunk.length;
		if (this.kept >= this.cap) {
			return;
		}

		const room = this.cap - this.kept;
		const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
		this.chunks.push(piece);
		this.kept += piece.length;
	}

	get truncated(): boolean {
		return this.size > this.kept;
	}

	preview(contentType: string | undefined): string {
		if (this.size === 0) {
			return "";
		}

		const type = (contentType ?? "").split(";")[0].trim();
		if (type && !TEXT_TYPES.test(type)) {
			return `(binary ${type}, ${this.size} bytes)`;
		}

		return Buffer.concat(this.chunks).toString("utf8");
	}
}

interface TargetSocket extends net.Socket {
	/** Set on a decrypted TLS socket: the host and port the app connected to. */
	__proxyTarget?: { host: string, port: number };
}

export class CaptureProxy {
	private readonly server: http.Server;
	/** Serves the requests inside decrypted TLS connections; never listens on a port. */
	private readonly inner: http.Server;
	private readonly entries: NetworkEntry[] = [];
	private readonly sockets = new Set<net.Socket>();
	private seq = 0;
	private counter = 0;
	port = 0;
	readonly stats: ProxyStats = { entries: 0, tlsTunnels: 0, tlsHandshakeFailures: 0 };
	readonly decryptHttps: boolean;

	constructor(private readonly options: ProxyOptions = {}) {
		this.decryptHttps = Boolean(options.decryptHttps && options.ca);
		this.server = http.createServer((req, res) => this.onRequest(req, res));
		this.server.on("connect", (req, socket, head) => this.onConnect(req, socket as net.Socket, head));
		this.server.on("connection", socket => this.track(socket));
		this.inner = http.createServer((req, res) => this.onRequest(req, res));
		// Node closes idle keep-alive connections after 5 s by default; apps keep theirs open much longer.
		this.server.keepAliveTimeout = 60_000;
		this.inner.keepAliveTimeout = 60_000;
	}

	/** Listen on a free localhost port; returns it. */
	async start(): Promise<number> {
		await new Promise<void>((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(0, "127.0.0.1", () => {
				this.server.off("error", reject);
				resolve();
			});
		});
		this.port = (this.server.address() as net.AddressInfo).port;
		return this.port;
	}

	async stop(): Promise<void> {
		for (const socket of this.sockets) {
			socket.destroy();
		}

		this.sockets.clear();
		await Promise.all([
			new Promise<void>(resolve => this.server.close(() => resolve())),
			new Promise<void>(resolve => this.inner.close(() => resolve())),
		]);
	}

	list(opts: ListOptions = {}) {
		const limit = Math.min(Math.max(1, opts.limit ?? 30), 100);
		const filter = opts.filter?.toLowerCase();
		const after = opts.afterSequence ?? 0;
		const matching = this.entries.filter(e => e.seq > after && (!filter || e.url.toLowerCase().includes(filter)));
		const entries = matching.slice(-limit);
		return {
			entries: entries.map(networkSummary),
			total: matching.length,
			cursor: this.seq,
			...(matching.length > entries.length && { truncated: true }),
		};
	}

	detail(opts: DetailOptions) {
		const entry = this.entries.find(e => e.seq === opts.seq);
		if (!entry) {
			return undefined;
		}

		return networkDetail(entry, opts);
	}

	clear(): number {
		const dropped = this.entries.length;
		this.entries.length = 0;
		this.stats.entries = 0;
		return dropped;
	}

	private track(socket: net.Socket): void {
		this.sockets.add(socket);
		socket.once("close", () => this.sockets.delete(socket));
	}

	private record(partial: Pick<NetworkEntry, "url" | "method" | "resourceType"> & Partial<NetworkEntry>): NetworkEntry {
		const entry: NetworkEntry = {
			seq: ++this.seq,
			requestId: `r${++this.counter}`,
			timestamp: Date.now(),
			completed: false,
			requestHeaders: {},
			responseHeaders: {},
			requestBodyPreview: "",
			requestBodyFullSize: 0,
			requestBodyTruncated: false,
			responsePreview: "",
			responseBodyFullSize: 0,
			responseBodyTruncated: false,
			...partial,
		};
		this.entries.push(entry);
		const max = this.options.maxEntries ?? DEFAULT_MAX_ENTRIES;
		if (this.entries.length > max) {
			this.entries.splice(0, this.entries.length - max);
		}

		this.stats.entries = this.entries.length;
		return entry;
	}

	private finish(entry: NetworkEntry, error?: string): void {
		entry.completed = true;
		entry.durationMs = Date.now() - entry.timestamp;
		if (error) {
			entry.error = error;
		}
	}

	/** A plain proxy request (absolute URL), or one inside a decrypted TLS connection (path only). */
	private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
		const target = (req.socket as TargetSocket).__proxyTarget;
		let url: URL;
		try {
			url = target
				? new URL(req.url ?? "/", `https://${target.host}${target.port === 443 ? "" : `:${target.port}`}`)
				: new URL(req.url ?? "");
		} catch {
			res.writeHead(400).end("mobile-mcp capture proxy: absolute URL required");
			return;
		}

		const cap = this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
		const entry = this.record({ url: url.href, method: req.method ?? "GET", resourceType: "http", requestHeaders: flatHeaders(req.headers) });
		const requestBody = new BodyCollector(cap);
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(entry.requestHeaders)) {
			if (!HOP_BY_HOP.has(name)) {
				headers[name] = value;
			}
		}

		// identity keeps response bodies readable; the app gets the same content uncompressed
		headers["accept-encoding"] = "identity";
		const transport = url.protocol === "https:" ? https : http;
		const upstream = transport.request(url, {
			method: req.method,
			headers,
			...(url.protocol === "https:" && this.options.upstreamCa && { ca: [...tls.rootCertificates, ...this.options.upstreamCa] }),
		});
		upstream.on("response", response => {
			entry.status = response.statusCode;
			entry.responseHeaders = flatHeaders(response.headers);
			entry.contentType = response.headers["content-type"];
			const responseBody = new BodyCollector(cap);
			response.on("data", (chunk: Buffer) => responseBody.push(chunk));
			response.on("end", () => {
				entry.responsePreview = responseBody.preview(entry.contentType);
				entry.responseBodyFullSize = responseBody.size;
				entry.responseBodyTruncated = responseBody.truncated;
				this.finish(entry);
			});
			// hop-by-hop headers describe the upstream connection, not this one: Node frames the reply itself
			const responseHeaders: http.OutgoingHttpHeaders = {};
			for (const [name, value] of Object.entries(response.headers)) {
				if (value !== undefined && !HOP_BY_HOP.has(name) && name !== "content-encoding") {
					responseHeaders[name] = value;
				}
			}

			res.writeHead(response.statusCode ?? 502, response.statusMessage, responseHeaders);
			response.pipe(res);
		});
		upstream.on("error", error => {
			this.finish(entry, `${(error as NodeJS.ErrnoException).code ?? "upstream_error"}: ${error.message}`);
			if (!res.headersSent) {
				res.writeHead(502, { "content-type": "text/plain" });
			}

			res.end(`mobile-mcp capture proxy: ${error.message}`);
		});
		req.on("data", (chunk: Buffer) => requestBody.push(chunk));
		req.on("end", () => {
			entry.requestBodyPreview = requestBody.preview(entry.requestHeaders["content-type"]);
			entry.requestBodyFullSize = requestBody.size;
			entry.requestBodyTruncated = requestBody.truncated;
		});
		req.on("aborted", () => {
			upstream.destroy();
			if (!entry.completed) {
				this.finish(entry, "client_aborted");
			}
		});
		req.pipe(upstream);
	}

	/** HTTPS: decrypt when configured, else tunnel bytes and record only the connection. */
	private onConnect(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
		const [hostPart, portPart] = (req.url ?? "").split(":");
		const host = hostPart || "";
		const port = Number(portPart) || 443;
		if (!host) {
			socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
			return;
		}

		if (this.decryptHttps && this.options.ca) {
			this.decrypt(host, port, socket, head);
			return;
		}

		this.tunnel(host, port, socket, head);
	}

	private tunnel(host: string, port: number, socket: net.Socket, head: Buffer): void {
		const entry = this.record({ url: `https://${host}${port === 443 ? "" : `:${port}`}`, method: "CONNECT", resourceType: "tls" });
		this.stats.tlsTunnels++;
		const upstream = net.connect(port, host);
		this.track(upstream);
		upstream.once("connect", () => {
			entry.status = 200;
			socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length) {
				upstream.write(head);
				entry.requestBodyFullSize += head.length;
			}

			socket.on("data", (chunk: Buffer) => {
				entry.requestBodyFullSize += chunk.length;
			});
			upstream.on("data", (chunk: Buffer) => {
				entry.responseBodyFullSize += chunk.length;
			});
			socket.pipe(upstream);
			upstream.pipe(socket);
		});
		const done = (error?: Error) => {
			if (!entry.completed) {
				this.finish(entry, error ? `${(error as NodeJS.ErrnoException).code ?? "tunnel_error"}: ${error.message}` : undefined);
			}

			socket.destroy();
			upstream.destroy();
		};
		upstream.on("error", error => {
			if (!socket.destroyed && entry.status === undefined) {
				socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
			}

			done(error);
		});
		upstream.on("close", () => done());
		socket.on("error", () => done());
		socket.on("close", () => done());
	}

	private decrypt(host: string, port: number, socket: net.Socket, head: Buffer): void {
		const ca = this.options.ca!;
		socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		if (head.length) {
			socket.unshift(head);
		}

		const tlsSocket: TargetSocket = new tls.TLSSocket(socket, {
			isServer: true,
			secureContext: ca.contextFor(host),
			SNICallback: (servername, callback) => callback(null, ca.contextFor(servername || host)),
			ALPNProtocols: ["http/1.1"],
		});
		tlsSocket.__proxyTarget = { host, port };
		this.track(tlsSocket);
		let secure = false;
		tlsSocket.once("secure", () => {
			secure = true;
		});
		const refused = () => {
			if (secure) {
				return;
			}

			// The app saw our certificate and hung up: it does not trust the capture CA.
			this.stats.tlsHandshakeFailures++;
			const entry = this.record({ url: `https://${host}${port === 443 ? "" : `:${port}`}`, method: "CONNECT", resourceType: "tls" });
			this.finish(entry, "tls_handshake_failed: the app rejected the capture certificate (CA not trusted)");
		};
		tlsSocket.on("error", refused);
		tlsSocket.once("close", refused);
		this.inner.emit("connection", tlsSocket);
	}
}
