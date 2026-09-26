#!/usr/bin/env node
// 决策日志查看器 —— 把「面板当时说了什么」和「Showdown 实际发生了什么」并排看。
//
//   node brain/logview.mjs                 列出所有存档
//   node brain/logview.mjs <key>           看这一局（每次决策一节）
//   node brain/logview.mjs <key> --turn 7  只看第 7 回合那几节
//   node brain/logview.mjs <key> --brief   只列每次决策的结论（不出原文）
//   node brain/logview.mjs <key> --json    原始 JSONL 全部打出来
//
// 每一节的结构：局面 → Showdown 这几行（上一次决策之后发生的事）→ 面板发给 Jev 的原文
// → Jev 的回答 → 面板最终显示。要对照的就是中间那两块。
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('./logs/', import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? (args[i + 1] ?? true) : d; };
const has = (n) => args.includes(n);
const key = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--turn');

const HR = '─'.repeat(72);
const pad = (s, n) => { let w = 0; for (const ch of String(s)) w += ch.charCodeAt(0) > 0x2000 ? 2 : 1;
  return String(s) + ' '.repeat(Math.max(0, n - w)); };

if (!existsSync(DIR)) { console.log('还没有任何决策日志。跑一局对战就会有：' + DIR); process.exit(0); }

function battles() {
  return readdirSync(DIR).filter(f => f.endsWith('.jsonl')).map(f => {
    const p = DIR + f;
    const st = statSync(p);
    let lines = [];
    try { lines = readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean); } catch (e) {}
    let first = null, last = null, lastTurn = null;
    for (const l of lines) { try { const r = JSON.parse(l); if (!first) first = r.at; last = r.at; lastTurn = r.turn; } catch (e) {} }
    return { key: f.replace(/\.jsonl$/, ''), n: lines.length, first, last, lastTurn, size: st.size };
  }).sort((a, b) => String(b.last).localeCompare(String(a.last)));
}

// 记录里存的是 ISO（UTC）—— 直接打出来会比你的钟少 8 小时，看着像穿越。转成本地时间再显示。
function localTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString('sv-SE').slice(0, 19); } catch (e) { return String(iso); }
}

if (!key || has('--list')) {
  const bs = battles();
  if (!bs.length) { console.log('logs/ 里没有 .jsonl 存档。'); process.exit(0); }
  console.log('决策日志存档（' + DIR + '）\n');
  for (const b of bs) {
    console.log('  ' + pad(b.key, 42) + pad(b.n + ' 次决策', 12) +
      '最后 turn ' + pad(b.lastTurn ?? '?', 6) + localTime(b.last));
  }
  console.log('\n看某一局：node brain/logview.mjs <上面对应的 key>');
  process.exit(0);
}

const jl = DIR + key + '.jsonl';
const lg = DIR + key + '.log';
if (!existsSync(jl)) {
  console.log('找不到 ' + jl);
  const bs = battles();
  if (bs.length) console.log('现有存档：' + bs.map(b => b.key).join('、'));
  process.exit(1);
}

const recs = readFileSync(jl, 'utf8').split(/\r?\n/).filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);

if (has('--json')) { for (const r of recs) console.log(JSON.stringify(r)); process.exit(0); }

// Showdown 全文中定位每次决策之间新增的那几行（用 record 里的 logLines 偏移切）
const allLog = existsSync(lg) ? readFileSync(lg, 'utf8').split(/\r?\n/) : [];
// 这些行每局都一样、或纯噪声 —— 打出来只会把真正要对的东西淹掉
const NOISE = /^\|(t:|request|upkeep|debug|rule|clearpoke|gametype|gen|tier)\|/;

const wantTurn = flag('--turn', null);
const brief = has('--brief');
let prevLines = 0;
let shown = 0;

console.log('══ ' + key + ' ══  ' + recs.length + ' 次决策\n');

for (const r of recs) {
  const delta = allLog.slice(prevLines, r.logLines || prevLines).filter(l => l && !NOISE.test(l));
  prevLines = r.logLines || prevLines;
  if (wantTurn != null && String(r.turn) !== String(wantTurn)) continue;
  shown++;

  const head = '#' + r.seq + '  turn ' + (r.turn ?? '?') + '  [' + r.shape + ']' +
    (r.panel && r.panel.confidence != null ? '  置信 ' + r.panel.confidence : '');
  console.log(HR);
  console.log(head);
  console.log('局面：' + (r.me ? r.me.species + ' ' + r.me.hp + '%' : '?') +
    '  vs  ' + (r.opp ? r.opp.species + ' ' + r.opp.hp + '%' : '?'));

  if (delta.length) {
    console.log('\n── Showdown 实际发生（上一次决策之后）──');
    for (const l of delta) console.log('  ' + l);
  }

  if (!brief && r.criteria) {
    console.log('\n── 面板当时发给 Jev 的原文 ──');
    for (const [id, txt] of Object.entries(r.criteria)) {
      console.log('  [' + id + ']');
      console.log('   ' + String(txt).replace(/。\s*/g, '。\n   '));
    }
  }
  if (!brief && r.instructions) {
    console.log('\n  [instructions]');
    console.log('   ' + String(r.instructions).replace(/；\s*/g, '；\n   '));
  }

  const a = (r.answers && r.answers.action) || {};
  const sw = (r.answers && r.answers.opp_switch) || {};
  const te = (r.answers && r.answers.tera) || {};
  console.log('\n── Jev 的回答 ──');
  console.log('  action     = ' + (a.choice || '(无)') + (a.confidence != null ? '  置信 ' + a.confidence : ''));
  if (a.probabilities) {
    const p = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).slice(0, 5);
    console.log('  概率分布   = ' + p.map(([k, v]) => k + ' ' + v).join('  '));
  }
  console.log('  opp_switch = ' + (sw.choice || '(没问)') + (sw.confidence != null ? '  置信 ' + sw.confidence : ''));
  console.log('  tera       = ' + (te.choice || '(没问 —— 说明事实层判定这次没收益)'));
  console.log('\n── 面板最终显示 ──');
  console.log('  点：' + (r.panel.nameZh || r.panel.pick || '?') +
    (r.panel.verdict ? '   ' + r.panel.verdict : '') +
    (r.panel.useTera ? '   【太晶】' : ''));
  if (r.locked && r.locked.only) console.log('  锁招：只能点 ' + r.locked.only.join(' / '));
  if (r.switchFacts) {
    if ((r.switchFacts.stay || []).length) console.log('  支持它留场：' + r.switchFacts.stay.join('；'));
    if ((r.switchFacts.switch || []).length) console.log('  支持它换人：' + r.switchFacts.switch.join('；'));
  }
  console.log('  耗时：' + r.ms + 'ms（其中 Jev ' + r.jevMs + 'ms）');
  console.log('');
}

if (!shown) console.log('（没有匹配的决策：' + (wantTurn != null ? '--turn ' + wantTurn : '？') + '）');
