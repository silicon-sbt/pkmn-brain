import { loadTeamOr } from './_sample-teams.mjs';
// RNG 验证：命中率是否真的按 90% 走？
// 对照设计：①连续种子 vs ②混合种子 vs ③100%命中招（阴性对照）
const sim = await import('@pkmn/sim');
const { Battle, Teams } = sim;
const { loadTeam } = await import('./toolkit/tools/lib.mjs');
const { fileURLToPath } = await import('node:url');
const ROOT = fileURLToPath(new URL('./toolkit/', import.meta.url));
const A = Teams.pack(loadTeamOr(ROOT + 'teams\\ou-a.txt', 'ou-a'));
const B = Teams.pack(loadTeamOr(ROOT + 'teams\\opp-122866ff.txt', 'dondozo-6'));

function trial(seed, moveId) {
  const b = new Battle({ formatid: 'gen9ou', seed });
  b.setPlayer('p1', { team: A });
  b.setPlayer('p2', { team: B });
  if (b.p1.requestState === 'teampreview') {
    b.p1.choose('team 123456'); b.p2.choose('team 123456'); b.commitChoices();
  }
  b.p1.choose('switch 5'); b.p2.choose('switch 6'); b.commitChoices();
  if (b.ended) return null;
  const mark = b.log.length;
  b.p1.choose('move ' + moveId); b.p2.autoChoose(); b.commitChoices();
  for (const line of b.log.slice(mark)) {
    if (typeof line === 'string' && line.startsWith('|-miss|p1a:')) return 'miss';
  }
  return 'hit';
}

const N = 400;
function run(label, seedFn, moveId) {
  let miss = 0, hit = 0;
  for (let i = 0; i < N; i++) {
    const r = trial(seedFn(i), moveId);
    if (r === 'miss') miss++; else if (r === 'hit') hit++;
  }
  const total = miss + hit;
  console.log(label.padEnd(38) + ' 未命中 ' + String(miss).padStart(4) + '/' + total +
    ' = ' + (miss / total * 100).toFixed(1) + '%');
}
// 混合种子：用 4 元数组，各元素独立分布（避免连续种子的相关性）
const mix = (i) => [ (i * 2654435761) % 4294967296, (i * 40503 + 12345) % 65536,
                     (i * 2246822519) % 4294967296, (i * 3266489917) % 4294967296 ];

console.log('=== 流星群（理论命中 90%，预期未命中 10%） ===');
run('① 连续种子 sodium,7000+i', (i) => 'sodium,' + (7000 + i), 'dracometeor');
run('② 混合种子（4元数组）', mix, 'dracometeor');
console.log('');
console.log('=== 阴性对照：暗影球（理论命中 100%，预期未命中 0%） ===');
run('③ 连续种子 sodium,7000+i', (i) => 'sodium,' + (7000 + i), 'shadowball');
run('④ 混合种子（4元数组）', mix, 'shadowball');
