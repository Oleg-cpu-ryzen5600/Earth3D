# 🌍 Earth3D

Interactive 3D Earth in the browser, built with [Three.js](https://threejs.org/) — standard materials only, no custom shaders.

- Evenly lit globe (no day/night cycle)
- **Earth texture with 3 levels of detail** (2K → 4K → 8K, NASA Blue Marble): sharper imagery is loaded automatically as you zoom in
- **Multi-sensor SAR layer**: NISAR L-band + Sentinel-1 C-band backscatter fused into one global composite (NISAR colour scale), baked from NASA GIBS; toggle + opacity slider
- Atmosphere glow: a camera-facing ring around the silhouette with per-vertex alpha
- 23.5° axial tilt, no automatic rotation — the globe moves only with the user
- Orbit camera: drag to rotate, scroll to zoom down to ~300 km above the surface (controls slow down near the surface)
- Data layer panel: a card per layer (💧 surface water & moisture, O₃ ozone layer, ☢️ radiation background) with an on/off switch, a visibility slider, a short plain-language description and a legend; layers without data yet are shown as *Coming soon*. New data is added by setting the layer's texture `url` in `DATA_LAYERS` (`src/script.js`)
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

Pushing to `main` builds the project and publishes it to **GitHub Pages** via
`.github/workflows/deploy.yml`.

One-time setup: in the repository go to **Settings → Pages → Build and deployment → Source** and select **GitHub Actions**.
The site will then be available at `https://<user>.github.io/<repo>/`.

The build uses a relative base path (`base: './'`), so `dist/` also works on Vercel, Netlify or any static host.

## Project structure

```
src/
  index.html
  script.js          # scene, globe, atmosphere ring, controls, render loop
  style.css
  textures/
    earth_2k.webp    # base map, far (loaded at start)
    earth_4k.webp    # base map, middle (on demand)
    earth_8k.webp    # base map, close (on demand)
    sar.webp         # SAR overlay (with alpha), generated
  sar-meta.json      # sources, dates and fusion stats of sar.webp, generated
scripts/
  bake_sar.py        # builds sar.webp from NASA GIBS
  bake_earth.py      # builds earth_2k/4k/8k.webp from NASA GIBS Blue Marble
  bake_ozone.py      # builds ozone.webp from NASA OMI/Aura OMTO3d (needs EARTHDATA_TOKEN)
  bake_radiation.py  # builds radiation.webp from the Safecast dataset (CC0)
vercel.json          # cache headers for hashed assets
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
The workflow runs `scripts/bake_sar.py`, commits `src/textures/sar.webp` + `src/sar-meta.json` and redeploys.
Locally: `pip install pillow numpy && python scripts/bake_sar.py`.

We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS).

## Credits

- Original project: [Earth3D by mitchcamza](https://github.com/mitchcamza/Earth3D) (MIT)
- Earth base map: NASA Blue Marble via [NASA GIBS](https://www.earthdata.nasa.gov/gibs)

## License

MIT — see [LICENSE](LICENSE). Textures remain under their respective licenses.
