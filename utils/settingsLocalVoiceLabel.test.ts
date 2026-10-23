import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Settings「其他 API」里的语音引擎选择项必须如实标注本机语音。
 *
 * 本机跑的是 MOSS-TTS-Nano（CPU），不是 GPT-SoVITS，也不能写成「已成功」：
 * 状态来自主代理 /agent/v1/tts/health 的真实 ready + referenceConfigured，
 * 没参考音频只能显示「待配置」，公开演示音色只能当试听。
 */
describe('Settings · 本机语音项标注', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/Settings.tsx'), 'utf8');

    it('标题如实写「本地语音（MOSS-TTS-Nano）」，不再提 GPT-SoVITS', () => {
        expect(source).toContain('本地语音（MOSS-TTS-Nano）');
        expect(source).not.toContain('GPT-SoVITS');
        expect(source).not.toContain('本机 SoVITS 试验未达标');
    });

    it('状态徽标由真实健康决定，不再写死「已选 · 不可用」或「已成功」', () => {
        expect(source).not.toContain('已选 · 不可用');
        expect(source).not.toContain('已成功');
        expect(source).toContain('describeMossVoiceStatus');
        expect(source).toContain('probeMossVoiceStatus');
    });

    it('没参考音频时给「待配置」说明与文件要求，不把公开演示当角色音色', () => {
        expect(source).toContain('试听公开演示音色');
        expect(source).toContain('不是角色音色');
        expect(source).toContain('待配置');
    });

    it('能选到已授权的本机音色：下拉选项只来自服务端白名单，且会随保存写入配置', () => {
        // 用户要能在设置里选到「ether」，选项必须是服务端给的 voices，不能前端硬编码。
        expect(source).toContain('localMossStatus!.voices.map');
        expect(source).toContain('mossVoiceId: localMossVoiceId.trim() || undefined');
        expect(source).toContain('本机音色');
    });

    it('不再说「网页端不提供上传入口」——本轮已把授权音色注册成可选音色', () => {
        expect(source).not.toContain('不提供上传入口');
        expect(source).toContain('网页端只负责');
    });

    it('云 TTS 三家仍是可用选项，不被本地语音顶替', () => {
        expect(source).toContain('MiniMax');
        expect(source).toContain('鱼声 Fish');
        expect(source).toContain('ElevenLabs');
        expect(source).toContain('语音合成 API');
    });
});
