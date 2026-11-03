/**
 * 测试环境的最小 Node 内置模块声明。
 *
 * 为什么手写：本仓库刻意不装 @types/node（零新增依赖），而 lib/__tests__ 的单测
 * 只需要 node:test 与 node:assert/strict 这两处的类型面，故在这里就地声明。
 * 运行时仍由真实 Node 提供，本文件不产生任何代码。
 */

declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function test(name: string, fn: (t: TestContext) => void | Promise<void>): void;

  interface TestContext {
    diagnostic(message: string): void;
  }
}

declare module 'node:assert/strict' {
  interface AssertStrict {
    (value: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    strictEqual(actual: unknown, expected: unknown, message?: string): void;
    match(actual: string, pattern: RegExp, message?: string): void;
    /** 断言 Promise 以指定错误拒绝（缺 key / 请求失败等用例） */
    rejects(value: Promise<unknown>, error?: RegExp, message?: string): Promise<void>;
    fail(message?: string): never;
  }

  const assert: AssertStrict;
  export default assert;
}
