/**
 * The one step we delegate to a library: decode compressed image bytes into raw
 * RGBA pixels. Everything downstream (normalize/luma/resize/DCT) is our own
 * PIL-exact code in `phash.ts`.
 *
 * `sharp` (libvips) is used only as a decoder. We force `failOn: "none"` so
 * truncated/partial images still decode (PIL's `ImageFile.LOAD_TRUNCATED`
 * behaviour), take the first frame of animations (page 0, matching PIL's
 * `image.load()`), and guard the decompression-bomb / size limits.
 */
import sharp from "sharp";
import { phashHexFromRgba } from "./phash";

export const MAX_FINGERPRINT_IMAGE_PIXELS = 50_000_000;

// Formats we accept, keyed off what libvips ACTUALLY decoded (meta.format), not
// the caller-supplied content-type/filename. These are also the only formats
// Hamming-comparable with the shared corpus.
const RASTER_FORMATS = new Set(["png", "jpeg", "gif", "webp", "tiff", "bmp"]);

/**
 * Leading-byte allowlist for the raster containers above, checked BEFORE handing
 * the buffer to libvips. The imageSources allowlist screens declared types, but
 * libvips picks its loader by sniffing bytes — and it invokes librsvg even during
 * `metadata()` to read an SVG's dimensions. Gating on magic bytes here means a
 * non-raster payload (SVG/XML/PDF/…) named `x.png` is rejected before libvips
 * ever parses it, so librsvg's XML surface is never reached. All of PNG/JPEG/GIF/
 * WebP/BMP/TIFF have fixed signatures, so there are no false negatives on real
 * raster images.
 */
function looksLikeRasterContainer(b: Buffer): boolean {
    if (b.length < 12) return false;
    // PNG: 89 50 4E 47
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true;
    // JPEG: FF D8 FF
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;
    // GIF: "GIF8"
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return true;
    // BMP: "BM"
    if (b[0] === 0x42 && b[1] === 0x4d) return true;
    // TIFF: "II*\0" (LE) or "MM\0*" (BE)
    if (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) return true;
    if (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a) return true;
    // WebP: "RIFF"????"WEBP"
    if (
        b[0] === 0x52 &&
        b[1] === 0x49 &&
        b[2] === 0x46 &&
        b[3] === 0x46 &&
        b[8] === 0x57 &&
        b[9] === 0x45 &&
        b[10] === 0x42 &&
        b[11] === 0x50
    ) {
        return true;
    }
    return false;
}

export interface DecodedImage {
    pixels: Uint8Array; // tightly packed RGBA
    width: number;
    height: number;
    hasAlpha: boolean;
}

export async function decodeImage(bytes: Buffer | Uint8Array): Promise<DecodedImage> {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    // Reject non-raster containers on magic bytes before libvips sees them, so an
    // SVG/PDF/XML payload can't reach librsvg even via metadata()'s dimension read.
    if (!looksLikeRasterContainer(buf)) {
        throw new Error("unsupported image format: not a recognized raster container");
    }
    const base = sharp(buf, { failOn: "none", limitInputPixels: MAX_FINGERPRINT_IMAGE_PIXELS });
    const meta = await base.metadata();
    // Defense in depth: also reject on what libvips actually decoded.
    if (!meta.format || !RASTER_FORMATS.has(meta.format)) {
        throw new Error(`unsupported image format: ${meta.format ?? "unknown"}`);
    }
    const hasAlpha = Boolean(meta.hasAlpha);

    const { data, info } = await sharp(buf, {
        failOn: "none",
        limitInputPixels: MAX_FINGERPRINT_IMAGE_PIXELS,
    })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    return {
        pixels: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        width: info.width,
        height: info.height,
        hasAlpha,
    };
}

/** Decode + hash: compressed image bytes → 16-char pHash hex. */
export async function computePhashHex(bytes: Buffer | Uint8Array): Promise<string> {
    const { pixels, width, height, hasAlpha } = await decodeImage(bytes);
    return phashHexFromRgba(pixels, width, height, hasAlpha);
}
