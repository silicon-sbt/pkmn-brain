// 双引擎解析器
//
// @pkmn/sim         —— 轻量、纯 ESM、201 个格式。默认引擎。
// pokemon-showdown  —— 官方完整包，334 个格式，且是【唯一】支持
//                      Pokémon Champions / VGC 2026 的引擎（15 个 champions 格式）。
//                      代价：CJS 包、依赖较大。
//
// 选择规则：格式 id 含 champions 走 pokemon-showdown，其余走 @pkmn/sim。
// 也可用 --engine sim|showdown 强制指定。

let _sim = null;
let _ps = null;

export async function loadSim() {
  if (!_sim) _sim = await import('@pkmn/sim');
  return _sim;
}

export async function loadShowdown() {
  if (!_ps) {
    // pokemon-showdown 是 CJS 且没有 exports 字段，必须取 default
    const mod = await import('pokemon-showdown');
    _ps = mod.default ?? mod;
    if (!_ps || !_ps.Battle) throw new Error('pokemon-showdown 加载失败（缺少 Battle 导出）');
  }
  return _ps;
}

export function engineFor(formatid) {
  return /champion/i.test(formatid || '') ? 'showdown' : 'sim';
}

export async function resolveEngine({ format, engine } = {}) {
  const which = engine && engine !== 'auto'
    ? engine
    : (/champion/i.test(format || '') ? 'showdown' : 'sim');
  if (which === 'showdown') return { sim: await loadShowdown(), name: 'showdown' };
  if (which === 'sim') return { sim: await loadSim(), name: 'sim' };
  throw new Error('未知引擎: ' + which + '（可选 sim / showdown / auto）');
}

// 列出可用格式，标注引擎来源
export async function listFormats(keyword) {
  const out = [];
  const sim = await loadSim();
  for (const f of sim.Dex.formats.all()) out.push({ id: f.id, name: f.name, gameType: f.gameType || 'singles', engine: 'sim' });
  try {
    const ps = await loadShowdown();
    const seen = new Set(out.map(o => o.id));
    for (const f of ps.Dex.formats.all()) {
      if (seen.has(f.id)) continue;
      out.push({ id: f.id, name: f.name, gameType: f.gameType || 'singles', engine: 'showdown' });
    }
  } catch (e) {
    out.push({ error: 'pokemon-showdown 不可用: ' + e.message });
  }
  if (!keyword) return out;
  const k = keyword.toLowerCase();
  return out.filter(o => o.id && o.id.toLowerCase().includes(k));
}
