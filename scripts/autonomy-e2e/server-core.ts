/**
 * 联调 worker 的核心入口（被 esbuild 打成一个 ESM 包，由 server.mjs 动态 import）。
 *
 * 这里只做 re-export，保证联调用的是**仓库里的真实模块**（路由/D1 端口/引擎/预算），
 * 不是联调专用的复制品。
 */

export { handleAutonomyLifeRequest, resolveOwnerFromSharedToken } from '../../worker/amsg/src/autonomyLife/routes';
export {
  ensureAutonomyLifeSchema,
  createD1LifeStore,
  resetAutonomyLifeSchemaCacheForTesting,
} from '../../worker/amsg/src/autonomyLife/store';
export {
  createAutonomyLifeRuntime,
  defaultAccountBoundary,
  defaultCharacterBoundary,
} from '../../worker/amsg/src/autonomyLife/runtime';
export { handleAutonomyLifeScheduled } from '../../worker/amsg/src/autonomyLife/tick';
export { buildActionRow } from '../../utils/autonomyLife/engine';
export { reserveBudget, windowIdAt } from '../../utils/autonomyLife/budget';
export { mergeEffectiveBoundary, normalizeBoundary } from '../../utils/autonomyLife/boundary';
export { hashArgs } from '../../contracts/autonomyLife';
