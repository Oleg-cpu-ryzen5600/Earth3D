import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import earthVertexShader from './shaders/earth/earth.vert';
import earthFragmentShader from './shaders/earth/earth.frag';
import atmosphereVertexShader from './shaders/atmosphere/atmosphere.vert';
import atmosphereFragmentShader from './shaders/atmosphere/atmosphere.frag';

// Canvas
const canvas = document.querySelector('canvas.webgl');

// Scene
const scene = new THREE.Scene();

// Sizes
const sizes = {
    width: window.innerWidth,
    height: window.innerHeight,
    pixelRatio: Math.min(window.devicePixelRatio, 2),
};

// Camera
// Small near plane so the surface isn't clipped when zoomed in close
const camera = new THREE.PerspectiveCamera(45, sizes.width / sizes.height, 0.001, 100);
camera.position.set(-3.2, 2.9, -1.2).setLength(5);
scene.add(camera);

// Renderer
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(sizes.width, sizes.height);
renderer.setPixelRatio(sizes.pixelRatio);
renderer.setClearColor(0x000000, 1);

// Resize
window.addEventListener('resize', () =>
{
    sizes.width = window.innerWidth;
    sizes.height = window.innerHeight;
    sizes.pixelRatio = Math.min(window.devicePixelRatio, 2);

    camera.aspect = sizes.width / sizes.height;
    camera.updateProjectionMatrix();

    renderer.setSize(sizes.width, sizes.height);
    renderer.setPixelRatio(sizes.pixelRatio);
});

// Fullscreen on double click
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

// Textures
const textureLoader = new THREE.TextureLoader();
const maxAnisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);

const loadTexture = (path, isColor) =>
{
    const texture = textureLoader.load(path);
    texture.anisotropy = maxAnisotropy;
    if (isColor) texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
};

const earthDayTexture = loadTexture('textures/2k_earth_daymap.jpg', true);
// G channel: clouds (R channel — ocean specular mask, unused without a sun)
const earthSpecularCloudsTexture = loadTexture('textures/specularClouds.jpg', false);

// Atmosphere color
const atmosphereColor = new THREE.Color(0x9fd8ff);

// Earth
const earthGeometry = new THREE.SphereGeometry(1, 64, 64);
const earthMaterial = new THREE.ShaderMaterial({
    vertexShader: earthVertexShader,
    fragmentShader: earthFragmentShader,
    uniforms: {
        uDayTexture: new THREE.Uniform(earthDayTexture),
        uSpecularCloudsTexture: new THREE.Uniform(earthSpecularCloudsTexture),
        uAtmosphereColor: new THREE.Uniform(atmosphereColor),
    },
});
const earth = new THREE.Mesh(earthGeometry, earthMaterial);
earth.rotation.x = THREE.MathUtils.degToRad(23.5); // axial tilt
scene.add(earth);

// Atmosphere
const atmosphereMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    transparent: true,
    vertexShader: atmosphereVertexShader,
    fragmentShader: atmosphereFragmentShader,
    uniforms: {
        uAtmosphereColor: new THREE.Uniform(atmosphereColor),
    },
});
const atmosphere = new THREE.Mesh(earthGeometry, atmosphereMaterial);
atmosphere.scale.setScalar(1.025);
scene.add(atmosphere);

// Orbit controls
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.enablePan = false;
const EARTH_RADIUS = 1;
controls.minDistance = 1.05; // ~320 km above the surface (Earth radius = 1)
controls.maxDistance = 10;

// Slow down rotation/zoom near the surface so close-up navigation stays controllable
const updateControlSpeed = () =>
{
    const altitude = camera.position.length() - EARTH_RADIUS;
    const factor = THREE.MathUtils.clamp(altitude / 2, 0.02, 1);
    controls.rotateSpeed = factor;
    controls.zoomSpeed = THREE.MathUtils.clamp(factor * 2, 0.1, 1);
};

// Animation (no automatic rotation — the globe moves only with the user)
const tick = () =>
{
    updateControlSpeed();
    controls.update();
    renderer.render(scene, camera);

    requestAnimationFrame(tick);
};
tick();
