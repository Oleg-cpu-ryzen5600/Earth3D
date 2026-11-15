#!/usr/bin/env python3
"""Bake additional data layers from NASA GIBS (WMS, EPSG:4326) into WebP textures + a manifest.

For every layer in LAYERS:
  * the latest date comes from the GIBS capabilities (layers without a time dimension are static);
  * the last `days` daily images are fetched and merged as a "latest valid pixel" mosaic
    (newest data wins, older days fill the gaps between satellite orbits);
  * the legend (units, colour scale or classes) is read from the layer's GIBS colour map;
  * src/textures/gibs/<id>.webp and an entry in src/gibs-layers.json are written.

The site reads src/gibs-layers.json and shows one card per layer (loaded only when switched on).

Usage:
    python scripts/bake_gibs_layers.py [--only id1,id2]
"""
import argparse
import datetime as dt
import io
import json
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
from PIL import Image

WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"
CAPS = "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/1.0.0/WMTSCapabilities.xml"
ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "src" / "textures" / "gibs"
MANIFEST = ROOT / "src" / "gibs-layers.json"
UA = {"User-Agent": "earth3d-gibs-baker"}

# id, GIBS layer(s), days to merge, texture width, lossless, category, icon, name, description, extra
LAYERS = [
    # --- Water & radar
    dict(id="soil_moisture", layers=["SMAP_L3_Passive_Day_Soil_Moisture"], days=3, width=1024, soft=True, smooth=1, out=4096,
         category="Water & radar", icon="🌱", name="Soil moisture (SMAP)",
         description="Water in the top 5 cm of soil, measured by the SMAP L-band radiometer — an independent check of the radar water layer."),
    dict(id="surface_water", layers=["OPERA_L3_Dynamic_Surface_Water_Extent-Sentinel-1"], days=12, width=4096, lossless=True,
         drop=["#ffffff", "#c8c8c8", "#808080", "#000000", "#00ff00"], land_only=True, thicken=1,
         recolor={"#0000ff": "#19e3ff"},
         category="Water & radar", icon="🌊", name="Surface water from radar",
         description="Open water (rivers, lakes, flooded land) detected in Sentinel-1 radar images by NASA OPERA."),
    dict(id="floods", layers=["MODIS_Combined_Flood_3-Day"], days=1, width=4096, lossless=True,
         hatch={"#afafaf": "No data (clouds)"},
         category="Water & radar", icon="🚩", name="Floods (last 3 days)",
         description="Flooded areas compared with normal water extent, from MODIS on Terra and Aqua."),
    dict(id="nisar_tracks", layers=["OrbitTracks_NISAR_Ascending", "OrbitTracks_NISAR_Descending"], days=1, width=4096,
         lossless=True, category="Water & radar", icon="🛰️", name="NISAR orbit tracks",
         description="Where the NISAR radar satellite flies over the Earth during one day (ascending and descending passes)."),
    # --- Air
    dict(id="no2", layers=["TROPOMI_L2_Nitrogen_Dioxide_Tropospheric_Column"], days=3, width=4096, smooth=3, min_frac=0.08,
         category="Air quality", icon="NO₂", icon_text=True, name="Nitrogen dioxide",
         description="Air pollution from traffic, industry and power plants (TROPOMI on Sentinel-5P). Cities stand out clearly."),
    dict(id="so2", layers=["TROPOMI_L2_Sulfur_Dioxide_Total_Vertical_Column"], days=5, width=2048, soft=True, smooth=2, out=4096, min_index=1, sparse=True,
         colors=["#6a1b9a", "#d81b60", "#ff6d00", "#ffea00"],
         category="Air quality", icon="SO₂", icon_text=True, name="Sulfur dioxide",
         description="Gas released by volcanoes, coal power plants and smelters (TROPOMI on Sentinel-5P)."),
    dict(id="aerosols", layers=["MODIS_Combined_Value_Added_AOD"], days=3, width=2048, soft=True, smooth=3, out=4096, min_frac=0.12,
         category="Air quality", icon="🌫️", name="Aerosols (dust, smoke, haze)",
         description="How much dust, smoke and haze is in the air (aerosol optical depth, MODIS)."),
    dict(id="fires", layers=["VIIRS_NOAA20_Thermal_Anomalies_375m_All"], days=3, width=4096, lossless=True,
         category="Air quality", icon="🔥", name="Active fires (last 3 days)",
         description="Hot spots detected by the VIIRS instrument on NOAA-20: wildfires, crop burning, gas flares."),
    # --- Temperature, rain & ice
    dict(id="sst", layers=["GHRSST_L4_MUR_Sea_Surface_Temperature"], days=1, width=4096, soft=True, smooth=1,
         value_range=(0, 32), display_range=(0, 30), units_label="°C",
         colors=["#283593", "#1e88e5", "#26c6da", "#66bb6a", "#fdd835", "#fb8c00", "#d84315"],
         category="Temperature, rain & ice", icon="🌡️", name="Sea surface temperature",
         description="Temperature of the ocean surface, gap-free analysis of several satellites (GHRSST MUR)."),
    dict(id="sst_anomaly", layers=["GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies"], days=1, width=4096,
         category="Temperature, rain & ice", icon="📈", name="Sea temperature anomaly",
         description="How much warmer (red) or colder (blue) the ocean is than usual for this time of year."),
    dict(id="land_temp", layers=["MODIS_Terra_L3_Land_Surface_Temp_8Day_Day"], days=1, width=4096,
         category="Temperature, rain & ice", icon="🔆", name="Land surface temperature",
         description="Daytime temperature of the ground, 8-day average from MODIS on Terra."),
    dict(id="precipitation", layers=["IMERG_Precipitation_Rate"], days=1, width=2048, soft_rgb=1, out=4096,
         category="Temperature, rain & ice", icon="🌧️", name="Rain and snowfall rate",
         description="Precipitation from the GPM satellite constellation (IMERG)."),
    dict(id="snow", layers=["MODIS_Terra_L3_NDSI_Snow_Cover_Daily"], days=2, width=4096, soft=True, smooth=1,
         category="Temperature, rain & ice", icon="❄️", name="Snow cover",
         description="Where the ground is covered with snow (MODIS on Terra)."),
    dict(id="sea_ice", layers=["GHRSST_L4_MUR_Sea_Ice_Concentration"], days=1, width=4096, land_ice=True,
         category="Temperature, rain & ice", icon="🧊", name="Sea ice",
         description="Share of the sea surface covered by ice."),
    # --- Land
    dict(id="vegetation", layers=["VIIRS_NOAA20_NDVI_8Day"], days=1, width=4096,
         category="Land & hazards", icon="🌳", name="Vegetation (NDVI)",
         description="How green and dense the plants are, 8-day composite from VIIRS on NOAA-20."),
    dict(id="landslide_hazard", layers=["NDH_Landslide_Hazard_Distribution_2000"], days=1, width=4096, soft=True, smooth=1, min_index=1,
         category="Land & hazards", icon="⛰️", name="Landslide hazard",
         description="Where landslides are likely (NASA SEDAC natural disaster hotspots, static)."),
    dict(id="flood_hazard", layers=["NDH_Flood_Hazard_Frequency_Distribution_1985-2003"], days=1, width=2048, soft=True, smooth=3, out=4096,
         min_index=3,
         category="Land & hazards", icon="⛈️", name="Flood hazard",
         description="How often floods happened in 1985–2003 (NASA SEDAC natural disaster hotspots, static)."),
    dict(id="drought_hazard", layers=["NDH_Drought_Hazard_Frequency_Distribution_1980-2000"], days=1, width=1024, soft=True, smooth=4, out=4096,
         min_index=1,
         category="Land & hazards", icon="🏜️", name="Drought hazard",
         description="How often droughts happened in 1980–2000 (NASA SEDAC natural disaster hotspots, static)."),
    # --- Night
    dict(id="night_lights", layers=["VIIRS_Black_Marble"], days=1, width=4096, opacity=1.0, night=True,
         category="Night", icon="🌃", name="Night lights",
         description="The Earth at night (VIIRS Black Marble): city lights. Switches the globe to night mode."),
]


def http_get(url, tries=4):
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=180) as r:
                return r.read()
        except Exception as e:
            if attempt == tries - 1:
                raise
            print(f"  retry {attempt + 1}: {e}", file=sys.stderr)
            time.sleep(2 ** attempt)


def layer_info(caps, layer):
    """Default date (or None for static layers) and colour map URL from the capabilities."""
    i = caps.find(f"<ows:Identifier>{layer}</ows:Identifier>")
    if i < 0:
        raise SystemExit(f"Layer {layer} not found in GIBS capabilities")
    block = caps[caps.rfind("<Layer>", 0, i):caps.find("</Layer>", i)]
    m = re.search(r"<Default>(\d{4}-\d{2}-\d{2})", block)
    cm = re.search(r"colormap/1\.3['\"][^>]*href=['\"]([^'\"]+)['\"]", block) or \
        re.search(r"href=['\"]([^'\"]+colormaps/v1\.3/[^'\"]+)['\"]", block)
    title = re.search(r"<ows:Title[^>]*>([^<]+)</ows:Title>", block)
    return (dt.date.fromisoformat(m.group(1)) if m else None,
            cm.group(1) if cm else None,
            title.group(1).strip() if title else layer)


def wms(layer, width, day):
    url = (f"{WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS={layer}&STYLES="
           f"&CRS=EPSG:4326&BBOX=-90,-180,90,180&WIDTH={width}&HEIGHT={width // 2}"
           f"&FORMAT=image/png&TRANSPARENT=true")
    if day:
        url += f"&TIME={day.isoformat()}"
    return np.asarray(Image.open(io.BytesIO(http_get(url))).convert("RGBA"))


def mosaic(layers, width, end, days):
    """Latest-valid-pixel mosaic of several days (and several layers drawn on top of each other)."""
    out = np.zeros((width // 2, width, 4), np.uint8)
    used = []
    dates = [end - dt.timedelta(days=k) for k in range(days)] if end else [None]
    for day in dates:
        for layer in layers:
            img = wms(layer, width, day)
            fill = (img[..., 3] > 0) & (out[..., 3] == 0)
            if fill.any():
                out[fill] = img[fill]
                if day and day not in used:
                    used.append(day)
    return out, sorted(used)


def hex_rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def palette(colormap_url):
    """Ordered colours (low -> high) of the first data colour map, without transparent entries."""
    root = ET.fromstring(http_get(colormap_url))
    for cmap in root.iter("ColorMap"):
        if (cmap.get("title") or "").lower().startswith("no data"):
            continue
        rgbs = [tuple(int(v) for v in e.get("rgb").split(",")[:3])
                for e in cmap.iter("ColorMapEntry") if e.get("transparent") != "true"]
        if rgbs:
            return np.array(rgbs, np.float32)
    return None


def to_index(img, pal):
    """Palette index of every opaque pixel (-1 where empty), by nearest colour."""
    valid = img[..., 3] > 127
    rgb = img[..., :3].astype(np.int64)
    packed = (rgb[..., 0] << 16) | (rgb[..., 1] << 8) | rgb[..., 2]
    uniq, inv = np.unique(packed[valid], return_inverse=True)
    ucol = np.stack([(uniq >> 16) & 255, (uniq >> 8) & 255, uniq & 255], 1).astype(np.float32)
    nearest = np.empty(len(uniq), np.int32)
    for a in range(0, len(uniq), 4096):
        d = ((ucol[a:a + 4096, None, :] - pal[None]) ** 2).sum(-1)
        nearest[a:a + 4096] = d.argmin(1)
    idx = np.full(img.shape[:2], -1, np.int32)
    idx[valid] = nearest[inv.reshape(-1)]
    return idx


def box_blur(a, r):
    """Box filter of radius r, wrapping in longitude."""
    if r <= 0:
        return a
    p = np.pad(a, ((r, r), (0, 0)), mode="edge")
    p = np.concatenate([p[:, -r:], p, p[:, :r]], 1)
    c = np.cumsum(np.cumsum(np.pad(p, ((1, 0), (1, 0))), 0), 1)
    k = 2 * r + 1
    return (c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]) / (k * k)


def mosaic_values(layers, width, end, days, pal, cfg):
    """Mean palette index over several days, gaps and stipple filled by normalized convolution,
    low values made transparent, then recoloured with the layer's own palette."""
    total = np.zeros((width // 2, width), np.float64)
    count = np.zeros_like(total)
    used = []
    dates = [end - dt.timedelta(days=k) for k in range(days)] if end else [None]
    for day in dates:
        for layer in layers:
            idx = to_index(wms(layer, width, day), pal)
            ok = idx >= 0
            if ok.any():
                total[ok] += idx[ok]
                count[ok] += 1
                if day and day not in used:
                    used.append(day)
    r = int(cfg.get("smooth", 0))
    w = box_blur(count, r)
    v = box_blur(total, r) / np.maximum(w, 1e-9)
    keep = w > (0.08 if r else 0)
    n = len(pal)
    cut = cfg.get("min_index", round(cfg.get("min_frac", 0) * (n - 1)))
    keep &= v >= cut
    out = np.zeros((width // 2, width, 4), np.uint8)
    out[..., :3] = pal[np.clip(np.rint(v), 0, n - 1).astype(int)].astype(np.uint8)
    out[..., 3] = np.where(keep, 255, 0)
    return out, sorted(used)


def gradient(colors, frac):
    """Colours (N, 3) of a linear gradient through hex `colors` at positions frac in [0, 1]."""
    stops = np.array([hex_rgb(c) for c in colors], np.float32)
    x = np.clip(frac, 0, 1) * (len(stops) - 1)
    i = np.minimum(np.floor(x).astype(int), len(stops) - 2)
    f = (x - i)[..., None]
    return stops[i] * (1 - f) + stops[i + 1] * f


def resize_float(a, width):
    if a.shape[1] == width:
        return a
    return np.asarray(Image.fromarray(a.astype(np.float32), "F").resize((width, width // 2), Image.BILINEAR))


def smoothstep(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def mosaic_soft(layers, width, end, days, pal, cfg):
    """Like the radiation layer: values instead of colours, holes filled by normalized convolution,
    bilinear upscaling, rounded soft-edged zones, and a smooth colour gradient (no blocky pixels)."""
    sparse = bool(cfg.get("sparse"))
    total = np.zeros((width // 2, width), np.float64)
    count = np.zeros_like(total)
    used = []
    dates = [end - dt.timedelta(days=k) for k in range(days)] if end else [None]
    for day in dates:
        for layer in layers:
            idx = to_index(wms(layer, width, day), pal)
            ok = idx >= 0
            if ok.any():
                if sparse:
                    # rare hotspots: keep the strongest value of all days, never average it away
                    total[ok] = np.maximum(total[ok], idx[ok])
                    count[ok] = 1
                else:
                    total[ok] += idx[ok]
                    count[ok] += 1
                if day and day not in used:
                    used.append(day)
    n = len(pal)
    cut = cfg.get("min_index", round(cfg.get("min_frac", 0) * (n - 1)))
    if sparse:
        weak = total < cut                    # background noise is no data, not a low value
        total[weak] = 0
        count[weak] = 0
    has = (count > 0).astype(np.float64)
    r = int(cfg.get("smooth", 1))
    w, t, p = count, total, has
    for _ in range(2):                         # two box passes ~ a soft Gaussian
        w, t, p = box_blur(w, r), box_blur(t, r), box_blur(p, r)
    v = t / np.maximum(w, 1e-9)
    out_w = cfg.get("out", width)
    v = resize_float(v, out_w)
    p = resize_float(p, out_w)
    if sparse:
        alpha = smoothstep((p - 0.01) / 0.05)  # even a single hotspot pixel becomes a soft dot
    else:
        alpha = smoothstep((p - 0.35) / 0.3)   # rounded zone edges, small gaps filled
    if cut > 0 and not sparse:
        band = max(0.6, 0.03 * (n - 1))
        alpha *= smoothstep((v - cut) / band + 0.5)
    if cfg.get("value_range"):
        lo, hi = cfg["value_range"]
        dlo, dhi = cfg["display_range"]
        value = lo + v / (n - 1) * (hi - lo)
        rgb = gradient(cfg["colors"], (value - dlo) / (dhi - dlo))
    elif cfg.get("colors"):
        rgb = gradient(cfg["colors"], v / (n - 1))
    else:
        x = np.clip(v, 0, n - 1)
        i = np.minimum(np.floor(x).astype(int), n - 2)
        f = (x - i)[..., None]
        rgb = pal[i] * (1 - f) + pal[i + 1] * f
    out = np.zeros((out_w // 2, out_w, 4), np.uint8)
    out[..., :3] = np.clip(np.rint(rgb), 0, 255).astype(np.uint8)
    out[..., 3] = np.rint(alpha * 255).astype(np.uint8)
    out[out[..., 3] == 0] = 0
    return out, sorted(used)


def soft_rgb(img, r, out_w):
    """Smoothing in colour space (for layers with several colour maps): premultiplied normalized
    convolution, bilinear upscaling, soft edges."""
    a = img[..., 3].astype(np.float64) / 255
    w, p = a, (a > 0).astype(np.float64)
    ch = [img[..., k].astype(np.float64) * a for k in range(3)]
    for _ in range(2):
        w, p = box_blur(w, r), box_blur(p, r)
        ch = [box_blur(c, r) for c in ch]
    rgb = [resize_float(c / np.maximum(w, 1e-9), out_w) for c in ch]
    p = resize_float(p, out_w)
    out = np.zeros((out_w // 2, out_w, 4), np.uint8)
    for k in range(3):
        out[..., k] = np.clip(np.rint(rgb[k]), 0, 255).astype(np.uint8)
    out[..., 3] = np.rint(smoothstep((p - 0.35) / 0.3) * 255).astype(np.uint8)
    out[out[..., 3] == 0] = 0
    return out


LAND_MASK = "OSM_Land_Mask"


def land_mask(width):
    """True on land (OpenStreetMap land polygons: inland lakes count as land, seas do not)."""
    return wms(LAND_MASK, width, None)[..., 3] > 127


def shifts(m):
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dy or dx:
                yield np.roll(np.roll(m, dy, 0), dx, 1)


def erode(m, n=1):
    for _ in range(n):
        out = m.copy()
        for s in shifts(m):
            out &= s
        m = out
    return m


def dilate_rgba(img, n=1):
    """Grow opaque pixels into empty neighbours (keeps their colour) so thin rivers stay visible."""
    for _ in range(n):
        out = img.copy()
        empty = out[..., 3] == 0
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if not (dy or dx):
                    continue
                src = np.roll(np.roll(img, dy, 0), dx, 1)
                take = empty & (src[..., 3] > 0)
                out[take] = src[take]
                empty &= ~take
        img = out
    return img


def match(img, h, tol=12):
    c = np.array(hex_rgb(h), np.int16)
    return (img[..., 3] > 0) & (np.abs(img[..., :3].astype(np.int16) - c).max(-1) <= tol)


def hatch(img, colors):
    """Areas without data become semi-transparent grey diagonal stripes."""
    hh, ww = img.shape[:2]
    yy, xx = np.mgrid[0:hh, 0:ww]
    stripe = ((xx + yy) // 5) % 2 == 0
    for h in colors:
        m = match(img, h)
        img[m, :3] = 150
        img[m, 3] = np.where(stripe[m], 120, 45)
    return img


def greenland_mask(width):
    from PIL import ImageDraw
    hgt = width // 2
    poly = [(-73, 78.2), (-66, 81.5), (-60, 82.4), (-40, 83.7), (-20, 83.7), (-11, 81.5), (-17, 76),
            (-20, 70), (-31, 67.5), (-40, 64.5), (-43.5, 59.5), (-50, 61), (-54, 66), (-56, 71), (-60, 76), (-73, 77)]
    mask = Image.new("L", (width, hgt), 0)
    ImageDraw.Draw(mask).polygon([((lon + 180) / 360 * width, (90 - lat) / 180 * hgt) for lon, lat in poly], fill=255)
    return np.asarray(mask) > 0


LAND_ICE = "#dfe8f0"


def drop_colors(img, colors, tol=12):
    for h in colors:
        c = np.array(hex_rgb(h), np.int16)
        img[(np.abs(img[..., :3].astype(np.int16) - c).max(-1) <= tol)] = 0
    return img


def legend(colormap_url, cfg=None):
    """Legend blocks from a GIBS v1.3 colour map: continuous -> gradient, classification -> classes."""
    if not colormap_url:
        return []
    root = ET.fromstring(http_get(colormap_url))
    blocks = []
    for cmap in root.iter("ColorMap"):
        title = cmap.get("title") or ""
        if title.lower().startswith("no data"):
            continue
        transparent = {e.get("rgb") for e in cmap.iter("ColorMapEntry") if e.get("transparent") == "true"}
        leg = cmap.find("Legend")
        if leg is None:
            continue
        entries = [e for e in leg.iter("LegendEntry") if e.get("rgb") not in transparent]
        if not entries:
            continue
        hexc = lambda rgb: "#%02x%02x%02x" % tuple(int(v) for v in rgb.split(",")[:3])
        def numeric(label):
            try:
                float(label.replace("%", "").replace("≥", "").replace("<", "").replace(">", "").replace("-", "", 1).strip().split(" ")[0])
                return True
            except ValueError:
                return False
        many_numeric = len(entries) > 8 and all(numeric(e.get("tooltip") or "") for e in entries[:20])
        if leg.get("type") == "continuous" or many_numeric:
            idx = np.linspace(0, len(entries) - 1, min(9, len(entries))).round().astype(int)
            blocks.append({
                "type": "gradient", "title": title, "units": cmap.get("units") or "",
                "colors": [hexc(entries[i].get("rgb")) for i in idx],
                "min": leg.get("minLabel") or entries[0].get("tooltip", ""),
                "max": leg.get("maxLabel") or entries[-1].get("tooltip", ""),
            })
        else:
            items = [[hexc(e.get("rgb")), e.get("tooltip") or ""] for e in entries]
            if cfg:
                items = [it for it in items if it[0] not in cfg.get("drop", [])][cfg.get("min_index", 0):]
            items = items[:8]
            blocks.append({"type": "classes", "title": title, "units": cmap.get("units") or "", "items": items})
    return blocks


def layer_legend(cmap_url, cfg):
    blocks = legend(cmap_url, cfg)
    for b in blocks:
        if b["type"] == "gradient" and cfg.get("colors"):
            b["colors"] = cfg["colors"]
            if cfg.get("display_range"):
                lo, hi = cfg["display_range"]
                b["min"], b["max"] = f"≤ {lo}", f"≥ {hi}"
                b["units"] = cfg.get("units_label", b["units"])
        if b["type"] == "classes":
            recolor = {k.lower(): v for k, v in cfg.get("recolor", {}).items()}
            hatched = {k.lower(): v for k, v in cfg.get("hatch", {}).items()}
            b["items"] = [[recolor.get(c, c), lab] for c, lab in b["items"]]
            b["items"] = [[c, lab] for c, lab in b["items"] if c not in hatched] + \
                [["repeating-linear-gradient(45deg, #969696 0 3px, transparent 3px 6px)", lab] for lab in hatched.values()]
    if cfg.get("land_ice"):
        blocks.append({"type": "classes", "title": "", "units": "", "items": [[LAND_ICE, "Land ice (ice sheet)"]]})
    return blocks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="comma-separated layer ids to rebuild")
    args = ap.parse_args()
    only = {s for s in args.only.split(",") if s}

    caps = http_get(CAPS).decode("utf-8")
    old = {m["id"]: m for m in json.loads(MANIFEST.read_text())} if MANIFEST.exists() else {}
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest = []
    for cfg in LAYERS:
        if only and cfg["id"] not in only and cfg["id"] in old:
            manifest.append(old[cfg["id"]])
            continue
        t0 = time.time()
        end, cmap_url, title = layer_info(caps, cfg["layers"][0])
        if cfg.get("soft") and cmap_url:
            img, used = mosaic_soft(cfg["layers"], cfg["width"], end, cfg["days"], palette(cmap_url), cfg)
        elif any(k in cfg for k in ("smooth", "min_frac", "min_index")) and cmap_url:
            img, used = mosaic_values(cfg["layers"], cfg["width"], end, cfg["days"], palette(cmap_url), cfg)
        else:
            img, used = mosaic(cfg["layers"], cfg["width"], end, cfg["days"])
        img = img.copy()
        if cfg.get("soft_rgb"):
            img = soft_rgb(img, cfg["soft_rgb"], cfg.get("out", cfg["width"]))
        if cfg.get("drop"):
            img = drop_colors(img, cfg["drop"])
        if cfg.get("land_only"):
            # only water on land: the sea and a one-pixel coastal strip are removed
            img[~erode(land_mask(img.shape[1]))] = 0
        for src, dst in cfg.get("recolor", {}).items():
            img[match(img, src), :3] = hex_rgb(dst)
        if cfg.get("thicken"):
            img = dilate_rgba(img, cfg["thicken"])
        if cfg.get("hatch"):
            img = hatch(img, cfg["hatch"])
        if cfg.get("land_ice"):
            # the ice sheets of Greenland and Antarctica are land ice, not sea ice: shown in their own colour
            hgt = img.shape[0]
            lat = 90 - (np.arange(hgt) + 0.5) / hgt * 180
            sheet = land_mask(img.shape[1]) & (greenland_mask(img.shape[1]) | (lat < -60)[:, None])
            sheet &= img[..., 3] == 0
            img[sheet] = (*hex_rgb(LAND_ICE), 230)
        cover = float((img[..., 3] > 0).mean() * 100)
        path = OUT_DIR / f"{cfg['id']}.webp"
        if cfg.get("lossless"):
            Image.fromarray(img, "RGBA").save(path, "WEBP", lossless=True, method=4)
        else:
            Image.fromarray(img, "RGBA").save(path, "WEBP", quality=85, method=4)
        entry = {
            "id": cfg["id"], "category": cfg["category"], "icon": cfg["icon"],
            "iconIsText": bool(cfg.get("icon_text")), "name": cfg["name"], "description": cfg["description"],
            "gibsLayers": cfg["layers"], "gibsTitle": title,
            "start": used[0].isoformat() if used else None, "end": used[-1].isoformat() if used else None,
            "static": end is None, "coveragePercent": round(cover, 1),
            "opacity": cfg.get("opacity", 0.85), "night": bool(cfg.get("night")),
            "legend": layer_legend(cmap_url, cfg),
            "file": f"{cfg['id']}.webp",
        }
        manifest.append(entry)
        print(f"{cfg['id']:18s} {entry['start']} .. {entry['end']}  cover {cover:5.1f}%  "
              f"{path.stat().st_size // 1024:5d} KB  legend {len(entry['legend'])}  {time.time() - t0:.0f}s", flush=True)
    MANIFEST.write_text(json.dumps(manifest, indent=1, ensure_ascii=False) + "\n")
    print(f"Wrote {MANIFEST.relative_to(ROOT)} ({len(manifest)} layers)")


if __name__ == "__main__":
    main()
