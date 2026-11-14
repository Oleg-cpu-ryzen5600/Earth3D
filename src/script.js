import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import earthDayUrl from './textures/earth_day.webp';

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
camera.position.set(-3.2, 2.9, -1.2).setLength(5);
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

const earthDayTexture = loadTexture(earthDayUrl, true);

// ---------------------------------------------------------------------------
// Globe (tilted group)
// ---------------------------------------------------------------------------
const globe = new THREE.Group();
globe.rotation.x = THREE.MathUtils.degToRad(23.5); // axial tilt
scene.add(globe);

// Earth: evenly lit, no lighting calculations at all
const earth = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_RADIUS, SEGMENTS, SEGMENTS),
    new THREE.MeshBasicMaterial({ map: earthDayTexture })
);
globe.add(earth);

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
const tick = () =>
{
    controls.update(); // fires 'change' while the camera is still moving

    if (needsRender)
    {
        needsRender = false;
        updateControlSpeed();
        updateAtmosphere();
        renderer.render(scene, camera);
    }

    requestAnimationFrame(tick);
};
tick();
