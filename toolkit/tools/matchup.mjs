#!/usr/bin/env node
// 对位速查表：战前一次性算好，战中直接念，不需要任何工具调用。
// 用法: node tools/matchup.mjs teams/me.txt teams/opp.txt [--format gen9ou]
import { readFileSync, writeFileSync } from 'node:fs';
import { parseImportable } from './lib.mjs';

const args = process.argv.slice(2);
const files = args.filter(a => !a.startsWith('--'));
const [myFile, oppFile] = files;
if (!myFile || !oppFile) {
  console.error('用法: node tools/matchup.mjs <我方队伍> <对方队伍>');
  process.exit(1);
}
const { calculate, Generations, Pokemon, Move, Field } = await import('@smogon/calc');
const g = Generations.get(9);

const mk = (set) => new Pokemon(g, set.species, {
  level: set.level || 100, nature: set.nature, evs: set.evs, ivs: set.ivs,
  item: set.item, ability: set.ability,
});
const toPct = (r, hp) => {
  const d = Array.isArray(r.damage) ? r.damage : [r.damage, r.damage];
  const lo = Math.min(...d), hi = Math.max(...d);
  let ko = '';
  try { ko = r.kochance().text || ''; } catch (e) { ko = lo === 0 ? '免疫' : ''; }
  return { lo, hi, loP: (lo / hp * 100), hiP: (hi / hp * 100), ko };
};
// 只保留攻击招式。注意：@smogon/calc 的 g.moves.get() 返回空对象，不可用，
// 必须用 @pkmn/dex 取招式数据。
const { Dex } = await import('@pkmn/dex');
const FIXED_DMG = ['Seismic Toss', 'Night Shade', 'Super Fang', 'Ruination'];
const atkMoves = (set) => set.moves.filter(m => {
  const mv = Dex.moves.get(m);
  if (!mv.exists) return false;
  return mv.category !== 'Status' || FIXED_DMG.includes(mv.name);
});

const my = parseImportable(readFileSync(myFile, 'utf8'));
const opp = parseImportable(readFileSync(oppFile, 'utf8'));
const lines = [];
lines.push('# 对位速查表');
lines.push('我方: ' + my.map(p => p.species).join(' / '));
lines.push('对方: ' + opp.map(p => p.species).join(' / '));
lines.push('');
lines.push('## 我打对面（每格 = 我方该用哪招 / 伤害% / 几确）');
for (const a of my) {
  const ap = mk(a);
  const row = [];
  for (const d of opp) {
    const dp = mk(d);
    let best = null;
    for (const mvName of atkMoves(a)) {
      try {
        const r = calculate(g, ap, dp, new Move(g, mvName), new Field({ gameType: 'Singles' }));
        const p = toPct(r, dp.stats.hp);
        if (!best || p.hiP > best.hiP) best = { mvName, ...p };
      } catch (e) { /* 跳过算不了的 */ }
    }
    row.push(best ? best.mvName + ' ' + best.loP.toFixed(0) + '-' + best.hiP.toFixed(0) + '% ' + best.ko : '—');
  }
  lines.push('');
  lines.push('### ' + a.species + '  (' + ap.stats.hp + 'HP)');
  opp.forEach((d, i) => lines.push('  vs ' + d.species.padEnd(16) + row[i]));
}
lines.push('');
lines.push('## 对面打我（每格 = 对方该用哪招 / 打我的伤害% ）');
lines.push('说明：这里用对方队伍文件里的真实配置算。若对方配置未知，等于最坏情况估算。');
for (const d of opp) {
  const dp = mk(d);
  const row = [];
  for (const a of my) {
    const ap = mk(a);
    let best = null;
    for (const mvName of atkMoves(d)) {
      try {
        const r = calculate(g, dp, ap, new Move(g, mvName), new Field({ gameType: 'Singles' }));
        const p = toPct(r, ap.stats.hp);
        if (!best || p.hiP > best.hiP) best = { mvName, ...p };
      } catch (e) {}
    }
    row.push(best ? best.mvName + ' ' + best.loP.toFixed(0) + '-' + best.hiP.toFixed(0) + '%' : '—');
  }
  lines.push('');
  lines.push('### ' + d.species);
  my.forEach((a, i) => lines.push('  -> ' + a.species.padEnd(16) + row[i]));
}
const text = lines.join('\n');
const outFile = 'matchup-sheet.md';
writeFileSync(outFile, text, 'utf8');
console.log(text);
console.log('\n[已写入 ' + outFile + ']');
