/**
 * PDF.js 加载参数回归：加载时必须显式 `isEvalSupported: false`。
 *
 * 背景：PDF.js 默认会为字体/PDF 函数编译动态代码（`new Function`）。在开了严格 CSP
 * 或某些 WebView 里这条路直接抛错，整份 PDF 提取失败；关掉后走解释路径，功能不变。
 * 这里用 mock 的 pdfjs 只钉住"传给 getDocument 的参数"，
 * 真正的文本拼接逻辑仍由 pdfText.test.ts 覆盖。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const pdfjsMock = vi.hoisted(() => ({
    getDocument: vi.fn(),
    GlobalWorkerOptions: {} as { workerSrc?: string },
}));

vi.mock('pdfjs-dist', () => ({
    getDocument: pdfjsMock.getDocument,
    GlobalWorkerOptions: pdfjsMock.GlobalWorkerOptions,
}));

const { extractPdfText } = await import('./pdfText');

describe('PDF.js 加载参数', () => {
    beforeEach(() => {
        pdfjsMock.getDocument.mockReset();
    });

    it('显式传 isEvalSupported:false，并沿用原有的 data 传参', async () => {
        const destroy = vi.fn(async () => {});
        pdfjsMock.getDocument.mockReturnValue({
            promise: Promise.resolve({ numPages: 0, getPage: vi.fn(), destroy }),
        });
        const data = new ArrayBuffer(32);

        const result = await extractPdfText(data);

        expect(pdfjsMock.getDocument).toHaveBeenCalledTimes(1);
        const params = pdfjsMock.getDocument.mock.calls[0][0];
        expect(params.isEvalSupported).toBe(false);
        expect(params.data).toBe(data);
        expect(result).toEqual({ text: '', pageCount: 0, extractedPages: 0 });
        expect(destroy).toHaveBeenCalledTimes(1);
        // worker 仍指向随站点构建的本地文件（原有离线/WebView 行为不变）
        expect(pdfjsMock.GlobalWorkerOptions.workerSrc).toBeTruthy();
    });

    it('关闭 eval 不影响页数上限与逐页提取', async () => {
        const destroy = vi.fn(async () => {});
        const getPage = vi.fn(async () => ({
            getTextContent: async () => ({ items: [{ str: '正文', hasEOL: true }] }),
        }));
        pdfjsMock.getDocument.mockReturnValue({
            promise: Promise.resolve({ numPages: 5, getPage, destroy }),
        });

        const result = await extractPdfText(new ArrayBuffer(8), { maxPages: 2 });

        expect(result.extractedPages).toBe(2);
        expect(result.pageCount).toBe(5);
        expect(getPage).toHaveBeenCalledTimes(2);
    });
});
