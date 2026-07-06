import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computePhashHex } from "../src/features/imageFingerprint/decode";
import { hammingHex, phashHexFromL, pilLuma } from "../src/features/imageFingerprint/phash";

const FIXTURE_DIR = join(__dirname, "fixtures", "fingerprint");

interface Vector {
    name: string;
    format: string;
    mode: string;
    phash_hex: string;
    note?: string;
}

const manifest: Vector[] = JSON.parse(readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8"));

// Lossless formats must hash byte-identically to Pillow. Lossy decoders
// (libjpeg-turbo vs Pillow's libjpeg, libwebp builds) may differ by a bit or
// two — still well inside the 5–6 bit production match tolerance.
const LOSSLESS = new Set(["PNG", "GIF"]);
const LOSSY_TOLERANCE = 6;

describe("phash — parity with Pillow 12.2.0 / ImageHash 4.3.2", () => {
    for (const vec of manifest) {
        it(`${vec.name} (${vec.format}/${vec.mode})`, async () => {
            const bytes = readFileSync(join(FIXTURE_DIR, vec.name));
            const got = await computePhashHex(bytes);
            if (LOSSLESS.has(vec.format)) {
                expect(got, `${vec.name} should match exactly`).toBe(vec.phash_hex);
            } else {
                const dist = hammingHex(got, vec.phash_hex);
                expect(dist, `${vec.name} got ${got} vs ${vec.phash_hex} (dist ${dist})`).toBeLessThanOrEqual(
                    LOSSY_TOLERANCE,
                );
            }
        });
    }
});

describe("pilLuma", () => {
    it("matches PIL rgb2l fixed-point luma", () => {
        expect(pilLuma(0, 0, 0)).toBe(0);
        expect(pilLuma(255, 255, 255)).toBe(255);
        // grayscale round-trips exactly (g,g,g) -> g
        for (const g of [1, 17, 128, 200, 254]) expect(pilLuma(g, g, g)).toBe(g);
        // (255*19595 + 0x8000) >> 16 = 76
        expect(pilLuma(255, 0, 0)).toBe(76);
        expect(pilLuma(0, 255, 0)).toBe(150);
        expect(pilLuma(0, 0, 255)).toBe(29);
    });
});

describe("phashHexFromL", () => {
    it("a flat image hashes to the DC-only value 8000000000000000", () => {
        const flat = new Uint8Array(64 * 64).fill(128);
        expect(phashHexFromL(flat, 64, 64)).toBe("8000000000000000");
    });
});
