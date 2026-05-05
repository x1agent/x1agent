import { useEffect, useRef } from "react";

/**
 * Volumetric nebula shader — ported 1:1 from the marketing site's
 * HeroCanvas.astro. Layered FBM noise + sparse hash-based starfield,
 * tinted with the four jewel-tone --blob-* tokens read live from the
 * document root, so dark/light theme switches re-tint without a
 * remount. Falls back silently if WebGL2 is unavailable; the parent
 * sidebar's CSS background then carries the look on its own.
 */

const VERT = /* glsl */ `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
out vec4 outColor;

uniform vec2  iResolution;
uniform float iTime;
uniform float uScroll;
uniform vec2  iMouse;
uniform vec3  uTintBlue;
uniform vec3  uTintPurple;
uniform vec3  uTintPeach;
uniform vec3  uTintPink;
uniform vec3  uHue;
uniform float uIntensity;
uniform float uIsDark;

float hash(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  return fract(sin(dot(p, p + 17.13)) * 43758.5453);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = rot * p * 2.0;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * iResolution.xy) / iResolution.y;
  vec2 uvNoise = vec2(uv.x, uv.y - 0.30);

  float t = iTime * 0.025;
  float scroll = uScroll * 0.06;
  vec2  mouse  = iMouse * 0.012;

  vec2 p1 = uvNoise * 1.4 + vec2(t * 0.30 + scroll * 0.45, t * 0.10) + mouse;
  vec2 p2 = uvNoise * 2.6 + vec2(-t * 0.18 + scroll * 0.85, t * 0.22) + mouse * 0.6;
  vec2 p3 = uvNoise * 4.5 + vec2(t * 0.42 + scroll * 1.30, -t * 0.30) + mouse * 0.3;

  float n1 = fbm(p1);
  float n2 = fbm(p2 + n1 * 0.30);
  float n3 = fbm(p3 + n2 * 0.18);

  float density = n1 * 0.55 + n2 * 0.30 + n3 * 0.15;
  density = pow(clamp(density, 0.0, 1.0), 1.35);

  float colorField = fbm(uvNoise * 0.9 + vec2(scroll * 0.2, 0.0));
  vec3 tint = mix(uTintBlue, uTintPurple, smoothstep(0.25, 0.55, colorField));
  tint      = mix(tint,      uTintPeach,  smoothstep(0.50, 0.75, colorField + n1 * 0.2));
  tint      = mix(tint,      uTintPink,   smoothstep(0.70, 0.95, n2));
  vec3 lavender = mix(vec3(0.85, 0.78, 0.95), vec3(0.95, 0.85, 0.92), step(0.5, uIsDark));
  tint          = mix(tint, lavender * 0.45, smoothstep(0.78, 0.97, n3) * 0.55);

  vec3 gas = tint * density * 2.6;

  vec2 starUv = uvNoise * 220.0 + vec2(scroll * 8.0, t * 0.5);
  vec2 starCell = floor(starUv);
  vec2 starF = fract(starUv) - 0.5;
  float starSeed = hash(starCell);
  float star = 0.0;
  if (starSeed > 0.985) {
    float dist = length(starF);
    star = smoothstep(0.10, 0.0, dist) * (starSeed - 0.985) * 60.0;
  }

  float hot = smoothstep(0.55, 1.0, density);
  vec3 col = gas + uHue * hot * 0.18;
  col += vec3(star) * 1.4;

  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(lum), col, 0.85);

  vec2 v = uv * vec2(0.9, 1.0);
  float edgeWeight = smoothstep(0.0, 0.85, length(v));
  float topFalloff = smoothstep(0.50, -0.10, uv.y);

  if (uIsDark > 0.5) {
    col *= uIntensity;
    col *= mix(0.25, 1.0, edgeWeight);
    col *= mix(0.10, 1.0, topFalloff);
    col = min(col, vec3(0.55));
    col += vec3(0.018, 0.014, 0.012);
  } else {
    vec3 cream = vec3(0.96, 0.94, 0.88);
    float blend = density * mix(0.55, 1.0, edgeWeight) * mix(0.40, 1.0, topFalloff) * uIntensity;
    blend = clamp(blend, 0.0, 0.85);
    col = mix(cream, tint, blend);
  }

  outColor = vec4(col, 1.0);
}
`;

type ThemeColors = {
  blue: [number, number, number];
  purple: [number, number, number];
  peach: [number, number, number];
  pink: [number, number, number];
  hue: [number, number, number];
  intensity: number;
  isDark: number;
};

function parseRgba(value: string): [number, number, number, number] | null {
  const m = value
    .trim()
    .match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\s*\)/);
  if (!m) return null;
  return [
    Number(m[1]) / 255,
    Number(m[2]) / 255,
    Number(m[3]) / 255,
    m[4] !== undefined ? Number(m[4]) : 1,
  ];
}
function parseHex(value: string): [number, number, number] | null {
  const m = value.trim().match(/^#([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function readTheme(): ThemeColors {
  const styles = getComputedStyle(document.documentElement);
  const blue = parseRgba(styles.getPropertyValue("--blob-blue")) ?? [0.49, 0.7, 0.9, 0.18];
  const purple = parseRgba(styles.getPropertyValue("--blob-purple")) ?? [0.71, 0.55, 0.86, 0.16];
  const peach = parseRgba(styles.getPropertyValue("--blob-peach")) ?? [0.86, 0.51, 0.39, 0.18];
  const pink = parseRgba(styles.getPropertyValue("--blob-pink")) ?? [0.86, 0.43, 0.63, 0.16];
  const hue = parseHex(styles.getPropertyValue("--color-hue").trim()) ?? [0.85, 0.46, 0.34];
  const isDark = document.documentElement.dataset.theme !== "light" ? 1 : 0;
  return {
    blue: [blue[0], blue[1], blue[2]],
    purple: [purple[0], purple[1], purple[2]],
    peach: [peach[0], peach[1], peach[2]],
    pink: [pink[0], pink[1], pink[2]],
    hue,
    intensity: isDark ? 1.0 : 1.35,
    isDark,
  };
}

export function RailCanvas() {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    const gl = canvas.getContext("webgl2", {
      premultipliedAlpha: false,
      antialias: false,
      alpha: false,
    });
    if (!gl) {
      wrap.dataset.shader = "off";
      return;
    }

    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.warn("rail shader compile", gl.getShaderInfoLog(sh));
        return null;
      }
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) {
      wrap.dataset.shader = "off";
      return;
    }

    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn("rail shader link", gl.getProgramInfoLog(prog));
      wrap.dataset.shader = "off";
      return;
    }

    const aPos = gl.getAttribLocation(prog, "a_pos");
    const uRes = gl.getUniformLocation(prog, "iResolution");
    const uTime = gl.getUniformLocation(prog, "iTime");
    const uScroll = gl.getUniformLocation(prog, "uScroll");
    const uMouse = gl.getUniformLocation(prog, "iMouse");
    const uBlue = gl.getUniformLocation(prog, "uTintBlue");
    const uPurple = gl.getUniformLocation(prog, "uTintPurple");
    const uPeach = gl.getUniformLocation(prog, "uTintPeach");
    const uPink = gl.getUniformLocation(prog, "uTintPink");
    const uHue = gl.getUniformLocation(prog, "uHue");
    const uIntensity = gl.getUniformLocation(prog, "uIntensity");
    const uIsDark = gl.getUniformLocation(prog, "uIsDark");

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    let theme = readTheme();
    let visible = true;
    let raf = 0;
    let cancelled = false;
    const start = performance.now();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let scrollY = window.scrollY || 0;
    const onScroll = () => {
      scrollY = window.scrollY || 0;
    };
    window.addEventListener("scroll", onScroll, { passive: true });

    let mouseTargetX = 0;
    let mouseTargetY = 0;
    let mouseX = 0;
    let mouseY = 0;
    const onMouseMove = (e: MouseEvent) => {
      const r = wrap.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      mouseTargetX = (x - 0.5) * 2;
      mouseTargetY = (y - 0.5) * 2;
    };
    if (!reduced) {
      window.addEventListener("mousemove", onMouseMove, { passive: true });
    }

    const dprCap = () => Math.min(1.0, window.devicePixelRatio || 1);

    function resize() {
      const r = canvas!.getBoundingClientRect();
      const dpr = dprCap();
      const w = Math.max(1, Math.floor(r.width * dpr));
      const h = Math.max(1, Math.floor(r.height * dpr));
      if (canvas!.width !== w || canvas!.height !== h) {
        canvas!.width = w;
        canvas!.height = h;
      }
    }

    function frame() {
      if (cancelled) return;
      if (visible) {
        const docH = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
        const progress = Math.max(0, Math.min(1, scrollY / docH));

        if (!reduced) {
          mouseX += (mouseTargetX - mouseX) * 0.05;
          mouseY += (mouseTargetY - mouseY) * 0.05;
        }

        resize();
        gl!.viewport(0, 0, canvas!.width, canvas!.height);
        if (theme.isDark) gl!.clearColor(0.024, 0.02, 0.016, 1.0);
        else gl!.clearColor(0.925, 0.898, 0.839, 1.0);
        gl!.clear(gl!.COLOR_BUFFER_BIT);
        gl!.useProgram(prog);
        gl!.uniform2f(uRes, canvas!.width, canvas!.height);
        gl!.uniform1f(uTime, reduced ? 0 : (performance.now() - start) / 1000);
        gl!.uniform1f(uScroll, progress * 4.5);
        gl!.uniform2f(uMouse, mouseX, mouseY);
        gl!.uniform3f(uBlue, theme.blue[0], theme.blue[1], theme.blue[2]);
        gl!.uniform3f(uPurple, theme.purple[0], theme.purple[1], theme.purple[2]);
        gl!.uniform3f(uPeach, theme.peach[0], theme.peach[1], theme.peach[2]);
        gl!.uniform3f(uPink, theme.pink[0], theme.pink[1], theme.pink[2]);
        gl!.uniform3f(uHue, theme.hue[0], theme.hue[1], theme.hue[2]);
        gl!.uniform1f(uIntensity, theme.intensity);
        gl!.uniform1f(uIsDark, theme.isDark);
        gl!.drawArrays(gl!.TRIANGLES, 0, 6);
      }
      raf = requestAnimationFrame(frame);
    }

    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          visible = e.isIntersecting;
        }),
      { threshold: 0 },
    );
    io.observe(wrap);

    const mo = new MutationObserver(() => {
      theme = readTheme();
    });
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    wrap.dataset.shader = "on";
    raf = requestAnimationFrame(frame);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("mousemove", onMouseMove);
      io.disconnect();
      mo.disconnect();
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buf);
    };
  }, []);

  return (
    <div
      ref={wrapRef}
      aria-hidden
      className="rail-canvas-wrap pointer-events-none absolute inset-0 z-0 overflow-hidden"
    >
      <canvas ref={canvasRef} className="rail-canvas absolute inset-0 h-full w-full" />
    </div>
  );
}
