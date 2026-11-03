import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from './utils';

const neutral = 'border-border bg-surface text-foreground-subtle';
const accentTone = 'border-brand/25 bg-brand/10 text-brand';
const successTone = 'border-success/25 bg-success/10 text-success';
const warningTone = 'border-warning/25 bg-warning/10 text-warning';
const dangerTone = 'border-destructive/25 bg-destructive/10 text-destructive';
const violetTone = 'border-idle-task/25 bg-idle-task/10 text-idle-task';

const badgeVariants = cva(
  'inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 text-ui-xs font-medium leading-none',
  {
    variants: {
      variant: {
        default: accentTone,
        secondary: neutral,
        destructive: dangerTone,
        outline: 'border-border bg-transparent text-foreground-subtle',
        ghost: 'border-transparent text-foreground-subtle',
        link: 'border-transparent text-brand underline-offset-4 hover:underline',
        /* tone 同名 variant：语义色直接对应 */
        neutral,
        accent: accentTone,
        success: successTone,
        warning: warningTone,
        danger: dangerTone,
        violet: violetTone,
      },
    },
    defaultVariants: { variant: 'secondary' },
  }
);

type BadgeTone = 'neutral' | 'outline' | 'accent' | 'success' | 'warning' | 'danger' | 'violet';

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  /** @deprecated 用 variant 代替；保留以兼容旧调用方 */
  tone?: BadgeTone;
}

export function Badge({ className, variant, tone, ...props }: BadgeProps) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant: variant ?? tone }), className)}
      {...props}
    />
  );
}

export { badgeVariants };
