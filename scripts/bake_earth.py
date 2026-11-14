#!/usr/bin/env python3
"""Bake the three level-of-detail Earth base textures from NASA GIBS.

One 8192x4096 image of a static GIBS Blue Marble layer is downloaded once and
downscaled (Lanczos) to the lower levels, so all levels have identical colours
and switching between them is seamless:

    src/textures/earth_2k.webp   2048x1024  far     (bundled, loaded at start)
    src/textures/earth_4k.webp   4096x2048  middle  (loaded on demand)
    src/textures/earth_8k.webp   8192x4096  close   (loaded on demand, desktop)

Usage:
    python scripts/bake_earth.py [--layer BlueMarble_ShadedRelief_Bathymetry]
"""
import argparse
import io
import sys
import time
import urllib.request
from pathlib import Path

from PIL import Image

Image.MAX_IMAGE_PIXELS = None

WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"
ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "src" / "textures"
UA = {"User-Agent": "earth3d-texture-baker"}
LEVELS = [(2048, "earth_2k.webp", 88), (4096, "earth_4k.webp", 85), (8192, "earth_8k.webp", 82)]


def http_get(url, tries=4):
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=300) as r:
                return r.read()
        except Exception as e:
            if attempt == tries - 1:
                raise
            print(f"  retry {attempt + 1}: {e}", file=sys.stderr)
            time.sleep(2 ** attempt)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--layer", default="BlueMarble_ShadedRelief_Bathymetry")
    args = ap.parse_args()

    w, h = LEVELS[-1][0], LEVELS[-1][0] // 2
    url = (f"{WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS={args.layer}&STYLES="
           f"&CRS=EPSG:4326&BBOX=-90,-180,90,180&WIDTH={w}&HEIGHT={h}&FORMAT=image/png")
    print(f"Downloading {args.layer} {w}x{h} …")
    src = Image.open(io.BytesIO(http_get(url))).convert("RGB")
    if src.size != (w, h):
        raise SystemExit(f"Unexpected size {src.size}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for width, name, quality in LEVELS:
        img = src if width == w else src.resize((width, width // 2), Image.LANCZOS)
        path = OUT_DIR / name
        img.save(path, "WEBP", quality=quality, method=6)
        print(f"Wrote {path.relative_to(ROOT)} {img.size[0]}x{img.size[1]} ({path.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
