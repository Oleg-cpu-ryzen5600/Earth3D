// Adapted from Bruno Simon's Earth shader (Three.js Journey, https://threejs-journey.com)
// Uniform glow around the whole globe (no day/night dependency).

uniform vec3 uAtmosphereColor;

varying vec3 vNormal;
varying vec3 vPosition;

void main()
{
    vec3 viewDirection = normalize(vPosition - cameraPosition);
    vec3 normal = normalize(vNormal);

    // Fade towards the outer edge
    float edgeAlpha = dot(viewDirection, normal);
    edgeAlpha = smoothstep(0.0, 0.5, edgeAlpha);

    gl_FragColor = vec4(uAtmosphereColor * 2.0, edgeAlpha);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
