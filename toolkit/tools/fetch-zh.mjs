// 从 PokeAPI 拉取简体中文名，并与本机 @pkmn/dex 校对后落盘为 data/zh-names.json
// 只需联网跑一次，之后全部离线使用。
import { writeFileSync, mkdirSync } from 'node:fs';
import { Dex } from '@pkmn/dex';

const ENDPOINT = 'https://beta.pokeapi.co/graphql/v1beta';
const ZH = 12, EN = 9;
async function gql(query) {
  const r = await fetch(ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (j.errors) throw new Error('GraphQL: ' + JSON.stringify(j.errors).slice(0, 400));
  return j.data;
}
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function fetchPair(table, idCol) {
  const data = await gql(`query {
    zh: ${table}(where: {language_id: {_eq: ${ZH}}}) { name ${idCol} }
    en: ${table}(where: {language_id: {_eq: ${EN}}}) { name ${idCol} }
  }`);
  const enById = new Map(data.en.map(r => [r[idCol], r.name]));
  const out = [];
  for (const row of data.zh) {
    const en = enById.get(row[idCol]);
    if (en) out.push({ id: row[idCol], zh: row.name, en });
  }
  return out;
}

const report = { source: 'PokeAPI GraphQL v1beta', fetchedAt: new Date().toISOString(), counts: {}, unmatched: {} };
const data = { species: {}, moves: {}, abilities: {}, items: {}, natures: {}, types: {} };

// --- 宝可梦：用全国图鉴编号（PokeAPI species id == 图鉴编号）与 Showdown 对齐 ---
{
  const pairs = await fetchPair('pokemon_v2_pokemonspeciesname', 'pokemon_species_id');
  const all = Dex.species.all();
  const byName = new Map(all.map(s => [norm(s.name), s.name]));
  const byNum = new Map();
  for (const s of all) {
    if (!s.num || s.forme) continue;
    if (!byNum.has(s.num)) byNum.set(s.num, s.name);
  }
  let ok = 0; const bad = [];
  for (const p of pairs) {
    const hit = byName.get(norm(p.en)) || byNum.get(p.id);
    if (hit) { data.species[p.zh] = hit; ok++; } else bad.push(p.zh + '->' + p.en);
  }
  report.counts.species = { total: pairs.length, matched: ok };
  report.unmatched.species = bad.slice(0, 15);
  // 反向：英文 -> 中文
  data.speciesEn = {};
  for (const [zh, en] of Object.entries(data.species)) if (!data.speciesEn[en]) data.speciesEn[en] = zh;
}

// --- 招式 / 特性 / 道具 / 性格 ---
for (const [key, table, idCol, lookup] of [
  ['types', 'pokemon_v2_typename', 'type_id', (n) => Dex.types.get(n)],
  ['moves', 'pokemon_v2_movename', 'move_id', (n) => Dex.moves.get(n)],
  ['abilities', 'pokemon_v2_abilityname', 'ability_id', (n) => Dex.abilities.get(n)],
  ['items', 'pokemon_v2_itemname', 'item_id', (n) => Dex.items.get(n)],
  ['natures', 'pokemon_v2_naturename', 'nature_id', (n) => Dex.natures.get(n)],
]) {
  const pairs = await fetchPair(table, idCol);
  let ok = 0; const bad = [];
  for (const p of pairs) {
    const ent = lookup(p.en);
    if (ent && ent.exists) { data[key][p.zh] = ent.name; ok++; } else bad.push(p.zh + '->' + p.en);
  }
  report.counts[key] = { total: pairs.length, matched: ok };
  report.unmatched[key] = bad.slice(0, 15);
  data[key + 'En'] = {};
  for (const [zh, en] of Object.entries(data[key])) if (!data[key + 'En'][en]) data[key + 'En'][en] = zh;
}

mkdirSync('data', { recursive: true });
writeFileSync('data/zh-names.json', JSON.stringify(data), 'utf8');
writeFileSync('data/zh-fetch-report.json', JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report, null, 2));
console.log('BYTES:', JSON.stringify(data).length);
