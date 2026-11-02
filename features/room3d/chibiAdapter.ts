/**
 * room3d · chibiAdapter
 * 只读 adapter：尝试把当前已保存人物映射为 3D 场景里的 Q 版标记。
 * - 只读角色对象的 chibiStudio 三槽位 img（dataURL 兜底图），绝不写回。
 * - 读不到 / 非法时返回 { kind:'fallback2d' } 并给出 reason，
 *   调用方保留现有 2D 角色展示，不伪称完成上游全套 avatar。
 * - 优先级 vr > room > like520（vr 槽即“彼方 chibi”，与 3D 场景最贴）。
 */
export type ChibiMarker =
  | { kind: 'sprite'; img: string; slot: 'room' | 'vr' | 'like520' }
  | { kind: 'fallback2d'; reason: string };

const isUsableImage = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 32 && v.startsWith('data:image/');

export function resolveChibiMarker(charData: unknown): ChibiMarker {
  if (typeof charData !== 'object' || charData === null) {
    return { kind: 'fallback2d', reason: 'no-character-data' };
  }
  const studio = (charData as Record<string, unknown>)['chibiStudio'];
  if (typeof studio !== 'object' || studio === null) {
    return { kind: 'fallback2d', reason: 'no-chibi-studio' };
  }
  const slots = studio as Record<string, unknown>;
  for (const slot of ['vr', 'room', 'like520'] as const) {
    const entry = slots[slot];
    if (typeof entry !== 'object' || entry === null) continue;
    const img = (entry as Record<string, unknown>)['img'];
    if (isUsableImage(img)) return { kind: 'sprite', img, slot };
  }
  return { kind: 'fallback2d', reason: 'no-readable-chibi-image' };
}
