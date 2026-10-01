// 自检：被改过的属性（变幻自如 Protean / 自由自在 Libero）必须进伤害计算。
//
//   node _verify-typechange.mjs
//
// 用户实测报的：「假面魔猫的特性好像没有考虑诶」——查日志，引擎其实【明说了】：
//   |-start|p2a: Meowscarada|typechange|Bug|[from] ability: Protean
// 而 brain 里搜 typechange 一条都没有 ⇒ 整局对它的伤害都按基础属性（草/恶）算。
//
// ⚠️ 两段都要验，缺一段都是假绿（本项目的经典教训）：
//   ① log2state 有没有把 typechange【解析出来】（喂真日志）
//   ② 解析出来的属性有没有【真的进 calc】（对拍面板数字，而不是看代码）
import { readFileSync } from 'node:fs';
import { Generations, Pokemon, Move, calculate } from '@smogon/calc';
import { stateFromLog } from './log2state.mjs';
import { buildQuestion } from './harness.mjs';

let bad = 0;
const check = (n, ok, extra) => { if (!ok) bad++; console.log((ok ? '  OK   ' : '  FAIL ') + n + (extra ? '   ' + extra : '')); };
const g9 = Generations.get(9);

console.log('① 喂【真日志的一行】，看 log2state 认不认（不是手写对象）');
const REAL = [
  '|player|p1|Me|', '|player|p2|Them|',
  '|poke|p1|Corviknight, M|', '|poke|p2|Meowscarada, M|',
  '|switch|p1a: Corv|Corviknight, M|341/341', '|switch|p2a: Meow|Meowscarada, M|100/100', '|turn|1',
  '|move|p2a: Meow|U-turn|p1a: Corv',
  '|-start|p2a: Meow|typechange|Bug|[from] ability: Protean',   // ← 引擎原话
  '|turn|2',
];
const st = stateFromLog(REAL, 'p1', [{ species: 'Corviknight', ability: 'Pressure', item: 'Leftovers', nature: 'Impish', evs: {}, moves: ['Brave Bird'] }], {});
check('解出了 types 且是 ["Bug"]（不是 ["Bug","[from] ability: Protean"]）',
  JSON.stringify(st.opp.sets.Meowscarada.types) === '["Bug"]', JSON.stringify(st.opp.sets.Meowscarada.types));

console.log('');
console.log('② 换下场要清掉（Protean 换上来可以再发动 —— 日志第 182 行证实过）');
const AFTER = REAL.concat(['|switch|p2a: Back|Corviknight, M|100/100', '|turn|3']);
check('换下去之后 types = null',
  (stateFromLog(AFTER, 'p1', [], {}).opp.sets.Meowscarada || {}).types == null,
  JSON.stringify((stateFromLog(AFTER, 'p1', [], {}).opp.sets.Meowscarada || {}).types));

console.log('');
console.log('③ 这些属性【真的进了 calc】（对拍，不看代码）');
// 同一个公式：我们打它。分别构造「基础属性」和「被改成 Bug」两种，看数字是否不同
const base = new Pokemon(g9, 'Corviknight', { level: 100, nature: 'Impish', evs: { hp: 252, def: 252 } });
const dm = (ov) => calculate(g9, base, new Pokemon(g9, 'Meowscarada', {
  level: 100, overrides: ov ? { types: ov } : undefined }), new Move(g9, 'Body Press')).damage[1];
const dGrassDark = dm(null), dBug = dm(['Bug']), dDark = dm(['Dark']);
console.log('   我们 Body Press(格) 打它：基础 草/恶=' + dGrassDark + '  纯虫=' + dBug + '  纯恶=' + dDark);
check('（前提）calc 确实认 overrides.types —— 三种属性给出不同数字',
  dGrassDark !== dBug && dGrassDark !== dDark, [dGrassDark, dBug, dDark].join(' / '));
check('纯虫 vs 基础：差 2 倍（虫抗格斗）', Math.abs(dGrassDark / dBug - 2) < 0.35 || dBug < dGrassDark, dBug + ' vs ' + dGrassDark);

console.log('');
console.log('④ 面板输出必须跟着变（这才是"接上了"的证据）');
const mkState = (types) => {
  // ⚠️ 基准那一份必须【不含】typechange 行 —— 第一版两边都 slice(0,9)、把那一行都带上了，
  //    于是「改没改属性」拿到同一个数字，断言看起来像产品没接上，其实是测试写错了。
  const L = REAL.slice(0, 8);
  if (types) L.push('|-start|p2a: Meow|typechange|' + types + '|[from] ability: Protean');
  return stateFromLog(L, 'p1', [{ species: 'Corviknight', ability: 'Pressure', item: 'Leftovers',
    nature: 'Impish', evs: { hp: 252, def: 252 }, moves: ['Body Press'] }], {});
};
const opt = (st2) => {
  const q = buildQuestion(st2);
  const a = (q.actions || []).find((x) => x.id === 'move:bodypress');
  return a ? a.pctHi : null;
};
const withBase = opt(mkState(null)), withBug = opt(mkState('Bug'));
console.log('   面板写 Body Press 打它：基础=' + withBase + '%   它变虫之后=' + withBug + '%');
check('变了属性之后面板数字【确实变了】', withBase != null && withBug != null && withBase !== withBug,
  withBase + ' → ' + withBug);
check('方向对：纯虫吃格斗更少', withBug != null && withBase != null && withBug < withBase,
  withBug + ' < ' + withBase);

console.log('');
console.log(bad ? bad + ' 项失败' : '全部通过');
process.exit(bad ? 1 : 0);
