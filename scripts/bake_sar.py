#!/usr/bin/env python3
"""Bake a global SAR composite texture from NASA GIBS.

Downloads N daily global images of a GIBS layer (WMS, EPSG:4326), stacks them
oldest -> newest (newest day on top) and saves one WebP with alpha plus a small
JSON with metadata that the site reads for its legend.

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

from PIL import Image

LAYER = "NISAR_L2_Geocoded_Polarimetric_Covariance"
TITLE = "NISAR L-band backscatter (GCOV, false colour)"
WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"
CAPS = "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/1.0.0/WMTSCapabilities.xml"
ROOT = Path(__file__).resolve().parent.parent
OUT_IMAGE = ROOT / "src" / "textures" / "sar.webp"
OUT_META = ROOT / "src" / "sar-meta.json"
UA = {"User-Agent": "earth3d-sar-baker"}


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


def fetch_day(day, width, height):
    url = (f"{WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS={LAYER}&STYLES="
           f"&CRS=EPSG:4326&BBOX=-90,-180,90,180&WIDTH={width}&HEIGHT={height}"
           f"&FORMAT=image/png&TRANSPARENT=true&TIME={day.isoformat()}")
    data = http_get(url)
    img = Image.open(io.BytesIO(data)).convert("RGBA")
    if img.size != (width, height):
        raise SystemExit(f"Unexpected image size {img.size} for {day}")
    return day, img


def coverage(img):
    alpha = img.getchannel("A")
    hist = alpha.histogram()
    return 100.0 * (1 - hist[0] / (img.width * img.height))


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
        results = dict(pool.map(lambda d: fetch_day(d, width, height), days))

    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    for day in days:  # newest day ends up on top
        canvas.alpha_composite(results[day])

    pct = coverage(canvas)
    print(f"Coverage: {pct:.1f}% of the map")
    if pct < 5:
        raise SystemExit("Coverage suspiciously low, not writing output")

    OUT_IMAGE.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(OUT_IMAGE, "WEBP", quality=args.quality, method=6)
    meta = {
        "layer": LAYER,
        "title": TITLE,
        "start": days[0].isoformat(),
        "end": days[-1].isoformat(),
        "days": len(days),
        "width": width,
        "height": height,
        "coveragePercent": round(pct, 1),
        "source": "NASA GIBS",
    }
    OUT_META.write_text(json.dumps(meta, indent=2) + "\n")
    print(f"Wrote {OUT_IMAGE.relative_to(ROOT)} ({OUT_IMAGE.stat().st_size // 1024} KB) and {OUT_META.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
