# 🌍 Earth3D

Interactive 3D Earth in the browser with NASA satellite data layers, built with [Three.js](https://threejs.org/) —
standard materials only, no custom shaders. Made for the **NASA Space Apps Challenge 2026 — "Dancing with the SARs"**.

**Live site: [earth3d-jade.vercel.app](https://earth3d-jade.vercel.app)**

The globe starts without data: every layer is switched on from the panel on the right.

- Evenly lit globe (no day/night cycle)
- **Earth texture with 3 levels of detail** (2K → 4K → 8K, NASA Blue Marble): sharper imagery is loaded automatically as you zoom in
- **Multi-sensor SAR layer**: NISAR L-band + Sentinel-1 C-band backscatter fused into one global composite (NISAR colour scale), baked from NASA GIBS; toggle + opacity slider
- Atmosphere glow: a camera-facing ring around the silhouette with per-vertex alpha
- 23.5° axial tilt, no automatic rotation — the globe moves only with the user
- Orbit camera: drag to rotate, scroll to zoom; the closest zoom is limited to ~5 km of ground per screen pixel (the detail of the 8K map and the enhanced data layers), so the merged data never looks blocky. Optional close-up NASA GIBS map tiles (`CLOSE_UP_TILES` in `src/script.js`) are switched off
- **22 data layers** in five groups (water & radar, air quality, temperature/rain/ice, land & hazards, night): our own processed SAR, ozone and radiation layers plus 19 layers from NASA GIBS. Each card has an on/off switch, a visibility slider, a plain-language description, a legend and the data dates; a texture is downloaded only when its layer is switched on
- **Night lights** fade the globe into night mode (dark map, Sun fades out, city lights fade in)
- Panel on the right with the data credits at its end; on phones a tap on the free part of the screen closes it
- **Reset view** button: smoothly flies back to the start position (north up, initial zoom)
- Double click — fullscreen

## Performance

- Renders only when the camera moves (render on demand) — ~0 GPU load when idle
- Pixel ratio capped at 1.5 on touch devices, 2 elsewhere
- WebP textures with hashed file names + long-term caching (`vercel.json`): SAR composite 4096×2048 (~0.9 MB) and the base map in three levels (below)
- Base map level of detail: only 2K is loaded at start; 4K and 8K are downloaded in the background when the globe covers enough screen pixels (zoom, window size and pixel ratio all count), uploaded to the GPU ahead of time and swapped in without a flash. Hysteresis prevents flicker at the threshold, unused high levels are freed from GPU memory, 8K is skipped on touch devices and GPUs with `maxTextureSize` < 8192
- Loading screen driven by `THREE.LoadingManager`

## Getting started

Requires Node.js 18+.

```bash
npm install
npm run dev      # dev server at http://localhost:5173
npm run build    # production build into dist/
npm run preview  # serve the built dist/ locally
```

## Deployment

The site is hosted on **Vercel**: every push to `main` (including the commits made by the data workflows) is built
(`npm run build`) and published automatically at [earth3d-jade.vercel.app](https://earth3d-jade.vercel.app).

The build uses a relative base path (`base: './'`), so `dist/` also works on any static host.

## Project structure

```
src/
  index.html
  script.js             # scene, globe, atmosphere ring, data layers, panel, controls, render loop
  style.css
  textures/
    earth_2k/4k/8k.webp # base map in three levels of detail
    sar.webp            # SAR composite (with alpha), generated; sar_hi.webp = 8192 px version for close-ups
    ozone.webp          # ozone layer, generated
    radiation.webp      # radiation background, generated
    gibs/*.webp         # 19 NASA GIBS layers, generated
  sar-meta.json, ozone-meta.json, radiation-meta.json, gibs-layers.json   # dates, sources, legends
scripts/
  bake_earth.py         # base map from NASA GIBS Blue Marble
  bake_sar.py           # multi-sensor SAR composite (NISAR + Sentinel-1) from NASA GIBS
  upscale_overlays.py   # sar_hi.webp for close-ups
  bake_ozone.py         # ozone from NASA OMI/Aura OMTO3d (needs EARTHDATA_TOKEN)
  bake_radiation.py     # radiation from the Safecast dataset (CC0)
  bake_gibs_layers.py   # the 19 NASA GIBS layers
.github/workflows/      # one "Bake …" workflow per script (Actions → Run workflow)
vercel.json             # cache headers for hashed assets
```

## Earth base map

`scripts/bake_earth.py` downloads one 8192×4096 image of the static GIBS layer
`BlueMarble_ShadedRelief_Bathymetry` and downscales it (Lanczos) to 4K and 2K, so all levels have identical colours.
Run it with **Actions → Bake Earth textures → Run workflow** (only needed once, or to switch the layer).

## Ozone data

`scripts/bake_ozone.py` builds `src/textures/ozone.webp` from **OMI/Aura OMTO3d V004** (total column ozone,
daily, 1°×1°, Dobson units) from NASA GES DISC: it averages the latest N days (fills the gaps between orbits),
upsamples to 2048×1024 and applies a fixed colour scale 150–500 DU (cells without data, e.g. polar night, stay transparent).
`src/ozone-meta.json` stores the dates, the scale and statistics (global mean, area below 220 DU).

The files require [Earthdata Login](https://urs.earthdata.nasa.gov): add a token as the repository secret
`EARTHDATA_TOKEN` (and authorize the *NASA GESDISC DATA ARCHIVE* application in your Earthdata profile), then run
**Actions → Bake ozone texture → Run workflow**. The token expires after 60 days.

## More NASA GIBS layers

`scripts/bake_gibs_layers.py` (**Actions → Bake GIBS layers**) bakes 19 more layers from NASA GIBS into
`src/textures/gibs/*.webp` plus a manifest `src/gibs-layers.json` (name, category, dates, legend):
soil moisture (SMAP), surface water from Sentinel-1 radar (OPERA DSWx), floods (MODIS), NISAR orbit tracks,
nitrogen dioxide and sulfur dioxide (TROPOMI), aerosols (MODIS), active fires (VIIRS), sea surface temperature and
its anomaly (GHRSST MUR), land surface temperature (MODIS), precipitation (IMERG), snow cover (MODIS), sea ice,
vegetation NDVI (VIIRS), landslide / flood / drought hazard (SEDAC) and night lights (VIIRS Black Marble).
For each layer the latest days are merged as a "latest valid pixel" mosaic (fills gaps between orbits) and the legend
is taken from the GIBS colour map. The site shows them grouped by topic; a layer's texture is downloaded only when it
is switched on and freed when switched off. **Night lights** switches the globe to night mode (dark map, no Sun).

## Radiation data

`scripts/bake_radiation.py` builds `src/textures/radiation.webp` from the complete **Safecast** radiation dataset
(citizen-science dosimeter readings, CC0): the archive is streamed (nothing stored on disk), readings since `--since`
(default 2018-01-01) in cpm or µSv/h are converted to µSv/h (334 cpm per µSv/h, LND 7317 tube) and aggregated per
0.5°×0.5° cell as a geometric mean (robust to spikes). Only cells with at least `--min-count` readings are coloured
(log scale 0.02–1 µSv/h); unmeasured areas stay transparent — no interpolation.
Run **Actions → Bake radiation texture → Run workflow** (takes a while: the archive is several GB).

## SAR data

The overlay is a **multi-sensor composite** baked from [NASA GIBS](https://www.earthdata.nasa.gov/gibs)
(WMS, EPSG:4326, 4096×2048), encoded as WebP with alpha. Relying on a single satellite is not robust
(narrow swaths, gaps, radio-frequency interference), so several sources are combined:

| Source | GIBS layer | Role |
|---|---|---|
| NISAR L-band GCOV (NASA-ISRO), 36 days | `NISAR_L2_Geocoded_Polarimetric_Covariance` | primary signal (R = HH, G = HV, B = HH/HV) |
| Sentinel-1 C-band RTC (ESA / NASA OPERA), 24 days | `OPERA_L2_Radiometric_Terrain_Corrected_SAR_Sentinel-1` | independent cross-check, RFI replacement, gap fill |
| MODIS IGBP land cover | `MODIS_Combined_L3_IGBP_Land_Cover_Type_Annual` | reference classes for harmonisation |
| OSM land mask | `OSM_Land_Mask` | clip to land and ice sheets |

`scripts/bake_sar.py`:

1. **Clean composite per sensor** — every daily swath is eroded by 2 px (noisy edges) and each pixel
   is the per-channel **median** of all valid days.
2. **Harmonisation to one scale** — for every land-cover class a robust (iteratively trimmed)
   linear colour mapping Sentinel-1 → NISAR is fitted on pixels observed by both sensors.
3. **Cross-sensor consistency check** — NISAR pixels with a strong HV excess and HH deficit relative to
   the Sentinel-1 prediction (typical L-band RFI signature) are flagged; areas where many pixels are
   flagged are replaced by harmonised Sentinel-1 with a soft transition.
4. **Gap filling** — land without NISAR data gets harmonised Sentinel-1.
5. Clip to land/ice, write `sar.webp` and `sar-meta.json` (dates, sources, share of each sensor,
   agreement statistics).

Note: GIBS serves visualised (false-colour) imagery, so the harmonisation is a colour-scale
alignment of the two sensors, not a radiometric (σ⁰) calibration.

To refresh it: **Actions → Bake SAR texture → Run workflow** (recommended *days* = 36, i.e. three NISAR 12-day cycles).
For close-ups, `scripts/upscale_overlays.py` (**Actions → Upscale overlays**) builds `sar_hi.webp` (8192×4096) from the same composite — no new data: small gaps are filled from neighbouring pixels, isolated noisy pixels are softened (3×3 median blend) and the image is upsampled 2× bicubically. The site loads it only when zoomed in; run it again after re-baking the SAR texture.
The workflow runs `scripts/bake_sar.py`, commits `src/textures/sar.webp` + `src/sar-meta.json` and redeploys.
Locally: `pip install pillow numpy && python scripts/bake_sar.py`.

We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS).

## Credits

- Original project: [Earth3D by mitchcamza](https://github.com/mitchcamza/Earth3D) (MIT)
- Satellite data and imagery: [NASA GIBS](https://www.earthdata.nasa.gov/gibs) — NASA Blue Marble, NISAR (NASA-ISRO),
  Sentinel-1 / NASA OPERA, SMAP, MODIS (Terra, Aqua), VIIRS (NOAA-20, Suomi NPP), GHRSST MUR, GPM IMERG, TROPOMI (Sentinel-5P)
- Ozone: NASA OMI/Aura OMTO3d, [NASA GES DISC](https://disc.gsfc.nasa.gov)
- Radiation: [Safecast](https://safecast.org) (CC0)
- Natural Disaster Hotspots: CHRR & CIESIN, Columbia University (2005), NASA SEDAC (CC BY)
- Land mask: © OpenStreetMap contributors (ODbL)
- Contains modified Copernicus Sentinel data 2026 (Sentinel-1, Sentinel-5P)

## License

MIT — see [LICENSE](LICENSE). Textures remain under their respective licenses.
