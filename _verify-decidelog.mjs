// 自检：决策日志端到端 —— 起一个真服务（放在 7799 端口，不打扰你在用的 7777），
// 跑几回合真对战，POST 过去，然后检查 logs/ 里有没有落盘、logview 能不能读出来。
//
//   node _verify-decidelog.mjs
//
// ⚠️ 会真的调 Jev（每次决策一次调用）。保持 2-3 回合，别放大。
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as sim from '@pkmn/sim';
const { Battle, Teams } = sim;

const PORT = 7799;
const HERE = fileURLToPath(new URL('.', import.meta.url));
const LOGDIR = HERE + 'logs/';

// 清掉本次自检产生的存档，免得和真存档混在一起
function cleanTestLogs() {
  if (!existsSync(LOGDIR)) return;
  for (const f of readdirSync(LOGDIR)) if (f.startsWith('selftest-')) rmSync(LOGDIR + f, { force: true });
}
mkdirSync(LOGDIR, { recursive: true });
cleanTestLogs();

const srv = spawn(process.execPath, ['serve.mjs'], {
  cwd: HERE, env: { ...process.env, JEV_PORT: String(PORT) }, stdio: 'ignore',
});
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function health() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/health'); if (r.ok) return await r.json(); } catch (e) {}
    await wait(250);
  }
  return null;
}

let bad = 0;
const check = (name, ok) => { if (!ok) bad++; console.log((ok ? '  OK   ' : '  FAIL ') + name); };

try {
  const h = await health();
  if (!h) { console.log('❌ 自检服务起不来（端口 ' + PORT + '）'); process.exit(1); }
  console.log('自检服务已起：' + JSON.stringify(h));

  const { loadTeam } = await import('../toolkit/tools/lib.mjs');
  const mine = loadTeam('../toolkit/teams/ou-c.txt');
  const theirs = Teams.import([
    'Corviknight @ Leftovers','Ability: Pressure','Level: 100','- Brave Bird','- Body Press','- Roost','- Iron Defense','',
    'Great Tusk @ Leftovers','Ability: Protosynthesis','Level: 100','- Headlong Rush','- Close Combat','- Rapid Spin','- Knock Off','',
    'Garganacl @ Leftovers','Ability: Purifying Salt','Level: 100','- Salt Cure','- Recover','- Iron Defense','- Body Press',
  ].join('\n'));
  const b = new Battle({ formatid: 'gen9ou', seed: [2, 4, 6, 8] });
  b.setPlayer('p1', { team: Teams.pack(mine) });
  b.setPlayer('p2', { team: Teams.pack(theirs) });
  const snap = () => b.sides[0].activeRequest ? JSON.parse(JSON.stringify(b.sides[0].activeRequest)) : null;

  const ask = async (req) => {
    const r = await fetch('http://127.0.0.1:' + PORT + '/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pkmn-Brain': '1' },
      // room 用固定名字，方便断言文件名
      body: JSON.stringify({ log: b.log.join('\n'), me: 'Player 1', request: req, room: 'selftest-battle' }),
    });
    return await r.json();
  };

  let req = snap();
  const o0 = await ask(req);
  console.log('  选人 → ' + (o0.nameZh || o0.pick));
  b.makeChoices('team 341256', 'team 123456');
  for (let t = 0; t < 3; t++) {
    req = snap(); if (!req || !req.active) { b.makeChoices(); continue; }
    const o = await ask(req);
    console.log('  t' + o.turn + ' → ' + (o.nameZh || o.pick));
    // 面板不需要这些字段（服务端发回前会删掉）—— 在这里确认它真的删了
    check('第 ' + (t + 1) + ' 次返回里没有 _criteria（几 KB 的原文不该发回浏览器）', o._criteria === undefined);
    b.makeChoices('move 1', 'move 1');
  }

  await wait(300);
  const jl = LOGDIR + 'selftest-battle.jsonl';
  const lg = LOGDIR + 'selftest-battle.log';
  check('生成了 selftest-battle.jsonl', existsSync(jl));
  check('生成了 selftest-battle.log', existsSync(lg));

  const recs = existsSync(jl) ? readFileSync(jl, 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)) : [];
  check('每次决策都写了一行（选人 + 每回合，>=3 行）', recs.length >= 3);
  const battleRecs = recs.filter(r => r.shape === 'move');
  check('出招阶段的记录带 criteria（面板原文）', battleRecs.length > 0 && battleRecs.every(r => r.criteria && Object.keys(r.criteria).length > 0));
  check('出招阶段的记录带 instructions', battleRecs.every(r => typeof r.instructions === 'string' && r.instructions.length > 50));
  check('记录了 Jev 的回答（answers.action.choice）', battleRecs.every(r => r.answers && r.answers.action && r.answers.action.choice));
  check('记录了面板最终建议（panel.pick）', battleRecs.every(r => r.panel && r.panel.pick));
  check('logLines 单调递增（供 logview 切 Showdown 行用）',
    recs.every((r, i) => i === 0 || r.logLines >= recs[i - 1].logLines));
  const mode = new Set(recs.map(r => r.shape));
  check('三种阶段都能记到（至少出现 teampreview 与 move）', mode.has('teampreview') && mode.has('move'));

  // logview 能不能读
  const { execFileSync } = await import('node:child_process');
  let view = '';
  try { view = execFileSync(process.execPath, ['logview.mjs', 'selftest-battle'], { cwd: HERE, encoding: 'utf8' }); }
  catch (e) { view = String(e.stdout || e.message); }
  check('logview 能读出这些决策', /#\d+\s+turn \d+/.test(view));
  check('logview 打出了面板原文', /面板当时发给 Jev 的原文/.test(view));
  check('logview 打出了 Showdown 实际发生的行', /Showdown 实际发生/.test(view) && /\|move\|/.test(view));
  check('logview 打出了 Jev 的回答', /Jev 的回答/.test(view));

  console.log('\n---- logview 前 40 行 ----');
  console.log(view.split('\n').slice(0, 40).join('\n'));
} finally {
  srv.kill();
  await wait(300);
}
console.log(bad ? ('\n❌ ' + bad + ' 项失败') : '\n✅ 全部通过');
process.exit(bad ? 1 : 0);