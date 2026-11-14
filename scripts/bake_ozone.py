#!/usr/bin/env python3
"""Bake the global total-column ozone texture from NASA OMI/Aura OMTO3d (GES DISC).

Data: OMTO3d V004 -- OMI/Aura TOMS-like ozone, L3, 1 day, 1 x 1 degree
(ColumnAmountO3, Dobson units). Files are protected by Earthdata Login:
the script needs an Earthdata token in the EARTHDATA_TOKEN environment
variable (stored as a GitHub Actions secret, never in the repository).

Pipeline:
  1. find the latest N daily granules through the public NASA CMR API;
  2. download them (Bearer token) and read ColumnAmountO3 from the HDF-EOS5 file;
  3. average the valid values of the N days per 1 x 1 degree cell (fills the
     gaps between orbits and the OMI row-anomaly stripes);
  4. upsample to 2048 x 1024 (bilinear) and colour with a fixed scale
     (OZONE_MIN..OZONE_MAX DU), cells without data stay transparent (polar night);
  5. write src/textures/ozone.webp + src/ozone-meta.json (dates, scale, statistics).

Usage:
    EARTHDATA_TOKEN=... python scripts/bake_ozone.py [--days 5]
"""
import argparse
import io
import json
import os
import re
import sys
import time
from pathlib import Path

import h5py
import numpy as np
import requests
from PIL import Image

COLLECTION = "C3377057241-GES_DISC"          # OMTO3d V004
CMR = "https://cmr.earthdata.nasa.gov/search/granules.umm_json"
ROOT = Path(__file__).resolve().parent.parent
OUT_IMAGE = ROOT / "src" / "textures" / "ozone.webp"
OUT_META = ROOT / "src" / "ozone-meta.json"

OZONE_MIN, OZONE_MAX = 150.0, 500.0           # colour scale range, Dobson units
# colour stops (DU, RGB): ozone-hole purple -> blue -> green -> yellow -> red
STOPS = [
    (150, (86, 30, 130)),
    (220, (40, 70, 200)),
    (280, (40, 170, 220)),
    (330, (60, 200, 110)),
    (380, (240, 220, 60)),
    (440, (245, 130, 40)),
    (500, (200, 40, 40)),
]
WIDTH = 2048


def find_granules(days):
    params = {"collection_concept_id": COLLECTION, "sort_key": "-start_date", "page_size": days}
    items = requests.get(CMR, params=params, timeout=60).json()["items"]
    granules = []
    for item in items:
        umm = item["umm"]
        url = next(u["URL"] for u in umm["RelatedUrls"]
                   if u.get("Type") == "GET DATA" and u["URL"].startswith("https://") and u["URL"].endswith(".he5"))
        day = umm["TemporalExtent"]["RangeDateTime"]["BeginningDateTime"][:10]
        granules.append((day, url))
    return sorted(granules)


class EarthdataSession(requests.Session):
    """Keeps the Authorization header on redirects between NASA Earthdata hosts.

    GES DISC answers with a redirect to urs.earthdata.nasa.gov (OAuth); plain requests
    drops the Bearer header on that cross-host redirect and gets the login page instead.
    """

    def rebuild_auth(self, prepared_request, response):
        headers = prepared_request.headers
        if "Authorization" in headers:
            old = requests.utils.urlparse(response.request.url).hostname or ""
            new = requests.utils.urlparse(prepared_request.url).hostname or ""
            nasa = lambda h: h.endswith("earthdata.nasa.gov") or h.endswith("gesdisc.eosdis.nasa.gov")
            if not (nasa(old) and nasa(new)) and old != new:
                del headers["Authorization"]      # never send the token to non-NASA hosts (e.g. S3)


def download(session, url, tries=4):
    for attempt in range(tries):
        try:
            r = session.get(url, timeout=180)
            is_html = r.content[:200].lstrip().lower().startswith((b"<!doctype html", b"<html"))
            if r.status_code in (401, 403) or is_html:
                host = requests.utils.urlparse(r.url).hostname
                raise SystemExit(f"Earthdata Login refused the token (HTTP {r.status_code} from {host}): check the "
                                 "EARTHDATA_TOKEN secret and that the 'NASA GESDISC DATA ARCHIVE' application is "
                                 "authorized in your Earthdata profile.")
            r.raise_for_status()
            return r.content
        except SystemExit:
            raise
        except Exception as e:
            if attempt == tries - 1:
                raise
            print(f"  retry {attempt + 1}: {e}", file=sys.stderr)
            time.sleep(2 ** attempt)


def read_ozone(content):
    """ColumnAmountO3 as (180, 360) float array, row 0 = north, NaN where invalid."""
    with h5py.File(io.BytesIO(content), "r") as f:
        found = []
        f.visititems(lambda name, obj: found.append(name)
                     if isinstance(obj, h5py.Dataset) and name.endswith("ColumnAmountO3") else None)
        if not found:
            raise SystemExit("ColumnAmountO3 not found in file")
        data = f[found[0]][()].astype(np.float64)
        # grid origin from the HDF-EOS structural metadata: lower-left (south-first) or upper-left
        meta = ""
        for key in ("HDFEOS INFORMATION/StructMetadata.0",):
            if key in f:
                raw = f[key][()]
                meta = raw.decode("utf-8", "ignore") if isinstance(raw, bytes) else str(raw)
    data[(data < 50) | (data > 1000)] = np.nan
    m = re.search(r"UpperLeftPointMtrs=\(([-\d.]+),([-\d.]+)\)", meta)
    south_first = bool(m and float(m.group(2)) < 0)   # e.g. (-180000000,-90000000)
    if south_first:
        data = data[::-1]
    if data.shape != (180, 360):
        raise SystemExit(f"Unexpected grid {data.shape}")
    return data


def colourize(du):
    """DU array -> RGB uint8 using the piecewise-linear colour stops."""
    xs = np.array([s[0] for s in STOPS], float)
    rgb = np.zeros(du.shape + (3,), np.float64)
    clipped = np.clip(du, OZONE_MIN, OZONE_MAX)
    for ch in range(3):
        rgb[..., ch] = np.interp(clipped, xs, [s[1][ch] for s in STOPS])
    return np.rint(rgb).astype(np.uint8)


def upsample(grid, width):
    """Bilinear upsampling of a (180, 360) grid with NaNs; returns values + validity."""
    valid = np.isfinite(grid)
    filled = np.where(valid, grid, 0.0).astype(np.float32)
    weight = valid.astype(np.float32)
    size = (width, width // 2)
    v = np.asarray(Image.fromarray(filled, "F").resize(size, Image.BILINEAR))
    w = np.asarray(Image.fromarray(weight, "F").resize(size, Image.BILINEAR))
    with np.errstate(invalid="ignore", divide="ignore"):
        out = np.where(w > 0.5, v / np.maximum(w, 1e-6), np.nan)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=5, help="number of latest daily files to average")
    args = ap.parse_args()
    token = os.environ.get("EARTHDATA_TOKEN", "").strip()
    if not token:
        raise SystemExit("EARTHDATA_TOKEN is not set (add it as a repository secret)")

    granules = find_granules(args.days)
    print("Granules:", ", ".join(d for d, _ in granules))
    session = EarthdataSession()
    session.headers["Authorization"] = f"Bearer {token}"
    stack = []
    for day, url in granules:
        stack.append(read_ozone(download(session, url)))
        print(f"  {day}: {np.isfinite(stack[-1]).mean() * 100:.1f}% of cells valid")
    stack = np.stack(stack)
    with np.errstate(invalid="ignore"):
        mean = np.nanmean(stack, axis=0) if np.isfinite(stack).any() else stack[0]
    coverage = float(np.isfinite(mean).mean() * 100)
    print(f"Composite: {coverage:.1f}% of the globe covered")
    if coverage < 40:
        raise SystemExit("Coverage suspiciously low, not writing output")

    hi = upsample(mean, WIDTH)
    rgb = colourize(np.nan_to_num(hi, nan=OZONE_MIN))
    alpha = np.where(np.isfinite(hi), 255, 0).astype(np.uint8)
    rgb[alpha == 0] = 0
    OUT_IMAGE.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.dstack([rgb, alpha]), "RGBA").save(OUT_IMAGE, "WEBP", quality=90, method=6)

    # area-weighted statistics (cells shrink towards the poles)
    lat = np.linspace(89.5, -89.5, 180)
    w = np.cos(np.radians(lat))[:, None] * np.ones((1, 360))
    ok = np.isfinite(mean)
    meta = {
        "title": "Total column ozone (OMI/Aura OMTO3d V004)",
        "source": "NASA GES DISC",
        "collection": COLLECTION,
        "start": granules[0][0],
        "end": granules[-1][0],
        "days": len(granules),
        "unit": "DU",
        "scale": {"min": OZONE_MIN, "max": OZONE_MAX,
                  "stops": [[s[0], "#%02x%02x%02x" % s[1]] for s in STOPS]},
        "stats": {
            "globalMeanDU": round(float(np.sum(mean[ok] * w[ok]) / np.sum(w[ok])), 1),
            "minDU": round(float(np.nanmin(mean)), 1),
            "maxDU": round(float(np.nanmax(mean)), 1),
            "areaBelow220DUPercent": round(float(np.sum(w[ok] * (mean[ok] < 220)) / np.sum(w) * 100), 2),
            "coveragePercent": round(coverage, 1),
        },
    }
    OUT_META.write_text(json.dumps(meta, indent=2) + "\n")
    print("Stats:", json.dumps(meta["stats"]))
    print(f"Wrote {OUT_IMAGE.relative_to(ROOT)} ({OUT_IMAGE.stat().st_size // 1024} KB) and {OUT_META.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
