// 自检：换人循环（来回换 = 白送对手两个回合）。
//
//   node _verify-loop.mjs
//
// 实测两次陷入循环：
//   · alomomola ↔ greattusk 一直换到 140 回合（AGENTS 里记的第一次）
//   · battle-20260927-123200：landorus ↔ irontreads 连换 4 个回合，置信 0.18/0.45/0.42/0.38
// 根因不在「代价没写」——代价写了。根因是【永远没人告诉模型"你上一手刚把它换下去"】，
// 它看到的永远是「换上这只少挨 10%」，而换人是对称的 ⇒ 两个方向轮流显得更优。
import { stateFromLog } from './log2state.mjs';
import { buildQuestion } from './harness.mjs';
import { loadTeamOr } from './_sample-teams.mjs';

let bad = 0;
const check = (n, ok, extra) => { if (!ok) bad++; console.log((ok ? '  OK   ' : '  FAIL ') + n + (extra ? '   ' + extra : '')); };
const MINE = loadTeamOr(null, 'ou-c');
const META = {
  Mimikyu: { ability: 'Disguise', item: 'Life Orb', nature: 'Jolly', evs: { atk: 252, spe: 252 }, moves: ['Play Rough'] },
};

// 手写日志：铁辙迹 → 换土地云 → 再回到铁辙迹（就是那一局的形状）
const LOG = [
  '|player|p1|Me|', '|player|p2|Them|',
  '|poke|p1|Landorus-Therian|', '|poke|p1|Iron Treads|', '|poke|p1|Ogerpon-Wellspring|',
  '|poke|p1|Zamazenta|', '|poke|p1|Kyurem|', '|poke|p1|Hatterene|',
  '|poke|p2|Mimikyu, F|',
  '|switch|p1a: Iron|Iron Treads|321/321', '|switch|p2a: Mimikyu|Mimikyu, F|100/100', '|turn|16',
  '|switch|p1a: Lando|Landorus-Therian, M|319/319',   // 第 16 回合换成土地云
  '|turn|17',
];
const st = stateFromLog(LOG, 'p1', MINE, META);
console.log('① log2state 要记下我方这个槽位的换人历史');
check('记到了上一只是 Iron Treads', (st._myHistory || [])[0] === 'Iron Treads', JSON.stringify(st._myHistory));
check('当前这只是 Landorus', st.me.active.species === 'Landorus-Therian', st.me.active.species);

console.log('');
console.log('② 往回换那一个选项必须贴警告');
const b = buildQuestion(st);
const crit = b.questions.action.criteria || {};
const back = String(crit['switch:irontreads'] || '');
const other = String(crit['switch:hatterene'] || '');
console.log('   [switch:irontreads] ' + back.replace(/；/g, ' | ').slice(0, 200));
check('换上「刚换下去的那只」会被告知', /你最近刚把它换下去过/.test(back), '');
check('并且点明「就在上一回合」', /就在上一回合/.test(back), '');
check('说明为什么亏（往回换是对称的）', /对称/.test(back) && /白送对手/.test(back), '');
check('别的换人选项【不该】被贴这个警告', other.length > 0 && !/你最近刚把它换下去过/.test(other), other.slice(0, 60));

console.log('');
console.log('③ 反向对照：没有换人历史时不该出现这句话');
{
  const st2 = stateFromLog(LOG.slice(0, 12), 'p1', MINE, META);   // 只到第一次 switch 为止
  const c2 = (buildQuestion(st2).questions.action.criteria) || {};
  const anyWarn = Object.values(c2).some(t => /你最近刚把它换下去过/.test(String(t)));
  check('第一次上场时没有任何「往回换」警告', !anyWarn);
}

console.log('');
console.log(bad ? bad + ' 项失败' : '全部通过');
process.exit(bad ? 1 : 0);
