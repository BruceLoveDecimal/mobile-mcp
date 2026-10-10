/**
 * Certificate authority for decrypted HTTPS capture. X.509 encoding stays in a certificate library;
 * RSA key generation and signing use Node's WebCrypto, with no external executable or verification fallback.
 * Existing PEM CAs remain usable so installed Android trust does not change during an engine upgrade.
 */
import "reflect-metadata";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import * as x509 from "@peculiar/x509";

const CA_KEY_FILE = "ca.key.pem";
const CA_CERT_FILE = "ca.cert.pem";
const CA_YEARS = 10;
const LEAF_DAYS = 397;
const ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048 };
// Node and DOM crypto overloads differ in types; both expose the same WebCrypto provider used here.
x509.cryptoProvider.set(crypto.webcrypto as unknown as Crypto);

const keyPair = async (): Promise<CryptoKeyPair> => crypto.webcrypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"]);
const pemKey = async (key: CryptoKey): Promise<string> => crypto.createPrivateKey({ key: Buffer.from(await crypto.webcrypto.subtle.exportKey("pkcs8", key)), format: "der", type: "pkcs8" }).export({ format: "pem", type: "pkcs8" }).toString();

export class CertificateAuthority {
	private static readonly loading = new Map<string, Promise<CertificateAuthority>>();
	private readonly contexts = new Map<string, Promise<tls.SecureContext>>();

	private constructor(readonly dir: string, private readonly key: CryptoKey, private readonly cert: x509.X509Certificate, private readonly leafKeys: CryptoKeyPair, private readonly leafPem: string) {}

	/** Share initialization across device sessions, without replacing an already installed CA. */
	static async load(dir: string): Promise<CertificateAuthority> {
		const resolved = path.resolve(dir);
		let loading = this.loading.get(resolved);
		if (!loading) {
			loading = this.create(resolved).finally(() => this.loading.delete(resolved));
			this.loading.set(resolved, loading);
		}
		return loading;
	}

	private static async create(dir: string): Promise<CertificateAuthority> {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const keyPath = path.join(dir, CA_KEY_FILE);
		const certPath = path.join(dir, CA_CERT_FILE);
		let key: CryptoKey;
		let cert: x509.X509Certificate;
		if (fs.existsSync(keyPath) || fs.existsSync(certPath)) {
			// An incomplete or mismatched pair must not silently invalidate the device's installed trust.
			const stored = crypto.createPrivateKey(fs.readFileSync(keyPath));
			const pem = fs.readFileSync(certPath, "utf8");
			const native = new crypto.X509Certificate(pem);
			if (!native.checkPrivateKey(stored) || !native.ca) { throw new Error("Invalid network capture CA key/certificate pair"); }
			key = await crypto.webcrypto.subtle.importKey("pkcs8", stored.export({ format: "der", type: "pkcs8" }), ALGORITHM, false, ["sign"]);
			cert = new x509.X509Certificate(pem);
			fs.chmodSync(keyPath, 0o600);
		} else {
			const keys = await keyPair();
			cert = await x509.X509CertificateGenerator.createSelfSigned({
				serialNumber: "01" + crypto.randomBytes(8).toString("hex"),
				name: [{ CN: ["mobile-mcp network capture CA"] }, { O: ["mobile-mcp"] }],
				notBefore: new Date(Date.now() - 86400000), notAfter: new Date(Date.now() + CA_YEARS * 365 * 86400000),
				signingAlgorithm: ALGORITHM, keys,
				extensions: [new x509.BasicConstraintsExtension(true, undefined, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true), await x509.SubjectKeyIdentifierExtension.create(keys.publicKey)],
			});
			key = keys.privateKey;
			fs.writeFileSync(keyPath, await pemKey(key), { mode: 0o600 });
			fs.writeFileSync(certPath, cert.toString("pem"), { mode: 0o644 });
		}
		const leaves = await keyPair();
		return new CertificateAuthority(dir, key, cert, leaves, await pemKey(leaves.privateKey));
	}

	get certPath(): string { return path.join(this.dir, CA_CERT_FILE); }
	get certPem(): string { return this.cert.toString("pem"); }
	get fingerprint(): string { return new crypto.X509Certificate(this.certPem).fingerprint256; }

	/** Android names certificate files by the first four little-endian bytes of MD5(DER subject). */
	get androidHash(): string {
		return crypto.createHash("md5").update(Buffer.from(this.cert.subjectName.toArrayBuffer())).digest().subarray(0, 4).reverse().toString("hex");
	}

	async contextFor(host: string): Promise<tls.SecureContext> {
		const name = host.toLowerCase();
		let context = this.contexts.get(name);
		if (!context) {
			context = this.createContext(name).catch(error => { this.contexts.delete(name); throw error; });
			this.contexts.set(name, context);
		}
		return context;
	}

	private async createContext(name: string): Promise<tls.SecureContext> {
		const cert = await x509.X509CertificateGenerator.create({
			serialNumber: "02" + crypto.randomBytes(8).toString("hex"),
			subject: [{ CN: [name] }], issuer: this.cert.subjectName,
			publicKey: this.leafKeys.publicKey, signingKey: this.key, signingAlgorithm: ALGORITHM,
			notBefore: new Date(Date.now() - 86400000), notAfter: new Date(Date.now() + LEAF_DAYS * 86400000),
			extensions: [new x509.BasicConstraintsExtension(false), new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment), new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]), new x509.SubjectAlternativeNameExtension([{ type: net.isIP(name) ? "ip" : "dns", value: name }])],
		});
		return tls.createSecureContext({ key: this.leafPem, cert: cert.toString("pem") + "\n" + this.certPem });
	}
}
