import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Settings「其他 API」里的语音引擎选择项必须如实标注本机语音的状态。
 *
 * 本机 GPT-SoVITS 实测不达标（41 字 65.3s、常驻 >4GB），服务保持 disabled + inactive。
 * 这里锁的是**文案与选项**，防止下一轮又把「MOSS 自建语音」写成可用的中文克隆，
 * 或者把云 TTS 三家挤掉。
 */
describe('Settings · 本机语音项标注', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/Settings.tsx'), 'utf8');

    it('用准确的「本地语音（GPT-SoVITS，未启用）」标题，不再叫 MOSS 自建语音', () => {
        expect(source).toContain('本地语音（GPT-SoVITS，未启用）');
        expect(source).not.toContain('MOSS 自建语音');
    });

    it('选中时明确显示「已选 · 不可用」并给出未达标原因', () => {
        expect(source).toContain('已选 · 不可用');
        expect(source).toContain('41 字需要 65 秒');
        expect(source).toContain('常驻内存超过 4GB');
    });

    it('云 TTS 三家仍是可用选项，不被本地语音顶替', () => {
        expect(source).toContain('MiniMax');
        expect(source).toContain('鱼声 Fish');
        expect(source).toContain('ElevenLabs');
        expect(source).toContain('语音合成 API');
    });
});
