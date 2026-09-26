// 绕过本机 DNS 污染。
//
// 背景（实测）：本机把 api.cloudflare.com 解析到 28.0.0.220（美国国防部地址段），
// 连接必然被重置。而权威解析（Google/Cloudflare DoH 一致）是 104.19.192.x。
// 实测直连真 IP + 正确 SNI/Host 完全正常 —— 即【只有 DNS 被污染，链路是通的】。
//
// 做法：先用 DoH 查真实 IP，再用 https 直连该 IP（SNI 与 Host 仍用真域名）。
import https from 'node:https';

const DOH = [
  'https://dns.google/resolve?name=%H&type=A',
  'https://cloudflare-dns.com/dns-query?name=%H&type=A',
];
// 查不到时的兜底（实测可用）
const FALLBACK = {
  'api.cloudflare.com': ['104.19.192.174', '104.19.192.177', '104.19.193.29'],
  // 实测：本机把 api.typesafe.ai 解析到 28.0.1.5（同一个污染段），直连必被重置。
  // 权威 DoH 结果是下面两个（AWS），直连 + 正确 SNI 实测可通。
  // 只在 DoH 也查不到时才用 —— IP 会变，不要把它当成主路径。
  'api.typesafe.ai': ['44.227.31.201', '100.20.85.248'],
};

const cache = new Map();
export async function resolveReal(host) {
  if (cache.has(host)) return cache.get(host);
  for (const tpl of DOH) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 10000);
    try {
      const r = await fetch(tpl.replace('%H', host), { headers: { 'Accept': 'application/dns-json' }, signal: ac.signal });
      const j = await r.json();
      const ips = (j.Answer || []).filter(x => x.type === 1).map(x => x.data);
      if (ips.length) { cache.set(host, ips); return ips; }
    } catch (e) { /* 换下一个 DoH */ }
    finally { clearTimeout(t); }
  }
  const fb = FALLBACK[host] || [];
  cache.set(host, fb);
  return fb;
}

// 发一个 JSON 请求到指定 URL，但 DNS 走上面查出的真 IP。
export async function fetchJsonViaRealIp(url, { method = 'POST', headers = {}, body, timeoutMs = 30000 } = {}) {
  const u = new URL(url);
  const ips = await resolveReal(u.hostname);
  if (!ips.length) throw new Error('无法解析 ' + u.hostname + '（DoH 与兜底都失败）');
  let lastErr;
  for (const ip of ips) {
    try {
      return await new Promise((resolve, reject) => {
        const req = https.request({
          host: ip, servername: u.hostname, port: u.port || 443,
          path: u.pathname + u.search, method,
          headers: { ...headers, Host: u.hostname },
          timeout: timeoutMs,
        }, (res) => {
          let b = '';
          res.on('data', d => b += d);
          res.on('end', () => resolve({ status: res.statusCode, text: b }));
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        if (body != null) req.write(body);
        req.end();
      });
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('全部 IP 均失败');
}
