// 端到端自检：本地队伍这条路接进 serve.mjs 之后，真起服务 POST 一次看【黑窗口说了什么】。
//
//   node _verify-team-e2e.mjs
//
// 为什么看黑窗口而不是看返回值：队伍解析在 decide() 的最前面，Jev 在后面。
// 这里故意不配密钥（Jev 必然失败），所以 HTTP 会 500 —— 但 [队伍] 那几行早就打出来了。
// 好处：一次额度都不烧，而且测的正是「出问题时人能看到什么」。
//
// 端口用 7798，不打扰你在用的 7777。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Generations, Pokemon } from '@smogon/calc';
import { Teams, Battle } from '@pkmn/sim';
import { loadTeamOr } from './_sample-teams.mjs';

const PORT = 7798;
const g = Generations.get(9);
let bad = 0;
const check = (n, ok, extra) => { if (!ok) bad++; console.log((ok ? '  OK   ' : '  FAIL ') + n + (extra ? '   ' + extra : '')); };

const BASE = loadTeamOr(null, 'ou-c');
const pack = (sets) => Teams.pack(sets);
// ★ 真跑一局引擎，拿【引擎自己发出来的 request】当输入。
//   手写一个「看起来对」的形状曾经造成假绿：我自己写的 item 是显示名（'Rocky Helmet'），
//   引擎发的是 ID（'rockyhelmet'）—— 于是这个自检全绿，而真实的本地队伍匹配从来没生效过。
const OPP = [
  ['Corviknight @ Leftovers','Ability: Pressure','Level: 100','- Brave Bird','- Body Press','- Roost','- Iron Defense'],
  ['Great Tusk @ Leftovers','Ability: Protosynthesis','Level: 100','- Headlong Rush','- Close Combat','- Rapid Spin','- Knock Off'],
  ['Clodsire @ Leftovers','Ability: Unaware','Level: 100','- Earthquake','- Recover','- Toxic','- Stealth Rock'],
  ['Dondozo @ Leftovers','Ability: Unaware','Level: 100','- Wave Crash','- Rest','- Sleep Talk','- Curse'],
  ['Skarmory @ Rocky Helmet','Ability: Sturdy','Level: 100','- Body Press','- Roost','- Spikes','- Whirlwind'],
  ['Ting-Lu @ Leftovers','Ability: Vessel of Ruin','Level: 100','- Earthquake','- Ruination','- Stealth Rock','- Whirlwind'],
].map(l => l.join(String.fromCharCode(10))).join(String.fromCharCode(10, 10));
const _b = new Battle({ formatid: 'gen9ou', seed: [1, 2, 3, 4] });
_b.setPlayer('p1', { team: Teams.pack(BASE) });
_b.setPlayer('p2', { team: Teams.pack(Teams.import(OPP)) });
_b.makeChoices('team 123456', 'team 123456');
const reqMons = JSON.parse(JSON.stringify(_b.sides[0].activeRequest.side.pokemon));
const LOG = ['|player|p1|Me|', '|player|p2|Them|',
  '|poke|p1|Landorus-Therian|', '|poke|p2|Corviknight|',
  '|switch|p1a: Lando|Landorus-Therian, M|319/319',
  '|switch|p2a: Corv|Corviknight, M|100/100', '|turn|1'].join('\n');

const srv = spawn(process.execPath, ['serve.mjs'], {
  env: { ...process.env, JEV_PORT: String(PORT), TYPESAFE_API_KEY: '' },
  cwd: fileURLToPath(new URL('.', import.meta.url)),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let outBuf = '';
srv.stdout.on('data', d => { outBuf += String(d); });
srv.stderr.on('data', d => { outBuf += String(d); });

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/health'); if (r.ok) return true; } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}
// ⚠️ 每个用例必须用【不同的日志】：服务端现在有一道去重闸（同一份日志 + 同一个 requestType
//    在 TTL 内只问一次 Jev），四段用例共用一份日志的话，②③④ 会直接命中①的缓存、
//    队伍解析根本不会再跑一遍 —— 这个自检第一次写成这样就全红了（那一红其实证明去重是好的）。
async function post(localTeams, tag) {
  outBuf = '';
  const log = LOG + '\n|turn|' + (tag || 1);
  const body = { log, me: 'Me', request: { requestType: 'move', side: { pokemon: reqMons }, active: [{ moves: [] }] } };
  if (localTeams !== undefined) body.localTeams = localTeams;
  try {
    await fetch('http://127.0.0.1:' + PORT + '/decide', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pkmn-Brain': '1' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
  } catch (e) { /* Jev 必然失败，这里不看返回值 */ }
  await new Promise(r => setTimeout(r, 300));
  return outBuf;
}

try {
  if (!await waitUp()) throw new Error('服务没起来（端口 ' + PORT + '）');
  console.log('服务已起 :' + PORT);
  console.log('');

  console.log('① 浏览器把本地队伍发过来（其中就有这一局用的那套）');
  {
    const others = [];
    for (let i = 0; i < 20; i++) others.push({ name: '别的队' + i, packedTeam: pack(BASE.map(m => ({ ...m, item: 'Leftovers' }))) });
    others.push({ name: '就是它', packedTeam: pack(BASE) });
    const o = await post(others, 1);
    const line = (o.split('\n').find(l => l.includes('[队伍] 正在用的队')) || '').trim();
    console.log('   ' + line);
    check('黑窗口说是本地队伍、且点名了是哪一套', /本地「就是它」/.test(line) && /数值核对通过/.test(line), line.slice(0, 40));
    check('并且说清了努力值/性格是精确的', /努力值\/性格\/个体值精确/.test(line));
    const tline = (o.split('\n').find(l => l.includes('Landorus-Therian(')) || '').trim();
    check('逐只一行里【没有】⚠️ 标记（说明全走的是本地精确值）', !!tline && !tline.includes('⚠️'), tline.slice(0, 90));
  }

  console.log('');
  console.log('② 浏览器拿不到本地队伍（PS.teams 没有 / 脚本没重装）');
  {
    const o = await post(undefined, 2);
    const line = (o.split('\n').find(l => l.includes('[队伍] 正在用的队')) || '').trim();
    console.log('   ' + line);
    check('退回反解，并且【大声说明】为什么没用本地', /request 反解/.test(line) && /本地队伍没用上/.test(line) && /没送来/.test(line), line.slice(0, 50));
  }

  console.log('');
  console.log('③ 本地有一套「同特征、只有努力值不同」的孪生队，但这一局用的不是它');
  {
    const twin = BASE.map((m, k) => ({ ...m, nature: k % 2 ? 'Adamant' : 'Bold',
      evs: { hp: 0, atk: 0, def: 252, spa: 0, spd: 4, spe: 252 } }));
    const o = await post([{ name: '孪生队', packedTeam: pack(twin) }], 3);
    const line = (o.split('\n').find(l => l.includes('[队伍] 正在用的队')) || '').trim();
    console.log('   ' + line);
    check('没拿错队污染伤害（退回反解）', /request 反解/.test(line));
    check('并且明说「不是这一局用的队」', /不是】这一局用的队/.test(line), line.slice(0, 60));
  }

  console.log('');
  console.log('④ 本地队伍里有解不开的条目 → 要数出来');
  {
    const o = await post([{ name: '好的', packedTeam: pack(BASE) }, { name: '坏的', packedTeam: 'garbage!!' }], 4);
    const line = (o.split('\n').find(l => l.includes('解不开')) || '').trim();
    console.log('   ' + line);
    check('坏条目被数出来并打到黑窗口', /有 1 套解不开/.test(line), line);
  }
  console.log('');
  console.log('⑤ 同一份日志被重复发（浏览器那侧去重失效时的兜底）');
  {
    const o1 = await post([{ name: '就是它', packedTeam: pack(BASE) }], 9);
    const o2 = await post([{ name: '就是它', packedTeam: pack(BASE) }], 9);   // 完全同一份日志
    check('第二次真的命中了服务端去重', /\[去重\]/.test(o2), (o2.split('\n').find(l => l.includes('[去重]')) || '(没有去重行)').trim());
    check('第一次没有被去重', !/\[去重\]/.test(o1));
  }
} finally {
  srv.kill();
}

console.log('');
console.log(bad ? bad + ' 项失败' : '全部通过');
process.exit(bad ? 1 : 0);
