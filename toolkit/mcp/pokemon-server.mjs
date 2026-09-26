#!/usr/bin/env node
// 项目级宝可梦 MCP 服务器（stdio）
// 类型化参数避免 shell 引号问题（如 "Flutter Mane" 被拆成两个参数），并支持中文名。
// 通过 MCP 客户端以 stdio 挂载（DSH / Claude 等的配置片段见 README），工具名形如 mcp__pokemon__calc
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { parseImportable, loadTeam, runBattle, zhToEn, enToZh, zhInfo, damageRolls, finalSpeed } from '../tools/lib.mjs';
import { resolveEngine } from '../tools/engine.mjs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const text = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 2) }] });
const DOUBLES = /doubles|vgc/i;
const zhFields = (kind, en, withDesc = true) => {
  const i = zhInfo(kind, en);
  const o = { nameZh: i.zh };
  if (withDesc && i.shortDesc) o.shortDescZh = i.shortDesc;
  if (withDesc && i.desc && i.desc !== i.shortDesc) o.descZh = i.desc;
  return o;
};

async function buildPokemon(input) {
  const { Pokemon, Generations } = await import('@smogon/calc');
  const gen = Generations.get(9);
  const isBlock = /\n/.test(input) || /:\s/.test(input);
  if (!isBlock) return new Pokemon(gen, zhToEn('species', input.trim()));
  const set = parseImportable(input)[0];
  if (!set) throw new Error('无法解析配置文本');
  return new Pokemon(gen, set.species, {
    level: set.level, ability: set.ability, item: set.item, nature: set.nature,
    evs: set.evs, ivs: set.ivs, teraType: set.teraType,
  });
}
async function calc(input, defender, moveName, doubles) {
  const { calculate, Move, Field, Generations } = await import('@smogon/calc');
  const g = Generations.get(9);
  const a = await buildPokemon(input), d = await buildPokemon(defender);
  const res = calculate(g, a, d, new Move(g, zhToEn('moves', moveName)), new Field({ gameType: doubles ? 'Doubles' : 'Singles' }));
  // ★ 多段招的 damage 是二维数组（外层=第几下）。Math.max 会 NaN，
  //   而 flat() 会静默给你【单下】的区间（种子机关枪报成 72-86，真实 216-258）。
  const { total, perHit, multiHit, hits } = damageRolls(res);
  const hp = d.stats.hp;
  const pc = (x) => (x / hp * 100).toFixed(1) + '%';
  return {
    desc: res.desc(), gameType: doubles ? 'Doubles' : 'Singles', defenderHp: hp,
    damage: total, percent: [pc(total[0]), pc(total[1])],
    koChance: res.kochance().text || res.kochance().chance + '%',
    ...(multiHit ? { multiHit: true, hits, perHitDamage: perHit,
      perHitPercent: [pc(perHit[0]), pc(perHit[1])],
      note: 'damage/percent 是 ' + hits + ' 下的合计' } : {}),
    rolls: total,
  };
}
function tmpTeam(txt, tag) {
  const dir = mkdtempSync(join(tmpdir(), 'pkmn-'));
  const f = join(dir, tag + '.txt');
  writeFileSync(f, txt, 'utf8');
  return f;
}

const TOOLS = [
  { name: 'dex', description: '查宝可梦种族值/属性/特性。支持中文名（如 耿鬼）或英文官方名',
    inputSchema: { type: 'object', properties: { species: { type: 'string', description: '如 "耿鬼" 或 "Gengar"' } }, required: ['species'] } },
  { name: 'move', description: '查招式威力/属性/分类/PP/优先度。支持中文名（如 地震）',
    inputSchema: { type: 'object', properties: { move: { type: 'string' } }, required: ['move'] } },
  { name: 'ability', description: '查特性效果（中文名可，如 威吓）。返回中文 shortDesc/desc —— 别凭记忆讲特性效果，用它查',
    inputSchema: { type: 'object', properties: { ability: { type: 'string' } }, required: ['ability'] } },
  { name: 'item', description: '查对战道具效果（中文名可，如 剩饭）。返回中文 shortDesc/desc',
    inputSchema: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] } },
  { name: 'calc', description: '伤害计算与击杀线。attacker/defender 可传物种名（中英文皆可）或整段 Showdown importable 配置文本（含 EVs/性格/道具/太晶）',
    inputSchema: { type: 'object', properties: {
      attacker: { type: 'string' }, defender: { type: 'string' }, move: { type: 'string' },
      doubles: { type: 'boolean', description: '双打场地（扩散招式按 0.75 倍计算），默认 false' } }, required: ['attacker', 'defender', 'move'] } },
  { name: 'speed', description: '速度线先后手对比。p1/p2 可传物种名或整段 importable 配置文本 ——' +
      '传配置文本时会【自动读配置里的讲究围巾/天气特性】（以前只认 scarf 开关，会答反）',
    inputSchema: { type: 'object', properties: {
      p1: { type: 'string' }, p2: { type: 'string' },
      scarf: { type: 'array', items: { type: 'string' }, description: '【额外假设】它戴围巾×1.5（配置里已有围巾则不用传）' },
      tailwind: { type: 'array', items: { type: 'string' }, description: '顺风×2' },
      para: { type: 'array', items: { type: 'string' }, description: '麻痹×0.5' },
      weather: { type: 'string', description: '天气：RainDance/SunnyDay/Sandstorm/Snow —— 配 Swift Swim 等特性时×2' },
      booster: { type: 'array', items: { type: 'string' }, description: '驱动能量/古代活性提速×1.5（需自己确认它提的是速度）' } },
      required: ['p1', 'p2'] } },
  { name: 'validate_team', description: '校验 Showdown importable 队伍是否合法。支持中文队伍文本',
    inputSchema: { type: 'object', properties: {
      team: { type: 'string' }, format: { type: 'string', description: '如 gen9ou(单打Lv100) / gen9vgc2025regi(VGC双打Lv50) / gen9championsvgc2026regmb(Champions VGC2026)，默认 gen9ou' },
      engine: { type: 'string', enum: ['auto', 'sim', 'showdown'], description: '引擎，默认 auto（champions 格式自动走 showdown）' } }, required: ['team'] } },
  { name: 'sim', description: '两队无头对战的蒙特卡洛胜率（双方随机出招，衡量队伍强度而非操作水平）。支持双打',
    inputSchema: { type: 'object', properties: {
      team1: { type: 'string' }, team2: { type: 'string' },
      n: { type: 'number', description: '对局数，默认 100，上限 2000' },
      format: { type: 'string', description: '默认 gen9customgame(单打)；双打用 gen9doublescustomgame / gen9vgc2025regi；Champions 用 gen9champions* 系列（自动走 showdown 引擎）' },
      engine: { type: 'string', enum: ['auto', 'sim', 'showdown'], description: '引擎，默认 auto' } }, required: ['team1', 'team2'] } },
];

const server = new Server({ name: 'pokemon', version: '1.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (name === 'dex') {
      const { Dex } = await import('@pkmn/dex');
      const s = Dex.species.get(zhToEn('species', args.species));
      if (!s.exists) return text({ error: '未知宝可梦: ' + args.species });
      return text({ name: s.name, nameZh: enToZh('species', s.name), types: s.types,
        typesZh: s.types.map(t => enToZh('types', t)), baseStats: s.baseStats,
        abilities: s.abilities,
        abilitiesZh: Object.fromEntries(Object.entries(s.abilities).map(([k, v]) => [k, enToZh('abilities', v)])),
        weightkg: s.weightkg, tier: s.tier });
    }
    if (name === 'move') {
      const { Dex } = await import('@pkmn/dex');
      const m = Dex.moves.get(zhToEn('moves', args.move));
      if (!m.exists) return text({ error: '未知招式: ' + args.move });
      return text({ name: m.name, ...zhFields('moves', m.name), type: m.type, category: m.category,
        basePower: m.basePower, accuracy: m.accuracy, priority: m.priority, pp: m.pp, shortDesc: m.shortDesc });
    }
    if (name === 'ability') {
      const { Dex } = await import('@pkmn/dex');
      const ab = Dex.abilities.get(zhToEn('abilities', args.ability));
      if (!ab.exists) return text({ error: '未知特性: ' + args.ability });
      return text({ name: ab.name, ...zhFields('abilities', ab.name), rating: ab.rating,
        shortDesc: ab.shortDesc, desc: ab.desc });
    }
    if (name === 'item') {
      const { Dex } = await import('@pkmn/dex');
      const it = Dex.items.get(zhToEn('items', args.item));
      if (!it.exists) return text({ error: '未知道具: ' + args.item });
      return text({ name: it.name, ...zhFields('items', it.name), shortDesc: it.shortDesc, desc: it.desc });
    }
    if (name === 'calc') return text(await calc(args.attacker, args.defender, args.move, !!args.doubles));
    if (name === 'speed') {
      const { Generations, Pokemon } = await import('@smogon/calc');
      const g = Generations.get(9);
      const mk = (inp) => /[\n:]/.test(inp) ? buildPokemon(inp)
        : new Pokemon(g, zhToEn('species', inp), { evs: { spe: 252 }, nature: 'Jolly', level: 50 });
      const a = await mk(args.p1), b = await mk(args.p2);
      // ★ 配置里本来就有的道具（讲究围巾）必须自己读 —— stats.spe 不含它。
      //   以前只认 --scarf 开关，实测报出「Iron Valiant 更快」而围巾土地云其实是 463。
      const has = (v, tag) => !!(v && v.includes(tag));
      const apply = (p, tag) => finalSpeed(p, {
        tailwind: has(args.tailwind, tag), para: has(args.para, tag),
        weather: args.weather || null,
        item: has(args.scarf, tag) ? 'Choice Scarf' : undefined,
        booster: has(args.booster, tag),
      });
      const A = apply(a, 'p1'), B = apply(b, 'p2');
      return text({ p1: A, p2: B, faster: A.effective > B.effective ? 'p1' : B.effective > A.effective ? 'p2' : 'tie' });
    }
    if (name === 'validate_team') {
      const team = parseImportable(args.team);
      const fmt = args.format || 'gen9ou';
      const { sim, name: eng } = await resolveEngine({ format: fmt, engine: args.engine });
      const v = sim.TeamValidator.get(fmt);
      if (!v) return text({ error: '未知格式: ' + fmt });
      const problems = v.validateTeam(team);
      return text({ format: fmt, engine: eng, gameType: v.format.gameType, count: team.length,
        problems: problems && problems.length ? problems : 'OK' });
    }
    if (name === 'sim') {
      const p1 = loadTeam(tmpTeam(args.team1, 'p1')), p2 = loadTeam(tmpTeam(args.team2, 'p2'));
      const n = Math.max(1, Math.min(2000, args.n || 100));
      const fmt = args.format || 'gen9customgame';
      const { sim, name: eng } = await resolveEngine({ format: fmt, engine: args.engine });
      const results = [];
      for (let i = 0; i < n; i++) {
        results.push(await runBattle(sim, p1, p2, fmt,
          [1 + i * 7919 % 65536, 2 + i * 104729 % 65536, 3 + i * 15485863 % 65536, 4 + i * 32452843 % 65536]));
      }
      const wins = results.filter(r => r.winner === 'Player 1').length;
      const losses = results.filter(r => r.winner === 'Player 2').length;
      return text({ format: fmt, engine: eng, gameType: DOUBLES.test(fmt) ? 'doubles' : 'singles', games: n,
        p1Wins: wins, p2Wins: losses, undecided: n - wins - losses,
        p1WinRate: ((wins / n) * 100).toFixed(1) + '%',
        avgTurns: (results.reduce((a, r) => a + r.turn, 0) / n).toFixed(1),
        stalled: results.filter(r => r.stalled).length,
        sampleErrors: results.flatMap(r => r.errors).slice(0, 5) });
    }
    return text({ error: '未知工具: ' + name });
  } catch (e) {
    return { content: [{ type: 'text', text: 'ERROR: ' + e.message }], isError: true };
  }
});
await server.connect(new StdioServerTransport());
