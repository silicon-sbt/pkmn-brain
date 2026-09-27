// 自检：画皮 / 结冻头 —— 【从真日志里】把「已经破了」解出来。
//
//   node _verify-disguise.mjs
//
// 为什么单独一个文件：原来 verify_firsthit.mjs 里那段「画皮已破就不该再挡」
// 是在 state 里【手写 intact:false】—— 它只证明了「harness 收到 false 会怎么做」，
// 证明不了「log2state 有没有把 false 解出来」。缝就在这里漏了一个真 bug：
//   |-activate|p2a: Mimikyu|ability: Disguise 被解析成 'abilitydisguise' ≠ 'disguise'，
//   于是画皮破了之后整局都还当它没破（实测 battle-20260927-123200 第 347 行）。
//   所以这一段必须【自己跑引擎、拿引擎发出来的原话】。
import { Battle, Teams } from '@pkmn/sim';
import { stateFromLog } from './log2state.mjs';
import { buildQuestion } from './harness.mjs';
import { loadTeamOr } from './_sample-teams.mjs';

let bad = 0;
const check = (n, ok, extra) => { if (!ok) bad++; console.log((ok ? '  OK   ' : '  FAIL ') + n + (extra ? '   ' + extra : '')); };

const F = [
  ['Corviknight @ Leftovers','Ability: Pressure','Level: 100','- Brave Bird','- Body Press','- Roost','- Iron Defense'],
  ['Great Tusk @ Leftovers','Ability: Protosynthesis','Level: 100','- Headlong Rush','- Close Combat','- Rapid Spin','- Knock Off'],
  ['Clodsire @ Leftovers','Ability: Unaware','Level: 100','- Earthquake','- Recover','- Toxic','- Stealth Rock'],
  ['Dondozo @ Leftovers','Ability: Unaware','Level: 100','- Wave Crash','- Rest','- Sleep Talk','- Curse'],
  ['Skarmory @ Rocky Helmet','Ability: Sturdy','Level: 100','- Body Press','- Roost','- Spikes','- Whirlwind'],
].map(l => l.join('\n'));
const t6 = (h) => [h].concat(F).join('\n\n');
const MK = ['Mimikyu @ Life Orb','Ability: Disguise','Level: 100','- Play Rough','- Shadow Claw','- Shadow Sneak','- Swords Dance'].join('\n');
const GG = ['Gholdengo @ Leftovers','Ability: Good as Gold','Level: 100','- Make It Rain','- Shadow Ball','- Recover','- Nasty Plot'].join('\n');

const b = new Battle({ formatid: 'gen9ou', seed: [1, 2, 3, 4] });
b.setPlayer('p1', { team: Teams.pack(Teams.import(t6(GG))) });
b.setPlayer('p2', { team: Teams.pack(Teams.import(t6(MK))) });
b.makeChoices('team 123456', 'team 123456');

const META = { Mimikyu: { ability: 'Disguise', item: 'Life Orb', nature: 'Jolly', evs: { atk: 252, spe: 252 }, moves: ['Play Rough'] } };
// ⚠️ 我方队伍必须【真的包含场上的那一只】：不然 findMine 失配 → set 变成 {} →
//    所有伤害算不出来（这正是本项目最经典的静默失败形状）。
const MY = [{ species: 'Gholdengo', item: 'Leftovers', ability: 'Good as Gold', nature: 'Timid',
  evs: { hp: 0, atk: 0, def: 0, spa: 252, spd: 4, spe: 252 },
  moves: ['Make It Rain', 'Shadow Ball', 'Recover', 'Nasty Plot'] }];
const snap = () => stateFromLog(b.log.filter(l => typeof l === 'string'), 'p1', MY, META);

console.log('① 打之前：画皮完好');
const before = snap();
check('intact 是 undefined（= 没破）', before.opp.sets.Mimikyu.intact === undefined, String(before.opp.sets.Mimikyu.intact));
const a0 = buildQuestion(before).actions.find(x => x.id === 'move:makeitrain');
check('面板说「被画皮挡下」', /画皮/.test(String(a0.blockedBy || '') + a0.verdict), String(a0.verdict).slice(0, 50));

console.log('');
console.log('② 打上去 —— 引擎会发 |-activate|p2a: Mimikyu|ability: Disguise');
b.makeChoices('move 1', 'move 1');
const lines = b.log.filter(l => typeof l === 'string');
const act = lines.filter(l => l.startsWith('|-activate|') && /disguise/i.test(l));
const dt = lines.filter(l => l.startsWith('|detailschange|'));
console.log('   引擎原话：' + act.join(' ⏐ ') + (dt.length ? ' ⏐ ' + dt.join(' ⏐ ') : ''));
check('引擎确实发了带前缀的那一行（这就是当初解析错的地方）',
  act.some(l => /ability:\s*Disguise/i.test(l)) || dt.length > 0, act.join(' / '));

console.log('');
console.log('③ 打之后：log2state 必须解出「已经破了」');
const after = snap();
check('intact === false', after.opp.sets.Mimikyu.intact === false, String(after.opp.sets.Mimikyu.intact));
const a1 = buildQuestion(after).actions.find(x => x.id === 'move:makeitrain');
console.log('   面板原文：' + String(a1.verdict).slice(0, 80));
check('面板不再说「被画皮挡下」', !/画皮/.test(String(a1.blockedBy || '') + a1.verdict), String(a1.verdict).slice(0, 60));
check('而且开始报真实伤害（不再是 0）', (a1.pctHi || 0) > 0, String(a1.pctLo) + '-' + String(a1.pctHi));

console.log('');
console.log(bad ? bad + ' 项失败' : '全部通过');
process.exit(bad ? 1 : 0);
