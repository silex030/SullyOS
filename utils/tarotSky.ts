export interface SkyPoint2D {
  x: number;
  y: number;
}

export interface SkyDirection {
  x: number;
  y: number;
  z: number;
}

export interface SkyPose {
  yaw: number;
  pitch: number;
  roll: number;
}

export interface ProjectedSkyPoint extends SkyPoint2D {
  depth: number;
}

export interface ConstellationDef {
  name: string;
  points: SkyPoint2D[];
  lines: [number, number][];
}

export interface SkyDomeItem {
  definition: ConstellationDef;
  anchor: SkyDirection;
  size: number;
  rotation: number;
  phase: number;
  rotationSpeed: number;
}

export const CONSTELLATIONS: ConstellationDef[] = [
  {
    name: '北斗七星',
    points: [{ x: -0.32, y: -0.12 }, { x: -0.13, y: -0.24 }, { x: 0.11, y: -0.20 }, { x: 0.20, y: 0.02 }, { x: 0.37, y: 0.12 }, { x: 0.51, y: 0.23 }, { x: 0.63, y: 0.34 }],
    lines: [[0, 1], [1, 2], [2, 3], [3, 0], [3, 4], [4, 5], [5, 6]],
  },
  {
    name: '仙后座',
    points: [{ x: -0.50, y: 0.10 }, { x: -0.27, y: -0.26 }, { x: -0.02, y: 0.13 }, { x: 0.24, y: -0.27 }, { x: 0.51, y: 0.12 }],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4]],
  },
  {
    name: '猎户座',
    points: [{ x: -0.38, y: -0.40 }, { x: 0.39, y: -0.37 }, { x: -0.25, y: -0.08 }, { x: 0, y: -0.02 }, { x: 0.24, y: 0.04 }, { x: 0.40, y: 0.38 }, { x: -0.42, y: 0.36 }],
    lines: [[0, 2], [1, 4], [2, 3], [3, 4], [2, 6], [4, 5]],
  },
  {
    name: '天鹅座',
    points: [{ x: -0.02, y: -0.56 }, { x: 0.03, y: 0.54 }, { x: -0.48, y: -0.05 }, { x: 0.46, y: 0.10 }, { x: 0.01, y: 0.02 }, { x: -0.24, y: -0.31 }],
    lines: [[0, 4], [4, 1], [2, 4], [4, 3], [0, 5]],
  },
  {
    name: '天琴座',
    points: [{ x: -0.37, y: -0.18 }, { x: -0.08, y: -0.29 }, { x: 0.25, y: -0.18 }, { x: 0.34, y: 0.15 }, { x: -0.12, y: 0.31 }],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4]],
  },
  {
    name: '天鹰座',
    points: [{ x: -0.49, y: -0.10 }, { x: -0.22, y: 0.08 }, { x: 0.02, y: -0.02 }, { x: 0.29, y: 0.11 }, { x: 0.52, y: -0.09 }],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4]],
  },
  {
    name: '天蝎座',
    points: [{ x: -0.43, y: -0.38 }, { x: -0.20, y: -0.19 }, { x: 0.03, y: -0.03 }, { x: 0.24, y: 0.12 }, { x: 0.44, y: 0.29 }, { x: 0.26, y: 0.44 }, { x: 0.02, y: 0.40 }, { x: -0.12, y: 0.20 }],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7]],
  },
  {
    name: '狮子座',
    points: [{ x: -0.48, y: -0.15 }, { x: -0.34, y: -0.39 }, { x: -0.08, y: -0.44 }, { x: 0.11, y: -0.26 }, { x: 0.03, y: -0.01 }, { x: 0.30, y: 0.12 }, { x: 0.12, y: 0.42 }],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0], [4, 5], [5, 6]],
  },
  {
    name: '金牛座',
    points: [{ x: -0.49, y: -0.14 }, { x: -0.23, y: 0.05 }, { x: 0.04, y: 0.20 }, { x: 0.30, y: 0.06 }, { x: 0.50, y: -0.19 }, { x: 0.19, y: -0.42 }],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [2, 5]],
  },
  {
    name: '双子座',
    points: [{ x: -0.36, y: -0.43 }, { x: -0.31, y: -0.13 }, { x: -0.22, y: 0.18 }, { x: -0.15, y: 0.46 }, { x: 0.18, y: -0.41 }, { x: 0.25, y: -0.09 }, { x: 0.34, y: 0.22 }],
    lines: [[0, 1], [1, 2], [2, 3], [0, 4], [4, 5], [5, 6]],
  },
  {
    name: '人马座',
    points: [{ x: -0.42, y: -0.22 }, { x: -0.15, y: -0.42 }, { x: 0.16, y: -0.35 }, { x: 0.43, y: -0.11 }, { x: 0.26, y: 0.20 }, { x: -0.07, y: 0.40 }, { x: -0.43, y: 0.20 }, { x: 0.01, y: -0.05 }],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 0], [1, 7], [7, 4]],
  },
  {
    name: '飞马座',
    points: [{ x: -0.42, y: -0.32 }, { x: 0.40, y: -0.38 }, { x: 0.44, y: 0.37 }, { x: -0.35, y: 0.34 }],
    lines: [[0, 1], [1, 2], [2, 3], [3, 0]],
  },
  {
    name: '仙女座',
    points: [{ x: -0.48, y: 0.33 }, { x: -0.23, y: 0.08 }, { x: 0.03, y: -0.17 }, { x: 0.29, y: -0.41 }, { x: 0.51, y: -0.20 }],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4]],
  },
  {
    name: '南十字座',
    points: [{ x: 0, y: -0.52 }, { x: 0, y: 0.48 }, { x: -0.40, y: -0.02 }, { x: 0.41, y: -0.02 }],
    lines: [[0, 1], [2, 3]],
  },
];

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const HORIZON_CLIP = 0.035;
const ZERO_POSE: SkyPose = { yaw: 0, pitch: 0, roll: 0 };
const NAVIGATION_YAW = [0.12, -0.14, 0.09, -0.11, 0.15, -0.07, 0.05, -0.13] as const;
const NAVIGATION_PITCH = [0.045, -0.052, 0.06, -0.03, 0.018, 0.055, -0.045, 0.025] as const;
const NAVIGATION_ROLL = [0.02, -0.03, 0.028, -0.018, 0.012, -0.025, 0.032, -0.01] as const;

const normalize = (direction: SkyDirection): SkyDirection => {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!Number.isFinite(length) || length < 1e-9) return { x: 0, y: 0, z: 1 };
  return { x: direction.x / length, y: direction.y / length, z: direction.z / length };
};

export const buildSkyDome = (): SkyDomeItem[] => {
  const count = CONSTELLATIONS.length;
  return CONSTELLATIONS.map((definition, index) => {
    const z = 0.10 + 0.88 * (index + 0.5) / count;
    const ring = Math.sqrt(1 - z * z);
    const azimuth = index * GOLDEN_ANGLE;
    return {
      definition,
      anchor: { x: ring * Math.cos(azimuth), y: ring * Math.sin(azimuth), z },
      size: 0.18 + (index % 4) * 0.018,
      rotation: index * 0.391,
      phase: index * 1.73,
      rotationSpeed: 0.02 + (index % 5) * 0.004,
    };
  });
};

export const rotateSkyDirection = (direction: SkyDirection, pose: SkyPose): SkyDirection => {
  const { x, y, z } = normalize(direction);
  const cy = Math.cos(pose.yaw);
  const sy = Math.sin(pose.yaw);
  const yawX = x * cy + z * sy;
  const yawZ = -x * sy + z * cy;
  const cp = Math.cos(pose.pitch);
  const sp = Math.sin(pose.pitch);
  const pitchY = y * cp - yawZ * sp;
  const pitchZ = y * sp + yawZ * cp;
  const cr = Math.cos(pose.roll);
  const sr = Math.sin(pose.roll);
  return normalize({
    x: yawX * cr - pitchY * sr,
    y: yawX * sr + pitchY * cr,
    z: pitchZ,
  });
};

export const constellationPointDirection = (
  anchor: SkyDirection,
  local: SkyPoint2D,
  angularSize: number,
  rotation: number,
): SkyDirection => {
  const center = normalize(anchor);
  const theta = Math.acos(Math.max(-1, Math.min(1, center.z)));
  const phi = Math.atan2(center.y, center.x);
  const east = { x: -Math.sin(phi), y: Math.cos(phi), z: 0 };
  const south = { x: Math.cos(theta) * Math.cos(phi), y: Math.cos(theta) * Math.sin(phi), z: -Math.sin(theta) };
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  const px = (local.x * c - local.y * s) * angularSize;
  const py = (local.x * s + local.y * c) * angularSize;
  const distance = Math.hypot(px, py);
  if (distance < 1e-9) return center;
  const tangent = normalize({
    x: east.x * px + south.x * py,
    y: east.y * px + south.y * py,
    z: east.z * px + south.z * py,
  });
  const cosine = Math.cos(distance);
  const sine = Math.sin(distance);
  return normalize({
    x: center.x * cosine + tangent.x * sine,
    y: center.y * cosine + tangent.y * sine,
    z: center.z * cosine + tangent.z * sine,
  });
};

export const projectHemispherePoint = (
  direction: SkyDirection,
  width: number,
  height: number,
  horizonClip = HORIZON_CLIP,
): ProjectedSkyPoint | null => {
  if (![width, height, direction.x, direction.y, direction.z].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  const unitDirection = normalize(direction);
  if (unitDirection.z <= horizonClip) return null;
  const theta = Math.acos(Math.max(-1, Math.min(1, unitDirection.z)));
  const halfDome = Math.PI / 2;
  const normalizedRadius = theta / halfDome;
  const radius = Math.min(width, height) * 0.47 * normalizedRadius * (1 + 0.10 * normalizedRadius * normalizedRadius);
  const planarLength = Math.hypot(unitDirection.x, unitDirection.y);
  const azimuthX = planarLength < 1e-9 ? 0 : unitDirection.x / planarLength;
  const azimuthY = planarLength < 1e-9 ? 0 : unitDirection.y / planarLength;
  const point = {
    x: width / 2 + azimuthX * radius,
    y: height * 0.44 - azimuthY * radius,
    depth: unitDirection.z,
  };
  return [point.x, point.y, point.depth].every(Number.isFinite) ? point : null;
};

const slerp = (from: SkyDirection, to: SkyDirection, t: number): SkyDirection => {
  const a = normalize(from);
  const b = normalize(to);
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
  const angle = Math.acos(dot);
  if (angle < 1e-6) return normalize({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
  if (Math.abs(Math.sin(angle)) < 1e-6) {
    const fallback = normalize({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
    return fallback;
  }
  const left = Math.sin((1 - t) * angle) / Math.sin(angle);
  const right = Math.sin(t * angle) / Math.sin(angle);
  return normalize({ x: a.x * left + b.x * right, y: a.y * left + b.y * right, z: a.z * left + b.z * right });
};

const clipSegment = (
  a: SkyPoint2D,
  b: SkyPoint2D,
  width: number,
  height: number,
): [SkyPoint2D, SkyPoint2D] | null => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x, width - a.x, a.y, height - a.y];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-12) {
      if (q[i] < 0) return null;
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return [
    { x: a.x + t0 * dx, y: a.y + t0 * dy },
    { x: a.x + t1 * dx, y: a.y + t1 * dy },
  ];
};

export const projectSkySegment = (
  from: SkyDirection,
  to: SkyDirection,
  width: number,
  height: number,
  pose: SkyPose,
  samples = 12,
): SkyPoint2D[][] => {
  const count = Math.max(2, Math.min(64, Math.floor(samples)));
  const points = Array.from({ length: count + 1 }, (_, index) => {
    const direction = rotateSkyDirection(slerp(from, to, index / count), pose);
    return projectHemispherePoint(direction, width, height);
  });
  const paths: SkyPoint2D[][] = [];
  for (let index = 0; index < count; index++) {
    const a = points[index];
    const b = points[index + 1];
    if (!a || !b) continue;
    const clipped = clipSegment(a, b, width, height);
    if (!clipped) continue;
    const previous = paths[paths.length - 1];
    const first = clipped[0];
    const last = clipped[1];
    if (previous && Math.hypot(previous[previous.length - 1].x - first.x, previous[previous.length - 1].y - first.y) < 0.1) {
      previous.push(last);
    } else {
      paths.push([first, last]);
    }
  }
  return paths;
};

export const resolveNavigationPose = (signal: number): SkyPose => {
  if (!Number.isFinite(signal) || Math.trunc(signal) === 0) return { ...ZERO_POSE };
  const index = ((Math.trunc(signal) - 1) % NAVIGATION_YAW.length + NAVIGATION_YAW.length) % NAVIGATION_YAW.length;
  return {
    yaw: NAVIGATION_YAW[index],
    pitch: NAVIGATION_PITCH[index],
    roll: NAVIGATION_ROLL[index],
  };
};

const shortestAngle = (delta: number): number => Math.atan2(Math.sin(delta), Math.cos(delta));

export const interpolateSkyPose = (current: SkyPose, target: SkyPose, dtSeconds: number, reducedMotion: boolean): SkyPose => {
  if (reducedMotion) return { ...target };
  const dt = Number.isFinite(dtSeconds) ? Math.max(0, Math.min(dtSeconds, 0.05)) : 0;
  const amount = 1 - Math.exp(-dt * 2.8);
  return {
    yaw: current.yaw + shortestAngle(target.yaw - current.yaw) * amount,
    pitch: current.pitch + shortestAngle(target.pitch - current.pitch) * amount,
    roll: current.roll + shortestAngle(target.roll - current.roll) * amount,
  };
};

export const continuousSkyPose = (elapsedSeconds: number, navigation: SkyPose, reducedMotion: boolean): SkyPose => {
  if (reducedMotion) return { ...navigation };
  const elapsed = Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0;
  return {
    yaw: navigation.yaw + elapsed * (Math.PI * 2 / 210),
    pitch: navigation.pitch + Math.sin(elapsed * 0.035) * 0.012,
    roll: navigation.roll + Math.sin(elapsed * 0.027) * 0.008,
  };
};

export const ZERO_SKY_POSE = ZERO_POSE;
