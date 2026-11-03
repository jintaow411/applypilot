#!/usr/bin/env node
/**
 * 主题对比度自检：解析 styles/tokens.css 的两套主题块，
 * 校验 WCAG 对比度（正文 7 / 次级 6 / 三级 4.5 / 品牌 4.5）。
 *
 * 用法：node scripts/check-theme-contrast.mjs
 * 不达标时打印明细并以 exit 1 结束。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tokensPath = resolve(here, "../styles/tokens.css");

const THEMES = [
  { selector: ":root", label: ":root（亮色）" },
  { selector: ".dark", label: ".dark（暗色）" },
];

const PAIRS = [
  { fg: "foreground", bg: "background", min: 7, desc: "正文" },
  { fg: "foreground-subtle", bg: "panel", min: 6, desc: "次级文本" },
  { fg: "foreground-subtlest", bg: "card", min: 4.5, desc: "三级文本" },
  { fg: "brand", bg: "background", min: 4.5, desc: "品牌色" },
];

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function extractBlock(css, selector) {
  const escaped = selector.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
  const re = new RegExp("(?:^|[\\s;])" + escaped + "\\s*\\{", "m");
  const match = re.exec(css);
  if (!match) return null;
  const open = css.indexOf("{", match.index + match[0].length - 1);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return null;
}

function parseDeclarations(block) {
  const map = new Map();
  for (const part of block.split(";")) {
    const decl = part.match(/^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/s);
    if (decl) map.set(decl[1], decl[2]);
  }
  return map;
}

function parseHex(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  const six = raw.match(/^#([0-9a-fA-F]{6})$/);
  if (six) return six[1];
  const three = raw.match(/^#([0-9a-fA-F]{3})$/);
  if (three) return three[1].split("").map((c) => c + c).join("");
  return null;
}

function channelToLinear(channel) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex) {
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return (
    0.2126 * channelToLinear(r) +
    0.7152 * channelToLinear(g) +
    0.0722 * channelToLinear(b)
  );
}

function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const light = Math.max(la, lb);
  const dark = Math.min(la, lb);
  return (light + 0.05) / (dark + 0.05);
}

const css = stripComments(readFileSync(tokensPath, "utf8"));
let failed = false;
const summary = [];

for (const theme of THEMES) {
  const block = extractBlock(css, theme.selector);
  if (!block) {
    console.error(`✗ 找不到主题块 ${theme.selector}`);
    failed = true;
    continue;
  }
  const tokens = parseDeclarations(block);
  console.log(`\n[${theme.label}]`);
  for (const pair of PAIRS) {
    const fgValue = tokens.get(`--color-${pair.fg}`);
    const bgValue = tokens.get(`--color-${pair.bg}`);
    if (!fgValue || !bgValue) {
      console.error(`  ✗ ${pair.desc}: 缺少 --color-${pair.fg} 或 --color-${pair.bg}`);
      failed = true;
      continue;
    }
    const fg = parseHex(fgValue);
    const bg = parseHex(bgValue);
    if (!fg || !bg) {
      console.error(
        `  ✗ ${pair.desc}: --color-${pair.fg} / --color-${pair.bg} 必须是不透明 6 位 hex（当前 ${fgValue} / ${bgValue}）`,
      );
      failed = true;
      continue;
    }
    const ratio = contrastRatio(fg, bg);
    const pass = ratio >= pair.min;
    summary.push({ theme: theme.label, pair: pair.desc, ratio, min: pair.min, pass });
    const line = `  ${pass ? "✓" : "✗"} ${pair.desc} ${pair.fg} ${fg} → ${pair.bg} ${bg}: ${ratio.toFixed(2)}:1（要求 ≥ ${pair.min}:1）`;
    if (pass) console.log(line);
    else {
      console.error(line);
      failed = true;
    }
  }
}

const passCount = summary.filter((row) => row.pass).length;
console.log(`\n合计 ${passCount}/${summary.length} 项达标。`);
if (failed) {
  console.error("主题对比度自检未通过。");
  process.exit(1);
}
console.log("主题对比度自检全部通过。");
