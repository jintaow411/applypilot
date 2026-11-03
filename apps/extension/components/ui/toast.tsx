import * as React from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, CheckCircle2, Info, X, type LucideIcon } from 'lucide-react';

import { Button } from './button';
import { cn } from './utils';

/**
 * 全局 Toast：任何模块直接 `toast.success() / toast.error() / toast.info()`，无需层层传 notify。
 * - 成功 / 信息：默认 3.5s / 4.5s 自动消失；
 * - 错误：默认常驻；所有 tone 右侧一律带关闭按钮，避免长错误被误吞；
 * - 视觉与产品其他提示一致：大号圆角卡片 + 图标 + 14px 正文 + 阴影，右下角操作；
 * - 通过 portal 挂到 body，z-index 高于 Modal（z-50）。
 */

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: ToastTone;
  action?: ToastAction;
  /** 毫秒；0 表示不自动消失 */
  duration?: number;
}

interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
  action?: ToastAction;
  duration: number;
}

const DEFAULT_DURATION: Record<ToastTone, number> = {
  success: 3500,
  info: 4500,
  error: 0,
};

const MAX_VISIBLE = 3;

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit() {
  for (const listener of listeners) listener();
}

function dismiss(id: number) {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  const next = items.filter((item) => item.id !== id);
  if (next.length === items.length) return;
  items = next;
  emit();
}

function show(options: ToastOptions): number {
  const tone = options.tone ?? 'info';
  const duration = options.duration ?? DEFAULT_DURATION[tone];
  const item: ToastItem = {
    id: nextId++,
    tone,
    title: options.title,
    description: options.description,
    action: options.action,
    duration,
  };
  // 同文案重复触发时替换旧条，避免反复重试把提示堆满
  const duplicate = items.find((existing) => existing.title === item.title && existing.tone === item.tone);
  if (duplicate) {
    const timer = timers.get(duplicate.id);
    if (timer) {
      clearTimeout(timer);
      timers.delete(duplicate.id);
    }
    items = items.filter((existing) => existing.id !== duplicate.id);
  }
  items = [...items, item].slice(-MAX_VISIBLE);
  emit();
  if (duration > 0) {
    timers.set(item.id, setTimeout(() => dismiss(item.id), duration));
  }
  return item.id;
}

export const toast = {
  show,
  dismiss,
  success(title: string, options: Omit<ToastOptions, 'title' | 'tone'> = {}) {
    return show({ ...options, title, tone: 'success' });
  },
  error(title: string, options: Omit<ToastOptions, 'title' | 'tone'> = {}) {
    return show({ ...options, title, tone: 'error' });
  },
  info(title: string, options: Omit<ToastOptions, 'title' | 'tone'> = {}) {
    return show({ ...options, title, tone: 'info' });
  },
  clear() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    if (!items.length) return;
    items = [];
    emit();
  },
};

function useToasts(): ToastItem[] {
  const [snapshot, setSnapshot] = React.useState<ToastItem[]>(items);
  React.useEffect(() => {
    const listener = () => setSnapshot(items);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return snapshot;
}

const TONE_STYLES: Record<ToastTone, { wrap: string; icon: string; Icon: LucideIcon }> = {
  success: {
    wrap: 'border-border bg-popover',
    icon: 'text-success',
    Icon: CheckCircle2,
  },
  error: {
    wrap: 'border-destructive/35 bg-destructive/8',
    icon: 'text-destructive',
    Icon: AlertCircle,
  },
  info: {
    wrap: 'border-border bg-popover',
    icon: 'text-foreground',
    Icon: Info,
  },
};

function ToastCard({ item }: { item: ToastItem }) {
  const { wrap, icon: iconClass, Icon } = TONE_STYLES[item.tone];

  return (
    <div
      role={item.tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'pointer-events-auto flex w-full max-w-[440px] gap-2.5 rounded-2xl border px-3.5 py-3 shadow-xl backdrop-blur',
        item.description ? 'items-start' : 'items-center',
        wrap,
      )}
      style={{ animation: 'ai-toast-in 200ms var(--wf-ease)' }}
    >
      <Icon className={cn(item.description ? 'mt-0.5' : 'mt-0', 'h-[18px] w-[18px] shrink-0 self-center', iconClass)} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'whitespace-pre-wrap break-words text-ui-base font-medium leading-snug',
            item.tone === 'error' ? 'text-destructive' : 'text-foreground',
          )}
        >
          {item.title}
        </p>
        {item.description ? (
          <p className="mt-1 whitespace-pre-wrap break-words text-ui-caption leading-relaxed text-foreground-subtle">
            {item.description}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {item.action ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-ui-sm"
            onClick={() => {
              dismiss(item.id);
              item.action?.run();
            }}
          >
            {item.action.label}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          onClick={() => dismiss(item.id)}
          title="关闭提示"
          aria-label="关闭提示"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

/**
 * Toast 容器：放在 App 根部，`offset` 控制离屏幕底部的距离
 * （主界面底部有 FooterBar，传更大的值避开按钮；设置页传小值）。
 */
export function Toaster({ offset = 16 }: { offset?: number }) {
  const list = useToasts();
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className="pointer-events-none fixed inset-x-0 z-[80] flex flex-col items-center gap-2 px-3"
      style={{ bottom: `calc(${offset}px + env(safe-area-inset-bottom))` }}
      aria-live="polite"
    >
      {list.map((item) => (
        <ToastCard key={item.id} item={item} />
      ))}
    </div>,
    document.body,
  );
}
