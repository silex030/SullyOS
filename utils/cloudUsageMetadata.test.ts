import { expect, it } from 'vitest';
import { cloudUsageMetadata } from './cloudUsageMetadata';
it('后台usage允许列表保留缓存且不透传私有内容',()=>{
 const r=cloudUsageMetadata({prompt_tokens:100,completion_tokens:5,total_tokens:105,prompt_tokens_details:{cached_tokens:80},secret:'private'});
 expect(r).toMatchObject({promptTokens:100,completionTokens:5,totalTokens:105,cachedTokens:80});
 expect(JSON.stringify(r)).not.toContain('private');
});
it('缺失用量不伪造零',()=>{expect(cloudUsageMetadata(undefined)).not.toHaveProperty('promptTokens');});
