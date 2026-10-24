/**
 * 链接分享卡片（集成卡 t_babca897）。
 *
 * 显示用户发来的小红书 / 抖音 / B站 分享：状态、标题、作者、简介、覆盖情况、打开与重试。
 *
 * 安全约定（契约 7.2）：
 *  - 所有外部文本（标题/作者/简介/评论）只走 React 文本节点，绝不 dangerouslySetInnerHTML；
 *  - 跳转只用 safeOpenUrl 过滤过的 https 地址，window.open 带 noopener,noreferrer；
 *  - 外部内容是低权限资料，卡片上不呈现任何“可执行/可授权”入口。
 *
 * 状态语义：queued/resolving 显示进度；ready 正常；partial 明说缺什么；failed 显示
 * 结构化原因 + 重试。卡片本身不发起模型调用（避免重复回复）。
 */

import React, { useState } from 'react';
import type { ShareAttachment } from '../../utils/socialContent/types';
import {
    mergeShareAttachments,
    retryShare,
    safeOpenUrl,
    shareAttachmentsOf,
    shortShareRef,
} from '../../utils/socialShare';

const PLATFORM_LABEL: Record<string, string> = {
    bilibili: 'B站',
    xiaohongshu: '小红书',
    douyin: '抖音',
};

const STATE_TEXT: Record<string, string> = {
    queued: '排队解析…',
    resolving: '正在读取…',
    ready: '已读取',
    partial: '部分读取',
    failed: '未能读取',
    cancelled: '已取消',
};

const ERROR_HINT: Record<string, string> = {
    AUTH_REQUIRED: '需要登录，未获取正文',
    ACCESS_DENIED: '平台拒绝了访问',
    REGION_RESTRICTED: '地区受限',
    PAYWALL: '需要付费',
    CONTENT_NOT_FOUND: '内容不存在或已删除',
    CONTENT_DELETED: '内容已删除',
    TIMEOUT: '解析超时，可重试',
    NETWORK_ERROR: '网络错误，可重试',
    SOURCE_NOT_CONFIGURED: '该平台尚未配置来源',
    SIZE_LIMIT: '链接数量或体积超限',
    UNSAFE_URL: '链接未通过安全校验',
    UNSUPPORTED_PLATFORM: '不支持的平台',
    UNSUPPORTED_LINK_TYPE: '不支持的链接类型',
    RATE_LIMITED: '被限流，稍后再试',
    UPSTREAM_CHANGED: '平台接口变了，暂时读不到',
};

function stateColor(state: string): string {
    if (state === 'ready') return 'bg-emerald-50 text-emerald-600 border-emerald-200';
    if (state === 'partial') return 'bg-amber-50 text-amber-700 border-amber-200';
    if (state === 'failed') return 'bg-rose-50 text-rose-600 border-rose-200';
    return 'bg-slate-100 text-slate-500 border-slate-200';
}

const SocialShareCard: React.FC<{
    messageId: number;
    attachments: ShareAttachment[];
    /** 用户原话（保留问题，不被卡片吞掉） */
    content?: string;
}> = ({ messageId, attachments, content }) => {
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const onRetry = async (att: ShareAttachment) => {
        if (busy) return;
        setBusy(att.shareRef);
        setError(null);
        try {
            const res = await retryShare(att.shareRef, att.revision);
            if (!res.ok) {
                setError(res.status === 409 ? '状态已变化，请刷新后重试' : `重试失败（${res.error}）`);
                return;
            }
            const next = res.value.attachment;
            // 动态 import：卡片本身保持纯渲染，单测/首屏不必把整个 DB 层拖进来
            const { DB } = await import('../../utils/db');
            await DB.updateMessageMetadata(messageId, (prev: any) => ({
                ...(prev || {}),
                shares: {
                    ...(prev?.shares || {}),
                    version: 1,
                    attachments: mergeShareAttachments(shareAttachmentsOf(prev), [next]),
                    updatedAt: Date.now(),
                },
            }));
        } catch (e) {
            setError('重试失败，请稍后再试');
        } finally {
            setBusy(null);
        }
    };

    const onOpen = (att: ShareAttachment) => {
        const url = safeOpenUrl(att);
        if (!url) return;
        window.open(url, '_blank', 'noopener,noreferrer');
    };

    return (
        <div className="w-72 max-w-full flex flex-col gap-2" data-testid="social-share-card">
            {content ? (
                // 用户说的话原样展示（问题不能被卡片吞掉）
                <div className="text-[13px] leading-relaxed text-slate-700 whitespace-pre-wrap break-words">{content}</div>
            ) : null}
            {attachments.map((att) => {
                const label = PLATFORM_LABEL[String(att.platform)] || att.preview?.platformName || '链接';
                const openUrl = safeOpenUrl(att);
                const pending = att.state === 'queued' || att.state === 'resolving';
                const failed = att.state === 'failed' || att.state === 'cancelled';
                return (
                    <div
                        key={att.shareRef}
                        className="rounded-2xl bg-white border border-slate-200/80 shadow-[0_2px_10px_rgba(0,0,0,0.05)] overflow-hidden"
                    >
                        <div className="flex items-center justify-between px-3 pt-2.5">
                            <div className="flex items-center gap-1.5 min-w-0">
                                <span className="text-[11px] font-semibold text-slate-500">{label}</span>
                                <span className="text-[9px] text-slate-300" title={att.shareRef}>{shortShareRef(att.shareRef)}</span>
                            </div>
                            <span className={`text-[9px] px-1.5 py-0.5 rounded-full border ${stateColor(att.state)}`}>
                                {STATE_TEXT[att.state] || att.state}
                            </span>
                        </div>

                        {att.preview ? (
                            <div className="flex gap-2 px-3 pt-2">
                                {att.preview.coverUrl ? (
                                    <img
                                        src={att.preview.coverUrl}
                                        alt=""
                                        className="w-16 h-16 rounded-lg object-cover bg-slate-100 shrink-0"
                                        loading="lazy"
                                        referrerPolicy="no-referrer"
                                        onError={(e: any) => { if (e?.target) e.target.style.display = 'none'; }}
                                    />
                                ) : null}
                                <div className="min-w-0">
                                    <div className="text-[13px] font-semibold text-slate-800 line-clamp-2 leading-snug">
                                        {att.preview.title || '（无标题）'}
                                    </div>
                                    {att.preview.authorName ? (
                                        <div className="text-[10px] text-slate-500 mt-0.5 truncate">@{att.preview.authorName}</div>
                                    ) : null}
                                    {att.preview.excerpt ? (
                                        <div className="text-[10px] text-slate-400 mt-1 line-clamp-2 leading-relaxed">{att.preview.excerpt}</div>
                                    ) : null}
                                </div>
                            </div>
                        ) : null}

                        {att.contextProjection?.summaryText && !failed ? (
                            <div className="px-3 pt-2 text-[10px] text-slate-500 leading-relaxed line-clamp-3">
                                {att.contextProjection.summaryText}
                            </div>
                        ) : null}

                        {att.state === 'partial' && att.contextProjection?.reason ? (
                            <div className="px-3 pt-1 text-[9px] text-amber-600">
                                部分内容未取得：{att.contextProjection.reason.replace(/^missing:/, '')}
                            </div>
                        ) : null}

                        {failed ? (
                            <div className="px-3 pt-1 text-[10px] text-rose-500">
                                {ERROR_HINT[att.error?.code || ''] || att.error?.userMessage || '读取失败'}
                            </div>
                        ) : null}

                        {pending ? (
                            <div className="px-3 pt-2 pb-1">
                                <div className="h-1 rounded-full bg-slate-100 overflow-hidden">
                                    <div className="h-full w-1/2 bg-slate-300 animate-pulse" />
                                </div>
                            </div>
                        ) : null}

                        <div className="flex items-center justify-between px-3 py-2">
                            {openUrl ? (
                                <button
                                    type="button"
                                    onClick={() => onOpen(att)}
                                    className="text-[10px] font-medium text-slate-600 hover:text-slate-900 underline-offset-2 hover:underline"
                                    aria-label={`打开${label}原页面`}
                                >
                                    打开原页面
                                </button>
                            ) : (
                                <span className="text-[10px] text-slate-300">无安全跳转地址</span>
                            )}
                            {failed ? (
                                <button
                                    type="button"
                                    onClick={() => onRetry(att)}
                                    disabled={busy === att.shareRef}
                                    className="text-[10px] font-medium text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
                                    aria-label={`重试读取${label}内容`}
                                >
                                    {busy === att.shareRef ? '重试中…' : '重试'}
                                </button>
                            ) : null}
                        </div>
                    </div>
                );
            })}
            {error ? <div className="text-[10px] text-rose-500">{error}</div> : null}
        </div>
    );
};

export default React.memo(SocialShareCard);
