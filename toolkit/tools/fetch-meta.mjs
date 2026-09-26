// 从 Smogon 真实统计数据生成"当前 OU 环境代表性配置"队伍文件
// 数据源: /stats/<月>/gen9ou-0.txt (使用率) + /stats/<月>/moveset/gen9ou-0.txt (真实配置分布)
// 所有网络请求都带 AbortController 超时。
import { writeFileSync, mkdirSync } from 'node:fs';

const MONTH = process.argv[2] || '2026-08';
const TOPN = Number(process.argv[3] || 20);
const BASE = 'https://www.smogon.com/stats/' + MONTH + '/';

async function get(url, ms = 60000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

const usage = await get(BASE + 'gen9ou-0.txt');
const moveset = await get(BASE + 'moveset/gen9ou-0.txt', 90000);

// 1) 使用率 Top N
const top = [];
for (const l of usage.split('\n')) {
  const m = l.match(/^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([\d.]+)%/);
  if (m && Number(m[1]) <= TOPN) top.push({ rank: Number(m[1]), name: m[2].trim(), usage: Number(m[3]) });
}

// 2) 解析 moveset 文本：按 | 名称 | 分块，取各分类最高项
// 解析 moveset 文本。
// 关键坑：分区标题（"| Abilities  |"）和宝可梦名（"| Great Tusk |"）格式一模一样，
// 只能靠"分隔线 +---+ 之后的第一个 |...| 是标题"来判断，并比对已知分区名。
const SECTIONS = new Set(['Abilities', 'Items', 'Spreads', 'Moves', 'Natures', 'Tera Types', 'Teammates', 'Checks and Counters']);
function parseBlocks(text) {
  const blocks = {};
  const lines = text.split('\n');
  let cur = null, section = null, afterSep = false;
  const blank = () => ({ Abilities: [], Items: [], Spreads: [], Moves: [], Natures: [], 'Tera Types': [] });
  for (const raw of lines) {
    const line = raw.trim();
    if (/^\+[-+]*\+$/.test(line)) { afterSep = true; continue; }
    const m = line.match(/^\|\s*(.*?)\s*\|$/);
    if (!m) continue;
    const content = m[1].trim();
    if (afterSep) {
      afterSep = false;
      if (SECTIONS.has(content)) { section = content; }
      else if (content.includes(':')) { /* Raw count / Avg. weight / Viability Ceiling 等元数据，忽略 */ }
      else { cur = content; blocks[cur] = blank(); section = null; }
      continue;
    }
    if (SECTIONS.has(content)) { section = content; continue; }
    if (!cur || !section || !blocks[cur][section]) continue;
    const v = content.match(/^(.+?)\s+([\d.]+)%$/);
    if (!v) continue;
    const name = v[1].trim();
    if (name === 'Other') continue;          // "Other" 是聚合项，不是真实配置
    blocks[cur][section].push({ v: name, pct: Number(v[2]) });
  }
  return blocks;
}
const blocks = parseBlocks(moveset);
const missing = [];
const sets = [];
for (const t of top) {
  const b = blocks[t.name];
  if (!b) { missing.push(t.name); continue; }
  const best = (arr) => arr.slice().sort((x, y) => y.pct - x.pct)[0];
  const ability = best(b.Abilities);
  const item = best(b.Items);
  const spread = best(b.Spreads);
  const moves = b.Moves.slice().sort((x, y) => y.pct - x.pct).slice(0, 4).map(m => m.v);
  // spread 形如 "Jolly:252/252/0/0/0/4"
  let nature = 'Serious', evs = {};
  if (spread) {
    const [nat, nums] = spread.v.split(':');
    nature = nat;
    const [hp, atk, def, spa, spd, spe] = nums.split('/').map(Number);
    evs = { hp, atk, def, spa, spd, spe };
  }
  sets.push({ ...t, ability: ability && ability.v, item: item && item.v, nature, evs, moves,
    itemPct: item && item.pct, abilityPct: ability && ability.pct, spreadPct: spread && spread.pct });
}

mkdirSync('data', { recursive: true });
// 保存【全部】宝可梦的真实配置 -> 供 battlecard 按名查询。
// 这样天梯上对面出什么冷门怪都能查到真实数据，不必再靠猜。
const allSets = {};
for (const [name, b] of Object.entries(blocks)) {
  const best = (arr) => (arr || []).slice().sort((x, y) => y.pct - x.pct)[0];
  const ability = best(b.Abilities), item = best(b.Items), spread = best(b.Spreads);
  const allMoves = (b.Moves || []).slice().sort((x, y) => y.pct - x.pct).map(m => ({ n: m.v, p: Math.round(m.pct) }));
  let nature = 'Serious', evs = {};
  if (spread) {
    const [nat, nums] = spread.v.split(':');
    nature = nat;
    const [hp, atk, def, spa, spd, spe] = nums.split('/').map(Number);
    evs = { hp, atk, def, spa, spd, spe };
  }
  allSets[name] = {
    ability: ability && ability.v, item: item && item.v, nature, evs,
    moves: allMoves.slice(0, 4).map(m => m.n), allMoves,
    itemPct: item && Math.round(item.pct), abilityPct: ability && Math.round(ability.pct),
    spreadPct: spread && Math.round(spread.pct),
  };
}
writeFileSync('data/meta-sets.json', JSON.stringify(allSets), 'utf8');
console.log('全部真实配置 -> data/meta-sets.json (' + Object.keys(allSets).length + ' 只)');

// 输出队伍文件（importable）
const teamTxt = sets.map(s =>
  s.name + (s.item ? ' @ ' + s.item : '') + '\n' +
  'Ability: ' + s.ability + '\n' +
  'Level: 100\n' +
  'EVs: ' + ['hp','atk','def','spa','spd','spe'].map(k => (s.evs[k] || 0) + ' ' + k.toUpperCase()).join(' / ') + '\n' +
  s.nature + ' Nature\n' +
  s.moves.map(m => '- ' + m).join('\n')
).join('\n\n') + '\n';
writeFileSync('teams/meta-top' + TOPN + '.txt', teamTxt, 'utf8');

// 输出可读报告
const rep = [];
rep.push('# OU 环境代表性配置 (Top ' + TOPN + ', ' + MONTH + ')');
rep.push('**每只是按使用率最高的道具/特性/性格/EV/招式组合拼的，不是某个人的真实队伍，代表"最常见的打法"。**');
rep.push('');
for (const s of sets) {
  rep.push('## ' + s.rank + '. ' + s.name + '  使用率 ' + s.usage + '%');
  rep.push('  道具: ' + s.item + ' (' + (s.itemPct||0).toFixed(0) + '%)  特性: ' + s.ability + ' (' + (s.abilityPct||0).toFixed(0) + '%)');
  rep.push('  性格/EV: ' + s.nature + ' ' + ['hp','atk','def','spa','spd','spe'].map(k => (s.evs[k]||0)).join('/') + ' (' + (s.spreadPct||0).toFixed(0) + '%)');
  rep.push('  招式: ' + s.moves.join(' / '));
}
if (missing.length) rep.push('\n(无配置数据: ' + missing.join(', ') + ')');
writeFileSync('data/meta-report.md', rep.join('\n'), 'utf8');
console.log('生成 ' + sets.length + ' 只 -> teams/meta-top' + TOPN + '.txt');
console.log('报告 -> data/meta-report.md');
if (missing.length) console.log('缺失: ' + missing.join(', '));
