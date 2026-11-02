/**
 * agentEndpoint 归一化回归：agentUrl 约定是站点根，但用户常把文档里的
 * `/agent` 或 `/agent/v1` 一起粘进设置（线上真实故障：拼出
 * …/agent/agent/v1/local-embedding/embeddings）。与 genieTts /
 * socialShare 的同款剥离保持一致。
 */
import { describe, expect, it } from 'vitest';
import { agentEndpoint } from './MemoryPalaceLocalEmbedding';

const ROOT = 'https://link.ethernet.bot.cd';

describe('agentEndpoint 归一化', () => {
    it('站点根保持不变', () => {
        expect(agentEndpoint(ROOT)).toBe(`${ROOT}/agent/v1/local-embedding`);
    });

    it('末尾斜杠被吃掉，不产生双斜杠', () => {
        expect(agentEndpoint(`${ROOT}/`)).toBe(`${ROOT}/agent/v1/local-embedding`);
    });

    it('粘进来的 /agent 后缀被剥掉，不再出现 /agent/agent', () => {
        expect(agentEndpoint(`${ROOT}/agent`)).toBe(`${ROOT}/agent/v1/local-embedding`);
        expect(agentEndpoint(`${ROOT}/agent/`)).toBe(`${ROOT}/agent/v1/local-embedding`);
    });

    it('粘进来的 /agent/v1 后缀同样被剥掉', () => {
        expect(agentEndpoint(`${ROOT}/agent/v1`)).toBe(`${ROOT}/agent/v1/local-embedding`);
    });

    it('空地址返回空串（本地模型不可用，不拼非法 URL）', () => {
        expect(agentEndpoint('')).toBe('');
        expect(agentEndpoint('   ')).toBe('');
    });

    it('非 /agent 结尾的路径不动（不误伤正常子路径）', () => {
        expect(agentEndpoint('https://example.com/myagent')).toBe(
            'https://example.com/myagent/agent/v1/local-embedding',
        );
    });
});
