import * as React from 'react';
import { normalizeBaseUrl, type SchemaJSON } from '../../../../lib/api';
import type { AIPlan } from '../../../../lib/schema.js';
import { toast } from '../../../../components/ui/toast';
import { DEFAULT_SERVER, STORAGE_KEYS, errorText, hostOf, type ServerSettings } from './errors';
import { buildRows, pendingFieldsOf, sameSchemaShape, sendToBackground } from '../schema/helpers';
import type { AIPlanMessage, SchemaResponse, SiteMode, SiteSchemaMessage, TabChangeInfo, TokenMessage } from '../schema/types';

/** 本地服务设置：baseUrl 走 storage，token 走 background；改动去抖 800ms 自动存 */
export function useServerSettings() {
  const [server, setServer] = React.useState<ServerSettings>(DEFAULT_SERVER);
  const serverTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await chrome.storage.local.get([STORAGE_KEYS.baseUrl]);
        const tokenMessage = await sendToBackground<TokenMessage>({ type: 'GET_TOKEN' });
        const baseUrlValue = stored[STORAGE_KEYS.baseUrl];
        if (cancelled) return;
        setServer({
          baseUrl: typeof baseUrlValue === 'string' && baseUrlValue.trim() ? baseUrlValue.trim() : DEFAULT_SERVER.baseUrl,
          token: tokenMessage?.token || '',
        });
      } catch (error) {
        if (!cancelled) toast.error(`读取设置失败：${errorText(error)}`);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const updateServer = (patch: Partial<ServerSettings>) => {
    const next = { ...server, ...patch };
    setServer(next);
    if (serverTimer.current) clearTimeout(serverTimer.current);
    serverTimer.current = setTimeout(() => {
      void (async () => {
        try {
          const clean: ServerSettings = { baseUrl: normalizeBaseUrl(next.baseUrl), token: next.token.trim() };
          await chrome.storage.local.set({ [STORAGE_KEYS.baseUrl]: clean.baseUrl });
          await sendToBackground({ type: 'SET_TOKEN', token: clean.token });
          toast.success('服务设置保存成功');
        } catch (error) {
          toast.error(`服务设置保存失败：${errorText(error)}`);
        }
      })();
    }, 800);
  };
  return { server, updateServer };
}

/** 页面抽取 + 纯 AI 决策：调不通则清空 plan，行列表全落到「AI 跳过」 */
export function useSchemaLoad() {
  const [schema, setSchema] = React.useState<SchemaJSON | null>(null);
  const [domain, setDomain] = React.useState('');
  const [mode, setMode] = React.useState<SiteMode>('generic');
  const [modeHint, setModeHint] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [nonRecruiting, setNonRecruiting] = React.useState(false);
  const [plan, setPlan] = React.useState<AIPlan | null>(null);
  const [aiLoading, setAiLoading] = React.useState(false);
  const [aiError, setAiError] = React.useState<string | null>(null);
  const tabIdRef = React.useRef<number | null>(null);
  const fullShapeRef = React.useRef<SchemaJSON | null>(null);
  // AI 决策单槽缓存：新生成直接覆盖旧的，切 Tab 再切回 shape 对得上就恢复，不靠“已填入页面”留存。
  // 放侧边栏 window.localStorage（不用 chrome.storage，免得域名一多触配额）。
  // 单槽 + 归属绑定：只恢复“同页”（url 一致且 shape 一致），新页永远用当前页现抽，绝不吃旧缓存。
  const planCacheKey = 'autoInfo.aiPlan';
  const readPlanCache = (): { schema: SchemaJSON; plan: AIPlan; url: string; tabId: number | null } | null => {
    try {
      const raw = window.localStorage.getItem(planCacheKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { schema?: SchemaJSON; plan?: AIPlan; url?: unknown; tabId?: unknown };
      if (!parsed?.schema || !parsed?.plan || typeof parsed.url !== 'string') return null;
      return { schema: parsed.schema, plan: parsed.plan, url: parsed.url, tabId: typeof parsed.tabId === 'number' ? parsed.tabId : null };
    } catch { return null; }
  };
  const writePlanCache = (schema: SchemaJSON, plan: AIPlan, url: string, tabId: number | null) => {
    try { window.localStorage.setItem(planCacheKey, JSON.stringify({ schema, plan, url, tabId })); } catch { /* 写失败就丢弃，下次覆盖 */ }
  };
  const dropPlanCache = () => {
    try { window.localStorage.removeItem(planCacheKey); } catch { /* 忽略 */ }
  };
  const refreshTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const schemaRef = React.useRef<SchemaJSON | null>(null);
  const planSchemaRef = React.useRef<SchemaJSON | null>(null);
  const loadSeqRef = React.useRef(0);
  const justFilledRef = React.useRef(0);

  const pendingSchema = React.useMemo(() => pendingFieldsOf(schema), [schema]);
  // 列表 / 计数看全量 schema：已填项按页面现值算已填，填完不消失，总数保持稳定。
  const rows = React.useMemo(() => buildRows(schema, plan), [schema, plan]);
  // 顶部计数分母：抽取到的全部可填组件数（schema.fields 全量，含 AI 未决策/跳过/已填/未填），
  // 直取全量抽取，不跟 AI 决策字段数走；buildRows 与 schema.fields 严格 1:1，故已填+未填恒等于该分母。
  const totalCount = schema?.fields.length ?? 0;
  const filledRows = React.useMemo(() => rows.filter((row) => row.filled), [rows]);
  const skippedRows = React.useMemo(() => rows.filter((row) => !row.filled), [rows]);
  const filledCount = filledRows.length;
  const coverage = totalCount ? Math.round((filledCount / totalCount) * 100) : 0;

  /* 发全量 schema：buildUserPayload 要用已填字段算 filledSiblings/occurrence，
     无待填项时直接清空 plan 不发请求；plan 落盘仍用 pendingSchema，buildFillSteps 只认待填。 */
  const runAI = React.useCallback(async (full: SchemaJSON | null, pending: SchemaJSON | null) => {
    if (!pending || !pending.fields.length) {
      setPlan(null);
      setAiLoading(false);
      return;
    }
    if (!full || !full.fields.length) {
      setPlan(null);
      setAiLoading(false);
      return;
    }
    setAiLoading(true);
    setAiError(null);
    try {
      // 候选人信息库由 background 侧供给，这里保持 null
      const response = await sendToBackground<AIPlanMessage>({ type: 'AI_CALL', schema: full, profileSubset: null });
      if (!response) throw new Error('后台脚本未响应');
      if (!response.ok || !response.result) throw new Error(response.error || 'AI 调用失败（无 Key 时请先在设置里填写 AI Key）');
      setPlan(response.result);
      // 落缓存：新生成直接覆盖旧的，顺手记下 url+tab 归属。
      try { if (full) writePlanCache(full, response.result, full.url || '', tabIdRef.current); } catch { /* 缓存失败不影响主流程 */ }
    } catch (error) {
      setPlan(null);
      setAiError(errorText(error));
    } finally {
      setAiLoading(false);
    }
  }, []);

  const loadPage = React.useCallback(async (options: { silent?: boolean; delayMs?: number; retried?: boolean } = {}) => {
    const seq = ++loadSeqRef.current;
    // 填入/清空刚派发完 change 事件，页面框架（级联/条件显隐）还没重渲染完：等一拍再抽，否则撞上过渡态。
    if (options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (seq !== loadSeqRef.current) return;
    }
    if (!options.silent) setLoading(true);
    setLoadError(null);
    setNonRecruiting(false);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('找不到当前活动标签页');
      tabIdRef.current = tab.id;
      let response: SchemaResponse | undefined;
      try {
        response = (await chrome.tabs.sendMessage(tab.id, { type: 'GET_SCHEMA' })) as SchemaResponse;
      } catch {
        throw new Error('当前页面还没有注入抽取脚本，请刷新页面后重试（chrome:// 等特殊页面不支持）');
      }
      if (response?.nonRecruiting) {
        if (seq !== loadSeqRef.current) return;
        setSchema(null);
        schemaRef.current = null;
        setDomain(hostOf(tab.url || ''));
        fullShapeRef.current = null;
        planSchemaRef.current = null;
        setPlan(null);
        setAiError(null);
        setMode('generic');
        setModeHint(null);
        setNonRecruiting(true);
        return;
      }
      if (!response?.ok || !response.schema) throw new Error(response?.error || '页面字段抽取失败');
      const nextSchema = response.schema;
      if (seq !== loadSeqRef.current) return;
      // 二次确认门禁：静默重抽凡遇形状变化（一增一减都算，不只看暴跌），一律 900ms 后二次确认、以第二次为准；
      // 单次过渡态采样（Angular 两拍渲染 / 预展开误关瞬间）永远覆盖不掉好结果。102→64 事件就是 62.7% 越过旧 0.6 阈值被当合法接受。
      // 手动刷新（非 silent）和确认那次（retried）直接接受；现值变化不算形状变化，不触发确认、不清空 plan。
      const prev = schemaRef.current;
      if (options.silent && !options.retried && prev && prev.fields.length && !sameSchemaShape(prev, nextSchema)) {
        setTimeout(() => void loadPage({ silent: true, retried: true }), 900);
        return;
      }
      setSchema(nextSchema);
      schemaRef.current = nextSchema;
      const nextDomain = hostOf(nextSchema.url) || hostOf(tab.url || '');
      setDomain(nextDomain);
      const site = await sendToBackground<SiteSchemaMessage>({ type: 'GET_SCHEMA', domain: nextDomain });
      if (!site) {
        setMode('generic');
        setModeHint('后台脚本未响应');
      } else {
        setMode(site.mode === 'site' ? 'site' : 'generic');
        setModeHint(site.error ?? null);
      }
      // 手动生成模式：AI 默认不跑，不自动花钱。
      // 只有表单结构实变（换页/字段增删）才清空旧决策；填入/清空只改现值，不算实变。
      // 切 Tab 再切回：先看本 tab 的缓存，shape 对得上直接恢复，不重新花钱生成。
      if (!sameSchemaShape(fullShapeRef.current, nextSchema)) {
        fullShapeRef.current = nextSchema;
        // 同页（url 一致 + shape 一致）才恢复；新页一律丢缓存、用当前页现抽。
        const hit = readPlanCache();
        if (hit && hit.url === nextSchema.url && sameSchemaShape(hit.schema, nextSchema)) {
          planSchemaRef.current = pendingFieldsOf(nextSchema);
          setPlan(hit.plan);
          setAiError(null);
        } else {
          if (hit) dropPlanCache();
          planSchemaRef.current = null;
          setPlan(null);
          setAiError(null);
        }
      }
    } catch (error) {
      setSchema(null);
      schemaRef.current = null;
      setDomain('');
      setMode('generic');
      setLoadError(errorText(error));
    } finally {
      setLoading(false);
    }
  }, []);

  // 一键生成：只在用户点击时跑 AI，可重复点击重新生成。
  const handleGenerate = React.useCallback(() => {
    if (!pendingSchema || !pendingSchema.fields.length || aiLoading) return;
    planSchemaRef.current = pendingSchema;
    void runAI(schema, pendingSchema);
  }, [schema, pendingSchema, aiLoading, runAI]);

  const handleRetryAI = () => {
    handleGenerate();
  };

  // 一键清除成功后调用：清空 AI 决策，已填数回 0，列表全回“AI 跳过”。
  const clearPlan = React.useCallback(() => {
    planSchemaRef.current = null;
    setPlan(null);
    setAiError(null);
    dropPlanCache();
  }, []);

  React.useEffect(() => { void loadPage(); }, [loadPage]);

  React.useEffect(() => {
    const listener = (message: unknown) => {
      if ((message as { type?: string } | null)?.type !== 'ROUTE_CHANGED') return;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => void loadPage({ silent: true }), 300);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {
      chrome.runtime.onMessage.removeListener(listener);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [loadPage]);

  React.useEffect(() => {
    const onActivated = () => void loadPage({ silent: true });
    const onUpdated = (tabId: number, changeInfo: TabChangeInfo) => {
      if (changeInfo.status === 'complete' && tabId === tabIdRef.current) void loadPage({ silent: true });
    };
    // 页关掉就清单槽缓存：归属 tab 没了，旧决策不许漏给后面的新页。
    const onRemoved = (tabId: number) => {
      try { if (readPlanCache()?.tabId === tabId) dropPlanCache(); } catch { /* 忽略 */ }
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };
  }, [loadPage]);

  return {
    schema, domain, mode, modeHint, loading, loadError, nonRecruiting, plan, aiLoading, aiError,
    pendingSchema, rows, filledRows, skippedRows, filledCount, totalCount, coverage,
    tabIdRef, justFilledRef, loadPage, handleRetryAI, handleGenerate, clearPlan,
  };
}
