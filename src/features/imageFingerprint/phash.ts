/**
 * Perceptual hash (pHash) — a bit-for-bit TypeScript port of the recipe every
 * FingerprintHub consumer uses: `imagehash.phash` (defaults) over an image
 * normalized with `alpha_white_v1` (reference environment: Pillow 12.2.0 /
 * ImageHash 4.3.2). The full recipe is specified in `docs/PHASH_RECIPE.md`.
 *
 * To stay Hamming-comparable with the shared corpus we must reproduce PIL's
 * exact pixel pipeline, not just "a pHash":
 *   normalize (alpha→white) → convert("L") → resize(32×32, LANCZOS) → DCT-II →
 *   top-left 8×8 vs median → 64 bits → 16 lowercase hex.
 *
 * The hard part is PIL's `convert("L")` + LANCZOS resample; both are replicated
 * here in fixed-point exactly as libImaging does them, so lossless inputs hash
 * bit-identically. Lossy formats (JPEG/WebP) can differ by a bit or two at the
 * decode step across libjpeg builds — that is absorbed by the match tolerance.
 *
 * The math below is pure and deterministic (no `sharp`), so it is unit-tested
 * directly against a corpus of PIL-generated vectors in
 * `tests/fixtures/fingerprint/`. Decoding compressed bytes to raw pixels (the
 * one thing we let a library do) lives in `decode.ts`.
 */

// libImaging Resample.c: PRECISION_BITS = 32 - 8 - 2.
const PRECISION_BITS = 32 - 8 - 2; // 22
const LANCZOS_SUPPORT = 3.0;

/** ITU-R 601-2 luma, matching PIL Convert.c `rgb2l`: (L24(rgb)) >> 16. */
export function pilLuma(r: number, g: number, b: number): number {
    return (r * 19595 + g * 38470 + b * 7471 + 0x8000) >> 16;
}

function sinc(x: number): number {
    if (x === 0) return 1.0;
    const px = Math.PI * x;
    return Math.sin(px) / px;
}

/** LANCZOS (a=3) filter, PIL `lanczos_filter`. */
function lanczosFilter(x: number): number {
    if (x >= -LANCZOS_SUPPORT && x < LANCZOS_SUPPORT) {
        return sinc(x) * sinc(x / LANCZOS_SUPPORT);
    }
    return 0.0;
}

interface Coeffs {
    bounds: Int32Array; // [xmin, xsize] per output pixel
    kk: Int32Array; // outSize * ksize fixed-point coefficients
    ksize: number;
}

/**
 * PIL `precompute_coeffs` + `normalize_coeffs_8bpc` for a full-image (box =
 * whole image) 1-D resample from `inSize` to `outSize`.
 */
function precomputeCoeffs(inSize: number, outSize: number): Coeffs {
    const scale = inSize / outSize;
    const filterscale = scale < 1.0 ? 1.0 : scale;
    const support = LANCZOS_SUPPORT * filterscale;
    const ksize = Math.ceil(support) * 2 + 1;

    const bounds = new Int32Array(outSize * 2);
    const prekk = new Float64Array(outSize * ksize);

    for (let xx = 0; xx < outSize; xx++) {
        const center = (xx + 0.5) * scale; // in0 = 0
        const ss = 1.0 / filterscale;

        // (int) cast truncates toward zero; negative xmin is clamped to 0, so
        // trunc-vs-floor is moot there. xmax side is always positive.
        let xmin = Math.trunc(center - support + 0.5);
        if (xmin < 0) xmin = 0;
        let xmax = Math.trunc(center + support + 0.5);
        if (xmax > inSize) xmax = inSize;
        xmax -= xmin;

        const base = xx * ksize;
        let ww = 0.0;
        for (let x = 0; x < xmax; x++) {
            const w = lanczosFilter((x + xmin - center + 0.5) * ss);
            prekk[base + x] = w;
            ww += w;
        }
        if (ww !== 0.0) {
            for (let x = 0; x < xmax; x++) prekk[base + x] = prekk[base + x]! / ww;
        }
        // remaining coefficients stay 0
        bounds[xx * 2 + 0] = xmin;
        bounds[xx * 2 + 1] = xmax;
    }

    // normalize_coeffs_8bpc: quantize to int, rounding away from zero.
    const mult = 1 << PRECISION_BITS;
    const kk = new Int32Array(outSize * ksize);
    for (let i = 0; i < prekk.length; i++) {
        const v = prekk[i]!;
        kk[i] = v < 0 ? Math.trunc(-0.5 + v * mult) : Math.trunc(0.5 + v * mult);
    }
    return { bounds, kk, ksize };
}

/** libImaging `clip8`: round-shift an accumulator back to a byte. */
function clip8(acc: number): number {
    if (acc >= 1 << (PRECISION_BITS + 8)) return 255; // overflow guard (1<<30)
    if (acc <= 0) return 0;
    return (acc >> PRECISION_BITS) & 0xff;
}

/**
 * One resample pass over a single 8-bit band. Resamples the X axis:
 * `src` is `inW × h`, result is `outW × h`. (Callers transpose to reuse this
 * for the Y axis, mirroring PIL's two separate passes.)
 */
function resamplePassX(src: Uint8Array, inW: number, h: number, outW: number): Uint8Array {
    if (inW === outW) return src; // PIL skips the pass when the dimension is unchanged
    const { bounds, kk, ksize } = precomputeCoeffs(inW, outW);
    const out = new Uint8Array(outW * h);
    const half = 1 << (PRECISION_BITS - 1);
    for (let y = 0; y < h; y++) {
        const row = y * inW;
        for (let xx = 0; xx < outW; xx++) {
            const xmin = bounds[xx * 2 + 0]!;
            const xsize = bounds[xx * 2 + 1]!;
            const kbase = xx * ksize;
            let acc = half;
            for (let x = 0; x < xsize; x++) {
                acc += src[row + xmin + x]! * kk[kbase + x]!;
            }
            out[y * outW + xx] = clip8(acc);
        }
    }
    return out;
}

/** Transpose an 8-bit band (w×h → h×w). */
function transpose(src: Uint8Array, w: number, h: number): Uint8Array {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            out[x * h + y] = src[y * w + x]!;
        }
    }
    return out;
}

/**
 * PIL `Image.resize((outW,outH), LANCZOS)` on a single 8-bit band: horizontal
 * pass then vertical pass, with an 8-bit clipped intermediate between them.
 */
export function resizeLanczosL(src: Uint8Array, inW: number, inH: number, outW: number, outH: number): Uint8Array {
    // Horizontal: inW×inH → outW×inH.
    const horiz = resamplePassX(src, inW, inH, outW);
    // Vertical via transpose: treat columns as rows, resample X (inH→outH).
    const t = transpose(horiz, outW, inH); // inH×outW
    const vert = resamplePassX(t, inH, outW, outH); // outH×outW
    return transpose(vert, outH, outW); // outW×outH, row-major
}

/**
 * 1-D DCT-II (scipy.fftpack.dct type=2, norm=None) — up to a positive scalar,
 * which is irrelevant because the hash only compares coefficients to their
 * median (scale-invariant for a positive factor).
 */
function dct1d(input: Float64Array, out: Float64Array, n: number): void {
    for (let k = 0; k < n; k++) {
        let sum = 0.0;
        const f = (Math.PI * k) / (2 * n);
        for (let m = 0; m < n; m++) {
            sum += input[m]! * Math.cos((2 * m + 1) * f);
        }
        out[k] = 2 * sum;
    }
}

/** Separable 2-D DCT-II over an n×n matrix (rows then columns). */
function dct2d(pixels: Float64Array, n: number): Float64Array {
    const tmp = new Float64Array(n * n);
    const row = new Float64Array(n);
    const rowOut = new Float64Array(n);
    // rows
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) row[x] = pixels[y * n + x]!;
        dct1d(row, rowOut, n);
        for (let x = 0; x < n; x++) tmp[y * n + x] = rowOut[x]!;
    }
    // columns
    const out = new Float64Array(n * n);
    const col = new Float64Array(n);
    const colOut = new Float64Array(n);
    for (let x = 0; x < n; x++) {
        for (let y = 0; y < n; y++) col[y] = tmp[y * n + x]!;
        dct1d(col, colOut, n);
        for (let y = 0; y < n; y++) out[y * n + x] = colOut[y]!;
    }
    return out;
}

const HASH_SIZE = 8;
const HIGHFREQ_FACTOR = 4;
const IMG_SIZE = HASH_SIZE * HIGHFREQ_FACTOR; // 32

/**
 * The pure core: an already-normalized, full-resolution 8-bit `L` band →
 * 16-char pHash hex. Mirrors `imagehash.phash` after `convert("L")`.
 */
export function phashHexFromL(lBand: Uint8Array, width: number, height: number): string {
    const small = resizeLanczosL(lBand, width, height, IMG_SIZE, IMG_SIZE);

    const pixels = new Float64Array(IMG_SIZE * IMG_SIZE);
    for (let i = 0; i < pixels.length; i++) pixels[i] = small[i]!;
    const dct = dct2d(pixels, IMG_SIZE);

    // top-left 8×8 low-frequency block. scipy's FFT-based DCT returns *exactly*
    // 0.0 for coefficients that cancel by symmetry (flat/regular images); our
    // O(n²) DCT leaves ~1e-9 float noise there, which would scatter around the
    // median and corrupt the hash. Snap that noise back to zero — real image
    // coefficients are orders of magnitude larger, so signs are unaffected.
    const EPS = 1e-6;
    const low: number[] = [];
    for (let y = 0; y < HASH_SIZE; y++) {
        for (let x = 0; x < HASH_SIZE; x++) {
            const v = dct[y * IMG_SIZE + x]!;
            low.push(Math.abs(v) < EPS ? 0 : v);
        }
    }
    // numpy.median: mean of the two middle elements for even count.
    const sorted = [...low].sort((a, b) => a - b);
    const mid = sorted.length / 2;
    const median = (sorted[mid - 1]! + sorted[mid]!) / 2;

    // bits row-major, MSB first (imagehash `_binary_array_to_hex`).
    let hex = "";
    for (let nibble = 0; nibble < 16; nibble++) {
        let v = 0;
        for (let bit = 0; bit < 4; bit++) {
            const idx = nibble * 4 + bit;
            v = (v << 1) | (low[idx]! > median ? 1 : 0);
        }
        hex += v.toString(16);
    }
    return hex;
}

/**
 * Raw decoded pixels → pHash hex, applying `alpha_white_v1` then PIL luma.
 * `pixels` is tightly-packed RGBA (4 bytes/pixel). When `hasAlpha` is false the
 * alpha channel is ignored (composite is a no-op for opaque pixels anyway).
 */
export function phashHexFromRgba(pixels: Uint8Array, width: number, height: number, hasAlpha: boolean): string {
    const l = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < l.length; i++, p += 4) {
        let r = pixels[p]!;
        let g = pixels[p + 1]!;
        let b = pixels[p + 2]!;
        if (hasAlpha) {
            const a = pixels[p + 3]!;
            if (a !== 255) {
                // alpha_white_v1: composite over opaque white.
                r = Math.round((r * a + 255 * (255 - a)) / 255);
                g = Math.round((g * a + 255 * (255 - a)) / 255);
                b = Math.round((b * a + 255 * (255 - a)) / 255);
            }
        }
        l[i] = pilLuma(r, g, b);
    }
    return phashHexFromL(l, width, height);
}

/** Hamming distance between two 16-hex pHashes (XOR + popcount). */
export function hammingHex(a: string, b: string): number {
    let dist = 0;
    let x = BigInt("0x" + a) ^ BigInt("0x" + b);
    while (x > 0n) {
        dist += Number(x & 1n);
        x >>= 1n;
    }
    return dist;
}
