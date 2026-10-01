// 抓 Pokemon Showdown 的公开对战记录（replay），当训练/评测样本用。
//
//   node toolkit/tools/fetch-replays.mjs [--format gen9ou] [--players 50] [--min-rating 1600]
//
// ⚠️ 联网、一次性、在【仓库根】运行。产物 data/replays/<format>.jsonl 已 gitignore（可随时重抓）。
//
// 为什么走「排行榜 → 按玩家」而不是「按格式翻页搜」——实测过两条路：
//   · 按格式翻页：翻 8 页 408 条，>= 1600 只有 1 条；rating= / minrating= 参数被服务端【忽略】。
//   · 排行榜再按玩家：top 25 玩家就给出 534 条 replay，其中 OU 409 条、>= 1600 有 340 条。
//   高分段的人不出现在公共列表里，必须定点抓。
//
// ⚠️ 抓下来的 log 里【没有 |request|】，血量也是百分比（100/100）不是真实数值 ——
//   所以它更适合当【评测集】而不是【训练集】——
//   评测用量：rating 中位 1749、>=1600 的有 340 条（top 25 玩家），够做行为克隆的目标。
//
// 两个接口的坑（都实测踩过）：
//   · 排行榜 toplist **不是按 elo 排序的**，必须自己排。
//   · search.json?user= 返回的 formatid 是【空字符串】，要拿 format（"[Gen 9] OU"）来比。

import { mkdirSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tpath } from './lib.mjs';

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : dflt; };

const FORMAT = opt('format', 'gen9ou');
const PLAYERS = Number(opt('players', 50));
const MIN_RATING = Number(opt('min-rating', 1600));
const DELAY = Number(opt('delay', 350));            // 对社区服务器客气一点，别打满
const OUT = opt('out', tpath('data', 'replays', FORMAT + '.jsonl'));
const UA = 'pkmn-toolkit fetch-replays (https://github.com/silicon-sbt/pkmn-toolkit)';

// 格式 id -> 回放里显示的格式名（拿它来筛）
const m = /^gen(\d)([a-z0-9]+)$/.exec(FORMAT);
const TIER = { ou: 'OU', uu: 'UU', ru: 'RU', nu: 'NU', pu: 'PU', zu: 'ZU', lc: 'LC',
  ubers: 'Ubers', anythinggoes: 'Anything Goes', monotype: 'Monotype', randombattle: 'Random Battle' };
const WANT = m ? '[' + 'Gen ' + m[1] + '] ' + (TIER[m[2]] || m[2].toUpperCase()) : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url) {
  const ac = new AbortController();                   // 项目约定：所有 fetch 必须带超时
  const t = setTimeout(() => ac.abort(), 30000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ac.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}

// 断点续抓：已经抓过的 id 跳过
const seen = new Set();
if (existsSync(OUT)) {
  for (const line of readFileSync(OUT, 'utf8').trim().split('\n')) {
    try { const j = JSON.parse(line); if (j.id) seen.add(j.id); } catch { /* 半行忽略 */ }
  }
}
mkdirSync(dirname(OUT), { recursive: true });

const lb = await getJson('https://pokemonshowdown.com/ladder/' + FORMAT + '.json');
const all = lb.toplist || [];
if (!all.length) { console.error('[错误] 排行榜是空的，format 对不对？'); process.exit(1); }
const top = all.slice().sort((a, b) => b.r - a.r).slice(0, PLAYERS);   // 它自己没排序
console.log('[排行榜] ' + FORMAT + ' 共 ' + all.length + ' 条；取前 ' + top.length +
  '（elo ' + Math.round(top[top.length - 1].r) + ' ~ ' + Math.round(top[0].r) + '）');
console.log('[输出] ' + OUT + (seen.size ? '（已有 ' + seen.size + ' 条，续抓）' : ''));

let added = 0, low = 0, dup = 0, fail = 0, scanned = 0;
for (const u of top) {
  let list;
  try {
    list = await getJson('https://replay.pokemonshowdown.com/search.json?user=' + encodeURIComponent(u.userid));
  } catch (e) {
    fail++; console.log('[失败] 玩家 ' + u.userid + ' 的列表：' + e.message); await sleep(DELAY); continue;
  }
  await sleep(DELAY);
  const mine = (list || []).filter((x) => (WANT ? String(x.format) === WANT : true));
  scanned += mine.length;
  for (const item of mine) {
    if ((item.rating || 0) < MIN_RATING) { low++; continue; }
    if (seen.has(item.id)) { dup++; continue; }
    try {
      const rj = await getJson('https://replay.pokemonshowdown.com/' + item.id + '.json');
      const log = rj.log || '';
      const win = (log.match(/^\|win\|(.+)$/m) || [])[1] || null;
      const players = [], ratings = [];
      for (const mm of log.matchAll(/^\|player\|(p[12])\|([^|]*)\|[^|]*\|(\d*)$/gm)) {
        players.push(mm[2]); ratings.push(Number(mm[3]) || null);
      }
      appendFileSync(OUT, JSON.stringify({
        id: rj.id, formatid: FORMAT, format: rj.format, rating: rj.rating,
        uploadtime: rj.uploadtime, winner: win, players, ratings, log,
      }) + '\n');
      seen.add(item.id); added++;
    } catch (e) {
      fail++; console.log('[失败] replay ' + item.id + '：' + e.message);
    }
    await sleep(DELAY);
  }
  console.log('  ' + u.userid + '  elo=' + Math.round(u.r) + '  OU回放=' + mine.length + '  已写入=' + added);
}
console.log('');
console.log('[完成] 新写 ' + added + ' 条；扫描 ' + scanned + ' 条；低于 ' + MIN_RATING + ' 跳过 ' + low +
  '；重复 ' + dup + '；失败 ' + fail + '；累计文件 ' + seen.size + ' 条');
if (fail) console.log('⚠️ 有 ' + fail + ' 次失败 —— 重跑一次会自动续抓（已抓的会跳过）');
