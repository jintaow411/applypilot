import type { SVGProps } from 'react';
import { cn } from '../ui/utils';

type LogoProps = SVGProps<SVGSVGElement> & {
  /** 提供 title 时作为有意义的图像暴露给读屏；默认视为装饰元素 */
  title?: string;
};

/**
 * ApplyPilot 品牌标记（单色版，跟随 currentColor）。
 * 语义：一个被自动填好的表单字段（圆角框 + 对勾）+ AI 星芒。
 * 应用图标版见 public/icon/logo.svg，两者轮廓一致。
 */
export function Logo({ className, title, ...props }: LogoProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      className={cn('block shrink-0', className)}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      {...props}
    >
      {title ? <title>{title}</title> : null}
      <rect
        x="3"
        y="8"
        width="20"
        height="20"
        rx="6.5"
        stroke="currentColor"
        strokeWidth="2.8"
      />
      <path
        d="M8.5 18 L13 22.5 L21.8 12.7"
        stroke="currentColor"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M27.5 1.2 Q28.07 4.43 31.3 5 Q28.07 5.57 27.5 8.8 Q26.93 5.57 23.7 5 Q26.93 4.43 27.5 1.2 Z"
        fill="currentColor"
      />
    </svg>
  );
}
