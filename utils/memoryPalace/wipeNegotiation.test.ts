import { expect, it } from 'vitest';
import { wipeAllMemoryPalace } from './wipe';
import { ledgerStorageKey } from './negotiationLedger';

it('全局清空记忆同时清除未决协商，避免以后重新物化旧候选', async () => {
 const key=ledgerStorageKey('wipe-negotiation');
 localStorage.setItem(key, JSON.stringify({version:1,charId:'wipe-negotiation',candidates:[],resolutions:[]}));
 localStorage.setItem('unrelated-preference','keep');
 await wipeAllMemoryPalace({skipRemote:true});
 expect(localStorage.getItem(key)).toBeNull();
 expect(localStorage.getItem('unrelated-preference')).toBe('keep');
 localStorage.removeItem('unrelated-preference');
});
