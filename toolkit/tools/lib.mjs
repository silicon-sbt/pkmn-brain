// 宝可梦对战核心库：中文名解析 / 队伍解析 / 无头对战
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------- 中文名映射 ----------
// 两个离线数据源，互为补充：
//
//  data/zh-ps.json    【主源】Pokemon Showdown 官方中文数据 (tools/fetch-zh-ps.mjs)
//                     键就是 Showdown ID，与 @pkmn/dex 同构，无需名称匹配；
//                     自带中文【描述】(shortDesc/desc)。覆盖：宝可梦 1559 / 招式 953 /
//                     特性 320 / 道具 583。
//  data/zh-names.json 【补充】PokeAPI 官方简中译名 (tools/fetch-zh.mjs)
//                     与主源在 59 条上译名不同（招式多为新旧官方译法之差，
//                     如 归天之翼/死亡之翼；宝可梦多为形态后缀）。保留它可让两种译名都能查到。
//  data/zh-aliases.json 社区俗称/旧译（剩饭、开朗…），人工维护，优先级最低。

const EMPTY = { species: {}, moves: {}, abilities: {}, items: {}, types: {}, natures: {} };
function loadJson(rel, fallback) {
  const p = join(HERE, '..', rel);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback;
}
// ★ 工具的「根目录」= 本仓库根。所有默认路径都必须基于它，不能依赖 cwd ——
//   这些默认值原来写成 'teams/ou-a.txt'，目录重组后从项目根调用就会【静默找不到文件】。
export const TOOLKIT_ROOT = join(HERE, '..');
export const tpath = (...p) => join(TOOLKIT_ROOT, ...p);

let _ps = null, _poke = null, _alias = null, _rev = null, _fwd = null;

export function zhPs() { if (!_ps) _ps = loadJson('data/zh-ps.json', EMPTY); return _ps; }
export function zh() { if (!_poke) _poke = loadJson('data/zh-names.json', EMPTY); return _poke; }
export function aliases() { if (!_alias) _alias = loadJson('data/zh-aliases.json', {}); return _alias; }

// 中文名 -> 英文名 的反查索引
function reverse() {
  if (_rev) return _rev;
  const r = {};
  const add = (kind, zhName, en) => {
    if (!zhName || !en) return;
    if (!r[kind]) r[kind] = new Map();
    if (!r[kind].has(zhName)) r[kind].set(zhName, en);   // 先到先得：主源优先
  };
  const ps = zhPs();
  for (const kind of ['species', 'moves', 'abilities', 'items']) {
    for (const v of Object.values(ps[kind] || {})) add(kind, v.zh, v.en);
  }
  for (const [en, zhName] of Object.entries(ps.types || {})) add('types', zhName, en);
  for (const [en, zhName] of Object.entries(ps.natures || {})) add('natures', zhName, en);
  const poke = zh();
  for (const kind of ['species', 'moves', 'abilities', 'items', 'natures', 'types']) {
    for (const [zhName, en] of Object.entries(poke[kind] || {})) add(kind, zhName, en);
  }
  _rev = r;
  return r;
}

// 英文名 -> 中文条目（含描述）
function forward() {
  if (_fwd) return _fwd;
  const f = {};
  const ps = zhPs();
  for (const kind of ['species', 'moves', 'abilities', 'items']) {
    f[kind] = new Map();
    for (const v of Object.values(ps[kind] || {})) if (!f[kind].has(v.en)) f[kind].set(v.en, v);
  }
  f.types = new Map(Object.entries(ps.types || {}).map(([en, zhName]) => [en, { en, zh: zhName }]));
  f.natures = new Map(Object.entries(ps.natures || {}).map(([en, zhName]) => [en, { en, zh: zhName }]));
  _fwd = f;
  return f;
}

export function zhToEn(kind, s) {
  if (!s) return s;
  const key = s.trim();
  const r = reverse()[kind];
  if (r && r.has(key)) return r.get(key);     // 主源 + 补充源
  const a = aliases()[kind];
  if (a && a[key]) return a[key];             // 社区俗称兜底
  return s;
}

// 返回 { en, zh, shortDesc?, desc? }；找不到时 zh 退化为英文名
export function zhInfo(kind, en) {
  if (!en) return { en, zh: en };
  const m = forward()[kind];
  const hit = m && m.get(en);
  if (hit) return hit;
  return { en, zh: enToZh(kind, en) };
}

export function enToZh(kind, s) {
  if (!s) return s;
  const m = forward()[kind];
  const hit = m && m.get(s);
  return (hit && hit.zh) || s;
}

// ---------- 队伍解析（支持中文标签与中文名） ----------
const LABELS = {
  '特性': 'ability', '等级': 'level', '太晶属性': 'tera type', '太晶': 'tera type',
  '努力值': 'evs', '个体值': 'ivs', '性格': 'nature', '亲密度': 'happiness',
};
const STAT_ZH = { hp: 'hp', '体力': 'hp', '攻击': 'atk', '防御': 'def', '特攻': 'spa', '特防': 'spd', '速度': 'spe' };
function normKey(k) {
  const k2 = k.toLowerCase();
  if (STAT_ZH[k2]) return STAT_ZH[k2];
  return { hp: 'hp', atk: 'atk', def: 'def', spa: 'spa', spd: 'spd', spe: 'spe' }[k2] || null;
}
function parseStatLine(v) {
  const stats = {};
  for (const q of v.split(/[\/／]/)) {
    const m = q.trim().match(/^(\d+)\s*(.+)$/);
    if (m) { const n = normKey(m[2].trim()); if (n) stats[n] = Number(m[1]); }
  }
  return stats;
}

export function parseImportable(text) {
  const blocks = text.replace(/\r\n/g, '\n').split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  return blocks.map(block => {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    const p = { moves: [] };
    let left = lines[0], item;
    const at = Math.max(lines[0].lastIndexOf(' @ '), lines[0].lastIndexOf('＠'));
    if (at !== -1) { left = lines[0].slice(0, at).trim(); item = lines[0].slice(at + 3).trim(); }
    const g = left.match(/[\(（]\s*([MF])\s*[\)）]\s*$/);
    if (g) { p.gender = g[1]; left = left.slice(0, g.index).trim(); }
    const sp = left.match(/^(.*?)\s*[\(（]([^\)）]+)[\)）]\s*$/);
    if (sp && sp[1].trim()) { p.name = sp[1].trim(); p.species = sp[2].trim(); } else p.species = left;
    if (item) p.item = item;
    for (const line of lines.slice(1)) {
      if (line.startsWith('-')) { p.moves.push(line.replace(/^-\s*/, '').trim()); continue; }
      const kv = line.match(/^(.+?)[:：]\s*(.*)$/);
      if (kv) {
        const rawK = kv[1].trim();
        const k = LABELS[rawK] || rawK.toLowerCase();
        const v = kv[2].trim();
        if (k === 'ability') p.ability = v;
        else if (k === 'level') p.level = Number(v);
        else if (k === 'tera type') p.teraType = v;
        else if (k === 'happiness') p.happiness = Number(v);
        else if (k === 'evs') p.evs = parseStatLine(v);
        else if (k === 'ivs') p.ivs = parseStatLine(v);
        else if (k === 'nature') p.nature = v;
        continue;
      }
      if (/^(shiny|闪光)$/i.test(line)) { p.shiny = true; continue; }
      const nat = line.match(/^([A-Za-z]+)\s+Nature$/);
      if (nat) { p.nature = nat[1]; continue; }
      const natZh = line.match(/^(.+?)性格$/);
      if (natZh) { p.nature = natZh[1]; continue; }
    }
    p.species = zhToEn('species', p.species);
    if (p.item) p.item = zhToEn('items', p.item);
    if (p.ability) p.ability = zhToEn('abilities', p.ability);
    if (p.nature) p.nature = zhToEn('natures', p.nature);
    if (p.teraType) p.teraType = zhToEn('types', p.teraType);
    p.moves = p.moves.map(m => zhToEn('moves', m));
    return p;
  });
}
export function loadTeam(file) {
  const raw = readFileSync(file, 'utf8');
  const t = raw.trim();
  if (t.startsWith('[') || t.startsWith('{')) {
    const j = JSON.parse(t);
    return Array.isArray(j) ? j : (j.team || j.p1 || j.p2);
  }
  return parseImportable(raw);
}

// ---------- 无头对战 ----------
// 出招策略直接用引擎自带的 Side.autoChoose()（Battle.makeChoices()）。
// 不要自己重写：引擎内部已经正确处理了双打的目标选择、替补上场、
// 以及"选择数必须等于未倒下宝可梦数"这些规则。
//
// 想跑指定操作线时，用 opts.scripted(battle, turn) 返回 { p1?, p2? } 的招法字符串，
// 未指定的那一方自动随机出招。双打里手动出招需自带目标，例如 'move 1 1, move 2'。

// ══════════ @smogon/calc 的两个高频坑（都在实际代码里踩过） ══════════

// ① 多段招的 damage 是【二维数组】—— 外层是【第几下】，内层是这一下的 16 档乱数。
//    实测（0.12）：种子机关枪 3×16、三旋击 3×16（每下递增 20-24 / 39-46 / 57-68）、
//    鼠数儿 10×16。总伤害 = 各下相加，desc 里也印证（三旋击 116-138 = 三下之和）。
//
//    ⚠️ 直接 Math.max(...res.damage) 会得到 NaN。
//    ⚠️ 更隐蔽的是 d.flat() —— 它【不报错但语义错】：给你的是【单下】的区间，
//       不是总伤害。种子机关枪会被报成 72-86 而真实是 216-258（差 3 倍）。
//    所以这个函数返回【两个】区间，用的人自己选，别猜。
export function damageRolls(res) {
  const d = res && res.damage !== undefined ? res.damage : res;
  if (!Array.isArray(d)) return { perHit: [d, d], total: [d, d], multiHit: false, hits: 1, groups: null };
  if (!Array.isArray(d[0])) return { perHit: [Math.min(...d), Math.max(...d)],
    total: [Math.min(...d), Math.max(...d)], multiHit: false, hits: 1, groups: null };
  const groups = d.map(g => [Math.min(...g), Math.max(...g)]);
  const total = [groups.reduce((s, g) => s + g[0], 0), groups.reduce((s, g) => s + g[1], 0)];
  const perHit = [Math.min(...groups.map(g => g[0])), Math.max(...groups.map(g => g[1]))];
  return { perHit, total, multiHit: true, hits: d.length, groups };
}

// ② 最终速度：Pokemon.stats.spe 【不含】道具 / 特性 / 能力等级 / 异常状态。
//    实测（0.12，本项目自己跑过）：讲究围巾、速度 +2、麻痹 —— 三者都不改变 stats.spe。
//    0.12 也【没有导出 getFinalSpeed】（那是后面版本才有的）。
//    所以这里自己补。踩过的坑：队文件里明明写着 @ Choice Scarf，工具却按 309 报，
//    还回一句「Iron Valiant 更快」—— 而围巾土地云是 463，它更快。数字就在手里却没用。
//
//    另注：驱动能量/夸克充能、古代活性 属于【特性+道具】联动，这里只能靠 opts.booster 显式打开。
const SPEED_STAGE = (n) => (n >= 0 ? (2 + n) / 2 : 2 / (2 - n));
const WEATHER_ABILITY = { RainDance: 'Swift Swim', SunnyDay: 'Chlorophyll', Sandstorm: 'Sand Rush', Snow: 'Slush Rush' };
export function finalSpeed(pokemon, opts = {}) {
  let v = pokemon.stats.spe;
  const notes = [];
  const stage = Math.max(-6, Math.min(6, opts.boost || 0));
  if (stage) { v = Math.floor(v * SPEED_STAGE(stage)); notes.push('能力等级 ' + (stage > 0 ? '+' : '') + stage); }
  if ((opts.item || pokemon.item) === 'Choice Scarf') { v = Math.floor(v * 1.5); notes.push('讲究围巾×1.5'); }
  if (opts.tailwind) { v *= 2; notes.push('顺风×2'); }
  if (opts.para) { v = Math.floor(v * 0.5); notes.push('麻痹×0.5'); }
  const wa = WEATHER_ABILITY[opts.weather];
  if (wa && (opts.ability || pokemon.ability) === wa) { v *= 2; notes.push(opts.weather + ' + ' + wa + '×2'); }
  if (opts.booster) { v = Math.floor(v * 1.5); notes.push('充能提速×1.5'); }
  return { species: pokemon.name, base: pokemon.stats.spe, effective: v, mods: notes };
}
export async function runBattle(sim, p1team, p2team, formatid, seed, opts = {}) {
  const { Battle, Teams } = sim;
  const b = new Battle({ formatid, seed });
  b.setPlayer('p1', { team: Teams.pack(p1team) });
  b.setPlayer('p2', { team: Teams.pack(p2team) });
  const errors = [];
  let guard = 0, stalled = 0;
  while (!b.ended && guard++ < 500) {
    try {
      if (opts.scripted) {
        const s = opts.scripted(b, b.turn) || {};
        if (s.p1) b.p1.choose(s.p1);
        if (s.p2) b.p2.choose(s.p2);
        b.p1.autoChoose();     // 补齐未指定的选择
        b.p2.autoChoose();
        b.commitChoices();
      } else {
        b.makeChoices();       // 双方都用引擎自带随机 AI
      }
    } catch (e) {
      errors.push(`t${b.turn} ${b.requestState}: ${e.message}`);
      stalled = 2;
      break;
    }
  }
  if (!b.ended && !stalled) stalled = 1;
  return { winner: b.winner || '', turn: b.turn, ended: b.ended, stalled, errors, log: b.log };
}
