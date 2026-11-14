#!/usr/bin/env python3
"""Bake a global multi-sensor SAR composite texture from NASA GIBS.

Sources (all through NASA GIBS, WMS EPSG:4326):
  * NISAR L-band GCOV false colour (R = HH, G = HV, B = HH/HV)      -- primary
  * OPERA RTC Sentinel-1 C-band false colour                       -- cross-check + gap fill
  * MODIS IGBP land cover                                          -- reference classes
  * OSM land mask                                                  -- land / ice only

Pipeline:
  1. per-sensor clean median composite: every daily swath is eroded by a few
     pixels (noisy swath edges), then each pixel is the per-channel median of
     all valid days (hides seams between passes and one-off outliers);
  2. harmonisation: for every land-cover class a robust linear colour mapping
     Sentinel-1 -> NISAR scale is fitted on pixels seen by both sensors
     (iteratively trimmed least squares, so contaminated pixels do not bias it);
  3. cross-sensor consistency check: NISAR pixels with a strong HV excess and
     HH deficit relative to the Sentinel-1 prediction (typical L-band RFI
     signature) are flagged; areas with many flagged pixels are replaced by
     the harmonised Sentinel-1 value with a soft transition;
  4. gaps without NISAR data are filled with harmonised Sentinel-1;
  5. result is clipped to land/ice, saved as WebP with alpha + JSON metadata
     (including the share of each source and agreement statistics).

Usage:
    python scripts/bake_sar.py [--end YYYY-MM-DD] [--days 36] [--s1-days 24] [--width 4096]
"""
import argparse
import datetime as dt
import gc
import io
import json
import re
import sys
import time
import urllib.request
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

NISAR_LAYER = "NISAR_L2_Geocoded_Polarimetric_Covariance"
S1_LAYER = "OPERA_L2_Radiometric_Terrain_Corrected_SAR_Sentinel-1"
LANDCOVER_LAYER = "MODIS_Combined_L3_IGBP_Land_Cover_Type_Annual"
LAND_MASK_LAYER = "OSM_Land_Mask"
TITLE = "Multi-sensor SAR backscatter (NISAR L-band + Sentinel-1 C-band, NISAR colour scale)"

WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"
CAPS = "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/1.0.0/WMTSCapabilities.xml"
ROOT = Path(__file__).resolve().parent.parent
OUT_IMAGE = ROOT / "src" / "textures" / "sar.webp"
OUT_META = ROOT / "src" / "sar-meta.json"
UA = {"User-Agent": "earth3d-sar-baker"}

EDGE_ERODE_PX = 2        # pixels removed along every swath edge
VALID_ALPHA = 200        # GIBS alpha above this counts as valid data
BAND_ROWS = 128          # rows processed at once for the median (memory bound)
TRAIN_SAMPLES = 600_000  # max pixels used to fit the colour mapping
MIN_CLASS_SAMPLES = 2000 # classes with fewer samples use the global mapping
RFI_SCORE = 80           # (HV excess) + (HH deficit) vs Sentinel-1 prediction
RFI_RADIUS_PX = 6        # neighbourhood (box) radius for the flagged fraction
RFI_FRAC_LO, RFI_FRAC_HI = 0.10, 0.30  # flagged fraction -> Sentinel-1 weight 0..1


# ----------------------------------------------------------------------------- download

def http_get(url, tries=4):
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=180) as r:
                return r.read()
        except Exception as e:  # network hiccups: retry with backoff
            if attempt == tries - 1:
                raise
            print(f"  retry {attempt + 1} for {url[:90]}…: {e}", file=sys.stderr)
            time.sleep(2 ** attempt)


def latest_date(layer):
    """Default (latest) date of a layer according to GIBS GetCapabilities."""
    caps = http_get(CAPS).decode("utf-8")
    block = caps[caps.index(f"<ows:Identifier>{layer}</ows:Identifier>"):]
    m = re.search(r"<Default>(\d{4}-\d{2}-\d{2})</Default>", block)
    if not m:
        raise SystemExit(f"Could not find default date for {layer} in GetCapabilities")
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


# ----------------------------------------------------------------------------- compositing

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


def fetch_day(layer, day, width, height):
    rgba = fetch_rgba(wms_url(layer, width, height, day), width, height)
    valid = erode(rgba[..., 3] > VALID_ALPHA, EDGE_ERODE_PX)
    return np.ascontiguousarray(rgba[..., :3]), valid


def median_composite(layer, days, width, height):
    """Per-pixel, per-channel median over the days where the pixel is valid."""
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda d: fetch_day(layer, d, width, height), days))
    rgbs = [r[0] for r in results]
    masks = [r[1] for r in results]
    out = np.zeros((height, width, 3), np.float32)
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
        out[y0:y1][ok] = med[ok]
        has[y0:y1] = ok
    del results, rgbs, masks
    gc.collect()
    return out, has


# ----------------------------------------------------------------------------- harmonisation

def design(x):
    """Feature matrix [R, G, B, 1] for a linear colour mapping."""
    return np.hstack([x, np.ones((x.shape[0], 1), np.float32)])


def robust_fit(src, dst, iterations=4, ridge=1.0):
    """Iteratively trimmed least squares src(n,3) -> dst(n,3). Returns (4,3) matrix."""
    keep = np.ones(len(src), bool)
    coef = None
    for _ in range(iterations):
        a = design(src[keep])
        b = dst[keep]
        coef = np.linalg.solve(a.T @ a + ridge * np.eye(4), a.T @ b)
        res = np.linalg.norm(design(src) @ coef - dst, axis=1)
        thr = max(25.0, 2.5 * float(np.median(res[keep])))
        keep = res < thr
        if keep.sum() < 50:
            break
    return coef


def class_ids(landcover_rgba):
    rgb = landcover_rgba[..., :3].astype(np.int32)
    ids = (rgb[..., 0] << 16) | (rgb[..., 1] << 8) | rgb[..., 2]
    ids[landcover_rgba[..., 3] < 255] = -1
    return ids


def box_mean(values, weights, r):
    """Mean of `values` over a (2r+1)^2 box, counting only cells where weights=1."""
    def integral(a):
        s = np.zeros((a.shape[0] + 1, a.shape[1] + 1), np.float64)
        s[1:, 1:] = a.cumsum(0).cumsum(1)
        return s

    def box(s):
        h, w = s.shape[0] - 1, s.shape[1] - 1
        y = np.arange(h)
        x = np.arange(w)
        y0, y1 = np.clip(y - r, 0, h), np.clip(y + r + 1, 0, h)
        x0, x1 = np.clip(x - r, 0, w), np.clip(x + r + 1, 0, w)
        return (s[y1][:, x1] - s[y0][:, x1] - s[y1][:, x0] + s[y0][:, x0])

    num = box(integral(values * weights))
    den = box(integral(weights))
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(den > 0, num / den, 0.0)


# ----------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--end", default="", help="last day YYYY-MM-DD (default: latest NISAR day)")
    ap.add_argument("--days", type=int, default=36, help="NISAR days (3 x 12-day repeat cycle)")
    ap.add_argument("--s1-days", type=int, default=24, help="Sentinel-1 days")
    ap.add_argument("--width", type=int, default=4096)
    ap.add_argument("--quality", type=int, default=85)
    args = ap.parse_args()

    width, height = args.width, args.width // 2
    end = dt.date.fromisoformat(args.end) if args.end else latest_date(NISAR_LAYER)
    s1_end = min(end, latest_date(S1_LAYER)) if not args.end else end
    n_days = [end - dt.timedelta(days=i) for i in range(args.days)][::-1]
    s_days = [s1_end - dt.timedelta(days=i) for i in range(args.s1_days)][::-1]
    print(f"NISAR {n_days[0]} .. {n_days[-1]} ({len(n_days)} d), "
          f"Sentinel-1 {s_days[0]} .. {s_days[-1]} ({len(s_days)} d), {width}x{height}")

    land = fetch_rgba(wms_url(LAND_MASK_LAYER, width, height), width, height)[..., 3]
    classes = class_ids(fetch_rgba(wms_url(LANDCOVER_LAYER, width, height), width, height))
    is_land = land >= 128

    t = time.time()
    nis, nis_has = median_composite(NISAR_LAYER, n_days, width, height)
    print(f"NISAR composite: {time.time() - t:.0f}s")
    t = time.time()
    s1, s1_has = median_composite(S1_LAYER, s_days, width, height)
    print(f"Sentinel-1 composite: {time.time() - t:.0f}s")

    # --- harmonisation S1 -> NISAR scale, per land-cover class
    both = is_land & nis_has & s1_has
    idx = np.flatnonzero(both)
    rng = np.random.default_rng(0)
    if len(idx) > TRAIN_SAMPLES:
        idx = rng.choice(idx, TRAIN_SAMPLES, replace=False)
    src_all = s1.reshape(-1, 3)[idx]
    dst_all = nis.reshape(-1, 3)[idx]
    cls_all = classes.reshape(-1)[idx]
    global_coef = robust_fit(src_all, dst_all)
    coefs = {}
    for c in np.unique(cls_all):
        sel = cls_all == c
        if c >= 0 and sel.sum() >= MIN_CLASS_SAMPLES:
            coefs[int(c)] = robust_fit(src_all[sel], dst_all[sel])
    print(f"Fitted colour mapping: {len(coefs)} land-cover classes + global fallback")

    pred = np.zeros_like(s1)
    flat_cls = classes.reshape(-1)
    flat_s1 = s1.reshape(-1, 3)
    flat_pred = pred.reshape(-1, 3)
    has_pred = (is_land & s1_has).reshape(-1)
    default = np.ones(flat_cls.shape, bool)
    for c, coef in coefs.items():
        sel = has_pred & (flat_cls == c)
        flat_pred[sel] = design(flat_s1[sel]) @ coef
        default &= ~sel
    sel = has_pred & default
    flat_pred[sel] = design(flat_s1[sel]) @ global_coef
    pred = np.clip(pred, 0, 255)
    s1_ok = is_land & s1_has

    # --- cross-sensor consistency check (RFI signature: HV excess + HH deficit)
    score = (nis[..., 1] - pred[..., 1]) - (nis[..., 0] - pred[..., 0])
    checkable = (is_land & nis_has & s1_ok).astype(np.float64)
    flagged = ((score > RFI_SCORE) & (checkable > 0)).astype(np.float64)
    frac = box_mean(flagged, checkable, RFI_RADIUS_PX)
    w_s1 = np.clip((frac - RFI_FRAC_LO) / (RFI_FRAC_HI - RFI_FRAC_LO), 0, 1)
    w_s1[~nis_has] = 1.0          # gaps in NISAR -> Sentinel-1
    w_s1[~s1_ok] = 0.0            # no Sentinel-1 -> keep NISAR as is
    has_any = is_land & (nis_has | s1_ok)

    fused = (1 - w_s1)[..., None] * nis + w_s1[..., None] * pred
    rgb = np.clip(np.rint(fused), 0, 255).astype(np.uint8)
    alpha = np.where(has_any, land, 0).astype(np.uint8)
    rgb[alpha == 0] = 0

    # --- statistics for the report
    land_px = max(1, int(is_land.sum()))
    covered = has_any
    clean = both & (score <= RFI_SCORE)
    agreement = np.linalg.norm(nis[clean] - pred[clean], axis=1)
    stats = {
        "landCoveredPercent": round(100.0 * covered.sum() / land_px, 1),
        "nisarSharePercent": round(100.0 * float(((1 - w_s1) * covered).sum()) / max(1, covered.sum()), 1),
        "sentinel1SharePercent": round(100.0 * float((w_s1 * covered).sum()) / max(1, covered.sum()), 1),
        "nisarFlaggedRfiPercentOfLand": round(100.0 * float(((frac > RFI_FRAC_LO) & is_land & nis_has).sum()) / land_px, 1),
        "gapsFilledBySentinel1PercentOfLand": round(100.0 * float((is_land & ~nis_has & s1_ok).sum()) / land_px, 1),
        "crossSensorMedianColourDifference": round(float(np.median(agreement)), 1) if agreement.size else None,
    }
    print("Stats:", json.dumps(stats))
    if stats["landCoveredPercent"] < 20:
        raise SystemExit("Coverage suspiciously low, not writing output")

    OUT_IMAGE.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.dstack([rgb, alpha]), "RGBA").save(OUT_IMAGE, "WEBP", quality=args.quality, method=6)
    meta = {
        "title": TITLE,
        "start": min(n_days[0], s_days[0]).isoformat(),
        "end": max(n_days[-1], s_days[-1]).isoformat(),
        "days": len(n_days),
        "sources": [
            {"name": "NISAR L-band GCOV (NASA-ISRO)", "layer": NISAR_LAYER,
             "start": n_days[0].isoformat(), "end": n_days[-1].isoformat(), "role": "primary"},
            {"name": "Sentinel-1 C-band RTC (ESA / NASA OPERA)", "layer": S1_LAYER,
             "start": s_days[0].isoformat(), "end": s_days[-1].isoformat(),
             "role": "cross-check, RFI replacement, gap fill (harmonised to NISAR colour scale)"},
            {"name": "MODIS IGBP land cover", "layer": LANDCOVER_LAYER, "role": "reference classes for harmonisation"},
            {"name": "OSM land mask", "layer": LAND_MASK_LAYER, "role": "land / ice clipping"},
        ],
        "stats": stats,
        "width": width,
        "height": height,
        "source": "NASA GIBS",
    }
    OUT_META.write_text(json.dumps(meta, indent=2) + "\n")
    print(f"Wrote {OUT_IMAGE.relative_to(ROOT)} ({OUT_IMAGE.stat().st_size // 1024} KB) and {OUT_META.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
