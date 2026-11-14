#!/usr/bin/env python3
"""Bake a global SAR composite texture from NASA GIBS.

Downloads N daily global images of a GIBS layer (WMS, EPSG:4326) and builds a
clean composite:
  * every daily swath is eroded by a few pixels (swath edges are dark/noisy),
  * each pixel is the per-channel MEDIAN of all valid days (hides seams between
    passes and one-off outliers such as RFI streaks),
  * the result is clipped to land/ice with the GIBS OSM_Land_Mask layer (SAR over
    open water is near-black and shows up as blocky swath patches).
Saves one WebP with alpha plus a small JSON with metadata for the site legend.

Usage:
    python scripts/bake_sar.py [--end YYYY-MM-DD] [--days 24] [--width 4096]
"""
import argparse
import datetime as dt
import io
import json
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import warnings

import numpy as np
from PIL import Image

LAYER = "NISAR_L2_Geocoded_Polarimetric_Covariance"
TITLE = "NISAR L-band backscatter (GCOV, false colour)"
WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"
CAPS = "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/1.0.0/WMTSCapabilities.xml"
ROOT = Path(__file__).resolve().parent.parent
OUT_IMAGE = ROOT / "src" / "textures" / "sar.webp"
OUT_META = ROOT / "src" / "sar-meta.json"
LAND_MASK_LAYER = "OSM_Land_Mask"
UA = {"User-Agent": "earth3d-sar-baker"}
EDGE_ERODE_PX = 2      # pixels removed along every swath edge
VALID_ALPHA = 200      # GIBS alpha above this counts as valid data
BAND_ROWS = 128        # rows processed at once for the median (memory bound)


def http_get(url, tries=4):
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
                return r.read()
        except Exception as e:  # network hiccups: retry with backoff
            if attempt == tries - 1:
                raise
            print(f"  retry {attempt + 1} for {url[:90]}…: {e}", file=sys.stderr)
            time.sleep(2 ** attempt)


def latest_date():
    """Default (latest) date of the layer according to GIBS GetCapabilities."""
    caps = http_get(CAPS).decode("utf-8")
    block = caps[caps.index(f"<ows:Identifier>{LAYER}</ows:Identifier>"):]
    m = re.search(r"<Default>(\d{4}-\d{2}-\d{2})</Default>", block)
    if not m:
        raise SystemExit("Could not find default date for layer in GetCapabilities")
    return dt.date.fromisoformat(m.group(1))


def wms_url(layer, width, height, day=None):
    url = (f"{WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS={layer}&STYLES="
           f"&CRS=EPSG:4326&BBOX=-90,-180,90,180&WIDTH={width}&HEIGHT={height}"
           f"&FORMAT=image/png&TRANSPARENT=true")
    return url + (f"&TIME={day.isoformat()}" if day else "")


def fetch_rgba(url, width, height):
    img = Image.open(io.BytesIO(http_get(url))).convert("RGBA")
    if img.size != (width, height):
        raise SystemExit(f"Unexpected image size {img.size} for {url[:120]}")
    return np.asarray(img)


def erode(mask, r):
    """Binary erosion with a 3x3 cross, r times (pure numpy)."""
    m = mask.copy()
    for _ in range(r):
        e = m.copy()
        e[1:, :] &= m[:-1, :]
        e[:-1, :] &= m[1:, :]
        e[:, 1:] &= m[:, :-1]
        e[:, :-1] &= m[:, 1:]
        e[0, :] = e[-1, :] = False
        m = e
    return m


def fetch_day(day, width, height):
    rgba = fetch_rgba(wms_url(LAYER, width, height, day), width, height)
    valid = erode(rgba[..., 3] > VALID_ALPHA, EDGE_ERODE_PX)
    return day, np.ascontiguousarray(rgba[..., :3]), valid


def median_composite(rgbs, masks):
    """Per-pixel, per-channel median over the days where the pixel is valid."""
    height, width, _ = rgbs[0].shape
    out = np.zeros((height, width, 3), np.uint8)
    has = np.zeros((height, width), bool)
    for y0 in range(0, height, BAND_ROWS):
        y1 = min(y0 + BAND_ROWS, height)
        stack = np.stack([r[y0:y1] for r in rgbs]).astype(np.float32)   # (days, rows, W, 3)
        valid = np.stack([m[y0:y1] for m in masks])                     # (days, rows, W)
        stack[~valid] = np.nan
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)              # all-NaN pixels
            med = np.nanmedian(stack, axis=0)
        ok = valid.any(axis=0)
        out[y0:y1][ok] = np.clip(np.rint(med[ok]), 0, 255).astype(np.uint8)
        has[y0:y1] = ok
    return out, has


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--end", default="", help="last day YYYY-MM-DD (default: latest available)")
    ap.add_argument("--days", type=int, default=24)
    ap.add_argument("--width", type=int, default=4096)
    ap.add_argument("--quality", type=int, default=85)
    args = ap.parse_args()

    end = dt.date.fromisoformat(args.end) if args.end else latest_date()
    width, height = args.width, args.width // 2
    days = [end - dt.timedelta(days=i) for i in range(args.days)][::-1]  # oldest first
    print(f"Layer {LAYER}: {days[0]} .. {days[-1]} ({len(days)} days), {width}x{height}")

    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda d: fetch_day(d, width, height), days))
    land = fetch_rgba(wms_url(LAND_MASK_LAYER, width, height), width, height)[..., 3]

    rgb, has = median_composite([r[1] for r in results], [r[2] for r in results])
    alpha = np.where(has, land, 0).astype(np.uint8)          # keep land/ice only, soft coastline
    rgb[alpha == 0] = 0

    pct = 100.0 * np.count_nonzero(alpha) / alpha.size
    print(f"Coverage (land with data): {pct:.1f}% of the map")
    if pct < 5:
        raise SystemExit("Coverage suspiciously low, not writing output")

    OUT_IMAGE.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.dstack([rgb, alpha]), "RGBA").save(OUT_IMAGE, "WEBP", quality=args.quality, method=6)
    meta = {
        "layer": LAYER,
        "title": TITLE,
        "start": days[0].isoformat(),
        "end": days[-1].isoformat(),
        "days": len(days),
        "width": width,
        "height": height,
        "coveragePercent": round(pct, 1),
        "method": "median of valid days, swath edges eroded, land mask (OSM_Land_Mask)",
        "source": "NASA GIBS",
    }
    OUT_META.write_text(json.dumps(meta, indent=2) + "\n")
    print(f"Wrote {OUT_IMAGE.relative_to(ROOT)} ({OUT_IMAGE.stat().st_size // 1024} KB) and {OUT_META.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
