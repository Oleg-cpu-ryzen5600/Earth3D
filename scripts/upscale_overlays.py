#!/usr/bin/env python3
"""Make a higher-resolution version of the SAR overlay from the existing composite.

No new data is downloaded: src/textures/sar.webp (4096 x 2048) is enhanced and
written as src/textures/sar_hi.webp (2x, 8192 x 4096). The site loads it only
when the camera is close to the surface.

Steps (all on premultiplied colour, so transparent pixels never darken the result):
  1. light despeckle: blend with a 3x3 median (removes isolated noisy pixels,
     keeps edges);
  2. hole filling: small gaps without data (isolated transparent pixels, thin
     swath seams) are filled from neighbouring pixels by normalized convolution;
     larger empty areas and the coastline are left as they are;
  3. 2x bicubic upsampling of colour and alpha (smooth instead of blocky pixels
     when magnified), slight smoothing of the alpha edge.

Usage:
    python scripts/upscale_overlays.py [--scale 2]
"""
import argparse
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src" / "textures" / "sar.webp"
DST = ROOT / "src" / "textures" / "sar_hi.webp"

FILL_PASSES = 3          # box-blur passes (radius 1) for the normalized convolution (~Gaussian sigma 1.4 px)
FILL_MIN_COVER = 0.6     # fill a hole only if >= 60% of its blurred neighbourhood has data
DESPECKLE = 0.5          # blend weight of the 3x3 median


def box3(a):
    """3x3 box blur, wrapping in longitude, clamped at the poles."""
    p = np.concatenate([a[:, -1:], a, a[:, :1]], axis=1)
    a = (p[:, :-2] + p[:, 1:-1] + p[:, 2:]) / 3
    p = np.concatenate([a[:1], a, a[-1:]], axis=0)
    return (p[:-2] + p[1:-1] + p[2:]) / 3


def median3(rgb, valid):
    """Per-channel 3x3 median over valid pixels only (invalid ones are replaced by the pixel itself)."""
    h, w, _ = rgb.shape
    out = np.empty_like(rgb)
    for c in range(3):
        ch = rgb[..., c]
        stack = []
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                s = np.roll(np.roll(ch, dy, axis=0), dx, axis=1)
                v = np.roll(np.roll(valid, dy, axis=0), dx, axis=1)
                stack.append(np.where(v, s, ch))
        out[..., c] = np.median(np.stack(stack), axis=0)
    return out


def enhance(rgba, scale):
    rgb = rgba[..., :3].astype(np.float32)
    a = rgba[..., 3].astype(np.float32) / 255
    valid = a > 0.5

    # 1. despeckle (only where there is data)
    med = median3(rgb, valid)
    rgb = np.where(valid[..., None], (1 - DESPECKLE) * rgb + DESPECKLE * med, rgb)

    # 2. hole filling by normalized convolution
    num = rgb * a[..., None]
    den = a.copy()
    for _ in range(FILL_PASSES):
        num = np.dstack([box3(num[..., c]) for c in range(3)])
        den = box3(den)
    hole = (a < 0.5) & (den >= FILL_MIN_COVER)
    with np.errstate(invalid="ignore", divide="ignore"):
        filled = num / np.maximum(den, 1e-6)[..., None]
    rgb = np.where(hole[..., None], filled, rgb)
    a = np.where(hole, np.maximum(a, den), a)
    print(f"Filled {hole.sum()} hole pixels ({hole.mean() * 100:.2f}% of the image)")

    # 3. bicubic upsampling of premultiplied colour and alpha
    h, w = a.shape
    size = (w * scale, h * scale)
    up = lambda x: np.asarray(Image.fromarray(x.astype(np.float32), "F").resize(size, Image.BICUBIC))
    pa = np.clip(up(a), 0, 1)
    prgb = np.dstack([up(rgb[..., c] * a) for c in range(3)])
    with np.errstate(invalid="ignore", divide="ignore"):
        out_rgb = np.where(pa[..., None] > 1e-3, prgb / pa[..., None], 0)
    pa = pa * pa * (3 - 2 * pa)                   # smoothstep: soft but clean alpha edge
    return np.dstack([np.clip(np.rint(out_rgb), 0, 255), np.rint(pa * 255)]).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scale", type=int, default=2)
    args = ap.parse_args()
    rgba = np.asarray(Image.open(SRC).convert("RGBA"))
    print(f"Input {SRC.relative_to(ROOT)}: {rgba.shape[1]}x{rgba.shape[0]}")
    out = enhance(rgba, args.scale)
    Image.fromarray(out, "RGBA").save(DST, "WEBP", quality=82, method=4)
    print(f"Wrote {DST.relative_to(ROOT)}: {out.shape[1]}x{out.shape[0]} ({DST.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
