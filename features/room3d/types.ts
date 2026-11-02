/**
 * room3d · types
 * 3D 小家园模块 schema（v1）。纯数据契约，不依赖 three / DOM，
 * 可在 Node 单测与生产组件之间共享。
 */

/** 模块 schema 版本。旧版/未知版本一律按损坏态拒绝，不做静默迁移。 */
export const ROOM3D_SCHEMA_VERSION = 1;

/** 单个家园最多家具数（上界，防止存档膨胀拖慢渲染与备份）。 */
export const ROOM3D_MAX_ITEMS = 40;

/** 房间半尺寸（米）：10m x 10m 地板，墙高 3.2m。 */
export const ROOM3D_BOUNDS = {
  minX: -5,
  maxX: 5,
  minY: 0,
  maxY: 3.2,
  minZ: -5,
  maxZ: 5,
  minScale: 0.2,
  maxScale: 3,
} as const;

export type FurnitureKind =
  | 'table'
  | 'chair'
  | 'bed'
  | 'lamp'
  | 'shelf'
  | 'rug';

export const FURNITURE_KINDS: readonly FurnitureKind[] = [
  'table',
  'chair',
  'bed',
  'lamp',
  'shelf',
  'rug',
];

export interface Room3DItemPose {
  x: number;
  y: number;
  z: number;
  /** 弧度，绕 Y 轴。入库前归一化到 [-PI, PI]。 */
  rotY: number;
  scale: number;
}

export interface Room3DFurnitureItem {
  id: string;
  kind: FurnitureKind;
  pose: Room3DItemPose;
  /** 可选贴色（#rrggbb），缺省用 catalog 默认色。 */
  color?: string;
}

export interface Room3DStateV1 {
  version: 1;
  charId: string;
  items: Room3DFurnitureItem[];
  updatedAt: number;
}

/** 同角色隔离的 localStorage key。 */
export function room3DStorageKey(charId: string): string {
  return `sully-home3d-${charId}`;
}

/** 模块备份信封（供整包备份导出/导入，见 storage.exportModule）。 */
export interface Room3DBackupEnvelope {
  module: 'room3d';
  version: 1;
  charId: string;
  state: Room3DStateV1;
}
