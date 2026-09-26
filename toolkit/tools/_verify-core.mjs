// 核心库自检：@smogon/calc 的两个高频坑（多段招二维数组、速度不含道具）。
//
//   node tools/_verify-core.mjs

// 这两个坑都在实际代码里踩过，而且都是【静默给错数】：
//   · 多段招：直接 Math.max 得 NaN；用 flat() 不报错但给的是【单下】区间，
//     种子机关枪被报成 56-68 而真实总伤害是 168-204（差 3 倍）。
//   · 速度：Pokemon.stats.spe 不含讲究围巾/天气特性/能力等级 ——
//     队文件里写着 @ Choice Scarf 也会被无视，报出反的先后手。
// 这个自检不联网、不调任何模型，纯本地对拍。
import { Generations, Pokemon, Move, calculate } from '@smogon/calc';
import { damageRolls, finalSpeed } from './lib.mjs';

const g = Generations.get(9);
let bad = 0;
const check = (n, ok, extra) => { if (!ok) bad++; console.log((ok ? '  OK   ' : '  FAIL ') + n + (extra ? '   ' + extra : '')); };

const bre = new Pokemon(g, 'Breloom', { level: 100, nature: 'Adamant', evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 } });
const gar = new Pokemon(g, 'Garganacl', { level: 100, nature: 'Careful', evs: { hp: 252, atk: 0, def: 4, spa: 0, spd: 252, spe: 0 } });

console.log('① 多段招：总伤害必须对得上 desc，且不能是 NaN');
for (const mv of ['Bullet Seed', 'Triple Axel', 'Population Bomb', 'Ice Beam', 'Earthquake']) {
  const res = calculate(g, bre, gar, new Move(g, mv));
  const d = damageRolls(res);
  const m = /^(?:.*: )?(\d+)-(\d+) \(/.exec(res.desc());
  const descLo = m ? Number(m[1]) : null, descHi = m ? Number(m[2]) : null;
  const finite = Number.isFinite(d.total[0]) && Number.isFinite(d.total[1]);
  check(mv + ' 不是 NaN', finite, JSON.stringify(d.total));
  if (descLo != null) check(mv + ' total 与 desc 一致（' + descLo + '-' + descHi + '）', d.total[0] === descLo && d.total[1] === descHi);
  if (d.multiHit) check(mv + ' 标出了多段 + 合计大于单下', d.hits > 1 && d.total[1] > d.perHit[1], 'hits=' + d.hits + ' 单下 ' + d.perHit.join('-') + ' 合计 ' + d.total.join('-'));
  else check(mv + ' 单段时 total === perHit', d.total[0] === d.perHit[0] && d.total[1] === d.perHit[1]);
}

console.log('\n② 速度：配置里本来就有的道具/特性必须自己算');
const scarfLando = new Pokemon(g, 'Landorus-Therian', { level: 100, nature: 'Jolly', item: 'Choice Scarf', ability: 'Intimidate', evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 } });
const valiant = new Pokemon(g, 'Iron Valiant', { level: 100, nature: 'Jolly', evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 } });
const SL = finalSpeed(scarfLando), VI = finalSpeed(valiant);
console.log('   围巾土地云 ' + SL.effective + '（' + SL.mods.join('/') + '）  铁武者 ' + VI.effective);
check('stats.spe 确实不含围巾（先确认前提）', scarfLando.stats.spe === 309 && SL.base === 309);
check('finalSpeed 读出了配置里的围巾', SL.effective === Math.floor(309 * 1.5), String(SL.effective));
check('先后手结论因此反过来（围巾蓝本更快）', SL.effective > VI.effective);
const swift = new Pokemon(g, 'Barraskewda', { level: 100, nature: 'Jolly', ability: 'Swift Swim', evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 } });
const dry = finalSpeed(swift), wet = finalSpeed(swift, { weather: 'RainDance' });
check('雨天 + 悠游自如 ×2', wet.effective === dry.effective * 2, dry.effective + ' -> ' + wet.effective);
check('其他天气不误触发', finalSpeed(swift, { weather: 'SunnyDay' }).effective === dry.effective);
check('能力等级 +2 = ×2', finalSpeed(valiant, { boost: 2 }).effective === VI.effective * 2);
check('麻痹 ×0.5', finalSpeed(valiant, { para: true }).effective === Math.floor(VI.effective * 0.5));
check('顺风 ×2', finalSpeed(valiant, { tailwind: true }).effective === VI.effective * 2);

console.log(bad ? ('\n❌ ' + bad + ' 项失败') : '\n✅ 全部通过');
process.exit(bad ? 1 : 0);