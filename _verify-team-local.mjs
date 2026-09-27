// 自检：本地队伍匹配（team-local.mjs）。不联网、不调 Jev。
//
//   node _verify-team-local.mjs
//
// 要证明的：
//   ① 唯一解 + 数值核对通过 → 直取，努力值/性格精确
//   ② 多套撞车 → 用对局数值消歧，取到对的那一套
//   ③ 等价多解（数值完全一样）不算失败
//   ④ ★「只有努力值不同的孪生队」【不能】被当成这一局用的队（数值核对要拦住它）
//   ⑤ 没匹配上 / 列表为空 → sets=null 且 why 非空（不许静默）
//   ⑥ 解不开的队伍要数出来
//   ⑦ 形态变化（request 物种 ≠ 本地物种）→ 放宽到基础形态仍能匹配
//   ⑧ 数值模型不兼容（L50/Champions）→ 唯一解仍然用，多解则拒绝
//   ⑨ 真收益：HP 有努力值的那只，本地匹配拿得到，反解拿不到
import { Generations, Pokemon, Move, calculate } from '@smogon/calc';
import { Teams, Battle } from '@pkmn/sim';
import { pickLocalTeam, alignLocal } from './team-local.mjs';
import { setFromRequest } from './serve.mjs';
import { loadTeamOr } from './_sample-teams.mjs';

const g = Generations.get(9);
const NAT = ['Jolly', 'Timid', 'Bold', 'Adamant', 'Modest', 'Impish', 'Careful', 'Calm', 'Naive', 'Hasty'];
let bad = 0;
const check = (n, ok, extra) => { if (!ok) bad++; console.log((ok ? '  OK   ' : '  FAIL ') + n + (extra ? '   ' + extra : '')); };

const BASE = loadTeamOr(null, 'ou-c');
const team = (name, sets) => ({ name, format: '[Gen 9] OU', packedTeam: Teams.pack(sets) });

// ★★ 真跑一局引擎，把【引擎自己发出来的 request.side.pokemon[]】拿回来当输入。★★
//   上一版这里是手写的 {item: s.item, ability: s.ability, moves: s.moves} —— 恰好写成了
//   【显示名】（'Rocky Helmet'），而引擎发的是【ID】（'rockyhelmet'）。
//   于是本地队伍这条路在实战里从来没生效过（用户实测报「用的队伍在本地是有的」），
//   而自检全绿。教训：**自检的输入必须来自被测系统本身，不能自己捏一个「看起来对」的形状。**
const OPP = [
  ['Corviknight @ Leftovers','Ability: Pressure','Level: 100','- Brave Bird','- Body Press','- Roost','- Iron Defense'],
  ['Great Tusk @ Leftovers','Ability: Protosynthesis','Level: 100','- Headlong Rush','- Close Combat','- Rapid Spin','- Knock Off'],
  ['Clodsire @ Leftovers','Ability: Unaware','Level: 100','- Earthquake','- Recover','- Toxic','- Stealth Rock'],
  ['Dondozo @ Leftovers','Ability: Unaware','Level: 100','- Wave Crash','- Rest','- Sleep Talk','- Curse'],
  ['Skarmory @ Rocky Helmet','Ability: Sturdy','Level: 100','- Body Press','- Roost','- Spikes','- Whirlwind'],
  ['Ting-Lu @ Leftovers','Ability: Vessel of Ruin','Level: 100','- Earthquake','- Ruination','- Stealth Rock','- Whirlwind'],
].map(l => l.join(String.fromCharCode(10))).join(String.fromCharCode(10, 10));

function reqOf(sets, { dead = [], level = 100 } = {}) {
  const use = sets.map(s => ({ ...s, level: s.level || level }));
  const b = new Battle({ formatid: 'gen9ou', seed: [1, 2, 3, 4] });
  b.setPlayer('p1', { team: Teams.pack(use) });
  b.setPlayer('p2', { team: Teams.pack(Teams.import(OPP)) });
  b.makeChoices('team 123456', 'team 123456');
  const mons = JSON.parse(JSON.stringify(b.sides[0].activeRequest.side.pokemon));
  for (const m of mons) if (dead.includes(String(m.details || '').split(',')[0].trim())) m.condition = '0 fnt';
  return mons;
}
// 同特征、不同努力值的孪生队（物种/道具/特性/招式全一样）
function twin(i) {
  return BASE.map((m, k) => {
    const seed = (i * 7 + k * 13) % 97;
    const evs = { hp: (seed % 5) * 52, atk: ((seed >> 1) % 5) * 52, def: ((seed >> 2) % 3) * 84,
      spa: ((seed >> 3) % 3) * 84, spd: ((seed >> 4) % 4) * 60, spe: ((seed >> 5) % 5) * 52 };
    let tot = Object.values(evs).reduce((a, b) => a + b, 0);
    while (tot > 508) { const k2 = ['hp','atk','def','spa','spd','spe'].find(x => evs[x] >= 4); evs[k2] -= 4; tot -= 4; }
    return { ...m, nature: NAT[(i + k) % NAT.length], evs };
  });
}
const sameNums = (a, b) => ['hp','atk','def','spa','spd','spe'].every(k => (a[k] || 0) === (b[k] || 0));

console.log('① 唯一解：本地 60 套里只有 1 套特征相符');
{
  const list = [];
  for (let i = 0; i < 59; i++) list.push(team('别的队' + i, BASE.map((m, k) => k === 0 ? { ...m, item: 'Leftovers' } : m)));
  list.push(team('就是它', BASE));
  const r = pickLocalTeam(list, reqOf(BASE));
  check('取到了队并标成数值核对通过', r.sets && /local-数值核对通过/.test(r.source || ''), r.source || r.why);
  check('选对了是哪一套', r.picked === '就是它', String(r.picked));
  const merged = alignLocal(r.sets, reqOf(BASE));
  check('6 只全部对上（没有 _localHit=false）', merged.every(x => x._localHit));
  check('努力值精确', merged.every((x, i) => sameNums(x.evs, BASE[i].evs)));
  check('物种/道具/招式取 request 那一侧（权威）',
    merged.every((x, i) => x.moves.join() === BASE[i].moves.join() && x.item === BASE[i].item));
}

console.log('');
console.log('② 多套撞车（60 套全部同特征）→ 用对局数值消歧');
{
  const list = [];
  for (let i = 0; i < 60; i++) list.push(team('team-' + i, i === 37 ? BASE : twin(i)));
  const r = pickLocalTeam(list, reqOf(BASE));
  check('报告了 60 套撞车', r.candidates.length === 60, String(r.candidates.length));
  check('取到正确的那一套', r.picked === 'team-37', String(r.picked));
  check('来源标成数值核对通过(60套撞车)', /数值核对通过\(60套撞车\)/.test(r.source || ''), String(r.source));
  const merged = alignLocal(r.sets, reqOf(BASE));
  check('努力值与性格都精确', merged.every((x, i) => sameNums(x.evs, BASE[i].evs) && x.nature === BASE[i].nature));
}

console.log('');
console.log('③ 等价多解：两套数值完全相同 ⇒ 不算失败');
{
  const r = pickLocalTeam([team('a', BASE), team('b', BASE)], reqOf(BASE));
  check('取到了队', !!r.sets, r.source || r.why);
  check('标成等价多解', r.equivalent === true && /等价多解/.test(r.source || ''), String(r.source));
}

console.log('');
console.log('④ ★孪生队不能冒充：本地只有一套「同特征、不同努力值」的队，而这一局用的不是它');
{
  const r = pickLocalTeam([team('孪生队', twin(3))], reqOf(BASE));
  check('拒绝（sets=null），不拿错队污染伤害', r.sets === null, r.source || ('why=' + r.why));
  check('why 说清了「不是这一局用的队」', /不是】这一局用的队/.test(r.why || ''), String(r.why).slice(0, 70));
}

console.log('');
console.log('⑤ 匹配不上 / 列表为空 —— sets=null 且 why 非空（不许静默）');
{
  const noMatch = team('无关队', BASE.map(m => ({ ...m, moves: m.moves.slice(0, 3) })));
  const r1 = pickLocalTeam([noMatch], reqOf(BASE));
  check('特征都不符时 sets=null', r1.sets === null);
  check('why 提到特征不符', /没有和第 1 段特征/.test(r1.why || ''), String(r1.why).slice(0, 60));
  const r2 = pickLocalTeam([], reqOf(BASE));
  check('列表为空时 sets=null', r2.sets === null);
  check('why 提到浏览器没送来', /没送来/.test(r2.why || ''), String(r2.why).slice(0, 60));
  const r3 = pickLocalTeam(null, reqOf(BASE));
  check('整个字段缺失也不炸', r3.sets === null && !!r3.why);
}

console.log('');
console.log('⑥ 解不开的队伍要数出来');
{
  const list = [team('好的', BASE), { name: '坏1', packedTeam: '!notloaded' },
    { name: '坏2', packedTeam: 'garbage!!' }, { name: '空', packedTeam: '' }];
  const r = pickLocalTeam(list, reqOf(BASE));
  check('坏的都被数出来（broken=3）', r.broken === 3, 'broken=' + r.broken);
  check('好的那套照样命中', r.picked === '好的', String(r.picked));
}

console.log('');
console.log('⑦ 形态变化：request 的物种和本地存的对不上 → 放宽到基础形态');
{
  const req = reqOf(BASE);
  const idx = req.findIndex(m => /Ogerpon/.test(m.details));
  req[idx].details = 'Ogerpon-Wellspring-Tera, F';
  const r = pickLocalTeam([team('我的队', BASE)], req);
  check('放宽后仍然匹配到', !!r.sets, r.source || r.why);
  check('标注了放宽形态', /放宽形态/.test(r.source || ''), String(r.source));
}

console.log('');
console.log('⑧ 数值模型不兼容（L50 / Champions 的数值系统）');
{
  const l50 = BASE.map(m => ({ ...m, level: 50 }));
  const r = pickLocalTeam([team('VGC队', l50)], reqOf(l50, { level: 50 }));
  check('L50 唯一解照样核对通过（calc 本身支持 L50）', /数值核对通过/.test(r.source || ''), r.source || r.why);
  const merged = alignLocal(r.sets, reqOf(l50, { level: 50 }));
  check('L50 努力值精确', merged.every((x, i) => sameNums(x.evs, l50[i].evs)));
  // 注入「数值算不出来」的 stub，模拟 Champions：核对失效
  const broken = (set, level) => { throw new Error('这个规则的数值算不出来'); };
  const r2 = pickLocalTeam([team('Champions队', BASE)], reqOf(BASE), { statsLine: broken, modelFits: () => false });
  check('核对失效时，唯一解仍然采用（比反解强）', !!r2.sets && /数值无法核对/.test(r2.source || ''), r2.source || r2.why);
  const r3 = pickLocalTeam([team('x', BASE), team('y', BASE)], reqOf(BASE), { statsLine: broken, modelFits: () => false });
  check('核对失效且多解 → 拒绝，不瞎猜', r3.sets === null && !!r3.why, String(r3.why).slice(0, 60));
}

console.log('');
console.log('⑨ 真收益：HP 有努力值的那只（Hatterene 252HP），它倒下了 ⇒ condition = "0 fnt"');
{
  const hat = BASE.find(m => /Hatterene/.test(m.species));
  const req = reqOf(BASE, { dead: [hat.species] });
  const r = pickLocalTeam([team('我的队', BASE)], req);
  const byLocal = alignLocal(r.sets, req).find(x => x.species === hat.species);
  const byReverse = setFromRequest(req.find(m => /Hatterene/.test(m.details)));
  const hpLocal = new Pokemon(g, hat.species, { level: 100, nature: byLocal.nature, evs: byLocal.evs }).stats.hp;
  const hpRev = new Pokemon(g, hat.species, { level: 100, nature: byReverse.nature, evs: byReverse.evs }).stats.hp;
  const hpTrue = new Pokemon(g, hat.species, { level: 100, nature: hat.nature, evs: hat.evs }).stats.hp;
  console.log('   真实 ' + hat.evs.hp + 'HP努力值 / 最大血 ' + hpTrue);
  console.log('   反解 → hp努力值 ' + (byReverse.evs.hp || 0) + '，最大血 ' + hpRev + '   [' + byReverse._exactSource + ']');
  console.log('   本地 → hp努力值 ' + (byLocal.evs.hp || 0) + '，最大血 ' + hpLocal);
  check('本地拿到正确最大血；反解拿到的是错的（这就是要做的理由）',
    hpLocal === hpTrue && hpRev !== hpTrue, hpLocal + ' vs ' + hpRev);
}

console.log('');
console.log('⑩ 交给 calc 的字段必须是【显示名】—— 给 ID 会被静默忽略');
{
  // 实测：new Pokemon(g,'Kyurem',{item:'choicespecs'}) 和「不给道具」算出同一个数（163 vs 244）。
  // 也就是本地队伍这条路一旦把 request 的原始 ID 直接透下去，我们全队的道具会被无声忽略。
  // （serve.mjs 的 setFromRequest 一直是转的，alignLocal 当初漏了。）
  const req = reqOf(BASE);
  const merged = alignLocal(pickLocalTeam([team('我的队', BASE)], req).sets, req);
  const ky = merged.find(x => /Kyurem/.test(x.species));
  check('道具是显示名不是 ID', ky.item === 'Choice Specs', String(ky.item));
  check('招式是显示名不是 ID', ky.moves.includes('Ice Beam'), (ky.moves || []).join('/'));
  check('特性是显示名不是 ID', ky.ability === 'Pressure', String(ky.ability));
  const foe = new Pokemon(g, 'Garganacl', { level: 100 });
  const num = (item) => calculate(g, new Pokemon(g, 'Kyurem', {
    level: 100, nature: ky.nature, evs: ky.evs, ability: ky.ability, item }), foe, new Move(g, 'Ice Beam')).damage[1];
  check('calc 真的把道具算进去了（ID 会让它等于不带道具）', num(ky.item) > num('choicespecs'),
    num(ky.item) + ' vs ' + num('choicespecs'));
}

console.log('');
console.log('⑪ 道具在对局中途被消耗掉 —— 仍然要认得出这套队');
{
  // 实测（battle-20260927-123200）：铁辙迹是首发，它的【驱动能量在换上场那一瞬间就被消耗】，
  // 引擎的 request 里 item 直接变成 ""。第一版把道具当硬条件 ⇒
  // teampreview 那次还能匹配（道具还在），从 t1 起整局都匹配不上 —— 日志里正好就是这个形状。
  // 别的会变的情况：结实/披带/树果被消耗、被拍落/掉包偷走、戏法交换。
  // ⚠️ 驱动能量只有【古代活性/夸克充能】持有者才会消耗，而且换上场那一瞬间就消耗了 ⇒
  //    必须把它放在【首发】位置，否则它还没上场、item 还是满的（第一次写就踩了这个）。
  const it = BASE.find(m => /Iron Treads/.test(m.species));
  const withBooster = [{ ...it, item: 'Booster Energy' }]
    .concat(BASE.filter(m => !/Iron Treads/.test(m.species)));
  const b = new Battle({ formatid: 'gen9ou', seed: [1, 2, 3, 4] });
  b.setPlayer('p1', { team: Teams.pack(withBooster) });
  b.setPlayer('p2', { team: Teams.pack(Teams.import(OPP)) });
  b.makeChoices('team 123456', 'team 123456');   // 铁辙迹是首发 ⇒ 驱动能量当场消耗
  const mons = JSON.parse(JSON.stringify(b.sides[0].activeRequest.side.pokemon));
  const anyEmpty = mons.some(m => !m.item);
  check('（前提）对局里确实有道具变成空的了', anyEmpty, mons.map(m => m.item || '空').join(','));
  const r = pickLocalTeam([{ name: '我的队', packedTeam: Teams.pack(withBooster) }], mons);
  check('道具被消耗之后仍然认得出', !!r.sets, r.source || r.why);
  check('来源是数值核对通过', /数值核对通过/.test(r.source || ''), String(r.source));
  // 反面：两组队只差道具时，仍然优先挑对得上的那套
  const other = withBooster.map(m => /Iron Treads/.test(m.species) ? { ...m, item: 'Leftovers' } : m);
  const r2 = pickLocalTeam(
    [{ name: '道具不同的队', packedTeam: Teams.pack(other) },
     { name: '道具对的队', packedTeam: Teams.pack(withBooster) }], mons);
  check('特征相同的两套里，道具对得上的那套被优先选中', r2.picked === '道具对的队', String(r2.picked));
}

console.log('');
console.log(bad ? bad + ' 项失败' : '全部通过');
process.exit(bad ? 1 : 0);
