import * as React from 'react';
import { AlertTriangle, Eraser, Loader2, RefreshCw, Settings as SettingsIcon, Sparkles, Upload, WandSparkles, X } from 'lucide-react';
import { Logo } from '../../components/brand/Logo';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Toaster, toast } from '../../components/ui/toast';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { cn } from '../../components/ui/utils';
import { ReportClient } from '../../lib/api';
import { activeProfileOf, loadAIProfiles } from '../../lib/ai';
import '../../lib/use-theme';
import { ThemeToggle } from '../../components/theme/ThemeToggle';
import { EmptyState, ErrorState, NonRecruitingState, SectionCard, SkeletonList } from './components/FieldList';
import { Modal } from './components/Modal';
import { SettingsPanel } from './components/SettingsPanel';
import { useAIProfiles } from './features/ai-profiles/hooks';
import { useCandidate } from './features/candidate/hooks';
import { buildFillSteps, buildManualSteps } from './features/schema/helpers';
import type { BusyState, FillResponse } from './features/schema/types';
import { errorText, friendlyNotice } from './features/server/errors';
import { useSchemaLoad, useServerSettings } from './features/server/hooks';

const COLLAPSED_STORAGE_KEY = 'autoInfo.sectionCollapsed';
const DEFAULT_COLLAPSED: Record<string, boolean> = {
  '已填': true,
  '未填': true,
};

export function App() {
  const [showSettings, setShowSettings] = React.useState(false);
  const [closing, setClosing] = React.useState(false);
  const closeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [busy, setBusy] = React.useState<BusyState>(null);
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>(DEFAULT_COLLAPSED);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await chrome.storage.local.get(COLLAPSED_STORAGE_KEY);
        const val = stored[COLLAPSED_STORAGE_KEY];
        if (!cancelled && val && typeof val === 'object') {
          setCollapsed((prev) => ({ ...prev, ...val }));
        }
      } catch {
        /* 忽略读取异常 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const [showClearConfirm, setShowClearConfirm] = React.useState(false);
  const { server, updateServer } = useServerSettings();
  const sl = useSchemaLoad();
  const { schema, domain, mode, modeHint, loading, loadError, nonRecruiting, plan, aiLoading, aiError } = sl;
  const [hintDismissed, setHintDismissed] = React.useState(false);
  React.useEffect(() => { setHintDismissed(false); }, [modeHint]);
  const { pendingSchema, rows, filledRows, skippedRows, filledCount, totalCount, coverage } = sl;
  const { tabIdRef, justFilledRef, loadPage, handleRetryAI, handleGenerate, clearPlan } = sl;
  // 手动补值草稿：fieldId -> 手填文本，输入即存；重抽/路由切换导致字段消失时剪掉幽灵项。
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    if (!schema) {
      setDrafts({});
      return;
    }
    const alive = new Set(schema.fields.map((field) => field.id));
    setDrafts((prev) => {
      const keys = Object.keys(prev);
      if (keys.every((key) => alive.has(key))) return prev;
      const next: Record<string, string> = {};
      for (const key of keys) {
        if (alive.has(key)) next[key] = prev[key];
      }
      return next;
    });
  }, [schema]);
  const handleDraftChange = React.useCallback((fieldId: string, value: string) => {
    setDrafts((prev) => {
      if (!value) {
        if (!(fieldId in prev)) return prev;
        const next = { ...prev };
        delete next[fieldId];
        return next;
      }
      return { ...prev, [fieldId]: value };
    });
  }, []);
  const optionsMap = React.useMemo(
    () => new Map((schema?.fields ?? []).map((field) => [field.id, field.options ?? []] as const)),
    [schema],
  );
  const optionsOf = React.useCallback((fieldId: string) => optionsMap.get(fieldId), [optionsMap]);
  const manualCount = React.useMemo(
    () => Object.values(drafts).filter((value) => value.trim().length > 0).length,
    [drafts],
  );
  const canGenerate = !loading && !aiLoading && !busy && Boolean(pendingSchema) && pendingSchema.fields.length > 0;
  const ai = useAIProfiles();
  const cand = useCandidate();
  const { reload: reloadProfiles } = ai;
  const { refresh: refreshCandidate } = cand;

  const openSettings = React.useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setClosing(false);
    setShowSettings(true);
    void reloadProfiles();
    void refreshCandidate();
  }, [reloadProfiles, refreshCandidate]);

  // 设置页退出先播 slide-out 动画，180ms 后再卸载；卸载时清理 timer
  React.useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
  }, []);

  React.useEffect(() => {
    if (!showSettings) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [showSettings]);

  // AI 识别失败统一走 toast，带重试动作；不再在列表顶部挤一条小字。
  React.useEffect(() => {
    if (!aiError) return;
    toast.error(aiError, { action: { label: '重试', run: handleRetryAI } });
    // 只跟随错误文本变化触发，重试动作取当次渲染的 handleRetryAI 即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiError]);

  const handleFill = async () => {
    if (busy || aiLoading || !pendingSchema) return;
    if (!plan) {
      toast.info('请先点击一键生成，让 AI 给出可填项');
      return;
    }
    setBusy('fill');
    try {
      const tabId = tabIdRef.current;
      if (!tabId) throw new Error('找不到当前标签页，请重新抽取');
      const steps = buildFillSteps(pendingSchema, plan);
      if (!steps.length) {
        toast.info('AI 没有给出可填项（全部跳过），无需填入');
        return;
      }
      const result = (await chrome.tabs.sendMessage(tabId, { type: 'FILL', steps })) as FillResponse | undefined;
      if (result?.ok) {
        justFilledRef.current = Date.now();
        toast.success(`已填入 ${result.filled ?? 0} 个字段`, {
          description: '请逐项核对后手动提交',
        });
        // 等页面框架重渲染落定再重抽，loadPage 里还有收缩确认兜底。
        void loadPage({ silent: true, delayMs: 700 });
      } else {
        const f = friendlyNotice(result?.error || result?.reason || '回填失败', '重试', () => void handleFill(), openSettings);
        toast.error(f.text, { action: f.action });
      }
    } catch (error) {
      const f = friendlyNotice(error, '重试', () => void handleFill(), openSettings);
      toast.error(`填入失败：${f.text}`, { action: f.action });
    } finally {
      setBusy(null);
    }
  };

  // 一键导入信息库：非空草稿组 Step → FILL 成功 → 清草稿 → 静默重抽（只更新已填/未填）→ 合并进候选人信息库。
  // 合并失败只 toast，不影响已填入的页面值；AI 无 Key 时降级为只填页。
  const handleImportManual = async () => {
    if (busy || aiLoading || loading || cand.merging) return;
    if (!schema) {
      toast.error('还没有抽到页面字段，请先重新抽取');
      return;
    }
    const steps = buildManualSteps(schema, drafts);
    if (!steps.length) {
      toast.info('没有可导入的手动补值');
      return;
    }
    const tabId = tabIdRef.current;
    if (!tabId) {
      toast.error('找不到当前标签页，请重新抽取');
      return;
    }
    setBusy('fill');
    try {
      const result = (await chrome.tabs.sendMessage(tabId, { type: 'FILL', steps })) as FillResponse | undefined;
      if (!result?.ok) {
        // FILL 失败直接中止：不清草稿、不重抽、不触发 AI。
        const f = friendlyNotice(result?.error || result?.reason || '回填失败', '重试', () => void handleImportManual(), openSettings);
        toast.error(f.text, { action: f.action });
        return;
      }
      const lines = steps.map((step) => `${String(step.label || step.fieldId)}：${String(step.wanted ?? '').trim()}`);
      const importedIds = new Set(steps.map((step) => step.fieldId));
      setDrafts((prev) => {
        const next: Record<string, string> = {};
        for (const [key, value] of Object.entries(prev)) {
          if (!importedIds.has(key)) next[key] = value;
        }
        return next;
      });
      justFilledRef.current = Date.now();
      toast.success(`已导入 ${result.filled ?? steps.length} 个手动补值`, {
        description: '请逐项核对后手动提交',
      });
      // 等页面框架重渲染落定再重抽，只更新已填/未填数，不再自动一键生成。
      await loadPage({ silent: true, delayMs: 700 });
      // 合并进信息库：读 storage 确认 AI Key，无 Key 降级为只填页。
      let key = ai.activeProfile?.apiKey?.trim() ?? '';
      try {
        const stored = await loadAIProfiles();
        key = activeProfileOf(stored)?.apiKey?.trim() || key;
      } catch {
        /* 读不到 storage 就用内存态兜底 */
      }
      if (!key) {
        toast.info('已填入页面；AI 未配置 Key，跳过信息库合并');
        return;
      }
      try {
        const merged = await cand.mergeManualLines(lines);
        if (merged) toast.success('信息库已合并更新');
      } catch (error) {
        toast.error('信息库合并失败，已填入的页面值不受影响', { description: errorText(error) });
      }
    } catch (error) {
      const f = friendlyNotice(error, '重试', () => void handleImportManual(), openSettings);
      toast.error(`导入失败：${f.text}`, { action: f.action });
    } finally {
      setBusy(null);
    }
  };

  const handleClear = async () => {
    if (busy || loading) return;
    const ids = (schema?.fields ?? []).map((f) => f.id).filter(Boolean);
    if (!ids.length) {
      setShowClearConfirm(false);
      toast.info('当前没有可清除的字段');
      return;
    }
    const tabId = tabIdRef.current;
    if (!tabId) {
      setShowClearConfirm(false);
      toast.error('找不到当前标签页，请重新抽取');
      return;
    }
    setShowClearConfirm(false);
    setBusy('clear');
    try {
      let result: { ok?: boolean; cleared?: number; error?: string } | undefined;
      try {
        result = (await chrome.tabs.sendMessage(tabId, { type: 'CLEAR', ids })) as { ok?: boolean; cleared?: number; error?: string } | undefined;
      } catch {
        result = undefined;
      }
      if (result?.ok) {
        // 清除页面值 + 清空 AI 决策，已填数回 0；静默重抽刷新待填列表。
        clearPlan();
      setDrafts({});
        toast.success(`已清空 ${result.cleared ?? 0} 个字段`);
        // 等清空触发的条件显隐落定再重抽，loadPage 里还有收缩确认兜底。
        void loadPage({ silent: true, delayMs: 700 });
      } else if (!result) {
        // 旧版 content script 没有 CLEAR 分支时会回 undefined：引导刷新页面/重载扩展
        toast.error('页面脚本还是旧版，请刷新页面后重试', { action: { label: '重新抽取', run: () => void loadPage() } });
      } else {
        const f = friendlyNotice(result?.error || '清空失败', '重试', () => void handleClear(), openSettings);
        toast.error(f.text, { action: f.action });
      }
    } catch (error) {
      const f = friendlyNotice(error, '重试', () => void handleClear(), openSettings);
      toast.error(`清空失败：${f.text}`, { action: f.action });
    } finally {
      setBusy(null);
    }
  };

  const handleReport = async () => {
    if (busy) return;
    setBusy('report');
    try {
      const client = new ReportClient({ baseUrl: server.baseUrl, token: server.token });
      const { reportId } = await client.postReportFlow({ domain: domain || undefined, schema: schema ?? undefined });
      toast.success(reportId == null ? '已上报当前页（服务端未返回 reportId）' : `已上报当前页 · reportId=${reportId}`);
    } catch (error) {
      const f = friendlyNotice(error, '重试', () => void handleReport(), openSettings);
      toast.error(f.text, { action: f.action });
    } finally {
      setBusy(null);
    }
  };

  const closeSettings = React.useCallback(() => {
    if (closeTimerRef.current) return;
    setClosing(true);
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setShowSettings(false);
    }, 180);
  }, []);
  const toggleSection = (section: string) => {
    setCollapsed((c) => {
      const next = { ...c, [section]: !c[section] };
      void chrome.storage.local.set({ [COLLAPSED_STORAGE_KEY]: next }).catch(() => {});
      return next;
    });
  };

  const handleLocateField = React.useCallback(async (fieldId: string) => {
    const tabId = tabIdRef.current;
    if (!tabId) {
      toast.error('找不到当前标签页，请重新抽取');
      return;
    }
    // 探活：先发 PING（0.5.0+ content 才有）；PING 无应答再用 GET_SCHEMA 区分“未注入”还是“旧版 content”。
    // 旧版 content 收不到 PING，且 GET_SCHEMA 回包里没有 bridgeVersion。
    let ping: { ok?: boolean; bridgeVersion?: string } | undefined;
    try {
      ping = (await chrome.tabs.sendMessage(tabId, { type: 'PING' })) as
        | { ok?: boolean; bridgeVersion?: string }
        | undefined;
    } catch {
      ping = undefined;
    }
    if (!ping) {
      let probe: { ok?: boolean; bridgeVersion?: string } | undefined;
      try {
        probe = (await chrome.tabs.sendMessage(tabId, { type: 'GET_SCHEMA' })) as
          | { ok?: boolean; bridgeVersion?: string }
          | undefined;
      } catch {
        probe = undefined;
      }
      if (probe && probe.bridgeVersion == null) {
        toast.error('扩展是旧版，请在 chrome://extensions 点重载扩展后再刷新招聘页', { action: { label: '重新抽取', run: () => void loadPage() } });
      } else {
        toast.error('扩展未注入，请刷新页面后重试', { action: { label: '重新抽取', run: () => void loadPage() } });
      }
      return;
    }
    try {
      const result = (await chrome.tabs.sendMessage(tabId, { type: 'FOCUS_FIELD', fieldId })) as
        | { ok?: boolean; error?: string }
        | undefined;
      if (!result) {
        // PING 通但 FOCUS_FIELD 无应答：只有旧版 content 会这样，防御性归到旧版。
        toast.error('扩展是旧版，请在 chrome://extensions 点重载扩展后再刷新招聘页', { action: { label: '重新抽取', run: () => void loadPage() } });
      } else if (!result.ok) {
        toast.error(result.error || '页面上找不到该字段');
      }
    } catch {
      toast.info('页面未响应，刷新页面后重试');
    }
  }, [tabIdRef, loadPage]);

  // 底部第二个按钮双态：未填草稿是否被编辑（manualCount > 0 即 dirty，以真实草稿状态为准）。
  const hasManualDraft = manualCount > 0;
  const canFill = !loading && !aiLoading && Boolean(plan) && filledRows.length > 0;

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {showSettings ? null : (
        <>
          <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background/95 px-3 backdrop-blur">
            <Logo className="h-5 w-5 shrink-0 text-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <Badge tone={mode === 'site' ? 'violet' : 'neutral'} className="shrink-0 px-1.5">
                  {mode === 'site' ? '站点模式' : '通用模式'}
                </Badge>
                <span
                  className="min-w-0 truncate text-ui-sm leading-4 text-foreground-subtle"
                  title={schema?.url || domain || undefined}
                >
                  {domain || '未检测到招聘页'}
                </span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <div
                className="mr-0.5 flex flex-col items-end leading-tight"
                aria-label={`已填 ${filledCount} / 共 ${totalCount} 项`}
              >
                <span className="text-ui-sm tabular-nums text-foreground" title={`已填 ${filledCount} / 共 ${totalCount} 项`}>
                  {filledCount}/{totalCount}
                </span>
              </div>
              <Tooltip>
                <TooltipTrigger>
                  <Button variant="ghost" size="icon-sm" onClick={() => setShowClearConfirm(true)} disabled={loading || Boolean(busy) || rows.length === 0} aria-label="一键清除（清空当前所有字段）">
                    <Eraser className={busy === 'clear' ? 'h-3.5 w-3.5 animate-pulse' : 'h-3.5 w-3.5'} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">一键清除（清空当前所有字段）</TooltipContent>
              </Tooltip>
              <Button variant="ghost" size="icon-sm" onClick={() => void loadPage()} disabled={loading || Boolean(busy)} title="重新抽取">
                <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={openSettings} title="设置">
                <SettingsIcon className="h-3.5 w-3.5" />
              </Button>
              <div data-slot="theme-toggle">
                <ThemeToggle />
              </div>
            </div>
          </header>
          <div className="h-[3px] w-full shrink-0 bg-surface" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={coverage} aria-label="覆盖率">
            <div
              className="h-full rounded-full bg-gradient-to-r from-brand to-idle-task transition-all duration-500"
              style={{ width: `${coverage}%` }}
            />
          </div>

          <main className="flex min-w-0 flex-1 flex-col gap-3 px-3 pb-28 pt-3">
            {modeHint && !hintDismissed ? (
              <div className="flex gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <span className="min-w-0 flex-1 text-ui-caption leading-relaxed text-foreground-subtle">
                  {modeHint}，已回落到通用抽取。
                </span>
                <Button variant="ghost" size="icon-sm" className="-mr-1 -mt-0.5 shrink-0" onClick={() => setHintDismissed(true)} title="关闭提示" aria-label="关闭提示">
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ) : null}

            {loading ? <SkeletonList /> : nonRecruiting ? <NonRecruitingState onRetry={() => void loadPage()} /> : loadError ? <ErrorState message={loadError} onRetry={() => void loadPage()} /> : rows.length === 0 ? <EmptyState onRetry={() => void loadPage()} /> : (
              <>
                {aiLoading ? (
                  <div className="flex flex-col gap-3" aria-busy="true">
                    <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-ui-sm text-foreground-subtle">
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-foreground-subtle" />
                      <span className="truncate">AI 正在识别可填项…</span>
                    </div>
                    <SkeletonList />
                  </div>
                ) : (
                  <>
                    {plan && filledRows.length === 0 && !aiError ? (
                      <div className="rounded-lg border border-dashed border-border px-3 py-3 text-center text-ui-caption text-foreground-subtle">
                        AI 没有给出可填项，可重新生成或上报当前页。
                      </div>
                    ) : null}
                    <SectionCard section="已填" rows={filledRows} collapsed={Boolean(collapsed['已填'])} onToggle={() => toggleSection('已填')} onLocateRow={handleLocateField}
                      badge={filledRows.length ? { text: `${filledRows.length} 已填`, tone: 'success' } : null} />
                    <SectionCard section="未填" rows={skippedRows} collapsed={Boolean(collapsed['未填'])} onToggle={() => toggleSection('未填')} onLocateRow={handleLocateField}
                      badge={skippedRows.length ? { text: `${skippedRows.length} 未填`, tone: 'neutral' } : null}
                      editable drafts={drafts} optionsOf={optionsOf} onDraftChange={handleDraftChange} />
                  </>
                )}
              </>
            )}
          </main>

          <footer className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-background/95 px-3 pt-2.5 pb-[calc(10px_+_env(safe-area-inset-bottom))] backdrop-blur">
            <div className="flex min-w-0 items-center gap-2">
              <Button
                variant="outline"
                className="h-8 min-w-0 flex-1 disabled:opacity-60"
                onClick={handleGenerate}
                disabled={Boolean(busy) || loading || aiLoading || !canGenerate}
                title="调用 AI 识别可填项"
              >
                {aiLoading ? <Loader2 className="animate-spin" /> : <Sparkles />}
                <span className="truncate">一键生成</span>
              </Button>
              {hasManualDraft ? (
                <Button
                  className="h-8 min-w-0 flex-1 disabled:opacity-60"
                  onClick={() => void handleImportManual()}
                  disabled={Boolean(busy) || loading || aiLoading || cand.merging}
                  title="导入信息库（填入手动补值并合并）"
                >
                  {busy === 'fill' ? <Loader2 className="animate-spin" /> : <Upload />}
                  <span className="truncate">导入信息库</span>
                </Button>
              ) : (
                <Button
                  className="h-8 min-w-0 flex-1 disabled:opacity-60"
                  onClick={() => void handleFill()}
                  disabled={Boolean(busy) || loading || aiLoading || !canFill}
                >
                  {busy === 'fill' ? <Loader2 className="animate-spin" /> : <WandSparkles />}
                  <span className="truncate">一键填入</span>
                </Button>
              )}
              <Tooltip className="shrink-0">
                <TooltipTrigger>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8 shrink-0 disabled:opacity-60"
                    onClick={() => void handleReport()}
                    disabled={Boolean(busy) || loading || aiLoading}
                    aria-label="上报当前页"
                  >
                    {busy === 'report' ? <Loader2 className="animate-spin" /> : <Upload />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" className="right-0 left-auto translate-x-2">
                  上报当前页
                </TooltipContent>
              </Tooltip>
            </div>
          </footer>
        </>
      )}
      {showSettings ? (
        <SettingsPanel server={server} onUpdateServer={updateServer} ai={ai} cand={cand} onClose={closeSettings} closing={closing} />
      ) : null}
      {showClearConfirm ? (
        <Modal
          title="确认清空？"
          onClose={() => { if (busy !== 'clear') setShowClearConfirm(false); }}
          footer={(
            <div className="ml-auto flex items-center gap-2">
              <Button variant="outline" onClick={() => setShowClearConfirm(false)} disabled={busy === 'clear'}>
                取消<span className="ml-1 text-ui-sm text-foreground-subtlest">esc</span>
              </Button>
              <Button variant="destructive" onClick={() => void handleClear()} disabled={busy === 'clear'}>
                确认清空
              </Button>
            </div>
          )}
        >
          <p className="text-ui-base leading-relaxed text-foreground-subtle">
            清空后将移除页面上当前所有字段的已填内容，该操作不会自动恢复。
          </p>
        </Modal>
      ) : null}
      <Toaster offset={showSettings ? 48 : 92} />
    </div>
  );
}
