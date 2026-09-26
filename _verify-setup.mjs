// 自检：强化技（剑舞/铁壁/…）在面板上被【读成什么】。
//
//   node _verify-setup.mjs
//
// 起因（用户报「整场一次强化都不用」× 2，第二次点名「厄鬼椪明明可以用剑舞扩大优势」）：
//   决策日志 battle-20260926-201943 turn 5 那一行，面板写的是
//     「回合账：… 一共 2 回合。【总回合数一样 —— 但这【不是亏】】…」
//   而同一份 instructions 的判据⑧写着「回合数没变 … → 才不值得」。
//   两句话互相打脸，模型信了后者 ⇒ Jev 给剑舞 0.22、棘藤棒 0.76。
//   这一条测的就是「打平」到底被写成了什么，以及「会带到下一只」有没有变成数字。
//
// 局面直接照抄真实那一局：厄鬼椪(水井面具) 100% vs 天蝎王 100%，
// 棘藤棒一发约 92%（⇒ 不强化 2 回合），剑舞 +2 后约 183%（⇒ 1 回合）⇒ netSave = 0。
// 手写局面，不联网、不调 Jev。
const { buildQuestion } = await import('./harness.mjs');

let bad = 0;
const check = (n, ok, extra) => { if (!ok) bad++; console.log((ok ? '  OK   ' : '  FAIL ') + n + (extra ? '   ' + extra : '')); };
const no = (n, s, sub) => check(n, !s.includes(sub), s.includes(sub) ? '（不该出现却出现了：' + sub + '）' : '');

const stateWith = (oppHp) => ({
  turn: 5,
  me: { active: { species: 'Ogerpon-Wellspring', hpPercent: 100, choices: null, set: {
    ability: 'Water Absorb', item: 'Wellspring Mask', nature: 'Jolly',
    evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 },
    moves: ['Swords Dance', 'Ivy Cudgel', 'Knock Off', 'Horn Leech'], boosts: {} } },
    bench: [] },
  opp: { active: { species: 'Gliscor', hpPercent: oppHp },
    revealed: ['Gliscor', 'Garganacl', 'Skarmory'],
    revealedMoves: { Gliscor: ['Earthquake', 'Knock Off'] },
    sets: {
      Gliscor: { ability: 'Poison Heal', item: 'Toxic Orb', nature: 'Impish',
        evs: { hp: 244, atk: 0, def: 252, spa: 0, spd: 12, spe: 0 },
        moves: ['Earthquake', 'Knock Off', 'Roost', 'Protect'] },
      Garganacl: { ability: 'Purifying Salt', item: 'Leftovers', nature: 'Impish',
        evs: { hp: 252, atk: 0, def: 252, spa: 0, spd: 4, spe: 0 }, moves: ['Salt Cure'] },
      Skarmory: { ability: 'Sturdy', item: 'Rocky Helmet', nature: 'Impish',
        evs: { hp: 252, atk: 0, def: 252, spa: 0, spd: 4, spe: 0 }, moves: ['Body Press'] } } },
  _hazards: { mine: [], theirs: [] }, _players: {}, _warnings: [],
});

const run = (oppHp) => {
  const b = buildQuestion(stateWith(oppHp));
  const a = b.actions.find(x => x.id === 'move:swordsdance');
  return { setup: a && a.setup, criteria: (b.questions.action.criteria || {})['move:swordsdance'] || '',
    instructions: b.questions.action.instructions };
};

console.log('① 满血天蝎王 —— 就是用户报的那一手，这一档正好【回合打平】（netSave = 0）');
const r1 = run(100);
check('生成了剑舞的判读', !!r1.setup);
console.log('   判读原文：' + r1.criteria.slice(0, 320) + ' …');
check('前提：确实是打平那一档（2 回合 → 1 回合强化 + 1 回合）',
  /不强化 → 出 2 次招/.test(r1.criteria) && /一共 2 回合/.test(r1.criteria), '');
check('写成了【★白赚】', r1.criteria.includes('【★白赚'), '');
no('不再出现旧措辞「但这【不是亏】】」', r1.criteria, '但这【不是亏】');
check('说明了挨打次数一模一样（不用读者自己推）', r1.criteria.includes('一模一样'), '');
check('把「会带到下一只」算成了具体数字', /带过去之后：/.test(r1.criteria) && /→ \d+ 回合|打不死 → /.test(r1.criteria), '');
check('带了前提（满血 + 使用率配置估）', r1.criteria.includes('按满血、使用率配置估'), '');

console.log('');
console.log('② instructions 的判据⑧不能再自相矛盾');
check('明写「总回合数一样 ≠ 不值得」', r1.instructions.includes('总回合数一样 ≠ 不值得'), '');
no('删掉了旧的那句「回合数没变…→ 才不值得」', r1.instructions, '回合数没变');

console.log('');
console.log('③ 对手残血时仍然要拦着（先杀人，别强化）');
const r3 = run(15);
check('明写「强化这一回合【没有必要】」', r3.criteria.includes('强化这一回合【没有必要】'), '');

console.log('');
console.log(bad ? bad + ' 项失败' : '全部通过');
process.exit(bad ? 1 : 0);
