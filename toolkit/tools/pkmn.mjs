#!/usr/bin/env node
// 宝可梦对战工具箱 CLI —— 全离线运行，支持中文名
// dex | move | set | calc | speed | team | sim | formats
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseImportable, loadTeam, runBattle, zhToEn, enToZh, zhInfo, damageRolls, finalSpeed, whoMovesFirst,
  paradoxMult, PARADOX_MULT } from './lib.mjs';
import { resolveEngine, listFormats, loadShowdown } from './engine.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const { values, positionals } = parseArgs({
  args: argv.slice(1), allowPositionals: true,
  options: {
    attacker: { type: 'string' }, defender: { type: 'string' },
    'attacker-file': { type: 'string' }, 'defender-file': { type: 'string' },
    move: { type: 'string' }, p1: { type: 'string' }, p2: { type: 'string' },
    format: { type: 'string', default: 'gen9customgame' },
    n: { type: 'string', default: '1' }, seed: { type: 'string' },
    field: { type: 'string' }, doubles: { type: 'boolean', default: false },
    scarf: { type: 'string' }, tailwind: { type: 'string' }, para: { type: 'string' },
    // 速度修正：配置里本来就有的（围巾/天气特性）现在自动读，这几个是【额外假设】
    weather: { type: 'string' }, booster: { type: 'string' },
    'boost-p1': { type: 'string' }, 'boost-p2': { type: 'string' },
    // 戏法空间：反转先后（慢的先动）。先制等级仍然优先，只比速度。
    'trick-room': { type: 'boolean', default: false },
    // 古代活性/夸克充能【提的是哪一项】：'atk'|'def'|'spa'|'spd'|'spe'（calc 不建，自己乘）
    'paradox-p1': { type: 'string' }, 'paradox-p2': { type: 'string' },
    engine: { type: 'string', default: 'auto' },
    zh: { type: 'boolean', default: false },
  },
});
const out = (o) => console.log(JSON.stringify(o, null, 2));
const fail = (m) => { console.error(JSON.stringify({ error: m })); process.exit(1); };
const isDoubles = () => values.doubles || /doubles|vgc/i.test(values.format || '') || values.field === 'doubles';
// 中文字段：名称 + shortDesc/desc（来自 PS 官方中文数据）
const zhFields = (kind, en, withDesc = true) => {
  const i = zhInfo(kind, en);
  const o = { nameZh: i.zh };
  if (withDesc && i.shortDesc) o.shortDescZh = i.shortDesc;
  if (withDesc && i.desc && i.desc !== i.shortDesc) o.descZh = i.desc;
  return o;
};

// 把"物种名（含中文）"或"单只配置文件"变成 calc 的 Pokemon
async function toCalcPokemon({ name, file }) {
  const { Pokemon, Generations } = await import('@smogon/calc');
  const g = Generations.get(9);
  if (file) {
    const sets = parseImportable(readFileSync(file, 'utf8'));
    if (!sets.length) fail('empty set file: ' + file);
    const s = sets[0];
    return new Pokemon(g, s.species, { level: s.level, ability: s.ability, item: s.item, nature: s.nature, evs: s.evs, ivs: s.ivs, teraType: s.teraType });
  }
  if (!name) fail('need --attacker/--defender or --attacker-file/--defender-file');
  const en = zhToEn('species', name);           // 中文/俗称 -> 英文
  const { Dex } = await import('@pkmn/dex');
  if (!Dex.species.get(en).exists) fail('未知宝可梦: ' + name + '（多词英文名请加引号）');
  return new Pokemon(g, en);
}

if (cmd === 'dex') {
  const { Dex } = await import('@pkmn/dex');
  const raw = positionals.join(' ');
  const en = zhToEn('species', raw);
  const s = Dex.species.get(en);
  if (!s.exists) fail('未知宝可梦: ' + raw);
  const abilitiesZh = Object.fromEntries(Object.entries(s.abilities).map(([k, v]) => [k, enToZh('abilities', v)]));
  out({ name: s.name, ...zhFields('species', s.name, false), types: s.types, typesZh: s.types.map(t => enToZh('types', t)),
        baseStats: s.baseStats, abilities: s.abilities, abilitiesZh, weightkg: s.weightkg, tier: s.tier });
} else if (cmd === 'ability') {
  const { Dex } = await import('@pkmn/dex');
  const raw = positionals.join(' ');
  const ab = Dex.abilities.get(zhToEn('abilities', raw));
  if (!ab.exists) fail('未知特性: ' + raw);
  out({ name: ab.name, ...zhFields('abilities', ab.name), rating: ab.rating,
        shortDesc: ab.shortDesc, desc: ab.desc });
} else if (cmd === 'item') {
  const { Dex } = await import('@pkmn/dex');
  const raw = positionals.join(' ');
  const it = Dex.items.get(zhToEn('items', raw));
  if (!it.exists) fail('未知道具: ' + raw);
  out({ name: it.name, ...zhFields('items', it.name), shortDesc: it.shortDesc, desc: it.desc });
} else if (cmd === 'move') {
  const { Dex } = await import('@pkmn/dex');
  const raw = positionals.join(' ');
  const en = zhToEn('moves', raw);
  const m = Dex.moves.get(en);
  if (!m.exists) fail('未知招式: ' + raw);
  out({ name: m.name, ...zhFields('moves', m.name), type: m.type, category: m.category,
        basePower: m.basePower, accuracy: m.accuracy, priority: m.priority, pp: m.pp, shortDesc: m.shortDesc });
} else if (cmd === 'set') {
  out({ count: parseImportable(readFileSync(positionals[0], 'utf8')).length, sets: parseImportable(readFileSync(positionals[0], 'utf8')) });
} else if (cmd === 'calc') {
  const { calculate, Move, Field } = await import('@smogon/calc');
  const { Generations } = await import('@smogon/calc');
  const g = Generations.get(9);
  const atk = await toCalcPokemon({ name: values.attacker, file: values['attacker-file'] });
  const def = await toCalcPokemon({ name: values.defender, file: values['defender-file'] });
  const moveEn = zhToEn('moves', values.move);
  const f = new Field({ gameType: isDoubles() ? 'Doubles' : 'Singles' });
  const res = calculate(g, atk, def, new Move(g, moveEn), f);
  // ★ 古代活性 / 夸克充能（含驱动能量）：@smogon/calc 完全没建（实测四种写法伤害一模一样）。
  //   倍率与「提的是哪一项」都走 lib.mjs（和 brain 的同一份），这里只把命令行给的两项传进去。
  //   不给 --paradox-pN 就是 1.0 —— 代码不猜「它多半提了攻」，猜出来的数字是假事实。
  const pm = paradoxMult(values['paradox-p1'] || null, values['paradox-p2'] || null,
    moveEn, new Move(g, moveEn).category);
  // ★ 多段招的 damage 是二维数组（外层=第几下）。直接 Math.max 会 NaN，
  //   而 flat() 会静默给你【单下】的区间（种子机关枪被报成 72-86，真实是 216-258）。
  const raw = damageRolls(res);
  const scale = (r) => pm === 1 ? r : [Math.round(r[0] * pm), Math.round(r[1] * pm)];
  const { total: _t, perHit: _p } = raw;
  const { multiHit, hits, groups } = raw;
  const total = scale(_t), perHit = scale(_p);
  const hp = def.stats.hp;
  const ko = res.kochance();
  const pc = (x) => (x / hp * 100).toFixed(1) + '%';
  out({
    // ⚠️ res.desc() 是 calc 的【原始】文案，它【不含】古代活性/夸克充能。
    //   缩放之后还照抄它会得到两个互相矛盾的数字（desc 58-69 / damage 75-90）——
    //   数字离开口径就是假事实，所以这里必须把口径钉在 desc 上。
    desc: pm === 1 ? res.desc() : res.desc() + '  ←【这一行是 calc 原始文案，未含古代活性/夸克充能，以 damage/percent 为准】',
    gameType: isDoubles() ? 'Doubles' : 'Singles',
    attackerHp: atk.stats.hp, defenderHp: hp,
    damage: total,
    percent: [pc(total[0]), pc(total[1])],
    koChance: ko.text || (ko.chance + '%'),
    // 多段招另给口径：总伤害 vs 单下。别把单下当总伤害用。
    ...(multiHit ? { multiHit: true, hits, perHitDamage: perHit,
      perHitPercent: [pc(perHit[0]), pc(perHit[1])],
      note: '多段招：damage/percent 是【' + hits + ' 下的合计】；命中数本身可变时（种子机关枪 2-5 下）这也是估算',
      byHit: groups } : {}),
    rolls: total,
    ...(pm !== 1 ? { paradoxMult: Number(pm.toFixed(5)),
      paradoxNote: '已按古代活性/夸克充能 ×' + PARADOX_MULT.toFixed(5) + '（引擎 chainModify([5325,4096])）' +
        '缩放：--paradox-p1=' + (values['paradox-p1'] || '-') + ' --paradox-p2=' + (values['paradox-p2'] || '-') +
        '。⚠️ calc 本身完全不建这个特性，不给参数就是 ×1 —— 别把没乘的数当准数。' } : {}),
  });
} else if (cmd === 'speed') {
  const { Generations } = await import('@smogon/calc');
  const g = Generations.get(9);
  const mk = (name, file) => toCalcPokemon({ name, file });
  const a = await mk(values.attacker, values['attacker-file']);
  const b = await mk(values.defender, values['defender-file']);
  // ★ 修正来源【三处都要看】：①配置里本来就有的道具/特性 ②命令行开关 ③能力等级。
  //   以前只认命令行开关，于是队文件里写着 @ Choice Scarf 也被无视 ——
  //   实测报出「Iron Valiant 更快」而围巾土地云其实是 463 > 364，直接答反。
  const flag = (v, tag) => !!(v && String(v).split(',').includes(tag));
  const mod = (p, tag, boost) => finalSpeed(p, {
    tailwind: flag(values.tailwind, tag), para: flag(values.para, tag),
    weather: values.weather || null, boost: boost || 0,
    // --scarf 仍然保留：用于「对手可能是围巾」这类【不属于本配置】的假设
    item: flag(values.scarf, tag) ? 'Choice Scarf' : undefined,
    booster: flag(values.booster, tag),
  });
  const boostOf = (v) => Number(v || 0);
  const A = mod(a, 'p1', boostOf(values['boost-p1'])), B = mod(b, 'p2', boostOf(values['boost-p2']));
  const tr = !!values['trick-room'];
  const speedOrder = whoMovesFirst(A.effective, B.effective);          // 只按速度
  const faster = whoMovesFirst(A.effective, B.effective, { trickRoom: tr });
  out({ p1: A, p2: B,
    faster,
    // 两个都给出：speedOrder 是不带戏法空间的原始快慢，方便对照
    speedOrder,
    trickRoom: tr || undefined,
    note: 'effective 已含配置里的讲究围巾/天气特性；opts 里含 --scarf/--tailwind/--para/--weather/--booster/--boost-pN'
      + (tr ? '；已按【戏法空间】反转先后（慢的先动）—— 注意【先制招仍然优先】，这里只比速度，别拿它跨优先级用' : '') });
} else if (cmd === 'team') {
  const team = loadTeam(positionals[0]);
  const { sim, name } = await resolveEngine({ format: values.format, engine: values.engine });
  const v = sim.TeamValidator.get(values.format);
  if (!v) fail('未知格式: ' + values.format + '（用 node tools/pkmn.mjs formats 查看）');
  const problems = v.validateTeam(loadTeam(positionals[0])) || [];
  // 必须两边都校验：pokemon-showdown 的校验器更严格，会执行 @pkmn/sim 漏掉的规则
  // （实测：Slowking-Galar 的 Scald 是 Gen8 来源，sim 判通过、PS 判非法）。
  // 只信一个校验器会给出【假的 OK】。
  let strict = [];
  let strictUsed = null;
  try {
    const PS = await loadShowdown();
    if (PS !== sim) {
      const v2 = PS.TeamValidator.get(values.format);
      if (v2) { strictUsed = 'showdown'; strict = v2.validateTeam(loadTeam(positionals[0])) || []; }
    }
  } catch (e) { /* pokemon-showdown 不可用时跳过 */ }
  const onlyStrict = strict.filter(p => !problems.includes(p));
  out({
    format: values.format, engine: name, gameType: v.format.gameType, count: team.length,
    problems: problems.length ? problems : 'OK',
    strictValidator: strictUsed || '(与主校验器相同)',
    strictProblems: onlyStrict.length ? onlyStrict : 'OK',
    verified: problems.length === 0 && onlyStrict.length === 0,
  });
} else if (cmd === 'sim') {
  const { sim, name } = await resolveEngine({ format: values.format, engine: values.engine });
  const p1 = loadTeam(values.p1), p2 = loadTeam(values.p2);
  const n = Math.max(1, Number(values.n));
  const results = [];
  for (let i = 0; i < n; i++) {
    const seed = values.seed ? values.seed.split(',').map(Number)
      : [1 + i * 7919 % 65536, 2 + i * 104729 % 65536, 3 + i * 15485863 % 65536, 4 + i * 32452843 % 65536];
    results.push(await runBattle(sim, p1, p2, values.format, seed));
  }
  const wins = results.filter(r => r.winner === 'Player 1').length;
  const losses = results.filter(r => r.winner === 'Player 2').length;
  out({ format: values.format, engine: name, gameType: isDoubles() ? 'doubles' : 'singles', games: n,
        p1Wins: wins, p2Wins: losses, undecided: n - wins - losses,
        p1WinRate: ((wins / n) * 100).toFixed(1) + '%',
        avgTurns: (results.reduce((a, r) => a + r.turn, 0) / n).toFixed(1),
        stalled: results.filter(r => r.stalled).length,
        sampleErrors: results.flatMap(r => r.errors).slice(0, 5) });
} else if (cmd === 'formats') {
  out(await listFormats(positionals[0]));
} else {
  console.log(`用法: node tools/pkmn.mjs <dex|move|set|calc|speed|team|sim|formats>

  dex   <名称>                             种族值/属性/特性（支持中文，如 耿鬼）
  move  <名称>                             招式资料（支持中文，如 地震）
  ability <名称>                           特性资料（支持中文，如 威吓）
  item  <名称>                             道具资料（支持中文，如 剩饭）
  set   <队伍文件>                         解析 importable 队伍（支持中文队伍文本）
  calc  --attacker X --defender Y --move Z 伤害计算（支持中文；双打加 --doubles）
  speed --attacker X --defender Y          速度对比（--scarf p1 --tailwind p2 --para p1 --trick-room）
                                             ⚠️ 冻风/电网这类【降速招】用 --boost-p2 -1 表达
                                             ⚠️ --trick-room 只反转速度先后，先制招仍然优先
  team  <队伍文件> --format <格式>         队伍合法性校验
  sim   --p1 a.txt --p2 b.txt --n 100      蒙特卡洛胜率
  formats [关键词]                         列出可用对战格式（两个引擎合并）

  双引擎: 格式含 champions 自动走 pokemon-showdown，其余走 @pkmn/sim。
          可用 --engine sim|showdown 强制指定。

  常用格式: gen9customgame(单打) / gen9ou(单打Lv100) /
            gen9doublescustomgame(双打) / gen9vgc2025regi(VGC双打Lv50) /
            gen9championsvgc2026regmb(Champions VGC 2026 双打,需 showdown)
  多词英文名请加引号: --defender "Flutter Mane"`);
}
