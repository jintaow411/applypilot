/// <reference path="./node-env.d.ts" />
/**
 * match.ts 单测（node:test，零测试框架依赖）：机械执行层。
 *
 * 覆盖：
 *   1. pickOption：3-5年、30-40K 走数值区间，优先完整包住期望区间的选项
 *   2. rangeOf / renderTemplate 保持可用
 *
 * 老的分批规划引擎 planWithAI（含 JSON 版 profile）已删除，
 * 规划链路回归改走 scripts/test-ai-plan.mjs。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickOption, rangeOf, renderTemplate } from '../match.js';

test('pickOption：3-5年 走数值区间，优先完整包住期望区间的选项', () => {
  const picked = pickOption(
    [
      { text: '1-3年', value: '1' },
      { text: '3~5年', value: '3' },
      { text: '5年以上', value: '5' },
    ],
    '3-5年'
  );
  assert.ok(picked);
  assert.equal(picked.how, 'range');
  assert.equal(picked.option.text, '3~5年');
});

test('pickOption：30-40K 走数值区间，而不是按文本模糊命中', () => {
  const picked = pickOption(
    [
      { text: '20-30K', value: '20' },
      { text: '30-50K', value: '30' },
      { text: '50K以上', value: '50' },
    ],
    '30-40K'
  );
  assert.ok(picked);
  assert.equal(picked.how, 'range');
  assert.equal(picked.option.text, '30-50K');
});

test('rangeOf / renderTemplate 保持可用', () => {
  assert.deepEqual(rangeOf('3~5年'), [3, 5]);
  assert.deepEqual(rangeOf('5以上'), [5, 999]);
  assert.equal(renderTemplate('我是{{name}}，来自{{city}}', { name: '林知远' }), '我是林知远，来自{{city}}');
});
