/**
 * 执行填充计划：逐字段操作真实页面（TS 版）。
 *
 * 对应关系：移植自 src/runner.mjs 的 runPlan，逐分支对齐：
 *   - select：读选项 → pickOption → 原生 setter 赋值 → 等 settle（级联下拉）
 *   - custom-select：读选项 → 点开控件 → 等 120ms → 点文本项 → 等 120ms
 *   - radio-group / checkbox-group：逐个 pickOption，按 index 优先命中 data-ai-opt
 *   - checkbox / radio：按布尔语义勾选
 *   - richtext / date / 文本类（text/email/tel/number/url/textarea）
 *   - 收尾回读核对：filled 但实际为空 → empty；容器带 invalid/bad → invalid
 *
 * 与 JS 版的差异：不再接收 playwright 的 page，改为最小接口 PageLike
 * （{ evaluate(fn,arg), clickOption?(selector) }），绝不引入 playwright 依赖；
 * 返回值仍是同一个 steps 数组（原地改状态），便于调用方直接渲染。
 */
import type { InspectResult } from './fill.js';
import type { FieldOption, PageLike, Step } from './schema.js';
import {
  pageCheck,
  pageChooseOption,
  pageClickTextOption,
  pageCountSelects,
  pageInspect,
  pageOpenCustomSelect,
  pageReadOptions,
  pageReadSelectOptions,
  pageSetRichText,
  pageSetSelectValue,
  pageSetText,
} from './fill.js';
import { pickOption } from './match.js';

/** 需要重新导出，调用方通常只 import runner */
export type { PageLike } from './schema.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 级联省市拆分：决策是数组取前两项为省/市；否则用最长省名前缀切分 wanted，余部作市。
 * 省名短称兼容（广东/广东省、广西/广西壮族自治区），市级用余部文本到时再对第二级选项匹配。
 */
function splitCascadeWanted(
  s: Step,
  provinceOptions: FieldOption[]
): { provinceValue: string; provinceText: string; cityWanted: string } | null {
  const usable = (provinceOptions || []).filter(
    (o) => !o.disabled && o.text && !/^(请选择|请先选择|加载中|--|—)/.test(o.text.trim())
  );
  if (s.list && s.list.length >= 2) {
    const prov = pickOption(usable, s.list[0]);
    if (prov) return { provinceValue: prov.option.value, provinceText: prov.option.text, cityWanted: s.list.slice(1).join('') };
  }
  const norm = (x: unknown): string => String(x ?? '').replace(/\s+/g, '');
  const strip = (t: string): string =>
    t
      .replace(/(特别行政区|自治区|自治州)$/, '')
      .replace(/(壮族|维吾尔|回族)$/, '')
      .replace(/[省市县区盟旗]$/, '');
  const w = norm(s.wanted);
  if (!w) return null;
  let best: { len: number; option: FieldOption } | null = null;
  for (const o of usable) {
    const t = norm(o.text);
    if (!t) continue;
    for (const c of [t, strip(t)]) {
      if (c && w.startsWith(c) && (!best || c.length > best.len)) best = { len: c.length, option: o };
    }
  }
  if (!best) return null;
  return { provinceValue: best.option.value, provinceText: best.option.text, cityWanted: w.slice(best.len) };
}

export async function runPlan(page: PageLike, steps: Step[], { settle = 220 }: { settle?: number } = {}): Promise<Step[]> {
  for (const s of steps) {
    if (s.status !== 'pending') continue;

    if (s.kind === 'select') {
      /* 二级联动（同 id 双 select，如籍贯省/市）：选完省→重读市→选市 */
      if ((await page.evaluate(pageCountSelects, s.fieldId)) > 1) {
        const firstOpts = await page.evaluate(pageReadSelectOptions, { id: s.fieldId, index: 0 });
        const parts = splitCascadeWanted(s, firstOpts);
        if (parts) {
          const r1 = await page.evaluate(pageSetSelectValue, { id: s.fieldId, index: 0, value: parts.provinceValue });
          if (!r1.ok) {
            s.status = 'failed';
            continue;
          }
          await sleep(Math.max(settle, 600)); // 等市级选项加载
          if (!parts.cityWanted) {
            s.value = parts.provinceText;
            s.status = 'filled';
            continue;
          }
          let secondOpts = await page.evaluate(pageReadSelectOptions, { id: s.fieldId, index: 1 });
          if (!secondOpts.filter((o) => o.text && !/^(请选择|请先选择|加载中)/.test(o.text.trim())).length) {
            await sleep(800); // 异步联动再等一拍重读
            secondOpts = await page.evaluate(pageReadSelectOptions, { id: s.fieldId, index: 1 });
          }
          const city = pickOption(secondOpts, parts.cityWanted);
          if (!city) {
            s.value = parts.provinceText;
            s.status = 'filled';
            s.note = `已选${parts.provinceText}，市级选项里没有「${parts.cityWanted}」`;
            continue;
          }
          const r2 = await page.evaluate(pageSetSelectValue, { id: s.fieldId, index: 1, value: city.option.value });
          s.value = parts.provinceText + city.option.text;
          s.status = r2.ok ? 'filled' : 'failed';
          await sleep(settle);
          continue;
        }
        /* 拆不出省市：回落普通单 select 流程（只填第一级） */
      }
      const options = await page.evaluate(pageReadOptions, s.fieldId);
      const picked = pickOption(options, s.wanted);
      if (!picked) {
        s.status = s.wanted ? 'no-option' : 'unmatched';
        s.note = options.length ? `选项里没有「${s.wanted}」` : '下拉尚未加载出选项';
        continue;
      }
      const r = await page.evaluate(pageSetText, { id: s.fieldId, value: picked.option.value });
      s.value = picked.option.text;
      s.status = r.ok ? 'filled' : 'failed';
      await sleep(settle); // 级联下拉 / 选项二次加载
      continue;
    }

    if (s.kind === 'custom-select') {
      // 得物/飞书下拉的选项是打开弹层后才挂载到 body 的 portal 中。
      // 必须先打开，再读取选项；否则性别、学历、来源等字段会被误判为无选项。
      await page.evaluate(pageOpenCustomSelect, s.fieldId);
      await sleep(180);
      let options = await page.evaluate(pageReadOptions, s.fieldId);
      if (!options.length) {
        await sleep(500);
        options = await page.evaluate(pageReadOptions, s.fieldId);
      }
      const picked = pickOption(options, s.wanted);
      if (!picked) {
        s.status = 'no-option';
        s.note = `自定义下拉里没有「${s.wanted}」`;
        continue;
      }
      const r = await page.evaluate(pageClickTextOption, { id: s.fieldId, text: picked.option.text });
      s.value = picked.option.text;
      s.status = r.ok ? 'filled' : 'failed';
      await sleep(120);
      continue;
    }

    if (s.kind === 'radio-group' || s.kind === 'checkbox-group') {
      const wanted: string[] = s.list && s.list.length ? s.list : String(s.wanted).split(/\s*[/,、]\s*/);
      const done: string[] = [];
      for (const w of wanted) {
        const picked = pickOption(s.options || [], w);
        const r = await page.evaluate(
          pageChooseOption,
          picked ? { id: s.fieldId, index: picked.option.index, text: picked.option.text } : { id: s.fieldId, text: w.trim() }
        );
        if (r.ok) done.push(w.trim());
      }
      s.value = done.join('、');
      s.status = done.length ? 'filled' : 'no-option';
      if (!done.length) s.note = `没有找到「${wanted.join('/')}」`;
      continue;
    }

    if (s.kind === 'checkbox' || s.kind === 'radio') {
      const r = await page.evaluate(pageCheck, { id: s.fieldId, wanted: s.wanted });
      s.status = r.ok ? 'filled' : 'failed';
      s.value = r.checked ? '已勾选' : '未勾选';
      continue;
    }

    if (s.kind === 'richtext') {
      const r = await page.evaluate(pageSetRichText, { id: s.fieldId, value: String(s.wanted) });
      s.status = r.ok ? 'filled' : 'failed';
      continue;
    }

    if (s.kind === 'date') {
      const r = await page.evaluate(pageSetText, { id: s.fieldId, value: String(s.wanted) });
      s.status = r.ok ? 'filled' : 'failed';
      s.value = String(s.wanted);
      continue;
    }

    // 文本类：text / email / tel / number / url / textarea
    const r = await page.evaluate(pageSetText, { id: s.fieldId, value: String(s.wanted) });
    s.status = r.ok ? 'filled' : 'failed';
    if (r.ok) s.value = r.value;
    continue;
  }

  // 回读核对
  const ids = steps.filter((s) => s.status === 'filled').map((s) => s.fieldId);
  const inspected: InspectResult[] = await page.evaluate(pageInspect, ids);
  const map = new Map<string, InspectResult>(inspected.map((i) => [i.id, i] as [string, InspectResult]));
  for (const s of steps) {
    if (s.status !== 'filled') continue;
    const got = map.get(s.fieldId);
    if (!got) continue;
    if (got.empty) s.status = 'empty';
    if (got.error) s.status = 'invalid';
  }
  return steps;
}
