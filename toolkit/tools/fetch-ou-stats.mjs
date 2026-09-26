// 拉取 Smogon gen9ou 真实使用率统计（含详细配置分布）
// 注意：chaos 数据是 .json.gz（gzip 压缩），请求不带 .gz 的路径会挂死。
// 所有网络请求必须带 AbortController 超时，否则挂起会拖死调用方。
import { writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const MONTH = process.argv[2] || '2026-08';
const BASE = 'https://www.smogon.com/stats/' + MONTH + '/';

async function get(url, ms = 60000, binary = false) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return binary ? Buffer.from(await r.arrayBuffer()) : await r.text();
  } finally { clearTimeout(t); }
}

mkdirSync('data', { recursive: true });

// 1) 使用率排名
const usage = await get(BASE + 'gen9ou-0.txt');
writeFileSync('data/ou-usage.txt', usage, 'utf8');

// 2) 详细配置（chaos，gzip）
const gz = await get(BASE + 'chaos/gen9ou-0.json.gz', 120000, true);
const json = gunzipSync(gz).toString('utf8');
writeFileSync('data/ou-chaos.json', json, 'utf8');
const chaos = JSON.parse(json);

const report = [];
report.push('# gen9ou 真实环境数据 (' + MONTH + ')');
report.push('');
report.push('总对局数: ' + (chaos.info && chaos.info['number of battles']));
report.push('样本宝可梦数: ' + Object.keys(chaos.data).length);
report.push('');
// 使用率 Top 30
report.push('## 使用率 Top 30');
let rank = 0;
for (const l of usage.split('\n')) {
  const m = l.match(/^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([\d.]+)%/);
  if (m && Number(m[1]) <= 30) { report.push(m[1].padStart(3) + '. ' + m[2].padEnd(22) + m[3] + '%'); rank++; }
}
report.push('');
const mine = ['Great Tusk', 'Gholdengo', 'Kingambit', 'Dragapult', 'Slowking-Galar', 'Glimmora'];
report.push('## 我选的 6 只 —— 真实配置分布');
for (const n of mine) {
  const d = chaos.data[n];
  if (!d) { report.push('### ' + n + ' (无数据)'); continue; }
  const top = (o, k) => Object.entries(o || {}).sort((a, b) => b[1] - a[1]).slice(0, k).map(([x, v]) => x + ' ' + (v * 100).toFixed(0) + '%').join(' | ');
  report.push('');
  report.push('### ' + n + '  使用率 ' + (d.usage * 100).toFixed(1) + '%');
  report.push('  道具: ' + top(d.Items, 4));
  report.push('  特性: ' + top(d.Abilities, 3));
  report.push('  性格: ' + top(d.Natures, 3));
  report.push('  招式: ' + top(d.Moves, 8));
  report.push('  Tera: ' + top(d.TeraTypes, 4));
  const sp = Object.entries(d.Spreads || {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
  sp.forEach(([k, v]) => report.push('  EV: ' + k + '  ' + (v * 100).toFixed(0) + '%'));
}
writeFileSync('data/ou-report.md', report.join('\n'), 'utf8');
console.log('OK 报告已写入 data/ou-report.md');
