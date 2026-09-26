import { loadTeamOr } from './_sample-teams.mjs';
// 自检：钉子招必须在面板上带【数字】—— 否则等于不存在。
//
//   node _verify-hazard.mjs
//
// 复现的是用户 2026-09-26 报的那一局：土地云是我方唯一的撒钉手，整局一次隐形岩都没撒。
// 决策日志里那一条的原文只有「隐形岩（对手出场时受岩石相性伤害。）」——
// 没有数字、没有代价、也没有「对面有几只怕它」，Jev 给的概率是 0.00。
// 这个自检【不调 Jev】（fetch 打桩），只断言事实层写出来的文案。
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
let bad = 0;
const check = (n, ok) => { if (!ok) bad++; console.log((ok ? '  OK   ' : '  FAIL ') + n); };

// ① 对手先发 Corviknight（在使用率表里 ⇒ 招式已知 ⇒ 代价句成立）
//    后排故意混进 4 倍弱岩（火神蛾）、2 倍（快龙）、抗岩（古鼎鹿/雄伟牙）
async function run(lead, rest) {
  captured = null;
  const b = new Battle({ formatid: 'gen9ou', seed: [1, 2, 3, 4] });
  b.setPlayer('p1', { team: Teams.pack(mine) });
  b.setPlayer('p2', { team: Teams.pack(Teams.import([lead].concat(rest).join('\n\n'))) });
  const snap = () => b.sides[0].activeRequest ? JSON.parse(JSON.stringify(b.sides[0].activeRequest)) : null;
  await decide({ log: b.log.join('\n'), me: 'Player 1', request: snap() });
  b.makeChoices('team 123456', 'team 123456');   // 我方先发 土地云，对方先发 1 号位
  const out = await decide({ log: b.log.join('\n'), me: 'Player 1', request: snap() });
  return { b, out, crit: (captured && captured.action && captured.action.criteria) || {},
           ins: String((captured && captured.action && captured.action.instructions) || '') };
}

const CORV = 'Corviknight @ Leftovers\nAbility: Pressure\nLevel: 100\n- Brave Bird\n- Body Press\n- Roost\n- Iron Defense';
const VOLC = 'Volcarona @ Heavy-Duty Boots\nAbility: Flame Body\nLevel: 100\n- Quiver Dance\n- Fiery Dance\n- Bug Buzz\n- Giga Drain';
const DDNI = 'Dragonite @ Heavy-Duty Boots\nAbility: Multiscale\nLevel: 100\n- Dragon Dance\n- Earthquake\n- Ice Spinner\n- Roost';
const TING = 'Ting-Lu @ Leftovers\nAbility: Vessel of Ruin\nLevel: 100\n- Earthquake\n- Ruination\n- Stealth Rock\n- Whirlwind';
const TUSK = 'Great Tusk @ Leftovers\nAbility: Protosynthesis\nLevel: 100\n- Headlong Rush\n- Close Combat\n- Rapid Spin\n- Knock Off';

console.log('① 对手先发 Corviknight（我方 土地云）—— 钉子文案');
const A = await run(CORV, [VOLC, DDNI, TING, TUSK]);
const sr = A.crit['move:stealthrock'];
console.log('\n---- move:stealthrock ----\n' + String(sr).replace(/。\s*/g, '。\n'));
const t = String(sr || '');
check('隐形岩选项存在', !!sr);
check('带【钉子】标签（不再只有一句描述）', /【钉子】隐形岩/.test(t));
check('4 倍弱岩算成 50%（火神蛾）', /火神蛾 50%/.test(t));
check('2 倍弱岩算成 25%（快龙）', /快龙 25%/.test(t));
check('抗岩算成 6.3% 以下（古鼎鹿）', /古鼎鹿 6\.3%/.test(t));
check('双重抵抗算成 3.1%（雄伟牙）', /雄伟牙 3\.1%/.test(t));
check('给出「几只要掉 25% 以上」', /只每次上场要掉 25% 以上/.test(t));
check('给出平均每次换人的期望伤害', /平均每次换人掉 [\d.]+%/.test(t));
check('写清楚这是投资不是输出', /这是【投资】/.test(t));
check('和攻击选项共用同一句代价（对称事实）',
  /本回合无论如何你都会吃一次攻击/.test(t) &&
  Object.entries(A.crit).some(([id, x]) => id.startsWith('move:') && id !== 'move:stealthrock' && /本回合无论如何你都会吃一次攻击/.test(String(x))));

console.log('\n② 对手先发 Volcarona（不在使用率表里、还没出过手）—— 威胁未知必须可见');
const B = await run(VOLC, [CORV, DDNI, TING, TUSK]);
check('instructions 里明说【威胁未知】', /【威胁未知】/.test(B.ins));
check('并说明「算不出来，不代表它没威胁」', /不代表它没威胁/.test(B.ins));

console.log('\n③ 换人代价要带判读（89% 这种裸数字不行）');
const verdicts = Object.entries(A.crit).filter(([id]) => id.startsWith('switch:'))
  .map(([id, x]) => [id, String(x)]);
const anyVerdict = verdicts.some(([, x]) => /【换上来就会|【换上来只剩|【换上来要掉一半以上/.test(x));
check('换人选项带「换上来会怎样」的判读', anyVerdict);
for (const [id, x] of verdicts.slice(0, 3)) console.log('   ' + id + ' → ' + x.replace(/。\s*/g, '。\n      ').slice(0, 220));

console.log(bad ? ('\n❌ ' + bad + ' 项失败') : '\n✅ 全部通过');
process.exit(bad ? 1 : 0);