import { checkAuth } from './auth.js';
import {
  listMessages, insertMessage, listMemories, insertEvents,
  getHomeConfig, putHomeConfig,
} from './store.js';
import { extractMemories, mergePlateEntries } from './memoryLeaf.js';
import { speakFallback } from './speak.js';
export default {
  async fetch(req: Request, env: any): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/home/health')
      return Response.json({ ok: true, version: 'home-0.1' });
    const authed = checkAuth(req, env);
    if (!authed) return Response.json({ error: 'unauthorized' }, { status: 401 });
    if (url.pathname === '/home/stats' && req.method === 'GET') {
      const db = env.DB;
      const count = async (t: string) =>
        (await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first()) as any;
      return Response.json({
        messages: (await count('home_messages')).n,
        memories: (await count('home_memories')).n,
        events: (await count('home_events')).n,
        facts: (await count('home_worlds')).n,
      });
    }
    if (url.pathname === '/home/messages' && req.method === 'GET')
      return Response.json(await listMessages(env.DB, url.searchParams.get('charId') ?? '', 50));
    if (url.pathname === '/home/messages' && req.method === 'POST') {
      const body = await req.json() as { charId: string; role: string; content: string };
      if (!body.charId || !body.content)
        return Response.json({ error: 'bad_request' }, { status: 400 });
      return Response.json(await insertMessage(env.DB, body), { status: 201 });
    }
    // P2 事件落盘：autonomyFire.persistHomeEvents 直调，失败回退旧链（见调用方）。
    if (url.pathname === '/home/events' && req.method === 'POST') {
      const body = await req.json().catch(() => null) as {
        charId?: unknown; events?: unknown;
      } | null;
      const events = body?.events;
      if (!body || typeof body.charId !== 'string' || !body.charId || !Array.isArray(events) ||
          !events.every((e) => !!e && typeof e === 'object'
            && typeof (e as { kind?: unknown }).kind === 'string'
            && (e as { kind: string }).kind.length > 0)) {
        return Response.json({ error: 'bad_request' }, { status: 400 });
      }
      const rows = await insertEvents(
        env.DB, body.charId, events as Array<{ kind: string; payload: unknown }>);
      return Response.json({ events: rows }, { status: 201 });
    }
    // P3 记忆快照读路径：plateFire.fetchHomeMemoriesSnapshot 拉取，失败回退旧链（见调用方）。
    if (url.pathname === '/home/memories' && req.method === 'GET') {
      const charId = url.searchParams.get('charId') ?? '';
      if (!charId)
        return Response.json({ error: 'bad_request' }, { status: 400 });
      const limit = Number(url.searchParams.get('limit') ?? 50);
      return Response.json(await listMemories(env.DB, charId, limit));
    }
    // 家行为参数：服务端按角色存（home_config 表），卡片 useHomeConfig 读写，离线回退本地。
    {
      const m = /^\/home\/config\/([^/]+)$/.exec(url.pathname);
      if (m) {
        const charId = decodeURIComponent(m[1]);
        if (!charId)
          return Response.json({ error: 'bad_request' }, { status: 400 });
        if (req.method === 'GET')
          return Response.json({ charId, config: await getHomeConfig(env.DB, charId) });
        if (req.method === 'PUT') {
          const body = await req.json().catch(() => null) as unknown;
          if (!body || typeof body !== 'object' || Array.isArray(body))
            return Response.json({ error: 'bad_request' }, { status: 400 });
          const patch = (body as { config?: unknown }).config !== undefined
            ? (body as { config: unknown }).config
            : body;
          if (!patch || typeof patch !== 'object' || Array.isArray(patch))
            return Response.json({ error: 'bad_request' }, { status: 400 });
          return Response.json({ charId, config: await putHomeConfig(env.DB, charId, patch) });
        }
      }
    }
    // P3 记忆叶子：纯函数提取/合并，不落库（LLM 精炼与持久化留 P3-b）。鉴权走上面的 checkAuth。
    if (url.pathname === '/home/memories/extract' && req.method === 'POST') {
      const body = await req.json().catch(() => null) as {
        messages?: Array<{ role: string; content: string }>;
      } | null;
      if (!body || !Array.isArray(body.messages))
        return Response.json({ error: 'bad_request' }, { status: 400 });
      return Response.json(extractMemories(body.messages));
    }
    if (url.pathname === '/home/memories/consolidate' && req.method === 'POST') {
      const body = await req.json().catch(() => null) as {
        base?: unknown; incoming?: unknown;
      } | null;
      if (!body || !Array.isArray(body.base) || !Array.isArray(body.incoming) ||
          ![...body.base, ...body.incoming].every((x) => typeof x === 'string'))
        return Response.json({ error: 'bad_request' }, { status: 400 });
      return Response.json(mergePlateEntries(body.base as string[], body.incoming as string[]));
    }
    // P4 语音：转调本机 Nano-TTS 18083，超时 30s，失败回纯文本（200 + fallback:true，调用方照发正文）。
    // Nano-TTS 的角色与参考音频已在服务端预热，调用方无需加载角色或设置参考音频。
    if (url.pathname === '/home/speak' && req.method === 'POST') {
      const body = await req.json().catch(() => null) as {
        text?: unknown;
      } | null;
      if (!body || typeof body.text !== 'string' || !body.text.trim())
        return Response.json({ error: 'bad_request' }, { status: 400 });
      const text = body.text;
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
      return Response.json(await speakFallback(trySpeak));
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  },
  async scheduled() { /* P1 无 cron，留空占位供宿主探测 */ },
};
