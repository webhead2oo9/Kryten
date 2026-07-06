import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ENVELOPE_VERSION = 1;
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface EncryptedJsonEnvelope {
    version: 1;
    algorithm: "aes-256-gcm";
    iv: string;
    tag: string;
    ciphertext: string;
}

export class EncryptionKeyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "EncryptionKeyError";
    }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64WithoutPadding(value: Buffer): string {
    return value.toString("base64").replace(/=+$/u, "");
}

function decodeBase64Key(value: string): Buffer | null {
    const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
    const padding = (4 - (normalized.length % 4)) % 4;
    const padded = normalized + "=".repeat(padding);
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(padded)) return null;

    const decoded = Buffer.from(padded, "base64");
    if (decoded.length !== KEY_BYTES) return null;
    if (base64WithoutPadding(decoded) !== padded.replace(/=+$/u, "")) return null;
    return decoded;
}

export function parseAes256Key(raw: string | undefined, envName: string): Buffer {
    const value = raw?.trim();
    if (!value) {
        throw new EncryptionKeyError(`${envName} is required for encrypted persistence`);
    }

    const hexCandidate = value.startsWith("hex:") ? value.slice(4) : value;
    if (/^[0-9a-f]{64}$/iu.test(hexCandidate)) {
        return Buffer.from(hexCandidate, "hex");
    }

    const base64Candidate = value.startsWith("base64:") ? value.slice(7) : value;
    const base64Key = decodeBase64Key(base64Candidate);
    if (base64Key) return base64Key;

    throw new EncryptionKeyError(`${envName} must be 32 random bytes encoded as base64 or 64 hex characters`);
}

export function keyFromEnv(envName: string): Buffer {
    return parseAes256Key(process.env[envName], envName);
}

export function isEncryptedJsonEnvelope(value: unknown): value is EncryptedJsonEnvelope {
    if (!isRecord(value)) return false;
    return (
        value["version"] === ENVELOPE_VERSION &&
        value["algorithm"] === ALGORITHM &&
        typeof value["iv"] === "string" &&
        typeof value["tag"] === "string" &&
        typeof value["ciphertext"] === "string"
    );
}

function assertKey(key: Buffer): void {
    if (key.length !== KEY_BYTES) {
        throw new EncryptionKeyError(`AES-256-GCM requires a ${KEY_BYTES}-byte key`);
    }
}

function decodeBase64Field(value: string, field: string, expectedBytes?: number): Buffer {
    const decoded = Buffer.from(value, "base64");
    if (expectedBytes !== undefined && decoded.length !== expectedBytes) {
        throw new Error(`Encrypted JSON ${field} has invalid length`);
    }
    return decoded;
}

export function encryptJson(value: unknown, key: Buffer): string {
    assertKey(key);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: EncryptedJsonEnvelope = {
        version: ENVELOPE_VERSION,
        algorithm: ALGORITHM,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
    };
    return JSON.stringify(envelope, null, 2);
}

export function decryptJson<T>(envelope: EncryptedJsonEnvelope, key: Buffer): T {
    assertKey(key);
    const iv = decodeBase64Field(envelope.iv, "iv", IV_BYTES);
    const tag = decodeBase64Field(envelope.tag, "tag", TAG_BYTES);
    const ciphertext = decodeBase64Field(envelope.ciphertext, "ciphertext");
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return JSON.parse(plaintext) as T;
}
