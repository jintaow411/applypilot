/**
 * 共享类型定义（浏览器扩展侧的「契约层」）。
 *
 * 对应关系：
 * - Field / ExtractResult / PageMeta ← src/extract.js 里 extractSchema() 的输出形状（含 section、options[].index、meta.scripts / meta.stylesheets）
 * - ProfileField ← data/profile.json 的 fields[] 形状（key/label/type/value/aliases/sections）
 * - Step / PlanStats / Plan ← 回填计划的产物形状（runner 执行 Step[] 写入页面）
 * - AIDecision / AIPlan ← shared/fill-plan.schema.json（AI 唯一允许输出的契约）
 * - PageLike ← src/runner.mjs 里对 playwright `page` 的最小依赖面，抽成接口后不引入 playwright
 *
 * 说明：这里只放类型，不放任何运行时代码（import type 即被抹掉），
 * 保证被 page.evaluate 注入的函数（extract / fill）仍然自包含。
 */

/** 抽取器能产出的控件种类（顺序与 src/extract.js 的判定链一致） */
export type FieldKind =
  | 'radio-group'
  | 'checkbox-group'
  | 'select'
  | 'textarea'
  | 'richtext'
  | 'custom-select'
  | 'checkbox'
  | 'radio'
  | 'file'
  | 'date'
  | 'number'
  | 'tel'
  | 'email'
  | 'text';

/** 一个可选项。index 只在 radio-group / checkbox-group 上有（回填时按 index 优先命中） */
export interface FieldOption {
  text: string;
  value: string;
  /** 同组内序号，对应页面上的 data-ai-opt */
  index?: number;
  disabled?: boolean;
}

/** 页面上的一个字段（extractSchema 的 fields[] 元素） */
export interface Field {
  /** 抽取器分配的稳定 id，页面元素上会写成 data-ai-id */
  id: string;
  kind: FieldKind;
  /** 原始 input type（div[role=combobox] 时为空串） */
  type: string;
  /** 小写标签名 */
  tag: string;
  name: string;
  /** 已去掉首尾星号的标签 */
  label: string;
  /** 未去星号的原始标签 */
  rawLabel: string;
  /** 所在区块标题（实习经历 / 项目经验 / …），找不到为空串 */
  section: string;
  placeholder: string;
  required: boolean;
  disabled: boolean;
  readonly: boolean;
  /** 原始 maxlength 属性串，没有则空串 */
  maxLength: string;
  options: FieldOption[];
  /** 多选组为已勾选值数组，其余为字符串 */
  value: string | string[];
  /** 所在容器文字，截断到 80 字（匹配时的弱信号） */
  wrapperText: string;
  /** 同（section,label）在 DOM 中的出现序号（1 起），总与 groupTotal 一起输出 */
  occurrence?: number;
  /** 同（section,label）的字段总数；>1 表示多段重复块 */
  groupTotal?: number;
}

/** 上报用的脚本清单：外链只记 src，内联只记长度与 hash（不收全文） */
export type ScriptMeta = { src: string } | { inline: true; chars: number; hash: string };

export interface StylesheetMeta {
  href: string;
  rules: number | 'blocked';
}

export interface PageMeta {
  scripts: ScriptMeta[];
  stylesheets: StylesheetMeta[];
}

/** extractSchema() 的完整返回值，也就是插件 ↔ 服务端的 SchemaJSON */
export interface ExtractResult {
  url: string;
  title: string;
  fields: Field[];
  meta: PageMeta;
}

/** 信息库字段的值类型（支持数组，回填时按 ` / ` 拼接给人看，按 list 逐个勾） */
export type ProfileValue = string | number | boolean | string[] | null;

/** 信息库里的一个字段（data/profile.json → fields[]） */
export interface ProfileField {
  key: string;
  label?: string;
  /** text / tel / email / date / bool / enum / number … */
  type?: string;
  value?: ProfileValue;
  /** 该字段可被哪些页面标签命中 */
  aliases?: string[];
  /** 限区块字段：非空时只在 section 命中的页面上生效（实习经历 ≠ 项目经验） */
  sections?: string[];
}

/** 开放题答案模板（自我介绍 / 为什么加入） */
export interface ProfileAnswer {
  key: string;
  label?: string;
  keywords: string[];
  template: string;
}

/** 信息库（data/profile.json） */
export interface Profile {
  version?: number;
  meta?: Record<string, unknown>;
  fields: ProfileField[];
  answers?: ProfileAnswer[];
  facts?: Record<string, string>;
}

/** AI 唯一允许输出的动作（与 shared/fill-plan.schema.json 的 action enum 逐字一致） */
export type AIAction = 'set' | 'click' | 'check' | 'skip';

/** AI 对单个字段的决策（fill-plan.decisions[] 元素） */
export interface AIDecision {
  /** 对应 Field.id，例如 af-1 */
  fieldId: string;
  action: AIAction;
  /** set/click/check 用字符串或字符串数组，单个勾选可用 boolean，skip 用空字符串 */
  value: string | number | boolean | string[];
  /** 0~1；低于 0.6 必须人工确认 */
  confidence: number;
  /** 可选：给出该值的依据，便于人工复核 */
  reason?: string;
}

/** AI 唯一允许输出的回填计划（shared/fill-plan.schema.json 的 TS 形状） */
export interface AIPlan {
  decisions: AIDecision[];
  requiresReview: string[];
}

/**
 * 一个字段的最终处理状态。
 * pending 是初始态；runner 执行后会落到 filled / failed / no-option / empty / invalid；
 * needs-ai / manual 是规划阶段直接判定的「不执行」态（needs-ai = 等人工确认或补信息）。
 * unmatched / ambiguous 是旧本地匹配引擎的遗留状态，保留以免破坏既有调用方。
 */
export type StepStatus =
  | 'pending'
  | 'filled'
  | 'needs-ai'
  | 'unmatched'
  | 'ambiguous'
  | 'manual'
  | 'no-option'
  | 'empty'
  | 'invalid'
  | 'failed';

/** 计划里的一步（回填用，字段顺序与页面一致） */
export interface Step {
  fieldId: string;
  kind: FieldKind;
  label: string;
  section: string;
  required: boolean;
  /** 命中的信息库 key；纯 AI 模式下为 null */
  profileKey: string | null;
  /** 0~1 的置信分，保留两位小数（AI 决策时与 confidence 同值） */
  score: number;
  /** 取值来源：AI 决策为 action（set/click/check/skip），未决策为空串 */
  via: string;
  source: 'field' | 'answer' | 'ai' | '';
  /** AI 决策的动作；没有决策时为空串 */
  action?: AIAction | '';
  /**
   * 要填的值（数组值会被拼成 ` / `，布尔值转成字符串）。
   * 信息库字段缺 value 时为 undefined —— 与 JS 版一致，渲染时按空值处理。
   */
  wanted: string | number | null | undefined;
  /** 仅当值为数组时存在（多选框组逐个勾选用） */
  list?: string[] | null;
  options: FieldOption[];
  status: StepStatus;
  /** 给用户看的说明（为什么没填 / 为什么待确认） */
  note?: string;
  /** runner 回填后写入的实际值 */
  value?: string;
  /** AI 决策的原始置信度（0~1），便于 UI 排序与人工复核 */
  confidence?: number;
  /** AI 给出的依据（可选） */
  reason?: string;
}

/** 计划汇总统计 */
export interface PlanStats {
  total: number;
  filled: number;
  unmatched: number;
  ambiguous: number;
  manual: number;
  pending: number;
  /** 需要人工确认 / 补信息的字段数（status = 'needs-ai'） */
  needsAi: number;
  /** failed + no-option + empty + invalid */
  failed: number;
}

/** buildPlan() 的返回值（回填计划 + 汇总统计） */
export interface Plan {
  steps: Step[];
  stats: PlanStats;
}

/**
 * runner 对页面宿主的最小依赖面。
 * 刻意不引入 playwright：只要对象有 evaluate（能跑注入函数）即可；
 * clickOption 预留给需要「原生点击」的站点适配器，不实现也能跑。
 */
export interface PageLike {
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<R>;
  clickOption?(selector: string): Promise<void>;
}
