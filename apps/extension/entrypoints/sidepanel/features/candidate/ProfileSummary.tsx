import * as React from 'react';
import { AlertCircle, Loader2, Trash2 } from 'lucide-react';
import { Button } from '../../../../components/ui/button';
import { cn } from '../../../../components/ui/utils';

export interface ProfileSummaryProps {
  /** 信息库状态 */
  state: 'loading' | 'ready' | 'empty' | 'invalid';
  /** 去空白后的字数 */
  charCount: number;
  /** 已格式化的更新时间，如 '10-22 19:03'，空则显示“未记录” */
  updatedAt: string | null;
  /** invalid 时的错误文案 */
  error?: string | null;
  /** 点击正文区（查看/编辑信息库） */
  onOpen: () => void;
  /** 点击右侧红色垃圾桶（删除信息库） */
  onDelete: () => void;
  /** 删除进行中 */
  deleting?: boolean;
}

/** 字数加千分位：1234 → 1,234 */
function formatCount(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString('en-US');
}

/**
 * 信息库摘要行：一行里放状态 / 字数 / 更新时间，右侧是删除按钮。
 * 只有 ready 时整行可点（打开编辑弹窗），loading / empty / invalid 只读；
 * 没有任何数据时不显示删除按钮，避免误删空状态。
 */
export function ProfileSummary(props: ProfileSummaryProps): React.ReactElement {
  const { state, charCount, updatedAt, error, onOpen, onDelete, deleting } = props;
  // 悬停高亮只在可打开时生效；垃圾桶是独立按钮，点击自己阻止冒泡
  const [hovered, setHovered] = React.useState(false);
  const clickable = state === 'ready';
  const canDelete = state === 'ready' || state === 'invalid';

  const rowCls = cn(
    'flex min-h-10 items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-2 transition-colors duration-150',
    clickable && !deleting && 'cursor-pointer',
    clickable && hovered && 'border-brand/60 bg-brand/5'
  );

  return (
    <div
      className={rowCls}
      // 整行（含内边距）都能点开；键盘走内部 button，垃圾桶自己阻止冒泡
      onClick={clickable && !deleting ? onOpen : undefined}
      onMouseEnter={clickable ? function () { setHovered(true); } : undefined}
      onMouseLeave={clickable ? function () { setHovered(false); } : undefined}
    >
      {state === 'ready' ? (
        <button
          type="button"
          onClick={function (event) {
            event.stopPropagation();
            onOpen();
          }}
          title="点击查看/编辑信息库内容"
          aria-label={'查看/编辑信息库（' + formatCount(charCount) + ' 字）'}
          className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <span className="max-w-full truncate text-ui-sm text-foreground">
            已有 · <span className="tabular-nums">{formatCount(charCount)}</span> 字
          </span>
          <span className="max-w-full truncate text-ui-2xs text-foreground-subtlest">
            更新于 {updatedAt || '未记录'}
          </span>
        </button>
      ) : state === 'loading' ? (
        <span className="flex min-w-0 flex-1 items-center gap-2 text-ui-sm text-foreground-subtle">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
          <span className="min-w-0 truncate">正在读取本地信息库…</span>
        </span>
      ) : state === 'invalid' ? (
        <span className="flex min-w-0 flex-1 items-start gap-2 text-ui-sm text-foreground">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden="true" />
          <span className="min-w-0 flex-1 break-words">
            已存数据不可用：{error || '格式不正确'}，可重新导入覆盖。
          </span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 text-ui-sm text-foreground-subtle">
          未上传（把个人资料拖到下方导入）
        </span>
      )}

      {canDelete ? (
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive [&_svg]:size-4"
          title="删除信息库"
          aria-label="删除信息库"
          disabled={Boolean(deleting)}
          onClick={function (event) {
            // 正文区也能点，阻止冒泡避免同时触发 onOpen
            event.stopPropagation();
            onDelete();
          }}
        >
          {deleting ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          )}
        </Button>
      ) : null}
    </div>
  );
}
