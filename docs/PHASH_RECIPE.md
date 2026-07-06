# The Shared Image-Fingerprint Recipe

**Identity triple: `phash` / `imagehash.phash` / `alpha_white_v1`.**

Every FingerprintHub consumer computes perceptual hashes with this exact recipe,
so a fingerprint contributed by one bot is Hamming-comparable with hashes
computed by every other. The hub itself never hashes anything — it only stores
and serves `phash_hex` strings — so this document is the compatibility contract
between consumers.

The recipe is *"`imagehash.phash` with default parameters, over an image
normalized with `alpha_white_v1`"*, as produced by the pinned reference
environment:

> **Pillow 12.2.0 · ImageHash 4.3.2 · numpy 2.5.0 · scipy 1.18.0**

Two conformance artifacts in this repo are normative:

- `src/features/imageFingerprint/phash.ts` — a bit-exact port written as
  spec-grade integer math, validated against the fixtures.
- `tests/fixtures/fingerprint/` + `manifest.json` — vectors generated on the
  reference environment. Any implementation must reproduce the PNG/GIF hashes
  **exactly** and the JPEG/WebP hashes within a couple of bits (decoder
  variance).

## The pipeline

### 0. Decode

- Raster formats only: PNG, JPEG, GIF, WebP, TIFF, BMP. Never SVG (it can't be
  Hamming-compared meaningfully and is a much larger parser attack surface).
- Take the **first frame** of animated images.
- Tolerate truncated files (PIL `LOAD_TRUNCATED_IMAGES` behaviour).
- Guards every consumer enforces: 8 MiB input bytes, 50,000,000 pixels.
- Lossless formats decode to identical pixels everywhere. Lossy decoders
  (libjpeg builds, libwebp versions) may differ by a pixel here and there —
  that drift is absorbed by the match tolerance, not by the recipe.

### 1. `alpha_white_v1` — composite transparency onto white

If the decoded image carries transparency (`RGBA`, `LA`, or palette with
transparency), composite it over **opaque white**; otherwise pass through
unchanged. Per channel `c ∈ {R,G,B}` with alpha `a ∈ [0,255]`:

```
c' = round((c·a + 255·(255 − a)) / 255)
```

(The half-way case cannot occur for integer inputs, so the rounding mode is
immaterial.) The result is opaque RGB.

### 2. Grayscale — PIL `convert("L")` (ITU-R 601-2 luma)

Integer arithmetic exactly as libImaging's `rgb2l`:

```
L = (R·19595 + G·38470 + B·7471 + 32768) >> 16
```

### 3. Resize to 32×32 — PIL LANCZOS, fixed-point

`imagehash.phash` defaults are `hash_size=8`, `highfreq_factor=4`, giving a
32×32 working image. The resample must reproduce **PIL's implementation**, not
"a Lanczos filter":

- Kernel with support a=3: `sinc(x)·sinc(x/3)` for −3 ≤ x < 3, else 0.
- Per output pixel, weights are normalized to sum 1, then quantized to fixed
  point with **22 fractional bits**, rounding half away from zero.
- Two 1-D passes — horizontal, then vertical — with the intermediate clamped
  back to 8-bit between the passes (accumulator seeded with the 0.5 rounding
  constant; see `clip8`).
- A pass whose dimension is already correct is skipped entirely.

`precomputeCoeffs` / `resamplePassX` in `phash.ts` are the exact arithmetic.

### 4. 2-D DCT-II

Unnormalized type-II DCT (scipy `dct(..., type=2, norm=None)`) along both axes
of the 32×32 matrix. Any positive global scale factor is fine — step 5 only
compares coefficients to their median, which is scale-invariant.

Implementation note: FFT-based DCTs return exactly `0.0` for coefficients that
cancel by symmetry (flat/regular images). A direct O(n²) DCT leaves ~1e-9 float
noise there instead, which lands randomly around the median and scatters the
hash. Snap `|coeff| < 1e-6` to 0 — real image coefficients are orders of
magnitude larger, so signs are unaffected.

### 5. Bits

Take the top-left 8×8 low-frequency block (DC coefficient **included**).
Compute the median of those 64 values as numpy does (mean of the two middle
elements). Each bit is `1` iff `coeff > median` (strict).

### 6. Hex serialization

Flatten the 8×8 bit matrix row-major, MSB first within each nibble, and render
as 16 lowercase hex characters (imagehash `_binary_array_to_hex`). Example:
`e5de4a00bcbd5a25`.

## Comparison semantics

Fingerprints compare by Hamming distance over the 64 bits. Consumers treat a
distance of ~5–6 as a match. A lossless re-encode hashes identically; a lossy
re-encode typically drifts 0–2 bits.

## Reference generator (Python)

```python
# uv run --with pillow==12.2.0 --with imagehash==4.3.2 python phash_reference.py <image>
import sys

import imagehash
from PIL import Image


def alpha_white_v1(img: Image.Image) -> Image.Image:
    if img.mode == "P" and "transparency" in img.info:
        img = img.convert("RGBA")
    if img.mode in ("RGBA", "LA"):
        white = Image.new("RGBA", img.size, (255, 255, 255, 255))
        img = Image.alpha_composite(white, img.convert("RGBA")).convert("RGB")
    return img


img = Image.open(sys.argv[1])
img.load()  # first frame of an animation
print(str(imagehash.phash(alpha_white_v1(img))))
```

The integer math in §1–§6 (and `phash.ts`, which the test suite holds to the
fixtures) is the normative spec. Before trusting any generator — including this
one — run it over `tests/fixtures/fingerprint/` and confirm it reproduces
`manifest.json` exactly for the lossless entries.

## Conformance checklist for a new consumer

1. Hash every fixture in `tests/fixtures/fingerprint/`: PNG/GIF must match
   `manifest.json` **exactly**; JPEG/WebP within your match tolerance.
2. Before enabling enforcement, confirm a hash computed by your consumer equals
   a peer's hash for the same original file.
3. Never hand-edit `manifest.json` hashes; regenerate on the reference
   environment.
