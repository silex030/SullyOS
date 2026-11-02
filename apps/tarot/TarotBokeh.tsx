import React, { useEffect, useRef } from 'react';

interface Orb {
  x: number;
  y: number;
  r: number;
  sprite: number;
  alpha: number;
}

const ORB_COLORS = ['232,201,106', '154,122,224', '111,192,168'];

const makeSprite = (rgb: string): HTMLCanvasElement => {
  const size = 128;
  const sprite = document.createElement('canvas');
  sprite.width = size;
  sprite.height = size;
  const ctx = sprite.getContext('2d');
  if (!ctx) return sprite;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, `rgba(${rgb},0.75)`);
  grad.addColorStop(0.45, `rgba(${rgb},0.5)`);
  grad.addColorStop(0.78, `rgba(${rgb},0.14)`);
  grad.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return sprite;
};

/** 静态前景柔光层，避免与主天穹产生独立的横向视差。 */
export const TarotBokeh: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const sprites = ORB_COLORS.map(makeSprite);
    let width = 0;
    let height = 0;
    let orbs: Orb[] = [];

    const resize = () => {
      const rect = canvas.parentElement?.getBoundingClientRect();
      width = Math.max(1, rect?.width ?? window.innerWidth);
      height = Math.max(1, rect?.height ?? window.innerHeight);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const count = width >= 700 ? 12 : 9;
      if (orbs.length !== count) {
        orbs = Array.from({ length: count }, () => ({
          x: Math.random(),
          y: 0.06 + Math.random() * 0.82,
          r: 40 + Math.random() * 90,
          sprite: Math.floor(Math.random() * sprites.length),
          alpha: 0.035 + Math.random() * 0.035,
        }));
      }

      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'lighter';
      orbs.forEach((orb) => {
        ctx.globalAlpha = orb.alpha;
        const x = orb.x * width;
        const y = orb.y * height;
        ctx.drawImage(sprites[orb.sprite], x - orb.r, y - orb.r, orb.r * 2, orb.r * 2);
      });
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    };

    resize();
    const observer = new ResizeObserver(resize);
    if (canvas.parentElement) observer.observe(canvas.parentElement);

    return () => observer.disconnect();
  }, []);

  return <canvas ref={canvasRef} aria-hidden className="pointer-events-none absolute inset-0 z-30 h-full w-full" />;
};
