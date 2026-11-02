import React, { useEffect, useRef } from 'react';
import {
  buildSkyDome,
  constellationPointDirection,
  continuousSkyPose,
  interpolateSkyPose,
  projectHemispherePoint,
  projectSkySegment,
  resolveNavigationPose,
  rotateSkyDirection,
  ZERO_SKY_POSE,
  type SkyDirection,
  type SkyPose,
} from '../../utils/tarotSky';

interface Props {
  navigationSignal?: number;
}

interface Star {
  direction: SkyDirection;
  radius: number;
  phase: number;
  twinkleSpeed: number;
  alpha: number;
  gold: boolean;
  layer: 0 | 1 | 2;
}

interface GalaxyDust {
  direction: SkyDirection;
  radius: number;
  alpha: number;
  tone: 0 | 1 | 2;
}

interface Meteor {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  ttl: number;
}

interface Sprites {
  glowWhite: HTMLCanvasElement;
  crossGold: HTMLCanvasElement;
  crossWhite: HTMLCanvasElement;
}

const makeSprites = (): Sprites => {
  const glowWhite = document.createElement('canvas');
  glowWhite.width = 64;
  glowWhite.height = 64;
  const glow = glowWhite.getContext('2d');
  if (glow) {
    const gradient = glow.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, 'rgba(255,248,226,0.9)');
    gradient.addColorStop(0.35, 'rgba(255,248,226,0.45)');
    gradient.addColorStop(1, 'rgba(255,248,226,0)');
    glow.fillStyle = gradient;
    glow.fillRect(0, 0, 64, 64);
  }
  const makeCross = (rgb: string) => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext('2d');
    if (context) {
      context.translate(32, 32);
      context.lineWidth = 1.2;
      for (let index = 0; index < 2; index++) {
        const gradient = context.createLinearGradient(-32, 0, 32, 0);
        gradient.addColorStop(0, `rgba(${rgb},0)`);
        gradient.addColorStop(0.5, `rgba(${rgb},0.9)`);
        gradient.addColorStop(1, `rgba(${rgb},0)`);
        context.strokeStyle = gradient;
        context.beginPath();
        context.moveTo(-28, 0);
        context.lineTo(28, 0);
        context.stroke();
        context.rotate(Math.PI / 2);
      }
    }
    return canvas;
  };
  return { glowWhite, crossGold: makeCross('232,201,106'), crossWhite: makeCross('255,248,226') };
};

const normalize = (direction: SkyDirection): SkyDirection => {
  const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
  return { x: direction.x / length, y: direction.y / length, z: direction.z / length };
};

const makeGalaxy = (count: number): GalaxyDust[] => {
  const center = normalize({ x: 0.24, y: -0.18, z: 0.95 });
  const east = normalize({ x: -center.y, y: center.x, z: 0 });
  const north = normalize({
    x: center.y * east.z - center.z * east.y,
    y: center.z * east.x - center.x * east.z,
    z: center.x * east.y - center.y * east.x,
  });
  return Array.from({ length: count }, () => {
    const along = (Math.random() - 0.5) * 2.25;
    const across = (Math.random() - 0.5) * 0.24;
    return {
      direction: normalize({
        x: center.x + east.x * along + north.x * across,
        y: center.y + east.y * along + north.y * across,
        z: center.z + east.z * along + north.z * across,
      }),
      radius: 0.35 + Math.random() * 0.8,
      alpha: 0.035 + Math.random() * 0.09,
      tone: Math.floor(Math.random() * 3) as 0 | 1 | 2,
    };
  });
};

const makeStars = (count: number): Star[] => Array.from({ length: count }, (_, index) => {
  const layer: 0 | 1 | 2 = index < count * 0.48 ? 0 : index < count * 0.82 ? 1 : 2;
  const theta = Math.acos(0.035 + Math.random() * 0.965);
  const azimuth = Math.random() * Math.PI * 2;
  const layerScale = [0.6, 0.95, 1.35][layer];
  return {
    direction: { x: Math.sin(theta) * Math.cos(azimuth), y: Math.sin(theta) * Math.sin(azimuth), z: Math.cos(theta) },
    radius: (0.45 + Math.random() * 0.85) * layerScale,
    phase: Math.random() * Math.PI * 2,
    twinkleSpeed: 0.35 + Math.random() * 0.75,
    alpha: [0.13, 0.24, 0.38][layer] * (0.65 + Math.random() * 0.55),
    gold: Math.random() < 0.72,
    layer,
  };
});

export const TarotDomeCanvas: React.FC<Props> = ({ navigationSignal = 0 }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const navigationRef = useRef(navigationSignal);
  const drawStaticRef = useRef<() => void>(() => {});

  useEffect(() => {
    navigationRef.current = navigationSignal;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) drawStaticRef.current();
  }, [navigationSignal]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reducedMotion = motionQuery.matches;
    let width = 1;
    let height = 1;
    let dpr = Math.min(window.devicePixelRatio || 1, 1.6);
    let stars: Star[] = [];
    let galaxy: GalaxyDust[] = [];
    let dome = buildSkyDome();
    let meteor: Meteor | null = null;
    let nextMeteor = 12 + Math.random() * 12;
    let elapsed = 0;
    let pose: SkyPose = { ...ZERO_SKY_POSE };
    let raf = 0;
    let lastDraw = 0;
    let running = false;
    const sprites = makeSprites();

    const drawSprite = (sprite: HTMLCanvasElement, x: number, y: number, radius: number, alpha: number) => {
      context.globalAlpha = Math.max(0, Math.min(1, alpha));
      context.drawImage(sprite, x - radius, y - radius, radius * 2, radius * 2);
      context.globalAlpha = 1;
    };

    const drawSky = (skyPose: SkyPose, time: number, animate = true) => {
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.globalCompositeOperation = 'lighter';

      galaxy.forEach((dust) => {
        const point = projectHemispherePoint(rotateSkyDirection(dust.direction, skyPose), width, height);
        if (!point) return;
        const depth = 0.35 + point.depth * 0.65;
        const colors = ['232,201,106', '190,180,235', '255,248,226'];
        context.beginPath();
        context.arc(point.x, point.y, dust.radius, 0, Math.PI * 2);
        context.fillStyle = `rgba(${colors[dust.tone]},${dust.alpha * depth})`;
        context.fill();
      });

      stars.forEach((star) => {
        const point = projectHemispherePoint(rotateSkyDirection(star.direction, skyPose), width, height);
        if (!point) return;
        const twinkle = animate ? 0.63 + 0.37 * Math.sin(time * star.twinkleSpeed + star.phase) : 0.9;
        const depth = 0.42 + point.depth * 0.58;
        const radius = star.radius * (0.78 + point.depth * 0.34);
        const alpha = star.alpha * twinkle * depth;
        context.beginPath();
        context.arc(point.x, point.y, radius, 0, Math.PI * 2);
        context.fillStyle = star.gold ? `rgba(232,201,106,${alpha})` : `rgba(255,248,226,${alpha * 0.82})`;
        context.fill();
        if (star.layer === 2 && twinkle > 0.88) {
          drawSprite(star.gold ? sprites.crossGold : sprites.crossWhite, point.x, point.y, radius * 3.2, alpha * 0.52);
        }
      });

      dome.forEach((item) => {
        const localRotation = item.rotation + (animate ? Math.sin(time * item.rotationSpeed + item.phase) * 0.025 : 0);
        const directions = item.definition.points.map((point) => constellationPointDirection(item.anchor, point, item.size, localRotation));
        const anchorPoint = projectHemispherePoint(rotateSkyDirection(item.anchor, skyPose), width, height);
        const alpha = anchorPoint ? 0.52 + anchorPoint.depth * 0.32 : 0.3;
        item.definition.lines.forEach(([fromIndex, toIndex]) => {
          const paths = projectSkySegment(directions[fromIndex], directions[toIndex], width, height, skyPose, 18);
          paths.forEach((path) => {
            if (path.length < 2) return;
            context.beginPath();
            context.moveTo(path[0].x, path[0].y);
            for (let index = 1; index < path.length; index++) context.lineTo(path[index].x, path[index].y);
            context.strokeStyle = `rgba(172,148,220,${0.075 * alpha})`;
            context.lineWidth = 2;
            context.stroke();
            context.strokeStyle = `rgba(232,201,106,${0.22 * alpha})`;
            context.lineWidth = 0.8;
            context.stroke();
          });
        });
        directions.forEach((direction, index) => {
          const point = projectHemispherePoint(rotateSkyDirection(direction, skyPose), width, height);
          if (!point) return;
          const pulse = animate ? 0.7 + 0.3 * Math.sin(time * 0.7 + item.phase + index * 1.4) : 0.92;
          const radius = (index === 0 ? 1.85 : 1.25) * (0.68 + point.depth * 0.34);
          drawSprite(sprites.glowWhite, point.x, point.y, radius * 3.5, 0.14 * alpha * pulse);
          context.beginPath();
          context.arc(point.x, point.y, radius, 0, Math.PI * 2);
          context.fillStyle = `rgba(255,248,226,${0.52 * alpha * pulse})`;
          context.fill();
        });
        if (anchorPoint && Math.hypot(anchorPoint.x - width / 2, anchorPoint.y - height * 0.44) < Math.min(width, height) * 0.56) {
          context.font = '10px serif';
          context.textAlign = 'center';
          context.fillStyle = `rgba(232,201,106,${0.14 * alpha})`;
          context.fillText(item.definition.name, anchorPoint.x, anchorPoint.y + 14);
        }
      });

      if (meteor && animate) {
        const progress = Math.min(1, meteor.life / meteor.ttl);
        const envelope = Math.sin(Math.PI * progress);
        const tailX = meteor.x - meteor.vx * 0.25;
        const tailY = meteor.y - meteor.vy * 0.25;
        const gradient = context.createLinearGradient(meteor.x, meteor.y, tailX, tailY);
        gradient.addColorStop(0, `rgba(255,244,214,${0.42 * envelope})`);
        gradient.addColorStop(0.45, `rgba(232,201,106,${0.24 * envelope})`);
        gradient.addColorStop(1, 'rgba(232,201,106,0)');
        context.strokeStyle = gradient;
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(meteor.x, meteor.y);
        context.lineTo(tailX, tailY);
        context.stroke();
      }
      context.globalCompositeOperation = 'source-over';
    };

    const drawStatic = () => {
      pose = resolveNavigationPose(navigationRef.current);
      drawSky(pose, 0, false);
    };
    drawStaticRef.current = drawStatic;

    const resize = () => {
      const rect = canvas.parentElement?.getBoundingClientRect();
      width = Math.max(1, rect?.width ?? window.innerWidth);
      height = Math.max(1, rect?.height ?? window.innerHeight);
      dpr = Math.min(window.devicePixelRatio || 1, 1.6);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      stars = makeStars(width >= 700 ? 180 : 125);
      galaxy = makeGalaxy(width >= 700 ? 420 : 300);
      dome = buildSkyDome();
      meteor = null;
      if (reducedMotion) drawStatic();
    };

    const frame = (now: number) => {
      if (!running) return;
      if (now - lastDraw < 16) {
        raf = requestAnimationFrame(frame);
        return;
      }
      const dt = Math.min(Math.max(0, (now - lastDraw) / 1000), 0.05);
      lastDraw = now;
      elapsed += dt;
      pose = interpolateSkyPose(pose, resolveNavigationPose(navigationRef.current), dt, false);
      if (meteor) {
        meteor.life += dt;
        meteor.x += meteor.vx * dt;
        meteor.y += meteor.vy * dt;
        if (meteor.life >= meteor.ttl) meteor = null;
      }
      nextMeteor -= dt;
      if (!meteor && nextMeteor <= 0) {
        const speed = 190 + Math.random() * 80;
        const angle = (28 + Math.random() * 18) * Math.PI / 180;
        meteor = {
          x: width * (0.15 + Math.random() * 0.5),
          y: height * (0.08 + Math.random() * 0.22),
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 0,
          ttl: 0.85 + Math.random() * 0.35,
        };
        nextMeteor = 14 + Math.random() * 14;
      }
      drawSky(continuousSkyPose(elapsed, pose, false), elapsed);
      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      if (reducedMotion || running || document.hidden) return;
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
      reducedMotion = event.matches;
      if (reducedMotion) {
        stop();
        drawStatic();
      } else {
        lastDraw = performance.now();
        start();
      }
    };

    const observer = new ResizeObserver(resize);
    if (canvas.parentElement) observer.observe(canvas.parentElement);
    document.addEventListener('visibilitychange', onVisibility);
    motionQuery.addEventListener('change', onMotionChange);
    resize();
    if (reducedMotion) drawStatic();
    else start();

    return () => {
      stop();
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      motionQuery.removeEventListener('change', onMotionChange);
      drawStaticRef.current = () => {};
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden className="pointer-events-none absolute inset-0" />;
};
