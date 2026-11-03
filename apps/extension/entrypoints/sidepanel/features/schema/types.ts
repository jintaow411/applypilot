import type { AIPlan } from '../../../../lib/schema.js';
import type { SchemaJSON } from '../../../../lib/api';

export type SiteMode = 'site' | 'generic';
export type BusyState = 'fill' | 'report' | 'ai' | 'clear' | null;

/** Toast 的动作按钮（errors.ts 的 friendlyNotice 也复用它） */
export interface NoticeAction {
  label: string;
  run: () => void;
}

/** 列表行模型：纯 AI 回填只分两类 —— AI 已填 / AI 跳过（无置信度概念） */
export interface FieldRow {
  fieldId: string;
  label: string;
  kind: string;
  required: boolean;
  value: string;
  filled: boolean;
  reason: string;
  section: string;
}

export interface AIPlanMessage {
  ok?: boolean;
  result?: AIPlan;
  error?: string;
}

export interface SchemaResponse {
  ok?: boolean;
  schema?: SchemaJSON;
  error?: string;
  /** 非招聘页门禁：content 拒绝抽取时为 true，侧边栏展示专用空态 */
  nonRecruiting?: boolean;
}

export interface SiteSchemaMessage {
  ok?: boolean;
  mode?: SiteMode;
  adapter?: unknown;
  domain?: string;
  error?: string;
  /** 服务端统一错误包的 code（background 从 envelope 里抠出来透下，调不通时为空） */
  code?: string;
}

export interface TokenMessage {
  ok?: boolean;
  token?: string;
  error?: string;
}

export interface FillResponse {
  ok?: boolean;
  filled?: number;
  total?: number;
  reason?: string;
  error?: string;
}

export interface TabChangeInfo {
  status?: string;
}

export interface ParseMessage {
  ok?: boolean;
  data?: unknown;
  error?: string;
}

export interface MergeMessage {
  ok?: boolean;
  data?: unknown;
  error?: string;
}
