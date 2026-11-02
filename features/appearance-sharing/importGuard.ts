/**
 * 备份导入纯预检（t_40feeeaa round3，协调授权 appearance-final-repair-scope.md）。
 *
 * DB.importFullData（utils/db.ts）与 OSContext 恢复链（context/OSContext.tsx）
 * 共用同一函数：备份 characters 中出现 present-but-illegal 的 dateReadingStyle
 * 即整包拒绝（中文错误），且调用必须发生在任何 clear/put/资产恢复之前。
 *
 * 纯逻辑：只依赖包校验 API，不引 DB/React/IO；仅「字段缺席」的旧包与空数组照常通过，
 * 显式 null/undefined 与其他非法值一律视为 present-but-illegal，不改 schema，不碰通用 clearAndAdd。
 */
import { coerceStoredReadingStyle } from './integration';

export interface IllegalDateReadingStyleHit {
  index: number;
  id: unknown;
}

/** 返回首个非法条目；无非法返回 null（仅字段缺席/空数组视为旧包兼容，不拒绝）。 */
export function findIllegalDateReadingStyle(data: unknown): IllegalDateReadingStyleHit | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const characters = (data as { characters?: unknown }).characters;
  if (characters === undefined) return null;
  if (!Array.isArray(characters)) return null;
  for (let index = 0; index < characters.length; index += 1) {
    const entry = characters[index];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (!Object.prototype.hasOwnProperty.call(entry, 'dateReadingStyle')) continue;
    // 字段存在即按 present-but-illegal 判定：显式 null/undefined 走真实校验必为非法，
    // 不得当缺席跳过；只有字段缺席才是旧包兼容。
    const value = (entry as { dateReadingStyle?: unknown }).dateReadingStyle;
    if (coerceStoredReadingStyle(value, 'date-reading') === undefined) {
      return { index, id: (entry as { id?: unknown }).id };
    }
  }
  return null;
}

/** 非法即抛中文错；合法/缺席静默通过。调用方在 catch 后不得写库。 */
export function assertNoIllegalDateReadingStyle(data: unknown): void {
  if (findIllegalDateReadingStyle(data) !== null) {
    throw new Error('备份中的约会阅读样式无效，已中止导入以保护现有角色数据。');
  }
}
