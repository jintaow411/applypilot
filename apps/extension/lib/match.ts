/**
 * 机械执行层（TS 版，与 src/plan.js 的同名函数同构）。
 *
 * 只留三样东西：
 * - 选项对齐（pickOption / rangeOf）：runner 用它把 AI 给的值落到真实控件上；
 * - 模板渲染（renderTemplate）：{{变量}} 占位替换；
 * - 信息库 → 精简纯文本（formatProfileValue / buildProfileText）：发给模型的知识库载体。
 *
 * AI 决策（callAI / 提示词 / 输出校验）住在 lib/ai.ts；老的分批规划引擎
 * planWithAI（含 JSON 版 profile）已删除，统一走纯文本知识库。
 */
import type { FieldOption, Profile } from './schema.js';

/* ------------------------------------------------------------------ *
 * 选项对齐：机械执行层（runner 用），不参与字段语义推理
 * ------------------------------------------------------------------ */

/** 选项文本归一化：全角转半角、小写、去标点空格（只服务于选项文本比对） */
function normalizeOptionText(s: unknown): string {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^(请输入|请填写|请选择|输入|填写|请)/, '')
    .replace(/[\s*＊:：()（）\[\]【】『』《》\-_—/、，,.。!！?？"'“”‘’|]/g, '')
    .trim();
}

export interface PickedOption {
  option: FieldOption;
  how: 'exact' | 'contains' | 'range';
}

/** 选项挑选：先精确，再包含，再数值区间重叠（与 JS 侧 pickOption 一致） */
export function pickOption(options: readonly FieldOption[] | null | undefined, wanted: unknown): PickedOption | null {
  const usable = (options || []).filter(
    (o) => !o.disabled && Boolean(o.text) && !/^(请选择|请先选择|加载中|--|—)/.test(o.text.trim())
  );
  if (!usable.length) return null;

  const w = normalizeOptionText(wanted);
  const exact = usable.find((o) => normalizeOptionText(o.text) === w);
  if (exact) return { option: exact, how: 'exact' };

  const contains = usable.find(
    (o) => normalizeOptionText(o.text).includes(w) || w.includes(normalizeOptionText(o.text))
  );
  if (contains) return { option: contains, how: 'contains' };

  const wr = rangeOf(wanted);
  if (wr) {
    let best: { option: FieldOption; how: 'range'; score: number } | null = null;
    for (const o of usable) {
      const or = rangeOf(o.text);
      if (!or) continue;
      const overlap = Math.min(wr[1], or[1]) - Math.max(wr[0], or[0]);
      if (overlap < 0) continue;
      // 完整包住期望区间的优先
      const containsAll = or[0] <= wr[0] && or[1] >= wr[1];
      const score = (containsAll ? 100 : 0) + overlap;
      if (!best || score > best.score) best = { option: o, how: 'range', score };
    }
    if (best) return { option: best.option, how: best.how };
  }

  return null;
}

/** 从文本里解析数值区间（区间/以上/单值）；必须在原文上解析，不能先 normalize（3-5年 会被压成 35年） */
export function rangeOf(text: unknown): [number, number] | null {
  const s = String(text)
    .replace(/[－—–~～至到]/g, '-')
    .replace(/[,，\s]/g, '')
    .replace(/[kK]$/, '');
  const pair = (a: string, b: string): [number, number] => [Number(a), Number(b)];
  const m = s.match(/(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)/);
  if (m) return pair(m[1], m[2]);
  const above = s.match(/(\d+(?:\.\d+)?)以上/);
  if (above) return pair(above[1], '999');
  const one = s.match(/^(\d+(?:\.\d+)?)/);
  if (one) return pair(one[1], one[1]);
  return null;
}

/** 渲染答案模板：{{ 变量 }} 用 facts 替换，缺失的保留原样 */
export function renderTemplate(tpl: unknown, facts?: Record<string, string> | null): string {
  return String(tpl).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_: string, k: string) => (facts && facts[k]) || '{{' + k + '}}');
}

/* ------------------------------------------------------------------ *
 * 信息库 → 精简纯文本（发给模型的知识库载体，不用 JSON 约束，省 token）
 * ------------------------------------------------------------------ */

/** 信息库值 → 文本行：数组用顿号拼，布尔转是/否，空值返回空串（调用方整行省略） */
export function formatProfileValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? '').trim()).filter(Boolean).join('、');
  }
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return String(value ?? '').trim();
}

/**
 * 信息库 → 精简纯文本（发给模型的知识库载体，不用 JSON 约束，省 token）。
 * 三段：【基本信息】每行“标签：值”／【短事实】零散事实／【开放题素材】可用表述
 * （{{变量}} 引用短事实/基本信息里的同名项）。空值行直接省略，条点一个不少。
 */
export function buildProfileText(profile: Profile): string {
  const lines: string[] = [];
  const metaName = profile.meta?.name;
  if (typeof metaName === 'string' && metaName.trim()) lines.push('候选人：' + metaName.trim());
  const seen = new Map<string, string>();
  for (const field of profile.fields || []) {
    const key = String(field.label || field.key || '').trim();
    if (!key) continue;
    const text = formatProfileValue(field.value);
    if (!text) continue;
    seen.set(key, text);
  }
  if (seen.size) {
    lines.push('【基本信息】');
    for (const [key, text] of seen) lines.push(key + '：' + text);
  }
  const facts = Object.entries(profile.facts || {}).filter((entry) => String(entry[1] ?? '').trim());
  if (facts.length) {
    lines.push('【短事实】');
    for (const [key, value] of facts) lines.push(key + '：' + String(value).trim());
  }
  const answers = (profile.answers || [])
    .map((answer) => ({ key: String(answer.label || answer.key || '').trim(), text: String(answer.template ?? '').trim() }))
    .filter((answer) => answer.key && answer.text);
  if (answers.length) {
    lines.push('【开放题素材】');
    for (const answer of answers) lines.push(answer.key + '：' + answer.text);
  }
  return lines.join('\n');
}
