
// 自检：把 buildQuestion 生成的【面板文案】原样打出来，不用真 Jev。
//
//   node _verify-setup-text.mjs [队伍文件] [先发顺序，如 431256]
//
// 做法：用一个 fetch 桩顶掉 Jev（不联网、不烧额度），把发出去的 questions 原文抓下来打印。
// 用途：改了 harness 的事实层文案后，先在这里看一眼真实局面下到底写了什么 ——
//       面板是纯文字，文案就是全部信息，光看代码看不出「读起来自相矛盾」。
// 实测踩过两次：①铁壁的收益被藏起来（基准招选错）②「几回合打死（X%）」两个基准并排
//       变成「1 回合就能打死它（35%）」这种自相矛盾的句子。两个都是这么当场看出来的。
import * as sim from '@pkmn/sim';
const { Battle, Teams } = sim;

let captured = null;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  captured = body.questions;
  const answers = {};
  for (const [k, q] of Object.entries(body.questions)) {
    const ids = q.criteria ? Object.keys(q.criteria) : [];
    answers[k] = q.type === 'choice'
      ? { type: 'choice', choice: ids[0] || null, confidence: 0.5, probabilities: {} }
      : { type: 'noul', noul: 0.5 };
  }
  return { status: 200, text: async () => JSON.stringify({ answers }) };
};
process.env.TYPESAFE_API_KEY = 'stub';

const { decide } = await import('./serve.mjs');
const { loadTeam } = await import('../toolkit/tools/lib.mjs');

const mine = loadTeam('../toolkit/teams/ou-c.txt');
const packed = (t) => Teams.pack(t);
const theirs = Teams.import('Corviknight\nAbility: Pressure\nLevel: 100\nItem: Leftovers\n- Brave Bird\n- Body Press\n- Roost\n- Iron Defense'
  + '\n\nGarganacl\nAbility: Purifying Salt\nLevel: 100\nItem: Leftovers\n- Salt Cure\n- Recover\n- Iron Defense\n- Body Press'
  + '\n\nGreat Tusk\nAbility: Protosynthesis\nLevel: 100\nItem: Leftovers\n- Headlong Rush\n- Close Combat\n- Rapid Spin\n- Knock Off');

const b = new Battle({ formatid: 'gen9ou', seed: [7, 7, 7, 7] });
b.setPlayer('p1', { team: packed(mine) });
b.setPlayer('p2', { team: packed(theirs) });
const snap = () => b.sides[0].activeRequest ? JSON.parse(JSON.stringify(b.sides[0].activeRequest)) : null;

let req = snap();
console.log('先发请求: ' + (req && req.teamPreview ? 'teamPreview' : req && req.active ? 'active' : '?'));
await decide({ log: b.log.join('\n'), me: 'Player 1', request: req });
// 先发 Zamazenta(4) + Ogerpon(3)
b.makeChoices('team 431256', 'team 123456');

for (let turn = 1; turn <= 8; turn++) {
  req = snap();
  if (!req || !req.active || req.forceSwitch) { console.log('turn ' + turn + ': 非出招请求，跳过'); b.makeChoices(); continue; }
  const meSp = b.sides[0].active[0].species.name;
  const oppSp = b.sides[1].active[0].species.name;
  let out;
  try { out = await decide({ log: b.log.join('\n'), me: 'Player 1', request: req }); }
  catch (e) { console.log('turn ' + turn + ' decide 抛错: ' + e.message); break; }
  const setups = out.allOptions.filter(o => o.kind === 'setup');
  console.log('\n════ turn ' + turn + ' ════ ' + meSp + ' vs ' + oppSp + ' | 选项 ' + out.allOptions.length + ' 个，其中强化 ' + setups.length + ' 个');
  console.log('  面板建议: ' + (out.nameZh || out.name) + (out.why ? ' | ' + out.why : ''));
  for (const s of setups) {
    const c = captured['action'] && captured['action'].criteria[s.id];
    console.log('  ── ' + s.id + ' ──');
    console.log('  RAW: ' + JSON.stringify(c).slice(0, 260));
    console.log('  ' + String(c).replace(/。\s*/g, '。\n  '));
  }
  const atk = out.allOptions.find(o => o.kind === 'move');
  if (atk) console.log('  ── 对照：攻击选项 ' + atk.id + ' ──\n  ' + String(captured['action'].criteria[atk.id]).replace(/。\s*/g, '。\n  '));
  b.makeChoices('move 1', 'move 1');
}
console.log('\n=== 战斗结束 = ' + b.ended + ' ===');
