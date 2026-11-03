import * as React from 'react';
import { AlertTriangle, Briefcase, ChevronDown, ChevronRight, Pencil, RefreshCw, ScanSearch } from 'lucide-react';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Card } from '../../../components/ui/card';
import { Input, inputVariants } from '../../../components/ui/input';
import { cn } from '../../../components/ui/utils';
import type { FieldOption } from '../../../lib/schema.js';
import type { FieldRow } from '../features/schema/types';

export function SkeletonList() {
  return (
    <div className="space-y-2.5">
      {[0, 1, 2].map((index) => (
        <div key={index} className="animate-pulse rounded-xl border border-card-border bg-card p-3.5">
          <div className="h-3 w-24 rounded bg-surface-hover" />
          <div className="mt-3 h-3 w-full rounded bg-surface" />
          <div className="mt-2 h-3 w-2/3 rounded bg-surface" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
      <ScanSearch className="mx-auto h-6 w-6 text-foreground-subtlest" />
      <p className="mt-2 text-ui-base font-medium text-foreground">没有检测到可填写的表单字段</p>
      <p className="mt-1 text-ui-sm leading-relaxed text-foreground-subtle">
        打开招聘 / 网申页面后重新抽取；SPA 页面路由变化会自动刷新。
      </p>
      <Button variant="outline" className="mt-3 h-8" onClick={onRetry}>
        <RefreshCw />
        重新抽取
      </Button>
    </div>
  );
}

export function NonRecruitingState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
      <Briefcase className="mx-auto h-6 w-6 text-foreground-subtlest" />
      <p className="mt-2 text-ui-base font-medium text-foreground">当前不是招聘页面</p>
      <p className="mt-1 text-ui-sm leading-relaxed text-foreground-subtle">
        插件仅在招聘站点工作（职位、网申、投递页）；切到招聘页后会自动抽取。
      </p>
      <Button variant="outline" className="mt-3 h-8" onClick={onRetry}>
        <RefreshCw />
        重新抽取
      </Button>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-destructive/25 bg-destructive/8 px-4 py-6 text-center">
      <AlertTriangle className="mx-auto h-5 w-5 text-destructive" />
      <p className="mt-2 break-words text-ui-sm leading-relaxed text-foreground">{message}</p>
      <Button variant="outline" className="mt-3 h-8" onClick={onRetry}>
        <RefreshCw />
        重试
      </Button>
    </div>
  );
}

export function FieldRowView({
  row,
  onLocate,
  editable,
  draft,
  options,
  onDraftChange,
}: {
  row: FieldRow;
  onLocate?: (fieldId: string) => void;
  /** 仅未填行可编辑；已填行保持只读 */
  editable?: boolean;
  draft?: string;
  options?: FieldOption[];
  onDraftChange?: (fieldId: string, value: string) => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const locateHint = `点击定位到页面位置：${row.label || row.fieldId}`;
  const canEdit = Boolean(editable && !row.filled);
  const draftText = String(draft ?? '');
  const hasDraft = draftText.trim().length > 0;
  const datalistId = `manual-${row.fieldId}`;
  // 选项类字段给 datalist 提示；文本类按语义取原生输入类型
  const showOptions = canEdit && Boolean(options && options.length);
  const inputType = row.kind === 'date' ? 'date' : row.kind === 'number' ? 'number' : 'text';
  const isTextarea = row.kind === 'textarea';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onLocate?.(row.fieldId)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onLocate?.(row.fieldId);
        }
      }}
      title={locateHint}
      aria-label={locateHint}
      className="group block w-full cursor-pointer border-t border-border/70 px-3 py-2.5 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-ui-caption font-medium text-foreground" title={row.label}>
              {row.label || '（未命名字段）'}
            </span>
            {row.required ? (
              <span className="shrink-0 text-ui-sm leading-none text-destructive" title="必填">
                *
              </span>
            ) : null}
            <span className="shrink-0 rounded border border-border px-1 py-px text-ui-xs leading-tight text-foreground-subtle">
              {row.kind}
            </span>
            {hasDraft ? (
              <Badge tone="accent" className="shrink-0 px-1.5">
                待导入
              </Badge>
            ) : null}
          </div>
          {row.filled ? (
            <span
              className={cn('mt-0.5 block truncate text-ui-sm', 'text-foreground-subtle')}
              title={row.value || undefined}
            >
              {row.value}
            </span>
          ) : null}
          {!row.filled && row.reason ? (
            <span className="mt-0.5 block truncate text-ui-xs text-foreground-subtlest" title={row.reason}>
              {row.reason}
            </span>
          ) : null}
          {canEdit && editing ? (
            <div
              className="mt-1.5"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Escape') setEditing(false);
              }}
            >
              {isTextarea ? (
                <textarea
                  value={draftText}
                  onChange={(event) => onDraftChange?.(row.fieldId, event.target.value)}
                  placeholder="手动输入后点导入"
                  rows={2}
                  aria-label={`手动补值：${row.label || row.fieldId}`}
                  className={cn(inputVariants({ size: 'default' }), 'h-auto min-h-8 py-1.5')}
                />
              ) : (
                <Input
                  type={inputType}
                  value={draftText}
                  onChange={(event) => onDraftChange?.(row.fieldId, event.target.value)}
                  placeholder="手动输入后点导入"
                  aria-label={`手动补值：${row.label || row.fieldId}`}
                  list={showOptions ? datalistId : undefined}
                />
              )}
              {showOptions ? (
                <datalist id={datalistId}>
                  {options!.map((opt) => (
                    <option key={`${opt.text}__${opt.value ?? ''}`} value={opt.text} />
                  ))}
                </datalist>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="mt-0.5 flex shrink-0 items-center gap-1">
          {canEdit ? (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={(event) => {
                event.stopPropagation();
                setEditing((open) => !open);
              }}
              title={editing ? '收起手动输入' : '手动补值'}
              aria-label={editing ? `收起手动输入：${row.label || row.fieldId}` : `手动补值：${row.label || row.fieldId}`}
              aria-expanded={editing}
              className="opacity-0 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
            >
              <Pencil />
            </Button>
          ) : null}
          <Badge tone={row.filled ? 'success' : 'neutral'}>
            {row.filled ? '已填' : '跳过'}
          </Badge>
        </div>
      </div>
    </div>
  );
}

export function SectionCard({
  section,
  rows,
  collapsed,
  onToggle,
  badge,
  onLocateRow,
  editable,
  drafts,
  optionsOf,
  onDraftChange,
}: {
  section: string;
  rows: FieldRow[];
  collapsed: boolean;
  onToggle: () => void;
  badge: { text: string; tone: 'success' | 'neutral' } | null;
  onLocateRow?: (fieldId: string) => void;
  /** 未填卡片：行内可手动补值 */
  editable?: boolean;
  drafts?: Record<string, string>;
  optionsOf?: (fieldId: string) => FieldOption[] | undefined;
  onDraftChange?: (fieldId: string, value: string) => void;
}) {
  return (
    <Card className="min-w-0 gap-0 overflow-hidden py-0">
      <div className="flex h-10 w-full min-w-0 items-center gap-1 pl-1.5 pr-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
        >
          {collapsed ? (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-foreground-subtlest" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-foreground-subtlest" />
          )}
          <span className="min-w-0 flex-1 truncate text-ui-caption font-semibold text-foreground">{section}</span>
        </button>
        {badge ? <Badge tone={badge.tone}>{badge.text}</Badge> : null}
      </div>
      {collapsed ? null : (
        <div>
          {rows.map((row) => (
            <FieldRowView
              key={row.fieldId}
              row={row}
              onLocate={onLocateRow}
              editable={editable}
              draft={drafts?.[row.fieldId]}
              options={optionsOf?.(row.fieldId)}
              onDraftChange={onDraftChange}
            />
          ))}
        </div>
      )}
    </Card>
  );
}
