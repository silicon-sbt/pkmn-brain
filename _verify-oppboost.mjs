import { loadTeamOr } from './_sample-teams.mjs';
// 自检：对手的【能力等级】必须进 calc —— 这是 2026-09-26 第三局被推队的直接原因。
//
//   node _verify-oppboost.mjs
//
// 那一局：玛力露丽腹鼓到 +6 攻，面板却一直按 +0 算它的输出 ——
//   · 写着「它打你很痛（Liquidation 66%）」，+6 真实值是 223-263%
//   · +6 的 Aqua Jet 是 105-124%（先制、必杀），可按 +0 只有 27-31%
//     ⇒ kills_our_active=false ⇒【先制必杀警告一次都没触发】⇒ 连着让 5 只上去送
// 手写日志构局，不联网、不调 Jev。
import { readFileSync } from 'node:fs';
const { stateFromLog } = await import('./log2state.mjs');
const { buildQuestion } = await import('./harness.mjs');
const { loadTeam } = await import('./toolkit/tools/lib.mjs');
const META = JSON.parse(readFileSync('./toolkit/data/meta-sets.json', 'utf8'));
const mine = loadTeamOr('./toolkit/teams/ou-a.txt', 'ou-a');

let bad = 0;
const check = (n, ok, extra) => { if (!ok) bad++; console.log((ok ? '  OK   ' : '  FAIL ') + n + (extra ? '   ' + extra : '')); };

const HEAD = [
  '|player|p1|Me|', '|player|p2|Them|',
  '|poke|p1|Gholdengo|', '|poke|p2|Azumarill|',
  '|switch|p1a: Gholdengo|Gholdengo, M|315/315',
  '|switch|p2a: Azumarill|Azumarill, M|100/100',
  '|turn|1',
  '|move|p2a: Azumarill|Aqua Jet|p1a: Gholdengo',
  '|-damage|p1a: Gholdengo|315/315',
  '|move|p2a: Azumarill|Liquidation|p1a: Gholdengo',
  '|-damage|p1a: Gholdengo|315/315',
];

console.log('① 腹鼓 +6 之后，对手的等级有没有进 state');
const LOG6 = HEAD.concat([
  '|turn|2',
  '|move|p2a: Azumarill|Belly Drum|p2a: Azumarill',
  '|-damage|p2a: Azumarill|4/100',
  '|-setboost|p2a: Azumarill|atk|6|[from] move: Belly Drum',
]);
const st6 = stateFromLog(LOG6, 'p1', mine, META);
check('log2state 收到了 +6', !!(st6.opp.sets.Azumarill && st6.opp.sets.Azumarill.boosts && st6.opp.sets.Azumarill.boosts.atk === 6),
  JSON.stringify(st6.opp.sets.Azumarill && st6.opp.sets.Azumarill.boosts));

const Q = buildQuestion(st6);
const crit = Q.questions.action.criteria;
const anyAttack = Object.entries(crit).find(([id]) => id.startsWith('move:') && !id.includes('recover'));
const txt = String(anyAttack && anyAttack[1]);
console.log('\n---- 面板原文（赛富豪 100% vs 玛力露丽 4% / +6 攻）----');
for (const [id, t] of Object.entries(crit)) { if (id.startsWith('move:')) console.log('  [' + id + ']\n   ' + String(t).replace(/。\s*/g, '。\n   ').slice(0, 400)); }

check('触发了【本回合必死】警告（+6 的 Aqua Jet 先制必杀）', /【本回合必死】/.test(txt));
check('必死清单点名了 Aqua Jet', /Aqua Jet/.test(txt));
check('点明它是先制招', /先制\+1/.test(txt));
const swf = Q.risk ? [...(Q.risk.stayReasons || []), ...(Q.risk.switchReasons || [])].join(' | ') : '';
const m = /Liquidation (\d+)%/.exec(swf);
check('对手输出按 +6 算（不再写 66%）', m && Number(m[1]) > 100, m ? ('Liquidation ' + m[1] + '%') : swf.slice(0, 120));

console.log('\n② 换下场必须清等级（否则它换上来还带着 +6）');
const LOG_SW = LOG6.concat([
  '|turn|3',
  '|switch|p2a: Pelipper|Pelipper, F|100/100',
]);
const stSw = stateFromLog(LOG_SW, 'p1', mine, META);
check('玛力露丽下场后 +6 被清掉', !(stSw.opp.sets.Azumarill && stSw.opp.sets.Azumarill.boosts && stSw.opp.sets.Azumarill.boosts.atk),
  JSON.stringify(stSw.opp.sets.Azumarill && stSw.opp.sets.Azumarill.boosts));

console.log(bad ? ('\n❌ ' + bad + ' 项失败') : '\n✅ 全部通过');
process.exit(bad ? 1 : 0);