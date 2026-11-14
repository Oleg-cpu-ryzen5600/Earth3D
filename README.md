# 🌍 Earth3D

Interactive 3D Earth in the browser, built with [Three.js](https://threejs.org/) — standard materials only, no custom shaders.

- Evenly lit globe (no day/night cycle)
- **NISAR SAR layer**: L-band GCOV false-colour backscatter, 24-day global composite baked from NASA GIBS; toggle + opacity slider
- Atmosphere glow: a camera-facing ring around the silhouette with per-vertex alpha
- 23.5° axial tilt, no automatic rotation — the globe moves only with the user
- Orbit camera: drag to rotate, scroll to zoom down to ~300 km above the surface (controls slow down near the surface)
- Double click — fullscreen

## Performance

- Renders only when the camera moves (render on demand) — ~0 GPU load when idle
- Pixel ratio capped at 1.5 on touch devices, 2 elsewhere
- WebP textures: base map 2048×1024 (~190 KB) + SAR composite 4096×2048 (~1 MB); hashed file names + long-term caching (`vercel.json`)
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
    earth_day.webp   # surface colour
    sar.webp         # SAR overlay (with alpha), generated
  sar-meta.json      # layer + date range of sar.webp, generated
scripts/
  bake_sar.py        # builds sar.webp from NASA GIBS
vercel.json          # cache headers for hashed assets
```

## SAR data

The overlay is a composite of 24 daily `NISAR_L2_Geocoded_Polarimetric_Covariance` layers from
[NASA GIBS](https://www.earthdata.nasa.gov/gibs) (WMS, EPSG:4326, 4096×2048), newest day on top,
encoded as WebP with alpha. Single days only cover narrow swaths; 24 days cover ~51% of the map (practically all land and ice sheets).

To refresh it: **Actions → Bake SAR texture → Run workflow** (optionally set the last day and number of days).
The workflow runs `scripts/bake_sar.py`, commits `src/textures/sar.webp` + `src/sar-meta.json` and redeploys.
Locally: `pip install pillow && python scripts/bake_sar.py`.

We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS).

## Credits

- Original project: [Earth3D by mitchcamza](https://github.com/mitchcamza/Earth3D) (MIT)
- Earth day map: [Solar System Scope](https://www.solarsystemscope.com/textures/), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)

## License

MIT — see [LICENSE](LICENSE). Textures remain under their respective licenses.
