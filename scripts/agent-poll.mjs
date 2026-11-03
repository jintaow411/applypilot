#!/usr/bin/env node
/**
 * agent 轮询脚本：拉取本地 ApplyPilot 服务端上 status=new 的上报，供 agent 认领。
 *
 * 用法: node scripts/agent-poll.mjs [--base <url>] [--token <token>] [--once]
 *
 * 零依赖，使用 Node 18+ 内置 fetch。
 */
const DEFAULT_BASE = 'http://127.0.0.1:17880';
const POLL_INTERVAL_MS = 5000;
const REQUEST_TIMEOUT_MS = 10000;

const HELP = `用法: node scripts/agent-poll.mjs [选项]

轮询本地 ApplyPilot 服务端的新报告，打印 id / domain / url / title。

选项:
  --base <url>    服务端地址（默认 ${DEFAULT_BASE}）
  --token <tok>   访问 token；GET 轮询一般可省略，写回 / 关单时需要
  --once         只轮询一次就退出（适合 cron / 一次性检查）
  -h, --help      显示本帮助并退出

环境变量:
  AUTO_INFO_BASE   同 --base（命令行优先）
  AUTO_INFO_TOKEN  同 --token（命令行优先）

示例:
  node scripts/agent-poll.mjs --help
  node scripts/agent-poll.mjs --once
  node scripts/agent-poll.mjs --base http://127.0.0.1:17880 --token <token>

退出码:
  0  正常轮询（--once 时单次查询成功）
  1  参数错误、服务端连不上、响应异常
`;

function fail(message) {
  console.error(`[错误] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    base: process.env.AUTO_INFO_BASE || DEFAULT_BASE,
    token: process.env.AUTO_INFO_TOKEN || '',
    once: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--once') {
      opts.once = true;
    } else if (arg === '--base') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) fail('--base 需要一个值，例如 --base http://127.0.0.1:17880');
      opts.base = value;
    } else if (arg.startsWith('--base=')) {
      const value = arg.slice('--base='.length);
      if (!value) fail('--base 需要一个值，例如 --base http://127.0.0.1:17880');
      opts.base = value;
    } else if (arg === '--token') {
      const value = argv[++i];
      if (!value) fail('--token 需要一个值');
      opts.token = value;
    } else if (arg.startsWith('--token=')) {
      const value = arg.slice('--token='.length);
      if (!value) fail('--token 需要一个值');
      opts.token = value;
    } else {
      fail(`未知参数：${arg}\n用 --help 查看用法`);
    }
  }

  return opts;
}

function normalizeBase(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`--base 不是合法 URL：${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail(`--base 只支持 http/https，收到：${raw}`);
  }
  return url.href.replace(/\/+$/, '');
}

async function pollOnce(base, token) {
  const endpoint = `${base}/api/reports?status=new`;
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(endpoint, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    const reason =
      err.name === 'TimeoutError' ? `请求超时（${REQUEST_TIMEOUT_MS}ms）` : err.message || String(err);
    console.error(`[错误] 无法连接服务端 ${base}：${reason}`);
    console.error('请先启动本地 server（默认 http://127.0.0.1:17880）后重试。');
    process.exit(1);
  }

  const text = await res.text();
  let data = null;
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      fail(`服务端返回的不是 JSON（HTTP ${res.status}）`);
    }
  }

  if (!res.ok) {
    const detail = data && typeof data === 'object' ? data.error || data.message || '' : '';
    fail(`GET /api/reports 返回 HTTP ${res.status}${detail ? `：${detail}` : ''}`);
  }

  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.reports)
      ? data.reports
      : Array.isArray(data?.items)
        ? data.items
        : null;

  if (!list) {
    fail('GET /api/reports 响应格式无法识别：期望数组或 { reports: [...] }');
  }

  const at = new Date().toLocaleTimeString('zh-CN', { hour12: false });

  if (!list.length) {
    console.log(`[${at}] 暂无待处理报告（status=new）`);
    return 0;
  }

  console.log(`[${at}] 发现 ${list.length} 条待处理报告：`);
  for (const report of list) {
    const id = report?.id ?? report?.reportId ?? '(无 id)';
    const domain = report?.domain ?? '(无 domain)';
    const url = report?.url ?? '(无 url)';
    const title = report?.title ?? '(无 title)';
    console.log(`- id=${id}  domain=${domain}  url=${url}  title=${title}`);
  }
  return list.length;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return;
  }

  const opts = parseArgs(argv);
  const base = normalizeBase(opts.base);

  if (opts.once) {
    await pollOnce(base, opts.token);
    return;
  }

  console.log(`开始轮询 ${base}/api/reports?status=new（每 ${POLL_INTERVAL_MS / 1000} 秒，Ctrl+C 退出）`);
  process.on('SIGINT', () => {
    console.log('\n已停止轮询');
    process.exit(0);
  });

  for (;;) {
    await pollOnce(base, opts.token);
    await sleep(POLL_INTERVAL_MS);
  }
}

await main();
