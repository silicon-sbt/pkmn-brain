// 自检：先后手必须算出来、并且当「它更快 + 能打死你」时警告这一手打不出去。
//
//   node _verify-speed.mjs
//
// 复现的是 2026-09-26 第二局实际丢掉的两只：
//   turn 4  Kyurem 28% vs Inteleon —— 面板说「冰冻光束 可一击必杀」，
//           Inteleon 372 > Kyurem 317，它先手 Snipe Shot 把 Kyurem 打死，那一手根本没打出去。
//   turn 11 Ogerpon 31% vs Cyclizar —— 面板说「拍落 可一击必杀」，Cyclizar 先手 Dragon Claw。
// 用【手写日志】构造局面，完全不联网、不调 Jev、结果确定。
import { readFileSync } from 'node:fs';
const { stateFromLog } = await import('./log2state.mjs');
const { buildQuestion } = await import('./harness.mjs');
const { loadTeam } = await import('../toolkit/tools/lib.mjs');
const META = JSON.parse(readFileSync('../toolkit/data/meta-sets.json', 'utf8'));
const mine = loadTeam('../toolkit/teams/ou-c.txt');

let bad = 0;
const check = (n, ok) => { if (!ok) bad++; console.log((ok ? '  OK   ' : '  FAIL ') + n); };

function build(lines) {
  const st = stateFromLog(lines, 'p1', mine, META);
  if (!st) throw new Error('stateFromLog 返回 null');
  return buildQuestion(st);
}

// ── ① Kyurem 28% vs Inteleon（Snipe Shot 已经出过手，所以是已知招式）
const LOG_KYU = [
  '|player|p1|Me|', '|player|p2|Them|',
  '|poke|p1|Kyurem|', '|poke|p2|Inteleon|',
  '|switch|p1a: Kyurem|Kyurem, M|110/391',
  '|switch|p2a: Inteleon|Inteleon, M|100/100',
  '|move|p2a: Inteleon|Snipe Shot|p1a: Kyurem',
  '|-damage|p1a: Kyurem|110/391',
  '|turn|4',
];
const A = build(LOG_KYU);
const ac = A.questions.action.criteria;
const aIce = ac['move:icebeam'];
console.log('---- Kyurem 28% vs Inteleon：冰冻光束 ----');
console.log(String(aIce).replace(/。\s*/g, '。\n'));
check('写出了先后手数字（Kyurem 317 vs Inteleon 372）', /你 317 vs 它 372/.test(String(aIce)));
check('点明【它先动】', /它先动/.test(String(aIce)));
check('警告本回合必死（它更快 + 能打死你）', /【本回合必死】/.test(String(aIce)));
check('必死清单里出现了「比你先动」的普通招（新代码路径真的生效）', /（比你先动，打 \d+%）/.test(String(aIce)));
check('同时保留原有的先制招路径（Vacuum Wave 先制+1）', /（先制\+1，打 \d+%）/.test(String(aIce)));
check('明说这一手根本打不出去', /根本打不出去/.test(String(aIce)));
check('instructions 里也给了先后手', /【先后手】你 317 vs 它 372/.test(String(A.questions.action.instructions)));

// ── ② Ogerpon-Wellspring vs Cyclizar（Cyclizar 更快）
const LOG_CYC = [
  '|player|p1|Me|', '|player|p2|Them|',
  '|poke|p1|Ogerpon-Wellspring|', '|poke|p2|Cyclizar|',
  '|switch|p1a: Ogerpon|Ogerpon-Wellspring, F|301/301',
  '|switch|p2a: Cyclizar|Cyclizar, F|100/100',
  '|move|p2a: Cyclizar|Dragon Claw|p1a: Ogerpon',
  '|-damage|p1a: Ogerpon|205/301',
  '|turn|9',
];
const B = build(LOG_CYC);
const bc = B.questions.action.criteria;
const bSd = bc['move:swordsdance'];
const bKnock = bc['move:knockoff'];
console.log('\n---- Ogerpon vs Cyclizar：剑舞 ----');
console.log(String(bSd).replace(/。\s*/g, '。\n'));
check('剑舞选项带先后手', /【先后手】/.test(String(bSd)));
check('拍落选项也带先后手', /【先后手】/.test(String(bKnock)));
check('打平时措辞明确说【不是亏】', /但这【不是亏】/.test(String(bSd)));
check('不再写「省不出回合」这种偏负面的说法', !/强化省不出回合/.test(String(bSd)));

// ── ③ 对手【只有普通招】但更快：必须说「它更快 X > 你 Y」，而不是「先制」
const mySet = mine.find(m => m.species === 'Zamazenta');
const st3 = {
  turn: 4,
  me: { active: { species: 'Zamazenta', hpPercent: 20, set: mySet, choices: null }, bench: [] },
  opp: {
    active: { species: 'Dragapult', hpPercent: 100 },
    revealed: ['Dragapult'],
    revealedMoves: { Dragapult: ['Dragon Darts', 'U-turn', 'Shadow Ball', 'Fire Blast'] },
    sets: { Dragapult: { ability: 'Clear Body', item: 'Heavy-Duty Boots', nature: 'Timid',
      evs: { hp: 0, atk: 0, def: 0, spa: 252, spd: 4, spe: 252 },
      moves: ['Dragon Darts', 'U-turn', 'Shadow Ball', 'Fire Blast'] } },
  },
  _hazards: { mine: [], theirs: [] }, _players: {}, _warnings: [],
};
const C = buildQuestion(st3);
const cCrit = C.questions.action.criteria;
const anyC = Object.values(cCrit).map(String).join(' | ');
console.log('\n---- 只有普通招、但更快（Zamazenta 20% vs Dragapult）----');
console.log(String(cCrit['move:closecombat']).replace(/。\s*/g, '。\n'));
check('无先制招时，必死理由写成「它更快 X > 你 Y」', /它更快 \d+ > 你 \d+/.test(anyC));
check('并且【没有】误报成先制', !/先制\+/.test(String(cCrit['move:closecombat']).split('【本回合必死】')[1] || ''));

console.log(bad ? ('\n❌ ' + bad + ' 项失败') : '\n✅ 全部通过');
process.exit(bad ? 1 : 0);