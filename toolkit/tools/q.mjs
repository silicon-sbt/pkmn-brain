#!/usr/bin/env node
// 战斗中即时查询 —— 不经过模型，直接出答案。
//
//   node tools/q.mjs 雄伟牙 天蝎王
//   node tools/q.mjs Great Tusk Gliscor
//   node tools/q.mjs 雄伟牙 天蝎王 --mine teams/ou-a.txt --opp teams/meta-top20.txt
//
// 配置查找顺序：指定队伍文件 -> teams/ou-a.txt(我方) -> teams/meta-top20.txt(环境) -> 裸种族值
// 中文名可直接敲。
import { readFileSync, existsSync } from 'node:fs';
import { parseImportable, zhToEn, zhInfo, tpath } from './lib.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const pos = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--mine' && argv[i - 1] !== '--opp');
const [mineArg, oppArg] = pos;

if (!mineArg || !oppArg) {
  console.log('用法: node tools/q.mjs <我方> <对方> [--mine 队伍文件] [--opp 队伍文件]');
  console.log('  例: node tools/q.mjs 雄伟牙 天蝎王');
  process.exit(0);
}

const loadSets = (file) => (file && existsSync(file)) ? parseImportable(readFileSync(file, 'utf8')) : [];
const mySets = loadSets(opt('--mine', tpath('teams', 'ou-a.txt')));
const oppSets = loadSets(opt('--opp', tpath('teams', 'meta-top40.txt')));

// 名字 -> 配置：先用中文转英文，再在队伍文件里找；找不到就退化
function resolve(input) {
  const en = zhToEn('species', input.replace(/\s+/g, ' ').trim());
  for (const list of [mySets, oppSets]) {
    const hit = list.find(s => s.species.toLowerCase() === en.toLowerCase());
    if (hit) return { ...hit, src: '队伍文件' };
  }
  return { species: en, level: 100, evs: {}, moves: [], src: '裸种族值(无配置)' };
}

const { calculate, Generations, Pokemon, Move, Field } = await import('@smogon/calc');
const { Dex } = await import('@pkmn/dex');
const g = Generations.get(9);
const mk = (s) => new Pokemon(g, s.species, { level: s.level || 100, nature: s.nature, evs: s.evs, ivs: s.ivs, item: s.item, ability: s.ability });
const FIXED = ['Seismic Toss', 'Night Shade', 'Super Fang', 'Ruination'];
const atkMoves = (s) => (s.moves || []).filter(m => { const mv = Dex.moves.get(m); return mv.exists && (mv.category !== 'Status' || FIXED.includes(mv.name)); });

function best(attacker, defender) {
  const ap = mk(attacker), dp = mk(defender);
  const rows = [];
  for (const name of atkMoves(attacker)) {
    try {
      const r = calculate(g, ap, dp, new Move(g, name), new Field({ gameType: 'Singles' }));
      const d = Array.isArray(r.damage) ? r.damage : [r.damage, r.damage];
      const lo = Math.min(...d), hi = Math.max(...d);
      let ko = ''; try { ko = r.kochance().text || ''; } catch (e) { ko = lo === 0 ? '免疫' : ''; }
      rows.push({ name, lo, hi, loP: lo / dp.stats.hp * 100, hiP: hi / dp.stats.hp * 100, ko });
    } catch (e) { /* 算不了就跳过 */ }
  }
  rows.sort((a, b) => b.hiP - a.hiP);
  return { rows, hp: dp.stats.hp, myHp: ap.stats.hp };
}

const A = resolve(mineArg), B = resolve(oppArg);
const zhA = zhInfo('species', A.species).zh, zhB = zhInfo('species', B.species).zh;
const fwd = best(A, B), back = best(B, A);

const line = (r) => '  ' + r.name.padEnd(16) + (r.lo + '-' + r.hi).padStart(10) + '  ' + (r.loP.toFixed(0) + '-' + r.hiP.toFixed(0) + '%').padStart(10) + '  ' + r.ko;
// 显示实际用的配置，保证数字可追溯（不写配置就等于没说清前提）
const cfg = (s) => {
  const ev = ['hp','atk','def','spa','spd','spe'].map(k => (s.evs && s.evs[k]) || 0).join('/');
  const parts = [];
  if (s.item) parts.push(s.item);
  if (s.ability) parts.push(s.ability);
  if (s.nature) parts.push(s.nature + ' ' + ev);
  return parts.length ? parts.join(' | ') : '(无配置，仅种族值)';
};
console.log('');
console.log(zhA + ' (' + A.species + ')  ' + fwd.myHp + 'HP');
console.log('   配置: ' + cfg(A) + '   <来源: ' + A.src + '>');
console.log('   vs');
console.log(zhB + ' (' + B.species + ')  ' + fwd.hp + 'HP');
console.log('   配置: ' + cfg(B) + '   <来源: ' + B.src + '>');
console.log('');
console.log('【你用】');
fwd.rows.slice(0, 4).forEach(r => console.log(line(r)));
if (!fwd.rows.length) console.log('  (没有可用的攻击招式数据)');
console.log('');
console.log('【对面用】');
back.rows.slice(0, 4).forEach(r => console.log(line(r)));
if (!back.rows.length) console.log('  (没有可用的攻击招式数据)');
console.log('');
if (fwd.rows[0]) console.log('>> 最佳选择: ' + fwd.rows[0].name + '  ' + fwd.rows[0].ko);
