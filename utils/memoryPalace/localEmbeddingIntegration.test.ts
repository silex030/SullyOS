/**
 * 本地 embedding 接线的集成契约（跨模块）：
 *   - embedding.ts 的「单条 = query / 批量 = document」默认语义，以及云端路径一个字节都不变。
 *   - 维度不一致必须显式失败。
 *   - Supabase pgvector 的 vector(1024) 与本地 768 冲突：版本化 + 只产出迁移 SQL（不执行 DDL）。
 *   - 本地索引里混入旧维度向量时，vectorSearch 只喂兼容子集，并在全不兼容时降级词法。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEmbedding, getEmbeddings } from './embedding';
import {
    REMOTE_VECTOR_SCHEMA,
    buildRemoteVectorMigrationSQL,
    isRemoteVectorDimensionCompatible,
    upsertVector,
} from './supabaseVector';
import { partitionVectorsByDimension } from './vectorSearch';

const LOCAL_CFG = {
    baseUrl: 'https://agent.example/agent/v1/local-embedding',
    apiKey: 'agent-client-token',
    model: 'google/embeddinggemma-2',
    dimensions: 768,
};

const CLOUD_CFG = {
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: 'sk-cloud',
    model: 'BAAI/bge-m3',
    dimensions: 1024,
};

let bodies: any[] = [];

beforeEach(() => {
    bodies = [];
    global.fetch = vi.fn(async (_url: any, init: any) => {
        const body = JSON.parse(init.body as string);
        bodies.push(body);
        const dims = /embeddinggemma/.test(body.model) ? 768 : 1024;
        return {
            ok: true,
            status: 200,
            json: async () => ({
                data: body.input.map((_t: string, i: number) => ({
                    index: i,
                    embedding: new Array(dims).fill(0).map((_, k) => (k === i ? 1 : 0)),
                })),
            }),
        } as any;
    }) as any;
});

afterEach(() => vi.restoreAllMocks());

describe('embedding.ts 任务语义', () => {
    it('单条 getEmbedding = query，批量 getEmbeddings = document', async () => {
        await getEmbedding('查询', LOCAL_CFG as any);
        await getEmbeddings(['文档一', '文档二'], LOCAL_CFG as any);
        expect(bodies[0].task).toBe('query');
        expect(bodies[1].task).toBe('document');
        expect(bodies[1].input).toEqual(['文档一', '文档二']);
    });

    it('调用方显式 task 覆盖默认值（pipeline 的 query 预取）', async () => {
        await getEmbeddings(['两条查询'], { ...LOCAL_CFG, task: 'query' } as any);
        expect(bodies[0].task).toBe('query');
    });

    it('云端配置不新增任何字段（老路径零行为变化）', async () => {
        await getEmbeddings(['x'], CLOUD_CFG as any);
        expect(bodies[0]).toEqual({
            model: 'BAAI/bge-m3',
            input: ['x'],
            encoding_format: 'float',
        });
    });

    it('本地维度与期望不符 ⇒ 抛错而不是返回错向量', async () => {
        global.fetch = vi.fn(async (_url: any, init: any) => {
            const body = JSON.parse(init.body as string);
            return {
                ok: true,
                status: 200,
                json: async () => ({ data: body.input.map((_t: string, i: number) => ({ index: i, embedding: new Array(1024).fill(0.5) })) }),
            } as any;
        }) as any;
        await expect(getEmbeddings(['x'], LOCAL_CFG as any)).rejects.toMatchObject({ code: 'dimension_mismatch' });
    });
});

describe('Supabase pgvector 版本化（1024 硬编码）', () => {
    it('schema 版本与维度显式声明，768 判定为不兼容', () => {
        expect(REMOTE_VECTOR_SCHEMA.version).toBe(1);
        expect(REMOTE_VECTOR_SCHEMA.dimensions).toBe(1024);
        expect(isRemoteVectorDimensionCompatible(1024)).toBe(true);
        expect(isRemoteVectorDimensionCompatible(768)).toBe(false);
    });

    it('迁移方案是纯文本（版本 2 / 新表 / 新 RPC），不执行任何 DDL', () => {
        const plan = buildRemoteVectorMigrationSQL({ targetDimensions: 768 });
        expect(plan.version).toBe(2);
        expect(plan.targetDimensions).toBe(768);
        expect(plan.sql).toContain('vector(768)');
        expect(plan.sql).toContain('memory_vectors_v2');
        expect(plan.sql).toContain('match_vectors_v2');
        // 明确要求人工执行：脚本本身不联网、不执行
        expect(plan.manualSteps.join('\n')).toMatch(/手工|手动|SQL Editor/);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('不兼容维度不允许写入远端（返回 false，不发请求）', async () => {
        const f = vi.spyOn(global, 'fetch');
        const cfg = { enabled: true, initialized: true, supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'k' } as any;
        const ok = await upsertVector(
            cfg,
            'm1',
            'c1',
            new Float32Array(768).fill(0.1),
            {
                id: 'm1', charId: 'c1', content: 'x', room: 'living_room', tags: [], importance: 5,
                mood: 'neutral', embedded: true, createdAt: 1, lastAccessedAt: 1, accessCount: 0,
            } as any,
            768,
            'google/embeddinggemma-2',
        );
        expect(ok).toBe(false);
        expect(f).not.toHaveBeenCalled();
    });
});

describe('vectorSearch 维度隔离', () => {
    it('只把与查询同维度的向量喂进打分，其余单独统计', () => {
        const vectors = [
            { memoryId: 'a', charId: 'c1', vector: new Float32Array(768), dimensions: 768 },
            { memoryId: 'b', charId: 'c1', vector: new Float32Array(1024), dimensions: 1024 },
            { memoryId: 'c', charId: 'c1', vector: new Float32Array(768), dimensions: 768 },
        ] as any;
        const { compatible, incompatible } = partitionVectorsByDimension(vectors, 768);
        expect(compatible.map(v => v.memoryId)).toEqual(['a', 'c']);
        expect(incompatible).toHaveLength(1);
    });
});
