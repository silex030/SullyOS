/**
 * 向量检索的身份隔离：**维度一致但模型/前缀不同，也绝不能混检**。
 *
 * 为什么单独锁这一条：
 *   - 上一轮只按 `dimensions` 分区，两个刚好都是 768 维的模型（云端小模型 vs 本地
 *     EmbeddingGemma2，或本地两套不同 prefix 的向量）会被当成同一空间，余弦相似度
 *     是纯噪声，排序静默变差，用户只会觉得"记忆变笨了"，任何日志都不报错。
 *   - 旧数据没有 `fingerprint`（legacy）。它无法证明自己属于当前空间，所以**不能**
 *     被当成新模型；只有一种例外：同名的云端模型（老版本只写 model 名 + 维度）在
 *     模型名与维度都一致时仍然可用，否则老用户升级当天向量检索会整片失效。
 *
 * 这组用例先红后绿：先写期望，再让实现满足。
 */
import { describe, expect, it } from 'vitest';
import type { MemoryVector } from './types';
import { buildEmbeddingFingerprint, LOCAL_GEMMA_PROFILE } from './localEmbedding';
import { partitionVectorsForQuery } from './vectorSearch';

const LOCAL_CFG = {
    baseUrl: 'https://agent.example/agent/v1/local-embedding',
    apiKey: 'agent-token',
    model: 'google/embeddinggemma-2',
    dimensions: 768,
    provider: 'local-gemma' as const,
    prefixScheme: 'eg2-retrieval-v1',
};

const CLOUD_CFG = {
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: 'sk-test',
    model: 'BAAI/bge-m3',
    dimensions: 1024,
};

const LOCAL_FP = buildEmbeddingFingerprint(LOCAL_CFG);
const CLOUD_FP = buildEmbeddingFingerprint(CLOUD_CFG);

function vec(id: string, dims: number, extra: Partial<MemoryVector> = {}): MemoryVector {
    return {
        memoryId: id,
        charId: 'c1',
        vector: new Float32Array(dims),
        dimensions: dims,
        ...extra,
    };
}

describe('partitionVectorsForQuery — 指纹严格匹配', () => {
    it('维度相同但指纹不同（另一个 768 维模型/前缀）不参与打分', () => {
        const vectors = [
            vec('a', 768, { fingerprint: LOCAL_FP, model: LOCAL_GEMMA_PROFILE.model }),
            vec('b', 768, { fingerprint: 'provider:local-gemma|model:other-768|rev:x|dim:768|prefix:other-v1|norm:l2' }),
        ];
        const { compatible, incompatible, mismatchedFingerprint } = partitionVectorsForQuery(vectors, {
            dimensions: 768,
            fingerprint: LOCAL_FP,
        });
        expect(compatible.map(v => v.memoryId)).toEqual(['a']);
        expect(incompatible.map(v => v.memoryId)).toEqual(['b']);
        expect(mismatchedFingerprint).toBe(1);
    });

    it('legacy（无 fingerprint）768 维旧向量不被当成当前本地模型', () => {
        const vectors = [
            vec('legacy', 768, { model: 'some/old-768-model' }),
            vec('fresh', 768, { fingerprint: LOCAL_FP, model: LOCAL_GEMMA_PROFILE.model }),
        ];
        const { compatible, incompatible, legacy } = partitionVectorsForQuery(vectors, {
            dimensions: 768,
            fingerprint: LOCAL_FP,
        });
        expect(compatible.map(v => v.memoryId)).toEqual(['fresh']);
        expect(incompatible.map(v => v.memoryId)).toEqual(['legacy']);
        expect(legacy).toBe(1);
    });

    it('云端同名同维度 legacy 仍可用（升级当天不掉检索），异名不可用', () => {
        const vectors = [
            vec('same-model', 1024, { model: 'BAAI/bge-m3' }),
            vec('other-model', 1024, { model: 'text-embedding-3-small' }),
            vec('fingerprinted', 1024, { model: 'BAAI/bge-m3', fingerprint: CLOUD_FP }),
        ];
        const { compatible, incompatible } = partitionVectorsForQuery(vectors, {
            dimensions: 1024,
            fingerprint: CLOUD_FP,
        });
        expect(compatible.map(v => v.memoryId).sort()).toEqual(['fingerprinted', 'same-model']);
        expect(incompatible.map(v => v.memoryId)).toEqual(['other-model']);
    });

    it('维度不同（1024 旧向量 vs 768 查询）即使指纹缺失也一律排除', () => {
        const vectors = [vec('old', 1024, { model: 'BAAI/bge-m3' }), vec('new', 768, { fingerprint: LOCAL_FP })];
        const { compatible, incompatible } = partitionVectorsForQuery(vectors, {
            dimensions: 768,
            fingerprint: LOCAL_FP,
        });
        expect(compatible.map(v => v.memoryId)).toEqual(['new']);
        expect(incompatible.map(v => v.memoryId)).toEqual(['old']);
    });

    it('没有期望指纹时退回维度分区（老调用方），但同维度异指纹仍按维度放行', () => {
        const vectors = [vec('a', 768, { fingerprint: LOCAL_FP }), vec('b', 1024, { fingerprint: CLOUD_FP })];
        const { compatible } = partitionVectorsForQuery(vectors, { dimensions: 768 });
        expect(compatible.map(v => v.memoryId)).toEqual(['a']);
    });

    it('空期望指纹字符串按「未提供」处理，不当成匹配任意 legacy', () => {
        const vectors = [vec('legacy', 768)];
        const { compatible } = partitionVectorsForQuery(vectors, { dimensions: 768, fingerprint: '   ' });
        expect(compatible.map(v => v.memoryId)).toEqual(['legacy']);
    });
});
