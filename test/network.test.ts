import { expect, test } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createMcpServer } from "../src/server";
import { CertificateAuthority } from "../src/network/ca";
import { CaptureProxy } from "../src/network/proxy";
import { NetworkCaptures } from "../src/network/captures";
import { CaInstall, DeviceProxyControl } from "../src/network/android-proxy";

const tmpDir = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const listen = (server: http.Server | https.Server): Promise<number> =>
	new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)));

/** An upstream that echoes the method, path and body as JSON. */
const echoHandler = (req: http.IncomingMessage, res: http.ServerResponse) => {
	const chunks: Buffer[] = [];
	req.on("data", (c: Buffer) => chunks.push(c));
	req.on("end", () => {
		const body = { method: req.method, path: req.url, body: Buffer.concat(chunks).toString(), encoding: req.headers["accept-encoding"] };
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
	});
};

/** A request through the proxy, as an HTTP client configured with a proxy sends it: absolute URL on the request line. */
const viaProxy = (proxyPort: number, url: string, method = "GET", body?: string): Promise<{ status: number, text: string }> =>
	new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port: proxyPort, method, path: url, headers: { host: new URL(url).host, ...(body && { "content-type": "application/json" }) } }, res => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString() }));
		});
		req.on("error", reject);
		req.end(body);
	});

/** CONNECT through the proxy, then TLS over the tunnel trusting `ca` (undefined: reject the proxy's certificate). */
const connectTls = (proxyPort: number, host: string, port: number, ca: string | undefined): Promise<tls.TLSSocket> =>
	new Promise((resolve, reject) => {
		const socket = net.connect(proxyPort, "127.0.0.1", () => {
			socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
		});
		socket.once("data", chunk => {
			if (!chunk.toString().startsWith("HTTP/1.1 200")) {
				reject(new Error(chunk.toString()));
				return;
			}

			const secure = tls.connect({ socket, servername: "localhost", ca: ca ? [ca] : undefined, rejectUnauthorized: true }, () => resolve(secure));
			secure.on("error", reject);
		});
		socket.on("error", reject);
	});

/** Poll until `done` holds (bookkeeping finishes a moment after the client sees the end of a reply). */
const settled = async (done: () => boolean): Promise<void> => {
	for (let i = 0; i < 100 && !done(); i++) {
		await new Promise(resolve => setTimeout(resolve, 20));
	}
};

const request = (socket: tls.TLSSocket, text: string): Promise<string> =>
	new Promise(resolve => {
		const chunks: Buffer[] = [];
		socket.on("data", (c: Buffer) => chunks.push(c));
		socket.on("end", () => resolve(Buffer.concat(chunks).toString()));
		socket.on("close", () => resolve(Buffer.concat(chunks).toString()));
		socket.write(text);
	});

test("plain HTTP is recorded with bodies; list filters and detail pages", async () => {
	const upstream = http.createServer(echoHandler);
	const upstreamPort = await listen(upstream);
	const proxy = new CaptureProxy({ maxBodyBytes: 40 });
	const port = await proxy.start();
	try {
		const first = await viaProxy(port, `http://127.0.0.1:${upstreamPort}/api/items?x=1`);
		expect(first.status).toBe(200);
		expect(JSON.parse(first.text)).toMatchObject({ method: "GET", path: "/api/items?x=1", encoding: "identity" });
		const posted = await viaProxy(port, `http://127.0.0.1:${upstreamPort}/api/items`, "POST", JSON.stringify({ title: "a poster with a long enough title to be cut" }));
		expect(posted.status).toBe(200);

		const all = proxy.list();
		expect(all.entries.map(e => [e.method, e.status])).toEqual([["GET", 200], ["POST", 200]]);
		expect(all.cursor).toBe(2);
		const filtered = proxy.list({ filter: "x=1" });
		expect(filtered.entries).toHaveLength(1);
		expect(proxy.list({ afterSequence: 1 }).entries.map(e => e.seq)).toEqual([2]);

		const detail = proxy.detail({ seq: 2, part: "request" })!;
		expect(detail.body.part).toBe("request");
		expect(detail.body.text.startsWith('{"title":"a poster')).toBe(true);
		expect(detail.body.captureTruncated).toBe(true);
		expect(detail.requestHeaders["content-type"]).toBe("application/json");
		const response = proxy.detail({ seq: 2, part: "response", maxChars: 200 })!;
		expect(response.body.text).toContain('"method":"POST"');
		expect(response.contentType).toBe("application/json");
		expect(response.responseHeaders["content-type"]).toBe("application/json");

		expect(proxy.detail({ seq: 9 })).toBeUndefined();
		expect(proxy.clear()).toBe(2);
		expect(proxy.list().entries).toEqual([]);
	} finally {
		await proxy.stop();
		upstream.close();
	}
});

test("an unreachable upstream is a 502 and an entry with the error", async () => {
	const proxy = new CaptureProxy();
	const port = await proxy.start();
	try {
		const closed = http.createServer();
		const deadPort = await listen(closed);
		await new Promise(resolve => closed.close(resolve));
		const result = await viaProxy(port, `http://127.0.0.1:${deadPort}/x`);
		expect(result.status).toBe(502);
		const [entry] = proxy.list().entries;
		expect(entry.completed).toBe(true);
		expect(entry.status).toBeUndefined();
		expect(entry.error).toContain("ECONNREFUSED");
	} finally {
		await proxy.stop();
	}
});

test("HTTPS is tunnelled by default (metadata only) and decrypted with the CA on request", async () => {
	const dir = tmpDir("mobile-mcp-ca-");
	const ca = await CertificateAuthority.load(dir);
	expect(fs.statSync(path.join(dir, "ca.key.pem")).mode & 0o777).toBe(0o600);
	expect(ca.androidHash).toMatch(/^[0-9a-f]{8}$/);
	expect((await CertificateAuthority.load(dir)).fingerprint).toBe(ca.fingerprint);

	// the upstream presents a certificate from the same CA, which the proxy is told to trust
	const serverCa = await CertificateAuthority.load(tmpDir("mobile-mcp-upstream-ca-"));
	const upstream = https.createServer({ SNICallback: (name, cb) => { void serverCa.contextFor(name).then(context => cb(null, context), cb); } }, echoHandler);
	const upstreamPort = await listen(upstream);

	const tunnelOnly = new CaptureProxy({ ca, upstreamCa: [serverCa.certPem] });
	const tunnelPort = await tunnelOnly.start();
	try {
		const socket = await connectTls(tunnelPort, "127.0.0.1", upstreamPort, serverCa.certPem);
		const reply = await request(socket, `GET /secret HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
		expect(reply).toContain('"path":"/secret"');
		await settled(() => tunnelOnly.list().entries[0]?.completed === true);
		const [entry] = tunnelOnly.list().entries;
		expect(entry).toMatchObject({ method: "CONNECT", resourceType: "tls", status: 200, completed: true, url: `https://127.0.0.1:${upstreamPort}` });
		expect(entry.requestBytes).toBeGreaterThan(0);
		expect(entry.responseBytes).toBeGreaterThan(0);
		expect(tunnelOnly.stats.tlsTunnels).toBe(1);
	} finally {
		await tunnelOnly.stop();
	}

	const decrypting = new CaptureProxy({ decryptHttps: true, ca, upstreamCa: [serverCa.certPem] });
	const decryptPort = await decrypting.start();
	try {
		// a client trusting the capture CA: the request inside is recorded like plain HTTP
		const socket = await connectTls(decryptPort, "127.0.0.1", upstreamPort, ca.certPem);
		const reply = await request(socket, `POST /login HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 12\r\nConnection: close\r\n\r\n{"pw":"s3c"}`);
		expect(reply).toContain('"method":"POST"');
		const detail = decrypting.detail({ seq: 1, part: "request" })!;
		expect(detail).toMatchObject({ method: "POST", resourceType: "http", status: 200, url: `https://127.0.0.1:${upstreamPort}/login` });
		expect(detail.body.text).toBe('{"pw":"s3c"}');

		// a client that does not trust it hangs up during the handshake: recorded as such, not silently lost
		await expect(connectTls(decryptPort, "127.0.0.1", upstreamPort, undefined)).rejects.toThrow();
		await settled(() => decrypting.list().entries.some(e => e.resourceType === "tls"));
		const refused = decrypting.list().entries.find(e => e.resourceType === "tls")!;
		expect(refused.error).toContain("tls_handshake_failed");
		expect(decrypting.stats.tlsHandshakeFailures).toBe(1);
	} finally {
		await decrypting.stop();
		upstream.close();
	}
});

/** Records what would have gone to adb. */
class FakeControl implements DeviceProxyControl {
	log: string[] = [];
	installed: CaInstall = "exported";

	enable(deviceId: string, port: number): string {
		this.log.push(`enable ${deviceId} ${port}`);
		return `serial-${deviceId}`;
	}

	disable(deviceId: string, port: number): void {
		this.log.push(`disable ${deviceId} ${port}`);
	}

	installCa(deviceId: string, pem: string, hashName: string): CaInstall {
		this.log.push(`installCa ${deviceId} ${hashName} ${pem.includes("BEGIN CERTIFICATE")}`);
		return this.installed;
	}
}

test("network_capture and network_inspect tools drive one capture per device", async () => {
	const control = new FakeControl();
	const captures = new NetworkCaptures(control, tmpDir("mobile-mcp-network-"));
	const server = createMcpServer({ adapterSources: [], networkCaptures: captures });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "test", version: "0" });
	await client.connect(clientTransport);
	const call = async (name: string, args: Record<string, unknown>) => {
		const result = await client.callTool({ name, arguments: args }) as { content: Array<{ type: string, text: string }>, isError?: boolean };
		return { text: result.content[0].text, isError: Boolean(result.isError) };
	};

	try {
		const none = await call("network_inspect", { device: "qa-pixel", action: "list" });
		expect(none.text).toContain("No network capture is running on qa-pixel");
		expect(none.text).toContain("Please fix the issue and try again.");

		const started = JSON.parse((await call("network_capture", { device: "qa-pixel", action: "start" })).text);
		expect(started).toMatchObject({ ok: true, device: "qa-pixel", active: true, decryptHttps: false });
		expect(control.log).toEqual([`enable qa-pixel ${started.port}`]);
		// idempotent while the mode is unchanged
		const again = JSON.parse((await call("network_capture", { device: "qa-pixel", action: "start" })).text);
		expect(again.port).toBe(started.port);
		expect(control.log).toHaveLength(1);

		const upstream = http.createServer(echoHandler);
		const upstreamPort = await listen(upstream);
		await viaProxy(started.port, `http://127.0.0.1:${upstreamPort}/ping`);
		upstream.close();

		const listed = JSON.parse((await call("network_inspect", { device: "qa-pixel", action: "list", filter: "ping" })).text);
		expect(listed.entries).toHaveLength(1);
		expect(listed.entries[0]).toMatchObject({ seq: 1, method: "GET", status: 200 });
		const detail = JSON.parse((await call("network_inspect", { device: "qa-pixel", action: "detail", seq: 1 })).text);
		expect(detail.body.text).toContain('"path":"/ping"');
		const missing = await call("network_inspect", { device: "qa-pixel", action: "detail" });
		expect(missing.text).toContain("detail requires seq");
		expect(JSON.parse((await call("network_inspect", { device: "qa-pixel", action: "clear" })).text).cleared).toBe(1);

		// switching to decryption installs the CA and restarts the proxy on the device
		const decrypting = JSON.parse((await call("network_capture", { device: "qa-pixel", action: "start", decryptHttps: true })).text);
		expect(decrypting.decryptHttps).toBe(true);
		expect(decrypting.ca.installed).toBe("exported");
		expect(decrypting.ca.hint).toContain("Settings");
		expect(control.log.slice(1)).toEqual([
			`disable qa-pixel ${started.port}`,
			expect.stringMatching(/^installCa qa-pixel [0-9a-f]{8} true$/),
			`enable qa-pixel ${decrypting.port}`,
		]);
		const status = JSON.parse((await call("network_capture", { device: "qa-pixel", action: "status" })).text);
		expect(status).toMatchObject({ active: true, port: decrypting.port, stats: { entries: 0 } });

		const stopped = JSON.parse((await call("network_capture", { device: "qa-pixel", action: "stop" })).text);
		expect(stopped.stopped).toBe(true);
		expect(control.log.at(-1)).toBe(`disable qa-pixel ${decrypting.port}`);
		expect(JSON.parse((await call("network_capture", { device: "qa-pixel", action: "status" })).text).active).toBe(false);
	} finally {
		await captures.stopAll();
		await client.close();
		await server.close();
	}
});

test("legacy PEM trust survives migration and still signs a verified TLS leaf", async () => {
	const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "legacy-ca.json"), "utf8"));
	const dir = tmpDir("mobile-mcp-legacy-ca-");
	fs.writeFileSync(path.join(dir, "ca.key.pem"), fixture.key, { mode: 0o600 });
	fs.writeFileSync(path.join(dir, "ca.cert.pem"), fixture.cert);
	const [ca, concurrent] = await Promise.all([CertificateAuthority.load(dir), CertificateAuthority.load(dir)]);
	expect(concurrent).toBe(ca);
	expect(ca.fingerprint).toBe(fixture.fingerprint);
	expect(ca.androidHash).toBe(fixture.androidHash);
	expect(fs.readFileSync(path.join(dir, "ca.key.pem"), "utf8")).toBe(fixture.key);
	expect(fs.readFileSync(path.join(dir, "ca.cert.pem"), "utf8")).toBe(fixture.cert);
	const server = https.createServer({ SNICallback: (name, cb) => { void ca.contextFor(name).then(context => cb(null, context), cb); } }, echoHandler);
	const port = await listen(server);
	try {
		const reply = await new Promise<string>((resolve, reject) => {
			const req = https.get({ host: "127.0.0.1", port, servername: "localhost", ca: fixture.cert, rejectUnauthorized: true }, res => {
				const chunks: Buffer[] = [];
				res.on("data", chunk => chunks.push(chunk));
				res.on("end", () => resolve(Buffer.concat(chunks).toString()));
			});
			req.on("error", reject);
		});
		expect(reply).toContain('"method":"GET"');
	} finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("incomplete or mismatched CA files are rejected without replacing installed trust", async () => {
	const dir = tmpDir("mobile-mcp-invalid-ca-");
	const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "legacy-ca.json"), "utf8"));
	fs.writeFileSync(path.join(dir, "ca.cert.pem"), fixture.cert);
	await expect(CertificateAuthority.load(dir)).rejects.toThrow();
	expect(fs.existsSync(path.join(dir, "ca.key.pem"))).toBe(false);
	const other = await CertificateAuthority.load(tmpDir("mobile-mcp-other-ca-"));
	fs.copyFileSync(path.join(other.dir, "ca.key.pem"), path.join(dir, "ca.key.pem"));
	await expect(CertificateAuthority.load(dir)).rejects.toThrow("Invalid network capture CA");
	expect(fs.readFileSync(path.join(dir, "ca.cert.pem"), "utf8")).toBe(fixture.cert);
});
