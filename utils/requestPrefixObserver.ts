import { compareCapturedRequests, stableFingerprint, type CapturedChatRequest, type RequestPrefixReport } from './promptCacheDiagnostics';

type RequestShape = CapturedChatRequest & { model?: unknown; [key: string]: unknown };
export interface FinalRequestPrefixDiagnostic {
    kind: 'structure_only';
    firstSystemFingerprint: string;
    toolsFingerprint: string;
    comparison: RequestPrefixReport | null;
    baselineRetained: boolean;
}

/** 仅内存保留少量上次输入用于结构比较；绝不持久化/上报正文或凭据。 */
export function createRequestPrefixObserver(options: { maxBytes?: number; maxScopes?: number } = {}) {
    const previous = new Map<string, CapturedChatRequest>();
    const maxBytes = options.maxBytes ?? 512_000;
    const maxScopes = options.maxScopes ?? 8;
    return {
        observe(scope: string, route: string, body: RequestShape): FinalRequestPrefixDiagnostic {
            const key = JSON.stringify([scope, route, typeof body.model === 'string' ? body.model : '']);
            const current: CapturedChatRequest = { messages: body.messages ?? [], tools: body.tools ?? [] };
            const serialized = JSON.stringify(current);
            const old = previous.get(key);
            const comparison = old ? compareCapturedRequests(old, current) : null;
            const baselineRetained = new TextEncoder().encode(serialized).length <= maxBytes;
            previous.delete(key);
            if (baselineRetained) previous.set(key, JSON.parse(serialized));
            while (previous.size > maxScopes) previous.delete(previous.keys().next().value!);
            return {
                kind: 'structure_only',
                firstSystemFingerprint: stableFingerprint(JSON.stringify(current.messages?.[0] ?? null)),
                toolsFingerprint: stableFingerprint(JSON.stringify(current.tools)),
                comparison, baselineRetained,
            };
        },
        clear() { previous.clear(); },
    };
}

const observer = createRequestPrefixObserver();
/** 返回实际发送body，调用者不需要重建它；只发布无正文的结构事件。 */
export function observeFinalChatRequest(scope: string, route: string, body: RequestShape): RequestShape {
    try {
        const detail = observer.observe(scope, route, body);
        if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('sullyos:prompt-cache-structure', { detail }));
    } catch {
        // 诊断失败不影响聊天；不打印可能带敏感正文的异常对象。
    }
    return body;
}
