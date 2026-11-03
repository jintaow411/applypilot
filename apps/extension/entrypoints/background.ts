/**
 * Background service worker（MV3）。
 *
 * 职责：
 * - 域名归一：去掉协议 / www. 前缀 / 端口，拿到 hostname；
 * - 按域名向本地 Go 服务查 adapter（GET /api/schema?domain=），
 *   有 adapter = 站点模式，没有 = 通用模式；
 * - token 存在 chrome.storage.local（key: autoInfo.token），供侧边栏配对/写回使用；
 * - AI 调用统一走 SW：启动时生成一个 x-opencode-session UUID 并复用，
 *   Profile / Key 从 chrome.storage.local（autoInfo.aiProfiles）读取，不落日志；
 * - 候选人信息库同样由 SW 供给模型：侧边栏 AI_CALL 传 profileSubset=null，
 *   SW 只认用户自己上传的 storage 文本（autoInfo.candidateProfile 下的 { text }，旧 JSON 按
 *   迁移规则转文本），原样放进 AI 请求的 profile 字段；没上传就不调 AI，绝不用内置示例数据冒充用户；
 * - 查适配（GET_SCHEMA）失败时把服务端统一错误包的 code 原样带回（error 仍是中文人话）。
 *
 * 侧边栏通过 chrome.runtime.sendMessage 访问：
 *   { type: 'GET_SCHEMA', domain } -> { ok, mode, adapter, domain, error?, code? }
 *   { type: 'GET_TOKEN' }          -> { ok, token }
 *   { type: 'SET_TOKEN', token }   -> { ok }
 *   { type: 'GET_SETTINGS' }       -> { ok, baseUrl, token }
 *   { type: 'AI_CALL', schema, profileSubset, profileId? } -> { ok, result } | { ok:false, error }
 *   { type: 'AI_PARSE', text, fixHint?, profileId? } -> { ok, data } | { ok:false, error }（简历文本→信息库纯文本）
 *   { type: 'AI_MERGE', existingText, newLines, profileId? } -> { ok, data } | { ok:false, error }（新增行合并进信息库）
 */

import { activeProfileOf, callAI, loadAIProfiles, mergeProfileText, mergeProfileTextStream, parseResumeToProfileText, parseResumeToProfileTextStream, type AIProfile } from '../lib/ai';
import { buildProfileText } from '../lib/match';
import type { ExtractResult, Profile } from '../lib/schema.js';

const BASE_URL_KEY = 'autoInfo.baseUrl';
const TOKEN_KEY = 'autoInfo.token';
const DEFAULT_BASE_URL = 'http://127.0.0.1:17880';

/** SW 启动时生成一次，内存复用；每次 SW 冷启动换新（用户确认随机即可） */
const AI_SESSION_ID = crypto.randomUUID();

export type SiteMode = 'site' | 'generic';

export interface SiteSchemaResponse {
  mode: SiteMode;
  adapter: unknown | null;
  domain: string;
  /** 本地服务不可用时的提示（此时仍返回通用模式，UI 可继续工作） */
  error?: string;
  /** 服务端统一错误包的 code（unauthorized/bad_request/not_found/forbidden/payload_too_large/storage_error），调不通时为空 */
  code?: string;
}

/** 候选人信息库 storage 键：只认用户上传的，没有就不调 AI（不用示例数据冒充）。 */
const CANDIDATE_KEY = 'autoInfo.candidateProfile';

/**
 * 读候选人信息库文本：新形状 { text } 直接取；旧形状（含 fields 数组的 JSON）
 * 经 buildProfileText 转文本（迁移写回由侧边栏 load 负责，这里只转不存）。
 */
function readCandidateText(value: unknown): string | null {
  if (typeof value === 'string') {
    const t = value.trim();
    return t ? t : null;
  }
  if (!!value && typeof value === 'object' && !Array.isArray(value)) {
    const rec = value as { text?: unknown; fields?: unknown };
    if (typeof rec.text === 'string' && rec.text.trim()) return rec.text.trim();
    if (Array.isArray(rec.fields)) {
      const text = buildProfileText(value as Profile).trim();
      return text ? text : null;
    }
  }
  return null;
}

/** 候选人信息库：只读用户上传的 storage 文本；没有/非法一律返回 null，不做任何兜底。 */
async function loadCandidateProfile(): Promise<string | null> {
  try {
    const stored = await chrome.storage.local.get(CANDIDATE_KEY);
    return readCandidateText(stored[CANDIDATE_KEY]);
  } catch {
    /* storage 不可用就当没有 */
  }
  return null;
}

/**
 * 解析服务端统一错误包 {ok:false, code, message}；body 不是 JSON 时按 HTTP 状态回退 code。
 * message 优先用服务端的中文人话，拿不到才用通用文案（绝不在这里拼英文）。
 */
function serverErrorOf(status: number, detail: string, baseUrl: string): Error & { code?: string } {
  let code: string | undefined;
  let message = '';
  if (detail) {
    try {
      const parsed = JSON.parse(detail) as { code?: unknown; message?: unknown; error?: unknown };
      if (typeof parsed.code === 'string' && parsed.code) code = parsed.code;
      const text =
        typeof parsed.message === 'string' && parsed.message
          ? parsed.message
          : typeof parsed.error === 'string'
            ? parsed.error
            : '';
      if (text) message = text;
    } catch {
      /* 非 JSON：按状态回退 */
    }
  }
  if (!code) {
    if (status === 401) code = 'unauthorized';
    else if (status === 400) code = 'bad_request';
    else if (status === 403) code = 'forbidden';
    else if (status === 404) code = 'not_found';
    else if (status === 413) code = 'payload_too_large';
    else if (status >= 500) code = 'storage_error';
  }
  if (!message) message = `本地服务返回 HTTP ${status}（${baseUrl}）`;
  return Object.assign(new Error(message), code ? { code } : {});
}

/** 域名归一：去协议、去 www.、去端口，返回小写 hostname。 */
export function normalizeDomain(input: string): string {
  const raw = String(input || '').trim();
  if (!raw) return '';

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    return new URL(withScheme).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  } catch {
    return raw
      .toLowerCase()
      .replace(/^www\./, '')
      .split(/[/:?#]/)[0];
  }
}

async function getBaseUrl(): Promise<string> {
  const stored = await chrome.storage.local.get(BASE_URL_KEY);
  const value = stored[BASE_URL_KEY];
  const raw = typeof value === 'string' ? value.trim() : '';
  const fallback = raw || DEFAULT_BASE_URL;
  const withScheme = /^https?:\/\//i.test(fallback) ? fallback : `http://${fallback}`;
  return withScheme.replace(/\/+$/, '');
}

export async function getToken(): Promise<string> {
  const stored = await chrome.storage.local.get(TOKEN_KEY);
  const value = stored[TOKEN_KEY];
  return typeof value === 'string' ? value : '';
}

export async function setToken(token: string): Promise<void> {
  const trimmed = String(token || '').trim();
  if (trimmed) {
    await chrome.storage.local.set({ [TOKEN_KEY]: trimmed });
  } else {
    await chrome.storage.local.remove(TOKEN_KEY);
  }
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

/** 查站点适配：无 adapter / 服务未启动都回落到通用模式。 */
export async function getSchema(domain: string): Promise<SiteSchemaResponse> {
  const normalized = normalizeDomain(domain);
  if (!normalized) {
    return { mode: 'generic', adapter: null, domain: normalized, error: '缺少有效域名' };
  }

  const baseUrl = await getBaseUrl();
  const token = await getToken();
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;

  try {
    const response = await fetchWithTimeout(
      `${baseUrl}/api/schema?domain=${encodeURIComponent(normalized)}`,
      { headers },
      6_000
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw serverErrorOf(response.status, detail, baseUrl);
    }

    const data = (await response.json()) as {
      found?: boolean;
      mode?: SiteMode;
      adapter?: unknown;
    };

    // 站点模式只认服务端显式的 mode==='site' 且 adapter 非空；found/adapter
    // 非空不再兜底判 site（库里没有该域名就一律 generic）。
    const adapter = data?.adapter ?? null;
    const hasAdapter = adapter !== null && adapter !== undefined && adapter !== '';
    const mode: SiteMode = data?.mode === 'site' && hasAdapter ? 'site' : 'generic';

    return { mode, adapter: mode === 'site' ? adapter : null, domain: normalized };
  } catch (error) {
    // 服务端错误包（带 code）原样透给侧边栏做友好映射；调不通才落到通用文案。
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && code) {
      return {
        mode: 'generic',
        adapter: null,
        domain: normalized,
        error: error instanceof Error ? error.message : String(error),
        code,
      };
    }
    return {
      mode: 'generic',
      adapter: null,
      domain: normalized,
      error: `本地服务未连接（${baseUrl}）`,
    };
  }
}

interface IncomingMessage {
  type?: string;
  domain?: string;
  token?: string;
  schema?: ExtractResult;
  profileSubset?: unknown;
  profileId?: string;
  profile?: AIProfile;
  text?: string;
  fixHint?: string;
  existingText?: string;
  newLines?: unknown;
}

async function handleAICall(message: IncomingMessage) {
  if (!message.schema || !Array.isArray(message.schema.fields)) {
    throw new Error('缺少页面 schema，无法调用 AI');
  }

  const state = await loadAIProfiles();
  const profile = message.profileId
    ? state.profiles.find((item) => item.id === message.profileId) ?? null
    : activeProfileOf(state);
  if (!profile) throw new Error('没有可用的 AI Profile，请先在设置中添加');

  // 候选人信息库：调用方自带 profileSubset 就用调用方的（侧边栏目前传 null），
  // 否则直接用用户上传的 storage 文本（已是精简纯文本，原样发给 AI，不再转换）。
  // 没有个人资料就直接报错，绝不用示例数据冒充，否则模型会拿别人的名字/电话去填表。
  const candidateText = await loadCandidateProfile();
  const subset = message.profileSubset ?? candidateText;
  if (!subset) {
    throw new Error('还没有个人资料：请先在设置里上传简历，再点一键生成');
  }

  const result = await callAI(message.schema, subset, {
    profile,
    sessionId: AI_SESSION_ID,
  });
  return { ok: true as const, result };
}

/** 手动补值新增行 + 现有信息库文本 → 合并后的完整文本（data 即合并文本，调用方只做长度校验）。 */
async function handleAIMerge(message: IncomingMessage) {
  const lines = Array.isArray(message.newLines)
    ? message.newLines.map((line) => String(line ?? '').trim()).filter(Boolean)
    : String(message.newLines ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error('没有可合并的手动补值');
  const state = await loadAIProfiles();
  const profile = message.profileId
    ? state.profiles.find((item) => item.id === message.profileId) ?? null
    : activeProfileOf(state);
  if (!profile) throw new Error('没有可用的 AI Profile，请先在设置中添加');
  if (!profile.apiKey?.trim()) throw new Error('AI 未配置 Key，跳过信息库合并');
  const data = await mergeProfileText(profile, String(message.existingText || ''), lines, {
    sessionId: AI_SESSION_ID,
  });
  return { ok: true as const, data };
}

/** 简历文本 → 信息库纯文本（data 即整理文本，调用方只做长度校验）。 */
async function handleAIParse(message: IncomingMessage) {
  const text = String(message.text || '');
  if (!text.trim()) throw new Error('简历文本为空，无法解析');
  const state = await loadAIProfiles();
  const profile = message.profileId
    ? state.profiles.find((item) => item.id === message.profileId) ?? null
    : activeProfileOf(state);
  if (!profile) throw new Error('没有可用的 AI Profile，请先在设置中添加');
  const data = await parseResumeToProfileText(profile, text, {
    sessionId: AI_SESSION_ID,
    fixHint: typeof message.fixHint === 'string' ? message.fixHint : undefined,
  });
  return { ok: true as const, data };
}

export default defineBackground(() => {
  // 点工具栏插件图标直接开/关侧边栏（MV3 openPanelOnActionClick）；
  // API 不可用（旧版 Chromium / 非 Chromium）时静默降级，用户仍可从扩展菜单打开侧边栏。
  try {
    const panel = (
      chrome as unknown as {
        sidePanel?: { setPanelBehavior?: (behavior: { openPanelOnActionClick: boolean }) => Promise<void> };
      }
    ).sidePanel;
    void panel?.setPanelBehavior?.({ openPanelOnActionClick: true })?.catch?.(() => {});
  } catch {
    /* 降级：忽略，侧边栏仍可手动打开 */
  }

  chrome.runtime.onMessage.addListener(
    (message: IncomingMessage, _sender: unknown, sendResponse: (response?: unknown) => void): boolean => {
      if (!message || typeof message.type !== 'string') return false;

      const fail = (error: unknown) =>
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });

      switch (message.type) {
        case 'GET_SCHEMA':
          getSchema(String(message.domain || ''))
            .then((result) => sendResponse({ ok: true, ...result }))
            .catch((error: unknown) =>
              sendResponse({
                ok: false,
                mode: 'generic',
                adapter: null,
                domain: normalizeDomain(String(message.domain || '')),
                error: error instanceof Error ? error.message : String(error),
              })
            );
          return true;

        case 'GET_TOKEN':
          getToken()
            .then((token) => sendResponse({ ok: true, token }))
            .catch(fail);
          return true;

        case 'SET_TOKEN':
          setToken(String(message.token || ''))
            .then(() => sendResponse({ ok: true }))
            .catch(fail);
          return true;

        case 'GET_SETTINGS':
          Promise.all([getBaseUrl(), getToken()])
            .then(([baseUrl, token]) => sendResponse({ ok: true, baseUrl, token }))
            .catch(fail);
          return true;

        case 'AI_CALL':
          handleAICall(message).then(sendResponse).catch(fail);
          return true;

        case 'AI_PARSE':
          handleAIParse(message).then(sendResponse).catch(fail);
          return true;

        case 'AI_MERGE':
          handleAIMerge(message).then(sendResponse).catch(fail);
          return true;

        default:
          // 例如 content script 广播的 ROUTE_CHANGED：交给侧边栏处理
          return false;
      }
    }
  );

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'AI_PARSE_STREAM' || port.name === 'AI_MERGE_STREAM' || port.name === 'AI_STREAM') {
      let abortController: AbortController | null = null;
      port.onDisconnect.addListener(() => {
        abortController?.abort();
      });

      port.onMessage.addListener(async (message: IncomingMessage) => {
        if (!message) return;
        abortController = new AbortController();
        try {
          const state = await loadAIProfiles();
          const profile = message.profileId
            ? state.profiles.find((item) => item.id === message.profileId) ?? null
            : activeProfileOf(state);
          if (!profile) throw new Error('没有可用的 AI Profile，请先在设置中添加');

          if (message.type === 'AI_PARSE') {
            const text = String(message.text || '');
            if (!text.trim()) throw new Error('简历文本为空，无法解析');

            const data = await parseResumeToProfileTextStream(profile, text, {
              sessionId: AI_SESSION_ID,
              fixHint: typeof message.fixHint === 'string' ? message.fixHint : undefined,
              signal: abortController.signal,
              onDelta: (delta, accumulated) => {
                try {
                  port.postMessage({ type: 'delta', delta, accumulated });
                } catch {
                  /* 端口已关闭 */
                }
              },
            });

            port.postMessage({ type: 'done', data });
          } else if (message.type === 'AI_MERGE') {
            const lines = Array.isArray(message.newLines)
              ? message.newLines.map((line) => String(line ?? '').trim()).filter(Boolean)
              : String(message.newLines ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
            if (!lines.length) throw new Error('没有可合并的手动补值');
            if (!profile.apiKey?.trim()) throw new Error('AI 未配置 Key，跳过信息库合并');

            const data = await mergeProfileTextStream(profile, String(message.existingText || ''), lines, {
              sessionId: AI_SESSION_ID,
              fixHint: typeof message.fixHint === 'string' ? message.fixHint : undefined,
              signal: abortController.signal,
              onDelta: (delta, accumulated) => {
                try {
                  port.postMessage({ type: 'delta', delta, accumulated });
                } catch {
                  /* 端口已关闭 */
                }
              },
            });

            port.postMessage({ type: 'done', data });
          }
        } catch (error) {
          try {
            port.postMessage({
              type: 'error',
              error: error instanceof Error ? error.message : String(error),
            });
          } catch {
            /* 端口已关闭 */
          }
        }
      });
    }
  });
});
