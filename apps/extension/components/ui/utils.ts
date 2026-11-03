import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      // text-ui-* 是字号（不是颜色）。必须全部登记，否则 tailwind-merge 会把它
      // 当成 text-color，和后写的 text-foreground / text-primary-foreground 互斥，
      // 导致按钮文字色丢失（保存按钮黑底黑字）。
      'font-size': [
        'text-ui-xl',
        'text-ui-lg',
        'text-ui-base',
        'text-ui-caption',
        'text-ui-sm',
        'text-ui-xs',
        'text-ui-2xs',
      ],
    },
  },
});

/**
 * 合并 Tailwind 类名：clsx 负责条件拼接，tailwind-merge 负责消解冲突（后写的赢）。
 * 所有 ui 组件都通过它透传 className，调用方可以随时覆盖默认样式。
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
