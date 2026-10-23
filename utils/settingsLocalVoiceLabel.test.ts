import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 本机语音（MOSS-TTS-Nano）音色入口的源码契约：
 *   1. 设置页与角色编辑共用同一个音色选择器，列表只来自鉴权后端；
 *   2. 试听是「选中音色的约 2 秒参考副本」，不再是统一 demo:true；
 *   3. 角色编辑只在当前服务商是本地语音时出现，其他 provider 配置不动；
 *   4. 全局写 apiConfig.mossVoiceId，角色写 voiceProfile.mossVoiceId。
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

    it('没参考音频时给「待配置」说明与文件要求', () => {
        expect(source).toContain('待配置');
        expect(source).toContain('WAV');
    });

    it('音色选择走共用选择器，选项来自服务端目录，保存写入 mossVoiceId', () => {
        expect(source).toContain('MossVoicePicker');
        expect(source).toContain('value={localMossVoiceId}');
        expect(source).toContain('mossVoiceId: localMossVoiceId.trim() || undefined');
        expect(source).toContain('本机音色');
        // 不允许前端硬编码音色 ID 列表
        expect(source).not.toContain('value="ether"');
    });

    it('试听不再走统一的 demo:true，也不再宣称「公开演示音色」', () => {
        expect(source).not.toContain('synthesizeMossDemoPreview');
        expect(source).not.toContain('试听公开演示音色');
        expect(source).not.toContain('playMossDemoPreview');
    });

    it('云 TTS 三家仍是可用选项，不被本地语音顶替', () => {
        expect(source).toContain('MiniMax');
        expect(source).toContain('鱼声 Fish');
        expect(source).toContain('ElevenLabs');
        expect(source).toContain('语音合成 API');
    });
});

describe('Character · 角色独立音色入口', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/Character.tsx'), 'utf8');

    it('只在本地语音（MOSS）服务商下渲染音色选择器', () => {
        expect(source).toContain('genieVoiceEnabled === true');
        expect(source).toContain('isMossProvider');
        expect(source).toContain('isMossProvider && (');
        expect(source).toContain('MossVoicePicker');
    });

    it('选择结果写进该角色的 voiceProfile.mossVoiceId（继承全局时删掉该字段）', () => {
        expect(source).toContain('next.mossVoiceId = id');
        expect(source).toContain('delete next.mossVoiceId');
        expect(source).toContain('formData.voiceProfile?.mossVoiceId');
        expect(source).toContain('showInherit');
    });

    it('原有三家音色字段仍然保留，不被本机语音改动', () => {
        expect(source).toContain('voiceProfile?.voiceId');
        expect(source).toContain('voiceProfile?.fishReferenceId');
        expect(source).toContain('voiceProfile?.elevenLabsVoiceId');
    });
});
