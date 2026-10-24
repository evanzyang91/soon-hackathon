// GLSL for the look post pass. The grade shader mirrors grade.ts `gradePixel` step for step (keep
// them in sync); bright-pass + separable blur make the bloom at reduced resolution. Fog and sky
// tint are per splat (lights.ts), not here.

const COMMON = /* glsl */ `
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
vec3 toLin(vec3 c) {
  c = max(c, 0.0);
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 toSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
`;

export const QUAD_VERT = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const GRADE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tColor;
uniform sampler2D tBloom;
uniform bool uUseBloom;
uniform mat3 uWB;
uniform float uExposure;
uniform float uContrast;
uniform float uSaturation;
uniform float uShadows;
uniform float uHighlights;
uniform float uLutSat;
uniform float uLutContrast;
uniform float uLutStrength;
uniform vec3 uLutLift;
uniform vec3 uLutGamma;
uniform vec3 uLutGain;
uniform vec3 uLutShadow;
uniform vec3 uLutHigh;
uniform float uVignette;
uniform float uAspect;
uniform float uGrain;
uniform float uFrame;
uniform float uBloom;
in vec2 vUv;
out vec4 outColor;
${COMMON}

float sCurve(float x, float k) {
  return x < 0.5 ? 0.5 * pow(2.0 * x, k) : 1.0 - 0.5 * pow(2.0 * (1.0 - x), k);
}

vec3 applyLut(vec3 d) {
  float L = dot(d, LUMA);
  vec3 o = (vec3(L) + (d - L) * uLutSat) * uLutGain;
  o = uLutLift + o * (1.0 - uLutLift);
  o = pow(max(o, 0.0), 1.0 / uLutGamma);
  o = clamp(o, 0.0, 1.0);
  o = vec3(sCurve(o.r, uLutContrast), sCurve(o.g, uLutContrast), sCurve(o.b, uLutContrast));
  L = dot(o, LUMA);
  float ws = (1.0 - L) * (1.0 - L);
  float wh = L * L;
  return clamp(o + uLutShadow * ws + uLutHigh * wh, 0.0, 1.0);
}

vec3 shadowsHighlights(vec3 d) {
  float L = clamp(dot(d, LUMA), 0.0, 1.0);
  float L2 = L;
  if (uShadows != 0.0) L2 += (pow(L2, exp2(-uShadows)) - L2) * (1.0 - smoothstep(0.0, 0.7, L));
  if (uHighlights != 0.0)
    L2 += (1.0 - pow(max(1.0 - L2, 0.0), exp2(uHighlights)) - L2) * smoothstep(0.3, 1.0, L);
  return d + (L2 - L);
}

float vignette(vec2 uv) {
  if (uVignette <= 0.0) return 1.0;
  vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
  float r = length(p) / length(vec2(0.5 * uAspect, 0.5));
  return 1.0 - uVignette * 0.85 * pow(smoothstep(0.3, 1.05, r), 1.5);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 lin = toLin(texture(tColor, vUv).rgb);
  if (uUseBloom) lin += texture(tBloom, vUv).rgb * uBloom * 1.5;
  lin = uWB * lin;
  lin *= uExposure * vignette(vUv);
  if (uContrast != 1.0) lin = 0.18 * pow(max(lin, 0.0) / 0.18, vec3(uContrast));
  float Ll = dot(lin, LUMA);
  lin = vec3(Ll) + (lin - Ll) * uSaturation;
  vec3 d = min(toSrgb(lin), 1.0);
  d = shadowsHighlights(d);
  if (uLutStrength > 0.0) d = mix(d, applyLut(d), uLutStrength);
  if (uGrain > 0.0) {
    float n = hash12(gl_FragCoord.xy + uFrame * vec2(17.0, 59.0)) - 0.5;
    float L = clamp(dot(d, LUMA), 0.0, 1.0);
    d += n * uGrain * 0.16 * (0.15 + 3.4 * L * (1.0 - L));
  }
  outColor = vec4(clamp(d, 0.0, 1.0), 1.0);
}
`;

/** Half-resolution bright pass: 2×2 box of the (nearest-sampled) frame, soft-knee threshold. */
export const BRIGHT_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tColor;
uniform vec2 uTexel;
uniform float uThreshold;
in vec2 vUv;
out vec4 outColor;
${COMMON}
void main() {
  vec3 c = toLin(texture(tColor, vUv + uTexel * vec2(-0.5, -0.5)).rgb);
  c += toLin(texture(tColor, vUv + uTexel * vec2(0.5, -0.5)).rgb);
  c += toLin(texture(tColor, vUv + uTexel * vec2(-0.5, 0.5)).rgb);
  c += toLin(texture(tColor, vUv + uTexel * vec2(0.5, 0.5)).rgb);
  c *= 0.25;
  float l = max(c.r, max(c.g, c.b));
  const float knee = 0.2;
  float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  outColor = vec4(c * (max(soft, l - uThreshold) / max(l, 1e-4)), 1.0);
}
`;

/** 9-tap Gaussian in 5 bilinear taps along `uDir` (texel step × spread). */
export const BLUR_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uDir;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec3 s = texture(tSrc, vUv).rgb * 0.2270270270;
  s += (texture(tSrc, vUv + uDir * 1.3846153846).rgb + texture(tSrc, vUv - uDir * 1.3846153846).rgb) * 0.3162162162;
  s += (texture(tSrc, vUv + uDir * 3.2307692308).rgb + texture(tSrc, vUv - uDir * 3.2307692308).rgb) * 0.0702702703;
  outColor = vec4(s, 1.0);
}
`;
