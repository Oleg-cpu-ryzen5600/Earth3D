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
const camera = new THREE.PerspectiveCamera(45, sizes.width / sizes.height, 0.1, 100);
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
const earthNightTexture = loadTexture('textures/night.jpg', true);
// R channel: ocean specular mask, G channel: clouds
const earthSpecularCloudsTexture = loadTexture('textures/specularClouds.jpg', false);

// Shared atmosphere colors
const atmosphereDayColor = new THREE.Color(0x9fd8ff);
const atmosphereTwilightColor = new THREE.Color(0x050c1f);

// Earth
const earthGeometry = new THREE.SphereGeometry(1, 64, 64);
const earthMaterial = new THREE.ShaderMaterial({
    vertexShader: earthVertexShader,
    fragmentShader: earthFragmentShader,
    uniforms: {
        uDayTexture: new THREE.Uniform(earthDayTexture),
        uNightTexture: new THREE.Uniform(earthNightTexture),
        uSpecularCloudsTexture: new THREE.Uniform(earthSpecularCloudsTexture),
        uSunDirection: new THREE.Uniform(new THREE.Vector3()),
        uAtmosphereDayColor: new THREE.Uniform(atmosphereDayColor),
        uAtmosphereTwilightColor: new THREE.Uniform(atmosphereTwilightColor),
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
        uSunDirection: new THREE.Uniform(new THREE.Vector3()),
        uAtmosphereDayColor: new THREE.Uniform(atmosphereDayColor),
        uAtmosphereTwilightColor: new THREE.Uniform(atmosphereTwilightColor),
    },
});
const atmosphere = new THREE.Mesh(earthGeometry, atmosphereMaterial);
atmosphere.scale.setScalar(1.025);
scene.add(atmosphere);

// Sun direction (the sun itself is not rendered, it only drives the shaders)
const sunSpherical = new THREE.Spherical(1, Math.PI * 0.5, 0.5);
const sunDirection = new THREE.Vector3().setFromSpherical(sunSpherical);
earthMaterial.uniforms.uSunDirection.value.copy(sunDirection);
atmosphereMaterial.uniforms.uSunDirection.value.copy(sunDirection);

// Orbit controls
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.enablePan = false;
controls.minDistance = 3;
controls.maxDistance = 10;

// Animation
const clock = new THREE.Clock();
const tick = () =>
{
    const elapsedTime = clock.getElapsedTime();

    // Rotate the earth around its (tilted) axis
    earth.rotation.y = elapsedTime * 0.1;

    controls.update();
    renderer.render(scene, camera);

    requestAnimationFrame(tick);
};
tick();
