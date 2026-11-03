# 主题接线说明（给拆分 Agent）

1. 令牌文件：`styles/tokens.css`，两套主题 `:root`(亮)/`.dark`(暗），机制是 `html` 的 class。
2. 默认主题 `dark`，key 为 `autoInfo.theme`，由 `lib/use-theme.ts` 读写。
3. 在 App header 右侧找 `data-slot="theme-toggle"` 的位置渲染 `<ThemeToggle />` 即可。
4. `ThemeToggle` 无 props，内部是 `ghost` + `icon` 档 Button（h-6 w-6 = icon-sm）。
5. 图标：dark 下显示 `Sun`，light 下显示 `Moon`（lucide-react）。
6. `useTheme()` 返回 `{ theme, toggle, setTheme }`，`toggle()` 切换白天/黑夜。
7. `toggle()` 会同步 `html.classList` 的 `dark` 与 `color-scheme`，并写 localStorage。
8. 写新 UI 只用语义类（`bg-card`/`text-foreground-subtle`/`border-border`）。
9. 字号只用 `text-ui-*`：xl 18 / lg 16 / base 14 / caption 13 / sm 12 /
   xs 11 / 2xs 10（对应 `--ui-font-size` 的 +4/+2/0/-1/-2/-3/-4，xs 与 2xs 用 `max()` 保证不小于 11/10px）。
10. 圆角用 Tailwind 默认档；动效 `120/160/200ms` + `cubic-bezier(0.22,0.61,0.36,1)`。
11. 旧类名（`bg-bg`/`bg-panel`/`border-line`/`text-ink`/`text-sub`/`text-dim`/
    `text-good`/`text-warn`/`text-bad`/`text-violet` 等）是兼容别名，可继续用。
12. `--color-accent` 统一等于品牌色 `brand`，不要再当浅底色；浅底语义请用 `surface`/`selected`。
13. 新增令牌：`brand-hover`（品牌悬停）、`brand-foreground`（品牌底上的文字）、
    `primary-hover`（主按钮悬停）、`overlay`（弹窗遮罩）。它们都同时写进了
    `@theme` 与两套主题，可直接用 `bg-brand-hover`/`text-brand-foreground`/`bg-overlay`。
14. 两套主题的 `foreground`/`foreground-subtle`/`foreground-subtlest`/`brand`/
    `success`/`warning`/`destructive` 必须写不透明 6 位 hex；边框/输入框可用 rgba。
15. `ring` 取该主题的可访问焦点色；`muted` 同 `surface`，`muted-foreground` 同次级文本。
16. 不要改 `entrypoints/sidepanel/**`、`components/ui/**`，不要新增依赖。
17. 主题相关逻辑只收敛在 `styles/` + `lib/use-theme.ts` + `components/theme/` 内。
18. 调字号只改 `--ui-font-size`（默认 14px，范围 12–20），不动 `html` 字号。
19. `TooltipProvider` 如需改延迟，用 `delayDuration={200}`（见 ui-contracts §2）。
20. 两段主题每段 <150 行；再加主题先拆 `tokens-dark.css`，别堆单文件。
21. 自检：
    - `node scripts/check-theme-contrast.mjs`（正文 ≥7、次级 ≥6、三级/品牌 ≥4.5，不达标 exit 1）
    - 构建后 `grep -c '.bg-panel' .output/chrome-mv3/assets/*.css` ≥1
    - `tsc --noEmit` 通过 + `text-ui-` 计数 + `ls styles components/theme` 对得上
