import { loadTeamOr } from './_sample-teams.mjs';
// 自检：讲究道具锁在一招【完全无效】的招上时，面板必须只给换人。
//
//   node _verify-deadmove.mjs
//
// 复现的是用户实测的那个局面：讲究眼镜的酋雷姆锁在流星群上、对面是妖精。
// 修前 Jev 两次都选了那发打不出伤害的流星群（置信 0.56 / 0.40）——
// 原因见 harness.mjs 的 deadLock 注释。这个自检【不调 Jev】（fetch 打桩），
// 只断言事实层给出的选项和文案，所以结果稳定、不烧额度。
import * as sim from '@pkmn/sim';
const { Battle, Teams } = sim;
let captured = null;
globalThis.fetch = async (url, init) => {
  if (init && init.body) { try { captured = JSON.parse(init.body).questions; } catch (e) {} }
  const answers = {};
  for (const [k, q] of Object.entries(captured || {})) {
    const ids = q.criteria ? Object.keys(q.criteria) : [];
    answers[k] = q.type === 'choice'
      ? { type: 'choice', choice: ids[0] || null, confidence: 0.5, probabilities: {} }
      : { type: 'noul', noul: 0.5 };
  }
  return { status: 200, text: async () => JSON.stringify({ answers }) };
};
process.env.TYPESAFE_API_KEY = 'stub';
const { decide } = await import('./serve.mjs');
const { loadTeam } = await import('./toolkit/tools/lib.mjs');

const mine = loadTeamOr('./toolkit/teams/ou-c.txt', 'ou-c');
const theirs = Teams.import([
  'Clefable @ Leftovers','Ability: Magic Guard','Level: 100','- Moonblast','- Soft-Boiled','- Calm Mind','- Flamethrower','',
  'Corviknight @ Leftovers','Ability: Pressure','Level: 100','- Brave Bird','- Body Press','- Roost','- Iron Defense','',
  'Great Tusk @ Leftovers','Ability: Protosynthesis','Level: 100','- Headlong Rush','- Close Combat','- Rapid Spin','- Knock Off',
].join('\n'));

const b = new Battle({ formatid: 'gen9ou', seed: [11, 22, 33, 44] });
b.setPlayer('p1', { team: Teams.pack(mine) });
b.setPlayer('p2', { team: Teams.pack(theirs) });
const snap = () => b.sides[0].activeRequest ? JSON.parse(JSON.stringify(b.sides[0].activeRequest)) : null;

let req = snap();
await decide({ log: b.log.join('\n'), me: 'Player 1', request: req });
b.makeChoices('team 561234', 'team 123456');   // 先发 Kyurem
b.makeChoices('move 4', 'move 2');             // 流星群（妖精免疫，但照样被眼镜锁住）
b.makeChoices('move 4', 'move 2');

req = snap();
const moves = (req.active[0].moves || []).map(m => m.move + (m.disabled ? '[disabled]' : ''));
console.log('锁招后的 active[0].moves = ' + JSON.stringify(moves));
console.log('对手场上 = ' + b.sides[1].active[0].species.name);

const out = await decide({ log: b.log.join('\n'), me: 'Player 1', request: req });
const moveOpts = out.allOptions.filter(o => o.id.startsWith('move:'));
const switchOpts = out.allOptions.filter(o => o.id.startsWith('switch:'));
console.log('选项 = ' + out.allOptions.map(o => o.id).join(', '));

const checks = [
  ['唯一能点的招被锁住（Earth Power/Freeze-Dry/Ice Beam 全 disabled）',
    moves.filter(m => m.includes('[disabled]')).length === 3],
  ['出招选项里【没有】那发无效的流星群', moveOpts.length === 0],
  ['仍然给出全部 5 个换人选项', switchOpts.length === 5],
  ['instructions 里明说「本回合出招 = 空过」',
    /本回合出招 = 空过/.test(String(captured && captured.action.instructions))],
  ['换人文案不再说「白送对手一次攻击」（出招同样是空过）',
    !/白送对手一次攻击/.test(String(captured && captured.action.criteria[switchOpts[0] && switchOpts[0].id]))],
  ['opp_switch 里给了「你这回合打不出伤害」这条支持它换人的事实',
    /一点伤害都打不出/.test(JSON.stringify(captured && captured.opp_switch))],
];
let bad = 0;
for (const [name, ok] of checks) { if (!ok) bad++; console.log((ok ? '  OK   ' : '  FAIL ') + name); }
console.log(bad ? ('\n❌ ' + bad + ' 项失败') : '\n✅ 全部通过');
process.exit(bad ? 1 : 0);