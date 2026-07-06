import { randomBytes } from "crypto";
import { describe, expect, it } from "vitest";
import { decryptJson, encryptJson, isEncryptedJsonEnvelope, parseAes256Key } from "../src/utils/encryptedJson";

describe("encryptedJson", () => {
    it("round-trips JSON without storing plaintext", () => {
        const key = randomBytes(32);
        const value = {
            "1234567890": {
                firstMessageTimestamp: 1710000000,
                greetedInRandom: true,
            },
        };

        const encrypted = encryptJson(value, key);
        expect(encrypted).not.toContain("1234567890");
        expect(encrypted).not.toContain("firstMessageTimestamp");

        const envelope: unknown = JSON.parse(encrypted);
        expect(isEncryptedJsonEnvelope(envelope)).toBe(true);
        if (!isEncryptedJsonEnvelope(envelope)) throw new Error("expected encrypted envelope");
        expect(decryptJson(envelope, key)).toEqual(value);
    });

    it("accepts base64 and hex encoded 32-byte keys", () => {
        const key = randomBytes(32);
        expect(parseAes256Key(key.toString("base64"), "KEY")).toEqual(key);
        expect(parseAes256Key(`base64:${key.toString("base64")}`, "KEY")).toEqual(key);
        expect(parseAes256Key(key.toString("hex"), "KEY")).toEqual(key);
        expect(parseAes256Key(`hex:${key.toString("hex")}`, "KEY")).toEqual(key);
    });

    it("rejects tampered ciphertext", () => {
        const key = randomBytes(32);
        const envelope: unknown = JSON.parse(encryptJson({ ok: true }, key));
        if (!isEncryptedJsonEnvelope(envelope)) throw new Error("expected encrypted envelope");
        envelope.ciphertext = Buffer.from("tampered").toString("base64");
        expect(() => decryptJson(envelope, key)).toThrow();
    });
});
