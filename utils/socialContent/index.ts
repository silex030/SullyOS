/**
 * utils/socialContent 桶文件：共享纯契约 + 链接识别。
 * 只有类型与纯函数；任何平台实现/网络请求都在 worker/social-content/*，避免被打进主 bundle。
 */
export * from './types';
export * from './links';
