import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import handler from './index.js';
import { HOME_SERVER_CONFIG_DEFAULTS } from './store.js';

describe('home schema', () => {
  it('建五张表且列名冻结', () => {
    const sql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
    for (const t of ['home_messages', 'home_memories', 'home_events', 'home_worlds', 'home_config'])
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${t}`);
    expect(sql).toContain('updated_at');
  });
});

// ─── 路由测试：假 D1（只认 store.ts 实际下发的六条语句形状） ───────────────

function makeDb(seed: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    home_messages: [], home_memories: [], home_events: [], home_config: [],
    ...seed,
  };
  const db = {
    tables,
    prepare(sql: string) {
      return {
        bind(...params: any[]) {
          return {
            all: async () => {
              if (sql.startsWith('SELECT * FROM home_memories')) {
                const [charId, limit] = params;
                const rows = tables.home_memories
                  .filter((r) => r.char_id === charId)
                  .sort((a, b) => b.updated_at - a.updated_at)
                  .slice(0, limit);
                return { results: rows };
              }
              if (sql.startsWith('SELECT * FROM home_messages')) {
                const [charId, limit] = params;
                const rows = tables.home_messages
                  .filter((r) => r.char_id === charId)
                  .sort((a, b) => b.created_at - a.created_at)
                  .slice(0, limit);
                return { results: rows };
              }
              return { results: [] };
            },
            run: async () => {
              if (sql.startsWith('INSERT INTO home_events')) {
                tables.home_events.push({
                  id: params[0], char_id: params[1], kind: params[2],
                  payload: params[3], disclosed_to_user: params[4], created_at: params[5],
                });
              }
              if (sql.startsWith('INSERT INTO home_config')) {
                const [charId, config, updatedAt] = params;
                const hit = tables.home_config.find((r) => r.char_id === charId);
                if (hit) { hit.config = config; hit.updated_at = updatedAt; }
                else tables.home_config.push({ char_id: charId, config, updated_at: updatedAt });
              }
              return {};
            },
            first: async () => {
              if (sql.startsWith('SELECT config FROM home_config')) {
                const hit = tables.home_config.find((r) => r.char_id === params[0]);
                return hit ? { config: hit.config } : null;
              }
              if (sql.startsWith('SELECT COUNT(*)')) {
                const m = /FROM (\w+)/.exec(sql);
                return { n: m ? tables[m[1]].length : 0 };
              }
              return null;
            },
          };
        },
      };
    },
  };
  return db;
}

const authedEnv = (db: any) => ({ DB: db, AMSG_CLIENT_TOKEN: 'test-token' });
const call = (env: any, path: string, init?: RequestInit, token = 'test-token') =>
  handler.fetch(
    new Request(`http://127.0.0.1:8837${path}`, {
      ...init,
      headers: { ...(token ? { 'x-client-token': token } : {}), ...(init?.headers ?? {}) },
    }),
    env,
  );

describe('sullyos-home 路由', () => {
  it('没带 token → 401（events / memories / config 全走同一道 checkAuth）', async () => {
    const env = authedEnv(makeDb());
    for (const [path, init] of [
      ['/home/events', { method: 'POST', body: '{}' }],
      ['/home/memories?charId=c1', {}],
      ['/home/config/c1', {}],
    ] as Array<[string, RequestInit]>) {
      const res = await call(env, path, init, '');
      expect(res.status).toBe(401);
    }
  });

  it('POST /home/events：形状不对 → 400', async () => {
    const env = authedEnv(makeDb());
    const bad = [
      '{}',
      '{"charId":"c1"}',
      '{"charId":"c1","events":{}}',
      '{"charId":"c1","events":[{"payload":1}]}',
      '{"charId":"","events":[]}',
    ];
    for (const body of bad) {
      const res = await call(env, '/home/events', { method: 'POST', body });
      expect(res.status).toBe(400);
    }
  });

  it('POST /home/events：正常 → 201，payload 按 JSON 字符串落 home_events', async () => {
    const db = makeDb();
    const res = await call(authedEnv(db), '/home/events', {
      method: 'POST',
      body: JSON.stringify({ charId: 'c1', events: [{ kind: 'surf', payload: { q: '为什么' } }, { kind: 'rest', payload: null }] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { events: any[] };
    expect(body.events).toHaveLength(2);
    expect(db.tables.home_events).toHaveLength(2);
    expect(db.tables.home_events[0]).toMatchObject({ char_id: 'c1', kind: 'surf' });
    expect(db.tables.home_events[0].payload).toBe(JSON.stringify({ q: '为什么' }));
    expect(db.tables.home_events[1].payload).toBe('null');
  });

  it('GET /home/memories：缺 charId → 400；正常按 updated_at 倒序，limit 缺省 50、上限 200', async () => {
    const db = makeDb({
      home_memories: [
        { id: 'm1', char_id: 'c1', room: 'attic', summary: '旧', importance: 0.5, created_at: 1, updated_at: 1 },
        { id: 'm2', char_id: 'c1', room: 'x', summary: '新', importance: 0.9, created_at: 2, updated_at: 3 },
        { id: 'm3', char_id: 'c1', room: 'y', summary: '中', importance: 0.1, created_at: 3, updated_at: 2 },
        { id: 'm9', char_id: 'c2', room: 'z', summary: '别人的', importance: 0.1, created_at: 9, updated_at: 9 },
      ],
    });
    const env = authedEnv(db);
    expect((await call(env, '/home/memories')).status).toBe(400);
    const res = await call(env, '/home/memories?charId=c1&limit=2');
    expect(res.status).toBe(200);
    const rows = await res.json() as any[];
    expect(rows.map((r) => r.id)).toEqual(['m2', 'm3']);
    // 上限 200：limit=999 也全量返回（本例 3 条）；缺省 50 同样全量。
    expect(((await (await call(env, '/home/memories?charId=c1&limit=999')).json()) as any[])).toHaveLength(3);
    expect(((await (await call(env, '/home/memories?charId=c1')).json()) as any[])).toHaveLength(3);
  });

  it('GET /home/config/:charId：没存过 → 缺省值，不建行', async () => {
    const db = makeDb();
    const res = await call(authedEnv(db), '/home/config/c1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ charId: 'c1', config: HOME_SERVER_CONFIG_DEFAULTS });
    expect(db.tables.home_config).toHaveLength(0);
  });

  it('PUT /home/config/:charId：clamp 落盘，非法体 → 400', async () => {
    const db = makeDb();
    const env = authedEnv(db);
    for (const body of ['null', '"str"', '[1]', '42']) {
      expect((await call(env, '/home/config/c1', { method: 'PUT', body })).status).toBe(400);
    }
    const res = await call(env, '/home/config/c1', {
      method: 'PUT',
      body: JSON.stringify({ roundIntervalMin: 500, quietStart: 'xx', dailyMaxRounds: 200 }),
    });
    expect(res.status).toBe(200);
    // 间隔 5–120、夜间 HH:MM、日上限 0–96，非法回缺省。
    expect(await res.json()).toEqual({
      charId: 'c1',
      config: { roundIntervalMin: 120, quietStart: '00:00', dailyMaxRounds: 96 },
    });
    // 部分 PUT：只改一项，其余沿用已存值。
    const res2 = await call(env, '/home/config/c1', {
      method: 'PUT',
      body: JSON.stringify({ config: { roundIntervalMin: 10 } }),
    });
    expect(await res2.json()).toEqual({
      charId: 'c1',
      config: { roundIntervalMin: 10, quietStart: '00:00', dailyMaxRounds: 96 },
    });
    const get = await call(env, '/home/config/c1');
    expect((await get.json() as any).config.roundIntervalMin).toBe(10);
  });
});

describe('POST /home/speak', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Nano 成功时返回 WAV data URL，并以 multipart 直传文本', async () => {
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);
    const audioB64 = Buffer.from(wav).toString('base64');
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(
      JSON.stringify({ audio_base64: audioB64 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const res = await call(authedEnv(makeDb()), '/home/speak', {
      method: 'POST',
      body: JSON.stringify({ text: '你好' }),
    });
    const result = await res.json() as { fallback: boolean; audioUrl: string | null };

    expect(res.status).toBe(200);
    expect(result.fallback).toBe(false);
    expect(result.audioUrl).toBe(`data:audio/wav;base64,${audioB64}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('http://127.0.0.1:18083/api/generate');
    const form = init.body as FormData;
    expect(form.get('text')).toBe('你好');
    expect(form.get('demo_id')).toBe('demo-30');
    expect(form.get('seed')).toBe('7');
    expect(form.get('max_new_frames')).toBe('200');
  });

  it('Nano 404 时回退纯文本', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));

    const res = await call(authedEnv(makeDb()), '/home/speak', {
      method: 'POST',
      body: JSON.stringify({ text: '你好' }),
    });
    const result = await res.json() as { fallback: boolean; audioUrl: string | null };

    expect(result.fallback).toBe(true);
    expect(result.audioUrl).toBeNull();
  });

  it('Nano 请求异常时回退纯文本', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));

    const res = await call(authedEnv(makeDb()), '/home/speak', {
      method: 'POST',
      body: JSON.stringify({ text: '你好' }),
    });
    const result = await res.json() as { fallback: boolean; audioUrl: string | null };

    expect(result.fallback).toBe(true);
  });
});
