# Nano-TTS 适配切换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 App 语音从已删除的 Genie 切到已验证的 Nano（一句话：main-agent 转 multipart，浏览器去 emotion，sullyos-home 跟进）。

**Architecture:** main-agent `ttsProxy` 做合同翻译（前端 JSON 不变 → Nano multipart；base64 解码回 wav；时长守卫拦循环）。浏览器只删 emotion 字段与错误映射。传输层（backend-proxy/CF/Caddy/vite）零改动。

**Tech Stack:** Cloudflare Workers (main-agent/src + bundle 重建）、TypeScript (vitest)、VPS（pull + 重启 + 烟雾）。

**Spec:** `docs/superpowers/specs/2026-09-28-nano-tts-adapter-design.md`

## Global Constraints

- 错误体契约形状不变：顶层 `{"error": "<code>"}`，不包 `detail`（码值换新：`empty`/`synth_failed`/`nano_unavailable`/`bad_request`）。
- 超时预算不变（150s/135s/30s），先跑数据再议。
- 写文件只用专用读写工具，必须 UTF-8 无 BOM；含中文的 oldString 只从 Read 输出逐字取；动过含中文文件后字节级扫 U+FFFD（EF BF BD），见红即停。
- git commit message 用英文（纯 ASCII）；提交只加本次文件。
- 仓库里禁止出现真实后端域名。
- 不碰迁移链四文件；services.js 的 envKeys 只是文档用途，不加键。
- `resolveGenieEmotion`/`GENIE_EMOTIONS` 保留导出仅停用；删除是后续任务。

## Review Focus

1. multipart 字段缺失（text/demo_id/seed/max_new_frames 少一个即 400）。→ 钉在 T2 测试（逐字段断言）。
2. base64 解码损坏（截断/非 wav 直通播放器）。→ 钉在 T2 测试（RIFF 魔数断言）+ 时长守卫。
3. 循环音频漏网（守卫公式错杀正常长句）。→ 钉在 T2 测试（12 秒/6 字拒收 + 34 字 6.3 秒放行两例）。
4. 上游非 200 被当 200 透传（Nano 用 status 表达失败）。→ 钉在 T2 状态映射表。
5. bundle 未重建就部署（VPS 跑的还是旧包）。→ 钉在 T7（grep `NANO_DEMO_ID` 命中 bundle 才算数）。
6. 模型无视朗读风格指南（四规则不执行）：prompt 指导无机器可验的钉子，门控只是回归套件不红。→ 接受为软约束，效果靠线上观察。

## 本次会触碰的文件清单

修改：`worker/main-agent/src/index.js`（ttsProxy 重写 + 时长 helper）、`worker/main-agent/src/index.test.ts`（TTS 块重写）、`utils/genieTts.ts`（body + 错误映射）、`utils/genieTts.test.ts`（body/错误用例）、`utils/chatPrompts.ts`（指南 + 朗读风格块）、`worker/sullyos-home/src/index.ts`（/home/speak 切 Nano）、`worker/sullyos-home/src/index.test.ts`（对应更新）、`worker/main-agent/worker.bundle.js` + `worker/sullyos-home/worker.bundle.js`（重建产物）
删除：`vps-backend/deploy/genie/`（整目录，服务已删，死代码）
新建：`vps-backend/deploy/nano/README.md`（服务定义 + demo 条目记录 + 回滚）
明确不碰：传输层四处、services.js、`types.ts`、迁移链、Phase B/C 分支。

## 任务依赖图

- T1（VPS demo 条目，controller 直跑，无代码）→ T2（无它则 multipart 缺 voice）。
- T2 → T3（同文件先后写：T2 代理重写，T3 时长守卫；T3 开工前确认 T2 提交已在）。
- T4（客户端）随时可做，T5（朗读风格指南）独立文本，T6（sullyos-home）独立文件；但 SDD 串行：T1→T2→T3→T4→T5→T6→T7→T8→T9。
- T7（deploy 清理 + bundle 重建）在 T2–T6 之后；T8（VPS 部署+烟雾，controller 直跑）；T9 验收记录。

---

### Task 1: VPS demo 条目 + 发音人锁定（controller 直跑，无代码）

**执行人：** controller（需 VPS 工具）。**产出：** demo-30 可用 + 烟雾证据行（记入 ledger，不提交）。

- [ ] **Step 1: 加 demo 条目**

`assets/demo.jsonl` 末尾追加一行（整行 JSON）：
```json
{"name": "ether", "role": "prompt-voices/emo-calm.wav", "text": "今天过得怎么样，想不想听我讲讲今天遇到的事？"}
```
（role 用已验证的 calm 参考 + 已知转写；prompt-voices 在 APP_DIR 内，满足 `_load_demo_entries` 的文件检查。）

- [ ] **Step 2: 重启并确认 id**

Run: `systemctl restart moss-tts`
Run: `curl -s -X POST 127.0.0.1:18083/api/generate -F "text=hi" -F "demo_id=demo-30" -o /dev/null -w "http=%{http_code}\n"`
Expected: `http=200`（非 200 则数 valid 条目重算 id，ledger 记录实际值并全计划替换）。

- [ ] **Step 3: 冒烟三句**

`今天过得怎么样` / `干一行爱一行` / `嗯，今天过得怎么样` 各打一条，逐条 200 即过。证据行记 ledger。

---

### Task 2: main-agent ttsProxy 切 Nano

**Files:**
- Modify: `worker/main-agent/src/index.js:467-497`（ttsProxy 整块重写 + 时长 helper）
- Modify: `worker/main-agent/src/index.test.ts:334-385`（转发/情绪头/码表三处重写；329-332 与 387-391 不动）

**Interfaces:**
- Consumes: T1 的 demo-30（若 T1 实测 id 不同，以 ledger 记录值为准，替换下文两处 `demo-30`）。
- Produces: 新合同（multipart 出、wav 回、三码错）供 T6 部署。

**Background:** 上游从 JSON/speak 变成 multipart/generate；失败表达从码体变成纯 status；情绪无处可送（调用方仍传 emotion 即忽略）。

- [ ] **Step 1: 重写 ttsProxy**

把 `:467-497` 整块换成：
```js
// 配置走 main-agent 的 env 对象（与 getJsonEnv / providersOf 同一套读法），不是 process.env。
async function ttsProxy(request, env) {
  const nanoUrl = (env?.NANO_TTS_URL || '').trim() || 'http://127.0.0.1:18083/api/generate';
  const demoId = (env?.NANO_DEMO_ID || '').trim() || 'demo-30';
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
  if (!text) return json({ error: 'empty' }, 400);
  // Nano 无情绪参数：调用方仍可传 emotion，本代理直接忽略（不校验、不转发）。
  try {
    const form = new FormData();
    form.append('text', text);
    form.append('demo_id', demoId);
    form.append('seed', '7');
    form.append('max_new_frames', '200');
    const upstream = await fetch(nanoUrl, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(150000),
    });
    let data;
    try {
      data = await upstream.json();
    } catch {
      return json({ error: 'synth_failed' }, 502);
    }
    if (!upstream.ok || typeof data?.audio_base64 !== 'string' || !data.audio_base64) {
      return json({ error: 'synth_failed' }, 502);
    }
    const wav = Uint8Array.from(atob(data.audio_base64), (c) => c.charCodeAt(0));
    const out = new Headers();
    out.set('content-type', 'audio/wav');
    out.set('access-control-allow-origin', '*');
    return new Response(wav, { status: 200, headers: out });
  } catch {
    return json({ error: 'nano_unavailable' }, 502);
  }
}
```
（旧注释"空文本由 /speak 裁决"随旧合同删除；`X-Genie-Resolved-Emotion` 转发删除，无来源。）

- [ ] **Step 2: 重写三处测试**

`:334-348` 换成（multipart 逐字段 + base64 解码 + 无情绪头）：
```ts
    it('把 text/demo/seed/帧数组成 multipart 并把 base64 解回 wav', async () => {
        const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]).buffer;
        const audioB64 = Buffer.from(wav).toString('base64');
        const calls: Array<{ url: string; init: any }> = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
            calls.push({ url: String(url), init });
            return new Response(JSON.stringify({ audio_base64: audioB64 }), {
                status: 200, headers: { 'content-type': 'application/json' },
            });
        }));
        const res = await postTts({ text: '你好', emotion: 'happy' });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('audio/wav');
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
        expect(res.headers.get('x-genie-resolved-emotion')).toBeNull();
        expect(calls[0].url).toBe('http://127.0.0.1:18083/api/generate');
        const body = calls[0].init.body as FormData;
        expect(body.get('text')).toBe('你好');
        expect(body.get('demo_id')).toBe('demo-30');
        expect(body.get('seed')).toBe('7');
        expect(body.get('max_new_frames')).toBe('200');
        const out = new Uint8Array(await res.arrayBuffer());
        expect(out[0]).toBe(0x52);
    });
```
`:350-361` 整块删除（情绪头已无来源）。
`:363-385` 的码表换成状态映射表：
```ts
    it.each([
        [400, 502, 'synth_failed'],
        [500, 502, 'synth_failed'],
        [503, 502, 'synth_failed'],
    ])('上游非 200 一律 502 synth_failed（Nano 用 status 表达失败）', async (status, want, code) => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status })));
        const res = await postTts({ text: 'x' });
        expect(res.status).toBe(want);
        expect(await res.json()).toEqual({ error: code });
    });

    it('空文本直接 400 empty，不打上游', async () => {
        const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        const res = await postTts({ text: '  ' });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'empty' });
        expect(fetchMock).not.toHaveBeenCalled();
    });
```
（`329-332` 403 与 `387-391` 502 不动。）

- [ ] **Step 3: 跑测试确认通过**

Run: `pnpm vitest run worker/main-agent`
Expected: 全绿。
Run: `pnpm exec tsc --noEmit 2>&1 | Select-String -Pattern '^worker/main-agent/src'`
Expected: 无输出。

- [ ] **Step 4: 提交**

```bash
git add worker/main-agent/src/index.js worker/main-agent/src/index.test.ts
git commit -m "feat(tts): route main-agent proxy to Nano multipart contract"
```

---

### Task 3: 时长守卫（拦复读循环）

**Files:**
- Modify: `worker/main-agent/src/index.js`（T2 块内 + helper）
- Modify: `worker/main-agent/src/index.test.ts`（+2 用例）

**Interfaces:**
- Consumes: T2 的 ttsProxy（开工前确认 T2 提交已在）。
- Produces: 守卫后合同（T6 部署）。

**Background:** seed 抽风已实测（4 字播 30 秒）；公式 `dur > chars*0.6 + 4` 经矩阵校验（12 秒/6 字拒收，34 字 6.3 秒放行）。

- [ ] **Step 1: 加 helper + 接入**

在 `ttsProxy` 上方加：
```js
/** 从 44 字节 RIFF 头估算秒数；头不全/非标返回 null（放行不断链）。 */
function wavDurationSeconds(wav) {
  try {
    if (wav.length < 44) return null;
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (riff !== 'RIFF') return null;
    const byteRate = view.getUint32(28, true);
    const dataSize = view.getUint32(40, true);
    if (!byteRate || !dataSize) return null;
    return dataSize / byteRate;
  } catch {
    return null;
  }
}
```
在 T2 的 `const wav = Uint8Array.from(...)` 之后、`new Headers()` 之前加：
```js
    // 时长守卫：复读循环的音频远长于文本应有长度，直接拒收（seed 抽风已实测）。
    const seconds = wavDurationSeconds(wav);
    if (seconds !== null && seconds > text.length * 0.6 + 4) {
      console.warn(`[tts] reject overlong audio: chars=${text.length} seconds=${seconds.toFixed(1)}`);
      return json({ error: 'synth_failed' }, 502);
    }
```

- [ ] **Step 2: 加 2 用例**

在 T2 的映射表之后追加：
```ts
    it('超长音频被时长守卫拒收（12 秒/6 字）', async () => {
        const big = new Uint8Array(44 + 192000 * 12);
        big.set([0x52, 0x49, 0x46, 0x46], 0);
        new DataView(big.buffer).setUint32(28, 192000, true);
        new DataView(big.buffer).setUint32(40, 192000 * 12, true);
        const audioB64 = Buffer.from(big).toString('base64');
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ audio_base64: audioB64 }), { status: 200 })));
        const res = await postTts({ text: '干一行爱一行' });
        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: 'synth_failed' });
    });

    it('正常长句放行（6.3 秒/34 字）', async () => {
        const ok = new Uint8Array(44 + Math.floor(192000 * 6.3));
        ok.set([0x52, 0x49, 0x46, 0x46], 0);
        new DataView(ok.buffer).setUint32(28, 192000, true);
        new DataView(ok.buffer).setUint32(40, Math.floor(192000 * 6.3), true);
        const audioB64 = Buffer.from(ok).toString('base64');
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ audio_base64: audioB64 }), { status: 200 })));
        const longText = '今天过得怎么样，想不想听我讲讲今天遇到的事？周末要不要一起出去走走？';
        const res = await postTts({ text: longText });
        expect(res.status).toBe(200);
    });
```

- [ ] **Step 3: 跑测试 + 提交**

Run: `pnpm vitest run worker/main-agent`
Expected: 全绿。
```bash
git add worker/main-agent/src/index.js worker/main-agent/src/index.test.ts
git commit -m "feat(tts): reject runaway loop audio by duration guard"
```

---

### Task 4: 浏览器客户端切 Nano（去 emotion + 换错误映射）

**Files:**
- Modify: `utils/genieTts.ts:1-32,83-91`（头注释 + ERROR_TEXT + body）
- Modify: `utils/genieTts.test.ts:55-64,78-92`（emotion 断言 + 三个错误码用例）

**Interfaces:** 无上下游（合同形状不变：同 URL、同 wav 出、码体同形）。

**Background:** Nano 无情绪参数；失败表达只剩 status。`resolveGenieEmotion`/`GENIE_EMOTIONS` 保留导出仅停用（删除另议）。

- [ ] **Step 1: 改三处**

头注释 `:4` 的 `组请求体（text + emotion）` → `组请求体（text；Nano 无情绪参数）`。
`:19-32` 的 ERROR_TEXT 换成：
```ts
const ERROR_TEXT: Record<string, string> = {
  bad_request: '请求格式不正确',
  empty: '没有可朗读的文字',
  synth_failed: '语音合成失败',
  nano_unavailable: '语音服务暂时不可用',
};
```
`:88` 的 `JSON.stringify({ text: spoken, emotion: resolveGenieEmotion(options, apiConfig) })` → `JSON.stringify({ text: spoken })`（`options`、`apiConfig` 形参保留，签名不动）。

- [ ] **Step 2: 改测试**

`:55-64` 用例改名并改断言：
```ts
  it('带上 X-Client-Token 鉴权头，不再发 emotion（Nano 无情绪参数）', async () => {
    const fetchMock = vi.fn(async () => makeResponse(200, new ArrayBuffer(2048)));
    vi.stubGlobal('fetch', fetchMock);
    await synthesizeSpeechGenieDetailed('测试文本', char, apiConfig, { emotion: 'sad' });
    const [, init] = fetchMock.mock.calls[0] as any;
    expect(init.headers['X-Client-Token']).toBe('tok');
    const body = JSON.parse(init.body);
    expect(body.text).toBe('测试文本');
    expect(body).not.toHaveProperty('emotion');
  });
```
`:78-92` 三个用例的期望文案照新映射改（503→`{"error":"synth_failed"}` 断 `/失败/`；504→`{"error":"nano_unavailable"}` 断 `/暂时不可用/`；413→`{"error":"bad_request"}` 断 `/格式不正确/`；status 照旧 503/504/413）。

- [ ] **Step 3: 跑测试 + 类型 + 提交**

Run: `pnpm vitest run utils/genieTts.test.ts utils/ttsRouter`
Expected: 全绿。
Run: `pnpm exec tsc --noEmit 2>&1 | Select-String -Pattern '^utils/genieTts'`
Expected: 无输出。
```bash
git add utils/genieTts.ts utils/genieTts.test.ts
git commit -m "feat(tts): Nano client without emotion, status-based errors"
```

---

### Task 5: 朗读风格指导（口语化四规则）

**Files:**
- Modify: `utils/chatPrompts.ts:59`（`GENIE_VOICE_ACTING_GUIDE` 末尾 +1 块）

**Interfaces:** 无上下游（prompt 纯文本；引擎无关，Nano/Genie 通用）。

**Background:** 用户决策（2026-09-28）：口语化、拆短句、数字中文读法、禁中英混杂。catalog 本体不动，只动 Genie 常量。服务端分块已存在，此为模型侧前置。

- [ ] **Step 1: 加一块**

把 `utils/chatPrompts.ts:59` 的：
```ts
- 语音和文字的标点、语气词要自然，口语化，不要念稿腔。`;
```
改成：
```ts
- 语音和文字的标点、语气词要自然，口语化，不要念稿腔。
- 朗读风格：书面语先转成大白话再说；长句拆成短句，每句约 25 字以内；数字、日期写中文读法（如 \`30%\` 写 \`百分之三十\`）；英文内容用全中文替换。`;
```
（`GENIE_CUE_RULE` 及 legacy 行不动。）

- [ ] **Step 2: 跑回归 + 提交**

Run: `pnpm vitest run utils/chatPrompts.test.ts utils/chatPrompts.voiceCues.test.ts`
Expected: 全绿。
Run: `pnpm exec tsc --noEmit 2>&1 | Select-String -Pattern '^utils/chatPrompts'`
Expected: 无输出。
```bash
git add utils/chatPrompts.ts
git commit -m "feat(voice): speaking-style rules in Genie voice guide"
```

---

### Task 6: sullyos-home /home/speak 跟进

**Files:**
- Modify: `worker/sullyos-home/src/index.ts:98-132`（上游改 Nano，删 PCM 包裹）
- Modify: `worker/sullyos-home/src/index.test.ts`（对应更新， `:218` 的 `:9882/tts` 断言必改）

**Background:** 该路径打的是 Genie 裸 PCM 接口（已删），与 /v1/tts 同病。Nano 直出 wav base64，`wrapPcmAsWav` + btoa 循环整段删除；fallback:true 语义保留。

- [ ] **Step 1: 改 trySpeak**

把 `:107-130` 的 `ttsBase`/`character`/`trySpeak` 换成：
```ts
      const nanoUrl = (env.NANO_TTS_URL as string | undefined) ?? 'http://127.0.0.1:18083/api/generate';
      const demoId = (env.NANO_DEMO_ID as string | undefined) ?? 'demo-30';
      const trySpeak = async (): Promise<string> => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30_000);
        try {
          const form = new FormData();
          form.append('text', text);
          form.append('demo_id', demoId);
          form.append('seed', '7');
          form.append('max_new_frames', '200');
          const res = await fetch(nanoUrl, { method: 'POST', body: form, signal: ctrl.signal });
          if (!res.ok) throw new Error(`tts upstream ${res.status}`);
          const data = await res.json() as { audio_base64?: unknown };
          if (typeof data?.audio_base64 !== 'string' || !data.audio_base64) throw new Error('tts empty audio');
          return `data:audio/wav;base64,${data.audio_base64}`;
        } finally {
          clearTimeout(timer);
        }
      };
```
（`wrapPcmAsWav` 的 import 若变死 import 则一并删；30s 与 fallback 语义不动。）

- [ ] **Step 2: 改测试 + 跑 + 提交**

`:218` 及相关断言按新合同改（multipart + base64 直返 + fallback 行为不断言死细节，只断言形状）。
Run: `pnpm vitest run worker/sullyos-home`
Expected: 全绿。
```bash
git add worker/sullyos-home/src/index.ts worker/sullyos-home/src/index.test.ts
git commit -m "feat(tts): route home speak to Nano contract"
```

---

### Task 7: 部署目录清理 + bundle 重建

**Files:**
- Delete: `vps-backend/deploy/genie/`（整目录：genie_server.py、test_speak.py、install.sh——服务已删，死代码）
- Create: `vps-backend/deploy/nano/README.md`（服务定义 + demo 条目记录 + torchaudio 补丁说明 + 回滚）
- Modify: `worker/main-agent/worker.bundle.js` + `worker/sullyos-home/worker.bundle.js`（重建产物）

- [ ] **Step 1: 删死目录 + 写 README**

```bash
git rm -r vps-backend/deploy/genie
```
`vps-backend/deploy/nano/README.md` 内容：
```md
# Nano-TTS 部署记录（VPS 手工维护，仓库只记契约）

- 服务：`moss-tts.service` → `/opt/moss-tts-nano/app_onnx.py --host 127.0.0.1 --port 18083 --cpu-threads 4 --max-new-frames 200`，conda env `moss`（py3.11）。
- 发音人：demo-30 = `prompt-voices/emo-calm.wav` + 已知转写（见 spec §2），`demo.jsonl` 追加行。
- 补丁：`moss` env 的 `sitecustomize.py` 把 `torchaudio.load` 换成 soundfile（sox 后端在此机段错误）。
- WeTextProcessing：pynini 先装再装本体；FST 一次性编译已缓存。
- 回滚：停 moss-tts → git 重下 Genie → `/root/genie-tts.service.bak` 恢复（权重 2.2GB 重下）。
```
- [ ] **Step 2: 重建 bundle**

Run: `node scripts/build-workers.mjs`
Run: `Select-String -Path worker/main-agent/worker.bundle.js -Pattern 'NANO_DEMO_ID'` 必须命中；`git status --short` 除两 bundle 外干净（有多余附带产物则 `git checkout --` 回退）。
- [ ] **Step 3: 提交**

```bash
git add vps-backend/deploy/genie vps-backend/deploy/nano/README.md worker/main-agent/worker.bundle.js worker/sullyos-home/worker.bundle.js
git commit -m "chore(tts): retire Genie deploy files, rebuild bundles for Nano"
```

---

### Task 8: VPS 部署 + 烟雾（controller 直跑）

**执行人：** controller（需 VPS 工具）。**产出：** 线上生效 + 证据行（ledger，不提交）。

- [ ] **Step 1: 拉 + 重启**

VPS `git pull`（sullyos 检出）→ `systemctl restart main-agent`（服务名以 `services.js` 为准）→ `systemctl is-active` 确认。
- [ ] **Step 2: 全链烟雾**

`curl` 经 Caddy `/agent/v1/tts`（`{"text":"今天过得怎么样"}` + token 现取现用，不回显）→ 200 + 首 4 字节 RIFF。
- [ ] **Step 3: 八句矩阵**

spec §5 第 3 条逐条打（含嗯/行/破折/省略/长文本 + `另起一行` seed 复核），逐条 200 + 守卫零误杀。

---

### Task 9: 写验收报告（报告进 ledger，不进仓库）

结论追加到本计划账本 `## Nano acceptance` 小节。**无代码提交**。

---

## Self-review 记录（写完即执行，不另派）

1. Spec 覆盖：§2 demo-30 → T1/T2；§2 守卫公式 → T3；§3 表格 → T2/T4/T6/T7；§4 不做 → Global Constraints；§5 → T8/T9；§6 朗读风格 → T5。
2. 占位扫描：无 TBD/TODO/"类似地"；multipart 字段/码值/公式/命令均为字面值；T1 的 id 漂移有显式处理分支（重算 + 全计划替换）。
3. 类型一致：`{error:code}` 三码在 T2 代码/T2 测试/T4 映射三处一致（empty/synth_failed/nano_unavailable + bad_request）；`demo-30`/`seed 7`/`max_new_frames 200` 在 T2/T6 两处一致；`text.length` 语义（CJK 按 1 计）与公式校准数据一致。
4. Review Focus 六项各有归属：见 Review Focus 末尾标注。
