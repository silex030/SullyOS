# Nano-TTS 适配切换参考设计

日期：2026-09-28｜状态：待审｜**本文件只写设计，未授权改任何业务代码**

## 1. 背景（已验证事实，不重查）

- Genie 已删（VPS 服务停+目录删+service 文件删；回滚靠 git 重下，service 备份在 `/root/genie-tts.service.bak`）。
- Nano ONNX 服务常驻 `127.0.0.1:18083`（systemd `moss-tts`，CPU 4 线程，`--max-new-frames 200`，稳态 RSS 约 4GB）。
- 线上音色锁定 long2 链：`seed 7` + 默认温度 + 参考音频（emo-happy+emo-calm 同音拼接）。
- Nano 行为实测：零 500（嗯问题被换引擎直接治好）；`行` 语境偏长（5–6 字播 12–14 秒）；`另起一行` 看 seed 抽风（默认 30 秒循环，seed 7 正常）；torchaudio 原生加载段错误，已用 soundfile 补丁绕过（`sitecustomize.py`，动 Nano 第三方代码零行）。
- App 端语音当前是暗的：main-agent 还在往已不存在的 9882 转。

## 2. 合同（VPS 已验证）

- 请求：`POST 127.0.0.1:18083/api/generate`，multipart（`text*`、`demo_id`、`seed`、`max_new_frames`）， servedemo  голос走服务端 demo 条目。
- 发音人：demo-30（`assets/demo.jsonl` 追加：role=`prompt-voices/emo-calm.wav`，text=其已知转写 `今天过得怎么样，想不想听我讲讲今天遇到的事？`）。
- 响应：`200 + {"audio_base64": "<wav base64>", "text_chunks": [...]}`；失败只有 HTTP status，无错误码体。
- 时长守卫（适配层执行）：解码后秒数 `> chars*0.6 + 4` 即拒收（6 字 12 秒循环必中，34 字正常 6.3 秒放行）。

## 3. 改动面（锁死）

| 层 | 改动 |
|---|---|
| main-agent `ttsProxy` | 上游改 multipart+base64 解码；错误收敛为 `{error:code}` 三码（`empty`/`synth_failed`/`nano_unavailable`，`bad_request` 保留）；删情绪头；加时长守卫；`GENIE_SPEAK_URL` → `NANO_TTS_URL` + 新增 `NANO_DEMO_ID`（均带默认值，services.js 的 envKeys 只是文档用途、全量直通，不改） |
| 浏览器 `genieTts.ts` | 请求体去 `emotion`；ERROR_TEXT 换 nano 三码+bad_request；135s/44 字节门保留；URL 路径 `/agent/v1/tts` 不变 |
| sullyos-home `/home/speak` | 同一切 Nano（demo-30），删 PCM 包裹（Nano 直出 wav base64），30s 超时保留 |
| 测试 | 两处测试文件按新合同重写（multimap 断言、状态映射表、无情绪断言） |
| 部署 | bundle 重建 + VPS pull + 重启 main-agent + 烟雾矩阵；删 `vps-backend/deploy/genie`（死目录） |

## 4. 不做

- 不动 `/agent` 传输层（backend-proxy、CF 函数、Caddy、vite 代理均通用）。
- 不调超时预算（先用 150s/135s/30s 跑数据，再议）。
- 不碰 Phase B/C 未合并分支（Genie 耦合，另议）；不碰迁移链四文件。
- `resolveGenieEmotion`/`GENIE_EMOTIONS` 保留导出（在途 UI 可能仍引用），仅停用调用；删除是后续任务。
- sullyos-home 以外的 9882 引用清理（若有）随测试红灯处理，不主动全仓重构。

## 5. 验收

1. `pnpm vitest run worker/main-agent utils/genieTts.test.ts worker/sullyos-home` 全绿。
2. `tsc` 本次触碰文件零命中 + FFFD 零。
3. VPS：`curl /agent/v1/tts` 出声（经 Caddy→8830 全链）；8 句矩阵（含嗯/行/破折/省略/长文本）逐条 200 且时长守卫零误杀；`另起一行` seed 7 复核 1.1 秒级。
4. bundle 含新路由逻辑（grep `NANO_DEMO_ID` 命中）；`genie-tts.service` 不复活（`systemctl is-active` 非 active）。

## 6. 朗读风格指导（2026-09-28 用户决策）

- 模型写语音内容必须口语化：书面语先转大白话再送语音块。
- 长句拆短句：每句约 25 字以内（服务端已有分块兜底，此为模型侧前置）。
- 数字、日期写中文读法（如 `30%`→`百分之三十`）。
- 避免中英混杂：英文内容用全中文替换。
- 落点：语音表演指南 prompt 文本（与引擎无关的写作要求，Nano/Genie 通用）。
