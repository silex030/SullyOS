/**
 * 容错的 JSON 解析。
 *
 * 为什么需要它：备份导出、localStorage 读取这类路径上，只要有一个键被写坏（用户手动改过、
 * 写到一半断电、老版本残留格式），裸 `JSON.parse` 就会抛错。导出路径上抛出 = 用户彻底无法
 * 备份，而且错误信息只说"导出失败"，根本定位不到是哪个键坏了。
 *
 * 与「静默吞掉」的区别：这里可以拿到失败原因（第二个可选回调），需要报警的地方照常报警；
 * 只是不再让一个坏键炸掉整条链路。
 */

/** 解析失败时不抛错，返回 fallback。 */
export function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    const parsed = JSON.parse(raw) as T;
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/** 需要知道「这个键坏了」时用这个；解析成功返回 `{ ok: true, value }`。 */
export function tryParseJson<T>(
  raw: string | null | undefined,
): { ok: true; value: T } | { ok: false; error: unknown } {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: false, error: new Error('empty input') };
  }
  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch (error) {
    return { ok: false, error };
  }
}
