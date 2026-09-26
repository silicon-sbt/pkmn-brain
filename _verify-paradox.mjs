// 自检：古代活性 / 夸克充能（含驱动能量）的 ×1.3 有没有算进去。
//
//   node _verify-paradox.mjs
//
// 两件事分开验：
//   ① 我们这边确实乘了 1.3（面板文案前后对比）
//   ② 1.3 这个数**是引擎的真值** —— 真跑一局 @pkmn/sim 对拍，不是拍脑袋写的常数
// 手写局面 + 本地引擎，不联网、不调 Jev。
const sim = await import('@pkmn/sim');
const { Battle, Teams } = sim;
const { buildQuestion } = await import('./harness.mjs');

let bad = 0;
const check = (n, ok, extra) => { if (!ok) bad++; console.log((ok ? '  OK   ' : '  FAIL ') + n + (extra ? '   ' + extra : '')); };

const TUSK_EVS = { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 };
const GARG_EVS = { hp: 252, atk: 0, def: 4, spa: 0, spd: 252, spe: 0 };

const stateWith = (paradox) => ({
  turn: 5,
  me: { active: { species: 'Great Tusk', hpPercent: 100, choices: null, set: {
    ability: 'Protosynthesis', item: 'Booster Energy', nature: 'Adamant', evs: TUSK_EVS,
    moves: ['Headlong Rush', 'Rapid Spin', 'Ice Spinner', 'Knock Off'], paradox } }, bench: [] },
  opp: { active: { species: 'Garganacl', hpPercent: 100 },
    revealed: ['Garganacl'], revealedMoves: { Garganacl: ['Salt Cure'] },
    sets: { Garganacl: { ability: 'Purifying Salt', item: 'Leftovers', nature: 'Careful', evs: GARG_EVS,
      moves: ['Salt Cure'], paradox: null } } },
  _hazards: { mine: [], theirs: [] }, _players: {}, _warnings: [],
});

const pctOf = (st) => {
  const b = buildQuestion(st);
  const f = b.actions.find(a => a.id === 'move:headlongrush');
  return f ? f.expPct : null;
};
const withPx = pctOf(stateWith('atk'));
const without = pctOf(stateWith(null));
console.log('① 我们这边（面板算出来的期望伤害 %）');
console.log('   无驱动能量: ' + without.toFixed(1) + '%     有驱动能量(+古代活性提攻): ' + withPx.toFixed(1) + '%');
const ourRatio = withPx / without;
check('乘了倍率（不再是同一个数）', Math.abs(withPx - without) > 1);
check('倍率 ≈ 1.3', Math.abs(ourRatio - 1.3) < 0.02, '实测 ' + ourRatio.toFixed(3));

// ── ①b 先把【前提】钉住：@smogon/calc 本身确实完全不建这个特性。
//   没有这一条，整个 paradoxMult 就是「凭印象补的一个倍数」——
//   而本项目的规矩是「calc 支不支持 X，一律先写个对拍测出来」。
//   （这一条原来是一个只打印不断言的临时探针 _probe-paradox.mjs，已折进来。）
{
  const { Generations, Pokemon, Move, calculate } = await import('@smogon/calc');
  const g = Generations.get(9);
  const defSet = { level: 100, nature: 'Impish', evs: { hp: 252, atk: 0, def: 252, spa: 0, spd: 4, spe: 0 } };
  const base = { level: 100, nature: 'Adamant', evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 } };
  const def = new Pokemon(g, 'Garganacl', defSet);
  const D = (p) => calculate(g, p, def, new Move(g, 'Headlong Rush')).damage[0];
  const A = D(new Pokemon(g, 'Great Tusk', base));
  const variants = {
    'ability=Protosynthesis': { ...base, ability: 'Protosynthesis' },
    'item=Booster Energy': { ...base, item: 'Booster Energy' },
    '两个都给': { ...base, ability: 'Protosynthesis', item: 'Booster Energy' },
    'boosts.atk=+1': { ...base, boosts: { atk: 1 } },
  };
  const same = Object.entries(variants).map(([k, s]) => [k, D(new Pokemon(g, 'Great Tusk', s))]);
  console.log('');
  console.log('①b calc 自己建不建这个特性（原始伤害 ' + A + '）');
  for (const [k, v] of same) console.log('   ' + k + '：' + v + (v === A ? '（没变）' : '（变了）'));
  check('calc 对 ability / item / 两者都给的写法一律【不生效】（这就是我们必须自己乘的原因）',
    same[0][1] === A && same[1][1] === A && same[2][1] === A);
  check('boosts.atk=+1 会生效，但那是 ×1.5 的能力等级，粒度太粗、替代不了 ×1.3',
    same[3][1] > A);
}

// ── ② 对拍：真跑引擎，看倍率到底是多少
//
// ⚠️ 引擎这一侧用【冰旋】(move 3，80 威力、对盐石巨灵中性)。
//    一开始用 头锤冲撞（本系 + 对岩石 2 倍）—— 实测直接秒杀，日志里那条是
//    `|-damage|p2a: Garganacl|0 fnt`，**没有 x/y 数字可读**，整段对拍静默拿到 null。
//    测倍率必须让靶子活下来，否则读不到任何比例。
const TUSK = (item) => ['Great Tusk @ ' + (item || 'Leftovers'), 'Ability: Protosynthesis', 'Level: 100',
  'EVs: 252 Atk / 4 SpD / 252 Spe', 'Adamant Nature', '- Headlong Rush', '- Rapid Spin', '- Ice Spinner', '- Knock Off'].join('\n');
const GARG = ['Garganacl @ Leftovers', 'Ability: Purifying Salt', 'Level: 100',
  'EVs: 252 HP / 4 Def / 252 SpD', 'Careful Nature', '- Salt Cure', '- Recover', '- Iron Defense', '- Body Press'].join('\n');

// ⚠️ gen9ou 至少要 6 只，单只队伍起不来（实测：日志里一条 -damage 都没有）。
//    所以补 5 只填充，正式那只放 1 号位，用 move 1。
// ⚠️ 填充不能用同一只 —— Gen9 有 Species Clause，重复物种队伍非法，整局起不来
//    （实测：日志里一条 -damage 都没有，静默拿到 null）。所以用 5 只不同的。
const FILLERS = [
  ['Corviknight @ Leftovers', 'Ability: Pressure', '- Brave Bird', '- Body Press', '- Roost', '- Iron Defense'],
  ['Ting-Lu @ Leftovers', 'Ability: Vessel of Ruin', '- Earthquake', '- Ruination', '- Stealth Rock', '- Whirlwind'],
  ['Clodsire @ Leftovers', 'Ability: Unaware', '- Earthquake', '- Recover', '- Toxic', '- Stealth Rock'],
  ['Dondozo @ Leftovers', 'Ability: Unaware', '- Wave Crash', '- Rest', '- Sleep Talk', '- Curse'],
  ['Skarmory @ Rocky Helmet', 'Ability: Sturdy', '- Body Press', '- Roost', '- Spikes', '- Whirlwind'],
].map(l => [l[0], 'Level: 100'].concat(l.slice(1)).join('\n'));   // ⚠️ 物种名必须第一行，Level 放后面
function team6(head) { return [head].concat(FILLERS).join('\n\n'); }

const RUNS = 80;
function engineDamage(item) {
  const got = [];
  let miss = 0;                                // ⚠️ 静默失败红线：读不到就数出来，不许当没发生
  for (let i = 0; i < RUNS; i++) {
    const b = new Battle({ formatid: 'gen9ou', seed: 'sodium,' + (9000 + i) });
    b.setPlayer('p1', { team: Teams.pack(Teams.import(team6(TUSK(item)))) });
    b.setPlayer('p2', { team: Teams.pack(Teams.import(team6(GARG))) });
    if (b.p1.requestState === 'teampreview') { b.p1.choose('team 123456'); b.p2.choose('team 123456'); b.commitChoices(); }
    const mark = b.log.length;
    b.p1.choose('move 3'); b.p2.autoChoose(); b.commitChoices();   // move 3 = 冰旋
    // ⚠️ 两个坑，都在这里踩过：
    //   ① `-damage|x/y` 的 x 是【打完之后的剩余血量】，不是伤害 —— 直接拿 x/y 当伤害，
    //      会得到 80% 这种数（其实是「还剩 80%」），倍率还会算成 0.92（方向反的）。
    //   ② 引擎把同一次掉血记两行（真血量 `249/404` + 百分比 `62/100`）⇒ 每局只取第一行。
    const line = b.log.slice(mark).find(l =>
      typeof l === 'string' && /^\|-damage\|p2a: Garganacl\|\d+\/\d+/.test(l));
    if (!line) { miss++; continue; }
    const m = /^\|-damage\|p2a: Garganacl\|(\d+)\/(\d+)/.exec(line);
    got.push((1 - Number(m[1]) / Number(m[2])) * 100);
  }
  got.sort((a, b) => a - b);
  return { med: got[Math.floor(got.length / 2)], n: got.length, miss };
}
const rNo = engineDamage(null);
const rYes = engineDamage('Booster Energy');
console.log('');
console.log('② 引擎实跑（中位数，各 ' + RUNS + ' 次）');
check('每一局都读到了伤害数字（没有静默拿 null）', rNo.miss === 0 && rYes.miss === 0,
  '无: ' + rNo.n + '/' + RUNS + ' 有: ' + rYes.n + '/' + RUNS);
check('引擎这一侧的绝对数在合理区间（冰旋打 4 防盐石巨灵，十几到三十几个百分点）',
  rNo.med > 10 && rNo.med < 40, '实测 ' + rNo.med.toFixed(1) + '%');
console.log('   无驱动能量: ' + rNo.med.toFixed(1) + '%     有驱动能量: ' + rYes.med.toFixed(1) + '%');
const engRatio = rYes.med / rNo.med;
check('引擎的倍率也 ≈ 1.3（证明 1.3 是引擎的真值，不是我们拍的常数）',
  Math.abs(engRatio - 1.3) < 0.06, '实测 ' + engRatio.toFixed(3));
console.log('   （我们的伤害管线本身和引擎的对拍在 _verify-dmg.mjs / verify_firsthit.mjs，这里只管倍率）');

console.log('');
console.log(bad ? bad + ' 项失败' : '全部通过');
process.exit(bad ? 1 : 0);

console.log(bad ? ('\n❌ ' + bad + ' 项失败') : '\n✅ 全部通过');
process.exit(bad ? 1 : 0);