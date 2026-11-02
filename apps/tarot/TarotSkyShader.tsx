import React, { useEffect, useRef } from 'react';
import { continuousSkyPose, resolveNavigationPose } from '../../utils/tarotSky';

interface Props {
  navigationSignal?: number;
  onFallback?: () => void;
}

const VERT = `
attribute vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform float u_time;
uniform vec2 u_resolution;
uniform float u_offset;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm4(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.02 + vec2(11.3, 7.7);
    a *= 0.5;
  }
  return v;
}

float fbm3(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec2(5.2, 9.1);
    a *= 0.5;
  }
  return v;
}

vec3 auroraColor(float t) {
  vec3 violet = vec3(0.48, 0.36, 0.80);
  vec3 jade = vec3(0.30, 0.62, 0.55);
  vec3 gold = vec3(0.91, 0.79, 0.42);
  vec3 c = mix(violet, jade, smoothstep(0.0, 0.6, t));
  c = mix(c, gold, smoothstep(0.72, 1.0, t) * 0.8);
  return c;
}

float auroraBand(vec2 p, float time, float seed, float centerY, float width, float speed, float freq) {
  float wob = sin(p.x * 0.6 + time * 0.09 + seed * 2.0) * 0.06
            + (noise(vec2(p.x * 0.9 + time * 0.02 + seed * 5.0, seed * 7.0)) - 0.5) * 0.12;
  float y = p.y - centerY - wob - sin(p.x * 1.3 + time * 0.11 + seed) * 0.04;
  float wvar = 0.65 + 0.8 * noise(vec2(p.x * 1.3 - time * 0.015 + seed * 11.0, seed * 3.0));
  float w = width * wvar;
  float window = exp(-y * y / (w * w));
  float streak = fbm3(vec2(p.x * freq + time * speed + seed * 13.0, y * 0.9 - time * 0.03 + seed));
  streak = pow(max(streak, 0.0), 1.5);
  float fold = 0.5 + 0.5 * noise(vec2(p.x * 2.2 - time * 0.025 + seed * 3.0, seed));
  float pulse = 0.6 + 0.4 * sin(time * (0.045 + seed * 0.004) + p.x * 1.2 + seed * 3.1);
  return window * streak * fold * pulse;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
  float c = cos(u_offset);
  float s = sin(u_offset);
  p = mat2(c, -s, s, c) * p;
  vec2 pa = p;
  float t = u_time;

  vec3 col = mix(vec3(0.10, 0.075, 0.16), vec3(0.045, 0.035, 0.08), clamp(uv.y, 0.0, 1.0));
  float alpha = 0.55;

  float n1 = fbm4(p * 1.6 + vec2(t * 0.012, -t * 0.008));
  float n2 = fbm4(p * 2.7 + vec2(-t * 0.008, t * 0.01) + 4.7);
  col += vec3(0.42, 0.32, 0.78) * n1 * 0.20;
  col += vec3(0.25, 0.55, 0.48) * n2 * 0.10;
  alpha += n1 * 0.25;

  vec2 mp = vec2(p.x * 0.85 + p.y * 0.53, -p.x * 0.53 + p.y * 0.85);
  float milky = fbm4(mp * vec2(1.0, 3.0) + vec2(t * 0.004, 0.0));
  float band = exp(-mp.y * mp.y * 26.0);
  float haze = band * smoothstep(0.35, 0.95, milky);
  col += vec3(0.72, 0.70, 0.85) * haze * 0.10;
  alpha += haze * 0.12;

  float a1 = auroraBand(pa, t, 0.0, 0.42, 0.16, 0.06, 4.5);
  float a2 = auroraBand(pa, t, 3.7, 0.23, 0.17, -0.045, 5.5);
  float a3 = auroraBand(pa, t, 8.3, 0.02, 0.18, 0.05, 6.5);
  float a4 = auroraBand(pa, t, 12.1, -0.2, 0.17, -0.06, 5.0);
  float a5 = auroraBand(pa, t, 17.9, -0.4, 0.16, 0.04, 7.0);
  float aSum = a1 * 0.9 + a2 * 0.85 + a3 + a4 * 0.75 + a5 * 0.55;
  vec3 auroraCol = auroraColor(uv.x + sin(t * 0.05) * 0.1) * a1
                 + auroraColor(0.35 + uv.x * 0.5) * a2
                 + auroraColor(0.75 - uv.x * 0.45 + sin(t * 0.07)) * a3
                 + auroraColor(0.25 + uv.x * 0.65 + sin(t * 0.04)) * a4
                 + auroraColor(0.9 - uv.x * 0.3 + sin(t * 0.06)) * a5;
  col += auroraCol * 0.55;
  alpha += aSum * 0.7;

  float a = clamp(alpha, 0.0, 1.0);
  gl_FragColor = vec4(col * a, a);
}
`;

const compile = (gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null => {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
};

/** WebGL 深空层：星云云团 + 极光幕帘 + 银河雾，60fps 封顶，失败/降档到底时回调 onFallback。 */
export const TarotSkyShader: React.FC<Props> = ({ navigationSignal = 0, onFallback }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const navigationRef = useRef(navigationSignal);
  const fallbackRef = useRef(onFallback);

  useEffect(() => { navigationRef.current = navigationSignal; }, [navigationSignal]);
  useEffect(() => { fallbackRef.current = onFallback; }, [onFallback]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    if (!gl) {
      fallbackRef.current?.();
      return;
    }

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const program = gl.createProgram();
    if (!vs || !fs || !program) {
      fallbackRef.current?.();
      return;
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      fallbackRef.current?.();
      return;
    }
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const uTime = gl.getUniformLocation(program, 'u_time');
    const uRes = gl.getUniformLocation(program, 'u_resolution');
    const uOffset = gl.getUniformLocation(program, 'u_offset');

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.clearColor(0, 0, 0, 0);

    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reduce = motionQuery.matches;
    let cssW = 0;
    let cssH = 1;
    let running = false;
    let raf = 0;
    let lastDraw = 0;
    let elapsed = 0;
    let skyRotation = 0;
    let quality = 1.0;
    let ema = 16.7;
    let warmup = 60;
    let sampled = 0;

    const draw = () => {
      gl.uniform1f(uTime, elapsed);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uOffset, skyRotation);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const resize = () => {
      const rect = canvas.parentElement?.getBoundingClientRect();
      cssW = Math.max(1, rect?.width ?? window.innerWidth);
      cssH = Math.max(1, rect?.height ?? window.innerHeight);
      const scale = Math.min(window.devicePixelRatio || 1, 2) * quality;
      canvas.width = Math.max(1, Math.round(cssW * scale));
      canvas.height = Math.max(1, Math.round(cssH * scale));
      gl.viewport(0, 0, canvas.width, canvas.height);
      if (reduce) {
        elapsed = 8;
        skyRotation = resolveNavigationPose(navigationRef.current).yaw;
        draw();
      }
    };

    const frame = (now: number) => {
      if (!running) return;
      if (now - lastDraw < 16) {
        raf = requestAnimationFrame(frame);
        return;
      }
      const dtMs = now - lastDraw;
      lastDraw = now;
      const dt = Math.min(dtMs / 1000, 0.05);
      elapsed += dt;
      const targetRotation = continuousSkyPose(elapsed, resolveNavigationPose(navigationRef.current), false).yaw;
      skyRotation += (targetRotation - skyRotation) * Math.min(1, dt * 2.5);
      draw();

      if (warmup > 0) {
        warmup -= 1;
      } else {
        ema = ema * 0.9 + dtMs * 0.1;
        sampled += 1;
        if (sampled >= 180) {
          sampled = 0;
          if (ema > 20 && quality > 0.55) {
            quality -= 0.15;
            resize();
            warmup = 60;
          } else if (ema > 26 && quality <= 0.55) {
            fallbackRef.current?.();
            return;
          }
        }
      }
      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      if (reduce || running || document.hidden) return;
      running = true;
      lastDraw = performance.now();
      raf = requestAnimationFrame(frame);
    };

    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };

    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    const onMotionChange = (event: MediaQueryListEvent) => {
      reduce = event.matches;
      if (reduce) {
        stop();
        elapsed = 8;
        skyRotation = resolveNavigationPose(navigationRef.current).yaw;
        draw();
      } else {
        lastDraw = performance.now();
        start();
      }
    };

    const onContextLost = (event: Event) => {
      event.preventDefault();
      stop();
      fallbackRef.current?.();
    };

    resize();
    const observer = new ResizeObserver(resize);
    if (canvas.parentElement) observer.observe(canvas.parentElement);
    document.addEventListener('visibilitychange', onVisibility);
    canvas.addEventListener('webglcontextlost', onContextLost);
    motionQuery.addEventListener('change', onMotionChange);
    start();

    return () => {
      stop();
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      motionQuery.removeEventListener('change', onMotionChange);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" />;
};
