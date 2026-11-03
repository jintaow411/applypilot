import * as React from 'react';
import { Moon, Sun } from 'lucide-react';

import { Button } from '../ui/button';
import { useTheme } from '../../lib/use-theme';

/** 白天/黑夜切换按钮，无 props。接线见 styles/README.md。 */
export function ThemeToggle(): React.JSX.Element {
  const { theme, toggle } = useTheme();
  const isDark = theme === 'dark';

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      title="切换白天/黑夜"
      aria-label="切换白天/黑夜"
      aria-pressed={isDark}
      onClick={toggle}
    >
      {isDark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
    </Button>
  );
}
