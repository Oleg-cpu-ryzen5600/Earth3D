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

const LOD_TEXEL_RATIO = 0.5;   // up to 2x magnification of texels is acceptable
const LOD_DOWN_MARGIN = 0.8;   // hysteresis: switch down only well below the threshold
const lazyLoader = new THREE.TextureLoader();
const lodLabel = document.querySelector('#lod-level');
let lodCurrent = 0;
let lodWanted = 0;

const texelsNeeded = () =>
{
    // projected radius of the globe in device pixels
    const distance = camera.position.length();
    const angularRadius = Math.asin(Math.min(1, EARTH_RADIUS / distance));
    const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
    const radiusPx = (Math.tan(angularRadius) / Math.tan(halfFov)) * renderer.domElement.height / 2;
    // around the centre of the disc 1 radian of longitude ~ radiusPx pixels -> full texture width = 2*pi*radiusPx
    return 2 * Math.PI * radiusPx * LOD_TEXEL_RATIO;
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
    lazyLoader.load(level.url, (texture) =>
    {
        level.loading = false;
        texture.colorSpace = THREE.SRGBColorSpace;
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
// Data layers
// Each layer is a transparent copy of the globe drawn on top of the surface.
// To add data for a layer, set `url` to its texture (equirectangular, with alpha):
// its card in the panel becomes active automatically.
// ---------------------------------------------------------------------------
const sarStats = sarMeta.stats;
const DATA_LAYERS = [
    {
        id: 'water',
        icon: '💧',
        name: 'Surface water & moisture',
        description: 'Radar satellites see how wet and rough the ground is, even through clouds and at night.',
        url: sarUrl,
        enabled: true,
        opacity: 1,
        details: `${sarMeta.start} – ${sarMeta.end} · NISAR + Sentinel-1`
            + (sarStats ? ` (${sarStats.nisarSharePercent}% / ${sarStats.sentinel1SharePercent}%)` : ''),
        legend: [
            ['#3bd16f', 'Vegetation'],
            ['#d65a8c', 'Cities, rock'],
            ['#4a6fd6', 'Smooth or wet ground'],
        ],
    },
    {
        id: 'ozone',
        icon: 'O₃',
        iconIsText: true,
        name: 'Ozone layer',
        description: 'How much ozone shields the surface from the Sun\'s ultraviolet light.',
        url: null,
        enabled: false,
        opacity: 0.8,
    },
    {
        id: 'radiation',
        icon: '☢️',
        name: 'Radiation background',
        description: 'Natural background radiation level at the surface.',
        url: null,
        enabled: false,
        opacity: 0.8,
    },
];

const layerList = document.querySelector('#layer-list');

DATA_LAYERS.forEach((layer, index) =>
{
    const available = Boolean(layer.url);

    // 3D overlay
    if (available)
    {
        layer.material = new THREE.MeshBasicMaterial({
            map: loadTexture(layer.url, true),
            transparent: true,
            depthWrite: false,
            polygonOffset: true,           // drawn on top of the surface without z-fighting
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1 - index,
        });
        layer.mesh = new THREE.Mesh(earth.geometry, layer.material);
        layer.mesh.renderOrder = index;
        globe.add(layer.mesh);
    }

    // Card in the panel
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
        <p class="layer-desc"></p>
        <div class="layer-opacity">
            <span>Visibility</span>
            <input type="range" min="0" max="1" step="0.05">
            <output></output>
        </div>`;
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
        card.append(legend);
    }
    if (layer.details)
    {
        const details = document.createElement('p');
        details.className = 'layer-details';
        details.textContent = layer.details;
        card.append(details);
    }

    const toggle = card.querySelector('.switch input');
    const slider = card.querySelector('input[type="range"]');
    const value = card.querySelector('output');
    toggle.checked = available && layer.enabled;
    toggle.disabled = !available;
    slider.value = layer.opacity;

    const update = () =>
    {
        const on = toggle.checked;
        slider.disabled = !on;
        card.classList.toggle('layer--off', !on);
        value.textContent = `${Math.round(Number(slider.value) * 100)}%`;
        if (layer.mesh)
        {
            layer.mesh.visible = on;
            layer.material.opacity = Number(slider.value);
            requestRender();
        }
    };
    toggle.addEventListener('change', update);
    slider.addEventListener('input', update);
    update();

    layerList.append(card);
});

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
setCollapsed(window.matchMedia('(max-width: 600px)').matches);

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
controls.minDistance = 1.05; // ~320 km above the surface (Earth radius = 1)
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
    if (resetAnimation) stepReset(now);
    else controls.update(); // fires 'change' while the camera is still moving

    if (needsRender)
    {
        needsRender = false;
        updateControlSpeed();
        updateAtmosphere();
        updateLod();
        renderer.render(scene, camera);
    }

    requestAnimationFrame(tick);
};
tick();
