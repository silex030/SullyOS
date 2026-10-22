/**
 * 记忆宫殿 · 本地 EmbeddingGemma2 选择卡（独立组件）
 *
 * 设计边界（重要）：
 *   - **一键选择，不强覆盖**：这里只把「本地模型」的地址/模型/维度填进上面那组
 *     state，用户仍要自己点「保存配置」；已有的云端 baseUrl / key 不会被静默改写。
 *   - 浏览器不持本地服务的 EMB_API_KEY：baseUrl 指主代理 `/agent/v1/local-embedding`
 *     这个受鉴权入口，apiKey 用的是主代理已有的 client token。
 *   - 切换模型 = 换向量空间：这里只显示「待重建 / 进度 / 取消 / 继续」，
 *     不会自动重建，也不删除任何旧向量；重建期间检索由数据层自动降级。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowsClockwise, Cpu, WarningCircle } from '@phosphor-icons/react';

import {
    LOCAL_GEMMA_PROFILE,
    buildEmbeddingFingerprint,
    type LocalAwareEmbeddingConfig,
} from '../../utils/memoryPalace/localEmbedding';
import {
    IndexStatusStore,
    checkIndexIdentity,
    describeIndexStatus,
    runIndexRebuild,
    type LocalIndexStatus,
} from '../../utils/memoryPalace/localEmbeddingIndex';

/** 主代理 client token 的类型别名（不是本地服务的 EMB_API_KEY） */
type AgentToken = string;

export interface LocalEmbeddingSelection {
    baseUrl: string;
    apiKey: AgentToken;
    model: string;
    dimensions: number;
    provider: 'local-gemma';
    prefixScheme: string;
}

interface Props {
    charId?: string;
    /** 主代理地址（设置里的 agentUrl），为空则本地模型不可用 */
    agentUrl: string;
    /** 主代理 client token（已有鉴权凭据，不是本地服务 key） */
    agentToken: string;
    /** 当前已保存的 embedding 配置（用于判断是否已经是本地模型） */
    current: { baseUrl?: string; apiKey?: string; model?: string; dimensions?: number } | undefined;
    /** 一键填入（只改表单 state，保存仍由用户点上面的按钮） */
    onSelect: (selection: LocalEmbeddingSelection) => void;
    /** 重建用到的向量化配置；未保存/未切到本地时传 undefined 表示禁用重建 */
    rebuildConfig?: LocalAwareEmbeddingConfig;
}

const CARD: React.CSSProperties = {
    background: '#f8f7ff',
    borderRadius: 16,
    padding: 16,
    border: '1px solid #e9e5ff',
    marginTop: 16,
};

const BTN_BASE: React.CSSProperties = {
    padding: '10px 14px',
    borderRadius: 12,
    fontSize: 12,
    fontWeight: 600,
    border: '1px solid #e9e5ff',
    background: 'white',
    color: '#7c3aed',
    cursor: 'pointer',
};

function agentEndpoint(agentUrl: string): string {
    const base = String(agentUrl || '').trim().replace(/\/+$/, '');
    return base ? `${base}/agent/v1/local-embedding` : '';
}

export default function MemoryPalaceLocalEmbedding({
    charId,
    agentUrl,
    agentToken,
    current,
    onSelect,
    rebuildConfig,
}: Props) {
    const store = useMemo(() => new IndexStatusStore(), []);
    const [status, setStatus] = useState<LocalIndexStatus | undefined>(undefined);
    const [busy, setBusy] = useState(false);
    const abortRef = useRef<AbortController | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    const endpoint = agentEndpoint(agentUrl);
    const ready = !!endpoint && !!agentToken.trim();
    const isLocalSelected = !!current?.model && /embeddinggemma/i.test(current.model);

    const refresh = useCallback(async () => {
        if (!charId) { setStatus(undefined); return; }
        setStatus(store.get(charId) ?? undefined);
        // 有向量时才值得做一次身份调查（空库不打扰用户）
        try {
            const [{ MemoryVectorDB }, aware] = await Promise.all([
                import('../../utils/memoryPalace/db'),
                Promise.resolve(rebuildConfig),
            ]);
            if (!aware?.model) return;
            const vectors = await MemoryVectorDB.getAllByCharId(charId);
            if (vectors.length === 0) return;
            const { status: ignored } = await checkIndexIdentity({
                charId,
                expectedFingerprint: buildEmbeddingFingerprint(aware),
                expectedDimensions: LOCAL_GEMMA_PROFILE.dimensions,
                vectors,
                store,
            });
            void ignored;
            setStatus(store.get(charId) ?? undefined);
        } catch {
            // 调查失败不影响选择模型本身
        }
    }, [charId, rebuildConfig, store]);

    useEffect(() => { void refresh(); }, [refresh]);

    const select = () => {
        onSelect({
            baseUrl: endpoint,
            // 复用主代理 client token：本地服务的 EMB_API_KEY 只留在服务端
            apiKey: agentToken.trim(),
            model: LOCAL_GEMMA_PROFILE.model,
            dimensions: LOCAL_GEMMA_PROFILE.dimensions,
            provider: 'local-gemma',
            prefixScheme: LOCAL_GEMMA_PROFILE.prefixScheme,
        });
        setNotice('已填入表单，点上面的「保存配置」才会生效（现有云端配置不会被自动覆盖）');
    };

    const startRebuild = async (resume: boolean) => {
        if (!charId || !rebuildConfig?.model || !rebuildConfig?.baseUrl || !rebuildConfig?.apiKey) {
            setNotice('请先保存本地 embedding 配置，再重建向量索引');
            return;
        }
        setBusy(true);
        setNotice(null);
        const ac = new AbortController();
        abortRef.current = ac;
        try {
            const [{ MemoryNodeDB, saveNodeWithVector }, { getEmbeddings }] = await Promise.all([
                import('../../utils/memoryPalace/db'),
                import('../../utils/memoryPalace/embedding'),
            ]);
            const cfg = { ...rebuildConfig, task: 'document' as const };
            const finalStatus = await runIndexRebuild({
                charId,
                expectedFingerprint: buildEmbeddingFingerprint(rebuildConfig),
                expectedDimensions: LOCAL_GEMMA_PROFILE.dimensions,
                store,
                resume,
                signal: ac.signal,
                batchSize: 5,
                onProgress: (p) => setStatus({ ...p }),
                deps: {
                    listNodes: async (id: string) => {
                        const nodes = await MemoryNodeDB.getByCharId(id);
                        return nodes.filter(n => n.embedded).map(n => ({ id: n.id, content: n.content }));
                    },
                    embed: async (texts: string[]) => getEmbeddings(texts, cfg),
                    // 只覆盖这条记忆自己的向量：正文与向量同事务落库，不删除任何节点
                    save: async (node, vector, fingerprint, dimensions) => {
                        const full = await MemoryNodeDB.getById(node.id);
                        if (!full) return;
                        await saveNodeWithVector(
                            { ...full, embedded: true },
                            {
                                memoryId: node.id,
                                charId: full.charId,
                                vector,
                                dimensions,
                                model: rebuildConfig.model,
                                fingerprint,
                            } as any,
                        );
                    },
                },
            });
            setStatus({ ...finalStatus });
        } catch (e: any) {
            setNotice(`重建失败：${e?.message || e}`);
        } finally {
            abortRef.current = null;
            setBusy(false);
        }
    };

    const cancelRebuild = () => {
        abortRef.current?.abort();
        setNotice('已请求取消：已完成的部分保留，可随时「继续重建」');
    };

    const statusText = describeIndexStatus(status);
    const canRebuild = !!status && ['pending_rebuild', 'cancelled', 'failed'].includes(status.state);

    return (
        <div style={CARD}>
            <div style={{
                fontSize: 12, fontWeight: 700, color: '#7c3aed', marginBottom: 8,
                display: 'flex', alignItems: 'center', gap: 6,
            }}>
                <Cpu size={14} />
                <span>本地 EmbeddingGemma2（本机 GPU/CPU，不上传记忆）</span>
            </div>

            <div style={{ fontSize: 11, color: '#6b7280', lineHeight: 1.7, marginBottom: 12 }}>
                走主代理已鉴权的本地通道（{LOCAL_GEMMA_PROFILE.model} · 768 维 · L2 归一）。
                query / document 前缀由服务端按任务自动选择。
                <br />
                切换向量模型会改变向量空间：已有向量会显示「待重建」，<b>不会自动重建、也不会删除</b>；
                重建期间检索自动降级为词法匹配并提示。
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <button
                    onClick={select}
                    style={{
                        ...BTN_BASE,
                        color: 'white',
                        background: ready ? '#7c3aed' : '#cbd5e1',
                        border: 'none',
                        cursor: ready ? 'pointer' : 'not-allowed',
                    }}
                    disabled={!ready}
                >
                    {isLocalSelected ? '重新填入本地配置' : '一键使用本地模型'}
                </button>

                {canRebuild && (
                    <button
                        onClick={() => void startRebuild(status?.state === 'cancelled' || status?.state === 'failed')}
                        disabled={busy}
                        style={{ ...BTN_BASE, display: 'inline-flex', alignItems: 'center', gap: 5 }}
                    >
                        <ArrowsClockwise size={13} />
                        <span>{status?.state === 'cancelled' ? '继续重建' : '重建向量索引'}</span>
                    </button>
                )}

                {busy && (
                    <button onClick={cancelRebuild} style={{ ...BTN_BASE, color: '#b91c1c' }}>
                        取消
                    </button>
                )}
            </div>

            {!ready && (
                <div style={{
                    marginTop: 10, fontSize: 11, color: '#b45309', display: 'flex', gap: 6, alignItems: 'flex-start',
                }}>
                    <WarningCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                    <span>先在「设置 → 网络代理」里配置主代理地址与 Token，本地模型才会出现在这里。</span>
                </div>
            )}

            <div style={{ marginTop: 10, fontSize: 11, color: '#4b5563' }}>
                向量索引状态：<b>{statusText}</b>
            </div>

            {charId && status?.state === 'pending_rebuild' && !busy && (
                <div style={{ marginTop: 6, fontSize: 10.5, color: '#9a3412', lineHeight: 1.6 }}>
                    已有 {status.total} 条记忆使用旧模型生成。重建是用本地模型逐条重算（可取消、可继续），
                    不重建也能继续聊天——只是这段记忆暂时靠关键词召回。
                </div>
            )}

            {notice && (
                <div style={{ marginTop: 8, fontSize: 11, color: '#6b7280' }}>{notice}</div>
            )}
        </div>
    );
}
