// concentric rings that move outward; u_time in seconds, u_resolution in pixels, u_seed an integer
precision highp float;
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_seed;
void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
  float r = length(p);
  float v = 0.5 + 0.5 * sin(40.0 * r - 6.2832 * u_time + u_seed);
  gl_FragColor = vec4(v, v * 0.4, 1.0 - v, 1.0);
}
