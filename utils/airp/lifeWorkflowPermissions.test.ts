import { expect, it } from 'vitest';
import { canRunPrivateLifeAction } from './lifeWorkflowPermissions';
it('显式none不会在后台复活，旧空列表保持all语义',()=>{
 expect(canRunPrivateLifeAction({capabilityMode:'none'},'diary')).toBe(false);
 expect(canRunPrivateLifeAction({capabilities:[]},'diary')).toBe(true);
});
it('自写日记和排程分别受对应白名单限制；私人生活不要求真实写入总闸',()=>{
 expect(canRunPrivateLifeAction({capabilityMode:'allowlist',capabilities:['diary_write']},'plan')).toBe(false);
 expect(canRunPrivateLifeAction({capabilityMode:'allowlist',capabilities:['diary_write']},'diary')).toBe(true);
 expect(canRunPrivateLifeAction({capabilityMode:'allowlist',capabilities:['schedule_write']},'plan')).toBe(true);
});
