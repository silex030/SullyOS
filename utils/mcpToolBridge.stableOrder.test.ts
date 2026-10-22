import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildMcpOpenAITools, buildMcpSystemBlock } from './mcpToolBridge';
import { canonicalJson } from './promptCacheDiagnostics';

// C8：工具集合相同、只改发现顺序 / 配置顺序时，暴露名映射与 schema 结构必须稳定。
// 供应商通常把工具定义算进输入上下文，工具数组顺序或 schema 键序抖动会打断前缀复用。

const KEY = 'aetheros.mcp.servers';

const server = (id: string, name: string, tools: any[]) => ({
    id, name, url: `https://${id}.example.com/mcp`, enabled: true, tools,
});

const writeServers = (servers: any[]) => localStorage.setItem(KEY, JSON.stringify(servers));

const names = (tools: Array<{ function: { name: string } }>) => tools.map(t => t.function.name);

beforeEach(() => localStorage.removeItem(KEY));
afterEach(() => localStorage.removeItem(KEY));

describe('buildMcpOpenAITools —— 暴露名与 schema 顺序稳定', () => {
    it('同一集合、不同发现顺序 → 工具数组顺序与名称完全一致', () => {
        writeServers([server('mcp-1', '笔记台', [
            { name: 'b_search', description: 'b', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
            { name: 'a_read', description: 'a', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
        ])]);
        const first = buildMcpOpenAITools('c1');

        writeServers([server('mcp-1', '笔记台', [
            { name: 'a_read', description: 'a', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
            { name: 'b_search', description: 'b', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
        ])]);
        const second = buildMcpOpenAITools('c1');

        expect(names(first.tools)).toEqual(['a_read', 'b_search']);
        expect(canonicalJson(first.tools)).toBe(canonicalJson(second.tools));
    });

    it('跨服务器重名的归属仍按配置顺序（不悄悄改工具名指向），但输出数组顺序稳定', () => {
        const dup = (id: string, name: string) => server(id, name, [
            { name: 'get_weather', description: `${name} 的天气`, inputSchema: { type: 'object', properties: {} } },
        ]);
        writeServers([dup('mcp-b', '乙台'), dup('mcp-a', '甲台')]);
        const first = buildMcpOpenAITools('c1');

        writeServers([dup('mcp-a', '甲台'), dup('mcp-b', '乙台')]);
        const second = buildMcpOpenAITools('c1');

        // 顺序：两边都按暴露名排序，不随配置顺序抖动
        expect(names(first.tools)).toEqual([...names(first.tools)].sort());
        expect(names(second.tools)).toEqual([...names(second.tools)].sort());
        expect(names(first.tools)).toHaveLength(2);
        // 归属：沿用「配置顺序第一台」的旧语义（这是用户可持久化、已被引用的事实）
        const bare = [...first.resolve.entries()].find(([exposed]) => exposed === 'get_weather');
        expect(bare?.[1].server.id).toBe('mcp-b');
        const bareAgain = [...second.resolve.entries()].find(([exposed]) => exposed === 'get_weather');
        expect(bareAgain?.[1].server.id).toBe('mcp-a');
    });

    it('schema 对象键序被规范化，语义数组顺序保留，且不改原对象', () => {
        const inputSchema = {
            type: 'object',
            properties: { zeta: { type: 'string' }, alpha: { type: 'number', enum: [3, 1, 2] } },
            required: ['zeta', 'alpha'],
        };
        const originalJson = JSON.stringify(inputSchema);
        writeServers([server('mcp-1', '工具台', [{ name: 'run', description: 'r', inputSchema }])]);

        const { tools } = buildMcpOpenAITools('c1');
        const params = tools[0].function.parameters as any;

        // 键序（对象的）稳定成字典序
        expect(Object.keys(params)).toEqual(['properties', 'required', 'type']);
        expect(Object.keys(params.properties)).toEqual(['alpha', 'zeta']);
        // 语义数组不动
        expect(params.required).toEqual(['zeta', 'alpha']);
        expect(params.properties.alpha.enum).toEqual([3, 1, 2]);
        // 原对象未被就地修改（否则别的调用方会看到被重排的 schema）
        expect(JSON.stringify(inputSchema)).toBe(originalJson);
    });

    it('工具集合本身变化时如实反映（不能为了稳定把工具吞掉）', () => {
        writeServers([server('mcp-1', '工具台', [
            { name: 'a', description: 'a', inputSchema: { type: 'object', properties: {} } },
            { name: 'b', description: 'b', inputSchema: { type: 'object', properties: {} } },
        ])]);
        expect(names(buildMcpOpenAITools('c1').tools)).toEqual(['a', 'b']);

        writeServers([server('mcp-1', '工具台', [
            { name: 'a', description: 'a', inputSchema: { type: 'object', properties: {} } },
        ])]);
        expect(names(buildMcpOpenAITools('c1').tools)).toEqual(['a']);
    });

    it('懒加载 stub 顺序同样稳定，展开后仍按暴露名排序', () => {
        writeServers([server('mcp-1', '工具台', [
            { name: 'b', description: 'b', inputSchema: { type: 'object', properties: {} } },
            { name: 'a', description: 'a', inputSchema: { type: 'object', properties: {} } },
        ])]);
        const lazy = buildMcpOpenAITools('c1', { lazy: true });
        expect(names(lazy.tools)).toEqual(['a', 'b']);
        const expanded = buildMcpOpenAITools('c1', { lazy: true, expandTools: ['a'] });
        expect(names(expanded.tools)).toEqual(['a', 'b']);
    });
});

describe('buildMcpSystemBlock —— 能力清单同源排序', () => {
    it('服务器与工具顺序变化不改变清单文本', () => {
        writeServers([
            server('mcp-2', '乙台', [{ name: 'z_tool' }, { name: 'a_tool' }]),
            server('mcp-1', '甲台', [{ name: 'm_tool' }]),
        ]);
        const first = buildMcpSystemBlock('小明', 'c1');

        writeServers([
            server('mcp-1', '甲台', [{ name: 'm_tool' }]),
            server('mcp-2', '乙台', [{ name: 'a_tool' }, { name: 'z_tool' }]),
        ]);
        const second = buildMcpSystemBlock('小明', 'c1');

        expect(first).toBe(second);
        // 信息不少：三台工具名都在
        ['a_tool', 'm_tool', 'z_tool'].forEach(n => expect(first).toContain(n));
    });

    it('空清单行为不变', () => {
        expect(buildMcpSystemBlock('小明', 'c1')).toBe('');
    });
});
