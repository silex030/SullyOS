// features/friend-feed/FriendFeedView.tsx
// 哔哔（本地 FriendFeed）UI：纯展示 + 回调，不直连存储/网络/LLM。
// 风格按 docs/design-system.md：浅玻璃卡片、rounded-3xl、shadow-sm、
// animate-fade-in 进入、active:scale 轻压；移动端单列、桌面端 max-w-2xl 居中。
import * as React from 'react';
import {
    Bell,
    ChatCircle,
    Download,
    Heart,
    Image as ImageIcon,
    PaperPlaneTilt,
    Trash,
    Upload,
} from '@phosphor-icons/react';
import { MAX_IMAGES_PER_POST } from './limits.js';
import type { FriendFeedIdentity, FriendFeedPost } from './types.js';
import { weiboStatus } from './weibo.js';
import { BibiIcon } from './BibiIcon.js';

export interface FriendFeedViewProps {
    posts: FriendFeedPost[];
    identities: FriendFeedIdentity[];
    currentIdentityId: string;
    unreadCount: number;
    /** 有未读评论的帖子 id（由 getUnread(state, viewerId).postIds 传入）。 */
    unreadPostIds: string[];
    error: string | null;
    isSaving: boolean;
    /** 只读模式（无跨文档写保护时）：禁用一切写入入口，可查看与导出。 */
    readOnly?: boolean;
    /** 图片引用解析（生产接线传 blob→objectURL 解析器；preview 传本地仓解析器）。 */
    resolveImageRef?: (ref: string) => string;
    onSelectIdentity: (id: string) => void;
    /** 成功 resolve 后 View 才清草稿；reject 时草稿保留并显示错误。 */
    onCreatePost: (text: string, files: File[]) => Promise<void>;
    onToggleLike: (postId: string) => void;
    onAddComment: (postId: string, text: string) => Promise<void>;
    onDeletePost: (postId: string) => void;
    /** 显式已读：用户点击“标为已读”时调用，禁止自动推进水位。 */
    onMarkPostRead: (postId: string) => void;
    onExport: () => void;
    onImport: (file: File) => void;
}

function formatTime(ts: number): string {
    try {
        return new Date(ts).toLocaleString();
    } catch {
        return '';
    }
}

function Avatar({ name, src }: { name: string; src: string }) {
    // src 必须是由 resolveImageRef 返回的可渲染 URL（objectURL）或空；
    // 任何持久化不可信引用都解析为空并显示首字占位，绝不直交 img。
    if (src) {
        return <img src={src} alt="" className="h-10 w-10 rounded-full object-cover" />;
    }
    return (
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white/70 text-sm font-bold text-slate-600">
            {(name || '?').slice(0, 1)}
        </span>
    );
}

export function FriendFeedView(props: FriendFeedViewProps) {
    const resolveRef = props.resolveImageRef ?? ((r: string) => r);
    const [draft, setDraft] = React.useState('');
    const [files, setFiles] = React.useState<File[]>([]);
    const [commentDrafts, setCommentDrafts] = React.useState<Record<string, string>>({});
    const [localError, setLocalError] = React.useState<string | null>(null);
    const [previewUrls, setPreviewUrls] = React.useState<string[]>([]);
    const importRef = React.useRef<HTMLInputElement>(null);
    const error = props.error ?? localError;

    React.useEffect(() => {
        const urls = files.map((f) => URL.createObjectURL(f));
        setPreviewUrls(urls);
        return () => {
            for (const u of urls) URL.revokeObjectURL(u);
        };
    }, [files]);

    const submit = async () => {
        setLocalError(null);
        if (props.readOnly) {
            setLocalError('只读模式：当前环境没有跨文档写保护，写入已禁用以保护旧数据');
            return;
        }
        if (!draft.trim()) {
            setLocalError('写点什么再发布吧');
            return;
        }
        try {
            await props.onCreatePost(draft, files);
            // 只有持久化成功才清草稿；失败时保留输入供重试。
            setDraft('');
            setFiles([]);
        } catch (e) {
            setLocalError(e instanceof Error ? e.message : String(e));
        }
    };

    const submitComment = async (postId: string) => {
        const text = (commentDrafts[postId] ?? '').trim();
        if (!text) return;
        if (props.readOnly) {
            setLocalError('只读模式：当前环境没有跨文档写保护，写入已禁用以保护旧数据');
            return;
        }
        try {
            await props.onAddComment(postId, text);
            setCommentDrafts((d) => ({ ...d, [postId]: '' }));
        } catch (e) {
            setLocalError(e instanceof Error ? e.message : String(e));
        }
    };

    const like = async (postId: string) => {
        if (props.readOnly) {
            setLocalError('只读模式：当前环境没有跨文档写保护，写入已禁用以保护旧数据');
            return;
        }
        try {
            await props.onToggleLike(postId);
        } catch (e) {
            setLocalError(e instanceof Error ? e.message : String(e));
        }
    };

    const markRead = async (postId: string) => {
        if (props.readOnly) {
            setLocalError('只读模式：当前环境没有跨文档写保护，写入已禁用以保护旧数据');
            return;
        }
        try {
            await props.onMarkPostRead(postId);
        } catch (e) {
            setLocalError(e instanceof Error ? e.message : String(e));
        }
    };

    const remove = async (postId: string) => {
        if (props.readOnly) {
            setLocalError('只读模式：当前环境没有跨文档写保护，写入已禁用以保护旧数据');
            return;
        }
        try {
            await props.onDeletePost(postId);
        } catch (e) {
            setLocalError(e instanceof Error ? e.message : String(e));
        }
    };

    const triggerImport = () => {
        if (props.readOnly) {
            setLocalError('只读模式：当前环境没有跨文档写保护，写入已禁用以保护旧数据');
            return;
        }
        importRef.current?.click();
    };

    const handleImportFile = async (f: File) => {
        if (props.readOnly) {
            setLocalError('只读模式：当前环境没有跨文档写保护，写入已禁用以保护旧数据');
            return;
        }
        try {
            await props.onImport(f);
        } catch (e) {
            setLocalError(e instanceof Error ? e.message : String(e));
        }
    };

    const current = props.identities.find((i) => i.id === props.currentIdentityId);

    return (
        <div className="flex-1 overflow-y-auto p-5 no-scrollbar">
            <div className="mx-auto w-full max-w-2xl space-y-4">
                {/* 顶栏：浅玻璃 */}
                <div className="flex items-center gap-3 rounded-3xl border border-white/40 bg-white/70 px-4 py-3 shadow-sm backdrop-blur-md">
                    <span className="text-sky-600">
                        <BibiIcon size={24} />
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="text-base font-bold text-slate-800">哔哔</div>
                        <div className="truncate text-xs text-slate-500">本地动态 · 仅此设备可见</div>
                    </div>
                    {props.unreadCount > 0 && (
                        <span className="flex items-center gap-1 rounded-full bg-rose-100 px-2 py-1 text-xs font-bold text-rose-600">
                            <Bell size={13} weight="bold" />
                            {props.unreadCount}
                        </span>
                    )}
                    <select
                        aria-label="发帖身份"
                        value={props.currentIdentityId}
                        onChange={(e) => props.onSelectIdentity(e.target.value)}
                        className="max-w-[8rem] truncate rounded-xl border border-white/60 bg-white/80 px-2 py-1.5 text-sm text-slate-700"
                    >
                        {props.identities.map((i) => (
                            <option key={i.id} value={i.id}>
                                {i.name}
                            </option>
                        ))}
                    </select>
                </div>

                {/* 微博降级提示（未接入，不伪装） */}
                <div className="rounded-2xl border border-white/40 bg-white/50 px-4 py-2 text-xs text-slate-500 backdrop-blur-md">
                    {weiboStatus().reason}
                </div>

                {/* 发布器 */}
                <div className="space-y-3 rounded-3xl border border-white/60 bg-white/80 p-4 shadow-sm backdrop-blur-xl">
                    <div className="flex items-center gap-2 text-sm text-slate-600">
                        <Avatar name={current?.name ?? '?'} src={resolveRef(current?.avatar ?? '')} />
                        <span>
                            以 <b>{current?.name ?? '未知身份'}</b> 的身份发布
                        </span>
                    </div>
                    <textarea
                        aria-label="写动态"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
                        placeholder="分享此刻的想法…"
                        rows={3}
                        className="w-full resize-none rounded-2xl border border-white/60 bg-white/70 p-3 text-sm text-slate-800 placeholder:text-slate-400"
                    />
                    {previewUrls.length > 0 && (
                        <div className="grid grid-cols-4 gap-2">
                            {previewUrls.map((u, i) => (
                                <img key={i} src={u} alt="待发布配图预览" className="aspect-square rounded-xl object-cover" />
                            ))}
                        </div>
                    )}
                    <div className="flex items-center gap-2">
                        <label className="flex cursor-pointer items-center gap-1 rounded-xl bg-white/70 px-3 py-1.5 text-sm text-slate-600 transition active:scale-95">
                            <ImageIcon size={16} />
                            图片
                            <input
                                type="file"
                                accept="image/png,image/jpeg,image/gif,image/webp"
                                multiple
                                className="hidden"
                                onChange={(e) => {
                                    const picked = Array.from(e.target.files ?? []);
                                    if (picked.length > MAX_IMAGES_PER_POST) {
                                        setLocalError(`图片最多 ${MAX_IMAGES_PER_POST} 张`);
                                        return;
                                    }
                                    setFiles(picked);
                                    e.target.value = '';
                                }}
                            />
                        </label>
                        <span className="text-xs text-slate-400">最多 {MAX_IMAGES_PER_POST} 张</span>
                        <span className="flex-1" />
                        <button
                            type="button"
                            disabled={props.isSaving || props.readOnly}
                            onClick={submit}
                            className="flex items-center gap-1 rounded-xl bg-sky-500 px-4 py-1.5 text-sm font-bold text-white shadow-sm transition active:scale-95 disabled:opacity-50"
                        >
                            <PaperPlaneTilt size={15} weight="bold" />
                            发布
                        </button>
                    </div>
                    {error && <div className="text-sm text-rose-600">{error}</div>}
                </div>

                {/* 动态流 */}
                {props.posts.length === 0 ? (
                    <div className="mx-auto max-w-sm rounded-3xl border border-white/60 bg-white/70 p-8 text-center text-sm text-slate-500 shadow-sm backdrop-blur-xl">
                        这里空空如也，发第一条哔哔吧
                    </div>
                ) : (
                    props.posts.map((p) => (
                        <article
                            key={p.id}
                            className="animate-fade-in space-y-3 rounded-3xl border border-white/60 bg-white/80 p-4 shadow-sm backdrop-blur-xl"
                        >
                            <div className="flex items-center gap-2">
                                <Avatar name={p.authorName} src={resolveRef(p.authorAvatar)} />
                                <div className="min-w-0 flex-1">
                                    <div className="truncate text-sm font-bold text-slate-800">{p.authorName}</div>
                                    <div className="text-xs text-slate-400">{formatTime(p.createdAt)}</div>
                                </div>
                                {p.authorId === props.currentIdentityId && (
                                    <button
                                        type="button"
                                        aria-label="删除动态"
                                        disabled={props.readOnly}
                                        onClick={() => void remove(p.id)}
                                        className="rounded-xl p-1.5 text-slate-400 transition active:scale-90 disabled:opacity-40"
                                    >
                                        <Trash size={16} />
                                    </button>
                                )}
                            </div>
                            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-800">{p.text}</p>
                            {p.imageRefs.length > 0 && (
                                <div className="grid grid-cols-2 gap-2">
                                    {p.imageRefs.map((r, i) => {
                                        const src = resolveRef(r);
                                        // 解析中（本地仓异步加载）先占位，避免空 src 触发 onError 被永久隐藏。
                                        if (!src) {
                                            return (
                                                <div
                                                    key={i}
                                                    aria-label={`动态配图${i + 1}加载中`}
                                                    className="aspect-square w-full animate-pulse rounded-2xl bg-white/60"
                                                />
                                            );
                                        }
                                        return (
                                            <img
                                                key={i}
                                                src={src}
                                                alt={`动态配图${i + 1}`}
                                                loading="lazy"
                                                className="aspect-square w-full rounded-2xl object-cover"
                                                onError={(e) => {
                                                    ((e.target as HTMLImageElement).style.display = 'none');
                                                }}
                                            />
                                        );
                                    })}
                                </div>
                            )}
                            <div className="flex items-center gap-3 text-sm">
                                <button
                                    type="button"
                                    disabled={props.readOnly}
                                    onClick={() => void like(p.id)}
                                    className={`flex items-center gap-1 rounded-xl px-2 py-1 transition active:scale-90 disabled:opacity-40 ${
                                        p.likedByMe ? 'text-rose-500' : 'text-slate-400'
                                    }`}
                                >
                                    <Heart size={16} weight={p.likedByMe ? 'fill' : 'regular'} />
                                    {p.likeCount > 0 ? p.likeCount : '赞'}
                                </button>
                                <span className="flex items-center gap-1 text-slate-400">
                                    <ChatCircle size={16} />
                                    {p.comments.length > 0 ? p.comments.length : '评论'}
                                </span>
                                {props.unreadPostIds.includes(p.id) && (
                                    <button
                                        type="button"
                                        disabled={props.readOnly}
                                        onClick={() => void markRead(p.id)}
                                        className="ml-auto rounded-xl bg-rose-50 px-2 py-1 text-xs font-bold text-rose-600 transition active:scale-90 disabled:opacity-40"
                                    >
                                        有新评论，标为已读
                                    </button>
                                )}
                            </div>
                            {p.comments.length > 0 && (
                                <div className="space-y-1.5 rounded-2xl bg-white/60 p-3">
                                    {p.comments.map((c) => (
                                        <div key={c.id} className="text-sm">
                                            <span className="font-bold text-slate-700">{c.authorName}</span>
                                            <span className="text-slate-500">：</span>
                                            <span className="break-words text-slate-700">{c.text}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                            <div className="flex items-center gap-2">
                                <input
                                    aria-label="写评论"
                                    value={commentDrafts[p.id] ?? ''}
                                    onChange={(e) => setCommentDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                                    placeholder={`以${current?.name ?? ''}的身份评论…`}
                                    className="min-w-0 flex-1 rounded-xl border border-white/60 bg-white/70 px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400"
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') submitComment(p.id);
                                    }}
                                />
                                <button
                                    type="button"
                                    disabled={props.readOnly}
                                    onClick={() => submitComment(p.id)}
                                    className="rounded-xl bg-slate-700 px-3 py-1.5 text-sm font-bold text-white transition active:scale-95 disabled:opacity-40"
                                >
                                    发送
                                </button>
                            </div>
                        </article>
                    ))
                )}

                {/* 模块备份出入口（文本 JSON，不含凭据） */}
                <div className="flex items-center gap-2 pb-2">
                    <button
                        type="button"
                        onClick={props.onExport}
                        className="flex items-center gap-1 rounded-xl bg-white/70 px-3 py-1.5 text-xs text-slate-600 shadow-sm transition active:scale-95"
                    >
                        <Download size={14} />
                        导出本模块备份
                    </button>
                    <button
                        type="button"
                        disabled={props.readOnly}
                        onClick={triggerImport}
                        className="flex items-center gap-1 rounded-xl bg-white/70 px-3 py-1.5 text-xs text-slate-600 shadow-sm transition active:scale-95 disabled:opacity-40"
                    >
                        <Upload size={14} />
                        导入本模块备份
                    </button>
                    <input
                        ref={importRef}
                        type="file"
                        accept="application/json"
                        className="hidden"
                        disabled={props.readOnly}
                        onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) void handleImportFile(f);
                            e.target.value = '';
                        }}
                    />
                </div>
            </div>
        </div>
    );
}
