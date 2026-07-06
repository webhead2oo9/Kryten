import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeImage, MAX_FINGERPRINT_IMAGE_PIXELS } from "../src/features/imageFingerprint/decode";

const FIXTURE_DIR = join(__dirname, "fixtures", "fingerprint");

describe("decodeImage — raster-only guard", () => {
    it("keeps the production decompression ceiling unchanged", () => {
        expect(MAX_FINGERPRINT_IMAGE_PIXELS).toBe(50_000_000);
    });

    it("rejects an SVG payload (even one misnamed as a raster) before libvips parses it", async () => {
        const svg = Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>`,
        );
        await expect(decodeImage(svg)).rejects.toThrow(/unsupported image format/);
    });

    it("rejects a leading-<?xml document", async () => {
        const xml = Buffer.from(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>`);
        await expect(decodeImage(xml)).rejects.toThrow(/unsupported image format/);
    });

    it("rejects a PDF header", async () => {
        const pdf = Buffer.from(`%PDF-1.7\n%\xE2\xE3\xCF\xD3\n1 0 obj<<>>endobj`);
        await expect(decodeImage(pdf)).rejects.toThrow(/unsupported image format/);
    });

    it("rejects tiny/empty buffers", async () => {
        await expect(decodeImage(Buffer.alloc(0))).rejects.toThrow(/unsupported image format/);
        await expect(decodeImage(Buffer.from([0x89, 0x50]))).rejects.toThrow(/unsupported image format/);
    });

    it("still decodes real raster fixtures (png/gif/jpg/webp)", async () => {
        for (const name of ["gradient.png", "checker.gif", "gradient.jpg", "gradient.webp"]) {
            const decoded = await decodeImage(readFileSync(join(FIXTURE_DIR, name)));
            expect(decoded.width).toBeGreaterThan(0);
            expect(decoded.height).toBeGreaterThan(0);
            expect(decoded.pixels.length).toBe(decoded.width * decoded.height * 4);
        }
    });
});
