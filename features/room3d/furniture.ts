/**
 * room3d · furniture
 * 自制家具目录：全部由基础几何体（box/cylinder/sphere/cone）拼装，
 * 无外部 GLB/图像依赖。组件侧把 parts 翻译成 three 网格。
 */
import {
  ROOM3D_BOUNDS,
  type FurnitureKind,
  type Room3DFurnitureItem,
  type Room3DItemPose,
} from './types';

export type PrimitiveShape = 'box' | 'cylinder' | 'sphere' | 'cone';

export interface PrimitivePart {
  shape: PrimitiveShape;
  /** [宽/半径, 高, 深]（cylinder/cone 取 [顶半径, 高, 底半径]）。 */
  size: [number, number, number];
  /** 相对家具原点的偏移（米）。 */
  offset: [number, number, number];
  color: string;
  /** 灯具等自发光部件。 */
  emissive?: boolean;
}

export interface FurnitureDef {
  kind: FurnitureKind;
  /** 中文展示名（自写文案，不复制上游）。 */
  label: string;
  /** 地面占位（米），用于出厂布局摆放。 */
  footprint: [number, number];
  parts: PrimitivePart[];
}

const WOOD = '#b98a5e';
const WOOD_DARK = '#8a5f3c';
const FABRIC = '#7fa6c9';
const FABRIC_DARK = '#5d84ab';
const METAL = '#9aa3ad';
const WARM = '#ffd9a0';
const LEAF = '#6fae7c';

export const FURNITURE_CATALOG: Record<FurnitureKind, FurnitureDef> = {
  table: {
    kind: 'table',
    label: '木桌',
    footprint: [1.6, 0.9],
    parts: [
      { shape: 'box', size: [1.6, 0.08, 0.9], offset: [0, 0.74, 0], color: WOOD },
      { shape: 'box', size: [0.08, 0.72, 0.08], offset: [-0.72, 0.36, -0.37], color: WOOD_DARK },
      { shape: 'box', size: [0.08, 0.72, 0.08], offset: [0.72, 0.36, -0.37], color: WOOD_DARK },
      { shape: 'box', size: [0.08, 0.72, 0.08], offset: [-0.72, 0.36, 0.37], color: WOOD_DARK },
      { shape: 'box', size: [0.08, 0.72, 0.08], offset: [0.72, 0.36, 0.37], color: WOOD_DARK },
    ],
  },
  chair: {
    kind: 'chair',
    label: '椅子',
    footprint: [0.55, 0.55],
    parts: [
      { shape: 'box', size: [0.5, 0.07, 0.5], offset: [0, 0.45, 0], color: FABRIC },
      { shape: 'box', size: [0.5, 0.55, 0.07], offset: [0, 0.75, -0.22], color: FABRIC_DARK },
      { shape: 'cylinder', size: [0.035, 0.45, 0.035], offset: [-0.2, 0.22, -0.2], color: METAL },
      { shape: 'cylinder', size: [0.035, 0.45, 0.035], offset: [0.2, 0.22, -0.2], color: METAL },
      { shape: 'cylinder', size: [0.035, 0.45, 0.035], offset: [-0.2, 0.22, 0.2], color: METAL },
      { shape: 'cylinder', size: [0.035, 0.45, 0.035], offset: [0.2, 0.22, 0.2], color: METAL },
    ],
  },
  bed: {
    kind: 'bed',
    label: '小床',
    footprint: [2.1, 1.2],
    parts: [
      { shape: 'box', size: [2.1, 0.25, 1.2], offset: [0, 0.32, 0], color: WOOD },
      { shape: 'box', size: [1.9, 0.18, 1.05], offset: [-0.05, 0.5, 0], color: '#e8e0d2' },
      { shape: 'box', size: [0.55, 0.14, 0.8], offset: [-0.7, 0.62, 0], color: '#f5f0e6' },
      { shape: 'box', size: [0.12, 0.8, 1.2], offset: [-1.0, 0.55, 0], color: WOOD_DARK },
      { shape: 'box', size: [0.12, 0.5, 1.2], offset: [1.0, 0.4, 0], color: WOOD_DARK },
    ],
  },
  lamp: {
    kind: 'lamp',
    label: '落地灯',
    footprint: [0.4, 0.4],
    parts: [
      { shape: 'cylinder', size: [0.16, 0.04, 0.16], offset: [0, 0.02, 0], color: METAL },
      { shape: 'cylinder', size: [0.03, 1.5, 0.03], offset: [0, 0.77, 0], color: METAL },
      { shape: 'cone', size: [0.28, 0.32, 0.28], offset: [0, 1.6, 0], color: WARM, emissive: true },
      { shape: 'sphere', size: [0.09, 0.09, 0.09], offset: [0, 1.5, 0], color: '#fff3d6', emissive: true },
    ],
  },
  shelf: {
    kind: 'shelf',
    label: '书架',
    footprint: [1.2, 0.4],
    parts: [
      { shape: 'box', size: [1.2, 0.06, 0.36], offset: [0, 0.35, 0], color: WOOD_DARK },
      { shape: 'box', size: [1.2, 0.06, 0.36], offset: [0, 0.75, 0], color: WOOD_DARK },
      { shape: 'box', size: [1.2, 0.06, 0.36], offset: [0, 1.15, 0], color: WOOD_DARK },
      { shape: 'box', size: [0.06, 1.2, 0.36], offset: [-0.57, 0.6, 0], color: WOOD },
      { shape: 'box', size: [0.06, 1.2, 0.36], offset: [0.57, 0.6, 0], color: WOOD },
      { shape: 'box', size: [0.18, 0.24, 0.22], offset: [-0.3, 0.5, 0], color: '#c96f5a' },
      { shape: 'box', size: [0.18, 0.24, 0.22], offset: [-0.05, 0.5, 0], color: LEAF },
      { shape: 'box', size: [0.18, 0.24, 0.22], offset: [0.25, 0.9, 0], color: FABRIC },
    ],
  },
  rug: {
    kind: 'rug',
    label: '圆毯',
    footprint: [2.0, 2.0],
    parts: [
      { shape: 'cylinder', size: [1.0, 0.03, 1.0], offset: [0, 0.015, 0], color: '#d9a7a0' },
      { shape: 'cylinder', size: [0.65, 0.035, 0.65], offset: [0, 0.018, 0], color: '#efe0d2' },
    ],
  },
};

let idSeq = 0;
/** 本地唯一 id（`f${Date.now().toString(36)}-${seq}`，不依赖外部 uuid）。 */
export function makeFurnitureId(): string {
  idSeq += 1;
  return `f${Date.now().toString(36)}-${idSeq}`;
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

/**
 * 新增家具落点（纯函数，与组件 addFurniture 共用同一算法）：
 * 5 列 x 8 行网格，40 件以内每个序号都有合法落点
 * （x ∈ ±2.4，z ∈ [2.4, -2.5]），不会制造无法保存的非法布局。
 */
export function spotPoseForIndex(idx: number): Room3DItemPose {
  const b = ROOM3D_BOUNDS;
  const clampN = (v: number, lo: number, hi: number): number =>
    Math.min(hi, Math.max(lo, v));
  return {
    x: clampN(((idx % 5) - 2) * 1.2, b.minX, b.maxX),
    y: 0,
    z: clampN(2.4 - Math.floor(idx / 5) * 0.7, b.minZ, b.maxZ),
    rotY: 0,
    scale: 1,
  };
}

/** 出厂布局：一桌两椅一床一灯，全部落在合法范围内。 */
export function createDefaultLayout(): Room3DFurnitureItem[] {
  const at = (
    kind: FurnitureKind,
    x: number,
    z: number,
    rotY = 0,
  ): Room3DFurnitureItem => ({
    id: makeFurnitureId(),
    kind,
    pose: { x, y: 0, z, rotY, scale: 1 },
  });
  return [
    at('table', 0.4, -0.6),
    at('chair', 0.4, 0.5, Math.PI),
    at('chair', 1.7, -0.6, -Math.PI / 2),
    at('bed', -2.6, -2.2, 0),
    at('lamp', 2.6, -2.6),
    at('shelf', -2.6, 1.8, 0),
    at('rug', 0.4, -0.2),
  ];
}

/** 平面移动（带房间钳制，y 不动——家具贴地）。 */
export function moveItemClamped(
  item: Room3DFurnitureItem,
  dx: number,
  dz: number,
): Room3DFurnitureItem {
  const b = ROOM3D_BOUNDS;
  return {
    ...item,
    pose: {
      ...item.pose,
      x: clamp(item.pose.x + dx, b.minX, b.maxX),
      z: clamp(item.pose.z + dz, b.minZ, b.maxZ),
    },
  };
}

/** 旋转固定步长（默认 45°），结果归一化到 [-PI, PI]。 */
export function rotateItem(
  item: Room3DFurnitureItem,
  step: number = Math.PI / 4,
): Room3DFurnitureItem {
  const twoPi = Math.PI * 2;
  let r = (item.pose.rotY + step) % twoPi;
  if (r > Math.PI) r -= twoPi;
  if (r < -Math.PI) r += twoPi;
  return { ...item, pose: { ...item.pose, rotY: r } };
}
