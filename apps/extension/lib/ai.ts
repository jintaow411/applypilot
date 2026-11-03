/**
 * AI 调用封装：多 Profile + 三种协议（OpenAI Chat Completions / OpenAI Responses / Anthropic Messages）。
 *
 * 设计约束：
 * - Profile（含 key / baseUrl / model）只存在 chrome.storage.local（key: autoInfo.aiProfiles），
 *   开源使用者应在扩展设置中填写自己的服务地址、模型和 API Key，代码里绝不硬编码真实 key，也不打印 key；
 * - 只把「精简 schema + 相关简历片段」发给模型，不传整页 HTML；
 * - 三个协议统一要求模型只输出 { decisions, requiresReview }，并在本地按 lib/schema.ts 的
 *   AIPlan 契约做轻量校验（decisions 数组、fieldId、action 枚举；confidence<0.6 强制人工确认）；
 * - 思考默认关闭：chat-completions 发 thinking:{type:'disabled'}；responses 发 reasoning:{effort:'none'}；
 *   anthropic 不传 thinking（默认即关闭）。
 */

import { MIN_CANDIDATE_TEXT_LENGTH, unwrapJsonWrappedText } from './candidate.js';
import type { AIDecision, AIPlan, ExtractResult } from './schema.js';

export const AI_PROFILES_KEY = 'autoInfo.aiProfiles';

export const DEFAULT_AI_BASE_URL = 'https://opencode.ai/zen/go/v1';
export const DEFAULT_AI_MODEL = 'deepseek-v4.1-flash';

export type AIProtocol = 'chat-completions' | 'responses' | 'anthropic';

export const AI_PROTOCOLS: Array<{ value: AIProtocol; label: string }> = [
  { value: 'chat-completions', label: 'Chat Completions' },
  { value: 'responses', label: 'Responses' },
  { value: 'anthropic', label: 'Anthropic' },
];

export interface AIProfile {
  id: string;
  name: string;
  baseUrl: string;
  protocol: AIProtocol;
  model: string;
  apiKey: string;
  /** 手动添加的模型 id 列表（设置页下拉框的选项，不自动拉取） */
  models: string[];
}

export interface ModelsCacheEntry {
  models: string[];
  updatedAt: number;
}

export interface AIProfilesState {
  profiles: AIProfile[];
  activeId: string;
  modelsCache: Record<string, ModelsCacheEntry>;
}

/** 测试用默认 Profile：key 留空，由用户在设置页填写 */
export const DEFAULT_AI_PROFILE: AIProfile = {
  id: 'profile-zen',
  name: 'opencode.ai',
  baseUrl: DEFAULT_AI_BASE_URL,
  protocol: 'chat-completions',
  model: DEFAULT_AI_MODEL,
  apiKey: '',
  models: [DEFAULT_AI_MODEL],
};

export type AIResult = AIPlan;

export interface AICallOptions {
  profile: AIProfile;
  /** 由 background SW 启动时生成并复用；缺省时临时生成一个 */
  sessionId?: string;
  timeoutMs?: number;
}

export interface FetchModelsOptions {
  sessionId?: string;
  timeoutMs?: number;
}

export interface ModelListResult {
  models: string[];
  /** 非致命提示（例如 anthropic 没有模型列表接口） */
  warning?: string;
}

export class AIError extends Error {
  /** HTTP 状态码；0 表示本地参数/网络/解析错误 */
  readonly status: number;
  readonly raw?: string;

  constructor(message: string, status = 0, raw?: string) {
    super(message);
    this.name = 'AIError';
    this.status = status;
    this.raw = raw;
  }
}

const SYSTEM_PROMPT = `你是求职网申表单填写助手。根据候选人的信息库，为页面字段给出填写决策。
只输出一个 JSON 对象，不要输出解释、Markdown 或代码块。结构固定为：
{"decisions":[{"fieldId":"字段id","action":"set|click|check|skip","value":"值或值数组","confidence":0.0,"reason":"简短理由"}],"requiresReview":["字段id"]}

动作含义：
- set：给文本框/文本域/富文本填值，value 为字符串；
- click：自定义下拉、级联、联想选择，value 必须是该字段 options 里的原文；
- check：单选/复选框，value 用选项原文、数组或 boolean；
- skip：不填（value 用空字符串），并尽量把 fieldId 写进 requiresReview。

规则：
1. 只能使用信息库里已有的信息，严禁编造经历、数字、证书、薪资、时间。
2. 选择题 value 必须是 options 中的原文，不要自己造选项。
3. 没有可用信息、字段是开放题、或涉及主观判断时，不要硬填：给 skip 或直接放进 requiresReview。
4. confidence 取 0~1。低于 0.6 的决策一律同时写进 requiresReview。
5. 不要输出 decisions、requiresReview 之外的任何键；没有可填字段时 decisions 为空数组。
6. 同一个 section 里出现多个相同 label 的字段，表示可重复添加的多段经历（如两段实习）：用 occurrenceText（如“第2段/共2段”）区分这是第几段。只填信息库里真实存在的第 N 段经历；信息库里没有第 N 段时，对该空段输出 skip，把 fieldId 写进 requiresReview，reason 写明已有第1段内容、缺少第 N 段信息，绝不编造。
7. filledSiblings 是同区块已经填好的内容（“标签=值”），currentValue 非空的字段也是已填好的：不要给已填字段输出决策，也不要把同一段经历重复填进另一段空段。label 太泛（如“活动描述”）时，用 context（该字段周边文字）判断它属于哪一段。

候选人信息库（profile）是精简纯文本而非 JSON：【基本信息】下每行“标签：值”（空值已省略）；
【短事实】是可引用的零散事实；【开放题素材】是开放题可用表述，其中的{{变量}}用短事实/基本信息里的同名项理解。`;

/* ------------------------------------------------------------------ *
 * Profile 持久化（chrome.storage.local → autoInfo.aiProfiles）          *
 * ------------------------------------------------------------------ */

function normalizeProtocol(value: unknown): AIProtocol {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'responses' || raw === 'response') return 'responses';
  if (raw === 'anthropic' || raw === 'claude' || raw === 'messages') return 'anthropic';
  return 'chat-completions';
}

export function newProfileId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** AI 地址归一：补 https://、去掉尾部斜杠（保留 /v1 这类路径）。 */
export function normalizeAIBaseUrl(input: string): string {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, '');
}

/** 取 host 作为 Profile 默认名（不合法时返回空串）。 */
export function hostOfUrl(input: string): string {
  const raw = String(input || '').trim();
  if (!raw) return '';
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function createAIProfile(overrides: Partial<AIProfile> = {}): AIProfile {
  const baseUrl = normalizeAIBaseUrl(overrides.baseUrl ?? '');
  return {
    id: overrides.id || newProfileId(),
    name: overrides.name ?? (hostOfUrl(baseUrl) || '新配置'),
    baseUrl,
    protocol: normalizeProtocol(overrides.protocol),
    model: overrides.model ?? '',
    apiKey: overrides.apiKey ?? '',
    models: overrides.models ?? (overrides.model ? [overrides.model] : []),
  };
}

export function defaultProfilesState(): AIProfilesState {
  const profile = createAIProfile(DEFAULT_AI_PROFILE);
  return { profiles: [profile], activeId: profile.id, modelsCache: {} };
}

function normalizeProfile(raw: unknown, index: number): AIProfile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `profile-${index + 1}`;
  const baseUrl = normalizeAIBaseUrl(String(item.baseUrl ?? ''));
  return {
    id,
    name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : hostOfUrl(baseUrl) || '未命名配置',
    baseUrl,
    protocol: normalizeProtocol(item.protocol),
    model: typeof item.model === 'string' ? item.model.trim() : '',
    apiKey: typeof item.apiKey === 'string' ? item.apiKey.trim() : '',
    models: normalizeProfileModels(item.models, typeof item.model === 'string' ? item.model.trim() : ''),
  };
}

function normalizeProfileModels(raw: unknown, current: string): string[] {
  const list = Array.isArray(raw)
    ? raw.filter((model): model is string => typeof model === 'string' && model.trim().length > 0).map((model) => model.trim())
    : [];
  const merged = [...new Set([...list, ...(current ? [current] : [])])];
  return merged;
}

function normalizeModelsCache(raw: unknown): Record<string, ModelsCacheEntry> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, ModelsCacheEntry> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const models = Array.isArray(entry.models)
      ? entry.models.filter((model): model is string => typeof model === 'string' && model.length > 0)
      : [];
    const updatedAt = typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0;
    out[key] = { models: [...new Set(models)], updatedAt };
  }
  return out;
}

export function normalizeProfilesState(raw: unknown): AIProfilesState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (!Array.isArray(item.profiles)) return null;

  const profiles = item.profiles
    .map((profile, index) => normalizeProfile(profile, index))
    .filter((profile): profile is AIProfile => profile !== null);

  const activeCandidate = typeof item.activeId === 'string' ? item.activeId : '';
  const activeId = profiles.some((profile) => profile.id === activeCandidate)
    ? activeCandidate
    : profiles[0]?.id ?? '';

  return { profiles, activeId, modelsCache: normalizeModelsCache(item.modelsCache) };
}

export async function loadAIProfiles(): Promise<AIProfilesState> {
  const area = typeof chrome === 'undefined' ? undefined : chrome.storage?.local;
  if (!area) throw new AIError('扩展 storage 不可用，无法读取 AI 配置');

  const stored = await area.get(AI_PROFILES_KEY);
  const normalized = normalizeProfilesState(stored[AI_PROFILES_KEY]);
  if (normalized) return normalized;

  // 首次使用：预置测试用 zen Profile（key 为空）
  const seeded = defaultProfilesState();
  await saveAIProfiles(seeded);
  return seeded;
}

export async function saveAIProfiles(state: AIProfilesState): Promise<void> {
  const area = typeof chrome === 'undefined' ? undefined : chrome.storage?.local;
  if (!area) throw new AIError('扩展 storage 不可用，无法保存 AI 配置');
  const payload: AIProfilesState = {
    profiles: state.profiles.map((profile, index) => normalizeProfile(profile, index) ?? createAIProfile()),
    activeId: state.activeId,
    modelsCache: normalizeModelsCache(state.modelsCache),
  };
  if (!payload.profiles.some((profile) => profile.id === payload.activeId)) {
    payload.activeId = payload.profiles[0]?.id ?? '';
  }
  await area.set({ [AI_PROFILES_KEY]: payload });
}

export function activeProfileOf(state: AIProfilesState): AIProfile | null {
  return state.profiles.find((profile) => profile.id === state.activeId) ?? state.profiles[0] ?? null;
}

/* ------------------------------------------------------------------ *
 * HTTP 基础                                                          *
 * ------------------------------------------------------------------ */

function newSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 把 baseUrl 收窄到“根”，再拼具体端点；用户填了完整端点也能工作。 */
function apiRoot(baseUrl: string): string {
  return normalizeAIBaseUrl(baseUrl).replace(/\/(chat\/completions|responses|messages)$/i, '');
}

function endpointUrl(profile: AIProfile): string {
  const base = apiRoot(profile.baseUrl);
  if (profile.protocol === 'responses') return `${base}/responses`;
  if (profile.protocol === 'anthropic') {
    return /\/v1$/i.test(base) ? `${base}/messages` : `${base}/v1/messages`;
  }
  return `${base}/chat/completions`;
}

function modelsUrl(baseUrl: string): string {
  const base = apiRoot(baseUrl);
  return /\/models$/i.test(base) ? base : `${base}/models`;
}

function requireProfile(profile: AIProfile): { baseUrl: string; model: string; apiKey: string } {
  const baseUrl = normalizeAIBaseUrl(profile?.baseUrl || '');
  const model = String(profile?.model || '').trim();
  const apiKey = String(profile?.apiKey || '').trim();
  if (!baseUrl) throw new AIError('AI 配置缺少 Base URL，请先在设置中填写');
  if (!model) throw new AIError('AI 配置缺少模型名，请先在设置中填写');
  if (!apiKey) throw new AIError('未配置 AI Key，请先在设置中填写');
  return { baseUrl, model, apiKey };
}

/* ------------------------------------------------------------------ *
 * 模型列表（设置页「刷新模型列表」）                                    *
 * ------------------------------------------------------------------ */

export async function fetchModels(
  profile: Pick<AIProfile, 'baseUrl' | 'protocol' | 'apiKey'>,
  options: FetchModelsOptions = {}
): Promise<ModelListResult> {
  const baseUrl = normalizeAIBaseUrl(profile?.baseUrl || '');
  if (!baseUrl) throw new AIError('请先填写 Base URL');

  const protocol = normalizeProtocol(profile.protocol);
  if (protocol === 'anthropic') {
    return { models: [], warning: 'Anthropic 协议没有模型列表接口，请手动输入模型名' };
  }

  const apiKey = String(profile.apiKey || '').trim();
  const headers: Record<string, string> = {
    'x-opencode-session': options.sessionId || newSessionId(),
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  let response: Response;
  try {
    response = await fetchWithTimeout(
      modelsUrl(baseUrl),
      { method: 'GET', headers },
      options.timeoutMs ?? 20_000
    );
  } catch (error) {
    throw new AIError(`无法连接模型列表接口（${modelsUrl(baseUrl)}）`, 0, String(error));
  }

  const text = await response.text();
  if (!response.ok) {
    throw new AIError(`模型列表接口返回 HTTP ${response.status}：${text.slice(0, 300)}`, response.status, text);
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AIError('模型列表接口返回的不是 JSON', response.status, text.slice(0, 300));
  }

  const container = body as {
    data?: unknown;
    models?: unknown;
  };
  const list = Array.isArray(container)
    ? container
    : Array.isArray(container?.data)
      ? container.data
      : Array.isArray(container?.models)
        ? container.models
        : [];

  const models = list
    .map((item) => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      const entry = item as { id?: unknown; name?: unknown };
      return typeof entry.id === 'string' ? entry.id : typeof entry.name === 'string' ? entry.name : '';
    })
    .filter((model): model is string => model.length > 0);

  return { models: [...new Set(models)].sort((a, b) => a.localeCompare(b)) };
}

/* ------------------------------------------------------------------ *
 * 结果校验                                                            *
 * ------------------------------------------------------------------ */

const ACTIONS = ['set', 'click', 'check', 'skip'] as const;
type Action = (typeof ACTIONS)[number];

function normalizeValue(value: unknown): string | number | boolean | string[] {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  }
  return '';
}

/**
 * 手写结果校验：只接受 { decisions, requiresReview }。
 * 非法 decision 直接丢弃（宁可不填，也不能把模型幻觉写进表单）。
 */
export function validateAIResult(raw: unknown): AIResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AIError('AI 结果格式错误：顶层必须是 JSON 对象');
  }

  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.decisions)) {
    throw new AIError('AI 结果格式错误：缺少 decisions 数组');
  }

  const decisions: AIDecision[] = [];
  for (const item of obj.decisions) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const decision = item as Record<string, unknown>;

    const fieldId = typeof decision.fieldId === 'string' ? decision.fieldId.trim() : '';
    if (!fieldId) continue;

    const action = typeof decision.action === 'string' ? decision.action.trim().toLowerCase() : '';
    if (!(ACTIONS as readonly string[]).includes(action)) continue;

    const rawConfidence = decision.confidence;
    const confidence =
      typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)
        ? Math.min(1, Math.max(0, rawConfidence))
        : 0;

    const normalized: AIDecision = {
      fieldId,
      action: action as Action,
      value: normalizeValue(decision.value),
      confidence,
    };
    if (typeof decision.reason === 'string' && decision.reason.trim()) {
      normalized.reason = decision.reason.trim().slice(0, 200);
    }
    decisions.push(normalized);
  }

  const requiresReview = Array.isArray(obj.requiresReview)
    ? obj.requiresReview
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim())
    : [];

  // 低置信强制人工确认（去重，保持稳定顺序）
  const reviewSet = new Set(requiresReview);
  for (const decision of decisions) {
    if (decision.confidence < 0.6) reviewSet.add(decision.fieldId);
  }

  if (!decisions.length && !reviewSet.size) {
    throw new AIError('AI 结果为空：decisions 与 requiresReview 都没有有效内容');
  }

  return { decisions, requiresReview: [...reviewSet] };
}

/* ------------------------------------------------------------------ *
 * 提示词输入                                                          *
 * ------------------------------------------------------------------ */

function buildUserPayload(schema: ExtractResult, profileSubset: unknown) {
  const all = schema?.fields ?? [];
  const formatValue = (value: unknown): string =>
    Array.isArray(value)
      ? value.map((item) => String(item ?? '').trim()).filter(Boolean).join('、')
      : String(value ?? '').trim();
  /* 同 section 已有现值的字段拼成「标签=值」串（截 120 字）：告诉 AI 该区块已填了什么 */
  const siblingText = (field: ExtractResult['fields'][number]): string => {
    const parts: string[] = [];
    for (const other of all) {
      if (other.id === field.id) continue;
      if ((other.section || '') !== (field.section || '')) continue;
      const v = formatValue(other.value);
      if (!v) continue;
      const lab = other.label || other.placeholder || other.name;
      if (!lab) continue;
      parts.push(`${lab}=${v}`);
      if (parts.join('；').length >= 120) break;
    }
    return parts.join('；').slice(0, 120);
  };
  const fields = all.map((field) => {
    const total = field.groupTotal ?? 1;
    const n = field.occurrence ?? 1;
    return {
      fieldId: field.id,
      label: field.label,
      kind: field.kind,
      section: field.section || '',
      required: Boolean(field.required),
      placeholder: field.placeholder || '',
      options: (field.options ?? [])
        .map((option) => option.text)
        .filter(Boolean)
        .slice(0, 40),
      context: (field.wrapperText || '').slice(0, 120),
      currentValue: field.value ?? '',
      /* 多段重复块才有值（如“第2段/共2段”），否则空串；单字段合计远不到 200 字预算 */
      occurrenceText: total > 1 ? `第${n}段/共${total}段` : '',
      filledSiblings: siblingText(field),
    };
  });

  return {
    page: { url: schema?.url, title: schema?.title },
    fields,
    profile: profileSubset,
  };
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

function parseModelJson(text: string, status: number): AIResult {
  if (!text.trim()) throw new AIError('AI 未返回内容', status);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(text));
  } catch {
    throw new AIError('AI 输出的不是合法 JSON', status, text.slice(0, 500));
  }
  return validateAIResult(parsed);
}

/* ------------------------------------------------------------------ *
 * 三种协议的请求 / 响应适配                                            *
 * ------------------------------------------------------------------ */

interface PreparedRequest {
  url: string;
  init: RequestInit;
}

export type AIResponseFormat = 'json' | 'text';

function buildRequest(
  profile: AIProfile,
  systemPrompt: string,
  userText: string,
  sessionId: string,
  responseFormat: AIResponseFormat = 'json',
  stream = false
): PreparedRequest {
  const { baseUrl, model, apiKey } = requireProfile(profile);

  if (profile.protocol === 'anthropic') {
    return {
      url: endpointUrl({ ...profile, baseUrl }),
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'x-opencode-session': sessionId,
        },
        body: JSON.stringify({
          model,
          system: systemPrompt,
          messages: [{ role: 'user', content: userText }],
          temperature: 0,
          max_tokens: 4096,
          ...(stream ? { stream: true } : {}),
        }),
      },
    };
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
    'x-opencode-session': sessionId,
  };

  if (profile.protocol === 'responses') {
    // text 模式省略 text.format，不强迫模型套 JSON 壳；anthropic 本无约束不动。
    const body: Record<string, unknown> = {
      model,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
        { role: 'user', content: [{ type: 'input_text', text: userText }] },
      ],
      reasoning: { effort: 'none' },
      temperature: 0,
      max_output_tokens: 4096,
      ...(stream ? { stream: true } : {}),
    };
    if (responseFormat === 'json') body.text = { format: { type: 'json_object' } };
    return {
      url: endpointUrl({ ...profile, baseUrl }),
      init: { method: 'POST', headers, body: JSON.stringify(body) },
    };
  }

  // text 模式省略 response_format，不强迫模型套 JSON 壳。
  const chatBody: Record<string, unknown> = {
    model,
    temperature: 0,
    thinking: { type: 'disabled' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText },
    ],
    ...(stream ? { stream: true } : {}),
  };
  if (responseFormat === 'json') chatBody.response_format = { type: 'json_object' };
  return {
    url: endpointUrl({ ...profile, baseUrl }),
    init: { method: 'POST', headers, body: JSON.stringify(chatBody) },
  };
}

function responseText(profile: AIProfile, body: unknown): string {
  if (profile.protocol === 'anthropic') {
    const content = (body as { content?: unknown })?.content;
    if (!Array.isArray(content)) return '';
    return content
      .filter((block): block is { type: string; text: string } => {
        if (!block || typeof block !== 'object') return false;
        const item = block as { type?: unknown; text?: unknown };
        return item.type === 'text' && typeof item.text === 'string';
      })
      .map((block) => block.text)
      .join('');
  }

  if (profile.protocol === 'responses') {
    const data = body as {
      output_text?: unknown;
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    };
    if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text;
    return (data?.output ?? [])
      .flatMap((item) => item.content ?? [])
      .filter((part) => (part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
  }

  const data = body as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = data?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

/**
 * AI 统一入口：按 profile.protocol 切换请求形状，输出统一走 validateAIResult → AIPlan。
 * 正常链路由 background SW 调用（sessionId 在 SW 启动时生成并复用）。
 */
/* ------------------------------------------------------------------ *
 * AI 调试日志：只打 console，不改请求行为；绝不打印 apiKey。生产保留， *
 * 成功走 debug、失败/空返回走 warn，统一带 [AI] 前缀方便 DevTools 过滤。 *
 * ------------------------------------------------------------------ */

/** 只取 URL 的 path（去掉 query，避免 key 残留；解析失败时按 '?' 截断）。 */
function aiRequestPath(url: string): string {
  try {
    return new URL(url).pathname || '/';
  } catch {
    return String(url || '').split('?')[0];
  }
}

function aiPreview(value: unknown, maxLen: number): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.slice(0, maxLen);
}

/** 按协议摘关键字段：chat-completions 看 choices/message.content；anthropic 看 content 块；responses 看 output_text/output 块。 */
function summarizeAIResponseBody(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const data = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if ('choices' in data) {
    const choices = (data as { choices?: unknown }).choices;
    const choiceList = choices as Array<{ message?: { content?: unknown } }> | undefined;
    if (typeof choiceList?.[0]?.message?.content === 'string') {
      out['choices[0].message.content'] = aiPreview(choiceList[0]?.message?.content, 2000);
    } else {
      try {
        out.choices = aiPreview(JSON.stringify(choices), 2000);
      } catch {
        out.choices = '[unstringifiable]';
      }
    }
  }
  if ('content' in data) {
    try {
      out.content = aiPreview(JSON.stringify((data as { content?: unknown }).content), 2000);
    } catch {
      out.content = '[unstringifiable]';
    }
  }
  if ('output_text' in data) {
    out.output_text = aiPreview((data as { output_text?: unknown }).output_text, 2000);
  }
  if ('output' in data) {
    try {
      out.output = aiPreview(JSON.stringify((data as { output?: unknown }).output), 2000);
    } catch {
      out.output = '[unstringifiable]';
    }
  }
  if (!Object.keys(out).length) return `[AI:empty] body keys=${Object.keys(data).join(',')}`;
  return out;
}

/**
 * 通用 JSON 任务：按 profile.protocol 发请求，返回模型输出的原始文本。
 * callAI（表单决策）与简历解析共用这一条请求链路。
 */
async function postJsonTask(
  profile: AIProfile,
  systemPrompt: string,
  userText: string,
  options: { sessionId?: string; timeoutMs?: number; responseFormat?: AIResponseFormat }
): Promise<string> {
  const sessionId = options.sessionId || newSessionId();
  const { url, init } = buildRequest(profile, systemPrompt, userText, sessionId, options.responseFormat ?? 'json');
  // 只打 path，不打 query/apiKey。
  const path = aiRequestPath(url);

  console.groupCollapsed('[AI] POST', profile.protocol, profile.model, path);
  console.debug('[AI:req]', {
    path,
    model: profile.model,
    protocol: profile.protocol,
    systemPrompt: aiPreview(systemPrompt, 500),
    userText: aiPreview(userText, 2000),
    sessionId,
  });
  try {
    let response: Response;
    try {
      response = await fetchWithTimeout(url, init, options.timeoutMs ?? 60_000);
    } catch (error) {
      console.warn('[AI] fetch failed', { path, protocol: profile.protocol, error: String(error) });
      const reason = error instanceof Error && error.name === 'AbortError' ? `AI 请求超时（${path}）` : `无法连接 AI 接口 ${path}`;
      throw new AIError(reason, 0, String(error));
    }

    const text = await response.text();
    console.debug('[AI:raw]', aiPreview(text, 4000));
    if (!response.ok) {
      console.warn('[AI] http error', { path, status: response.status, preview: aiPreview(text, 500) });
      throw new AIError(`AI 接口返回 HTTP ${response.status}：${text.slice(0, 300)}`, response.status, text);
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      console.warn('[AI] parse failed', { path, status: response.status, preview: aiPreview(text, 300) });
      throw new AIError('AI 接口返回的不是 JSON', response.status, text.slice(0, 300));
    }

    console.debug('[AI:body]', summarizeAIResponseBody(body));

    const content = responseText(profile, body);
    if (!content) {
      const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
      let bodyPreview = '';
      try {
        bodyPreview = aiPreview(JSON.stringify(body), 2000);
      } catch {
        bodyPreview = '[unstringifiable]';
      }
      console.warn('[AI:empty-content]', { protocol: profile.protocol, bodyKeys: keys, bodyPreview });
    } else {
      console.debug('[AI:ok]', { protocol: profile.protocol, length: content.length });
    }
    return content;
  } finally {
    console.groupEnd();
  }
}

/**
 * AI 统一入口：按 profile.protocol 切换请求形状，输出统一走 validateAIResult → AIPlan。
 * 正常链路由 background SW 调用（sessionId 在 SW 启动时生成并复用）。
 */
export async function callAI(
  schema: ExtractResult,
  profileSubset: unknown,
  options: AICallOptions
): Promise<AIResult> {
  const payload = buildUserPayload(schema, profileSubset);
  const content = await postJsonTask(options.profile, SYSTEM_PROMPT, JSON.stringify(payload), {
    sessionId: options.sessionId,
    timeoutMs: options.timeoutMs,
  });
  return parseModelJson(content, 200);
}

const PARSE_SYSTEM_PROMPT = `你是简历信息整理助手。把用户给出的简历文本整理成精简纯文本信息库，直接输出整理后的文本，不要输出 JSON、解释、Markdown 或代码块。
输入可能是多份文件（以【文件：文件名】分段），请把它们当成同一个人的材料合并：同一字段取更完整/更新的值，重复内容只留一份，按下面的分类统一输出，不要按文件分节。

格式：
【基本信息】
姓名：…
电话：…
…每行“标签：值”，多值（技能/证书）用顿号连接；没有的信息直接省略该行。
【短事实】
…零散可引用的事实，每行“标签：值”。
【开放题素材】
自我介绍：成段可用表述……
优势：……

规则：
1. 忠于原文，严禁编造经历、数字、证书、薪资、时间；不确定的时间数字如实抄原文。
2. 分类标题固定用【基本信息】【短事实】【开放题素材】，有内容的分类才出现。
3. 开放题素材写成可直接引用的表述，必要时用{{变量}}引用短事实/基本信息里的同名项。
4. 信息太少时如实输出已有内容，不要编造凑数。`;

export interface ParseResumeOptions {
  sessionId?: string;
  timeoutMs?: number;
  /** 上一次输出校验失败时的修正提示（自动重试时用） */
  fixHint?: string;
}

/** 去空白后有效字符数（信息库文本长度口径） */
function strippedLength(text: string): number {
  return text.replace(/\s+/g, '').length;
}

/**
 * 简历文本 → 信息库纯文本（去代码围栏后的整理文本，由调用方做长度校验）。
 * 输出去空白后不足 20 字视为失败，带上修正提示自动重试 1 次。
 * 走 background SW 调用已配置的 AI，与表单决策共用协议适配。
 */
function sseLineToData(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':')) return undefined;
  if (trimmed.startsWith('data:')) return trimmed.slice(5).trim();
  return undefined;
}

async function* iterateSseLines(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        const data = sseLineToData(line);
        if (data !== undefined) yield data;
        newline = buffer.indexOf('\n');
      }
    }
    const tail = sseLineToData(buffer.replace(/\r$/, ''));
    if (tail !== undefined) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function extractSseDelta(protocol: AIProtocol, data: string): string {
  if (data === '[DONE]') return '';
  try {
    const json = JSON.parse(data);
    if (!json || typeof json !== 'object') return '';

    if (protocol === 'anthropic') {
      if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
        return typeof json.delta.text === 'string' ? json.delta.text : '';
      }
      return '';
    }

    if (protocol === 'responses') {
      if (typeof json.delta === 'string') return json.delta;
      if (typeof json.output_text_delta === 'string') return json.output_text_delta;
      if (json.type === 'response.text.delta' && typeof json.delta === 'string') return json.delta;
      if (Array.isArray(json.choices) && json.choices[0]?.delta?.content) {
        return String(json.choices[0].delta.content);
      }
      return '';
    }

    const choices = json.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const delta = choices[0]?.delta;
      if (delta && typeof delta.content === 'string') return delta.content;
      if (delta && typeof delta.text === 'string') return delta.text;
    }
    return '';
  } catch {
    return '';
  }
}

export interface PostStreamTaskOptions {
  sessionId?: string;
  timeoutMs?: number;
  responseFormat?: AIResponseFormat;
  signal?: AbortSignal;
  onDelta?: (delta: string, accumulated: string) => void;
}

async function postStreamTask(
  profile: AIProfile,
  systemPrompt: string,
  userText: string,
  options: PostStreamTaskOptions = {}
): Promise<string> {
  const sessionId = options.sessionId || newSessionId();
  const { url, init } = buildRequest(profile, systemPrompt, userText, sessionId, options.responseFormat ?? 'text', true);
  const path = aiRequestPath(url);

  console.groupCollapsed('[AI:stream] POST', profile.protocol, profile.model, path);
  try {
    let response: Response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);
      const onAbort = () => controller.abort();
      options.signal?.addEventListener('abort', onAbort);
      try {
        response = await fetch(url, { ...init, signal: controller.signal });
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      }
    } catch (error) {
      const reason =
        error instanceof Error && error.name === 'AbortError'
          ? `AI 请求超时或已中断（${path}）`
          : `无法连接 AI 接口 ${path}`;
      throw new AIError(reason, 0, String(error));
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new AIError(`AI 接口返回 HTTP ${response.status}：${text.slice(0, 300)}`, response.status, text);
    }

    if (!response.body) {
      throw new AIError('AI 接口未返回流式响应体', response.status);
    }

    let accumulated = '';
    for await (const data of iterateSseLines(response.body, options.signal)) {
      if (data === '[DONE]') break;
      const delta = extractSseDelta(profile.protocol, data);
      if (delta) {
        accumulated += delta;
        options.onDelta?.(delta, accumulated);
      }
    }

    return accumulated;
  } finally {
    console.groupEnd();
  }
}

export async function parseResumeToProfileText(
  profile: AIProfile,
  resumeText: string,
  options: ParseResumeOptions = {}
): Promise<string> {
  const text = String(resumeText || '').slice(0, 30_000);
  if (!text.trim()) throw new AIError('简历文本为空，无法解析');
  let fixHint = options.fixHint;
  for (let attempt = 0; attempt < 2; attempt++) {
    const userText = fixHint
      ? `简历原文：\n${text}\n\n上一次输出校验失败，请修正：${fixHint}\n只输出修正后的整理文本。`
      : text;
    const content = await postJsonTask(profile, PARSE_SYSTEM_PROMPT, userText, {
      sessionId: options.sessionId,
      timeoutMs: options.timeoutMs ?? 90_000,
      responseFormat: 'text',
    });
    const cleaned = unwrapJsonWrappedText(stripCodeFence(content)).trim();
    if (!cleaned) throw new AIError('AI 未返回内容', 0);
    if (strippedLength(cleaned) >= MIN_CANDIDATE_TEXT_LENGTH) return cleaned;
    fixHint = `上一次输出太短（不足 ${MIN_CANDIDATE_TEXT_LENGTH} 字），请输出完整的分类整理文本，不要只给一两行。`;
  }
  throw new AIError('AI 输出内容太短，已重试一次仍不足', 0);
}

export interface ParseResumeStreamOptions {
  sessionId?: string;
  timeoutMs?: number;
  fixHint?: string;
  signal?: AbortSignal;
  onDelta?: (delta: string, accumulated: string) => void;
}

export async function parseResumeToProfileTextStream(
  profile: AIProfile,
  resumeText: string,
  options: ParseResumeStreamOptions = {}
): Promise<string> {
  const text = String(resumeText || '').slice(0, 30_000);
  if (!text.trim()) throw new AIError('简历文本为空，无法解析');
  let fixHint = options.fixHint;
  for (let attempt = 0; attempt < 2; attempt++) {
    const userText = fixHint
      ? `简历原文：\n${text}\n\n上一次输出校验失败，请修正：${fixHint}\n只输出修正后的整理文本。`
      : text;
    const content = await postStreamTask(profile, PARSE_SYSTEM_PROMPT, userText, {
      sessionId: options.sessionId,
      timeoutMs: options.timeoutMs ?? 90_000,
      responseFormat: 'text',
      signal: options.signal,
      onDelta: options.onDelta,
    });
    const cleaned = unwrapJsonWrappedText(stripCodeFence(content)).trim();
    if (!cleaned) throw new AIError('AI 未返回内容', 0);
    if (strippedLength(cleaned) >= MIN_CANDIDATE_TEXT_LENGTH) return cleaned;
    fixHint = `上一次输出太短（不足 ${MIN_CANDIDATE_TEXT_LENGTH} 字），请输出完整的分类整理文本，不要只给一两行。`;
    if (options.onDelta) {
      options.onDelta('\n\n[正在重新整理修正...]\n\n', `${content}\n\n[正在重新整理修正...]\n\n`);
    }
  }
  throw new AIError('AI 输出内容太短，已重试一次仍不足', 0);
}

const MERGE_SYSTEM_PROMPT = `你是简历信息库整理助手。把【现有资料】和【新增信息】都当原材料，重新生成一份完整的精简总结文本，直接输出这份新文本，不要输出 JSON、解释、Markdown 或代码块。

格式：
【基本信息】
标签：值
…每行“标签：值”，多值（技能/证书）用顿号连接；没有的信息直接省略该行。
【短事实】
…零散可引用的事实，每行“标签：值”。
【开放题素材】
自我介绍：成段可用表述……
优势：……

规则：
1. 整份重生成：允许重新分类、去重、理顺，不必保留原有行的位置和措辞，输出自洽完整的新文本。
2. 分类标题固定用【基本信息】【短事实】【开放题素材】，有内容的分类才出现。
3. 忠于输入，严禁编造没给的信息；不确定的数字时间如实抄原文。
4. 只输出重新生成的完整文本。
5. 新增信息的每一行都必须在输出中有对应内容，不得丢弃；输入本来就只有一两行时如实输出短文本，不要编造凑数。`;

export interface MergeProfileOptions {
  sessionId?: string;
  timeoutMs?: number;
  /** 上一次输出校验失败时的修正提示（自动重试时用） */
  fixHint?: string;
}

/**
 * 现有资料 + 新增信息 → 重新生成的完整信息库文本（去代码围栏后由调用方做长度校验）。
 * 输出按分级阈值验收（输入材料不足 20 字时按输入有效长度验收，避免短输入死锁），
 * 不达标带上修正提示自动重试 1 次。
 * 与 AI_PARSE 同协议/超时/重试，走 background SW 调用已配置的 AI。
 */
export async function mergeProfileText(
  profile: AIProfile,
  existingText: string,
  newLines: string[],
  options: MergeProfileOptions = {}
): Promise<string> {
  const lines = newLines.map((line) => String(line ?? '').trim()).filter(Boolean);
  if (!lines.length) throw new AIError('没有可合并的手动补值', 0);
  const existing = String(existingText || '').slice(0, 30_000).trim();
  // 分级阈值：输入材料本身不足 20 字时（如首次导入只有一两个字段），按输入有效长度验收；
  // 否则“如实输出短文本”与“≥20 字”死锁（忠实规则禁止编造凑数，模型只能反复输出短文本）。
  const inputLength = strippedLength(`${existing}\n${lines.join('\n')}`);
  const required = Math.min(MIN_CANDIDATE_TEXT_LENGTH, Math.max(1, inputLength));
  let fixHint = options.fixHint;
  let lastCleaned = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const userText = fixHint
      ? `【现有资料】\n${existing || '（空）'}\n\n【新增信息】\n${lines.join('\n')}\n\n上一次输出校验失败，请修正：${fixHint}\n只输出修正后的整理文本。`
      : `【现有资料】\n${existing || '（空）'}\n\n【新增信息】\n${lines.join('\n')}\n\n把以上全部材料重新生成一份完整的精简总结，只输出这份新文本。`;
    const content = await postJsonTask(profile, MERGE_SYSTEM_PROMPT, userText, {
      sessionId: options.sessionId,
      timeoutMs: options.timeoutMs ?? 90_000,
      responseFormat: 'text',
    });
    // json_object 协议下模型会输出 {"type":"json_object","content":"…"}：stripCodeFence 后再解一层，绝不把 JSON 串透给调用方。
    const cleaned = unwrapJsonWrappedText(stripCodeFence(content)).trim();
    if (!cleaned) throw new AIError('AI 未返回内容', 0);
    if (strippedLength(cleaned) >= required) return cleaned;
    lastCleaned = cleaned;
    fixHint = `上一次输出仅 ${strippedLength(cleaned)} 字（需至少 ${required} 字），请输出重新生成的完整分类文本，确保【新增信息】的每一行都在输出中有对应内容，不要只给一两行。`;
  }
  // 保留最后一次短输出供埋点（raw 只在进程内可见，不打 key、不进 SW 透传，background fail 只透 message）。
  throw new AIError(`AI 输出内容太短，已重试一次仍不足（最后一次 ${strippedLength(lastCleaned)} 字）`, 0, lastCleaned.slice(0, 500));
}

export interface MergeProfileStreamOptions extends MergeProfileOptions {
  signal?: AbortSignal;
  onDelta?: (delta: string, accumulated: string) => void;
}

export async function mergeProfileTextStream(
  profile: AIProfile,
  existingText: string,
  newLines: string[],
  options: MergeProfileStreamOptions = {}
): Promise<string> {
  const lines = newLines.map((line) => String(line ?? '').trim()).filter(Boolean);
  if (!lines.length) throw new AIError('没有可合并的手动补值', 0);
  const existing = String(existingText || '').slice(0, 30_000).trim();
  const inputLength = strippedLength(`${existing}\n${lines.join('\n')}`);
  const required = Math.min(MIN_CANDIDATE_TEXT_LENGTH, Math.max(1, inputLength));
  let fixHint = options.fixHint;
  let lastCleaned = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const userText = fixHint
      ? `【现有资料】\n${existing || '（空）'}\n\n【新增信息】\n${lines.join('\n')}\n\n上一次输出校验失败，请修正：${fixHint}\n只输出重新生成的完整文本。`
      : `【现有资料】\n${existing || '（空）'}\n\n【新增信息】\n${lines.join('\n')}\n\n把以上全部材料重新生成一份完整的精简总结，只输出这份新文本。`;
    const content = await postStreamTask(profile, MERGE_SYSTEM_PROMPT, userText, {
      sessionId: options.sessionId,
      timeoutMs: options.timeoutMs ?? 90_000,
      responseFormat: 'text',
      signal: options.signal,
      onDelta: options.onDelta,
    });
    const cleaned = unwrapJsonWrappedText(stripCodeFence(content)).trim();
    if (!cleaned) throw new AIError('AI 未返回内容', 0);
    if (strippedLength(cleaned) >= required) return cleaned;
    lastCleaned = cleaned;
    fixHint = `上一次输出仅 ${strippedLength(cleaned)} 字（需至少 ${required} 字），请输出重新生成的完整分类文本，确保【新增信息】的每一行都在输出中有对应内容，不要只给一两行。`;
    if (options.onDelta) {
      options.onDelta('\n\n[正在重新整理修正...]\n\n', `${content}\n\n[正在重新整理修正...]\n\n`);
    }
  }
  throw new AIError(`AI 输出内容太短，已重试一次仍不足（最后一次 ${strippedLength(lastCleaned)} 字）`, 0, lastCleaned.slice(0, 500));
}

/**
 * 测试 AI Profile 连通性：向配置的模型发送极简 ping，测试认证与模型响应
 */
export async function testAIConnection(
  profile: AIProfile,
  options: { timeoutMs?: number } = {}
): Promise<{ latencyMs: number }> {
  const { baseUrl, model, apiKey } = requireProfile(profile);

  const start = Date.now();
  await postJsonTask(
    { ...profile, baseUrl, model, apiKey },
    'You are a connectivity test assistant. Respond with valid JSON: {"status":"ok"}.',
    'ping',
    { timeoutMs: options.timeoutMs ?? 15_000 }
  );
  return { latencyMs: Date.now() - start };
}

export { SYSTEM_PROMPT };
