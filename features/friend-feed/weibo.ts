// features/friend-feed/weibo.ts
// 微博只读时间线适配器占位（后续自托管代理接线范围）。
// 首批实现：明确未配置、可降级；不发起任何网络请求、不存任何凭据、不伪造已连接。

export interface WeiboAdapterStatus {
    configured: false;
    /** 固定降级原因，供 UI 直接展示，不编造连接态。 */
    reason: string;
    proxyEndpoint: null;
}

export interface WeiboTimelineItem {
    id: string;
    text: string;
    createdAt: number;
}

export function weiboStatus(): WeiboAdapterStatus {
    return {
        configured: false,
        reason: '微博只读时间线尚未接入（需要自托管代理 /weibo，首批仅本地动态可用）',
        proxyEndpoint: null,
    };
}

/** 未配置时直接拒绝；有朝一日接线后由后续卡片实现真正的 adapter（本卡不做）。 */
export async function listWeiboTimeline(): Promise<WeiboTimelineItem[]> {
    throw new Error('weibo proxy not configured: 只读时间线尚未接入，本地动态不受影响');
}
