// 自检：替身（Substitute）。不联网、不调 Jev。
//
//   node _verify-sub.mjs
//
// 起因（用户实测报的）：对手天蝎王替身档在场上，面板照样写
//   「Kowtow Cleave 打掉约 72-84% 血，大概率一击必杀」—— 而那一发只打掉了替身。
//
// 引擎源码（data/moves.js:18358-18401 substitute 的 onTryPrimaryHit）：
//   · 替身血量 = Math.floor(maxhp / 4)
//   · damage > 替身剩余血量 时【截到替身剩余血量】—— 多出来的不结转到本体
//   · 不吃替身的三种情况：target === source / move.flags.bypasssub（音波招）/ move.infiltrates（穿透）
//   · 替身被打掉后，同一个多段招的后续几下才打到本体
import { stateFromLog } from './log2state.mjs';
import { buildQuestion } from './harness.mjs';

let bad = 0;
const check = (n, ok, extra) => { if (!ok) bad++; console.log((ok ? '  OK   ' : '  FAIL ') + n + (extra ? '   ' + extra : '')); };

// ── ① 日志解析：替身是 volatile，start / end / 换人 三种情况都要跟对
console.log('① log2state 要认识替身');
{
  const mk = (extra) => [
    '|player|p1|Me|', '|player|p2|Them|',
    '|poke|p1|Kingambit|', '|poke|p2|Gliscor|',
    '|switch|p1a: King|Kingambit, F|341/341',
    '|switch|p2a: Gliscor|Gliscor, M|354/354',
    '|turn|1',
  ].concat(extra);
  const MY = [{ species: 'Kingambit', item: 'Leftovers', ability: 'Supreme Overlord', nature: 'Adamant',
    evs: { hp: 252, atk: 252, def: 0, spa: 0, spd: 4, spe: 0 }, moves: ['Sucker Punch'] }];
  const META = { Gliscor: { ability: 'Poison Heal', item: 'Toxic Orb', nature: 'Impish',
    evs: { hp: 244, atk: 0, def: 252, spa: 0, spd: 12, spe: 0 }, moves: ['Earthquake'] } };

  const noSub = stateFromLog(mk([]), 'p1', MY, META);
  check('没放替身时 sub=false', noSub.opp.active.sub === false);

  const withSub = stateFromLog(mk(['|move|p2a: Gliscor|Substitute|p2a: Gliscor',
    '|-start|p2a: Gliscor|Substitute', '|-damage|p2a: Gliscor|75/100']), 'p1', MY, META);
  check('|-start|...|Substitute 之后 sub=true', withSub.opp.active.sub === true);
  check('并且进了 oppSets（harness 靠这个字段算）', withSub.opp.sets.Gliscor.sub === true);
  check('我方那侧不受影响', withSub.me.active.sub === false);

  const ended = stateFromLog(mk(['|-start|p2a: Gliscor|Substitute', '|-end|p2a: Gliscor|Substitute']), 'p1', MY, META);
  check('|-end|...|Substitute（被打掉）之后 sub=false', ended.opp.active.sub === false);

  const switched = stateFromLog(mk(['|-start|p2a: Gliscor|Substitute',
    '|switch|p2a: Corviknight|Corviknight, M|100/100']), 'p1', MY,
    Object.assign({}, META, { Corviknight: { ability: 'Pressure', item: 'Leftovers', nature: 'Impish',
      evs: { hp: 252, atk: 0, def: 252, spa: 0, spd: 4, spe: 0 }, moves: ['Brave Bird'] } }));
  check('换下场要清掉替身（volatile）', switched.opp.sets.Gliscor.sub === false);
}

// ── ② 面板：对手有替身时，我们的攻击必须改口径
console.log('');
console.log('② 对手有替身时，攻击选项不能再说「可一击必杀」');
const KING = { ability: 'Supreme Overlord', item: 'Leftovers', nature: 'Adamant',
  evs: { hp: 252, atk: 252, def: 0, spa: 0, spd: 4, spe: 0 },
  moves: ['Kowtow Cleave', 'Iron Head', 'Sucker Punch', 'Swords Dance'], boosts: {} };
const GLISCOR = { ability: 'Poison Heal', item: 'Toxic Orb', nature: 'Impish',
  evs: { hp: 244, atk: 0, def: 252, spa: 0, spd: 12, spe: 0 }, moves: ['Earthquake', 'Knock Off'] };

const stateWith = (sub, myMoves) => ({
  turn: 13,
  me: { active: { species: 'Kingambit', hpPercent: 100, sub: false, choices: null,
    set: Object.assign({}, KING, myMoves ? { moves: myMoves } : {}) }, bench: [] },
  opp: { active: { species: 'Gliscor', hpPercent: 88, sub },
    revealed: ['Gliscor'], revealedMoves: { Gliscor: ['Earthquake', 'Knock Off'] },
    sets: { Gliscor: Object.assign({}, GLISCOR, { sub }) } },
  _hazards: { mine: [], theirs: [] }, _players: {}, _warnings: [],
});
const optOf = (st, id) => (buildQuestion(st).actions.find(a => a.id === id) || null);

{
  const plain = optOf(stateWith(false), 'move:kowtowcleave');
  check('（前提）没替身时它是「大概率一击必杀」之类', /一击必杀|回合/.test(plain.verdict), plain.verdict);

  const withSub = optOf(stateWith(true), 'move:kowtowcleave');
  console.log('   有替身时的原文：' + withSub.verdict);
  check('有替身时明写【替身】', /替身/.test(withSub.verdict));
  check('不再出现「一击必杀」', !/一击必杀/.test(withSub.verdict), withSub.verdict);
  check('明说本体一点血都不掉', /本体一点血都不掉/.test(withSub.verdict));
  check('kills 被压成 false', withSub.kills === false);
  check('koChance = 0', withSub.koChance === 0);
  check('标了 subBlocked（下游能判）', withSub.subBlocked === true);
  check('几回合里【把破替身那一回合也算进去】了', withSub.turnsToKO > plain.turnsToKO,
    plain.turnsToKO + ' → ' + withSub.turnsToKO);
}

console.log('');
console.log('③ 打不破替身时要直说「连替身都打不破」');
{
  // 用一招【确实打不到 88 点】的：Kingambit 特攻低，Ember 只有 40 威力
  const weak = optOf(stateWith(true, ['Ember', 'Swords Dance', 'Kowtow Cleave', 'Sucker Punch']), 'move:ember');
  console.log('   Ember vs 替身：' + (weak && weak.verdict));
  check('弱招连替身都打不破', !!weak && /连替身都打不破/.test(weak.verdict),
    weak && (weak.sub ? '这一发 ' + weak.sub.dmg + ' 点 vs 替身 ' + weak.sub.hp + ' 点' : '无 sub 信息'));
  const strong = optOf(stateWith(true, ['Iron Head', 'Swords Dance', 'Kowtow Cleave', 'Sucker Punch']), 'move:ironhead');
  check('够打的招写成「只会把替身打掉」', !!strong && /只会把替身打掉/.test(strong.verdict),
    strong && (strong.sub ? '这一发 ' + strong.sub.dmg + ' 点 vs 替身 ' + strong.sub.hp + ' 点' : ''));
}

console.log('');
console.log('④ 穿替身的要放行：音波招式 / 穿透特性');
{
  const boom = optOf(stateWith(true, ['Boomburst', 'Kowtow Cleave', 'Iron Head', 'Sucker Punch']), 'move:boomburst');
  check('音波招式（flags.bypasssub）照常算伤害', !!boom && !boom.subBlocked && boom.sub && boom.sub.bypass === true,
    boom && boom.verdict);
  const inf = stateWith(true, ['Kowtow Cleave', 'Iron Head', 'Sucker Punch', 'Swords Dance']);
  inf.me.active.set.ability = 'Infiltrator';
  const k = optOf(inf, 'move:kowtowcleave');
  check('穿透特性也照常算伤害', !!k && !k.subBlocked, k && k.verdict);
}

console.log('');
console.log('⑤ 我方有替身时，对手打我们的数字要改成「打在替身上」');
{
  const without = buildQuestion(stateWith(false));
  const withSub = stateWith(false);
  withSub.me.active.sub = true;
  withSub.me.active.set.sub = true;      // setOf 会带上这个字段（harness 靠它算）
  const b = buildQuestion(withSub);
  const pick = (bb) => String((bb.questions.action.criteria || {})['move:kowtowcleave'] || '');
  const t0 = pick(without), t1 = pick(b);
  console.log('   没替身：' + (t0.match(/；注意本回合[^。]*。/) || ['(无代价句)'])[0].slice(0, 70));
  console.log('   有替身：' + (t1.match(/；注意本回合[^。]*。/) || ['(无代价句)'])[0].slice(0, 90));
  check('我方有替身时代价句改成「先打在替身上」', /先打在你的【替身】上/.test(t1), '');
  check('并且说明本体这一回合不掉血', /本体这一回合不掉血/.test(t1));
  check('没替身时还是老样子', /无论如何你都会吃一次攻击/.test(t0) && !/替身/.test(t0));
  // 反面对照：对手那一发如果是音波招式，我方替身挡不住 —— 不能一概而论说「有替身就不掉血」
  const boom = stateWith(false);
  boom.me.active.sub = true;
  boom.me.active.set.sub = true;
  boom.opp.revealedMoves.Gliscor = ['Boomburst'];
  const t2 = String((buildQuestion(boom).questions.action.criteria || {})['move:kowtowcleave'] || '');
  check('对手打的是音波招式时【不能】再说「先打在替身上」',
    !/先打在你的【替身】上/.test(t2), t2.slice(0, 60));
}

console.log('');
console.log('⑥ 这些事实必须【进 Jev 的 payload】，不能只在面板上好看（用户明确要求）');
{
  const crit = (st) => (buildQuestion(st).questions.action.criteria || {});
  const plain = crit(stateWith(false));
  const subbed = crit(stateWith(true));
  const k = String(subbed['move:kowtowcleave'] || '');
  check('招式选项的原文里就有替身警告（Jev 读的是这一份）', /它有【替身】/.test(k) && /只会把替身打掉/.test(k));
  check('对照：没替身那一份没有这句', !/它有【替身】/.test(String(plain['move:kowtowcleave'] || '')));

  // 强化选项：档位只能拼成短句，不能把整段 verdict 拼进去（2026-09-27 真踩过：
  // 「+30 个百分点；⚠️ 它有【替身】… → ⚠️ 它有【替身】…」—— 重复又读不通）
  const sd = String(subbed['move:swordsdance'] || '');
  const gain = /收益：[^。]*。/.exec(sd);
  console.log('   强化收益行：' + (gain ? gain[0] : '(无)'));
  check('强化选项里也说破了「有替身时强化兑现不了」',
    /有【替身】/.test(sd) && /等替身破了才开始兑现/.test(sd));
  check('收益行的档位是短句（没有把整段 verdict 拼进去）',
    !!gain && !/→[^）]*它有【替身】/.test(gain[0]), gain ? gain[0] : '');
  check('档位写成了可读的中文', !!gain && /只能打掉替身 → 只能打掉替身/.test(gain[0]));

  // opp_switch：有替身时，「你几回合就能打死它」这条支持换人的事实应当【消失或改口】
  const osPlain = JSON.stringify(buildQuestion(stateWith(false)).questions.opp_switch.criteria);
  const osSub = JSON.stringify(buildQuestion(stateWith(true)).questions.opp_switch.criteria);
  check('没替身时 opp_switch 拿「你 N 回合打死它」当支持换人的事实', /你 \d+ 回合能打死它/.test(osPlain));
  check('有替身时这条不再成立（判断依据跟着变）', !/你 \d+ 回合能打死它/.test(osSub));
  check('并且换成了「你打它很慢 + 只会打掉替身」', /你打它很慢/.test(osSub) && /只会把替身打掉/.test(osSub));
}

console.log('');
console.log(bad ? bad + ' 项失败' : '全部通过');
process.exit(bad ? 1 : 0);
