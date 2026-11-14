# 🌍 Earth3D

Interactive 3D Earth in the browser, built with [Three.js](https://threejs.org/) and custom GLSL shaders.

- Day / night transition driven by the sun direction (city lights on the night side)
- Clouds and sun reflection on the oceans from a combined specular/clouds texture
- Fresnel atmosphere tint on the planet plus a separate glowing atmosphere shell
- 23.5° axial tilt, slow rotation, orbit camera (drag to rotate, scroll to zoom)
- Double click — fullscreen

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
  script.js                 # scene, camera, materials, animation loop
  style.css
  shaders/
    earth/earth.vert|frag   # day/night, clouds, specular, fresnel
    atmosphere/atmosphere.vert|frag
static/textures/            # served as-is
  2k_earth_daymap.jpg
  night.jpg
  specularClouds.jpg        # R = ocean specular mask, G = clouds
```

## Credits

- Original project: [Earth3D by mitchcamza](https://github.com/mitchcamza/Earth3D) (MIT)
- Shader technique: Bruno Simon, [Three.js Journey](https://threejs-journey.com)
- Earth day map: [Solar System Scope](https://www.solarsystemscope.com/textures/), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)

## License

MIT — see [LICENSE](LICENSE). Textures remain under their respective licenses.
