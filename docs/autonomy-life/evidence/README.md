# 验证原始日志（本卡 t_984b3cfc 第三轮）

全部是**命令的原始 stdout**（不是手工汇总），跑在提交 `98e570dd` 的内容上；
后续提交只改文档。读取方式：`gunzip -c <file>.gz`。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| `vitest-full.log.gz`（652 KB 原始 / 92 KB 压缩） | `npx vitest run` | 623 文件 / 7577 用例通过，`EXIT:0` |
| `focused.log.gz` | `npx vitest run utils/autonomyLife worker/amsg/src/autonomyLife worker/amsg/src/autonomyFire.test.ts worker/amsg/src/autonomyFire.integration.test.ts components/autonomy-life` | 20 文件 / 317 用例通过，`EXIT:0` |
| `tsc-current.log.gz` / `tsc-baseline.log.gz` / `tsc-compare.txt` | `npx tsc --noEmit -p tsconfig.json`（当前 vs 基线 `f7f040c7`） | 两边各 56 条；归一化路径后逐行 diff 为空 |
| `build.log.gz` | `pnpm run build` | `EXIT:0`（worker bundle + vite built in 2m58s） |
| `e2e-run.log.gz` / `e2e-report.json.gz` / `e2e-http-requests.json.gz` | `AUTONOMY_E2E_EVIDENCE=... node scripts/autonomy-e2e/run.mjs` | 40/40 checks 通过，`EXIT:0` |
| `legacy-grep.log.gz` | 旧入口 / 旧频率 / 外部占位 / 新闸位置的精确 grep | 见文件内逐条结果 |

这些文件同时作为任务附件上传（`kanban_attachments`）；入库是为了让复审在任何时候都能
`git show` 到同一份字节，不受 scratch 清理影响。
