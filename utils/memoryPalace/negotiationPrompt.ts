/**
 * Memory Palace — 记忆协商 · 提示词片段
 *
 * 只做两件事：
 * 1. 在**既有**那次记忆提取调用的输出格式里追加证据字段（不给模型第二次调用机会）；
 * 2. 把当前未决候选以 C0..Cn 呈现给模型，让它有机会把这一轮的澄清绑回去。
 *
 * 这些片段由 extraction.ts 在开关打开时拼到系统提示词尾部，
 * 不改提示词目录（promptPresetCatalog）里用户可见/可覆盖的模板本体。
 */

import type { NegotiationCandidate } from './negotiationTypes';

/** 最多呈现给模型的未决候选条数（控制 token 与注意力） */
export const NEGOTIATION_PROMPT_CANDIDATE_LIMIT = 6;

/**
 * 呈现给模型的候选顺序 = 解析 `C0..Cn` 的顺序。
 * prompt 与解析必须共用这一个函数：只要一边改了截断方式，`C1` 就会指到另一条候选，
 * 那就是把 A 议题的澄清绑到 B 议题上（P3 review focus 第 3 条）。
 */
export function visiblePendingCandidates<T extends { state?: string }>(candidates: T[]): T[] {
    return candidates.slice(-NEGOTIATION_PROMPT_CANDIDATE_LIMIT);
}

export function buildNegotiationEvidenceBlock(): string {
    return `## 记忆证据标注（逐条必填；缺失会被系统当作不可靠，只能留在未决区）
除原有字段外，每条记忆对象再给出这几个字段：
  "evidence": "explicit | inferred | ambiguous",
  "subject": "user | character | third_party | relationship",
  "subjectRef": "这条说法关于谁的专名（可省略）",
  "scope": "long_term | short_term",
  "timeRange": {"kind":"point | day | range | recurring","from":"YYYY-MM-DD","to":"YYYY-MM-DD"},
  "topic": "这件事的短名（4-8 字）",
  "sourceMsgIds": [12, 13]
规则：
1. evidence 只看「这句话是谁说的、说得多确定」：
   - 用户以第一人称说出的关于自己 / 他人 / 你们关系的事实 → explicit
   - 你自己从语气和上下文推出来的（"她大概是累了"）→ inferred
   - 否定（"我不是…"）、转述别人的话、假设（"如果我…"）、反问、玩笑、说的是过去或别处的事、你自己也不确定 → ambiguous
   即使判为 ambiguous 也要**照常输出这条记忆**——系统会把它留作未决候选，漏写就等于丢线索。
2. sourceMsgIds 只能填对话每行开头 [#数字] 里的数字，且必须是这句话真正出现的那几行；不准写别的数字，不准编。
3. scope：一时状态（今天很累、这会儿心情差、感冒中）→ short_term；稳定事实、长期偏好、长期关系 → long_term。**一时情绪不能写成 long_term。**
4. subject：关于用户 → user；关于你自己 → character；某个第三个人 → third_party（同时写 subjectRef）；"我们之间" → relationship。
5. topic 用来把后来的澄清绑回当初那句：同一件事请用同一个短名。`;
}

export function buildPendingCandidatesBlock(candidates: NegotiationCandidate[]): string {
    const visible = visiblePendingCandidates(candidates);
    if (visible.length === 0) return '';
    const lines = visible.map((candidate, index) => {
        const topic = candidate.topicLabel ? `[议题:${candidate.topicLabel}] ` : '';
        const source = candidate.sourceMessageIds.length > 0
            ? `来自 [#${candidate.sourceMessageIds.join(', #')}]`
            : '没有可核对的来源';
        const reason = candidate.evidence === 'character_inferred' ? '之前只是你的猜测' : '当时没弄清楚';
        return `C${index}. ${topic}${candidate.claim}（${reason}，${source}）`;
    });
    return `## 之前的未决事项（仅供参考；没有明确表态就不要动它们）
${lines.join('\n')}`;
}

export function buildResolutionRuleBlock(): string {
    return `## 澄清的写法（只在用户这一轮确实表态时输出）
如果用户这一轮**明确**说清了上面某条 C，在本批 JSON 数组末尾追加一项：
{"resolve":"C0","as":"confirm | reject | decline","evidence":"explicit","topic":"和该 C 相同的议题短名","sourceMsgIds":[21],"note":"用户确认/否认了什么"}
- confirm = 用户明确肯定；reject = 用户明确否认或纠正；decline = 用户拒答、不想谈（保留未决，不要追问）
- sourceMsgIds 必须引用**这一轮**真正说明问题的那几行，不能重复引用当初那句；没有新表态就不要输出 resolve
- 用户只是换话题、含糊其辞，或下一句答的是别的事 → 不要输出 resolve：系统不会把「下一句」自动当成确认
- 一条 C 最多 resolve 一次；拿不准就用 decline，不要硬猜`;
}

/** 拼给系统提示词尾部的完整块（有候选时才带澄清段）。 */
export function buildNegotiationPromptSuffix(pendingCandidates: NegotiationCandidate[]): string {
    const evidence = buildNegotiationEvidenceBlock();
    const pending = buildPendingCandidatesBlock(pendingCandidates);
    if (!pending) return `\n\n${evidence}`;
    return `\n\n${evidence}\n\n${pending}\n\n${buildResolutionRuleBlock()}`;
}
