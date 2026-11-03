import type { AIDecision, AIPlan, FieldOption, Step } from '../../../../lib/schema.js';
import type { SchemaJSON } from '../../../../lib/api';
import type { FieldRow } from './types';

/** 选项值→文本：去空格后匹配 options 的 value 或 text，命中显示 text，否则回退原值。 */
export function mapOptionText(raw: unknown, options: FieldOption[] | undefined): string {
  const text = String(raw ?? '').trim();
  if (!text || !options || !options.length) return text;
  const key = text.replace(/\s+/g, '');
  for (const opt of options) {
    if (String(opt.value ?? '').replace(/\s+/g, '') === key || String(opt.text ?? '').replace(/\s+/g, '') === key) {
      return String(opt.text ?? '').trim() || text;
    }
  }
  return text;
}

export function formatDecisionValue(value: AIDecision['value'], options?: FieldOption[]): string {
  if (Array.isArray(value)) {
    return value
      .map((item) => mapOptionText(item, options))
      .filter(Boolean)
      .join('、');
  }
  if (typeof value === 'boolean') return value ? '是' : '否';
  return mapOptionText(value, options);
}

/** AI 决策值 -> Step.wanted / list（与 lib/match.ts 的 valueToWanted 同语义） */
export function decisionToWanted(value: AIDecision['value']): { wanted: string; list: string[] | null } {
  if (Array.isArray(value)) {
    const list = value.map((item) => String(item ?? '').trim()).filter(Boolean);
    return { wanted: list.join(' / '), list: list.length ? list : null };
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return { wanted: String(value), list: null };
  }
  return { wanted: String(value ?? '').trim(), list: null };
}

export function hasFillValue(value: AIDecision['value']): boolean {
  if (Array.isArray(value)) return value.some((item) => String(item ?? '').trim());
  if (typeof value === 'boolean' || typeof value === 'number') return true;
  return String(value ?? '').trim().length > 0;
}

/**
 * 纯 AI 行列表：decisions 给出非 skip 决策、且不在 requiresReview 里的字段 → AI 已填；
 * requiresReview / action=skip / 无决策 / 无可用值 / file 控件 → AI 跳过。
 * 不展示置信度，不做低置信置顶排序，保持页面原顺序。
 * （background 的 callAI 已把 confidence<0.6 强制并入 requiresReview，这里只认 requiresReview。）
 *
 * 不变量：返回行数恒等于 schema.fields.length（严格 1:1，file/禁用/无决策行也占位），
 * 调用方按 filled 切分即得已填/未填，已填数 + 未填数恒等于全量分母。
 */
export function buildRows(schema: SchemaJSON | null, plan: AIPlan | null): FieldRow[] {
  if (!schema) return [];
  const review = new Set(plan?.requiresReview ?? []);
  const byId = new Map((plan?.decisions ?? []).map((decision) => [decision.fieldId, decision]));
  /* 重复 label 统计：去空格后出现 2 次及以上的裸 label，后面拼 section 前缀以区分上下文 */
  const bareLabel = (f: (typeof schema.fields)[number]): string =>
    f.label || f.placeholder || f.name || `字段 ${f.id}`;
  const labelCounts = new Map<string, number>();
  for (const f of schema.fields) {
    const key = bareLabel(f).replace(/\s+/g, '');
    labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
  }
  return schema.fields.map((field) => {
    let label = bareLabel(field);
    if ((labelCounts.get(label.replace(/\s+/g, '')) ?? 0) >= 2 && field.section) {
      label = field.section + '-' + label;
    }
    const base = {
      fieldId: field.id,
      label,
      kind: field.kind,
      required: Boolean(field.required),
      section: field.section || '未分组',
    };
    if (field.kind === 'file') {
      return { ...base, value: '', filled: false, reason: '附件需人工选择' };
    }
    // 页面已有值（AI 填完回读 / 站点预填）：直接算已填留在列表里，不随 pending 过滤消失。
    if (hasPageValue(field.value)) {
      const decision = byId.get(field.id);
      return {
        ...base,
        value: formatPageValue(field.value, field.options),
        filled: true,
        reason: decision?.reason || '页面已有值',
      };
    }
    const decision = byId.get(field.id);
    if (!decision) {
      return { ...base, value: '', filled: false, reason: 'AI 未给出该字段的决策' };
    }
    if (review.has(field.id)) {
      return { ...base, value: '', filled: false, reason: decision.reason || 'AI 标记需人工确认' };
    }
    if (decision.action === 'skip') {
      return { ...base, value: '', filled: false, reason: decision.reason || 'AI 判断不填' };
    }
    if (!hasFillValue(decision.value)) {
      return { ...base, value: '', filled: false, reason: 'AI 未给出可用值' };
    }
    return { ...base, value: formatDecisionValue(decision.value, field.options), filled: true, reason: decision.reason || '' };
  });
}

/**
 * 一键填入用的 Step[]：只含待填项（status pending），content 收到后调 runPlan 逐个真实写入。
 * requiresReview / skip / 无决策 / 无可用值 / file 控件一律不进 steps，绝不写入 DOM。
 */
export function buildFillSteps(schema: SchemaJSON, plan: AIPlan): Step[] {
  const review = new Set(plan.requiresReview ?? []);
  const byId = new Map((plan.decisions ?? []).map((decision) => [decision.fieldId, decision]));
  const steps: Step[] = [];
  for (const field of schema.fields) {
    if (field.kind === 'file') continue;
    const decision = byId.get(field.id);
    if (!decision || decision.action === 'skip' || review.has(field.id)) continue;
    const { wanted, list } = decisionToWanted(decision.value);
    if (!wanted.trim()) continue;
    steps.push({
      fieldId: field.id,
      kind: field.kind,
      label: field.label || field.placeholder || field.name || field.id,
      section: field.section || '',
      required: Boolean(field.required),
      profileKey: null,
      score: 0,
      via: decision.action,
      source: 'ai',
      action: decision.action,
      wanted,
      list,
      options: field.options || [],
      status: 'pending',
      note: decision.reason || '',
    });
  }
  return steps;
}

/**
 * 手动补值用的 Step[]：把侧边栏草稿（fieldId -> 手填文本）转成 FILL steps。
 * 空草稿不进 steps；action 按 kind 映射（对照 lib/runner.ts 的分支语义）：
 * set → 文本类（text/textarea/richtext/date/number/email/tel/url），
 * click → 选项类（select/custom-select/radio-group/checkbox-group，wanted 取选项文本），
 * check → 勾选类（checkbox/radio）；file 控件永远不进 steps。
 */
export function buildManualSteps(schema: SchemaJSON | null, drafts: Record<string, string>): Step[] {
  if (!schema) return [];
  const byId = new Map(schema.fields.map((field) => [field.id, field]));
  const steps: Step[] = [];
  for (const [fieldId, raw] of Object.entries(drafts)) {
    const wanted = String(raw ?? '').trim();
    if (!wanted) continue;
    const field = byId.get(fieldId);
    if (!field || field.kind === 'file') continue;
    const action = manualActionOf(field.kind);
    steps.push({
      fieldId: field.id,
      kind: field.kind,
      label: field.label || field.placeholder || field.name || field.id,
      section: field.section || '',
      required: Boolean(field.required),
      profileKey: null,
      score: 0,
      via: 'manual',
      source: 'field',
      action,
      wanted,
      list: action === 'click' ? wanted.split(/\s*[/,、，;；]+\s*/).map((s) => s.trim()).filter(Boolean) : null,
      options: field.options || [],
      status: 'pending',
      note: '手动补值',
    });
  }
  return steps;
}

function manualActionOf(kind: string): 'set' | 'click' | 'check' {
  if (kind === 'checkbox' || kind === 'radio') return 'check';
  if (kind === 'select' || kind === 'custom-select' || kind === 'radio-group' || kind === 'checkbox-group') return 'click';
  return 'set';
}

/** 页面已有值的展示文案：数组用顿号拼；每个元素先按 options 映射成选项文本。 */
export function formatPageValue(value: unknown, options?: FieldOption[]): string {
  if (Array.isArray(value)) {
    return value.map((item) => mapOptionText(item, options)).filter(Boolean).join('、');
  }
  return mapOptionText(value, options);
}

/** 页面已有值的字段：AI 不碰、不发（以页面现值为准）；列表里按已填展示。 */
export function hasPageValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => String(item ?? '').trim().length > 0);
  return String(value ?? '').trim().length > 0;
}

/** 未填字段子集：只给 AI 请求用（省 token）；列表 / 计数看全量 schema，已填的按页面现值算已填。 */
export function pendingFieldsOf(schema: SchemaJSON | null): SchemaJSON | null {
  if (!schema) return null;
  return { ...schema, fields: schema.fields.filter((field) => !hasPageValue(field.value)) };
}

/**
 * schema 实变判定：字段增删 / kind / 必填 / 可用性 / 选项数变化才算变，现值变化不算。
 * 静默重抽形状一致 → 复用已有 AI 决策，不重复花钱调 AI。
 */
export function sameSchemaShape(a: SchemaJSON | null, b: SchemaJSON | null): boolean {
  if (!a || !b || a.fields.length !== b.fields.length) return false;
  return a.fields.every((field, index) => {
    const other = b.fields[index];
    if (!other || field.id !== other.id || field.kind !== other.kind) return false;
    if (Boolean(field.required) !== Boolean(other.required)) return false;
    if (Boolean(field.disabled) !== Boolean(other.disabled)) return false;
    return (field.options || []).length === (other.options || []).length;
  });
}

export function formatDateTime(ts: number | null): string {
  if (!ts) return '未知时间';
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return String(ts);
  }
}

export async function sendToBackground<T>(message: Record<string, unknown>): Promise<T | null> {
  try {
    return (await chrome.runtime.sendMessage(message)) as T;
  } catch {
    return null;
  }
}
