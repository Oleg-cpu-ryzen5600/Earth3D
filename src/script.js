import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
// Earth base map in three levels of detail (NASA GIBS Blue Marble, baked by scripts/bake_earth.py).
// Only the 2K level is loaded at start; 4K / 8K are fetched when the camera gets close enough.
import earth2kUrl from './textures/earth_2k.webp';
import earth4kUrl from './textures/earth_4k.webp';
import earth8kUrl from './textures/earth_8k.webp';
// SAR composite baked from NASA GIBS by scripts/bake_sar.py (GitHub Actions: "Bake SAR texture")
import sarUrl from './textures/sar.webp';
import sarMeta from './sar-meta.json';
// Enhanced 2x SAR overlay (scripts/upscale_overlays.py), loaded only for close-ups; optional
const sarHiUrl = Object.values(import.meta.glob('./textures/sar_hi.webp', { eager: true, query: '?url', import: 'default' }))[0] ?? null;
// Ozone (OMI/Aura OMTO3d) baked by scripts/bake_ozone.py; optional: until the first bake
// these globs are empty and the layer is shown as "Coming soon"
const ozoneUrl = Object.values(import.meta.glob('./textures/ozone.webp', { eager: true, query: '?url', import: 'default' }))[0] ?? null;
const ozoneMeta = Object.values(import.meta.glob('./ozone-meta.json', { eager: true, import: 'default' }))[0] ?? null;
// Radiation background (Safecast) baked by scripts/bake_radiation.py; optional in the same way
const radiationUrl = Object.values(import.meta.glob('./textures/radiation.webp', { eager: true, query: '?url', import: 'default' }))[0] ?? null;
const radiationMeta = Object.values(import.meta.glob('./radiation-meta.json', { eager: true, import: 'default' }))[0] ?? null;
// More NASA GIBS layers baked by scripts/bake_gibs_layers.py (manifest + one texture per layer); optional
const gibsManifest = Object.values(import.meta.glob('./gibs-layers.json', { eager: true, import: 'default' }))[0] ?? [];
const gibsUrls = import.meta.glob('./textures/gibs/*.webp', { eager: true, query: '?url', import: 'default' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const EARTH_RADIUS = 1;
const ATMOSPHERE_RADIUS = 1.06;   // outer edge of the glow
const ATMOSPHERE_COLOR = new THREE.Color(0x9fd8ff);
const SEGMENTS = 128;             // smooth horizon when zoomed in close

// ---------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------
const canvas = document.querySelector('canvas.webgl');
const scene = new THREE.Scene();

// Lower pixel ratio on touch devices: almost no visible difference, far fewer pixels
const isTouch = window.matchMedia('(pointer: coarse)').matches;
const getPixelRatio = () => Math.min(window.devicePixelRatio, isTouch ? 1.5 : 2);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.005, 100);
const AXIAL_TILT = THREE.MathUtils.degToRad(23.5);

// Direction from the globe centre to a point on the surface, in scene space
// (matches the equirectangular UV layout of THREE.SphereGeometry + the globe's tilt)
const latLonToDirection = (lat, lon) =>
{
    const phi = THREE.MathUtils.degToRad(lon + 180);
    const latR = THREE.MathUtils.degToRad(lat);
    return new THREE.Vector3(-Math.cos(phi) * Math.cos(latR), Math.sin(latR), Math.sin(phi) * Math.cos(latR))
        .applyAxisAngle(new THREE.Vector3(1, 0, 0), AXIAL_TILT);
};

// Start view (also used by "Reset view"): centred on Ukraine
const HOME_LAT = 48.5;
const HOME_LON = 31.5;
const HOME_DISTANCE = 3;  // Earth radii from the centre: Ukraine and its neighbours fill the view
const HOME_POSITION = latLonToDirection(HOME_LAT, HOME_LON).multiplyScalar(HOME_DISTANCE);
camera.position.copy(HOME_POSITION);
scene.add(camera);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(getPixelRatio());
renderer.setClearColor(0x000000, 1);

// ---------------------------------------------------------------------------
// Render on demand: draw a frame only when something changed
// ---------------------------------------------------------------------------
let needsRender = true;
const requestRender = () => { needsRender = true; };

// ---------------------------------------------------------------------------
// Loading screen + textures
// ---------------------------------------------------------------------------
const loader = document.querySelector('.loader');
const loadingManager = new THREE.LoadingManager(
    () =>
    {
        loader.classList.add('hidden');
        requestRender();
    },
    (url, loaded, total) =>
    {
        loader.textContent = `Loading ${Math.round((loaded / total) * 100)}%`;
    }
);

const textureLoader = new THREE.TextureLoader(loadingManager);
const maxAnisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);

const loadTexture = (url, isColor) =>
{
    const texture = textureLoader.load(url, requestRender);
    texture.anisotropy = maxAnisotropy;
    if (isColor) texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
};

const earthBaseTexture = loadTexture(earth2kUrl, true);

// ---------------------------------------------------------------------------
// Starry background: static points on a large sphere around the scene.
// Seeded random, so the sky is the same on every visit; no animation.
// Three groups of different size give bright, medium and faint stars.
// ---------------------------------------------------------------------------
const createStars = () =>
{
    let seed = 20261114;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

    // Soft round dot used as the sprite of every star
    const spriteCanvas = document.createElement('canvas');
    spriteCanvas.width = spriteCanvas.height = 32;
    const ctx = spriteCanvas.getContext('2d');
    const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.4, 'rgba(255,255,255,0.8)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 32, 32);
    const sprite = new THREE.CanvasTexture(spriteCanvas);
    sprite.colorSpace = THREE.SRGBColorSpace;

    const STAR_RADIUS = 60;          // well inside the camera's far plane (100)
    const groups = [
        { count: 2600, size: 1.9, brightness: [0.55, 0.85] },  // faint
        { count: 700,  size: 2.8, brightness: [0.8, 1.0] },    // medium
        { count: 120,  size: 3.8, brightness: [1.0, 1.0] },    // bright
    ];
    const tints = [[1, 1, 1], [0.8, 0.88, 1], [1, 0.93, 0.82], [1, 0.85, 0.7]]; // white, blue-white, yellow, orange

    const stars = new THREE.Group();
    groups.forEach(({ count, size, brightness }) =>
    {
        const positions = new Float32Array(count * 3);
        const colors = new Float32Array(count * 3);
        for (let i = 0; i < count; i++)
        {
            // uniform direction on the sphere
            const z = random() * 2 - 1;
            const a = random() * Math.PI * 2;
            const r = Math.sqrt(1 - z * z);
            positions.set([r * Math.cos(a) * STAR_RADIUS, z * STAR_RADIUS, r * Math.sin(a) * STAR_RADIUS], i * 3);

            const tint = tints[Math.floor(random() * tints.length)];
            const b = brightness[0] + random() * (brightness[1] - brightness[0]);
            colors.set([tint[0] * b, tint[1] * b, tint[2] * b], i * 3);
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        stars.add(new THREE.Points(geometry, new THREE.PointsMaterial({
            size: size * renderer.getPixelRatio(),
            sizeAttenuation: false,  // size in screen pixels, independent of zoom
            map: sprite,
            vertexColors: true,
            transparent: true,
            depthWrite: false,
        })));
    });
    stars.renderOrder = -1;          // behind everything else
    return stars;
};
scene.add(createStars());

// ---------------------------------------------------------------------------
// Distant Sun: a glowing sprite far behind the globe, slightly off to the
// upper right of the start view. Decorative only (the Earth stays evenly lit).
// ---------------------------------------------------------------------------
const createSun = () =>
{
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const c = size / 2;
    // wide soft glow
    const glow = ctx.createRadialGradient(c, c, 0, c, c, c);
    glow.addColorStop(0, 'rgba(255, 244, 214, 1)');
    glow.addColorStop(0.08, 'rgba(255, 236, 180, 1)');
    glow.addColorStop(0.18, 'rgba(255, 200, 110, 0.45)');
    glow.addColorStop(0.45, 'rgba(255, 160, 60, 0.12)');
    glow.addColorStop(1, 'rgba(255, 140, 40, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, size, size);
    // bright disc
    ctx.beginPath();
    ctx.arc(c, c, size * 0.05, 0, Math.PI * 2);
    ctx.fillStyle = '#fffaf0';
    ctx.fill();

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sun = new THREE.Sprite(new THREE.SpriteMaterial({
        map: texture,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,       // depth test stays on: the globe hides the Sun when it is in front
    }));

    // Direction: behind the globe as seen from the start view, up and to the right
    const forward = HOME_POSITION.clone().negate().normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();
    const direction = forward.add(right.multiplyScalar(0.3)).add(up.multiplyScalar(0.22)).normalize();

    sun.position.copy(direction.multiplyScalar(55));   // in front of the star sphere (60)
    sun.scale.setScalar(14);
    sun.renderOrder = 0;
    return sun;
};
const sun = createSun();
scene.add(sun);

// ---------------------------------------------------------------------------
// Globe (tilted group)
// ---------------------------------------------------------------------------
const globe = new THREE.Group();
globe.rotation.x = AXIAL_TILT;
scene.add(globe);

// Earth: evenly lit, no lighting calculations at all
const earth = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_RADIUS, SEGMENTS, SEGMENTS),
    new THREE.MeshBasicMaterial({ map: earthBaseTexture })
);
globe.add(earth);

// ---------------------------------------------------------------------------
// Level of detail for the Earth texture
// The level is chosen from how many screen pixels the globe covers, so it adapts
// to zoom, window size and pixel ratio. Higher levels load lazily, in the
// background; the current level stays visible until the next one is ready.
// ---------------------------------------------------------------------------
const maxTextureSize = renderer.capabilities.maxTextureSize;
const LOD_LEVELS = [
    { width: 2048, label: '2K', url: earth2kUrl, texture: earthBaseTexture },
    { width: 4096, label: '4K', url: earth4kUrl, texture: null },
    { width: 8192, label: '8K', url: earth8kUrl, texture: null },
].filter((level) => level.width <= maxTextureSize && !(isTouch && level.width > 4096)); // 8K: desktop only

const LOD_TEXEL_RATIO = 1;     // ~1 texel per screen pixel (the closest view shows the 8K map at 1:1)
const LOD_DOWN_MARGIN = 0.8;   // hysteresis: switch down only well below the threshold
// ImageBitmapLoader decodes images off the main thread (TextureLoader decodes during the GPU upload -> stutter)
const bitmapLoader = new THREE.ImageBitmapLoader();
bitmapLoader.setOptions({ imageOrientation: 'flipY', premultiplyAlpha: 'none' });
bitmapLoader.setCrossOrigin('anonymous');
const bitmapTexture = (bitmap) =>
{
    const texture = new THREE.Texture(bitmap);
    texture.flipY = false;                      // already flipped while decoding
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
};
const lodLabel = document.querySelector('#lod-level');
let lodCurrent = 0;
let lodWanted = 0;

const texelsNeeded = () =>
{
    // Size of one screen pixel on the ground at the centre of the view: the camera is
    // `altitude` Earth radii above the surface and one pixel spans 2*tan(fov/2)/height radians.
    // Texture width needed for ~1 texel per pixel there = 2*pi / (ground radians per pixel).
    const altitude = Math.max(1e-4, camera.position.length() - EARTH_RADIUS);
    const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
    const groundPerPixel = (altitude * 2 * Math.tan(halfFov)) / renderer.domElement.height;
    return ((2 * Math.PI) / groundPerPixel) * LOD_TEXEL_RATIO;
};

const showLod = (index) =>
{
    lodCurrent = index;
    earth.material.map = LOD_LEVELS[index].texture;
    earth.material.needsUpdate = true;
    if (lodLabel) lodLabel.textContent = `Map detail: ${LOD_LEVELS[index].label}`;
    // free GPU memory of levels far above the one in use (8K is ~170 MB with mipmaps)
    LOD_LEVELS.forEach((level, i) =>
    {
        if (i > index + 1 && level.texture)
        {
            level.texture.dispose();
            level.texture = null;
        }
    });
    requestRender();
};

const updateLod = () =>
{
    const need = texelsNeeded();
    let target = LOD_LEVELS.findIndex((level) => level.width >= need);
    if (target === -1) target = LOD_LEVELS.length - 1;
    if (target < lodCurrent && need > LOD_LEVELS[target].width * LOD_DOWN_MARGIN) target = lodCurrent;
    if (target === lodWanted) return;
    lodWanted = target;

    const level = LOD_LEVELS[target];
    if (level.texture)
    {
        showLod(target);
        return;
    }
    if (level.loading) return;
    level.loading = true;
    if (lodLabel) lodLabel.textContent = `Map detail: ${LOD_LEVELS[lodCurrent].label} → loading ${level.label}…`;
    bitmapLoader.load(level.url, (bitmap) =>
    {
        level.loading = false;
        const texture = bitmapTexture(bitmap);
        texture.anisotropy = maxAnisotropy;
        level.texture = texture;
        renderer.initTexture(texture);          // upload to the GPU now, not on the first visible frame
        if (lodWanted === target) showLod(target);
        else
        {
            if (target > lodCurrent + 1) { texture.dispose(); level.texture = null; } // no longer needed
            if (lodLabel) lodLabel.textContent = `Map detail: ${LOD_LEVELS[lodCurrent].label}`;
        }
    }, undefined, () =>
    {
        level.loading = false;
        lodWanted = lodCurrent;                 // keep the current level if the download failed
    });
};

// ---------------------------------------------------------------------------
// Close-up detail: streamed map tiles (like online maps)
// A single 16K / 32K texture would need 0.7-3 GB of GPU memory and exceeds the
// WebGL size limit on most devices. Instead, when the 8K base map is no longer
// sharp enough, 512 px tiles of NASA GIBS Blue Marble (WMTS, EPSG:4326) are
// loaded only for the part of the globe that is on screen:
//   level 5 ~ 20K, level 6 ~ 40K, level 7 ~ 80K equivalent (~500 m per pixel).
// Each tile is a small sphere patch drawn just above the base map and below the
// data layers. Loaded tiles are cached (LRU) and the least recently used freed.
// ---------------------------------------------------------------------------
const TILE_URL = (z, y, x) =>
    `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlueMarble_ShadedRelief_Bathymetry/default/500m/${z}/${y}/${x}.jpeg`;
const TILE_MIN_LEVEL = 5;
const TILE_MAX_LEVEL = 7;
const TILE_PX = 512;
const tileSpan = (z) => 288 / 2 ** z;                    // degrees per tile (GIBS 500m matrix set)
const tileEquivalentWidth = (z) => (360 / tileSpan(z)) * TILE_PX;
const TILE_MAX_VISIBLE = 80;                             // per level
const TILE_CACHE_SIZE = 220;
const TILE_PARALLEL = 6;
const TILE_SEGMENTS = 12;

const tileGroup = new THREE.Group();
globe.add(tileGroup);
const TILE_UPLOADS_PER_FRAME = 2;                       // spreads GPU uploads over frames (no hitches)
const TILE_SELECT_INTERVAL = 120;                        // ms between visible-tile recomputations
const tileReady = [];                                    // decoded tiles waiting for their GPU upload
let tileSelectTime = 0;
let tileSelectTimer = 0;
let tileLevelShown = 0;
const tiles = new Map();                                 // key -> { z, y, x, mesh, state, used }
const tileQueue = [];
let tilesLoading = 0;
let tileLevel = 0;                                       // 0 = tiles off
let tileFrame = 0;

// Sub-camera point (lat/lon on the untilted globe) and the visible angular radius
const viewCap = () =>
{
    const local = globe.worldToLocal(camera.position.clone());
    const distance = local.length();
    const dir = local.normalize();
    const lat = THREE.MathUtils.radToDeg(Math.asin(dir.y));
    let lon = THREE.MathUtils.radToDeg(Math.atan2(dir.z, -dir.x)) - 180;
    if (lon < -180) lon += 360;
    // angle on the sphere hit by the ray at the corner of the view, capped by the horizon
    const halfDiag = Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.hypot(1, camera.aspect));
    const s = distance * Math.sin(halfDiag);
    const horizon = Math.acos(1 / distance);
    const radius = s < 1 ? Math.min(horizon, Math.asin(s) - halfDiag) : horizon;
    return { lat, lon, radius: THREE.MathUtils.radToDeg(radius) * 1.15 + 1 };
};

const createTileMesh = (z, y, x, texture) =>
{
    const span = tileSpan(z);
    const lon0 = -180 + x * span;
    const lat0 = 90 - y * span;                          // north edge
    const geometry = new THREE.SphereGeometry(
        EARTH_RADIUS, TILE_SEGMENTS, TILE_SEGMENTS,
        THREE.MathUtils.degToRad(lon0 + 180), THREE.MathUtils.degToRad(span),
        THREE.MathUtils.degToRad(90 - lat0), THREE.MathUtils.degToRad(span),
    );
    const material = new THREE.MeshBasicMaterial({
        map: texture,
        // No depth writes: the finely tessellated tile bulges slightly above the coarser globe mesh that
        // the data layers share; writing its depth would hide the data layers there ("torn" overlays).
        depthWrite: false,
        polygonOffset: true,                             // above the base map, below the data layers
        polygonOffsetFactor: -0.2 - z * 0.05,
        polygonOffsetUnits: -0.2 - z * 0.05,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 0.5 + z * 0.01;                   // after the base map (tiles write no depth)
    return mesh;
};

const pumpTileQueue = () =>
{
    while (tilesLoading < TILE_PARALLEL && tileQueue.length)
    {
        const tile = tileQueue.shift();
        if (tile.state !== 'queued') continue;
        tile.state = 'loading';
        tilesLoading++;
        bitmapLoader.load(TILE_URL(tile.z, tile.y, tile.x), (bitmap) =>
        {
            tilesLoading--;
            if (tile.state !== 'loading') { bitmap.close?.(); pumpTileQueue(); return; }
            tile.bitmap = bitmap;
            tile.state = 'decoded';
            tileReady.push(tile);
            requestRender();
            pumpTileQueue();
        }, undefined, () =>
        {
            tilesLoading--;
            tile.state = 'failed';
            pumpTileQueue();
        });
    }
};

// GPU upload of a few decoded tiles per frame
const uploadReadyTiles = () =>
{
    for (let n = 0; n < TILE_UPLOADS_PER_FRAME && tileReady.length; n++)
    {
        const tile = tileReady.shift();
        if (tile.state !== 'decoded') { tile.bitmap?.close?.(); continue; }
        const texture = bitmapTexture(tile.bitmap);
        tile.bitmap = null;
        texture.generateMipmaps = false;                 // tiles are shown close to 1:1, saves upload time
        texture.minFilter = THREE.LinearFilter;
        tile.mesh = createTileMesh(tile.z, tile.y, tile.x, texture);
        renderer.initTexture(texture);
        tile.mesh.visible = tile.wanted;
        tileGroup.add(tile.mesh);
        tile.state = 'ready';
    }
    if (tileReady.length) requestRender();               // continue uploading on the next frame
};

const disposeTile = (key, tile) =>
{
    if (tile.mesh)
    {
        tileGroup.remove(tile.mesh);
        tile.mesh.geometry.dispose();
        tile.mesh.material.map?.source?.data?.close?.();
        tile.mesh.material.map?.dispose();
        tile.mesh.material.dispose();
    }
    tile.bitmap?.close?.();
    tile.state = 'disposed';
    tiles.delete(key);
};

// Off: the closest zoom is limited to ~5 km per pixel (see MAX_DETAIL_KM), where the 8K map is enough
// and the data layers still look clean. Set to true together with a smaller MAX_DETAIL_KM to stream tiles again.
const CLOSE_UP_TILES = false;

const updateTiles = () =>
{
    if (!CLOSE_UP_TILES) return;
    uploadReadyTiles();
    // recompute the wanted tiles at most every TILE_SELECT_INTERVAL ms (camera moves every frame)
    const now = performance.now();
    if (now - tileSelectTime < TILE_SELECT_INTERVAL)
    {
        clearTimeout(tileSelectTimer);
        tileSelectTimer = setTimeout(requestRender, TILE_SELECT_INTERVAL);   // final update when motion stops
        return;
    }
    tileSelectTime = now;
    tileFrame++;
    const need = texelsNeeded();
    const base = LOD_LEVELS[LOD_LEVELS.length - 1].width;
    let level = 0;
    if (need > base * (tileLevelShown ? 0.9 : 1.1))     // hysteresis around the 8K -> tiles switch
    {
        level = TILE_MIN_LEVEL;
        while (level < TILE_MAX_LEVEL && tileEquivalentWidth(level) < need * (level < tileLevelShown ? 0.8 : 1)) level++;
    }
    tileLevel = level;
    tileLevelShown = level;
    tiles.forEach((tile) => { tile.wanted = false; });

    if (level)
    {
        const cap = viewCap();
        // wanted: tiles of the current level plus the next coarser tile level as fallback while loading
        for (let z = Math.max(TILE_MIN_LEVEL, level - 1); z <= level; z++)
        {
            const span = tileSpan(z);
            const latMin = Math.max(-90, cap.lat - cap.radius);
            const latMax = Math.min(90, cap.lat + cap.radius);
            const nearPole = latMax > 89 || latMin < -89;
            const lonHalf = nearPole ? 180 : Math.min(180, cap.radius / Math.max(0.05, Math.cos(THREE.MathUtils.degToRad(
                Math.max(Math.abs(latMin), Math.abs(latMax))))));
            const yMin = Math.max(0, Math.floor((90 - latMax) / span));
            const yMax = Math.min(180 / span - 1, Math.floor((90 - latMin) / span));
            const cols = 360 / span;
            const xFrom = Math.floor((cap.lon - lonHalf + 180) / span);
            const xTo = Math.floor((cap.lon + lonHalf + 180) / span);
            const list = [];
            for (let y = yMin; y <= yMax; y++)
            {
                for (let xi = xFrom; xi <= Math.min(xTo, xFrom + cols - 1); xi++)
                {
                    const x = ((xi % cols) + cols) % cols;
                    const cLat = 90 - (y + 0.5) * span;
                    const cLon = -180 + (x + 0.5) * span;
                    const dLon = ((cLon - cap.lon + 540) % 360) - 180;
                    list.push({ y, x, d: Math.hypot(cLat - cap.lat, dLon * Math.cos(THREE.MathUtils.degToRad(cLat))) });
                }
            }
            list.sort((a, b) => a.d - b.d);
            list.slice(0, TILE_MAX_VISIBLE).forEach(({ y, x }) =>
            {
                const key = `${z}/${y}/${x}`;
                let tile = tiles.get(key);
                if (!tile)
                {
                    tile = { z, y, x, mesh: null, state: 'queued' };
                    tiles.set(key, tile);
                    tileQueue.push(tile);
                }
                else if (tile.state === 'failed' || tile.state === 'disposed')
                {
                    return;
                }
                tile.wanted = true;
                tile.used = tileFrame;
            });
        }
        // load the current level first, nearest tiles first (queue order = insertion order by distance)
        tileQueue.sort((a, b) => (b.z === level) - (a.z === level));
    }

    // drop queued tiles that are no longer needed, show/hide ready ones
    for (let i = tileQueue.length - 1; i >= 0; i--)
    {
        if (!tileQueue[i].wanted) { tileQueue[i].state = 'dropped'; tiles.delete(`${tileQueue[i].z}/${tileQueue[i].y}/${tileQueue[i].x}`); tileQueue.splice(i, 1); }
    }
    tiles.forEach((tile) => { if (tile.mesh) tile.mesh.visible = tile.wanted; });
    if (tiles.size > TILE_CACHE_SIZE)
    {
        [...tiles.entries()]
            .filter(([, t]) => !t.wanted && t.state === 'ready')
            .sort((a, b) => a[1].used - b[1].used)
            .slice(0, tiles.size - TILE_CACHE_SIZE)
            .forEach(([key, t]) => disposeTile(key, t));
    }
    pumpTileQueue();

    if (lodLabel && level)
    {
        const pending = tileQueue.length + tilesLoading;
        lodLabel.textContent = `Map detail: ~${Math.round(tileEquivalentWidth(level) / 1024)}K (live tiles)`
            + (pending ? ` · loading ${pending}` : '');
    }
    else if (lodLabel && lodLabel.textContent.includes('tiles'))
    {
        lodLabel.textContent = `Map detail: ${LOD_LEVELS[lodCurrent].label}`;
    }
};

// ---------------------------------------------------------------------------
// Data layers
// Each layer is a transparent copy of the globe drawn on top of the surface.
// To add data for a layer, set `url` to its texture (equirectangular, with alpha):
// its card in the panel becomes active automatically.
// ---------------------------------------------------------------------------
const sarStats = sarMeta.stats;
const DATA_LAYERS = [
    {
        id: 'water',
        category: 'Water & radar',
        icon: '💧',
        name: 'Surface water & moisture',
        description: 'Radar satellites see how wet and rough the ground is, even through clouds and at night.',
        url: sarUrl,
        hiUrl: sarHiUrl,                 // 8192 px version for close-ups
        hiWidth: 8192,
        enabled: true,
        opacity: 1,
        details: `${sarMeta.start} – ${sarMeta.end} · NISAR + Sentinel-1`
            + (sarStats ? ` (${sarStats.nisarSharePercent}% / ${sarStats.sentinel1SharePercent}%)` : ''),
        legend: [
            ['#3bd16f', 'Vegetation'],
            ['#e8a030', 'Cities, rock'],
            ['#4a6fd6', 'Smooth or wet ground'],
        ],
    },
    {
        id: 'ozone',
        category: 'Air quality',
        icon: 'O₃',
        iconIsText: true,
        name: 'Ozone layer',
        description: 'How much ozone shields the surface from the Sun\'s ultraviolet light. Less ozone means more UV reaches the ground.',
        url: ozoneUrl,
        enabled: false,
        opacity: 0.8,
        details: ozoneMeta
            ? `${ozoneMeta.start} – ${ozoneMeta.end} · NASA OMI/Aura · global mean ${ozoneMeta.stats.globalMeanDU} DU`
            : null,
        scale: ozoneMeta
            ? {
                stops: ozoneMeta.scale.stops,
                min: ozoneMeta.scale.min,
                max: ozoneMeta.scale.max,
                unit: 'DU',
                lowLabel: 'Thin (ozone hole)',
                highLabel: 'Thick',
            }
            : null,
        legend: ozoneMeta?.noData ? [[ozoneMeta.noData.color, ozoneMeta.noData.label]] : null,
    },
    {
        id: 'radiation',
        category: 'Land & hazards',
        icon: '☢️',
        name: 'Radiation background',
        description: 'Gamma dose rate near the ground, measured by volunteers with Safecast dosimeters. Only measured places are coloured.',
        url: radiationUrl,
        enabled: false,
        opacity: 0.9,
        details: radiationMeta
            ? `${radiationMeta.start} – ${radiationMeta.end} · Safecast · `
                + `${(radiationMeta.stats.readingsUsed / 1e6).toFixed(1)} M readings · median ${radiationMeta.stats.medianUSvH} µSv/h`
            : null,
        scale: radiationMeta
            ? {
                stops: radiationMeta.scale.stops,
                min: radiationMeta.scale.min,
                max: radiationMeta.scale.max,
                log: true,
                unit: 'µSv/h',
                lowLabel: 'Low',
                highLabel: 'High',
            }
            : null,
    },
];

// Layers from the GIBS manifest: one card each, texture loaded only when switched on
gibsManifest.forEach((m) =>
{
    const url = gibsUrls[`./textures/gibs/${m.file}`];
    if (!url) return;
    const period = m.static ? 'static map' : (m.start === m.end ? m.end : `${m.start} – ${m.end}`);
    DATA_LAYERS.push({
        id: m.id,
        category: m.category,
        icon: m.icon,
        iconIsText: m.iconIsText,
        name: m.name,
        description: m.description,
        url,
        enabled: false,
        opacity: m.opacity ?? 0.85,
        night: m.night,
        legendBlocks: m.legend,
        details: `${period} · NASA GIBS · ${m.gibsTitle}`,
    });
});

// One panel group per theme; our own processed layers sit in the matching group (stable sort)
const CATEGORY_ORDER = ['Water & radar', 'Air quality', 'Temperature, rain & ice', 'Land & hazards', 'Night'];
const categoryRank = (category) =>
{
    const rank = CATEGORY_ORDER.indexOf(category);
    return rank < 0 ? CATEGORY_ORDER.length : rank;
};
DATA_LAYERS.sort((a, b) => categoryRank(a.category) - categoryRank(b.category));

// Night mode (night lights layer): the globe fades to dark, the Sun fades out, the city lights fade in
const NIGHT_FADE_MS = 1500;
let nightTarget = 0;              // 0 = day, 1 = night
let nightLevel = 0;               // current, animated towards the target
let nightLastTime = null;
let nightLayer = null;
const setNightMode = (on) =>
{
    nightTarget = on ? 1 : 0;
    nightLastTime = null;
    requestRender();
};
const applyNight = () =>
{
    const t = nightLevel * nightLevel * (3 - 2 * nightLevel);      // smoothstep
    earth.material.color.setScalar(1 - 0.94 * t);
    sun.material.opacity = 1 - t;
    sun.visible = t < 0.999;
    atmosphere.material.opacity = 1 - 0.65 * t;
    if (nightLayer?.mesh)
    {
        // the lights appear in the second half of the fade, after the day side has dimmed
        const lights = Math.min(1, Math.max(0, (nightLevel - 0.35) / 0.65));
        nightLayer.material.opacity = nightLayer.userOpacity * lights;
        nightLayer.mesh.visible = lights > 0 && Boolean(nightLayer.material.map);
    }
};
const stepNight = (now) =>
{
    if (nightLevel === nightTarget)
    {
        nightLastTime = null;
        if (nightLevel === 0 && nightLayer && !nightLayer.isOn && nightLayer.material?.map) nightLayer.unload();
        return;
    }
    const dt = nightLastTime === null ? 16 : Math.min(100, now - nightLastTime);
    nightLastTime = now;
    const step = dt / NIGHT_FADE_MS;
    nightLevel = nightTarget > nightLevel
        ? Math.min(nightTarget, nightLevel + step)
        : Math.max(nightTarget, nightLevel - step);
    applyNight();
    requestRender();
};

const layerList = document.querySelector('#layer-list');
let currentCategory = null;

const createOverlay = (layer, index, texture) =>
{
    layer.material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,           // drawn on top of the surface without z-fighting
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1 - index,
    });
    layer.mesh = new THREE.Mesh(earth.geometry, layer.material);
    layer.mesh.renderOrder = index;
    layer.mesh.visible = false;
    globe.add(layer.mesh);
};

const appendLegendBlocks = (card, blocks) =>
{
    blocks.forEach((block) =>
    {
        if (block.type === 'gradient')
        {
            const scale = document.createElement('div');
            scale.className = 'scale';
            scale.innerHTML = `
                <div class="scale-title"></div>
                <div class="scale-bar"></div>
                <div class="scale-ticks"><span></span><span></span></div>`;
            scale.querySelector('.scale-title').textContent = block.title + (block.units ? `, ${block.units}` : '');
            scale.querySelector('.scale-bar').style.background = `linear-gradient(to right, ${block.colors.join(', ')})`;
            const ticks = scale.querySelectorAll('.scale-ticks span');
            ticks[0].textContent = block.min;
            ticks[1].textContent = block.max;
            card.append(scale);
        }
        else if (block.items?.length)
        {
            const legend = document.createElement('ul');
            legend.className = 'legend';
            block.items.forEach(([color, label]) =>
            {
                const item = document.createElement('li');
                const swatch = document.createElement('i');
                swatch.style.background = color;
                item.append(swatch, label);
                legend.append(item);
            });
            card.append(legend);
        }
    });
};

DATA_LAYERS.forEach((layer, index) =>
{
    const available = Boolean(layer.url);
    // Layers switched on at start are loaded with the page; the others only when switched on
    layer.lazy = !layer.enabled;
    if (available && !layer.lazy)
    {
        createOverlay(layer, index, loadTexture(layer.url, true));
        layer.baseTexture = layer.material.map;
    }

    if (layer.category !== currentCategory)
    {
        currentCategory = layer.category;
        const heading = document.createElement('h2');
        heading.className = 'layer-group';
        heading.textContent = currentCategory;
        layerList.append(heading);
    }

    // Card in the panel: header always visible, body (description, slider, legend) only when on
    const card = document.createElement('section');
    card.className = 'layer' + (available ? '' : ' layer--soon');
    card.innerHTML = `
        <div class="layer-head">
            <span class="layer-icon${layer.iconIsText ? ' layer-icon--text' : ''}" aria-hidden="true"></span>
            <div class="layer-title">
                <span class="layer-name"></span>
                ${available ? '' : '<span class="badge">Coming soon</span>'}
            </div>
            <label class="switch" title="Show / hide">
                <input type="checkbox">
                <span class="switch-track"></span>
            </label>
        </div>
        <div class="layer-body">
            <p class="layer-desc"></p>
            <div class="layer-opacity">
                <span>Visibility</span>
                <input type="range" min="0" max="1" step="0.05">
                <output></output>
            </div>
        </div>`;
    const body = card.querySelector('.layer-body');
    card.querySelector('.layer-icon').textContent = layer.icon;
    card.querySelector('.layer-name').textContent = layer.name;
    card.querySelector('.layer-desc').textContent = layer.description;
    card.querySelector('.switch input').setAttribute('aria-label', `Show ${layer.name}`);
    card.querySelector('input[type="range"]').setAttribute('aria-label', `${layer.name} visibility`);

    if (layer.legend)
    {
        const legend = document.createElement('ul');
        legend.className = 'legend';
        layer.legend.forEach(([color, label]) =>
        {
            const item = document.createElement('li');
            const swatch = document.createElement('i');
            swatch.style.background = color;
            item.append(swatch, label);
            legend.append(item);
        });
        body.append(legend);
    }
    if (layer.scale)
    {
        // continuous colour scale: gradient bar with values in its units
        const { stops, min, max, unit, lowLabel, highLabel, log } = layer.scale;
        const position = log
            ? (value) => (Math.log(value) - Math.log(min)) / (Math.log(max) - Math.log(min))
            : (value) => (value - min) / (max - min);
        const mid = log ? Number(Math.sqrt(min * max).toPrecision(2)) : Math.round((min + max) / 2);
        const gradient = stops
            .map(([value, color]) => `${color} ${position(value) * 100}%`)
            .join(', ');
        const scale = document.createElement('div');
        scale.className = 'scale';
        scale.innerHTML = `
            <div class="scale-bar"></div>
            <div class="scale-ticks"><span></span><span></span><span></span></div>
            <div class="scale-labels"><span></span><span></span></div>`;
        scale.querySelector('.scale-bar').style.background = `linear-gradient(to right, ${gradient})`;
        const ticks = scale.querySelectorAll('.scale-ticks span');
        ticks[0].textContent = `${min} ${unit}`;
        ticks[1].textContent = `${mid}`;
        ticks[2].textContent = `${max} ${unit}`;
        const labels = scale.querySelectorAll('.scale-labels span');
        labels[0].textContent = lowLabel;
        labels[1].textContent = highLabel;
        body.append(scale);
    }
    if (layer.legendBlocks) appendLegendBlocks(body, layer.legendBlocks);
    if (layer.details)
    {
        const details = document.createElement('p');
        details.className = 'layer-details';
        details.textContent = layer.details;
        body.append(details);
    }

    const toggle = card.querySelector('.switch input');
    const slider = card.querySelector('input[type="range"]');
    const value = card.querySelector('output');
    toggle.checked = available && layer.enabled;
    toggle.disabled = !available;
    slider.value = layer.opacity;

    // Lazy layers: load the texture (decoded off the main thread) when switched on, free it when off
    const loadLazy = () =>
    {
        if (layer.loading || layer.material?.map) return;
        layer.loading = true;
        card.classList.add('layer--loading');
        bitmapLoader.load(layer.url, (bitmap) =>
        {
            layer.loading = false;
            card.classList.remove('layer--loading');
            const texture = bitmapTexture(bitmap);
            texture.anisotropy = maxAnisotropy;
            if (!toggle.checked) { bitmap.close?.(); texture.dispose(); return; }
            if (!layer.mesh) createOverlay(layer, index, texture);
            else { layer.material.map = texture; layer.material.needsUpdate = true; }
            update();
        }, undefined, () =>
        {
            layer.loading = false;
            card.classList.remove('layer--loading');
        });
    };
    const unloadLazy = () =>
    {
        const map = layer.material?.map;
        if (!map) return;
        layer.material.map = null;
        layer.material.needsUpdate = true;
        map.source?.data?.close?.();
        map.dispose();
    };

    const update = () =>
    {
        const on = toggle.checked;
        slider.disabled = !on;
        card.classList.toggle('layer--off', !on);
        value.textContent = `${Math.round(Number(slider.value) * 100)}%`;
        layer.isOn = on;
        layer.unload = unloadLazy;
        if (layer.lazy && available)
        {
            if (on) loadLazy();
            else if (!layer.night) unloadLazy();    // night lights are freed after they have faded out
        }
        if (layer.night)
        {
            // visibility and opacity of the lights are driven by the night fade
            nightLayer = layer;
            layer.userOpacity = Number(slider.value);
            setNightMode(on && Boolean(layer.material?.map));
            if (layer.mesh) applyNight();
            return;
        }
        if (layer.mesh)
        {
            layer.mesh.visible = on && Boolean(layer.material.map);
            layer.material.opacity = Number(slider.value);
            requestRender();
        }
    };
    toggle.addEventListener('change', update);
    slider.addEventListener('input', update);
    update();

    layerList.append(card);
});

// Data layers in higher resolution for close-ups: the enhanced texture is loaded (decoded off the main
// thread) only when the layer is visible and the view needs more detail than the base texture has,
// and freed again when zooming far out.
const updateOverlayDetail = () =>
{
    const need = texelsNeeded();
    DATA_LAYERS.forEach((layer) =>
    {
        if (!layer.hiUrl || !layer.mesh) return;
        const baseWidth = layer.baseTexture.image?.width || 4096;
        const wantHi = layer.mesh.visible && need > baseWidth * (layer.hiActive ? 0.9 : 1.2);
        if (wantHi && !layer.hiTexture && !layer.hiLoading)
        {
            layer.hiLoading = true;
            bitmapLoader.load(layer.hiUrl, (bitmap) =>
            {
                layer.hiLoading = false;
                layer.hiTexture = bitmapTexture(bitmap);
                layer.hiTexture.anisotropy = maxAnisotropy;
                renderer.initTexture(layer.hiTexture);
                requestRender();
            }, undefined, () => { layer.hiLoading = false; layer.hiUrl = null; });
        }
        if (wantHi && layer.hiTexture && !layer.hiActive)
        {
            layer.material.map = layer.hiTexture;
            layer.material.needsUpdate = true;
            layer.hiActive = true;
            requestRender();
        }
        else if (!wantHi && layer.hiActive)
        {
            layer.material.map = layer.baseTexture;
            layer.material.needsUpdate = true;
            layer.hiActive = false;
            requestRender();
        }
        if (layer.hiTexture && !layer.hiActive && need < baseWidth * 0.5)
        {
            layer.hiTexture.source?.data?.close?.();
            layer.hiTexture.dispose();             // far away: free ~170 MB of GPU memory
            layer.hiTexture = null;
        }
    });
};

// Collapse / expand the panel (starts collapsed on small screens)
const panel = document.querySelector('.panel');
const panelToggle = document.querySelector('.panel-collapse');
const setCollapsed = (collapsed) =>
{
    panel.classList.toggle('panel--collapsed', collapsed);
    panelToggle.setAttribute('aria-expanded', String(!collapsed));
    panelToggle.textContent = collapsed ? '▸' : '▾';
};
panelToggle.addEventListener('click', () => setCollapsed(!panel.classList.contains('panel--collapsed')));
const smallScreen = window.matchMedia('(max-width: 600px)');
setCollapsed(smallScreen.matches);

// On phones the open panel covers most of the screen: a tap on the free part of the screen closes it
// (a drag still rotates the globe and keeps the panel open)
let tapStart = null;
let pointersDown = 0;
canvas.addEventListener('pointerdown', (event) =>
{
    pointersDown += 1;
    // a second finger means pinch-zoom, not a tap
    tapStart = pointersDown === 1 ? { x: event.clientX, y: event.clientY, time: performance.now() } : null;
});
window.addEventListener('pointerup', () => { pointersDown = Math.max(0, pointersDown - 1); });
window.addEventListener('pointercancel', () => { pointersDown = Math.max(0, pointersDown - 1); });
canvas.addEventListener('pointerup', (event) =>
{
    if (!tapStart) return;
    const moved = Math.hypot(event.clientX - tapStart.x, event.clientY - tapStart.y);
    const quick = performance.now() - tapStart.time < 400;
    tapStart = null;
    if (smallScreen.matches && moved < 10 && quick && !panel.classList.contains('panel--collapsed'))
        setCollapsed(true);
});
canvas.addEventListener('pointercancel', () => { tapStart = null; });

// ---------------------------------------------------------------------------
// Atmosphere glow: a camera-facing ring around the globe's silhouette.
// Plain geometry with per-vertex alpha, no custom shaders.
//  - inner part overlaps the Earth's edge (haze over the limb)
//  - outer part fades out into space
// ---------------------------------------------------------------------------
const RING_SEGMENTS = 128;
const INNER_STEPS = 6;
const OUTER_STEPS = 10;
const INNER_START = 0.9;  // haze starts at 90% of the silhouette radius
const PEAK_ALPHA = 0.75;  // brightest right at the silhouette

// Radial profile: { zone, t } per ring of vertices
const ringProfile = [];
for (let i = 0; i <= INNER_STEPS; i++) ringProfile.push({ zone: 'inner', t: i / INNER_STEPS });
for (let i = 1; i <= OUTER_STEPS; i++) ringProfile.push({ zone: 'outer', t: i / OUTER_STEPS });

const ringGeometry = new THREE.BufferGeometry();
const vertexCount = ringProfile.length * (RING_SEGMENTS + 1);
const ringPositions = new Float32Array(vertexCount * 3);
const ringColors = new Float32Array(vertexCount * 4);
const ringIndices = [];

ringProfile.forEach(({ zone, t }, step) =>
{
    const alpha = zone === 'inner'
        ? PEAK_ALPHA * t * t * t              // fades in towards the edge
        : PEAK_ALPHA * (1 - t) * (1 - t);     // fades out into space

    for (let i = 0; i <= RING_SEGMENTS; i++)
    {
        const v = step * (RING_SEGMENTS + 1) + i;
        ringColors.set([ATMOSPHERE_COLOR.r, ATMOSPHERE_COLOR.g, ATMOSPHERE_COLOR.b, alpha], v * 4);

        if (step < ringProfile.length - 1 && i < RING_SEGMENTS)
        {
            const next = v + RING_SEGMENTS + 1;
            ringIndices.push(v, next, v + 1, v + 1, next, next + 1);
        }
    }
});

ringGeometry.setAttribute('position', new THREE.BufferAttribute(ringPositions, 3));
ringGeometry.setAttribute('color', new THREE.BufferAttribute(ringColors, 4));
ringGeometry.setIndex(ringIndices);

const atmosphere = new THREE.Mesh(
    ringGeometry,
    new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        depthTest: false,          // drawn as an overlay on top of the globe's edge
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
    })
);
atmosphere.frustumCulled = false;
atmosphere.renderOrder = 1;
scene.add(atmosphere);

// Radius (in the plane through the globe centre) where the view cone touches a sphere
const silhouetteRadius = (sphereRadius, distance) =>
    (sphereRadius * distance) / Math.sqrt(distance * distance - sphereRadius * sphereRadius);

const updateAtmosphere = () =>
{
    const distance = camera.position.length();
    const edge = silhouetteRadius(EARTH_RADIUS, distance);
    const inner = edge * INNER_START;
    const outer = silhouetteRadius(ATMOSPHERE_RADIUS, distance);

    ringProfile.forEach(({ zone, t }, step) =>
    {
        const radius = zone === 'inner'
            ? inner + (edge - inner) * t
            : edge + (outer - edge) * t;

        for (let i = 0; i <= RING_SEGMENTS; i++)
        {
            const angle = (i / RING_SEGMENTS) * Math.PI * 2;
            const v = (step * (RING_SEGMENTS + 1) + i) * 3;
            ringPositions[v] = Math.cos(angle) * radius;
            ringPositions[v + 1] = Math.sin(angle) * radius;
            ringPositions[v + 2] = 0;
        }
    });
    ringGeometry.attributes.position.needsUpdate = true;

    // Face the camera (the camera always looks at the globe centre)
    atmosphere.quaternion.copy(camera.quaternion);
};

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.enablePan = false;
// Closest zoom: one screen pixel shows about MAX_DETAIL_KM of ground in the centre of the view
// (the resolution of the 8K map and of the enhanced data layers); depends on the window height.
const MAX_DETAIL_KM = 5;
const EARTH_RADIUS_KM = 6371;
const updateMinDistance = () =>
{
    const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
    const altitude = (MAX_DETAIL_KM / EARTH_RADIUS_KM) * window.innerHeight / (2 * Math.tan(halfFov));
    controls.minDistance = EARTH_RADIUS + altitude;
};
updateMinDistance();
controls.maxDistance = 10;
controls.addEventListener('change', requestRender);

// "Reset view": fly back to the start position (direction and distance) with ease in-out
const RESET_DURATION = 900; // ms
let resetAnimation = null;
const startReset = () =>
{
    resetAnimation = {
        start: performance.now(),
        fromDir: camera.position.clone().normalize(),
        toDir: HOME_POSITION.clone().normalize(),
        fromDist: camera.position.length(),
        toDist: HOME_POSITION.length(),
    };
    resetAnimation.rotation = new THREE.Quaternion().setFromUnitVectors(resetAnimation.fromDir, resetAnimation.toDir);
    controls.enabled = false;
    requestRender();
};
const stepReset = (now) =>
{
    const a = resetAnimation;
    const t = Math.min(1, (now - a.start) / RESET_DURATION);
    const k = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // easeInOutCubic
    const dir = a.fromDir.clone().applyQuaternion(new THREE.Quaternion().slerp(a.rotation, k));
    camera.position.copy(dir.multiplyScalar(THREE.MathUtils.lerp(a.fromDist, a.toDist, k)));
    camera.up.set(0, 1, 0);             // north up again
    camera.lookAt(controls.target);
    if (t >= 1)
    {
        resetAnimation = null;
        controls.enabled = true;
        controls.update();
    }
    requestRender();
};
document.querySelector('.reset-view').addEventListener('click', startReset);

// Slow down rotation/zoom near the surface so close-up navigation stays controllable
const updateControlSpeed = () =>
{
    const altitude = camera.position.length() - EARTH_RADIUS;
    const factor = THREE.MathUtils.clamp(altitude / 2, 0.02, 1);
    controls.rotateSpeed = factor;
    controls.zoomSpeed = THREE.MathUtils.clamp(factor * 2, 0.1, 1);
};

// ---------------------------------------------------------------------------
// Resize & fullscreen
// ---------------------------------------------------------------------------
window.addEventListener('resize', () =>
{
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(getPixelRatio());
    updateMinDistance();
    controls.update();
    requestRender();
});

// Browsers may drop the canvas contents of background tabs: redraw when the page is shown again
document.addEventListener('visibilitychange', () =>
{
    if (!document.hidden) requestRender();
});

window.addEventListener('dblclick', () =>
{
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;

    if (!fullscreenElement)
    {
        if (canvas.requestFullscreen) canvas.requestFullscreen();
        else if (canvas.webkitRequestFullscreen) canvas.webkitRequestFullscreen();
    }
    else
    {
        if (document.exitFullscreen) document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    }
});

// ---------------------------------------------------------------------------
// Loop: controls are updated every frame (for damping), rendering only on change
// ---------------------------------------------------------------------------
const tick = (now = performance.now()) =>
{
    stepNight(now);
    if (resetAnimation) stepReset(now);
    else controls.update(); // fires 'change' while the camera is still moving

    if (needsRender)
    {
        needsRender = false;
        updateControlSpeed();
        updateAtmosphere();
        updateLod();
        updateTiles();
        updateOverlayDetail();
        renderer.render(scene, camera);
    }

    requestAnimationFrame(tick);
};
tick();
