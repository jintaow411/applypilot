/**
 * 本地服务端 HTTP 客户端 + 上报快照采集。
 *
 * 接口契约见 docs/plan-extension-server.md 第 4 / 5 节：
 *   POST   /api/reports                   上报陌生页（HTML 全量 + CSS + JS 清单 + schema）
 *   GET    /api/reports?status=new        agent 轮询待处理
 *   PATCH  /api/reports/:id               标注状态（done / wip）
 *   PUT    /api/sites/:domain/schema      写回 adapter（需 token）
 *   GET    /api/stats                     覆盖率看板
 *
 * 注意事项：
 * - 采集函数（scrubHtml / collectPageReport）依赖页面 DOM，必须在 content script 里执行；
 *   侧边栏通过 chrome.tabs.sendMessage 让 content script 采集后，再用 ReportClient 发 POST
 *   （sidepanel 有 host_permissions，跨域 POST 不会被页面的 CORS 限制）。
 * - 所有请求失败统一抛 ApiError（status=0 表示本地网络/客户端错误，非 HTTP 状态码）。
 */

import type { ExtractResult, Field, FieldOption } from './schema.js';

export const DEFAULT_BASE_URL = 'http://127.0.0.1:17880';

/* ------------------------------------------------------------------ *
 * 契约类型：直接复用 lib/schema.ts（shared 契约的唯一来源）            *
 * ------------------------------------------------------------------ */

export type SchemaJSON = ExtractResult;
export type SchemaField = Field;
export type SchemaOption = FieldOption;

export interface JsMeta {
  /** 外链只收 src；内联只收长度 + hash，不传全文 */
  scripts: Array<{ src?: string; inline?: boolean; chars?: number; hash?: string }>;
  stylesheets: Array<{ href: string; rules: number | 'blocked' }>;
}

export interface ReportSnapshot {
  url: string;
  title: string;
  html: string;
  css: string;
  jsMeta: JsMeta;
  schema?: SchemaJSON;
}

export interface ReportPayload extends ReportSnapshot {
  domain: string;
}

export interface ReportResult {
  reportId: string | number | null;
}

export interface ReportClientOptions {
  /** 本地服务地址，默认 http://127.0.0.1:17880 */
  baseUrl?: string;
  /** 服务端首次启动生成的一次性 token，可选 */
  token?: string | null;
}

/* ------------------------------------------------------------------ *
 * 工具函数                                                           *
 * ------------------------------------------------------------------ */

/** 域名归一：去掉协议、www. 前缀与端口，返回小写 hostname（与 background 保持同一语义）。 */
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

/** 服务地址归一：补协议、去掉尾部斜杠。 */
export function normalizeBaseUrl(input: string): string {
  const raw = String(input || '').trim() || DEFAULT_BASE_URL;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return withScheme.replace(/\/+$/, '');
}

export class ApiError extends Error {
  /** HTTP 状态码；0 表示没拿到响应（网络错误 / 超时 / 参数问题） */
  readonly status: number;
  readonly body?: unknown;

  constructor(message: string, status = 0, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/* ------------------------------------------------------------------ *
 * 上报快照（只在页面上下文执行）                                       *
 * ------------------------------------------------------------------ */

const hashText = (text: string): string => {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
};

/**
 * scrub 一份 HTML 字符串，返回新的 HTML：
 * - 移除 password / file 控件（连带值），不把敏感输入带上服务端；
 * - 清空 input / textarea / select 的已填值；
 * - 清空 contenteditable 的文本。
 */
export function scrubHtml(html: string): string {
  if (typeof DOMParser === 'undefined') return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  scrubDom(doc);
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}

function scrubDom(root: ParentNode): void {
  root.querySelectorAll('input').forEach((node) => {
    const input = node as HTMLInputElement;
    const type = (input.getAttribute('type') || '').toLowerCase();
    // password / file：直接移除控件，避免任何值或路径残留
    if (type === 'password' || type === 'file') {
      input.remove();
      return;
    }
    input.removeAttribute('value');
    if (type === 'checkbox' || type === 'radio') input.removeAttribute('checked');
  });

  root.querySelectorAll('textarea').forEach((node) => {
    node.textContent = '';
    node.removeAttribute('value');
  });

  root.querySelectorAll('select').forEach((node) => {
    node.removeAttribute('value');
    node.querySelectorAll('option').forEach((option) => {
      option.removeAttribute('selected');
    });
  });

  root.querySelectorAll('[contenteditable=""], [contenteditable="true"]').forEach((node) => {
    node.textContent = '';
  });
}

/** 收集页面 CSS：内联 <style> 原文 + 同源外链的可读规则（跨域只留 href 标记）。 */
function collectCss(): string {
  const chunks: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    const owner = sheet.ownerNode as HTMLElement | null;
    if (owner?.tagName === 'STYLE' && owner.textContent) {
      chunks.push(owner.textContent);
      continue;
    }
    if (!sheet.href) continue;
    try {
      const rules = Array.from(sheet.cssRules)
        .map((rule) => rule.cssText)
        .join('\n');
      chunks.push(`/* ${sheet.href} */\n${rules}`);
    } catch {
      chunks.push(`/* 外链样式（跨域，无法读取规则）：${sheet.href} */`);
    }
  }
  return chunks.join('\n\n');
}

/** JS 只收清单：src 列表 + 内联脚本的长度与 hash（沿用 extract 的 meta 思想）。 */
function collectJsMeta(): JsMeta {
  const scripts = Array.from(document.scripts).map((script) =>
    script.src
      ? { src: script.src }
      : {
          inline: true,
          chars: (script.textContent || '').length,
          hash: hashText(script.textContent || ''),
        }
  );

  const stylesheets = Array.from(document.styleSheets).map((sheet) => {
    let rules: number | 'blocked' = 0;
    try {
      rules = sheet.cssRules.length;
    } catch {
      rules = 'blocked';
    }
    return { href: sheet.href || '(inline <style>)', rules };
  });

  return { scripts, stylesheets };
}

/**
 * 采集当前页面用于上报的快照（必须运行在 content script / 页面上下文）。
 * 默认 scrub：清空已填值、移除 password/file、CSS 只收可读文本、JS 只收清单。
 */
export function collectPageReport(schema?: SchemaJSON): ReportSnapshot {
  const html = scrubHtml(document.documentElement.outerHTML);
  return {
    url: location.href,
    title: document.title,
    html,
    css: collectCss(),
    jsMeta: collectJsMeta(),
    schema,
  };
}

interface CollectMessageResponse {
  ok?: boolean;
  snapshot?: ReportSnapshot;
  error?: string;
}

/** 在扩展页里让当前标签页的 content script 采集快照。 */
async function collectFromActiveTab(schema?: SchemaJSON): Promise<ReportSnapshot> {
  if (typeof chrome === 'undefined' || !chrome.tabs?.query) {
    throw new ApiError('当前上下文无法访问标签页，请在扩展侧边栏中使用上报', 0);
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new ApiError('找不到当前活动标签页', 0);

  let response: CollectMessageResponse | undefined;
  try {
    response = (await chrome.tabs.sendMessage(tab.id, {
      type: 'COLLECT_REPORT',
    })) as CollectMessageResponse;
  } catch {
    throw new ApiError('页面采集脚本未就绪，请刷新当前页面后重试', 0);
  }

  if (!response?.ok || !response.snapshot) {
    throw new ApiError(response?.error || '页面采集失败', 0);
  }
  return { ...response.snapshot, schema: response.snapshot.schema ?? schema };
}

/* ------------------------------------------------------------------ *
 * HTTP 客户端                                                        *
 * ------------------------------------------------------------------ */

export class ReportClient {
  readonly baseUrl: string;
  private readonly token: string;

  constructor(options: ReportClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl || DEFAULT_BASE_URL);
    this.token = String(options.token || '').trim();
  }

  private headers(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {};
    if (hasBody) headers['content-type'] = 'application/json';
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}${path}`, {
          ...init,
          headers: {
            ...this.headers(Boolean(init.body)),
            ...((init.headers as Record<string, string> | undefined) ?? {}),
          },
          signal: controller.signal,
        });
      } catch (error) {
        const reason = controller.signal.aborted
          ? `请求超时（${this.baseUrl}）`
          : `无法连接本地服务 ${this.baseUrl}，请确认服务已启动`;
        throw new ApiError(reason, 0, error);
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new ApiError(
          `服务端返回 HTTP ${response.status}${detail ? `：${detail.slice(0, 300)}` : ''}`,
          response.status,
          detail
        );
      }

      if (response.status === 204) return undefined as T;
      const text = await response.text();
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new ApiError('服务端返回的不是合法 JSON', response.status, text.slice(0, 300));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** 上报一份已经采集好的快照（POST /api/reports）。 */
  async postReport(payload: ReportPayload): Promise<ReportResult> {
    if (!payload?.html) throw new ApiError('上报内容为空：缺少页面 HTML', 0);
    if (!payload.domain) throw new ApiError('上报内容为空：缺少域名', 0);

    const data = await this.request<{ reportId?: string | number; id?: string | number }>(
      '/api/reports',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      30_000
    );
    return { reportId: data?.reportId ?? data?.id ?? null };
  }

  /**
   * 一步完成「采集 + 上报」：侧边栏调用时向当前标签页的 content script 取快照，
   * 再用 POST /api/reports 发到本地服务。成功返回 { reportId }。
   */
  async postReportFlow(options: { domain?: string; schema?: SchemaJSON } = {}): Promise<ReportResult> {
    const snapshot = await collectFromActiveTab(options.schema);
    const domain = normalizeDomain(options.domain || snapshot.url);
    return this.postReport({ ...snapshot, domain });
  }

  /** agent 轮询待处理上报（GET /api/reports?status=new）。 */
  async getNewReports(): Promise<unknown[]> {
    const data = await this.request<unknown>('/api/reports?status=new');
    if (Array.isArray(data)) return data;
    const list = (data as { reports?: unknown[] } | null)?.reports;
    return Array.isArray(list) ? list : [];
  }

  /** 标注上报单状态（PATCH /api/reports/:id）。 */
  async patchReport(id: string | number, patch: Record<string, unknown>): Promise<void> {
    await this.request<unknown>(`/api/reports/${encodeURIComponent(String(id))}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  /**
   * 写回站点 adapter（PUT /api/sites/:domain/schema，需 token）。
   * 请求体直接是 AdapterJSON（含 domain/version/aliases/sections/widgets）。
   */
  async putSchema(domain: string, adapter: unknown): Promise<void> {
    const normalized = normalizeDomain(domain);
    if (!normalized) throw new ApiError('域名无效，无法写回 adapter', 0);
    await this.request<unknown>(`/api/sites/${encodeURIComponent(normalized)}/schema`, {
      method: 'PUT',
      body: JSON.stringify(adapter),
    });
  }

  /** 覆盖率看板数据（GET /api/stats）。 */
  async getStats(): Promise<Record<string, unknown>> {
    const data = await this.request<Record<string, unknown>>('/api/stats');
    return data ?? {};
  }
}
