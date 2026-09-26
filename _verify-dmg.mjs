import { loadTeamOr } from './_sample-teams.mjs';
// 伤害对拍：@smogon/calc 的预测 vs @pkmn/sim 引擎的实际伤害分布
const sim = await import('@pkmn/sim');
const { Battle, Teams } = sim;
const { loadTeam } = await import('./toolkit/tools/lib.mjs');
const { fileURLToPath } = await import('node:url');
const ROOT = fileURLToPath(new URL('./toolkit/', import.meta.url));
const A = Teams.pack(loadTeamOr(ROOT + 'teams\\ou-a.txt', 'ou-a'));       // 5=Dragapult
const B = Teams.pack(loadTeamOr(ROOT + 'teams\\opp-122866ff.txt', 'dondozo-6')); // 6=Dondozo

const pcts = [];
let misses = 0, crits = 0, runs = 120;
for (let i = 0; i < runs; i++) {
  const b = new Battle({ formatid: 'gen9ou', seed: 'sodium,' + (7000 + i) });
  b.setPlayer('p1', { team: A });
  b.setPlayer('p2', { team: B });
  if (b.p1.requestState === 'teampreview') {
    b.p1.choose('team 123456'); b.p2.choose('team 123456'); b.commitChoices();
  }
  // 回合1：双方换到 多龙巴鲁托 vs 吃吼霸
  b.p1.choose('switch 5'); b.p2.choose('switch 6'); b.commitChoices();
  if (b.ended) continue;
  const mark = b.log.length;
  // 回合2：多龙点流星群
  b.p1.choose('move dracometeor'); b.p2.autoChoose(); b.commitChoices();
  let got = null, miss = false, crit = false;
  for (const line of b.log.slice(mark)) {
    if (typeof line !== 'string') continue;
    if (line.startsWith('|-miss|p1a:')) miss = true;
    if (line.startsWith('|-crit|p2a:')) crit = true;
    const m = line.match(/^\|-damage\|p2a: Dondozo\|(\d+)\/100/);
    if (m) got = Number(m[1]);
  }
  if (miss) misses++;
  if (crit) crits++;
  if (got !== null) pcts.push(100 - got);
}
pcts.sort((x, y) => x - y);
console.log('=== @pkmn/sim 引擎实跑（' + runs + ' 次） ===');
console.log('有效命中 = ' + pcts.length + ' | 未命中 = ' + misses + ' | 击中要害 = ' + crits);
if (pcts.length) {
  const uniq = [...new Set(pcts)].sort((a, b) => a - b);
  console.log('伤害区间 = ' + pcts[0].toFixed(1) + '% - ' + pcts[pcts.length - 1].toFixed(1) + '%');
  console.log('中位数   = ' + pcts[Math.floor(pcts.length / 2)].toFixed(1) + '%');
  console.log('档位数 = ' + uniq.length + ' 档');
  console.log('最低5档: ' + uniq.slice(0, 5).map(p => p.toFixed(1)).join(', '));
  console.log('最高5档: ' + uniq.slice(-5).map(p => p.toFixed(1)).join(', '));
}
console.log('');
console.log('=== @smogon/calc 的预测 ===');
console.log('74.2% - 87.3%  (373-439 of 503)');
console.log('命中率 = 90%（120 次里实测未命中 ' + misses + ' 次 = ' + (misses / runs * 100).toFixed(1) + '%）');
