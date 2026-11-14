// Adapted from Bruno Simon's Earth shader (Three.js Journey, https://threejs-journey.com)
// Day side only: the whole globe is evenly lit, no day/night cycle.

uniform sampler2D uDayTexture;
uniform sampler2D uSpecularCloudsTexture;
uniform vec3 uAtmosphereColor;

varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vPosition;

void main()
{
    vec3 viewDirection = normalize(vPosition - cameraPosition);
    vec3 normal = normalize(vNormal);

    // Surface
    vec3 color = texture(uDayTexture, vUv).rgb;

    // Clouds (G channel)
    float clouds = texture(uSpecularCloudsTexture, vUv).g;
    float cloudsMix = smoothstep(0.5, 1.0, clouds);
    color = mix(color, vec3(1.0), cloudsMix);

    // Fresnel atmosphere tint on the edges
    float fresnel = dot(viewDirection, normal) + 1.0;
    fresnel = pow(fresnel, 2.0);
    color = mix(color, uAtmosphereColor, fresnel);

    // Final color
    gl_FragColor = vec4(color, 1.0);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
