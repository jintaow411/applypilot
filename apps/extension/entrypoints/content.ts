/**
 * Content script：在页面上下文里抽取表单结构、响应侧边栏消息、监听 SPA 路由变化。
 *
 * - 抽取：直接复用 lib/extract.ts 的 extractSchema()（与 src/extract.js 行为对齐）；
 * - 上报：COLLECT_REPORT 时用 lib/api.ts 的 collectPageReport() 采集并 scrub；
 * - 回填：FILL 分支收到侧边栏发来的 Step[]（由 background AI_CALL 的 decisions 转成，
 *   requiresReview / 无决策字段已在侧边栏过滤掉），直接调 lib/runner.ts 的 runPlan()
 *   真实写入 DOM（原生 setter / 自定义控件点击语义见 lib/fill.ts，与 src/fill.js 对齐）。
 *   纯 AI 回填，不写置信度，不做排序。
 */

import { extractSchema } from '../lib/extract';
import type { ExtractResult, FieldOption, Step } from '../lib/schema.js';
import { collectPageReport, type ReportSnapshot } from '../lib/api';
import { pageClearAll, pageExpandAll, pageFocusField } from '../lib/fill';
import { matchExpandRule } from '../lib/expand-rules';
import { isRecruitingPage } from '../lib/recruiting';
import { runPlan, type PageLike } from '../lib/runner';

const BRIDGE_VERSION = '0.5.0';

export interface FillResult {
  ok: boolean;
  filled: number;
  total: number;
  steps?: Step[];
  error?: string;
}

interface AutoInfoBridge {
  version: string;
  extract: () => ExtractResult;
  fill: (input?: unknown) => Promise<FillResult>;
  clear: (input?: unknown) => Promise<ClearResult>;
}

declare global {
  interface Window {
    __autoInfo?: AutoInfoBridge;
  }
}

/* ------------------------------------------------------------------ *
 * 回填占位 + SPA 路由监听                                              *
 * ------------------------------------------------------------------ */

/** content script 宿主就是页面本身：evaluate 直接调用注入函数（fill.ts 只用 document）。 */
function evaluateOnPage<R, A>(fn: (arg: A) => R, arg: A): Promise<R> {
  return Promise.resolve().then(() => fn(arg));
}

const hostPage: PageLike = { evaluate: evaluateOnPage };

/**
 * 得物/飞书的自定义下拉选项采用 portal 延迟渲染：页面初始 DOM 里只有
 * readonly combobox，真正的 role=option 要点击后才挂到 body。只对得物域名
 * 做登记式采集，避免在未知站点上盲目点击页面控件。
 */
async function enrichDewuCustomOptions(schema: ExtractResult): Promise<ExtractResult> {
  if (location.hostname.toLowerCase() !== 'poizon.jobs.feishu.cn') return schema;
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (value: string): string => value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

  for (const field of schema.fields) {
    if (field.kind !== 'custom-select' || field.options.length) continue;
    const el = document.querySelector<HTMLElement>(`[data-ai-id="${field.id}"]`);
    if (!el) continue;
    const trigger = el.closest<HTMLElement>('[role="combobox"],.ud__select__selector,.atsx-select-selection') || el;
    try {
      trigger.click();
      await sleep(160);
      const listId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
      const list =
        (listId ? document.getElementById(listId) : null) ||
        document.querySelector<HTMLElement>('[role="listbox"]:not([aria-hidden="true"]),[role="menu"]:not([aria-hidden="true"])');
      if (list) {
        const options: FieldOption[] = Array.from(list.querySelectorAll<HTMLElement>('[role="option"],li'))
          .filter((item) => {
            const rect = item.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          })
          .map((item) => ({
            text: clean(item.textContent || ''),
            value: item.getAttribute('data-value') || item.getAttribute('value') || '',
          }))
          .filter((option) => option.text);
        if (options.length) field.options = options;
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      await sleep(80);
    } catch {
      /* 单个下拉采集失败不阻塞整页抽取 */
    }
  }
  return schema;
}

async function collectSchemaForCurrentPage(): Promise<ExtractResult> {
  return enrichDewuCustomOptions(extractSchema());
}

/** 从 FILL 消息里取出可执行的 Step[]（兼容 steps / plan / plan.steps 三种包法）。 */
function toSteps(input: unknown): Step[] | null {
  const asRecord = (value: unknown): Record<string, unknown> | null =>
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  const root = asRecord(input);
  if (!root) return null;
  const raw = Array.isArray(root.steps)
    ? root.steps
    : Array.isArray(root.plan)
      ? root.plan
      : (() => {
          const plan = asRecord(root.plan);
          return plan && Array.isArray(plan.steps) ? plan.steps : null;
        })();
  if (!raw) return null;
  return (raw as unknown[]).filter((item): item is Step => {
    const step = asRecord(item);
    return !!step && typeof step.fieldId === 'string' && typeof step.kind === 'string';
  });
}

/**
 * 预展开（GET_SCHEMA / FILL 前，纯登记制）：有规则才跑，无规则直接跳过（连扫描都不扫）。
 * 命中时把规则 scope 里藏着表单控件的折叠块点开再抽取/回填，避免字段被 isVisible 过滤掉。
 * hostPage.evaluate 是同步调用的 Promise 包装（async 注入函数会被 await 拍平），
 * 所以直接 await；2s 超时兜底，超时/失败都直接往下走，不阻塞正事。
 */
async function preExpandBestEffort(): Promise<void> {
  let gated = false;
  try {
    gated = !!matchExpandRule(location.href);
  } catch {
    gated = false;
  }
  if (!gated) return;
  try {
    await Promise.race([
      hostPage.evaluate(pageExpandAll, location.href),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ]);
  } catch {
    /* 预展开失败不阻塞抽取/回填 */
  }
}

/**
 * 真实回填：只跑 status === 'pending' 的步骤（runPlan 内部同样只认 pending，
 * requiresReview / skip / manual 保持原样返回，绝不写入 DOM）。
 */
export interface ClearResult {
  ok: boolean;
  cleared: number;
  total: number;
  error?: string;
}

/** 一键清除：按 id 列表清空页面控件值（value 不参与路由签名，不会触发重抽） */
export async function clearWithIds(input: unknown): Promise<ClearResult> {
  const asRecord = (value: unknown): Record<string, unknown> | null =>
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  const root = asRecord(input);
  const raw = root && Array.isArray(root.ids) ? root.ids : null;
  const ids = (raw as unknown[] | null)?.filter((v): v is string => typeof v === 'string' && v.length > 0) ?? [];
  if (!ids.length) return { ok: false, cleared: 0, total: 0, error: '当前没有可清除的字段' };
  const r = await hostPage.evaluate(pageClearAll, ids);
  return { ok: true, cleared: r.cleared, total: r.total };
}

export async function fillWithSteps(input: unknown): Promise<FillResult> {
  const steps = toSteps(input);
  if (!steps) return { ok: false, filled: 0, total: 0, error: '缺少可执行的回填步骤（需要 Step[]）' };
  const pending = steps.filter((step) => step.status === 'pending');
  if (!pending.length) {
    return { ok: false, filled: 0, total: steps.length, error: '没有待填步骤（AI 决策全部跳过）' };
  }
  await preExpandBestEffort();
  const done = await runPlan(hostPage, steps);
  const filled = done.filter((step) => step.status === 'filled').length;
  return { ok: true, filled, total: done.length, steps: done };
}

function setupRouteWatcher(): () => void {
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  /**
   * 路由/结构签名：只认「字段增删 / 可用性变化」，不认现值。
   * attribute（tag/type/name/id/placeholder/role/disabled）参与签名，value/checked 等现值不参与，
   * 因此一键填入造成的 DOM 变化不会触发 ROUTE_CHANGED，不会导致侧边栏重跑 AI；
   * SPA 同 URL 换表单（数量相同但字段不同）也能被控件摘要检出。
   */
  const hashText = (text: string): string => {
    let hash = 5381;
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    return (hash >>> 0).toString(16);
  };

  const signature = (): string => {
    const controls = Array.from(
      document.querySelectorAll('input,select,textarea,[contenteditable]')
    )
      .slice(0, 120)
      .map((node) => {
        const typed = node as HTMLInputElement;
        return [
          node.tagName,
          (typed.type || '').toLowerCase(),
          typed.name || '',
          node.id || '',
          node.getAttribute?.('placeholder') || '',
          (node.getAttribute?.('role') || '').toLowerCase(),
          typed.disabled ? '1' : '0',
        ].join('~');
      })
      .join(';');
    const count = document.querySelectorAll('input,select,textarea').length;
    return location.href + '|' + String(count) + '|' + hashText(controls);
  };

  let lastSignature = signature();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const notify = (): void => {
    const next = signature();
    if (next === lastSignature) return;
    lastSignature = next;
    try {
      // 没有接收方（侧边栏未打开 / SW 休眠）时会 reject，静默忽略
      chrome.runtime.sendMessage({ type: 'ROUTE_CHANGED', url: location.href }).catch(() => {});
    } catch {
      /* 扩展上下文已失效（更新 / 重载），忽略 */
    }
  };

  // 去抖 500ms：SPA 首屏经常连续多次 pushState + 大量 DOM 变更
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(notify, 500);
  };

  history.pushState = function (this: History, data: unknown, unused: string, url?: string | URL | null) {
    const result = originalPushState.call(this, data, unused, url);
    schedule();
    return result;
  };
  history.replaceState = function (this: History, data: unknown, unused: string, url?: string | URL | null) {
    const result = originalReplaceState.call(this, data, unused, url);
    schedule();
    return result;
  };

  window.addEventListener('popstate', schedule);
  window.addEventListener('hashchange', schedule);

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  return () => {
    if (timer) clearTimeout(timer);
    observer.disconnect();
    window.removeEventListener('popstate', schedule);
    window.removeEventListener('hashchange', schedule);
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
  };
}

/* ------------------------------------------------------------------ *
 * 入口                                                               *
 * ------------------------------------------------------------------ */

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  runAt: 'document_idle',
  main(ctx) {
    const extract = extractSchema;

    // 侧边栏 / 调试入口：window.__autoInfo（content script 的 isolated world 内可见）
    window.__autoInfo = {
      version: BRIDGE_VERSION,
      extract,
      fill: fillWithSteps,
      clear: clearWithIds,
    };

    chrome.runtime.onMessage.addListener(
      (message: unknown, _sender: unknown, sendResponse: (response?: unknown) => void) => {
      const type = (message as { type?: string } | null)?.type;
      if (!type) return false;

      switch (type) {
        case 'PING':
          sendResponse({ ok: true, bridgeVersion: BRIDGE_VERSION });
          return false;

        case 'GET_SCHEMA': {
          if (!isRecruitingPage(location.href)) {
            sendResponse({ ok: false, nonRecruiting: true, error: '当前不是招聘页面，插件仅在招聘站点工作' });
            return false;
          }
          // 先预展开再抽取：折叠块里的字段否则会被 isVisible 过滤掉；2s 超时直接往下走
          preExpandBestEffort()
            .then(() => collectSchemaForCurrentPage())
            .then((schema) => sendResponse({ ok: true, bridgeVersion: BRIDGE_VERSION, schema }))
            .catch((error: unknown) =>
              sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
            );
          return true;
        }

        case 'COLLECT_REPORT':
          collectSchemaForCurrentPage()
            .then((schema) => sendResponse({ ok: true, snapshot: collectPageReport(schema) }))
            .catch((error: unknown) =>
              sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
            );
          return true;

        case 'CLEAR': {
          if (!isRecruitingPage(location.href)) {
            sendResponse({ ok: false, cleared: 0, total: 0, nonRecruiting: true, error: '当前不是招聘页面，插件仅在招聘站点工作' });
            return false;
          }
          clearWithIds(message)
            .then((result) => sendResponse(result))
            .catch((error: unknown) =>
              sendResponse({
                ok: false,
                cleared: 0,
                total: 0,
                error: error instanceof Error ? error.message : String(error),
              })
            );
          return true;
        }

        case 'FILL': {
          if (!isRecruitingPage(location.href)) {
            sendResponse({ ok: false, filled: 0, total: 0, nonRecruiting: true, error: '当前不是招聘页面，插件仅在招聘站点工作' });
            return false;
          }
          // 真实回填：steps 由侧边栏按 background AI_CALL 的 decisions 转成
          fillWithSteps(message)
            .then((result) => sendResponse(result))
            .catch((error: unknown) =>
              sendResponse({
                ok: false,
                filled: 0,
                total: 0,
                error: error instanceof Error ? error.message : String(error),
              })
            );
          return true;
        }

        case 'FOCUS_FIELD': {
          if (!isRecruitingPage(location.href)) {
            sendResponse({ ok: false, nonRecruiting: true, error: '当前不是招聘页面，插件仅在招聘站点工作' });
            return false;
          }
          const fieldId = (message as { fieldId?: unknown })?.fieldId;
          if (typeof fieldId !== 'string' || !fieldId) {
            sendResponse({ ok: false, error: '缺少字段 id' });
            return false;
          }
          hostPage
            .evaluate(pageFocusField, fieldId)
            .then((result) => sendResponse(result))
            .catch((error: unknown) =>
              sendResponse({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              })
            );
          return true;
        }

        default:
          return false;
      }
    });

    const stopRouteWatcher = setupRouteWatcher();
    ctx.onInvalidated(() => {
      stopRouteWatcher();
      delete window.__autoInfo;
    });
  },
});
