/**
 * 外观分享面板：本地导出 / 导入校验 / 隔离预览 / 确认后应用或取消。
 *
 * 闭环语义：
 * - 导出：把当前已应用的配置（props.current）打包成 JSON 下载，不发网络请求；
 * - 导入：读取用户选择的 .json，经 parseSharePackage 校验；失败显示中文错误，
 *   不改动任何已应用配置；成功只进入预览（draft），不直接应用；
 * - 预览：变量只写面板内的预览根节点（applyShareVarsToElement），不碰全局；
 * - 应用：用户点「应用」才调用 onApply(draft)；取消则 draft 回到 current，
 *   全程不调用 onApply。
 *
 * 不做云端投稿按钮，不发网络请求，不调用 LLM，不读写既有 store。
 */

import React from 'react';
import {
  buildSharePackage,
  serializeSharePackage,
  parseSharePackage,
  MAX_SHARE_PACKAGE_BYTES,
  type ParseShareResult,
} from './package';
import { applyShareVarsToElement } from './scopedStyle';
import type { ReadingStyle, ShareTarget } from './types';

export interface SharePanelApi {
  /** 把外部样式载入预览（仅预览，不应用；新意图，使未完成的导入读取失效）。 */
  loadPreview: (style: ReadingStyle) => void;
  /** 确认应用当前预览。 */
  apply: () => void;
  /** 取消：预览回到 current，不触发 onApply；同时使未完成的导入读取失效。 */
  cancel: () => void;
  /** 导出当前配置的 JSON 文本。 */
  exportJson: () => string;
  /** 导入 JSON 文本（与选文件同一校验路径）。 */
  importJsonText: (text: string) => ParseShareResult;
  /** 导入文件对象（与 input 选择同一异步路径；返回读取完成后的校验结果）。 */
  importFile: (file: File) => Promise<ParseShareResult>;
}

export interface SharePanelProps {
  target: ShareTarget;
  current: ReadingStyle;
  onApply: (style: ReadingStyle) => void;
  /** 测试缝：注册命令式 API（生产可不传）。 */
  registerApi?: (api: SharePanelApi) => void;
}

const TARGET_LABEL: Record<ShareTarget, string> = {
  collaboration: '协作界面',
  'story-reading': '故事阅读',
  'date-reading': '约会阅读',
};

export function SharePanel({ target, current, onApply, registerApi }: SharePanelProps): React.ReactElement {
  const [draft, setDraft] = React.useState<ReadingStyle>(current);
  const [error, setError] = React.useState<string | null>(null);
  const [fileName, setFileName] = React.useState<string>('');
  const previewRef = React.useRef<HTMLDivElement>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  // 异步导入读取的失效令牌：取消 / 新一次导入（文件或同步文本，合法与非法
  // 输入一律递增代次） / loadPreview / current 或 target 变化 / 卸载都会使旧读取过期。
  // 迟到的读取成功或失败一律不得覆盖新预览或错误。
  // 所有意图入口共用 beginIntent，后发意图使旧读取失效（redesign-v1 D）。
  const readSeqRef = React.useRef(0);
  const targetRef = React.useRef<ShareTarget>(target);
  targetRef.current = target;
  const currentRef = React.useRef<ReadingStyle>(current);
  currentRef.current = current;

  // 所有意图入口共用：开始一个新意图（同步文本导入 / 文件导入 /
  // loadPreview / 取消 / current 或 target 变化），旧读取一律过期。
  const beginIntent = React.useCallback((): { seq: number; targetAtStart: ShareTarget } => {
    readSeqRef.current += 1;
    return { seq: readSeqRef.current, targetAtStart: targetRef.current };
  }, []);

  // current 变化（外部已应用新配置）时，预览基线跟随；旧读取失效。
  React.useEffect(() => {
    beginIntent();
    setDraft(current);
    setError(null);
    setFileName('');
  }, [current, beginIntent]);

  // target 变化时旧 draft 必须清理（不能要求所有 owner 用 key 重挂载规避），
  // 且进行中的旧 target 读取失效。
  React.useEffect(() => {
    beginIntent();
    setDraft(currentRef.current);
    setError(null);
    setFileName('');
    if (fileRef.current) fileRef.current.value = '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, beginIntent]);

  // 卸载时使未完成的读取失效。
  React.useEffect(() => {
    return () => {
      readSeqRef.current += 1;
    };
  }, []);

  // 预览变量只写面板内的预览根节点。
  React.useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const cleanup = applyShareVarsToElement(el, draft);
    return cleanup;
  }, [draft]);

  const applyValidatedText = React.useCallback(
    (text: string, seq: number, targetAtStart: ShareTarget): ParseShareResult => {
      // 迟到读取：已有更新的取消/导入/current/target/卸载，一律丢弃。
      if (seq !== readSeqRef.current) {
        return { ok: false, error: '导入已过期（已有更新的操作），当前设置未改变' };
      }
      if (targetAtStart !== targetRef.current) {
        return { ok: false, error: '导入已过期（目标已切换），当前设置未改变' };
      }
      const result = parseSharePackage(text);
      // 解析完成后再复核一次：防止解析期间发生取消或切换。
      if (seq !== readSeqRef.current || targetAtStart !== targetRef.current) {
        return { ok: false, error: '导入已过期（已有更新的操作），当前设置未改变' };
      }
      if (!result.ok) {
        setError(result.error);
        return result;
      }
      if (result.target !== targetRef.current) {
        const mismatch = `这个包是给「${TARGET_LABEL[result.target]}」的，不能用在「${TARGET_LABEL[targetRef.current]}」；当前设置未改变`;
        setError(mismatch);
        return { ok: false, error: mismatch };
      }
      setError(null);
      setDraft(result.style);
      return result;
    },
    [],
  );

  const importJsonText = React.useCallback(
    (text: string): ParseShareResult => {
      // 同步文本导入同样是新意图：合法与非法输入一律递增代次，
      // 使之前未完成的文件读取失效；迟到读取不得覆盖新 draft 或新错误。
      const { seq, targetAtStart } = beginIntent();
      return applyValidatedText(text, seq, targetAtStart);
    },
    [applyValidatedText, beginIntent],
  );

  /**
   * 外部样式载入预览（仅预览，不应用）：同样是新意图，后发 loadPreview
   * 使未完成的文件读取失效并获胜；迟到读取不得覆盖这次载入的预览。
   * 优先级：loadPreview 与文本/文件导入同级，一律以后发者为准。
   */
  const loadPreview = React.useCallback(
    (style: ReadingStyle) => {
      beginIntent();
      setError(null);
      setDraft(style);
    },
    [beginIntent],
  );

  const exportJson = React.useCallback((): string => {
    return serializeSharePackage(buildSharePackage(current, target));
  }, [current, target]);

  const handleExport = React.useCallback(() => {
    const text = exportJson();
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `appearance-share-${target}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [exportJson, target]);

  const handleFile = React.useCallback(
    async (file: File): Promise<ParseShareResult> => {
      // 新一次导入使之前未完成的读取失效（A/B 倒序时旧的不得覆盖新的）。
      const { seq, targetAtStart } = beginIntent();
      setFileName(file.name);
      if (file.size > MAX_SHARE_PACKAGE_BYTES) {
        // 大小拒绝只属于本次读取：若期间已有更新操作，不覆盖新状态。
        if (seq !== readSeqRef.current) {
          return { ok: false, error: '导入已过期（已有更新的操作），当前设置未改变' };
        }
        const tooBig = `文件过大（上限 ${MAX_SHARE_PACKAGE_BYTES / 1024}KB），已拒绝导入，当前设置未改变`;
        setError(tooBig);
        return { ok: false, error: tooBig };
      }
      let text: string;
      try {
        text = await file.text();
      } catch {
        if (seq !== readSeqRef.current || targetAtStart !== targetRef.current) {
          return { ok: false, error: '导入已过期（已有更新的操作），当前设置未改变' };
        }
        const readFail = '文件读取失败，请重新选择分享包；当前设置未改变';
        setError(readFail);
        return { ok: false, error: readFail };
      }
      return applyValidatedText(text, seq, targetAtStart);
    },
    [applyValidatedText, beginIntent],
  );

  const apply = React.useCallback(() => {
    onApply(draft);
  }, [draft, onApply]);

  const cancel = React.useCallback(() => {
    // 取消同时使未完成的读取失效：迟到完成不得回写预览。
    beginIntent();
    setDraft(currentRef.current);
    setError(null);
    setFileName('');
    if (fileRef.current) fileRef.current.value = '';
  }, [beginIntent]);

  React.useEffect(() => {
    if (registerApi) {
      registerApi({
        loadPreview,
        apply,
        cancel,
        exportJson,
        importJsonText,
        importFile: handleFile,
      });
    }
  }, [registerApi, loadPreview, apply, cancel, exportJson, importJsonText, handleFile]);

  return React.createElement(
    'div',
    {
      'data-testid': 'ap-share-panel',
      style: {
        borderRadius: 16,
        padding: 16,
        background: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.12)',
        backdropFilter: 'blur(12px)',
      },
    },
    React.createElement('div', { style: { fontWeight: 700, marginBottom: 4 } }, `外观分享 · ${TARGET_LABEL[target]}（本地包）`),
    React.createElement(
      'div',
      { style: { fontSize: 12, opacity: 0.7, marginBottom: 12 } },
      '仅含配色 / 字体 / 字号 / 行距 / 圆角。首版不支持自定义 CSS，不含任何账号与聊天内容。',
    ),
    React.createElement(
      'div',
      { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 } },
      React.createElement('button', { type: 'button', onClick: handleExport }, '导出当前样式'),
      React.createElement('input', {
        ref: fileRef,
        type: 'file',
        accept: '.json,application/json',
        'aria-label': '导入分享包',
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
          const f = e.target.files && e.target.files[0];
          if (f) void handleFile(f);
        },
      }),
    ),
    fileName
      ? React.createElement('div', { style: { fontSize: 12, opacity: 0.7, marginBottom: 8 } }, `已选文件：${fileName}`)
      : null,
    error
      ? React.createElement(
          'div',
          { role: 'alert', style: { fontSize: 13, color: '#fca5a5', marginBottom: 8 } },
          error,
        )
      : null,
    React.createElement(
      'div',
      {
        ref: previewRef,
        'data-testid': 'ap-share-preview-target',
        style: {
          borderRadius: 'var(--ap-share-radius, 12px)',
          padding: 16,
          marginBottom: 12,
          background: 'var(--ap-share-bg, transparent)',
          color: 'var(--ap-share-fg, inherit)',
          fontFamily: 'var(--ap-share-font, inherit)',
          fontSize: 'var(--ap-share-font-size, 14px)',
          lineHeight: 'var(--ap-share-line-height, 1.6)',
          border: '1px solid var(--ap-share-accent, rgba(255,255,255,0.15))',
        },
      },
      React.createElement('div', { style: { fontWeight: 700, marginBottom: 8, color: 'var(--ap-share-accent, inherit)' } }, '预览：样式只在这里生效'),
      React.createElement('p', { style: { margin: 0 } }, '这是一段示例正文，用来预览字号、行距与配色。取消不会改变当前配置。'),
    ),
    React.createElement(
      'div',
      { style: { display: 'flex', gap: 8 } },
      React.createElement('button', { type: 'button', onClick: apply }, '应用'),
      React.createElement('button', { type: 'button', onClick: cancel }, '取消'),
    ),
  );
}
