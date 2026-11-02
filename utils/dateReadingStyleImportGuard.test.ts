import { describe, it, expect, beforeEach } from 'vitest';
import JSZip from 'jszip';
import { DB, openDB } from './db';
import { assembleV2Backup, writeV2Backup } from './backupFormat';
import type { ReadingStyle } from '../features/appearance-sharing/types';

/**
 * t_40feeeaa 最小收口（用户明确授权）：dateReadingStyle 真实备份恢复保护。
 * 走真实链路 writeV2Backup → ZIP 序列化/读取 → assembleV2Backup →
 * DB.importFullData → 真实 IndexedDB（fake-indexeddb）→ 读回持久化角色，
 * 不用自写 restore 替代，不在测试里写 coerced ?? oldStyle 冒充产品行为。
 * 安全合成种子，不碰用户真实库；每次用例前清空 characters。
 */

const VALID_DATE_STYLE: ReadingStyle = {
  background: 'rgba(0, 0, 0, 0.9)',
  foreground: '#e2e8f0',
  accent: 'rgba(255, 255, 255, 0.1)',
  fontFamily: 'serif',
  fontSizePx: 18,
  lineHeight: 2,
  borderRadiusPx: 0,
};

async function readCharacters(): Promise<any[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('characters', 'readonly');
    const req = tx.objectStore('characters').getAll();
    req.onsuccess = () => resolve(req.result as any[]);
    req.onerror = () => reject(req.error || tx.error);
  });
}

async function clearCharacters(): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('characters', 'readwrite');
    tx.objectStore('characters').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

beforeEach(async () => {
  await clearCharacters();
});

describe('dateReadingStyle 真实恢复：DB.importFullData 入口预检', () => {
  it('有效样式经真实 importFullData 落库，读回七字段一致', async () => {
    await DB.importFullData(
      { characters: [{ id: 'char-ap-guard-1', name: '外观守卫种子', dateReadingStyle: { ...VALID_DATE_STYLE } }] } as any,
    );
    const chars = await readCharacters();
    expect(chars).toHaveLength(1);
    expect(chars[0].dateReadingStyle).toEqual(VALID_DATE_STYLE);
    expect(Object.keys(chars[0].dateReadingStyle).sort()).toEqual(
      ['accent', 'background', 'borderRadiusPx', 'fontFamily', 'fontSizePx', 'foreground', 'lineHeight'].sort(),
    );
  });

  it('非法样式整包拒绝（中文错误），旧角色与旧有效样式保持不变', async () => {
    // 先落一个带有效样式的旧角色
    await DB.importFullData(
      { characters: [{ id: 'char-ap-guard-2', name: '旧角色', nick: '旧昵称', dateReadingStyle: { ...VALID_DATE_STYLE } }] } as any,
    );
    // 再喂非法包：直接调公开入口，不能绕过
    await expect(
      DB.importFullData(
        { characters: [{ id: 'char-ap-guard-2', name: '旧角色', dateReadingStyle: { ...VALID_DATE_STYLE, background: 'red' } }] } as any,
      ),
    ).rejects.toThrow(/阅读样式/);
    // 旧数据一字未动：拒绝发生在任何 clear/put 之前
    const chars = await readCharacters();
    expect(chars).toHaveLength(1);
    expect(chars[0].name).toBe('旧角色');
    expect(chars[0].nick).toBe('旧昵称');
    expect(chars[0].dateReadingStyle).toEqual(VALID_DATE_STYLE);
  });

  it('越界数字同样整包拒绝且不抹旧值', async () => {
    await DB.importFullData(
      { characters: [{ id: 'char-ap-guard-3', name: '旧角色', dateReadingStyle: { ...VALID_DATE_STYLE } }] } as any,
    );
    await expect(
      DB.importFullData(
        { characters: [{ id: 'char-ap-guard-3', name: '旧角色', dateReadingStyle: { ...VALID_DATE_STYLE, fontSizePx: 99 } }] } as any,
      ),
    ).rejects.toThrow(/阅读样式/);
    const chars = await readCharacters();
    expect(chars).toHaveLength(1);
    expect(chars[0].dateReadingStyle).toEqual(VALID_DATE_STYLE);
  });

  it('无字段旧包照常恢复，不因新增字段拒绝', async () => {
    await DB.importFullData({ characters: [{ id: 'char-ap-guard-4', name: '远古角色' }] } as any);
    const chars = await readCharacters();
    expect(chars).toHaveLength(1);
    expect(chars[0].name).toBe('远古角色');
    expect('dateReadingStyle' in chars[0]).toBe(false);
  });

  it('有效包一次连续往返：writer→ZIP字节→reader→importFullData→IDB读回七字段一致', async () => {
    // 真实 writer 把 characters 分片进 ZIP，generateAsync 落字节，loadAsync 重读，
    // 再经真实 reader 拼回 data，最后走产品公开入口 importFullData 落库。
    const zip = new JSZip();
    await writeV2Backup(
      zip as any,
      { characters: [{ id: 'char-ap-chain-1', name: '链路种子', dateReadingStyle: { ...VALID_DATE_STYLE } }] },
      { mode: 'full' as any },
    );
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const loaded = await JSZip.loadAsync(bytes);
    const manifest = JSON.parse(await loaded.file('manifest.json')!.async('string'));
    const data = await assembleV2Backup(loaded as any, manifest);
    await DB.importFullData(data as any);
    const chars = await readCharacters();
    expect(chars).toHaveLength(1);
    expect(chars[0].id).toBe('char-ap-chain-1');
    expect(chars[0].dateReadingStyle).toEqual(VALID_DATE_STYLE);
    expect(Object.keys(chars[0].dateReadingStyle).sort()).toEqual(
      ['accent', 'background', 'borderRadiusPx', 'fontFamily', 'fontSizePx', 'foreground', 'lineHeight'].sort(),
    );
  });

  it('显式 null 包走同一连续链整包拒绝，旧角色与旧有效样式完整不变', async () => {
    // 先落旧有效角色
    await DB.importFullData(
      { characters: [{ id: 'char-ap-chain-2', name: '旧角色', nick: '旧昵称', dateReadingStyle: { ...VALID_DATE_STYLE } }] } as any,
    );
    // 显式 null 包经同一 writer→字节→reader 链得到 data，再喂产品公开入口，必须整包拒绝
    const zip = new JSZip();
    await writeV2Backup(
      zip as any,
      { characters: [{ id: 'char-ap-chain-2', name: '旧角色', dateReadingStyle: null }] },
      { mode: 'full' as any },
    );
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const loaded = await JSZip.loadAsync(bytes);
    const manifest = JSON.parse(await loaded.file('manifest.json')!.async('string'));
    const data = await assembleV2Backup(loaded as any, manifest);
    await expect(DB.importFullData(data as any)).rejects.toThrow(/阅读样式/);
    // 旧数据一字未动：拒绝发生在任何 clear/put 之前
    const chars = await readCharacters();
    expect(chars).toHaveLength(1);
    expect(chars[0].id).toBe('char-ap-chain-2');
    expect(chars[0].name).toBe('旧角色');
    expect(chars[0].nick).toBe('旧昵称');
    expect(chars[0].dateReadingStyle).toEqual(VALID_DATE_STYLE);
  });
});
