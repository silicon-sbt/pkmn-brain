#!/usr/bin/env node
// 本地队伍匹配 —— 从【浏览器里存着的队伍】中找出「这一局正在用的那一套」。
//
// ── 为什么需要它 ────────────────────────────────────────────────────────────
// request.side.pokemon[] 里【没有努力值 / 性格 / 个体值】。
// 引擎源码：side.js:177 getRequestData() → pokemon.js:785 getSwitchRequestData()，
// 只发 ident/details/condition/active/stats/moves/baseAbility/item/pokeball/ability/teraType。
// stats 是 baseStoredStats（已经算完的最终数值），所以「反解」是唯一能从 request 拿 EV 的办法。
//
// 反解在 L100 上其实【精确】（往返对拍过：ou-c 6/6 性格与努力值完全一致），但两处会坏：
//   ① HP 不在 stats 里，在 condition（"434/434"）；这只倒下 / 形态变化后引擎发 "0 fnt"
//      ⇒ HP 努力值被当成 0。实测 Hatterene 252 → 0，最大血 318 → 255。
//   ② 等级 ≠ 100（VGC / Champions）⇒ 反解直接放弃 ⇒ 性格 Serious、努力值全 0，整局伤害全错。
//
// 而浏览器里 PS.teams.list[].packedTeam 是【精确】的，解出来就有 nature/evs/ivs/teraType。
//
// ── 但它不能变成【第二条真相来源】（本项目在这上面栽过）────────────────────
// 以前浏览器侧挑字段发 body.myTeam，挑空之后服务端看不出来，会悄悄回退 teams/ou-a.txt ——
// 换了队也不生效，面板上一点异常都没有。所以这里的规矩：
//   1. 匹配【全部在服务端做】。浏览器只原样转发列表，一个字段都不筛。
//   2. 本地队伍只用来取 nature / evs / ivs；
//      species / item / ability / moves / teraType 一律用 request 的（权威、反映对局实况）。
//   3. 解不开的、没匹配上的、数值核对不过的，都【数出来/写进 why】由调用方打出来 —— 不许静默。
//
// ── 判定顺序 ────────────────────────────────────────────────────────────────
//   第 1 段  按【物种 + 道具 + 特性 + 4 招】匹配特征（先严格比物种，再放宽到基础形态）
//            0 套 → null + why
//   第 2 段  用对局 request 给的 stats 核对（stats 是 nature/EV/IV 的结果，能复现同一组
//            数值 = 这套队确实就是这一局在用的 —— 这是最强的验证，也堵掉「本地存着一套
//            只有努力值不同的孪生队」这种撞车）
//            · 恰好 1 套对得上 → 就是它
//            · 多套都对得上   → 它们【伤害等价】（calc 只吃最终数值），随便哪套，标注即可
//            · 一套都对不上   → 两种可能，要分开：
//                 a) 我们的数值模型跟这个规则合得来（反解能成功）⇒ 说明这些本地队
//                    确实【不是】这一局用的 ⇒ 返回 null，让调用方回退反解（不拿错队污染）
//                 b) 合不来（L50 / Champions 的数值系统）⇒ 核对本身失效，
//                    此时唯一解仍然比反解强，就用它并标注「数值无法核对」；多解则返回 null
const { Teams } = await import('@pkmn/sim');
const { Generations, Pokemon } = await import('@smogon/calc');
const { Dex } = await import('@pkmn/dex');

const g = Generations.get(9);

const toID = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
// 招名归一：引擎会给 报恩/迁怒 加威力后缀（pokemon.js:802-805 发的是 "return102"），本地存的是 "Return"
const normMove = (m) => toID(m).replace(/\d+$/, '');

// ★★ 两边必须归一化到【同一个口径】，否则特征永远对不上。★★
//   实测（2026-09-27 用户实测报的：「用的队伍在本地是有的」）——
//   对局 request 发的是【ID】，本地 unpack 出来的是【显示名】：
//     request.item  = 'rockyhelmet'   本地 item  = 'Rocky Helmet'
//     request.ability = 'intimidate'  本地 ability = 'Intimidate'
//   第一版直接拿这两个字符串比 ⇒ **本地队伍这条路在实战里从来没生效过**，
//   而我的自检 fixture 是自己手写的、恰好写成了名字 ⇒ 假绿。教训：
//   **自检的输入必须来自真引擎**，不能自己捏一个「看起来对」的形状。
//   （引擎字段来源：side.js:177 getRequestData → pokemon.js:785 getSwitchRequestData）
const itemId = (v) => { const e = Dex.items.get(String(v || '')); return e.exists ? e.id : toID(v); };
const abilityId = (v) => { const e = Dex.abilities.get(String(v || '')); return e.exists ? e.id : toID(v); };
const speciesId = (v) => { const s = Dex.species.get(String(v || '')); return s.exists ? s.id : toID(v); };
// ID → 显示名（Dex 两种写法都认：'choicespecs' 和 'Choice Specs' 都返回规范名）
const idName = (kind, v) => {
  if (!v) return undefined;
  const e = Dex[kind].get(String(v));
  return e && e.exists ? e.name : String(v);
};
const baseSpecies = (sp) => {
  const s = Dex.species.get(String(sp || ''));
  return s.exists ? toID(s.baseSpecies) : toID(sp);
};

// 一套队的「特征」：物种 + 道具 + 特性 + 4 招。
//   【不】看努力值/性格/太晶 —— 前两个正是我们要解的东西，太晶本地可能没写、由引擎补默认值。
//   loose=true 时物种按【基础形态】比：形态变化（Ogerpon-…-Tera / Palafin-Hero）会让 request
//   的 details 和本地存的物种对不上，收紧比较会整队匹配失败。
// ★★ 特征里【不含道具】：道具在对局里会变，拿它当硬条件是自找失败。★★
//   实测（battle-20260927-123200）：铁辙迹的【驱动能量在换上场那一瞬间就被消耗掉】，
//   引擎的 request 里 item 直接变成 ""（实测：switch 之后第一份 request 就是 item=""），
//   于是「本地队有 boosterenergy、对局里没有」⇒ 从 t1 起整局都匹配不上
//   （teampreview 那一次还能匹配，因为那时道具还在 —— 日志里正好就是这个形状）。
//   别的会变的情况：结实/披带/树果被消耗、被拍落/掉包/腐蚀气体偷走、戏法交换。
//   道具的作用在下面 itemPref 里当【优选条件】用，不当否决条件。
export function sigOf(sets, loose) {
  return sets.map(s => {
    const sp = loose ? baseSpecies(s.species) : speciesId(s.species);
    return [sp, abilityId(s.ability), (s.moves || []).map(normMove).sort().join('+')].join('~');
  }).sort().join('|');
}
export function sigOfRequest(reqMons, loose) {
  return reqMons.map(m => {
    const sp = String(m.details || m.species || '').split(',')[0].trim();
    // ★ 特性要用 baseAbility：ability 会被 追踪/交换特性 改掉，baseAbility 不会。
    return [(loose ? baseSpecies(sp) : speciesId(sp)), abilityId(m.baseAbility || m.ability),
      (m.moves || []).map(normMove).sort().join('+')].join('~');
  }).sort().join('|');
}
// 道具偏好：对局里那一只是【空的】（消耗/被偷/还没拿到）时不算不符，其余按 ID 比。
function itemPref(sets, reqMons) {
  const a = sets.map(s => itemId(s.item)).sort();
  const b = reqMons.map(m => itemId(m.item)).sort();
  let miss = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (b[i] && a[i] !== b[i]) miss++;
  return miss;
}

// 匹配不上时，说清【到底差在哪一项】—— 上一版只说「没有相符的」，
// 结果真实原因（ID vs 显示名）只能靠猜。逐只列出差异，最多 4 条。
export function nearMiss(localSets, reqMons, max = 4) {
  const want = reqMons.map(m => {
    const sp = String(m.details || m.species || '').split(',')[0].trim();
    return { species: sp, sig: sigOfRequest([m], false), loose: sigOfRequest([m], true) };
  });
  const pool = localSets.slice();
  const diffs = [];
  for (const w of want) {
    let i = pool.findIndex(s => sigOf([s], false) === w.sig);
    let used = 'strict';
    if (i < 0) { i = pool.findIndex(s => sigOf([s], true) === w.loose); used = 'loose'; }
    if (i >= 0) { pool.splice(i, 1); continue; }
    // 找不到：拿物种最接近的一只出来比字段
    const cand = localSets.find(s => speciesId(s.species) === speciesId(w.species)) ||
      localSets.find(s => baseSpecies(s.species) === baseSpecies(w.species));
    if (!cand) { diffs.push(w.species + '：本地队伍里没有这只'); continue; }
    const mine = reqMons.find(m => String(m.details || '').split(',')[0].trim() === w.species) || {};
    const bits = [];
    // 对局那侧道具是空的 = 已消耗/被拍落，不算差异（本函数只在【特征】对不上时才会被调用）
    if (mine.item && itemId(cand.item) !== itemId(mine.item)) {
      bits.push('道具 本地「' + (cand.item || '无') + '」vs 对局「' + (mine.item || '无') + '」');
    }
    if (abilityId(cand.ability) !== abilityId(mine.ability || mine.baseAbility)) {
      bits.push('特性 本地「' + (cand.ability || '无') + '」vs 对局「' + (mine.ability || mine.baseAbility || '无') + '」');
    }
    const a = (cand.moves || []).map(normMove).sort().join('+');
    const b = (mine.moves || []).map(normMove).sort().join('+');
    if (a !== b) {
      bits.push('招式 本地[' + (cand.moves || []).join('/') + '] vs 对局[' +
        (mine.moves || []).map(x => Dex.moves.get(x).name || x).join('/') + ']');
    }
    diffs.push(w.species + '：' + (bits.length ? bits.join('；') : '特征相同（不该走到这里）'));
  }
  return diffs.slice(0, max);
}

// 本地那套队的 5 项数值（HP 不在 request 的 stats 里，所以不参与比较）
function statsLine(set, level) {
  const p = new Pokemon(g, set.species, {
    level: level || 100, nature: set.nature || 'Serious',
    evs: set.evs || {}, ivs: set.ivs || {},
    ability: set.ability, item: set.item,
  });
  return [p.stats.atk, p.stats.def, p.stats.spa, p.stats.spd, p.stats.spe].join(',');
}
// 请求里那一侧的同一组数；【排序后】比，因为两边顺序不一定一样
const reqStatsLine = (reqMons) => reqMons.map(m => {
  const s = m.stats || {};
  return [s.atk, s.def, s.spa, s.spd, s.spe].join(',');
}).sort().join('|');
const statsUsable = (reqMons) => reqMons.every(m => m && m.stats &&
  ['atk', 'def', 'spa', 'spd', 'spe'].every(k => typeof m.stats[k] === 'number'));

// 等级：details 形如 "Great Tusk, M, L50"（L100 时引擎不写这一段）
export function levelOf(reqMons) {
  const m = /,\s*L(\d+)/.exec(String((reqMons && reqMons[0] || {}).details || ''));
  return m ? Number(m[1]) : 100;
}

/**
 * @param localTeams 浏览器原样转发的 [{name, format, packedTeam}, …]（不做任何筛选）
 * @param reqMons    request.side.pokemon[]（原样）
 * @param deps       测试注入：{ unpack, statsLine, modelFits }
 *                   modelFits(mon) → 我们的数值模型能不能反解这一只（false = 规则不兼容，如 L50/Champions）
 * @returns {sets, picked, source, why, total, broken, candidates, statChecked, statFailed, equivalent}
 *   sets=null ⇒ 没匹配上，调用方必须回退，并且 why 一定非空、要显示出来
 */
export function pickLocalTeam(localTeams, reqMons, deps = {}) {
  const unpack = deps.unpack || ((packed) => Teams.unpack(packed));
  const statLine = deps.statsLine || statsLine;
  const modelFits = deps.modelFits || null;
  const out = {
    sets: null, picked: null, source: null, why: '',
    total: Array.isArray(localTeams) ? localTeams.length : 0,
    broken: 0, candidates: [], statChecked: 0, statFailed: 0, equivalent: false,
  };
  if (!Array.isArray(localTeams) || !localTeams.length) {
    out.why = '浏览器没送来本地队伍列表（页面里拿不到 PS.teams？脚本没重装？）';
    return out;
  }
  if (!Array.isArray(reqMons) || !reqMons.length) { out.why = 'request 里没有我方队伍'; return out; }

  // ── 解包：解不开的要数出来，不能当它不存在
  const all = [];
  for (const t of localTeams) {
    if (!t || typeof t.packedTeam !== 'string' || !t.packedTeam) { out.broken++; continue; }
    let sets = null;
    try { sets = unpack(t.packedTeam); } catch (e) { sets = null; }
    if (!Array.isArray(sets) || !sets.length) { out.broken++; continue; }
    all.push({ name: (t && t.name) || '(无名)', sets });
  }

  // ── 第 1 段：特征匹配（先严格比物种，再放宽到基础形态）
  let cands = all.filter(x => sigOf(x.sets, false) === sigOfRequest(reqMons, false));
  let relaxed = false;
  if (!cands.length) {
    cands = all.filter(x => sigOf(x.sets, true) === sigOfRequest(reqMons, true));
    relaxed = cands.length > 0;
  }
  // ★ 道具只当【优选】，不当否决：同特征多套时先挑道具也对得上的。
  //   硬比道具会让整局匹配不上（道具在对局里会被消耗/拍落，实测见 sigOf 顶部）。
  if (cands.length > 1) {
    const exact = cands.filter(x => itemPref(x.sets, reqMons) === 0);
    if (exact.length) { out.itemPreferred = cands.length - exact.length; cands = exact; }
  }
  out.candidates = cands.map(x => x.name);
  if (!cands.length) {
    // ★ 匹配不上时要说清【差在哪一项】。上一版只有一句「没有相符的」，
    //   真实原因（request 发的是 ID、本地存的是显示名）只能靠猜 —— 一句话的诊断等于没有诊断。
    try {
      // ★ 找「最接近的那一套」要按【物种重合度】挑，不能挑列表里第一个 ——
      //   否则差异会报成一堆「本地队伍里没有这只」，等于没报（上一版就是这个毛病）。
      const overlap = (sets) => sets.filter(s => reqMons.some(m =>
        speciesId(String(m.details || '').split(',')[0].trim()) === speciesId(s.species))).length;
      const best = all.slice().sort((x, y) => overlap(y.sets) - overlap(x.sets))[0];
      out.diffs = best ? nearMiss(best.sets, reqMons) : [];
      out.nearest = best ? best.name + '（' + overlap(best.sets) + '/' + reqMons.length + ' 只对得上）' : null;
    } catch (e) { out.diffs = []; out.nearest = null; }
    out.why = '本地 ' + all.length + ' 套队里没有和第 1 段特征（物种/道具/特性/4 招）相符的' +
      (out.nearest ? '；最接近的是「' + out.nearest + '」，差异：' + out.diffs.join('，') : '');
    return out;
  }

  // ── 第 2 段：用对局里的最终数值核对
  const level = levelOf(reqMons);
  const usable = statsUsable(reqMons);
  const scored = [];
  if (usable) {
    const want = reqStatsLine(reqMons);
    for (const c of cands) {
      out.statChecked++;
      let got = null;
      try { got = c.sets.map(s => statLine(s, level)).sort().join('|'); }
      catch (e) { got = null; }
      if (got === null) { out.statFailed++; continue; }
      if (got === want) scored.push(c);
    }
  }

  const tag = relaxed ? '(放宽形态)' : '';
  if (scored.length === 1) {
    out.sets = scored[0].sets; out.picked = scored[0].name;
    out.source = 'local-数值核对通过' + (cands.length > 1 ? '(' + cands.length + '套撞车)' : '') + tag;
    return out;
  }
  if (scored.length > 1) {
    // 多套都能复现同一组数值 ⇒ 它们的 nature/EV 组合在 calc 眼里【完全等价】（calc 只吃最终数值）
    out.sets = scored[0].sets; out.picked = scored[0].name; out.equivalent = true;
    out.source = 'local-等价多解(' + scored.length + '套数值相同)' + tag;
    return out;
  }

  // 一套都对不上（或数值根本不可用 / 算不出来）：
  //   先判断「我们的数值模型跟这个规则合不合得来」—— 合得来就说明这些本地队不是这一局用的。
  const fits = usable && !out.statFailed && (!modelFits || reqMons.every(m => {
    try { return !!modelFits(m); } catch (e) { return false; }
  }));
  if (fits) {
    out.why = cands.length + ' 套本地队特征相符，但最终数值一套也对不上 —— 它们【不是】这一局用的队';
    return out;
  }
  // 模型不兼容（L50 / Champions 的数值系统）：核对本身失效。
  // 此时「唯一解」仍然比反解强（反解在这种规则下直接放弃、努力值全 0），所以用它并标注。
  if (cands.length === 1) {
    out.sets = cands[0].sets; out.picked = cands[0].name;
    out.source = 'local-唯一(数值无法核对)' + tag;
    return out;
  }
  out.why = cands.length + ' 套本地队特征相符，且这个规则的数值我们核对不了 —— 无法消歧，改走反解';
  return out;
}

/**
 * 把本地那套队【对齐】到 request 的顺序，并合并成我们的 set 格式：
 *   nature / evs / ivs 取本地的（精确）；species / item / ability / moves / teraType 取 request 的（权威）。
 * 对不上的那一只 _localHit=false（调用方要看得见，不许静默当成解出来了）。
 */
export function alignLocal(localSets, reqMons) {
  const pool = localSets.slice();
  return reqMons.map(m => {
    const sp = String(m.details || m.species || '').split(',')[0].trim();
    const want = sigOfRequest([m], false), wantLoose = sigOfRequest([m], true);
    let i = pool.findIndex(s => sigOf([s], false) === want);
    if (i < 0) i = pool.findIndex(s => sigOf([s], true) === wantLoose);
    const hit = i >= 0 ? pool.splice(i, 1)[0] : null;
    return {
      species: sp,
      // ★★ request 发的是【ID】，下游（@smogon/calc / 中文表 / 道具判读）要的是【显示名】。★★
      //   不转的后果【静默且严重】：实测 calc 对 item:'choicespecs' 和「不给道具」算出同一个数
      //   （冰冻光束 163 vs 163，显示名是 244）—— 也就是我们全队的道具会被无声无息地忽略掉。
      //   serve.mjs 的 setFromRequest 一直是转的，这里当初漏了。
      item: idName('items', m.item),
      ability: idName('abilities', m.ability || m.baseAbility),
      moves: (m.moves || []).map(x => idName('moves', x)).filter(Boolean),
      teraType: idName('types', m.teraType),
      nature: hit ? (hit.nature || 'Serious') : null,
      evs: hit ? (hit.evs || null) : null,
      ivs: hit ? (hit.ivs || null) : null,
      _localHit: !!hit,
    };
  });
}
