/**
 * 白天/黑夜主题切换（契约：导出 useTheme，见 styles/README.md）。
 * - theme: 'light' | 'dark'，默认 'dark'（与现有深色观感一致）
 * - 持久化 key：'autoInfo.theme'；切换 html.classList 的 dark
 *
 * 注意：本包没有 @types/react，tsc 只覆盖 lib/**，此处用一份最小的
 * ambient 声明让 tsc 通过；打包时仍解析到真正的 react。
 */
// @ts-ignore: 本包无 @types/react（tsc 仅覆盖 lib），打包时由 vite 解析真实 react
import { useCallback, useEffect, useState } from 'react';

type SetStateAction<S> = S | ((prev: S) => S);
type StateSetter<S> = (value: SetStateAction<S>) => void;

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'autoInfo.theme';

function readStoredTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* 隐私模式等异常时回落默认 */
  }
  return 'dark';
}

function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.style.colorScheme = theme;
}

// 模块加载即应用一次，避免首屏闪白（sidepanel 常驻 document，可安全执行）
applyTheme(typeof localStorage !== 'undefined' ? readStoredTheme() : 'dark');

export function useTheme(): { theme: Theme; toggle: () => void; setTheme: (t: Theme) => void } {
  const [theme, setThemeState]: [Theme, StateSetter<Theme>] = useState<Theme>(readStoredTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* 忽略持久化失败 */
    }
  }, []);

  const toggle = useCallback(() => {
    setThemeState((prev: Theme) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* 忽略持久化失败 */
      }
      return next;
    });
  }, []);

  return { theme, toggle, setTheme };
}
