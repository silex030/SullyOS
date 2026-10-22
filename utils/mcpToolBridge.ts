/**
 * 通用 MCP → 聊天工具循环 的桥接层（对标 luckinToolBridge 的角色分工）
 *
 * 职责：
 * 1. 把所有启用 MCP 服务器的已发现工具聚合成 OpenAI function-calling 格式
 * 2. 生成注入 systemPrompt 的说明块与尾部提醒
 * 3. 中转不认 function calling 时的兼容兜底（降级请求体、前置气泡粗洗）
 * 重名映射和正文假调用解析住在 mcpFireCore（浏览器与 amsg worker 共用）。
 * 工具循环本体在 hooks/useChatAI.ts（对标 luckinChat 循环）。
 */

import { getEnabledMcpServers, type McpServerConfig, type McpToolDef } from './mcpClient';
import { buildMcpNameMap, type FakedMcpCall as FakedMcpCallCore, type McpResolvedToolCore } from './mcpFireCore';

// 结果格式化和正文假调用解析都是纯逻辑，住在 mcpFireCore 里给浏览器和 amsg
// worker 共用；这里按原名转出来，调用方的引用路径不用动。
export {
    MCP_RESULT_MAX_CHARS,
    formatMcpToolResult,
    stripTextFakedMcpCalls,
    extractTextFakedMcpCalls,
} from './mcpFireCore';

export interface OpenAIMcpTool {
    type: 'function';
    function: {
        name: string;
        description?: string;
        parameters?: any;
    };
}

/**
 * 前台 MCP 工具循环硬上限。不是固定调用次数：模型正常回复会立即退出；只有仍在调用工具
 * 才继续，连续原地重复则提前收束。游戏/论坛类多步任务最多可推进到 12 轮。
 */
export const MCP_CHAT_MAX_TOOL_LOOPS = 12;
export const MCP_CHAT_MAX_STALLED_ROUNDS = 2;

/** 名映射条目，server 收窄成前台的完整配置类型（含 proxyUrl 等浏览器侧字段） */
export type ResolvedMcpTool = McpResolvedToolCore<McpServerConfig>;

/** 正文假调用条目，server 收窄成前台完整配置（callMcpTool 要 proxyUrl/proxyKey） */
export type FakedMcpCall = FakedMcpCallCore<McpServerConfig>;

/**
 * 聚合启用服务器的工具，返回 OpenAI 工具数组 + 暴露名→真实工具 的映射。
 * 暴露名（含重名前缀、非法字符替换）统一由 mcpFireCore.buildMcpNameMap 算，
 * 保证前台聊天和 amsg worker 后台 fire 看到的是同一套工具名。
 * charId：只聚合对该角色可见的服务器（通用 + 绑定了该角色的）。
 *
 * 懒加载（opts.lazy）：请求只注入「名字 + 摘要 + 宽松参数」的 stub——工具清单长的
 * 时候完整 schema 会占掉大量 token；模型第一次就能给出参数，参数能否通过完整
 * schema 校验由 useChatAI 判断，失败再带完整 schema 二次请求重填（expandTools）。
 */
export interface BuildMcpOpenAIToolsOpts {
    /** 懒加载 stub 模式；调用方不传 = 完整 schema（原行为） */
    lazy?: boolean;
    /** 需要展开完整 schema 的暴露名清单（二次请求重填参数用；懒加载关闭时忽略） */
    expandTools?: string[];
}

/** 懒加载摘要默认长度（工具 description 截取），超过提示模型可要求展开 */
const LAZY_DESC_MAX = 80;
/** 懒加载宽松参数 schema：模型把参数塞进 args 对象，校验层负责按真实 schema 还原 */
const LAZY_STUB_PARAMETERS = { type: 'object', additionalProperties: true } as const;

/**
 * 规范化 schema 的对象键序（深拷贝，数组顺序原样保留）。
 *
 * 为什么要做：供应商通常把工具定义算进输入上下文，而 JSON 对象的键序取决于「当时怎么拼出来的」。
 * 同一台服务器重新发现工具、或上游返回字段顺序不同，就可能让 schema 的字节序列变化，
 * 白白打断前缀复用。只排对象键——enum / required / oneOf 这类数组的顺序有语义，排序会改含义。
 */
const canonicalSchema = (value: any): any => {
    if (Array.isArray(value)) return value.map(canonicalSchema);
    if (value && typeof value === 'object') {
        const out: Record<string, any> = {};
        for (const key of Object.keys(value).sort()) out[key] = canonicalSchema(value[key]);
        return out;
    }
    return value;
};

/**
 * 名字映射的输入规范化：每台服务器内部的工具按原名排。
 *
 * 为什么不排服务器：跨服务器重名时「先占先得」的归属今天由**配置顺序**决定（用户可持久化、
 * 已被云端/历史引用）。改成按 id 排会让裸名换主，等于悄悄改工具名指向 —— 属于功能性变更，
 * 不是缓存优化能顺手做的（审计明确提醒过）。所以这里只消除「发现返回顺序」这个真正的随机源：
 * 同一台服务器本次发现先给 b 后给 a，映射结果必须一样。
 * 输出数组另外按暴露名排序（见 buildMcpOpenAITools），顺序稳定与归属稳定分开处理。
 */
const canonicalServers = (servers: McpServerConfig[]): McpServerConfig[] =>
    servers.map(server => ({
        ...server,
        tools: [...(server.tools || [])].sort((a, b) => `${a.name}`.localeCompare(`${b.name}`)),
    }));

export const buildMcpOpenAITools = (
    charId?: string,
    opts: BuildMcpOpenAIToolsOpts = {},
): { tools: OpenAIMcpTool[]; resolve: Map<string, ResolvedMcpTool> } => {
    const servers = canonicalServers(getEnabledMcpServers(charId));
    const resolve: Map<string, ResolvedMcpTool> = buildMcpNameMap(servers);
    const tools: OpenAIMcpTool[] = [];
    const multi = servers.length > 1;
    const expand = new Set(opts.expandTools || []);
    // 输出按暴露名排序：工具集合相同、发现顺序不同时，数组逐项一致（前缀缓存稳定）。
    const ordered = [...resolve.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [exposed, { server, tool }] of ordered) {
        const lazyStub = !!opts.lazy && !expand.has(exposed);
        tools.push({
            type: 'function',
            function: {
                name: exposed,
                description: lazyStub
                    ? buildLazyDescription(server, tool, multi)
                    : buildToolDescription(server, tool, multi),
                parameters: lazyStub
                    ? LAZY_STUB_PARAMETERS
                    : canonicalSchema(tool.inputSchema || { type: 'object', properties: {} }),
            },
        });
    }
    return { tools, resolve };
};

/** 懒加载 stub 的描述：自定义摘要优先，缺省用工具 description 截断 + 展开提示 */
const buildLazyDescription = (server: McpServerConfig, t: McpToolDef, multi: boolean): string => {
    const custom = (server.toolSummaries || {})[t.name]?.trim();
    const base = custom || (t.description || '').trim().slice(0, LAZY_DESC_MAX);
    const suffix = base.length < ((t.description || '').trim().length) && !custom
        ? '…' : '';
    const source = multi ? `[${server.name}] ` : '';
    return `${source}${base}${suffix}（参数可先用宽松对象 {args:{...}} 传；若参数不符合要求，系统会要求你按完整 schema 重填）`;
};

const buildToolDescription = (server: McpServerConfig, t: McpToolDef, multi: boolean): string => {
    const desc = (t.description || '').trim();
    // 多服务器时在描述里带上来源，帮模型区分同类工具
    return multi ? `[${server.name}] ${desc}` : desc;
};

// ========== 提示词 ==========

/**
 * MCP 工具模式的 systemPrompt 说明块。
 * 与瑞幸不同：这里的工具是用户自配的、内容未知，所以只讲纪律，不讲业务流程。
 * charId：只列对该角色可见的服务器，与 buildMcpOpenAITools 的过滤保持一致。
 */
export const buildMcpSystemBlock = (userName: string = '用户', charId?: string): string => {
    const servers = canonicalServers(getEnabledMcpServers(charId));
    if (!servers.length) return '';
    // 清单与真实 tools 同源排序（暴露名）：两处顺序不一致时模型会对不上名字。
    const resolve = buildMcpNameMap(servers);
    const exposedByServer = new Map<string, Array<{ exposed: string; toolName: string }>>();
    for (const [exposed, { server, toolName }] of resolve) {
        const list = exposedByServer.get(server.id) || [];
        list.push({ exposed, toolName });
        exposedByServer.set(server.id, list);
    }
    const lines = servers.map(s => {
        const names = (exposedByServer.get(s.id) || [])
            .sort((a, b) => a.exposed.localeCompare(b.exposed))
            .map(entry => entry.toolName)
            .join('、');
        return `- ${s.name}: ${names}`;
    });
    // 清单只是给人看的列表：按服务器名排一遍，配置顺序变化不会重排这段稳定前缀。
    // （真实 tools 数组的归属仍按配置顺序，见 canonicalServers 的说明。）
    lines.sort((a, b) => a.localeCompare(b));
    return `

---
[外部工具已接入 —— ${userName} 在设置里给你连了 MCP 工具服务器]

**核心**: 你还是原来的角色、原来的语气、原来的记忆。工具只是你顺手能用的能力，**每轮都要有角色化的文字**，别干巴巴报结果。

可用工具来源:
${lines.join('\n')}

**使用纪律**:
- 需要时直接调工具（系统会自动执行并把结果给你），不需要时正常聊天，**别硬找理由调工具**。
- 用户明确要求完成游戏、论坛或其他多步任务时，先做必要检查，随后立刻调用能推进目标的动作工具；不要反复读取同一份说明或状态。执行动作后可以再次检查新状态，并继续到目标完成或工具明确失败。
- 工具必须通过系统的 function calling 接口发起，**绝对不要把工具名和参数写进聊天正文**（比如输出 \`工具名(参数)\` 这种文字），用户会看到乱码一样的东西。
- 工具结果只挑与对话相关的部分用角色语气转述，别整段复读 JSON。
- 工具失败就如实说，并根据报错调整参数重试或换个方式，别编造结果。
- 涉及真实世界副作用的操作（发布内容、下单、删除等），若 ${userName} 本轮已经明确要求执行，即视为已经确认；没有明确要求时才先确认一句再动手。
---
`;
};

/** 尾部小提醒（注入 messages 末尾，防长对话把纪律冲掉） */
export const MCP_TAIL_REMINDER = `[MCP 工具 ON · 永远用角色语气回复别空回; 工具只能走 function calling 接口、严禁写成正文文字; 工具结果别复读 JSON; 用户本轮已明确要求的操作视为已确认，否则副作用操作先确认]`;

// ========== 掉格式容错: 正文里的"假工具调用"（解析本体见 mcpFireCore） ==========

/**
 * MCP 工具前置气泡专用粗洗。该气泡在统一后处理之前落库，必须自行清掉模型
 * 复刻的历史外壳和思考标签；不能把“用户发送了表情包”反向变成角色消息。
 */
export const sanitizeMcpLeadInText = (raw: string): string => {
    let cleaned = raw || '';
    cleaned = cleaned.replace(/<(think|thinking|thought)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    cleaned = cleaned.replace(/<(?:think|thinking|thought)\b[^>]*>[\s\S]*$/gi, '');
    cleaned = cleaned.replace(/<\/?(?:think|thinking|thought)\b[^>]*>/gi, '');
    cleaned = cleaned.replace(/\[(?:你|User|用户|System)\s*发送了表情包[:：]\s*.*?\]/gi, '');
    cleaned = cleaned.replace(/\[\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[^\]]*\]/g, '');
    cleaned = cleaned.replace(/\s*\[(?:聊天|通话|约会)\]\s*/g, '\n');
    return cleaned.replace(/\n{3,}/g, '\n\n').trim();
};

/**
 * 正文假调用已经由客户端代为执行，下一跳只负责把结果组织成角色回复。
 * 这里必须移除 tools；否则部分中转会在这一跳改走正规 tool_calls，返回空正文，
 * 而正规工具循环阶段已经结束，最终表现就是角色一直打字后不落消息。
 * 不支持 FC 的模型仍可继续输出正文假调用，并由同一兜底循环处理多步任务。
 */
export const buildMcpTextFallbackBody = (baseReqBody: any, messages: any[]): any => {
    const followBody = { ...baseReqBody, messages };
    delete followBody.tools;
    delete followBody.tool_choice;
    return followBody;
};

/** tools 被中转拒绝时，把最小 schema 仅作为本轮兼容说明交给正文调用兜底。 */
export const buildMcpRejectedToolsFallbackBody = (baseReqBody: any): any => {
    const followBody = buildMcpTextFallbackBody(baseReqBody, baseReqBody.messages || []);
    const signatures = (baseReqBody.tools || []).map((tool: any) => {
        const fn = tool?.function || {};
        const schema = fn.parameters || {};
        const required = new Set(Array.isArray(schema.required) ? schema.required : []);
        const args = Object.entries(schema.properties || {}).map(([name, def]: [string, any]) =>
            `${name}${required.has(name) ? '*' : ''}:${def?.type || 'any'}`,
        );
        const description = typeof fn.description === 'string' ? fn.description.trim() : '';
        return `- ${fn.name}(${args.join(', ')})${description ? `：${description}` : ''}`;
    }).filter(Boolean);
    followBody.messages = [...followBody.messages, {
        role: 'system',
        content: `[MCP 兼容模式：当前 API 中转拒绝 function calling 参数。必须根据下方工具的来源、描述和参数选择真正匹配用户意图的工具，禁止因为名字看起来通用就乱选。每一步如果需要工具，只输出一行 tool_name({"参数":"值"})，系统会代为执行后把结果给你；收到结果后，若任务还没完成就选择下一步真正能推进目标的工具，不要反复读取同一份说明或状态。没有收到系统返回前不要声称工具已经成功，也不要自行编造结果。* 表示必填参数。\n${signatures.join('\n')}]`,
    }];
    return followBody;
};

/** 部分 OpenAI 兼容中转不是忽略 tools，而是直接用 4xx 拒绝整次请求。 */
export const shouldRetryMcpWithoutTools = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error || '');
    return /(?:^|\D)(?:400|401|403|422)(?:\D|$)/.test(message);
};
