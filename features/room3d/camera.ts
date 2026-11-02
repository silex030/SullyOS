/**
 * room3d · camera
 * 自研轨道镜头纯数学：拖拽旋转 / 缩放 / 复位 + 上下界钳制。
 * 不依赖 three，可单测；组件侧把 OrbitState 翻译成相机位置。
 */
export interface OrbitState {
  /** 水平角（弧度）。 */
  theta: number;
  /** 极角（弧度，0=正上方）。 */
  phi: number;
  /** 到目标点距离（米）。 */
  radius: number;
}

export const ORBIT_LIMITS = {
  minPhi: 0.15,
  maxPhi: 1.35,
  minRadius: 4,
  maxRadius: 16,
} as const;

export const DEFAULT_ORBIT: OrbitState = {
  theta: 0.7,
  phi: 0.9,
  radius: 9,
};

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

/** 像素拖拽 → 角度（灵敏度 0.005 rad/px）。 */
export function applyDrag(
  s: OrbitState,
  dxPx: number,
  dyPx: number,
): OrbitState {
  return {
    theta: s.theta - dxPx * 0.005,
    phi: clamp(s.phi - dyPx * 0.005, ORBIT_LIMITS.minPhi, ORBIT_LIMITS.maxPhi),
    radius: s.radius,
  };
}

/** 缩放系数（>1 拉远），钳制在半径上下界。 */
export function applyZoom(s: OrbitState, factor: number): OrbitState {
  if (!Number.isFinite(factor) || factor <= 0) return s;
  return {
    ...s,
    radius: clamp(
      s.radius * factor,
      ORBIT_LIMITS.minRadius,
      ORBIT_LIMITS.maxRadius,
    ),
  };
}

export function resetOrbit(): OrbitState {
  return { ...DEFAULT_ORBIT };
}

/** reduced-motion 媒体查询（SSR/Node 下缺省 false，不抛错）。 */
export function prefersReducedMotion(): boolean {
  try {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
