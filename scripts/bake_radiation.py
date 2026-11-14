#!/usr/bin/env python3
"""Bake the ground-level radiation background texture from Safecast measurements.

Data: the complete Safecast radiation dataset (citizen-science dosimeter readings,
CC0 public domain, https://safecast.org), downloaded as one archive and processed
as a stream (nothing is stored on disk).

Pipeline:
  1. stream https://api.safecast.org/system/measurements.tar.gz and read the CSV in chunks;
  2. keep recent radiation readings (--since, default 2018-01-01) in cpm or uSv/h;
     convert cpm -> uSv/h with the Safecast factor for the LND 7317 tube (334 cpm per uSv/h);
     drop implausible values;
  3. aggregate per 0.5 x 0.5 degree cell: geometric mean (robust to single spikes),
     only cells with at least --min-count readings are shown;
  4. colour with a logarithmic scale 0.02 .. 1 uSv/h; cells without measurements stay
     transparent (honest: no interpolation into unmeasured areas);
  5. write src/textures/radiation.webp + src/radiation-meta.json (dates, scale, statistics).

Usage:
    python scripts/bake_radiation.py [--since 2018-01-01] [--min-count 10]
"""
import argparse
import csv
import io
import json
import sys
import tarfile
import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests
from PIL import Image

URL = "https://api.safecast.org/system/measurements.tar.gz"
ROOT = Path(__file__).resolve().parent.parent
OUT_IMAGE = ROOT / "src" / "textures" / "radiation.webp"
OUT_META = ROOT / "src" / "radiation-meta.json"

CELL_DEG = 0.5
NX, NY = int(360 / CELL_DEG), int(180 / CELL_DEG)
PX_PER_CELL = 4                                   # texture 2880 x 1440
CPM_PER_USVH = 334.0                              # Safecast bGeigie (LND 7317)
VALID_USVH = (0.005, 50.0)
SCALE_MIN, SCALE_MAX = 0.02, 1.0                  # uSv/h, logarithmic colour scale
# colour stops (uSv/h, RGB): low natural background -> high
STOPS = [
    (0.02, (40, 90, 200)),
    (0.05, (40, 180, 200)),
    (0.10, (70, 200, 90)),
    (0.20, (240, 220, 60)),
    (0.40, (245, 130, 40)),
    (1.00, (200, 30, 60)),
]
CELL_ALPHA = 235


class ProgressReader:
    """File-like wrapper that reports download progress."""

    def __init__(self, raw, total):
        self.raw, self.total, self.done, self.last = raw, total, 0, 0.0

    def read(self, n=-1):
        chunk = self.raw.read(n)
        self.done += len(chunk)
        now = time.time()
        if now - self.last > 30:
            self.last = now
            pct = f" ({self.done / self.total * 100:.0f}%)" if self.total else ""
            print(f"  downloaded {self.done / 1e9:.2f} GB{pct}", flush=True)
        return chunk


class StreamRaw(io.RawIOBase):
    """Non-seekable raw stream over a tar member (pandas needs seekable()/readinto())."""

    def __init__(self, f):
        self.f = f

    def readable(self):
        return True

    def seekable(self):
        return False

    def readinto(self, b):
        data = self.f.read(len(b))
        b[:len(data)] = data
        return len(data)


def column(columns, *names):
    lower = {c.strip().lower(): c for c in columns}
    for n in names:
        if n in lower:
            return lower[n]
    raise SystemExit(f"Column {names} not found in {list(columns)}")


def aggregate(since, chunk_rows):
    log_sum = np.zeros(NX * NY, np.float64)
    count = np.zeros(NX * NY, np.int64)
    first, last, used, seen = None, None, 0, 0

    r = requests.get(URL, stream=True, timeout=300, headers={"User-Agent": "earth3d-radiation-baker"})
    r.raise_for_status()
    total = int(r.headers.get("content-length") or 0)
    print(f"Archive size: {total / 1e9:.2f} GB" if total else "Archive size: unknown")
    r.raw.decode_content = False
    with tarfile.open(fileobj=ProgressReader(r.raw, total), mode="r|gz") as tar:
        for member in tar:
            if not member.isfile() or not member.name.lower().endswith(".csv"):
                continue
            print(f"Reading {member.name} ({member.size / 1e9:.2f} GB)")
            f = io.TextIOWrapper(io.BufferedReader(StreamRaw(tar.extractfile(member)), 1 << 20),
                                 encoding="utf-8", errors="replace", newline="")
            header = next(csv.reader([f.readline()]))                         # header line only
            header = [h.strip() for h in header]
            c_time = column(header, "captured time", "captured_at")
            c_lat = column(header, "latitude")
            c_lon = column(header, "longitude")
            c_val = column(header, "value")
            c_unit = column(header, "unit")
            reader = pd.read_csv(f, names=list(header), header=None, usecols=[c_time, c_lat, c_lon, c_val, c_unit],
                                 chunksize=chunk_rows, on_bad_lines="skip", low_memory=True,
                                 dtype={c_time: str, c_unit: str})
            for chunk in reader:
                seen += len(chunk)
                t = chunk[c_time].astype(str).str.slice(0, 10)
                unit = chunk[c_unit].astype(str).str.strip().str.lower()
                lat = pd.to_numeric(chunk[c_lat], errors="coerce").to_numpy()
                lon = pd.to_numeric(chunk[c_lon], errors="coerce").to_numpy()
                val = pd.to_numeric(chunk[c_val], errors="coerce").to_numpy()
                usvh = np.where(unit == "cpm", val / CPM_PER_USVH,
                                np.where(unit.isin(["usv", "usv/h", "microsievert", "µsv/h", "usvh"]), val, np.nan))
                ok = ((t >= since).to_numpy() & np.isfinite(usvh) & np.isfinite(lat) & np.isfinite(lon)
                      & (usvh >= VALID_USVH[0]) & (usvh <= VALID_USVH[1])
                      & (np.abs(lat) <= 90) & (np.abs(lon) <= 180) & ~((lat == 0) & (lon == 0)))
                if not ok.any():
                    continue
                ix = np.clip(((lon[ok] + 180) / CELL_DEG).astype(int), 0, NX - 1)
                iy = np.clip(((90 - lat[ok]) / CELL_DEG).astype(int), 0, NY - 1)
                idx = iy * NX + ix
                log_sum += np.bincount(idx, weights=np.log(usvh[ok]), minlength=NX * NY)
                count += np.bincount(idx, minlength=NX * NY)
                used += int(ok.sum())
                ts = t[ok]
                lo, hi = ts.min(), ts.max()
                first = lo if first is None or lo < first else first
                last = hi if last is None or hi > last else last
                if seen % (chunk_rows * 20) < chunk_rows:
                    print(f"  rows read {seen / 1e6:.0f} M, used {used / 1e6:.1f} M", flush=True)
    print(f"Done: {seen / 1e6:.1f} M rows read, {used / 1e6:.1f} M used")
    return log_sum.reshape(NY, NX), count.reshape(NY, NX), first, last, used, seen


def colourize(usvh):
    xs = np.log10([s[0] for s in STOPS])
    v = np.log10(np.clip(usvh, SCALE_MIN, SCALE_MAX))
    rgb = np.zeros(usvh.shape + (3,))
    for ch in range(3):
        rgb[..., ch] = np.interp(v, xs, [s[1][ch] for s in STOPS])
    return np.rint(rgb).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", default="2018-01-01", help="ignore readings captured before this date")
    ap.add_argument("--min-count", type=int, default=10, help="minimum readings per cell")
    ap.add_argument("--chunk-rows", type=int, default=2_000_000)
    args = ap.parse_args()

    log_sum, count, first, last, used, seen = aggregate(args.since, args.chunk_rows)
    shown = count >= args.min_count
    if shown.sum() < 100:
        raise SystemExit("Too few cells with data, not writing output")
    gmean = np.full(count.shape, np.nan)
    gmean[shown] = np.exp(log_sum[shown] / count[shown])

    rgb = colourize(np.nan_to_num(gmean, nan=SCALE_MIN))
    alpha = np.where(shown, CELL_ALPHA, 0).astype(np.uint8)
    rgb[~shown] = 0
    img = np.dstack([rgb, alpha])
    img = np.repeat(np.repeat(img, PX_PER_CELL, axis=0), PX_PER_CELL, axis=1)
    OUT_IMAGE.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(img, "RGBA").save(OUT_IMAGE, "WEBP", lossless=True, method=6)

    lat = 90 - (np.arange(NY) + 0.5) * CELL_DEG
    area = np.cos(np.radians(lat))[:, None] * np.ones((1, NX))
    values = gmean[shown]
    meta = {
        "title": "Ground-level radiation background (Safecast)",
        "source": "Safecast (CC0)",
        "url": URL,
        "start": first,
        "end": last,
        "since": args.since,
        "unit": "µSv/h",
        "cellDegrees": CELL_DEG,
        "scale": {"min": SCALE_MIN, "max": SCALE_MAX, "log": True,
                  "stops": [[s[0], "#%02x%02x%02x" % s[1]] for s in STOPS]},
        "stats": {
            "readingsUsed": used,
            "rowsRead": seen,
            "cellsWithData": int(shown.sum()),
            "earthSurfaceCoveredPercent": round(float(area[shown].sum() / area.sum() * 100), 2),
            "medianUSvH": round(float(np.median(values)), 3),
            "p95USvH": round(float(np.percentile(values, 95)), 3),
            "maxCellUSvH": round(float(values.max()), 3),
        },
    }
    OUT_META.write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n")
    print("Stats:", json.dumps(meta["stats"]))
    print(f"Wrote {OUT_IMAGE.relative_to(ROOT)} ({OUT_IMAGE.stat().st_size // 1024} KB) and {OUT_META.relative_to(ROOT)}")


if __name__ == "__main__":
    sys.exit(main())
