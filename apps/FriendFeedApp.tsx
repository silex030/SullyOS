// apps/FriendFeedApp.tsx
// 哔哔（本地 FriendFeed）真实 App 入口：唯一生产接线层。
// - 身份来自真实 userProfile + characters，经 buildIdentityList 映射；
//   用户本人固定首位，提醒 id 用设备主人常量 'me'（稳定，不随发帖身份切换改变，
//   与 preview 的 user-1/南南/北北无关；UserProfile 本就没有 id 字段，此处不发明 API）。
// - 文本走真实生产端口 makeAssetStoragePort({getAsset:DB.getAsset,saveAsset:DB.saveAsset})
//   （assets store key=friend_feed_v1）；图片走 makeBlobAssetImagePort()（blob_assets）。
// - 无 Web Locks 即真实只读（controller 缺省探测，不用测试锁/realm 队列冒充）。
// - 打开/刷新/定时零模型调用；Weibo 未配置只展示未配置，不伪造连接。
// - 明确这是本地动态，不暗示跨设备云同步。
import * as React from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { FriendFeedView } from '../features/friend-feed/FriendFeedView';
import { FeedController, NoSafeWriteError } from '../features/friend-feed/controller';
import { makeAssetStoragePort, makeBlobAssetImagePort } from '../features/friend-feed/service';
import { resolveBibiImageMap } from '../features/friend-feed/bibiImageMap';
import { buildIdentityList } from '../features/friend-feed/identities';
import { exportBackup, parseBackup } from '../features/friend-feed/backup';
import { saveProductionFeed } from '../features/friend-feed/service';
import type { FriendFeedIdentity, FriendFeedPost } from '../features/friend-feed/types';

/** 设备主人的提醒 id：应用级常量，稳定且不随发帖身份切换改变。 */
export const BIBI_OWNER_ID = 'me';

export default function FriendFeedApp() {
    const { userProfile, characters } = useOS();
    const [posts, setPosts] = React.useState<FriendFeedPost[]>([]);
    const [identities, setIdentities] = React.useState<FriendFeedIdentity[]>([]);
    const [currentIdentityId, setCurrentIdentityId] = React.useState<string>(BIBI_OWNER_ID);
    const [unreadCount, setUnreadCount] = React.useState(0);
    const [unreadPostIds, setUnreadPostIds] = React.useState<string[]>([]);
    const [error, setError] = React.useState<string | null>(null);
    const [isSaving, setIsSaving] = React.useState(false);
    const [readOnly, setReadOnly] = React.useState(false);
    const [imgUrls, setImgUrls] = React.useState<Record<string, string>>({});
    const ctrlRef = React.useRef<FeedController | null>(null);
    const aliveRef = React.useRef(true);
    // StrictMode(dev) 会“挂载→卸载→重挂载”跑一遍 effect：cleanup 把存活标记打成 false 后，
    // 重挂载的 setup 必须重新置 true，否则提交/导入后的缓存同步被永久跳过（isSaving 卡死）。
    React.useEffect(() => {
        aliveRef.current = true;
        return () => { aliveRef.current = false; };
    }, []);

    const refreshFrom = React.useCallback((c: FeedController, viewerId: string) => {
        setPosts([...c.state.posts]);
        const u = c.getUnread(viewerId);
        setUnreadCount(u.count);
        setUnreadPostIds(u.postIds);
    }, []);

    React.useEffect(() => {
        let cancelled = false;
        (async () => {
            const list = buildIdentityList({
                user: { id: BIBI_OWNER_ID, name: userProfile?.name || '我', avatar: userProfile?.avatar || '' },
                characters: (characters ?? []).map((c) => ({ id: c.id, name: c.name, avatar: c.avatar })),
            });
            const ctrl = new FeedController(
                makeAssetStoragePort({ getAsset: DB.getAsset, saveAsset: DB.saveAsset }),
                makeBlobAssetImagePort(),
            );
            ctrlRef.current = ctrl;
            try {
                await ctrl.load();
            } catch (e) {
                if (!cancelled) {
                    setError(e instanceof Error ? e.message : String(e));
                    setReadOnly(true);
                }
                return;
            }
            if (cancelled) return;
            if (!ctrl.writable) {
                setReadOnly(true);
                setError('当前环境没有跨文档写保护，已进入只读模式：可查看与导出，写入已禁用以保护旧数据');
            }
            setIdentities(list);
            setCurrentIdentityId((prev) => (list.some((i) => i.id === prev) ? prev : list[0].id));
            refreshFrom(ctrl, BIBI_OWNER_ID);
            const refs = [...new Set(ctrl.state.posts.flatMap((p) => p.imageRefs))];
            if (refs.length > 0) {
                try {
                    const map = await resolveBibiImageMap(refs, undefined, { isCancelled: () => cancelled || !aliveRef.current });
                    if (cancelled || !aliveRef.current) {
                        Object.values(map).forEach((u) => { try { URL.revokeObjectURL(u); } catch { /* ignore */ } });
                        return;
                    }
                    setImgUrls(map);
                } catch { /* 图片解析失败不影响文字展示 */ }
            }
        })().catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
        return () => {
            cancelled = true;
            setImgUrls((prev) => {
                Object.values(prev).forEach((u) => { try { URL.revokeObjectURL(u); } catch { /* ignore */ } });
                return {};
            });
        };
    }, [refreshFrom, userProfile?.name, userProfile?.avatar, characters]);

    const fail = React.useCallback((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setIsSaving(false);
    }, []);

    const handleCreatePost = React.useCallback(async (text: string, files: File[]) => {
        const ctrl = ctrlRef.current;
        if (!ctrl) throw new Error('尚未加载完成');
        const me = identities.find((i) => i.id === currentIdentityId) ?? identities[0];
        if (!me) throw new Error('没有可用身份');
        setIsSaving(true);
        setError(null);
        let createdUrls: string[] = [];
        try {
            await ctrl.submitPost(me, text, files);
            const refs = [...new Set(ctrl.state.posts.flatMap((p) => p.imageRefs))].filter((r) => !imgUrls[r]);
            if (refs.length > 0) {
                try {
                    const map = await resolveBibiImageMap(refs, undefined, { isCancelled: () => !aliveRef.current });
                    createdUrls = Object.values(map);
                    if (!aliveRef.current) return;
                    if (Object.keys(map).length > 0) {
                        setImgUrls((prev) => ({ ...prev, ...map }));
                    }
                } catch { /* ignore */ }
            }
            if (!aliveRef.current) return;
            refreshFrom(ctrl, BIBI_OWNER_ID);
            setIsSaving(false);
        } catch (e) {
            for (const u of createdUrls) { try { URL.revokeObjectURL(u); } catch { /* ignore */ } }
            fail(e);
            throw e;
        }
    }, [currentIdentityId, fail, identities, imgUrls, refreshFrom]);

    const handleAddComment = React.useCallback(async (postId: string, text: string) => {
        const ctrl = ctrlRef.current;
        if (!ctrl) throw new Error('尚未加载完成');
        const me = identities.find((i) => i.id === currentIdentityId) ?? identities[0];
        if (!me) throw new Error('没有可用身份');
        try {
            await ctrl.addComment(postId, me, text);
            refreshFrom(ctrl, BIBI_OWNER_ID);
        } catch (e) {
            fail(e);
            throw e;
        }
    }, [currentIdentityId, fail, identities, refreshFrom]);

    const handleToggleLike = React.useCallback((postId: string) => {
        const ctrl = ctrlRef.current;
        if (!ctrl) return;
        void ctrl.toggleLike(postId).then(() => refreshFrom(ctrl, BIBI_OWNER_ID)).catch(fail);
    }, [fail, refreshFrom]);

    const handleDeletePost = React.useCallback((postId: string) => {
        const ctrl = ctrlRef.current;
        if (!ctrl) return;
        void ctrl.deletePost(postId, currentIdentityId).then(() => refreshFrom(ctrl, BIBI_OWNER_ID)).catch(fail);
    }, [currentIdentityId, fail, refreshFrom]);

    const handleMarkRead = React.useCallback((postId: string) => {
        const ctrl = ctrlRef.current;
        if (!ctrl) return;
        void ctrl.markPostRead(postId).then(() => refreshFrom(ctrl, BIBI_OWNER_ID)).catch(fail);
    }, [fail, refreshFrom]);

    const handleExport = React.useCallback(() => {
        const ctrl = ctrlRef.current;
        if (!ctrl) return;
        const blob = new Blob([JSON.stringify(exportBackup(ctrl.state))], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'bibi-backup.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    }, []);

    const handleImport = React.useCallback((file: File) => {
        void (async () => {
            try {
                const parsed = parseBackup(JSON.parse(await file.text()));
                await saveProductionFeed(parsed);
                const ctrl = ctrlRef.current;
                if (ctrl) {
                    await ctrl.load();
                    refreshFrom(ctrl, BIBI_OWNER_ID);
                    // 导入成功后同步引用→URL 缓存：空缓存打开后导入含已存在 blob 的备份也显示图片。
                    // 逐 ref 一一对应解析（缺失不占位），卸载则回收本次新建 URL。
                    try {
                        const refs = [...new Set(ctrl.state.posts.flatMap((p) => p.imageRefs))];
                        const map = await resolveBibiImageMap(refs, undefined, { isCancelled: () => !aliveRef.current });
                        if (!aliveRef.current) {
                            Object.values(map).forEach((u) => { try { URL.revokeObjectURL(u); } catch { /* ignore */ } });
                            return;
                        }
                        setImgUrls((prev) => {
                            Object.values(prev).forEach((u) => {
                                if (!(Object.values(map) as string[]).includes(u)) {
                                    try { URL.revokeObjectURL(u); } catch { /* ignore */ }
                                }
                            });
                            return map;
                        });
                    } catch { /* 图片解析失败不影响文字恢复 */ }
                }
            } catch (e) {
                fail(e);
            }
        })();
    }, [fail, refreshFrom]);

    return (
        <div className="flex h-full flex-col">
            <div className="px-4 pb-1 pt-3 text-center text-xs text-slate-500">本地动态 · 仅存本机，不跨设备同步</div>
            <div className="min-h-0 flex-1">
                <FriendFeedView
                    posts={posts}
                    identities={identities}
                    currentIdentityId={currentIdentityId}
                    unreadCount={unreadCount}
                    unreadPostIds={unreadPostIds}
                    error={error}
                    isSaving={isSaving}
                    readOnly={readOnly}
                    resolveImageRef={(ref) => imgUrls[ref] ?? ''}
                    onSelectIdentity={setCurrentIdentityId}
                    onCreatePost={handleCreatePost}
                    onToggleLike={handleToggleLike}
                    onAddComment={handleAddComment}
                    onDeletePost={handleDeletePost}
                    onMarkPostRead={handleMarkRead}
                    onExport={handleExport}
                    onImport={handleImport}
                />
            </div>
        </div>
    );
}
