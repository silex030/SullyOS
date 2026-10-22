import { describe, expect, it } from 'vitest';
import { createRequestPrefixObserver } from './requestPrefixObserver';

describe('最终请求缓存结构观测', () => {
 it('只输出脱敏结构指标，模型或通道变化时重新建基线', () => {
  const o=createRequestPrefixObserver();
  const a={model:'m',messages:[{role:'system',content:'private'},{role:'user',content:'hello'}],api_key:'secret'};
  expect(o.observe('c','route',a).comparison).toBeNull();
  const b={...a,messages:[...a.messages,{role:'assistant',content:'answer'}]};
  const r=o.observe('c','route',b);
  expect(r.comparison?.sameLeadingMessages).toBe(2);
  expect(JSON.stringify(r)).not.toMatch(/private|secret|hello|answer/);
  expect(o.observe('c','other-route',b).comparison).toBeNull();
  expect(o.observe('c','route',{...b,model:'different'}).comparison).toBeNull();
 });
 it('保存前一请求快照，不被调用方后续修改污染', () => {
  const o=createRequestPrefixObserver(); const a={model:'m',messages:[{role:'system',content:'fixed'}]};
  o.observe('c','r',a); a.messages[0].content='changed';
  expect(o.observe('c','r',a).comparison?.stableSystemEqual).toBe(false);
 });
 it('超大请求不保留正文，下次重新建基线', () => {
  const o=createRequestPrefixObserver({maxBytes:100});
  expect(o.observe('c','r',{messages:[{role:'system',content:'x'.repeat(200)}]}).baselineRetained).toBe(false);
 });
});
