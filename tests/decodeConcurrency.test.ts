import { describe, expect, it, vi } from "vitest";

// White-box test of the fingerprint semaphore. `sharp` is fully mocked here (so this
// file must stay separate from decode.test.ts, which decodes real fixtures): the
// mocked decoder and hash track how many jobs have begun but not finished hashing.
const shared = vi.hoisted(() => ({ active: 0, maxActive: 0, metadataCalls: 0, hashes: 0, maxUnhashed: 0 }));

vi.mock("sharp", () => ({
    default: () => ({
        metadata: async () => {
            shared.metadataCalls++;
            return { format: "png", hasAlpha: false };
        },
        ensureAlpha() {
            return this;
        },
        raw() {
            return this;
        },
        async toBuffer() {
            shared.active++;
            shared.maxActive = Math.max(shared.maxActive, shared.active);
            await new Promise(resolve => setTimeout(resolve, 5));
            shared.active--;
            return { data: Buffer.alloc(4), info: { width: 1, height: 1 } };
        },
    }),
}));

vi.mock("../src/features/imageFingerprint/phash", () => ({
    phashHexFromRgba: () => {
        shared.maxUnhashed = Math.max(shared.maxUnhashed, shared.metadataCalls - shared.hashes);
        shared.hashes++;
        return "0000000000000000";
    },
}));

import { computePhashHex, decodeImage } from "../src/features/imageFingerprint/decode";

// Minimal buffer that passes the PNG magic-byte gate (>= 12 bytes, PNG signature).
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);

describe("decodeImage concurrency bound", () => {
    it("runs at most 2 decodes at once even under a burst", async () => {
        const results = await Promise.all(Array.from({ length: 8 }, () => decodeImage(PNG)));
        expect(results).toHaveLength(8);
        expect(shared.maxActive).toBeGreaterThan(0);
        expect(shared.maxActive).toBeLessThanOrEqual(2);
    });

    it("keeps each slot through hashing before admitting another decode", async () => {
        shared.metadataCalls = 0;
        shared.hashes = 0;
        shared.maxUnhashed = 0;

        const results = await Promise.all(Array.from({ length: 8 }, () => computePhashHex(PNG)));

        expect(results).toEqual(Array(8).fill("0000000000000000"));
        expect(shared.hashes).toBe(8);
        expect(shared.maxUnhashed).toBeLessThanOrEqual(2);
    });
});
