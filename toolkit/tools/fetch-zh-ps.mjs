// 从 Pokemon Showdown 官方中文数据生成 data/zh-ps.json
//
// 优势（相对 PokeAPI 方案）：
//  1. 键就是 Showdown ID，和 @pkmn/dex 完全同构 —— 不需要任何名称模糊匹配
//  2. 自带中文【描述】(shortDesc / desc)，这是 PokeAPI 没有的
//  3. 对战道具覆盖好（583 条，含全部对战相关道具）
// 只需联网跑一次，之后完全离线。
import vm from 'node:vm';
import { writeFileSync, mkdirSync } from 'node:fs';
import { Dex } from '@pkmn/dex';

const URL = 'https://play.pokemonshowdown.com/data/text/zh-cn.js';
const res = await fetch(URL);
if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + URL);
const src = await res.text();
const sandbox = { exports: {} };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { timeout: 30000 });
const zh = sandbox.exports.BattleText['zh-cn'];
if (!zh) throw new Error('解析失败：未找到 BattleText["zh-cn"]');

const out = {
  _source: URL,
  _fetchedAt: new Date().toISOString(),
  _note: '键为 Showdown ID，与 @pkmn/dex 同构；zhToEn 反查时直接建立 中文名->ID 索引。',
  species: {}, moves: {}, abilities: {}, items: {}, types: {}, natures: {},
};
const report = { unmatched: {}, counts: {} };

// 用 dex 校验每个 id 是否真实存在，并记录英文名
function collect(section, dexLookup, target, keepDesc) {
  let ok = 0; const bad = [];
  for (const [id, v] of Object.entries(section)) {
    if (!v || !v.name) continue;
    const ent = dexLookup(id);
    if (!ent || !ent.exists) { bad.push(id); continue; }
    const rec = { en: ent.name, zh: v.name };
    if (keepDesc) {
      if (v.shortDesc) rec.shortDesc = v.shortDesc;
      if (v.desc && v.desc !== v.shortDesc) rec.desc = v.desc;
    }
    target[id] = rec;
    ok++;
  }
  report.counts[target === out.species ? 'species' : null] = null;
  return { ok, bad };
}
const sp = collect(zh.Pokedex, (id) => Dex.species.get(id), out.species, false);
const mv = collect(zh.Moves, (id) => Dex.moves.get(id), out.moves, true);
const ab = collect(zh.Abilities, (id) => Dex.abilities.get(id), out.abilities, true);
const it = collect(zh.Items, (id) => Dex.items.get(id), out.items, true);

// 属性 / 性格：键就是英文名
for (const [en, cn] of Object.entries(zh.TypeNames || {})) {
  if (Dex.types.get(en).exists) out.types[en] = cn;
}
for (const [en, cn] of Object.entries(zh.NatureNames || {})) {
  if (Dex.natures.get(en).exists) out.natures[en] = cn;
}

report.counts = {
  species: { ps: Object.keys(zh.Pokedex).length, matched: sp.ok },
  moves: { ps: Object.keys(zh.Moves).length, matched: mv.ok },
  abilities: { ps: Object.keys(zh.Abilities).length, matched: ab.ok },
  items: { ps: Object.keys(zh.Items).length, matched: it.ok },
  types: { matched: Object.keys(out.types).length },
  natures: { matched: Object.keys(out.natures).length },
};
report.unmatched = { species: sp.bad.slice(0, 10), moves: mv.bad.slice(0, 10), abilities: ab.bad.slice(0, 10), items: it.bad.slice(0, 10) };

mkdirSync('data', { recursive: true });
writeFileSync('data/zh-ps.json', JSON.stringify(out), 'utf8');
writeFileSync('data/zh-ps-report.json', JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report, null, 2));
console.log('BYTES:', JSON.stringify(out).length);
