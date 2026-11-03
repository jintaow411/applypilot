import * as React from 'react';
import { ChevronDown } from 'lucide-react';

import { cn } from './utils';

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

const selectField =
  'h-8 w-full appearance-none rounded-md border border-input-border bg-input pl-2 pr-7 text-ui-base text-foreground outline-none transition-colors ' +
  'hover:border-input-border-hover focus:border-input-border-hover focus:bg-surface-hover ' +
  'disabled:cursor-not-allowed disabled:opacity-60 ' +
  '[&>option]:bg-menu [&>option]:text-foreground';

/** 原生 select + 自定义箭头，外观与 Input 对齐；选项文本透传给浏览器。 */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, ...props }, ref) => (
    <div className="relative">
      <select ref={ref} data-slot="select" className={cn(selectField, className)} {...props}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-foreground-subtle" />
    </div>
  )
);
Select.displayName = 'Select';

/* 轻量组合式下拉（无 radix 时的 div 实现，API 与文档对齐）。 */

export function SelectGroup({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="select-group" className={cn(className)} {...props} />;
}

export function SelectValue({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span data-slot="select-value" className={cn('truncate', className)} {...props} />;
}

export function SelectTrigger({ className, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      data-slot="select-trigger"
      className={cn(
        'flex h-8 w-full items-center justify-between gap-1 rounded-md border border-input-border bg-input px-2 text-ui-base text-foreground outline-none transition-colors',
        'hover:border-input-border-hover focus:border-input-border-hover focus:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60',
        '[&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-foreground-subtle',
        className
      )}
      {...props}
    >
      {children}
      <ChevronDown className="pointer-events-none" />
    </button>
  );
}

export function SelectContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="select-content" className={cn('rounded-lg border border-popover-border bg-menu p-1 text-ui-base text-foreground shadow-md', className)} {...props} />;
}

export function SelectLabel({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="select-label" className={cn('px-2 py-1 text-ui-xs text-foreground-subtle', className)} {...props} />;
}

export function SelectItem({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div role="option" data-slot="select-item" className={cn('flex min-h-7 cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-ui-base outline-none hover:bg-menu-hover', className)} {...props} />;
}

export function SelectSeparator({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="select-separator" className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
}

export function SelectScrollUpButton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="select-scroll-up" className={cn('flex items-center justify-center py-1', className)} {...props} />;
}

export function SelectScrollDownButton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="select-scroll-down" className={cn('flex items-center justify-center py-1', className)} {...props} />;
}
