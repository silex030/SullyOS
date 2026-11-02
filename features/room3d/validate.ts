/**
 * room3d · validate
 * 存档校验：schema 版本 / 数量上界 / 坐标与缩放范围 / 非法 JSON。
 * 原则：任何可疑输入一律整体拒绝（ok:false, state:null），
 * 调用方（storage）据此做到“损坏旧态不覆盖好存档”。
 */
import {
  FURNITURE_KINDS,
  ROOM3D_BOUNDS,
  ROOM3D_MAX_ITEMS,
  ROOM3D_SCHEMA_VERSION,
  type Room3DFurnitureItem,
  type Room3DItemPose,
  type Room3DStateV1,
} from './types';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  state: Room3DStateV1 | null;
}

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** rotY 归一化到 [-PI, PI]。 */
export function normalizeRotY(rotY: number): number {
  const twoPi = Math.PI * 2;
  let r = rotY % twoPi;
  if (r > Math.PI) r -= twoPi;
  if (r < -Math.PI) r += twoPi;
  return r;
}

function validatePose(
  pose: unknown,
  index: number,
  errors: string[],
): Room3DItemPose | null {
  if (!isRecord(pose)) {
    errors.push(`items[${index}].pose 不是对象`);
    return null;
  }
  const { x, y, z, rotY, scale } = pose;
  if (
    !isFiniteNumber(x) ||
    !isFiniteNumber(y) ||
    !isFiniteNumber(z) ||
    !isFiniteNumber(rotY) ||
    !isFiniteNumber(scale)
  ) {
    errors.push(`items[${index}].pose 含非有限数值`);
    return null;
  }
  const b = ROOM3D_BOUNDS;
  if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) {
    errors.push(`items[${index}] 坐标超出房间范围`);
    return null;
  }
  if (y < b.minY || y > b.maxY) {
    errors.push(`items[${index}] 高度超出范围`);
    return null;
  }
  if (scale < b.minScale || scale > b.maxScale) {
    errors.push(`items[${index}] 缩放超出范围`);
    return null;
  }
  return { x, y, z, rotY: normalizeRotY(rotY), scale };
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * 严格校验未知输入。expectedCharId 传入时要求 charId 一致
 *（防止把 A 角色的备份导入 B 角色槽位）。
 */
export function validateRoomState(
  input: unknown,
  expectedCharId?: string,
): ValidationResult {
  const fail = (msg: string): ValidationResult => ({
    ok: false,
    errors: [msg],
    state: null,
  });
  if (!isRecord(input)) return fail('存档不是对象');
  if (input['version'] !== ROOM3D_SCHEMA_VERSION) {
    return fail(
      `不支持的 schema 版本: ${String(input['version'])}（期望 v${ROOM3D_SCHEMA_VERSION}）`,
    );
  }
  if (
    typeof input['charId'] !== 'string' ||
    input['charId'].length === 0
  ) {
    return fail('charId 缺失或非法');
  }
  if (expectedCharId !== undefined && input['charId'] !== expectedCharId) {
    return fail('charId 与目标槽位不一致');
  }
  if (!Array.isArray(input['items'])) return fail('items 不是数组');
  if (input['items'].length > ROOM3D_MAX_ITEMS) {
    return fail(`物体数量超限: ${input['items'].length} > ${ROOM3D_MAX_ITEMS}`);
  }
  if (!isFiniteNumber(input['updatedAt'])) return fail('updatedAt 非法');

  const errors: string[] = [];
  const items: Room3DFurnitureItem[] = [];
  const seenIds = new Set<string>();
  input['items'].forEach((raw: unknown, index: number) => {
    if (!isRecord(raw)) {
      errors.push(`items[${index}] 不是对象`);
      return;
    }
    if (typeof raw['id'] !== 'string' || raw['id'].length === 0) {
      errors.push(`items[${index}].id 非法`);
      return;
    }
    if (seenIds.has(raw['id'])) {
      errors.push(`items[${index}].id 重复: ${raw['id']}`);
      return;
    }
    seenIds.add(raw['id']);
    if (
      typeof raw['kind'] !== 'string' ||
      !(FURNITURE_KINDS as readonly string[]).includes(raw['kind'])
    ) {
      errors.push(`items[${index}].kind 未知: ${String(raw['kind'])}`);
      return;
    }
    const pose = validatePose(raw['pose'], index, errors);
    if (!pose) return;
    let color: string | undefined;
    if (raw['color'] !== undefined) {
      if (typeof raw['color'] !== 'string' || !COLOR_RE.test(raw['color'])) {
        errors.push(`items[${index}].color 非法`);
        return;
      }
      color = raw['color'];
    }
    items.push({
      id: raw['id'],
      kind: raw['kind'] as Room3DFurnitureItem['kind'],
      pose,
      ...(color ? { color } : {}),
    });
  });

  if (errors.length > 0) return { ok: false, errors, state: null };
  return {
    ok: true,
    errors: [],
    state: {
      version: 1,
      charId: input['charId'] as string,
      items,
      updatedAt: input['updatedAt'] as number,
    },
  };
}
