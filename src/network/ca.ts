/**
 * The certificate authority behind decrypted HTTPS capture.
 *
 * A capture proxy can only read HTTPS bodies by terminating TLS itself, which needs a certificate the app
 * trusts for every host it talks to. One CA key pair lives in the network directory (created on first use,
 * private key 0600) and signs a leaf certificate per host on demand. The CA certificate is what has to be
 * installed on the device; the leaf certificates never leave this process.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import forge from "node-forge";

const CA_KEY_FILE = "ca.key.pem";
const CA_CERT_FILE = "ca.cert.pem";
const KEY_BITS = 2048;
const CA_YEARS = 10;
const LEAF_DAYS = 397;

const isIp = (host: string): boolean => /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");

export class CertificateAuthority {
	private readonly contexts = new Map<string, tls.SecureContext>();
	/** One key pair for every leaf: generating RSA keys per host would take seconds each. */
	private readonly leafKeys: forge.pki.rsa.KeyPair;

	private constructor(
		readonly dir: string,
		private readonly key: forge.pki.rsa.PrivateKey,
		private readonly cert: forge.pki.Certificate,
	) {
		this.leafKeys = forge.pki.rsa.generateKeyPair({ bits: KEY_BITS });
	}

	/** The CA stored in `dir`, created when missing. */
	static load(dir: string): CertificateAuthority {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const keyPath = path.join(dir, CA_KEY_FILE);
		const certPath = path.join(dir, CA_CERT_FILE);
		if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
			const key = forge.pki.privateKeyFromPem(fs.readFileSync(keyPath, "utf8"));
			const cert = forge.pki.certificateFromPem(fs.readFileSync(certPath, "utf8"));
			return new CertificateAuthority(dir, key, cert);
		}

		const keys = forge.pki.rsa.generateKeyPair({ bits: KEY_BITS });
		const cert = forge.pki.createCertificate();
		cert.publicKey = keys.publicKey;
		cert.serialNumber = "01" + crypto.randomBytes(8).toString("hex");
		cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
		cert.validity.notAfter = new Date(Date.now() + CA_YEARS * 365 * 24 * 3600 * 1000);
		const subject = [
			{ name: "commonName", value: "mobile-mcp network capture CA" },
			{ name: "organizationName", value: "mobile-mcp" },
		];
		cert.setSubject(subject);
		cert.setIssuer(subject);
		cert.setExtensions([
			{ name: "basicConstraints", cA: true, critical: true },
			{ name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
			{ name: "subjectKeyIdentifier" },
		]);
		cert.sign(keys.privateKey, forge.md.sha256.create());
		fs.writeFileSync(keyPath, forge.pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
		fs.writeFileSync(certPath, forge.pki.certificateToPem(cert), { mode: 0o644 });
		return new CertificateAuthority(dir, keys.privateKey, cert);
	}

	get certPath(): string {
		return path.join(this.dir, CA_CERT_FILE);
	}

	get certPem(): string {
		return forge.pki.certificateToPem(this.cert);
	}

	/** SHA-256 of the DER certificate, colon separated, as Android's certificate details show it. */
	get fingerprint(): string {
		const der = forge.asn1.toDer(forge.pki.certificateToAsn1(this.cert)).getBytes();
		const hex = crypto.createHash("sha256").update(Buffer.from(der, "binary")).digest("hex").toUpperCase();
		return hex.match(/.{2}/g)!.join(":");
	}

	/**
	 * `openssl x509 -subject_hash_old`: the file name Android's certificate stores use (`<hash>.0`), the first four
	 * bytes of the MD5 of the DER subject name, little endian.
	 */
	get androidHash(): string {
		// typed nowhere in @types/node-forge, present at runtime
		const toAsn1 = (forge.pki as unknown as { distinguishedNameToAsn1: (dn: unknown) => forge.asn1.Asn1 }).distinguishedNameToAsn1;
		const der = forge.asn1.toDer(toAsn1(this.cert.subject)).getBytes();
		const md5 = crypto.createHash("md5").update(Buffer.from(der, "binary")).digest();
		return md5.subarray(0, 4).reverse().toString("hex");
	}

	/** A TLS server context presenting a leaf certificate for `host`, signed by this CA. */
	contextFor(host: string): tls.SecureContext {
		const name = host.toLowerCase();
		const cached = this.contexts.get(name);
		if (cached) {
			return cached;
		}

		const cert = forge.pki.createCertificate();
		cert.publicKey = this.leafKeys.publicKey;
		cert.serialNumber = "02" + crypto.randomBytes(8).toString("hex");
		cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
		cert.validity.notAfter = new Date(Date.now() + LEAF_DAYS * 24 * 3600 * 1000);
		cert.setSubject([{ name: "commonName", value: name }]);
		cert.setIssuer(this.cert.subject.attributes);
		cert.setExtensions([
			{ name: "basicConstraints", cA: false },
			{ name: "keyUsage", digitalSignature: true, keyEncipherment: true },
			{ name: "extKeyUsage", serverAuth: true },
			{ name: "subjectAltName", altNames: [isIp(name) ? { type: 7, ip: name } : { type: 2, value: name }] },
		]);
		cert.sign(this.key, forge.md.sha256.create());
		const context = tls.createSecureContext({
			key: forge.pki.privateKeyToPem(this.leafKeys.privateKey),
			cert: forge.pki.certificateToPem(cert) + this.certPem,
		});
		this.contexts.set(name, context);
		return context;
	}
}
