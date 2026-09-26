// TypeSafe Jev 客户端 —— 极薄的 HTTP 封装，不依赖官方 SDK。
// 文档: POST https://api.typesafe.ai/v1/systemone
//
// 为什么用它：Jev 是专做「快速模糊判断」的模型（单次约 269ms），
// 让代码负责算事实、Jev 负责做选择题，运行时不需要慢模型在回路上。
//
// key 从环境变量 TYPESAFE_API_KEY 读；没有 key 时可用 mock 模式验证流程。
const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
// Cloudflare Workers AI 路线（备选，要花钱）。
// 【更正】typesafe/jev 是第三方模型，不吃 10,000 Neurons/天 免费额度，必须走 AI Gateway
// 统一计费（预充余额，充值另收 5% 手续费）。实测无余额返回 HTTP 402 code 2021
// "Insufficient balance; add money to your gateway or use BYOK"。
// 需要: CF_ACCOUNT_ID + CF_API_TOKEN（从 Workers AI 面板拿）
const CF_MODEL = 'typesafe/jev';
// 本机 DNS 把 api.cloudflare.com 污染成假地址，需走 dnsfix 直连真实 IP。
import { fetchJsonViaRealIp } from './dnsfix.mjs';
const cfEndpoint = (accountId) => 'https://api.cloudflare.com/client/v4/accounts/' + accountId + '/ai/run/' + CF_MODEL;

// 凭据来源与优先级：**环境变量 → brain/config.json → brain/.env**。
//   config.json 比 .env 高：密钥搬进 config.json 之后，旧的 .env 不该再把它盖掉。
//   想临时覆盖（或在 CI 里跑）就设环境变量，它永远最大。
import { cfg } from './config.mjs';   // ★ 必须先 import，下面才能按优先级合并
import { readFileSync, existsSync } from 'node:fs';

// 先记下【真正的环境变量】—— 后面 .env 会往 process.env 里灌，届时分不清来源了。
const REAL_ENV = {
  TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
  CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID,
  CF_API_TOKEN: process.env.CF_API_TOKEN,
};
const ENV_FILE = new URL('./.env', import.meta.url);
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
// config.json 覆盖 .env（但让位给真正的环境变量）
const fromCfg = { TYPESAFE_API_KEY: cfg.jev.apiKey, CF_ACCOUNT_ID: cfg.jev.cfAccountId, CF_API_TOKEN: cfg.jev.cfApiToken };
for (const k of Object.keys(fromCfg)) {
  if (!REAL_ENV[k] && fromCfg[k]) process.env[k] = String(fromCfg[k]).trim();
}
// 密钥对不上时，第一件要确认的就是「到底用的哪一份」——所以来源要能问得出来。
export function credentialSource() {
  if (REAL_ENV.TYPESAFE_API_KEY) return '环境变量 TYPESAFE_API_KEY';
  if (cfg.jev.apiKey) return 'brain/config.json 的 jev.apiKey';
  if (process.env.TYPESAFE_API_KEY) return 'brain/.env 的 TYPESAFE_API_KEY';
  if (process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN) return 'Cloudflare 路线（CF_ACCOUNT_ID + CF_API_TOKEN）';
  return '⚠️ 一份都没有';
}
console.log('[凭据] ' + credentialSource());

export function jevRoute() {
  if (process.env.TYPESAFE_API_KEY) return 'typesafe';
  if (process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN) return 'cloudflare';
  return null;
}
export function jevAvailable() { return jevRoute() !== null; }

// questions: { name: { type:'choice'|'score'|'noul', instructions, criteria? } }
export async function askJev(state, questions, opts = {}) {
  const route = opts.route || jevRoute();
  if (!route) throw new Error('没有可用的 Jev 凭据：需 TYPESAFE_API_KEY，或 CF_ACCOUNT_ID + CF_API_TOKEN');
  const stateStr = typeof state === 'string' ? state : JSON.stringify(state);
  const payload = route === 'cloudflare'
    ? { state: stateStr, questions }                                   // Cloudflare 直接收模型输入
    : { state: stateStr, model: opts.model || cfg.jev.model || 'jev-latest', questions }; // TypeSafe 官方需要 model 字段
  const url = route === 'cloudflare'
    ? cfEndpoint(opts.accountId || process.env.CF_ACCOUNT_ID)
    : TYPESAFE_ENDPOINT;
  const key = route === 'cloudflare'
    ? (opts.apiToken || process.env.CF_API_TOKEN)
    : (opts.apiKey || process.env.TYPESAFE_API_KEY);

  const t0 = Date.now();
  // ★ 网络层重试：本机到 api.typesafe.ai 的连接【实测是间歇性 ECONNRESET 的】
  //   （DNS 污染 + 直连真 IP 也偶发失败）。对战当中一次抖动就会让那一回合没有建议，
  //   而用户没有第二次机会 —— 所以这里自动重试，网络错误重试、认证/参数错误立刻放弃。
  const attempts = Math.max(1, opts.retries == null ? (cfg.jev.retries ?? 3) : opts.retries);
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
  try {
    const hdrs = { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' };
    // Cloudflare 那条路必须绕 DNS；TypeSafe 走普通 fetch。
    const body = JSON.stringify(payload);
    const r = route === 'cloudflare'
      ? await fetchJsonViaRealIp(url, { method: 'POST', headers: hdrs, body, timeoutMs: opts.timeoutMs || 30000 })
      : await (async () => {
          // ★ 本机 DNS 会把 api.typesafe.ai 污染成 28.0.1.5（实测），连过去必然 ECONNRESET ——
          //   和 api.cloudflare.com 是同一个毛病，只是域名不同。
          //   所以：先走普通 fetch（DNS 正常时更快），网络层一失败就自动改走
          //   DoH 查真 IP + 直连（SNI 与 Host 仍用真域名）。
          //   不加这一层的话，DNS 一被污染整块面板就直接报废，而用户在对战中毫无办法。
          try {
            const ac = new AbortController();
            const t = setTimeout(() => ac.abort(), opts.timeoutMs || 30000);
            try {
              const rr = await fetch(url, { method: 'POST', headers: hdrs, body, signal: ac.signal });
              return { status: rr.status, text: await rr.text() };
            } finally { clearTimeout(t); }
          } catch (e) {
            const code = (e && e.cause && e.cause.code) || (e && e.code) || (e && e.message) || String(e);
            console.log('[jev] 直连失败（' + code + '），改走 DoH 直连真 IP');
            return await fetchJsonViaRealIp(url, { method: 'POST', headers: hdrs, body, timeoutMs: opts.timeoutMs || 30000 });
          }
        })();
    const txt = r.text;
    if (r.status < 200 || r.status >= 300) {
      // 4xx 是我们的问题（密钥/参数），重试多少次都一样 —— 直接放弃
      throw Object.assign(new Error('HTTP ' + r.status + ' ' + txt.slice(0, 300)), { noRetry: true });
    }
    let j = JSON.parse(txt);
    // Workers AI 会把结果包在 result 里
    if (j && j.success === false) throw new Error('Cloudflare 返回失败: ' + JSON.stringify(j.errors || j).slice(0, 300));
    if (j && j.result) j = typeof j.result === 'string' ? JSON.parse(j.result) : j.result;
    return { ...j, route, elapsedMs: Date.now() - t0 };
  } catch (e) {
    lastErr = e;
    const code = (e && e.cause && e.cause.code) || e.code || e.message || String(e);
    if (e && e.noRetry) break;
    if (attempt < attempts) {
      console.log('[jev] 第 ' + attempt + '/' + attempts + ' 次失败（' + code + '），' + (500 * attempt) + 'ms 后重试…');
      await new Promise(s => setTimeout(s, 500 * attempt));
    } else {
      console.log('[jev] ' + attempts + ' 次都失败（' + code + '）');
    }
  }
  }
  throw lastErr;
}

// mock：不联网，用确定性规则从 criteria 里挑一个，只为验证 harness 流程。
export async function askJevMock(state, questions) {
  const answers = {};
  for (const [name, q] of Object.entries(questions)) {
    const ids = q.criteria ? Object.keys(q.criteria) : [];
    const pick = ids.find(i => /^move:/.test(i)) || ids[0] || null;
    answers[name] = q.type === 'choice'
      ? { type: 'choice', choice: pick, confidence: 0.5, probabilities: Object.fromEntries(ids.map(i => [i, 1 / Math.max(1, ids.length)])) }
      : q.type === 'noul' ? { type: 'noul', noul: 0.5 }
      : { type: 'score', score: 0, confidence: 0.5 };
  }
  return { model: 'mock', answers, usage: { input_tokens: 0, output_tokens: 0 }, elapsedMs: 0 };
}
