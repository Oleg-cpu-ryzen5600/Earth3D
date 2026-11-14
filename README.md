# 🌍 Earth3D

Interactive 3D Earth in the browser, built with [Three.js](https://threejs.org/) — standard materials only, no custom shaders.

- Evenly lit globe (no day/night cycle)
- Separate cloud shell ~20 km above the surface (parallax when moving)
- Atmosphere glow: a camera-facing ring around the silhouette with per-vertex alpha
- 23.5° axial tilt, no automatic rotation — the globe moves only with the user
- Orbit camera: drag to rotate, scroll to zoom down to ~300 km above the surface (controls slow down near the surface)
- Double click — fullscreen

## Performance

- Renders only when the camera moves (render on demand) — ~0 GPU load when idle
- Pixel ratio capped at 1.5 on touch devices, 2 elsewhere
- WebP textures, 2048×1024, ~390 KB in total; hashed file names + long-term caching (`vercel.json`)
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
  script.js          # scene, globe, clouds, atmosphere ring, controls, render loop
  style.css
  textures/
    earth_day.webp   # surface colour
    clouds.webp      # grayscale cloud mask (used as alphaMap)
vercel.json          # cache headers for hashed assets
```

## Credits

- Original project: [Earth3D by mitchcamza](https://github.com/mitchcamza/Earth3D) (MIT)
- Cloud mask derived from the specular/clouds texture of Bruno Simon's [Three.js Journey](https://threejs-journey.com)
- Earth day map: [Solar System Scope](https://www.solarsystemscope.com/textures/), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)

## License

MIT — see [LICENSE](LICENSE). Textures remain under their respective licenses.
