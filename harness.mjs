#!/usr/bin/env node
// 对战 harness —— 把「我的判断策略」固化成代码 + Jev 问题。
//
// 分工（这是关键）：
//   代码 = 算事实（伤害/几确/免疫/速度/先制），以及执行动作
//   Jev  = 做模糊判断（该攻击还是该换人、打谁）
//
// 用法:
//   node tools/harness.mjs <state.json>            # 调 Jev（需 TYPESAFE_API_KEY）
//   node tools/harness.mjs <state.json> --mock     # 不联网，验证流程
//   node tools/harness.mjs --demo --mock           # 用内置示例局面
import { readFileSync } from 'node:fs';

const { calculate, Generations, Pokemon, Move, Field } = await import('@smogon/calc');
const { Dex } = await import('@pkmn/dex');
const { askJev, askJevMock, jevAvailable } = await import('./jev.mjs');
const { zhInfo, paradoxMult: paradoxMultRaw, PARADOX_MULT } = await import('./toolkit/tools/lib.mjs');
// 太晶属性名走项目自己的中文数据源（data/zh-ps.json），不另起一张手写表
const typeZh = (t) => zhInfo('types', t).zh || t;

const g = Generations.get(9);
const FIXED = ['Seismic Toss', 'Night Shade', 'Super Fang', 'Ruination'];

// ★ 中文描述里带换行是常事（实测 zh-ps 的剑舞 shortDesc 是「自身的攻击提高2级。\n」），
//   直接拼进面板会变成两行、多一个孤零零的「）。」。面板是纯文字、逐行显示的，必须压成一行。
const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// 把 @smogon/calc 的 damage 结果统一成【扁平的一维乱数数组】。
// ★★ 多段招返回的是嵌套数组（每个命中次数一组乱数），直接 Math.max(...) 会得到 NaN。★★
//   实测：三旋击 multihit:3 → [[1下×16档],[2下×16档],[3下×16档]] = 18-22 / 35-42 / 51-61。
//   以前这段逻辑被复制了三份（攻击面板 / 对手威胁 / 换人换入伤害），所以【三处都是坏的】：
//   种子机关枪、三旋击、鼠数儿、水流喷射、鳞射这些招会显示「NaN-NaN%，需 NaN 回合」，且不报错。
function damageRolls(r) {
  const dm = r.damage;
  if (!Array.isArray(dm)) return [dm, dm];
  if (!Array.isArray(dm[0])) return dm;
  // ★★ 二维数组是【每一下一组 16 档乱数】—— 总伤害 = 各下【逐档相加】，得 16 档合计。★★
  //   ⚠️ 以前这里是 dm.flat()。它不报错，但语义是错的：给你的是【单下】的区间，
  //      不是总伤害。实测（种子机关枪 3 下 vs 盐石巨灵）：flatten 得 56-68（单下），
  //      真实总伤害是 168-204（49-60%）。于是 expPct 只有真值的 1/3、
  //      koRolls 恒为 0 —— 多段招的几确和击杀概率【整类都是错的】，而且一声不吭。
  //   与 toolkit/tools/lib.mjs 的 damageRolls 是同一套口径（那边返回 total + perHit 两个）。
  const n = Math.max(...dm.map(g => g.length));
  const total = [];
  for (let i = 0; i < n; i++) total.push(dm.reduce((s, g) => s + (g[i] ?? g[g.length - 1]), 0));
  return total;
}

// ★ boosts 必须传：对手开了剑舞/破壳/诡计之后，不传等于按 +0 算，伤害会严重低估。
//   state 里对方的能力等级来自日志的 |-boost|/|-unboost|（log2state 已解析）。
const setOf = (s) => {
  const o = { level: 100, nature: s.nature, evs: s.evs, item: s.item, ability: s.ability };
  // ★ s.teraType 的含义是【这只已经太晶了】——@smogon/calc 0.12 里给 set 加 teraType 即视为已太晶。
  //   「还能太晶」是另一回事（s.teraAvailable），绝不能同时传进来，否则伤害凭空 ×1.333。
  if (s.teraType) o.teraType = s.teraType;
  if (s.boosts && Object.keys(s.boosts).length) o.boosts = s.boosts;
  // ★★ 属性被改过（变幻自如 Protean / 自由自在 Libero / 保护色…）★★
  //   不覆盖的话，防御面全部按【基础属性】算 —— 实测（battle-20261001-225012，
  //   魔幻假面喵先变虫、后变恶）：
  //     吃 Drain Punch(格)：基础 草/恶 = 130-154 ｜ 变纯恶 = 260-308（翻倍）｜ 变纯虫 = 65-77（一半）
  //     吃 Brave Bird(飞)：基础 = 308-366 ｜ 变纯恶 = 154-183（一半）
  //   同一次实测确认 @smogon/calc 认 overrides.types，不传就是错的。
  //   ⚠️ 这是【唯一的注入点】—— 三个 calculate() 调用点都走 mk() → setOf()，
  //      所以只要这里接上，moveFeature / switchFeature / hitOnMe 三处一起生效，
  //      不会出现「真事实只放在一边」那种一边对一边错。
  //   ⚠️ 太晶之后属性就是太晶属性，此时【不要】再用 typechange 覆盖（会盖掉太晶，变成双重真相）。
  if (s.types && s.types.length && !s.teraType) o.overrides = { types: s.types };
  return o;
};

// ★★ 形态名归一化（实测重大 bug）★★
// Showdown 日志里的名字可能是 @smogon/calc 不认的形态：
//   实测 new Pokemon(g, 'Minior-Violet') 直接抛 "Cannot read properties of undefined (reading 'hp')"，
//   而 Minior / Minior-Meteor 正常。后果极其严重 —— moveFeature 的 catch 会 return null，
//   buildQuestion 再静默丢弃，导致该对手在场时【我方所有攻击选项全部消失】，
//   只剩状态招和换人，于是模型只能一直推荐「隐形岩」。
// 策略：先试原名；失败就逐步砍掉末尾的 -Xxx 段，直到能构造为止。
const _calcNameCache = new Map();
function calcName(species) {
  const k0 = String(species);
  if (_calcNameCache.has(k0)) return _calcNameCache.get(k0);
  const parts = k0.split('-');
  let out = null;
  for (let i = parts.length; i >= 1; i--) {
    const cand = parts.slice(0, i).join('-');
    try { new Pokemon(g, cand, { level: 100 }); out = cand; break; } catch (e) {}
  }
  _calcNameCache.set(k0, out);
  return out;
}
const mk = (species, s = {}) => new Pokemon(g, calcName(species) || species, setOf(s));

// ---------- 0) 「打不死」的机制（挡下 / 留 1 血） ----------
// ★★ 哪些 @smogon/calc 已经建模、哪些没有 —— 【实测过，别再猜】：★★
//   ✅ 已建模（千万不要自己再算一遍，否则会双重减半）：多重鳞片 Multiscale、幻影防守 Shadow Shield
//        实测：快龙吃暗影球 199-235 → 带多重鳞片 99-117（正好一半）
//   ❌ 没建模（必须自己补）：
//        画皮 Disguise / 结冻头 Ice Face —— 挡下第一击，改扣 1/8 最大 HP
//        结实 Sturdy / 气势披带 Focus Sash —— 满血时被打倒就留 1 血
//        实测：盐石巨灵带结实 / 带披带，calc 给的都是 654-770，和不带一模一样
//   引擎源码（pokemon-showdown/dist/data/，行号可按名字搜）：
//     abilities.js sturdy    onDamagePriority:-30  hp===maxhp && damage>=hp && 来自招式 → hp-1
//     items.js     focussash onDamagePriority:-40  同上条件，且消耗道具
//     abilities.js disguise  onDamagePriority:1    → 返回 0；onUpdate 里再扣 baseMaxhp/8
//     abilities.js iceface   onDamagePriority:1    同上，但只挡物理
//   优先级数值大的先结算：画皮(1) > 结实(-30) > 披带(-40) —— 所以被挡下时结实不会触发。
const BLOCK_ABILITY = {
  disguise: { zh: '画皮', physicalOnly: false },
  iceface: { zh: '结冻头', physicalOnly: true },
};

// 本击会生效的「打不死」机制。defenderSet.intact === false 表示画皮/结冻头已经用掉了
// （由 log2state 解析 |-activate|…|Disguise 得出）；缺省视为「还没用」——宁可多警告一次。
function firstHitEffects(defenderSet, moveCategory, defenderHpPercent, moveName) {
  const out = [];
  const set = defenderSet || {};
  const ab = Dex.abilities.get(set.ability || '');
  const abId = ab.exists ? ab.id : null;
  // 用掉的道具在 log2state 里被写成 '(已消耗) Xxx' —— 不能当成还在身上
  const rawItem = String(set.item || '');
  const itemId = rawItem.startsWith('(') ? '' : rawItem.toLowerCase().replace(/[^a-z]/g, '');
  const atFull = (defenderHpPercent == null ? 100 : defenderHpPercent) >= 100;

  const b = BLOCK_ABILITY[abId];
  if (b && set.intact !== false && (!b.physicalOnly || moveCategory === 'Physical')) {
    out.push({ kind: 'block', zh: b.zh });
  }
  // ★ 结实/披带只对【单体命中】有效：多段招第一段留 1 血，第二段照样打死。
  const mv = Dex.moves.get(moveName);
  const multiHit = !!(mv.exists && mv.multihit);
  if (atFull && !out.length && !multiHit) {
    if (abId === 'sturdy') out.push({ kind: 'endure', zh: '结实' });
    else if (itemId === 'focussash') out.push({ kind: 'endure', zh: '气势披带' });
  }
  return out;
}

// 这一击（已经算出来能打倒它）会不会被挡下/留 1 血
function survivesFirstHit(set, category, hpPercent, moveName) {
  return firstHitEffects(set, category, hpPercent, moveName).length > 0;
}

// ---------- 0.9) 古代活性 / 夸克充能（含驱动能量）----------
// ★ 它把它【最高的一项】×1.3，速度 ×1.5；而 @smogon/calc **完全没建这个**。
//   实测（不要凭印象，这是跑出来的）：大伟牙 252 攻 Adamant 猛进 vs 盐石巨灵，
//     不给 / ability:'Protosynthesis' / item:'Booster Energy' / 两者都给
//   —— 四种写法的伤害**一模一样**（全是 260-308 = 64.4%），Atk 也一直是 397。
//   连同「构造后改 stats.atk / rawStats.atk 也不生效」也试过了（calc 会忽略）。
//   唯一被认的是 overrides.baseStats，但那是改种族值，跟「最终数值 ×1.3」不是一回事。
//
//   引擎实现：abilities.js 的 onModifyAtk → chainModify([5325, 4096])，即该项 ×1.30005；
//   速度那一档是 chainModify(1.5)。所以这里在算完伤害后按同一倍率缩放 ——
//   唯一的误差来自伤害公式里那一次 floor，实测 <1%（这条 30% 的错先修掉更重要）。
//   ★ 倍率与「哪一项被提」的判定走 toolkit 的同一份实现（lib.mjs 的 PARADOX_MULT /
//     paradoxMult）—— 两边各写一份必然漂移，而漂移的方向是「面板和 CLI 给出不同数字」。
//     这里只做一层适配：把 set 上的 paradox 字段拆出来传进去。
//     自检：node _verify-paradox.mjs（我们乘了没有 + 真跑 80 局引擎对拍）。
function paradoxMult(attackerSet, defenderSet, moveName, category) {
  return paradoxMultRaw(attackerSet && attackerSet.paradox, defenderSet && defenderSet.paradox,
    moveName, category);
}

// koTier（机器可读的短档位）→ 中文短语。**拼句子只能用这个，不能用 verdict**：
// verdict 是整句（可能带上替身/画皮那一长串），拿它拼会得到重复又读不通的句子，
// 而且所有「verdict === 可一击必杀」之类的判断会静默失效。
const TIER_ZH = {
  immune: '无效（免疫）', '1HKO': '可一击必杀', likely: '大概率一击必杀',
  multihit: '多段招（看命中几下）', endure: '满血时留 1 血', blocked: '被挡下',
  'sub-break': '只能打掉替身', 'sub-nobreak': '连替身都打不破',
};
const tierZh = (t) => TIER_ZH[t] ||
  ((/^(\d+)回合$/.exec(String(t || ''))) ? '需 ' + RegExp.$1 + ' 回合' : String(t || '未知'));

// ---------- 0.95) 替身 ----------
// 目标身上有没有替身、这一发会不会被它吃掉。没有替身返回 null。
//   基准：替身血量 = floor(最大血 / 4)（引擎 moves.js:18365）。
//   d = 这一发的乱数数组（单段招就是 16 档；多段招已经在 damageRolls 里合成合计）。
function subInfoOf(defender, defenderSet, m, attackerSet, d, multiHit) {
  if (!defenderSet || !defenderSet.sub) return null;
  if (m.category === 'Status') {
    // 状态招打不到有替身的对手（自身/场地招除外）—— 引擎里同样走 onTryPrimaryHit 的拦截
    if (m.target === 'self' || m.target === 'allySide' || m.target === 'allyTeam' ||
        m.target === 'foeSide' || m.target === 'all' || m.target === 'field') return null;
    return { hp: 0, hpPct: 0, blocks: true, bypass: false, oneShot: false, dmg: 0,
      turnsTotal: null, why: '状态招打不到替身' };
  }
  const hp = mk(defender, defenderSet).stats.hp;
  const subHp = Math.floor(hp / 4);
  const bypass = !!(m.flags && m.flags.bypasssub) ||
    ((attackerSet && attackerSet.ability) === 'Infiltrator');
  if (bypass) return { hp: subHp, hpPct: Math.round(subHp / hp * 100), blocks: false, bypass: true,
    oneShot: false, dmg: Math.max(...d), turnsTotal: null,
    why: (m.flags && m.flags.bypasssub) ? '音波招式穿替身' : '穿透特性穿替身' };
  const dmg = Math.max(...d);                    // 最坏乱数下能打出多少点
  const oneShot = dmg >= subHp;                  // 这一发够不够打掉替身
  // 几回合：先花掉打替身的回合数，再按本体血量算。替身打掉后剩下的几下（多段招）直接算进本体。
  const subTurns = oneShot ? 1 : Math.max(1, Math.ceil(subHp / Math.max(dmg, 1)));
  let bodyTurns = Infinity;
  const hi = Math.max(...d);
  if (hi > 0) bodyTurns = Math.max(1, Math.ceil(100 / (hi / hp * 100)));   // 替身打掉之后，本体还要几下
  return { hp: subHp, hpPct: Math.round(subHp / hp * 100), blocks: true, bypass: false, oneShot,
    dmg, turnsTotal: Number.isFinite(subTurns + bodyTurns) ? subTurns + bodyTurns : null,
    why: oneShot ? '这一发够打掉替身，但打不到本体' : '连替身都打不破' };
}

// ---------- 1) 事实计算 ----------
// tera = 「这一发用太晶属性 X 打出去」。@smogon/calc 0.12 起支持：给 set 加 teraType 即视为已太晶，
//   我方防御属性同时改变。0.11.0 完全不支持（写 teraType 被静默忽略，算出来和没太晶一样）。
//   ★ 本系加成的准确规则见 analyzeTera() 顶部（太晶成【自己原有属性】才是 2.0 倍）。
//     这里曾写成「与本系不同时 2.0」，是反的 —— 别再写第二遍。
function moveFeature(attacker, attackerSet, defender, defenderSet, mvName, hpPercent, tera) {
  const m = Dex.moves.get(mvName);
  if (!m.exists) return null;
  const isFixed = FIXED.includes(m.name);
  const atkSet = tera ? { ...attackerSet, teraType: tera } : attackerSet;
  if (m.category === 'Status' && !isFixed) {
    return { id: 'move:' + m.id, name: m.name, moveName: m.name, kind: 'status', priority: m.priority || 0,
      note: '状态招，不造成伤害' };
  }
  let r;
  try { r = calculate(g, mk(attacker, atkSet), mk(defender, defenderSet), new Move(g, m.name), new Field({ gameType: 'Singles' })); }
  catch (e) { return null; }
  const multiHit = Array.isArray(r.damage) && Array.isArray(r.damage[0]);
  // ★ 古代活性/夸克充能：calc 不建，自己按同一倍率缩放（见 paradoxMult 顶部）
  const _pm = isFixed ? 1 : paradoxMult(atkSet, defenderSet, m.name, m.category);
  const d = damageRolls(r).map(x => Math.round(x * _pm));
  const hi = Math.max(...d), lo = Math.min(...d);
  const hp = mk(defender, defenderSet).stats.hp;
  const pctHi = hi / hp * 100, pctLo = lo / hp * 100;
  const remain = hpPercent == null ? 100 : hpPercent;
  const turnsToKO = hi === 0 ? Infinity : Math.max(1, Math.ceil(remain / pctHi));

  // ★ KO 概率与期望伤害（含命中率）——此前只看 pctLo/pctHi 是错的：
  //   ① 只看区间等于假设必中，把 85% 命中的大字爆炎和 100% 的突飞猛进当同一回事；
  //   ② 「74-87%」和一个「50% 概率秒杀」的招没法比，必须化成同一个量纲。
  //   实测对拍：本函数用的 16 档乱数与 @pkmn/sim 引擎实跑一致（74.0-87.0% vs 74.2-87.3%）。
  const acc = (m.accuracy === true || m.accuracy == null) ? 100 : m.accuracy;
  const need = hp * remain / 100;                       // 打掉对手当前血量所需伤害
  const koRolls = d.filter(x => x >= need).length;      // 16 档里能击杀的档数
  const koChance = (koRolls / d.length) * (acc / 100);  // 真实击杀概率（含未命中）
  const expPct = ((d.reduce((a, b) => a + b, 0) / d.length) * (acc / 100)) / hp * 100; // 期望伤害%

  // ★★ 替身：目标有替身时，这一发的伤害【全部打在替身上】，而且超出部分【不结转】。★★
  //   引擎源码 data/moves.js:18358-18401（substitute 的 onTryPrimaryHit）：
  //     · 替身血量 = Math.floor(maxhp / 4)
  //     · damage > 替身剩余血量 时【截到替身剩余血量】——多出来的不会打到本体
  //     · 三种情况不吃替身：target === source / move.flags.bypasssub（音波招式）/ move.infiltrates（穿透特性）
  //     · 替身被打掉后，同一个多段招的【后续几下】会打到本体（每一下都是一次独立的主判定）
  //   不处理它的后果实测过（2026-09-27 battle-20260927-115708 t13/t14）：
  //   对手天蝎王替身档在场上（88% 血），面板照写「Kowtow Cleave 打掉约 72-84% 血，大概率一击必杀」——
  //   而那一发只打掉了替身，它本体一点血都没掉。
  const sub = subInfoOf(defender, defenderSet, m, atkSet, d, multiHit);
  if (sub && sub.blocks) {
    // 这一手打不到本体：verdict / 几确全部改成「先破替身」的口径
    const verdictSub = sub.oneShot
      ? '⚠️ 它有【替身】（' + sub.hp + ' 点 = 它最大血的 ' + sub.hpPct + '%）：你这一发【只会把替身打掉】，它本体一点血都不掉' +
        (multiHit ? '（多段招会打穿替身，剩下的几下才打到本体）' : '')
      : '⚠️ 它有【替身】（' + sub.hp + ' 点 = 它最大血的 ' + sub.hpPct + '%）：你这一发 ' +
        sub.dmg + ' 点【连替身都打不破】，它本体一点血都不掉';
    return { id: 'move:' + m.id, name: m.name, moveName: m.name, tera: tera || undefined,
      kind: 'move', type: m.type, category: m.category,
      bp: m.basePower, accuracy: acc, priority: m.priority || 0,
      rawPctLo: pctLo, rawPctHi: pctHi, pctLo, pctHi,
      turnsToKO: sub.turnsTotal,
      verdict: verdictSub, koTier: sub.oneShot ? 'sub-break' : 'sub-nobreak',
      immune: false, kills: false, koChance: 0, expPct,
      multiHit, hits: multiHit ? r.damage.length : 1, rolls: d.length,
      subBlocked: true, sub };
  }

  // ★ 画皮 / 结冻头：这一击实际伤害为 0，只掉 1/8 血。必须覆盖上面的计算器结果，
  //   否则下游会拿到「125-148% 可一击必杀」这种假事实。
  const effects = firstHitEffects(defenderSet, m.category, remain, m.name);
  const block = effects.find(e => e.kind === 'block');
  if (block) {
    return { id: 'move:' + m.id, name: m.name, moveName: m.name, tera: tera || undefined,
      kind: 'move', type: m.type, category: m.category,
      bp: m.basePower, accuracy: m.accuracy, priority: m.priority || 0,
      rawPctLo: pctLo, rawPctHi: pctHi, pctLo: 0, pctHi: 0, turnsToKO: Infinity,
      verdict: '被【' + block.zh + '】挡下：这一击伤害为 0，只掉 1/8（约 ' + Math.round(hp / 8) + ' 血），打不死它',
      koTier: 'blocked',
      immune: false, blockedBy: block.zh, kills: false, koChance: 0, expPct: 0, rolls: d.length };
  }

  // ★ verdict 是【给人看的整句】，koTier 是【给代码拼句子用的短档位】，两个必须分开。
  //   把 verdict 拼进别的句子会得到「只能打掉替身 → 只能打掉替身」这种垃圾，
  //   而且下游那些 verdict === '可一击必杀' 的判断会【静默失效】——
  //   2026-09-27 加替身时真踩过一次：强化选项的收益行变成了两句替身警告拼在一起。
  let verdict, koTier;
  if (hi === 0) { verdict = '无效（免疫）'; koTier = 'immune'; }
  else if (multiHit && pctLo >= remain) { verdict = '可一击必杀（最坏命中数也够）'; koTier = '1HKO'; }
  else if (multiHit && pctHi >= remain) { koTier = 'multihit';
    verdict = '打掉约 ' + pctLo.toFixed(0) + '-' + pctHi.toFixed(0) +
    '% —— 多段招，能不能杀取决于命中几下，不是准数'; }
  else if (pctLo >= remain) { verdict = '可一击必杀'; koTier = '1HKO'; }
  else if (pctHi >= remain) { verdict = '大概率一击必杀'; koTier = 'likely'; }
  else { verdict = '需 ' + turnsToKO + ' 回合'; koTier = turnsToKO + '回合'; }

  // ★ 结实 / 气势披带：满血时【任何乱数档】都会被截成「留 1 血」。
  //   不覆盖 verdict 的后果实测过：面板会对一只带披带的宝可梦报「打掉约 104-122% 血，可一击必杀」。
  let kills = pctLo >= remain, kc = koChance;
  const endure = effects.find(e => e.kind === 'endure');
  if (endure && pctHi >= remain) {
    kills = false; kc = 0; koTier = 'endure';
    verdict = '但它满血时打不死 —— 【' + endure.zh + '】会留它 1 血（先削掉一点血，这个就没了）';
  }
  return { id: 'move:' + m.id, name: m.name, moveName: m.name, tera: tera || undefined,
    kind: 'move', type: m.type, category: m.category,
    bp: m.basePower, accuracy: acc, priority: m.priority || 0,
    pctLo, pctHi, turnsToKO, verdict, koTier, immune: hi === 0, kills,
    enduredBy: endure ? endure.zh : undefined,
    multiHit, hits: multiHit ? r.damage.length : 1,
    koChance: kc, expPct, rolls: d.length,
    // ★ 目标有替身但被【穿过去】时，这里也要带上，否则下游只看到「伤害正常」而不知道有替身
    ...(sub ? { sub } : {}) };
}

// ★ 换人选项必须同时给出【吃多少】和【能打多少】。
//   只给"要吃的伤害"会造成一个致命后果：打不动对手时，换人永远显得比出招划算，
//   而换出去再换回来是对称的 ⇒ 策略陷入无限换人循环（实测真的发生了：
//   switch:alomomola → switch:greattusk → switch:alomomola → …  一直换到 140 回合）。
//   这个洞同时坑了 Jev（选项文案缺事实）和 myPolicy（打分缺一项）。
function switchFeature(mySet, oppSets, oppRevealedMoves, species, oppActiveSp, oppActiveHp, hpPercent, risk) {
  // 上场要吃的伤害：用对手已知招式里打它最痛的那招估
  let worst = null;
  let priorityWorst = null; // 单独记「先制招」——换上来同样躲不掉先制
  // ★ 换上来这一回合能打到它的，只有【对手场上那一只】。把后排也算进来会凭空造威胁。
  const sources = oppActiveSp ? [oppActiveSp] : Object.keys(oppSets || {});
  const inHp = mk(species, mySet).stats.hp;      // 每次循环都重算同一个值，提到外面
  for (const oppSp of sources) {
    const moves = (oppRevealedMoves && oppRevealedMoves[oppSp]) || [];
    for (const mv of moves) {
      const m = Dex.moves.get(mv);
      const isPri = m.exists && (m.priority || 0) > 0;
      try {
        const r = calculate(g, mk(oppSp, oppSets[oppSp] || {}), mk(species, mySet), new Move(g, mv), new Field({ gameType: 'Singles' }));
        // 古代活性/夸克充能：对手提了攻、或我们这只提了防，都要算进去
        const pm = paradoxMult(oppSets[oppSp] || {}, mySet, m.name, m.category);
        const pct = Math.round(Math.max(...damageRolls(r)) * pm) / inHp * 100;
        if (!worst || pct > worst.pct) worst = { pct, mv, from: oppSp };
        if (isPri && (!priorityWorst || pct > priorityWorst.pct)) priorityWorst = { pct, mv, from: oppSp, priority: m.priority };
      } catch (e) {}
    }
  }
  // ★ 换上来之后能打多少：它自己的招式打对手【当前】宝可梦最优的一发
  let myOutput = null;
  if (oppActiveSp) {
    const oppActiveSet = (oppSets && oppSets[oppActiveSp]) || {};
    for (const mv of (mySet.moves || [])) {
      const f = moveFeature(species, mySet, oppActiveSp, oppActiveSet, mv, oppActiveHp);
      if (f && f.kind === 'move' && (!myOutput || (f.expPct || 0) > (myOutput.expPct || 0))) myOutput = f;
    }
  }
  // ★ 如果对手很可能换人，你换上来的这只实际要对上的是【它换上来的那一只】，不是它场上这只。
  //   换人决策和强化决策一样，必须按「对手换 / 不换」两个走向分别给数。
  let vsAnswer = null;
  if (risk && risk.answer) {
    const ansSp = risk.answer.species, ansSet = (oppSets || {})[ansSp] || {};
    let mine = null;
    for (const mv of (mySet.moves || [])) {
      const f = moveFeature(species, mySet, ansSp, ansSet, mv, 100);
      if (f && f.kind === 'move' && (!mine || (f.expPct || 0) > (mine.expPct || 0))) mine = f;
    }
    let theirs = null;
    for (const mv of (ansSet.moves || [])) {
      const f = moveFeature(ansSp, ansSet, species, mySet, mv, hpPercent == null ? 100 : hpPercent);
      if (f && f.kind === 'move' && (!theirs || (f.expPct || 0) > (theirs.expPct || 0))) theirs = f;
    }
    if (mine && theirs) {
      vsAnswer = { species: ansSp, myPct: mine.expPct || 0, myMove: mine.moveName,
        theirPct: theirs.expPct || 0, theirMove: theirs.moveName };
    }
  }
  return { id: 'switch:' + Dex.species.get(species).id, name: species, kind: 'switch',
    worst, priorityWorst, myOutput, vsAnswer, hpPercent: hpPercent == null ? 100 : hpPercent,
    myOutputPct: myOutput ? myOutput.expPct : null,
    myKoChance: myOutput ? myOutput.koChance : null,
    set: mySet };   // ★ 换人文案要判「它是不是撒钉手」，所以把 set 一起带出去
}

// ---------- 1.55) 先后手：本项目一直【没有认真算过】 ----------
// ★★ 实测（2026-09-26 第二局），代价非常直接：
//   · turn 4  面板说「冰冻光束 可一击必杀」，可 Inteleon 372 > Kyurem 317 ——
//             它先手一发 Snipe Shot 把 Kyurem 打死，那一手【根本打不出去】。
//   · turn 11 同样：Ogerpon 31% 对 Cyclizar 11%，面板说「拍落 可一击必杀」，
//             Cyclizar 先手 Dragon Claw，Ogerpon 倒下。
//   根因：原来的「本回合必死」只看【先制招】（lethal = priority > 0）——
//   普通招只要比你快、又能打死你，同样让这一手作废，而这一整类以前完全没人管。
//
// ⚠️ 速度只能【估】，必须把口径写进文案：@smogon/calc 0.12 没有 getFinalSpeed，
//   Pokemon.stats.spe 【不含】道具/能力等级/异常状态（实测：围巾、+2、麻痹三者都不变）。
//   所以这里自己补：能力等级 → 讲究围巾 → 麻痹 → 天气特性 → 夸克充能/古代活性 → 顺风。
//   补不齐的部分（对手的努力值来自使用率配置）必须在文案里说清楚，不能假装是精确值。
const SPEED_STAGE = (n) => (n >= 0 ? (2 + n) / 2 : 2 / (2 - n));
const WEATHER_ABILITY = {
  RainDance: 'Swift Swim', SunnyDay: 'Chlorophyll', Sandstorm: 'Sand Rush', Snow: 'Slush Rush',
};
function finalSpeedOf(sp, set, opts = {}) {
  let v = null;
  try { v = mk(sp, set).stats.spe; } catch (e) { return null; }
  if (!Number.isFinite(v)) return null;
  const stage = Math.max(-6, Math.min(6, ((set.boosts || {}).spe) || 0));
  if (stage) v = Math.floor(v * SPEED_STAGE(stage));
  if (set.item === 'Choice Scarf') v = Math.floor(v * 1.5);
  if (opts.status === 'par') v = Math.floor(v * 0.5);
  const wa = WEATHER_ABILITY[opts.weather];
  if (wa && set.ability === wa) v *= 2;
  if (opts.speedFlag) v = Math.floor(v * 1.5);
  if (opts.tailwind) v *= 2;
  return v;
}
// 对手用某一招打我方这套配置的伤害（% ，取最大乱数档）。
// ★ 这个算法原本被复制粘贴了三遍（威胁列表 / 换人的换入伤害 / 太晶前后的存活分析），
//   改一处忘一处 —— 实测就错过一次（后排的招被当成场上威胁）。现在只有这一份。
function hitOnMe(oppSp, oppSet, mySp, mySet, moveName) {
  const r = calculate(g, mk(oppSp, oppSet), mk(mySp, mySet), new Move(g, moveName), new Field({ gameType: 'Singles' }));
  const mv = Dex.moves.get(moveName);
  const pm = paradoxMult(oppSet, mySet, mv.name, mv.category);
  return Math.round(Math.max(...damageRolls(r)) * pm) / mk(mySp, mySet).stats.hp * 100;
}

// 对手【场上那一只】的威胁：已知招式里能打我方当前宝可梦多少，以及哪些是先制招。
// ★ 只算场上那一只 —— 后排的招这一回合打不到我们。曾经把后排也算进来，凭空造出「你会死」：
//   实测后排烈咬陆鲨的地震被当成威胁，让太晶分析以为「太晶幽灵能活命」，
//   面板于是在第 1 回合就建议用掉整局唯一一次太晶。
// ★ 另一条实战血泪仍然成立：先制招无视速度（我曾判断"你更快"，结果被影子偷袭秒杀）。
function opponentThreats(state) {
  const me = state.me, opp = state.opp;
  const mySet = me.active.set || {};
  const sp = opp.active && opp.active.species;
  if (!sp) return [];
  const set = (opp.sets && opp.sets[sp]) || {};
  const out = [];
  for (const mv of ((opp.revealedMoves && opp.revealedMoves[sp]) || [])) {
    const m = Dex.moves.get(mv);
    if (!m.exists) continue;
    let pct = null;
    if (m.category !== 'Status' || FIXED.includes(m.name)) {
      try { pct = hitOnMe(sp, set, me.active.species, mySet, m.name); } catch (e) {}
    }
    out.push({
      from: sp, move: m.name, priority: m.priority || 0,
      damage_percent_vs_our_active: pct == null ? null : Math.round(pct),
      // ★ 我方若有结实/披带/画皮，这一击其实打不死我们。不扣掉的话，
      //   面板会对「根本死不了」的局面喊「本回合必死」，把模型逼去做保守到错误的换手。
      kills_our_active: pct != null && pct >= me.active.hpPercent &&
        !survivesFirstHit(mySet, m.category, me.active.hpPercent, m.name),
    });
  }
  // 先制排前面
  return out.sort((a, b) => (b.priority - a.priority) || ((b.damage_percent_vs_our_active || 0) - (a.damage_percent_vs_our_active || 0)));
}

// ---------- 1.5) 太晶分析（攻/防两条线） ----------
// 太晶整局只能用一次，所以问题不是「太晶后这一发打多少」，而是「这唯一一次机会，
// 现在用掉值不值」。因此要同时把两条线算出来，缺一条就会误判：
//   进攻线 —— 太晶后哪一招收益最大（同系 STAB 1.5 → 2.0，实测正好 ×1.333）
//   防守线 —— 对手现在能一击打死我方的招，太晶换属性之后还打死吗（这才是太晶最常见的正确用法）
// 实测（0.12.0）：太晶超能打不动的局面，太晶妖精/钢换属性之后从「必死」变「扛得住」。
function analyzeTera(state, mySet, oppSet, threats) {
  const tera = mySet.teraAvailable;
  const teraSet = { ...mySet, teraType: tera };
  const mySp = state.me.active.species;
  const oppSp = state.opp.active.species;
  const hpNow = state.me.active.hpPercent;

  // ① 进攻线
  // ★ 必须逐招算：太晶 STAB 只对「和太晶属性同系」的招生效。
  //   如果 Jev 同时决定「太晶」和「出哪一招」，而这两件事分开回答，它很可能
  //   一边说太晶很好、一边又去点一个太晶根本不加成的招 —— 那这次太晶就白用了。
  //   所以把每一招的太晶收益都算出来，让两个答案能自己对上。
  const perMove = [];
  let best = null;
  for (const mv of (mySet.moves || [])) {
    const f = moveFeature(mySp, mySet, oppSp, oppSet, mv, state.opp.active.hpPercent);
    if (!f || f.kind !== 'move') continue;
    const t = moveFeature(mySp, mySet, oppSp, oppSet, mv, state.opp.active.hpPercent, tera);
    if (!t || t.kind !== 'move') continue;
    const row = { move: t.moveName, base: f.expPct || 0, tera: t.expPct || 0,
      gain: (t.expPct || 0) - (f.expPct || 0), baseVerdict: f.verdict, teraVerdict: t.verdict };
    perMove.push(row);
    if (!best || row.gain > best.gain) best = row;
  }

  // ② 防守线
  const survive = [];
  for (const t of threats) {
    if (!t.move) continue;
    const om = Dex.moves.get(t.move);
    if (!om.exists) continue;
    if (om.category === 'Status' && !FIXED.includes(om.name)) continue;
    let before = null, after = null;
    try {
      const atkSet = (state.opp.sets && state.opp.sets[t.from]) || {};
      before = hitOnMe(t.from, atkSet, mySp, mySet, om.name);
      after = hitOnMe(t.from, atkSet, mySp, teraSet, om.name);
    } catch (e) { continue; }
    if (before >= hpNow && !survivesFirstHit(mySet, om.category, hpNow, om.name)) {
      survive.push({ from: t.from, move: om.name, before, after, stillKills: after >= hpNow, priority: t.priority || 0 });
    }
  }
  survive.sort((a, b) => (b.priority - a.priority) || ((b.stillKills ? 0 : 1) - (a.stillKills ? 0 : 1)));
  // ★「质变」不能只看百分比涨了多少，要看是否跨过【击杀这一档】。
  //   实测：暗影球 24%→32%（+8 个百分点）看着是涨，其实只是「需 4 回合」变「需 3 回合」。
  const isBreakthrough = !!(best && best.teraVerdict === '可一击必杀' && best.baseVerdict !== '可一击必杀');

  // ★ 太晶的本系加成规则，【以引擎源码为准】，不凭记忆：
  //   sim 源 battle-actions.mjs:1713-1741（pokemon-showdown dist 同款 1473-1491）——
  //     isSTAB → stab = 1.5
  //     仅当 pokemon.terastallized === 招式属性 【且】 该属性在 getTypes(false, true)（=太晶前的原始属性）里 → stab = 2
  //   即：太晶成【自己本来就有的属性】才有 2.0 倍；太晶成【全新属性】只有 1.5 倍，
  //   而且原有属性的招式【仍然保留 1.5 倍，不会丢失】。
  //   实测对拍（@smogon/calc 0.12 与引擎一致）：
  //     赛富豪(钢/幽)太晶钢 + 淘金潮  770→1028（1.335 ≈ 2.0/1.5，= 2.0 倍）
  //     多龙(龙/幽)太晶火 + 大字爆炎  404→606 （1.500，= 1.5 倍）
  //     多龙(龙/幽)太晶火 + 流星群    179→179 （1.000，原属性本系没丢）
  //   ⚠️ 我此前把「本系 1.5 → 太晶 2.0」当成通用规则写进 instructions，用户当场指出。
  //      那句话会让 Jev 高估进攻型太晶，也会误以为太晶会丢本系。
  const origTypes = (Dex.species.get(mySp).types || []).slice();
  const origText = origTypes.map(typeZh).join('/') || '无';
  const stabNote = origTypes.includes(tera)
    ? '太晶属性「' + typeZh(tera) + '」本来就是你自己的属性 —— 与该属性同系的招式本系加成从 1.5 倍升到 2.0 倍，其余招式不变'
    : '太晶属性「' + typeZh(tera) + '」是【全新属性】—— 该属性的招式只拿 1.5 倍本系加成（和普通本系一样，不会变成 2 倍）；' +
      '你原有属性（' + origText + '）的招式仍然保留 1.5 倍本系加成，不会丢';

  return { type: tera, typeZh: typeZh(tera), best, perMove, survive, hpNow, isBreakthrough, stabNote,
    savedCount: survive.filter(x => !x.stillKills).length };
}

// 把太晶分析变成 Jev 的第二个问题。
// ★ 代价必须和收益写在同一句话里：Jev 这类模型的已知弱点是【只信具体标签、不信抽象规则】，
//   把「只能用一次」单独写成一条 instructions 它就会无视（实测画皮那次就是这么错的）。
function buildTeraQuestion(ti) {
  const parts = [];
  // ★ 判断「质变」不能只看百分比涨了多少，要看【是否跨过击杀这一档】。
  //   实测踩过：暗影球 24%→32%（+8 个百分点）看着是涨，其实「需 4 回合」只变成「需 3 回合」，
  //   为这点涨幅用掉整局唯一一次太晶是纯浪费。真正的质变是「打不死 → 一击必杀」。
  const b = ti.best;
  const isBreakthrough = ti.isBreakthrough;
  const gaining = (ti.perMove || []).filter(x => x.gain >= 1);
  if (b && b.gain >= 1) {
    parts.push('进攻：太晶后 ' + b.move + ' 从 ' + b.base.toFixed(0) + '% 提到 ' + b.tera.toFixed(0) +
      '%（+' + b.gain.toFixed(0) + ' 个百分点，' + b.baseVerdict + ' → ' + b.teraVerdict + '）——' +
      (isBreakthrough ? '这是【质变】：不太晶打不死，太晶能一击必杀'
        : '这【不是质变】：只是数字变大，击杀需要的回合数没有跨过关键的一档'));
    parts.push(gaining.length > 1
      ? '太晶的伤害提升【只作用于这些招】：' + gaining.map(x => x.move + ' +' + x.gain.toFixed(0) + ' 个百分点').join('、') +
        '。如果你打算点别的招，太晶在伤害上一点收益都没有'
      : '太晶的伤害提升【只作用于 ' + b.move + ' 这一招】。如果你打算点别的招，太晶在伤害上一点收益都没有');
    parts.push(ti.stabNote);
  } else {
    // ★ 这里原来写的是「太晶反而会丢掉本系加成」——【错的】。实测：太晶成新属性后，
    //   原有属性的招式仍然保留 1.5 倍本系加成（多龙太晶火 + 流星群 179→179）。不能再这么吓唬模型。
    parts.push('进攻：太晶不会让任何一招打得更痛（没有任何招与太晶属性「' + ti.typeZh + '」同系），' +
      '所以这次太晶是【纯防御】性质，与出哪一招无关');
    parts.push(ti.stabNote);
  }
  if (ti.survive.length) {
    parts.push('防守：对手现在能一击打死我方（当前 ' + ti.hpNow + '% 血）的招是 ' +
      ti.survive.slice(0, 3).map(x => x.from + ' 的 ' + x.move + '（现在打 ' + x.before.toFixed(0) +
        '%，太晶后 ' + x.after.toFixed(0) + '%' + (x.stillKills ? ' —— 照样被打死，太晶救不了' : ' —— 打不死了') + '）').join('；'));
  } else {
    parts.push('防守：目前已知的对手招式都不会一击打死我方，太晶在防御上也没有救命的必要');
  }
  const payoff = isBreakthrough || ti.savedCount > 0;
  return {
    tera: {
      type: 'choice',
      instructions:
        '太晶化【整场战斗只能用一次】，用掉就再也没有了。太晶后我方属性变成「' + ti.typeZh + '」，防御属性随之改变。' +
        ti.stabNote +
        '太晶是独立于出招的一步：宣告太晶之后，你照样可以点任何一个招。' +
        '①只有当太晶能带来质变时才选 use（把打不动变成打得动、把对方的一击必杀变成打不死、' +
        '把需要两回合压缩成一回合）；②仅仅多一点伤害不值得用掉这唯一的一次机会；' +
        '③如果收益不明确，选 save 留到后面。只回答 use 或 save。',
      criteria: {
        use: '【使用太晶】本回合宣告太晶，属性变为「' + ti.typeZh + '」。' + parts.join('。') +
          '。代价：这唯一的一次机会当场用掉，之后再也不会有了。' +
          (payoff ? '' : '【注意】按上面的计算，这次太晶在【当前局面没有明确的收益】（既不能把打不死变成一击必杀，' +
            '也不能让你从必死变成扛得住），用掉它大概率是浪费 —— 除非你判断有别的理由。'),
        save: '【保留太晶】本回合不用，继续留着，等你判断哪一回合太晶能直接定胜负时再用。',
      },
    },
  };
}

// ---------- 1.6) 强化招：把收益算成具体数字 ----------
const BOOST_ZH = { atk: '攻击', def: '防御', spa: '特攻', spd: '特防', spe: '速度', accuracy: '命中', evasion: '闪避' };

// 对手【场上那一只】现在打我最痛的一招（后排的招这一回合打不到我，不算）
function worstIncoming(mySp, mySet, threats, oppSets) {
  let worst = null;
  for (const t of threats) {
    if (!t.move) continue;
    const om = Dex.moves.get(t.move);
    if (!om.exists) continue;
    if (om.category === 'Status' && !FIXED.includes(om.name)) continue;
    try {
      const pct = hitOnMe(t.from, (oppSets && oppSets[t.from]) || {}, mySp, mySet, om.name);
      if (!worst || pct > worst.pct) worst = { pct, move: om.name, from: t.from };
    } catch (e) {}
  }
  // ★★ 我方有替身时，对手这一发【打不到我们本体】。★★
  //   不标出来的后果和「对手有替身」是一对镜像：面板会喊「本回合无论如何你都会吃一次攻击：62%」，
  //   可实际上那一发先打在替身上、你本体这一回合一点血都不掉 —— 「强化/换人值不值」整个算反。
  //   基准：替身最多还能吸收 floor(最大血/4)；日志【不公开】替身剩余血量，所以只能说「上限」。
  if (worst && mySet && mySet.sub) {
    const om = Dex.moves.get(worst.move);
    const bypass = !!(om.flags && om.flags.bypasssub) || (mySet.ability === 'Infiltrator');
    const selfOrField = ['self', 'allySide', 'allyTeam', 'foeSide', 'all', 'field'].includes(om.target);
    if (!bypass && !selfOrField && om.category !== 'Status') {
      worst.subbedByUs = true;
      worst.subbedPctMax = 25;
    }
  }
  return worst;
}

// ---------- 1.65) 对手换人的可能性 ----------
// ★ 为什么必须有它：强化技和换人这两件事的价值，几乎完全取决于【对手会不会换】。
//   · 它不换 → 你强化就是白挨一发，可能直接被打死
//   · 它换   → 你白赚一回合（不挨打还涨了能力），但它换上来的可能是专门挡你的那一只
//   所以「要不要强化 / 要不要换」绝不能只看对当前这一只的收益。
//
// ⚠️ 这个函数【不产出概率】。曾经用人工权重算过一个 0–1 的数并写进文案 —— 用户当场否掉：
//   那是把【先验】冒充成【事实】。判断换不换是模糊判断，归 Jev（见 buildOppSwitchQuestion）。
//   这里只负责一件事：把可算的事实分成「支持留场」「支持换人」两堆。
// ★★ 本回合【真正能点的招式】—— 唯一来源是 request.active[0].moves
//   （serve.mjs 已把它搬到 state.me.active.choices 上）。
//   讲究系列道具（围巾/头巾/眼镜）会把你锁在上一手招上：request 里其余三招 disabled=true。
//   引擎侧真相：sim 源 pokemon.mjs getMoveRequestData() → getMoves(lockedMove)。
//   实测：用了地震后 active[0].moves = [Earthquake, U-turn[禁用], Stealth Rock[禁用], Stone Edge[禁用]]。
//
//   ⚠️⚠️ side.pokemon[].moves / mySet.moves 永远是【完整 4 招、不带锁招信息】。
//   读它就会给出「客户端里点不下去」的建议。这个 bug 在 buildQuestion 里修过一次，
//   但 oppSwitchRisk 里【漏了】—— 实测（讲究眼镜锁住流星群、对面是妖精）：
//   面板的换人事实里写着「你 2 回合就能打死它（Ice Beam 一发打掉它最大血量的 66%）」，
//   而 Ice Beam 在客户端是灰的 ⇒ Jev 判定「我打得动，不用换」⇒ 点了一发完全无效的流星群。
//   这就是那条红线：真事实只放在一个地方修，另一个地方会继续用旧口径。
function legalMovesOf(state, mySet) {
  const ch = (state.me && state.me.active && Array.isArray(state.me.active.choices)
    && state.me.active.choices.length) ? state.me.active.choices : null;
  const legal = ch ? ch.filter(c => !c.disabled) : null;
  let list = (legal && legal.length) ? legal.map(c => c.name) : (mySet.moves || []);
  // ★ 全部 disabled 是异常状态。以前直接 throw，那一回合面板完全没有建议。
  //   现在退回队伍文件继续给建议，但【大声说明】这些建议不代表客户端真能点。
  let fallback = false;
  if (ch && !list.length) {
    fallback = true;
    list = (mySet.moves || []);
    console.log('[警告] request 说我方一招都点不了（active[0].moves 全部 disabled）—— 退回队伍文件继续给建议，数字仅供参考');
  }
  const locked = (ch && legal) ? ch.filter(c => c.disabled).map(c => c.name) : [];
  return { moveList: list, lockedAway: locked, moveFallback: fallback };
}
function oppSwitchRisk(state, mySet, oppSet, threats, moveList) {
  const meSp = state.me.active.species;
  const themSp = state.opp.active.species;
  const oppSets = state.opp.sets || {};

  // ① 我们打它场上这一只（用它当前血量算几确）
  let ourBest = null;
  let legalHit = false;   // 本回合能点的招里，有没有一招真能打出伤害
  // ⚠️ 只用【本回合真能点的招】—— 被讲究道具锁住的那三招在客户端是灰的。
  for (const mv of (moveList || mySet.moves || [])) {
    const f = moveFeature(meSp, mySet, themSp, oppSet, mv, state.opp.active.hpPercent);
    if (!f || f.kind !== 'move') continue;
    if (!f.immune) legalHit = true;
    if (!ourBest || (f.expPct || 0) > (ourBest.expPct || 0)) ourBest = f;
  }
  const noLegalDamage = !legalHit;
  // ② 它打我们（只算场上这一只 —— 后排这一回合打不到我们）
  const theirBest = worstIncoming(meSp, mySet, threats, oppSets);

  // ③ 对面后排里【最能挡住我们的那一只】：吃我们少 + 打我们多
  let answer = null;
  for (const sp of (state.opp.revealed || [])) {
    if (sp === themSp) continue;
    const set = oppSets[sp];
    if (!set) continue;
    const our = ourBest ? moveFeature(meSp, mySet, sp, set, ourBest.moveName, 100) : null;
    let their = null;
    for (const mv of (set.moves || [])) {
      const g2 = moveFeature(sp, set, meSp, mySet, mv, state.me.active.hpPercent);
      if (g2 && g2.kind === 'move' && (!their || (g2.expPct || 0) > (their.expPct || 0))) their = g2;
    }
    if (!our || !their) continue;
    const score = (their.expPct || 0) - (our.expPct || 0);
    if (!answer || score > answer.score) {
      answer = { species: sp, ourPct: our.expPct || 0, ourMove: our.moveName,
                 theirPct: their.expPct || 0, theirMove: their.moveName, score };
    }
  }
  const wallsUs = !!(answer && answer.ourPct < 40 && answer.theirPct > 25);

  const theirHazards = (state._hazards && state._hazards.theirs) || [];
  const turns = ourBest ? ourBest.turnsToKO : Infinity;

  // ★★ 这里【故意不给出概率】。★★
  //   「对手会不会换人」是模糊判断，不是可算事实。用我拍脑袋的权重算一个 0.45 出来，
  //   等于把【先验】冒充成【事实】—— 正是本项目红线里那条「假事实贴在最显眼的位置」。
  //   所以这里只做一件事：把【可以算的事实】分成「支持它留场」「支持它换人」两堆摆好，
  //   判断本身交给 Jev（见 questions.opp_switch），再让它用自己的判断去选招。
  const stayReasons = [], switchReasons = [];
  // ★ 「几回合打死」是按【当前血量】算的，「X%」是按【最大血量】算的 —— 两个数并排放会自相矛盾。
  //   实测：对手只剩 35% 血、Ivy Cudgel 一发打它最大血量的 35% ⇒ 文案变成
  //   「你 1 回合就能打死它（Ivy Cudgel 35%）」，读起来像「35% 就能打死」。
  //   修法是【把基准写出来】：一发打掉最大血量的 X%，它现在只剩 Y% 血。
  const oppHpNow = (state.opp && state.opp.active && state.opp.active.hpPercent != null)
    ? state.opp.active.hpPercent : null;
  // ⚠️ ourBest 可能是 null（我方这只在队伍数据里找不到 → set 成 {}，或所有招都算不出来）。
  //   这里原来无条件取 ourBest.moveName —— 一旦为 null 就【整个决策抛异常】，
  //   面板直接没有建议。本项目的红线是「失败必须可见」，但可见 ≠ 崩掉：
  //   找不到就写清楚，别让这一回合没有输出。
  const dmgNote = ourBest
    ? ourBest.moveName + ' 一发打掉它最大血量的 ' + (ourBest.expPct || 0).toFixed(0) + '%' +
      (oppHpNow != null ? '，它现在只剩 ' + Math.round(oppHpNow) + '% 血' : '')
    : '（算不出你这一手能打多少 —— 我方这只在队伍数据里没找到，或所有招都算不出来）';
  if (turns <= 2) switchReasons.push('你 ' + turns + ' 回合就能打死它（' + dmgNote + '）');
  else if (turns === 3) switchReasons.push('你 3 回合能打死它（' + dmgNote + '）');
  else stayReasons.push('你打它很慢（' + (ourBest ? ourBest.verdict : '未知') + '），它没有被打死的压力');

  if (theirBest) {
    if (theirBest.pct >= 40) stayReasons.push('它打你很痛（' + theirBest.move + ' ' + theirBest.pct.toFixed(0) + '%），留场能打出实打实的输出');
    else if (theirBest.pct < 25) switchReasons.push('它打你只有 ' + theirBest.pct.toFixed(0) + '%（' + theirBest.move + '），留场等于白送一个回合');
    else stayReasons.push('它打你 ' + theirBest.pct.toFixed(0) + '%（' + theirBest.move + '），留场不算亏');
  }
  if (wallsUs) {
    switchReasons.push('它后排的 ' + answer.species + ' 挡得住你（你只能打它 ' + answer.ourPct.toFixed(0) +
      '%，它反手 ' + answer.theirMove + ' 打你 ' + answer.theirPct.toFixed(0) + '%；⚠️它的配置是【按最常见配置推测】的，' +
      '不是真配置）—— 换人它有收益');
  } else if (answer) {
    stayReasons.push('它后排没有真正挡得住你的（最像的 ' + answer.species + ' 也要吃你 ' + answer.ourPct.toFixed(0) + '%），换上来一样难受');
  }
  if (theirHazards.length) stayReasons.push('它场上有 ' + theirHazards.join('/') + '，换人要吃钉子，有成本');
  // ★ 你这一回合能点的招【一点伤害都打不出】时，必须把它作为「支持它换人」的事实说出来。
  //   否则 opp_switch 只会看到「你打它很慢」，得出「它不用换」—— 那是被锁招制造出来的假象。
  if (noLegalDamage) switchReasons.push('你这回合能点的招【对它一点伤害都打不出】，它没有理由怕你 —— ' +
    '它反而有空间换上专挡你的那一只、或者趁机强化一次');

  return { stayReasons, switchReasons, answer, ourBest, theirBest, wallsUs, turns, theirHazards };
}

// 把「对手会不会换人」做成 Jev 自己的问题（第三个问题）。
// ★ 为什么不让代码直接给一个概率：见 oppSwitchRisk 里的说明 —— 那是拿先验冒充事实。
//   判断换不换本来就是模糊判断，正是 Jev 该干的活；代码只负责把可算的事实摆出来。
function buildOppSwitchQuestion(facts, state) {
  const themSp = state.opp.active.species;
  return {
    opp_switch: {
      type: 'choice',
      instructions:
        '估计对手这一回合【会不会换人】。这个判断决定了强化技和换人到底值不值：' +
        '它不换，你强化就是白挨一发；它换，你白赚一回合、但要面对它换上来的那一只。' +
        '下面两边列出的都是【可以算的事实】，换不换的判断由你自己下 —— 没有标准答案，只有理由的强弱。' +
        '如果两边理由都成立，就选 uncertain。只回答 stay / switch / uncertain。',
      criteria: {
        stay: '【它不会换人】继续用 ' + themSp + ' 和你打。支持这个判断的事实：' +
          (facts.stayReasons.length ? facts.stayReasons.join('；') : '（没有明显支持它留场的事实）'),
        switch: '【它会换人】换上它后排最能挡你的那一只' +
          (facts.answer ? '（' + facts.answer.species + '）' : '') + '。支持这个判断的事实：' +
          (facts.switchReasons.length ? facts.switchReasons.join('；') : '（没有明显支持它换人的事实）'),
        uncertain: '【说不准】两种都说得通。那就在出招时优先选【它换不换都不亏】的那一手，' +
          '不要把整回合押在对手换不换上。',
      },
    },
  };
}

// ★ 强化招必须贴上【具体数字】，否则模型永远不选它。
//   实测（用户当场指出「好像不会用强化来增强自己」）：原来 status 分支的文案只有
//   「剑舞（状态招，不造成伤害）」—— 一个数字都没有，而每个攻击选项都挂着百分比。
//   结果就是：有标签的永远赢，强化永远排最后。修法是给强化招也算出标签 ——
//   用完之后我最痛的一手能打多少（以及速度线、以及这一回合白挨多少）。
//   强化数据不用手写表：@pkmn/dex 的 Move 自带 boosts 与 target（剑舞 {atk:2}、龙之舞 {atk:1,spe:1}…）。
function setupFeature(meSp, mySet, oppSp, oppSet, mvName, oppHp, threats, oppSets, risk, myHp) {
  const m = Dex.moves.get(mvName);
  if (!m.exists || !m.boosts || m.target !== 'self') return null;
  const keys = Object.keys(m.boosts);
  if (!keys.length) return null;
  const merged = { ...(mySet.boosts || {}) };
  for (const k of keys) merged[k] = Math.max(-6, Math.min(6, (merged[k] || 0) + m.boosts[k]));
  const boosted = { ...mySet, boosts: merged };

  const bestOf = (s, tSp, tSet, tHp) => {
    let best = null;
    for (const mv of (mySet.moves || [])) {
      const f = moveFeature(meSp, s, tSp || oppSp, tSet || oppSet, mv, tHp == null ? oppHp : tHp);
      if (f && f.kind === 'move' && (!best || (f.expPct || 0) > (best.expPct || 0))) best = f;
    }
    return best;
  };
  const now = bestOf(mySet), after = bestOf(boosted);
  // ★ 必须另外算一个【同一招】强化后的值。
  //   强化之后「最痛的一手」可能换招（铁壁让扑击超过近身战），直接拿
  //   「现在最痛的招」比「之后最痛的招」，会得出「从 60% 提到 63%、提升很小」这种
  //   【把两招混在一起】的结论；而同一招的真实变化是「扑击 29% → 63%」。
  //   实测：这个 bug 让 Zamazenta 的铁壁在面板上看起来毫无价值。
  const sameAfter = now ? moveFeature(meSp, boosted, oppSp, oppSet, now.moveName, oppHp) : null;
  // ★ 逐招算「同一招的强化前后」，找出【受益最大】的那一招。
  //   纯防御强化（铁壁/冥想）时，「现在最强的一手」可能完全不受影响（近身战），
  //   真正受益的是另一招（扑击看防御）。只报「现在最强那招」的前后 = 把收益藏起来 ——
  //   实测：Zamazenta 的铁壁因此在面板上看起来毫无价值。
  let biggest = null;
  for (const mv of (mySet.moves || [])) {
    const b0 = moveFeature(meSp, mySet, oppSp, oppSet, mv, oppHp);
    const b1 = moveFeature(meSp, boosted, oppSp, oppSet, mv, oppHp);
    if (!b0 || !b1 || b0.kind !== 'move' || b1.kind !== 'move') continue;
    const gain = (b1.expPct || 0) - (b0.expPct || 0);
    if (!biggest || gain > biggest.gain) {
      biggest = { move: b1.moveName, before: b0.expPct || 0, after: b1.expPct || 0, gain,
        verdictBefore: b0.verdict, verdictAfter: b1.verdict,
      tierBefore: b0.koTier, tierAfter: b1.koTier,
        turnsBefore: b0.turnsToKO, turnsAfter: b1.turnsToKO };
    }
  }
  // ★ 强化【之后】去打对面最可能换上来的那一只 —— 这才是「这次强化到底有没有用」的关键。
  //   打当前这一只的收益是虚的：对手一换人，你面对的就是另一只（很可能是专门挡你的）。
  //   如果连 +2 都打不动它的挡子，那这次强化就是白给。
  const ansSp = (risk && risk.answer) ? risk.answer.species : null;
  const ansSet = ansSp ? (oppSets || {})[ansSp] : null;
  const nowVsAnswer = (ansSp && ansSet) ? bestOf(mySet, ansSp, ansSet, 100) : null;
  const afterVsAnswer = (ansSp && ansSet) ? bestOf(boosted, ansSp, ansSet, 100) : null;
  // ★★ 强化真正的价值在【它后面的那几只】，不在当前这一只。★★
  //   只算当前这一只时，netSave===0（回合打平）看起来像「强化没用」—— 而 instructions 里
  //   那条判据恰好写着「回合数没变 → 才不值得」⇒ 模型拿到的结论是【别强化】。
  //   实测（2026-09-26 ou-c 厄鬼椪 vs 满血天蝎王）：面板明明写了【不是亏】，
  //   Jev 还是给剑舞 0.22、棘藤棒 0.76。根因就是判据那一句把「打平」直接归进了「不值得」。
  //   而光写「会带到下一只」是空话 —— 「没有数字的选项 = 不存在的选项」是本项目第 4 次同坑。
  //   所以这里逐只算成数字：这个 +N 让对手后面几只的死法快了没有、快了多少。
  //   基准写死：对手满血（100）、按使用率配置估。
  const carry = [];
  for (const sp of Object.keys(oppSets || {})) {
    if (sp === oppSp) continue;
    const c0 = bestOf(mySet, sp, oppSets[sp], 100);
    const c1 = bestOf(boosted, sp, oppSets[sp], 100);
    if (!c0 || !c1) continue;   // 算不出来的不进结论 —— 它属于「没算出来」，不是「没收益」
    const t0 = c0.turnsToKO, t1 = c1.turnsToKO;
    const flip = t0 === Infinity && Number.isFinite(t1);
    const faster = Number.isFinite(t0) && Number.isFinite(t1) && t1 < t0;
    if (flip || faster) carry.push({ sp, move: c1.moveName, t0, t1, flip });
  }
  const speOf = (s) => { try { return mk(meSp, s).stats.spe; } catch (e) { return null; } };
  let oppSpe = null; try { oppSpe = mk(oppSp, oppSet).stats.spe; } catch (e) {}
  const zh = zhInfo('moves', m.name);
  return {
    move: m.name, zh: zh.zh, desc: oneLine(zh.shortDesc || zh.desc || ''),
    boosts: m.boosts,
    boostText: keys.map(k => (BOOST_ZH[k] || k) + ' ' + (m.boosts[k] > 0 ? '+' : '') + m.boosts[k]).join('、'),
    now: now ? { move: now.moveName, pct: now.expPct || 0, verdict: now.verdict, tier: now.koTier, turns: now.turnsToKO } : null,
    after: after ? { move: after.moveName, pct: after.expPct || 0, verdict: after.verdict, tier: after.koTier, turns: after.turnsToKO } : null,
    biggestGain: (biggest && biggest.gain >= 8) ? biggest : null,
    sameAfter: (sameAfter && sameAfter.kind === 'move')
      ? { move: sameAfter.moveName, pct: sameAfter.expPct || 0, verdict: sameAfter.verdict,
          tier: sameAfter.koTier, turns: sameAfter.turnsToKO }
      : null,
    gain: (now && after) ? (after.expPct || 0) - (now.expPct || 0) : null,
    oppSub: !!(oppSet && oppSet.sub),   // ★ 对手有替身时，强化的收益这一回合根本兑现不了
    oppHp,   // ★ 对手【当前】血量。几确是按它算的，而 pct 是按最大血量算的 —— 并排写必须标清基准
    myHp,    // ★ 我方当前血量：用来判断「对手这一发打你会不会直接打倒你」
    speNow: speOf(mySet), speAfter: speOf(boosted), oppSpe,
    inNow: worstIncoming(meSp, mySet, threats, oppSets),
    inAfter: worstIncoming(meSp, boosted, threats, oppSets),
    nowVsAnswer: nowVsAnswer ? { move: nowVsAnswer.moveName, pct: nowVsAnswer.expPct || 0 } : null,
    afterVsAnswer: afterVsAnswer ? { move: afterVsAnswer.moveName, pct: afterVsAnswer.expPct || 0 } : null,
    carry,   // ★ 这个 +N 让对手【后面几只】的死法快了多少（只列真的变快的）
  };
}

// ---------- 1.7) 钉子招：把收益算成具体数字 ----------
// ★★ 「没有标签的选项 = 不存在的选项」—— 强化招那次的老毛病，钉子招一直没修。★★
//   实测（用户当场指出，2026-09-26 那局）：土地云是我方唯一的撒钉手，整局一次隐形岩都没撒。
//   决策日志里那一条的原文只有一句：
//       [move:stealthrock]  隐形岩（对手出场时受岩石相性伤害。）
//   没有一个数字、没有代价、也没有「对面有几只怕它」—— 而旁边每个攻击选项都写着
//   「打掉 X-Y% 血、需 N 回合」，于是 Jev 给它的概率就是 0.00（日志里是真的 0）。
//
//   钉子收益是可算的：隐形岩 = 最大血量的 1/8 × 岩石相性倍率；对手 6 只是公开信息
//   （|poke| 行 → state.opp.revealed），逐只都能算。
//
// ⚠️ 相性表别凭记忆写：@pkmn/dex 的 damageTaken 是【从防守方视角】记的 ——
//   0=中性 1=弱点(2x) 2=抵抗(0.5x) 3=免疫 4=双重抵抗(0.25x)。
//   已对拍：雄伟牙 0.25 / 钢铠鸦 1 / 喷火龙 4 / 快龙 2 / 古鼎鹿 0.5 / 铁辙迹 0.25。
// 钉子招 id → 英文名。**放在模块作用域**：buildQuestion 和 buildTeamPreviewQuestion 都要用
const HAZARD_OF = { stealthrock: 'Stealth Rock', spikes: 'Spikes', toxicspikes: 'Toxic Spikes', stickyweb: 'Sticky Web' };
const ROCK_MULT = { 0: 1, 1: 2, 2: 0.5, 3: 0, 4: 0.25 };
function rockMult(spName) {
  const s = Dex.species.get(spName);
  if (!s.exists) return null;
  let m = 1;
  for (const t of s.types) m *= (ROCK_MULT[Dex.types.get(t).damageTaken['Rock']] ?? 1);
  return m;
}

function hazardFeature(state, moveName) {
  const m = Dex.moves.get(moveName);
  if (!m.exists || m.target !== 'foeSide' || !m.sideCondition) return null;
  const zh = zhInfo('moves', m.name);
  const head = '【钉子】' + (zh.zh || m.name) + '（' + oneLine(zh.shortDesc || zh.desc || '') + '）';
  if (m.sideCondition !== 'stealthrock') {
    // 尖刺/毒菱/黏网要判「地面上的」（飞行/飘浮/气球/厚底靴）—— 没把握的推断不做。
    // 但也不能当没这回事：至少把「这是一次性投资、收益在之后每次换人」说清楚。
    return head + '效果：铺在对方场上，它之后每次换人都要付出代价，整局有效。' +
      '（具体数值要先判定对方哪些是地面上的，本面板不猜。）';
  }
  const seen = state.opp.revealed || [];
  if (!seen.length) {
    return head + '⚠️ 但拿不到对手的 6 只名单，算不出数值 —— 别按数字判断。';
  }
  const rows = seen.map(sp => ({ sp, pct: (rockMult(sp) ?? 1) / 8 * 100 })).sort((a, b) => b.pct - a.pct);
  const heavy = rows.filter(r => r.pct >= 25).length;
  const avg = rows.reduce((s, r) => s + r.pct, 0) / rows.length;
  const list = rows.map(r => zhInfo('species', r.sp).zh + ' ' +
    (Number.isInteger(r.pct) ? r.pct.toFixed(0) : r.pct.toFixed(1)) + '%').join('、');
  return head +
    '效果：铺在对方场上，它【每次换人上场】都要吃一次，整局有效、不会消失。' +
    '对方 ' + rows.length + ' 只吃到的伤害：' + list + '。' +
    '其中 ' + heavy + ' 只每次上场要掉 25% 以上，平均每次换人掉 ' + avg.toFixed(1) + '%' +
    (m.sideCondition === 'stealthrock' && heavy === 0
      ? '—— ⚠️ 对面这几只都不怕岩石，铺钉子的收益很低' : '') + '。' +
    '⚠️ 这是【投资】：这一回合不造成任何伤害，收益全在往后的每一次对手换人里。';
}
function setupText(s, risk) {
  const parts = ['【强化】' + s.zh + '（' + s.desc + '）。用完你自己变成：' + s.boostText];
  // ★ 用【同一招】的强化前后做判断；强化后最强的一手换没换招单独说。
  const n = s.now, a = s.sameAfter || s.after;
  // ★★ 对手有替身 ⇒ 强化的收益【这一回合兑现不了】。★★
  //   不说这句，模型只看得到「+30 个百分点 / 净省 1 回合」，却看不到「你打出去的那一发
  //   还是只能打掉替身、本体一点血不掉」—— 实测就是这一条让面板在替身档前推荐了剑舞。
  if (s.oppSub) {
    parts.push('⚠️ 但它现在有【替身】：强化完之后你这一发仍然【只会打掉替身】，本体一点血不掉 —— ' +
      '这个 +能力要等替身破了才开始兑现；如果现在这一手本来就够打掉替身，先出招破替身更实在');
  }
  if (n && a) {
    const d = a.pct - n.pct;
    if (n.tier === '1HKO') {
      // 实测踩过：对手残血时两边都是「可一击必杀」，还写「+35 个百分点、这是实打实的提升」——
      // 那句话会让模型去强化一个已经能秒的对手。必须显式说破。
      // ★ 这里的 pct 是「打掉它最大血量的百分之几」，verdict 却是按【当前血量】判的。
      //   只写「被你这一手 Close Combat（35%）打死」会自相矛盾 —— 实测面板上真出现了这句
      //   （对手残血时）。两个基准都要写出来。
      parts.push('⚠️ 对手现在就已经被你这一手 ' + n.move + ' 打死了（它只剩 ' +
        Math.round(s.oppHp) + '% 血，这一手打它最大血量的 ' + n.pct.toFixed(0) +
        '%）—— 强化这一回合【没有必要】，先把对面打死');
    } else if (n.tier === 'likely') {
      parts.push('⚠️ 你现在打它就已经是【大概率一击必杀】—— 除非你有把握它这回合死不了，否则先出手');
    } else {
      // ★ 判据是「有没有跨过击杀档」而不是「涨了几个百分点」——
      //   百分点的绝对大小和血量挂钩（同样是 +8 点，在 40% 血和 15% 血的对手身上意义完全不同），
      //   而「需 N 回合 → 需 M 回合」才是玩家真正在意的量。
      // ★ 基准必须是【受益最大的那一招】，不是「你现在最强的那一招」。
      //   纯防御强化（铁壁）对近身战毫无影响，却让扑击翻倍；拿近身战当基准会显示
      //   「60% → 60%，提升很小」—— 收益全被藏起来，实测导致铁壁永不被选。
      const bg = s.biggestGain;
      const base = (bg && bg.gain > d)
        ? { move: bg.move, before: bg.before, after: bg.after,
            vB: bg.tierBefore, vA: bg.tierAfter, tB: bg.turnsBefore, tA: bg.turnsAfter, other: bg.move !== n.move }
        : { move: n.move, before: n.pct, after: a.pct, vB: n.tier, vA: a.tier, tB: n.turns, tA: a.turns, other: false };
      const db = base.after - base.before;
      const breakthrough = base.vA === '1HKO' && base.vB !== '1HKO';
      // ★★ 回合账必须【把强化自己那一回合算进去】。★★
      //   原来只写「需 3 回合 → 需 2 回合」，读起来像省了 1 回合 ——
      //   可你为它花掉的那一回合没人扣。实测（ou-c 厄鬼椪剑舞 vs 满血盐石巨灵）真实账是：
      //     不强化：2 回合打死它；强化：1 回合强化 + 1 回合打死 = 也是 2 回合。
      //   而面板写的是「76% → 153%，【质变】打不死 → 一击必杀」——
      //   Jev 看到的是「强化要挨一发、又没省下回合」⇒ 点攻击（0.55 vs 剑舞 0.39）。
      //   这是本项目的红线第三次以同一个形状发作：**数字少算了一项，读者就得出相反的结论**。
      const canT = Number.isFinite(base.tB) && Number.isFinite(base.tA);
      const totalYes = canT ? 1 + base.tA : NaN;
      const netSave = canT ? (base.tB - totalYes) : NaN;
      parts.push('收益：' +
        (base.other ? '（你目前最强的一手 ' + n.move + ' 不受这个强化影响，真正受益的是）' : '') +
        base.move + ' ' + base.before.toFixed(0) + '% → ' + base.after.toFixed(0) + '%（' +
        (db > 0 ? '+' : '') + db.toFixed(0) + ' 个百分点；' + tierZh(base.vB) + ' → ' + tierZh(base.vA) + '）');
      if (canT) {
        parts.push('回合账：不强化 → 出 ' + base.tB + ' 次招打死它；强化 → 1 回合强化 + ' + base.tA +
          ' 回合打死 = 一共 ' + totalYes + ' 回合。' +
          (netSave > 0 ? '【净省 ' + netSave + ' 回合 —— 这是实打实的赚】'
            // ★★ 「打平」= 白赚，不是「没差别」。★★
            //   两条路花的回合一样、挨打的次数也【严格一样】（对手每一回合都在动），
            //   唯一区别是结束时的数值 ⇒ 这是严格更优，不是平手。
            //   旧文案写「总回合数一样 —— 但这【不是亏】」，而 instructions 那条判据
            //   同时写着「回合数没变 → 才不值得」：两边对不上，模型信了后者（实测剑舞只有 0.22）。
            : netSave === 0 ? '【★白赚一个 ' + s.boostText + '】—— 两条路花的回合一样、' +
              '挨打的次数也【一模一样】（对手在这几回合里照样出手），' +
              '唯一区别是结束时的数值：出招那条路你打完它还是原来的数值，' +
              '强化这条路你【同样打完它、却多带着 ' + s.boostText + ' 进下一只】。' +
              '所以这一档是【该强化】，不是「没差别」'
            : '⚠️【反而多花 ' + (-netSave) + ' 回合】—— 光看这一只，强化是亏的，' +
              '只有你确定能靠强化后的身板/输出去赢下后面几只时才值得'));

        // ★ 把「会带到下一只」从空话变成数字（基准：对手满血、按使用率配置估）
        if (s.carry && s.carry.length) {
          const cl = s.carry.slice(0, 5).map(c => zhInfo('species', c.sp).zh + '（' + c.move + ' ' +
            (c.flip ? '打不死 → ' + c.t1 + ' 回合' : c.t0 + ' → ' + c.t1 + ' 回合') + '）').join('、');
          parts.push('带过去之后：这个 ' + s.boostText + ' 会一直挂在你身上换不掉，' +
            '对手后面 ' + s.carry.length + ' 只的死法都会变快（按满血、使用率配置估）—— ' + cl);
        }
      } else {
        parts.push('回合账：这一手改的是数值不是回合数（' + tierZh(base.vB) + ' → ' + tierZh(base.vA) + '）');
      }
      // 强化后最强的一手换没换招，必须单独说 —— 否则读者会把两招的数字当成同一招的前后
      if (s.after && s.after.move !== n.move) {
        parts.push('强化后你最强的一手会变成 ' + s.after.move + '（' + s.after.pct.toFixed(0) + '%）');
      }
    }
  }
  if (s.speNow != null && s.speAfter != null && s.oppSpe && s.speNow !== s.speAfter) {
    parts.push('速度：' + s.speNow + ' → ' + s.speAfter + '（对手 ' + s.oppSpe + '）：' +
      (s.speNow > s.oppSpe ? '现在你已经先手' : '现在你先手不了') + '，用完后' +
      (s.speAfter > s.oppSpe ? '能先手' : '仍然先手不了'));
  }
  // ★ 和攻击选项用【同一句致命标记】。攻击选项已经写了「最坏乱数就能打倒你」，
  //   强化选项如果只写「打你约 104%」，就又是一次「真事实只放在一边」——
  //   模型会读成「强化要挨打、攻击只是挨打」，而实际上两者都要挨同一发必死。
  const inFatal = !!(s.inNow && s.myHp != null && s.inNow.pct >= s.myHp);
  const fatalMark = inFatal ? '（这一发【最坏乱数就能打倒你】）' : '';
  if (s.inNow) {
    parts.push('代价：这一回合不出招，会白挨对手一次攻击 —— ' + s.inNow.from + ' 的 ' + s.inNow.move +
      ' 打你约 ' + s.inNow.pct.toFixed(0) + '%' + fatalMark);
  }
  // ★ 防守收益【单独成句】。对铁壁/冥想这类偏防御的强化，这才是主要收益 ——
  //   以前它只是「代价」那句的括号附注，等于把唯一的好处藏起来了（实测导致铁壁永不被选）。
  if (s.inNow && s.inAfter && s.inAfter.pct <= s.inNow.pct - 8) {
    parts.push('防守收益：同一个 ' + s.inNow.move + ' 打你从 ' + s.inNow.pct.toFixed(0) +
      '% 降到 ' + s.inAfter.pct.toFixed(0) + '%' +
      (s.inNow.pct >= 100 ? '（这一发本来能打死你，强化后就死不了了）' : ''));
  }

  // ★ 本回合的两种走向都写出来。强化技该不该点，本质上就是在赌【对手换不换】：
  //   它不换 → 你白挨一发；它换 → 你白赚一回合，但要面对它换上来的挡子。
  if (risk) {
    const sub = [];
    sub.push('对手换不换，见 opp_switch 问题里你自己的判断' +
      (risk.switchReasons.length ? '（支持它换人的事实：' + risk.switchReasons[0] + '）' : ''));
    sub.push('· 它【不换】：它直接攻击你，这一回合你是白挨' + (s.inNow
      ? ' —— 它最痛的一手 ' + s.inNow.move + ' 打你约 ' + s.inNow.pct.toFixed(0) + '%' + fatalMark : ''));
    if (risk.answer) {
      sub.push('· 它【换人】：你白赚一回合（不挨打还涨了能力）' +
        (s.nowVsAnswer && s.afterVsAnswer
          ? '，但换上来的是 ' + risk.answer.species + ' —— 你现在打它 ' + s.nowVsAnswer.pct.toFixed(0) +
            '%，强化后 ' + s.afterVsAnswer.pct.toFixed(0) + '%（' + s.afterVsAnswer.move + '）；它反手 ' +
            risk.answer.theirMove + ' 打你约 ' + risk.answer.theirPct.toFixed(0) + '%'
          : ''));
    } else {
      sub.push('· 它【换人】：你白赚一回合（不挨打还涨了能力）；它后排没有真正能挡你的');
    }
    parts.push(sub.join('。'));
    if (risk.wallsUs && s.afterVsAnswer && s.afterVsAnswer.pct < 40) {
      parts.push('⚠️ 关键：就算它换上挡子、你也强化到 +2，仍只能打它 ' + s.afterVsAnswer.pct.toFixed(0) +
        '% —— 强化挡不住它的换人，别指望靠强化破它');
    }
  }
  return parts.join('。') + '。';
}

// ---------- 2) 组装 Jev 问题 ----------
export function buildQuestion(state) {
  const me = state.me, opp = state.opp;
  const mySet = me.active.set || {};
  const oppSet = (opp.sets && opp.sets[opp.active.species]) || {};

  // ★ 威胁必须先算：选项文案要用它。
  //   修前：威胁只活在 payload 的另一头（opponent_threats 字段），每个选项的文案里没有，
  //   模型得自己把两头连起来——实测 Jev 没连上，对「先制招能秒我方」的局面照样选了攻击。
  const threats = opponentThreats(state);
  // ★★ 先后手：以前【完全没算】，只有先制招会触发「本回合必死」。★★
  //   普通招只要对手比你快、又能打死你，同样让这一手作废 —— 这次把它并进来。
  const _theirHaz = (state._hazards && state._hazards.theirs) || [];
  const _myHaz = (state._hazards && state._hazards.mine) || [];
  const mySpe = finalSpeedOf(me.active.species, mySet, {
    weather: state._weather, status: state._status && state._status.mine,
    speedFlag: state._mySpeedFlag, tailwind: _theirHaz.includes('Tailwind'),
  });
  const oppSpe = finalSpeedOf(opp.active.species, oppSet, {
    weather: state._weather, status: state._status && state._status.theirs,
    speedFlag: state._oppSpeedFlag, tailwind: _myHaz.includes('Tailwind'),
  });
  const speedKnown = (mySpe != null && oppSpe != null);
  const outsped = speedKnown && oppSpe > mySpe;
  const speedTie = speedKnown && oppSpe === mySpe;
  // 口径：对手的努力值是使用率配置推的，不是真配置。不说清楚就是假事实。
  const speedMods = [
    state._weather ? '天气 ' + state._weather : null,
    (state._status && state._status.mine) === 'par' ? '我方麻痹' : null,
    (state._status && state._status.theirs) === 'par' ? '对手麻痹' : null,
    state._mySpeedFlag ? '我方充能提速' : null,
    state._oppSpeedFlag ? '对手充能提速' : null,
    _theirHaz.includes('Tailwind') ? '对手顺风' : null,
    _myHaz.includes('Tailwind') ? '我方顺风' : null,
  ].filter(Boolean);
  const speedFact = speedKnown
    ? '【先后手】你 ' + mySpe + ' vs 它 ' + oppSpe + ' —— ' +
      (outsped ? '它先动' : speedTie ? '同速（看乱数）' : '你先动') +
      '（按使用率配置估' + (speedMods.length ? '，含 ' + speedMods.join('、') : '') + '）。' +
      (outsped ? '⚠️ 它先动 ⇒ 你这一回合只有【先制招】能抢在它前面打出去；' +
        '普通招是它先打完你、你才出手。' : '')
    : '【先后手】算不出来（缺一方的配置）。';
  const speedClause = '；' + speedFact;
  // 会【抢在我们前面】打死我们的招 = 先制招，或（它更快时的）普通招
  const lethal = threats.filter(t => t.kills_our_active && ((t.priority || 0) > 0 || outsped));
  const maxLethalP = lethal.length ? Math.max(...lethal.map(t => t.priority || 0)) : 0;
  const lethalText = lethal.map(t => t.from + ' 的 ' + t.move +
    ((t.priority || 0) > 0 ? '（先制+' + t.priority + '，打 ' : '（比你先动，打 ') +
    t.damage_percent_vs_our_active + '%）').join('、');



  // ★ 本回合能点哪些招 —— 走 legalMovesOf（唯一来源 request.active[0].moves）。
  //   必须在 oppSwitchRisk 之前算：换人判断里的「你几回合打死它」也得只用能点的招。
  const { moveList, lockedAway, moveFallback } = legalMovesOf(state, mySet);

  // ★ 对手换人的可能性 —— 强化技与换人的价值几乎完全由它决定，所以算一次、全程复用。
  const risk = oppSwitchRisk(state, mySet, oppSet, threats, moveList);

  const riskLine = '【对手会不会换人】由 opp_switch 问题单独判断 —— 这里【不给概率】，' +
    '因为换不换是模糊判断，不是可算事实（给一个数字等于把先验当事实）。你只需要看事实、自己下判断。' +
    '支持它【留场】的事实：' + (risk.stayReasons.join('；') || '无') + '。' +
    '支持它【换人】的事实：' + (risk.switchReasons.join('；') || '无') + '。';

  const actions = [];
  for (const mv of moveList) {
    let f = moveFeature(me.active.species, mySet, opp.active.species, oppSet, mv, opp.active.hpPercent);
    if (f) {
      // ★ 强化招贴上「收益」标签（原来它一个数字都没有，所以永远输给攻击招）
      if (f.kind === 'status') {
        const su = setupFeature(me.active.species, mySet, opp.active.species, oppSet, mv,
          opp.active.hpPercent, threats, opp.sets || {}, risk, me.active.hpPercent);
        if (su) f = { ...f, kind: 'setup', setup: su, note: su.desc || f.note };
      }
      actions.push(f);
      continue;
    }
    // ★★ 绝不静默丢弃 ★★
    // 这里原本是 if (f) actions.push(f) —— 算不出来就没了。实测后果：
    // 对手是 Minior-Violet（calc 不认的形态名）时，我方 4 个招式全部计算失败 →
    // 选项列表只剩「隐形岩」+ 5 个换人 → 模型只能推荐隐形岩，而玩家完全看不出哪里不对。
    // 现在改成：算不出来也要出现在选项里，并明确标注，让模型和人都能看见。
    const dm = Dex.moves.get(mv);
    actions.push({
      id: 'move:' + (dm.exists ? dm.id : String(mv).toLowerCase().replace(/[^a-z0-9]/g, '')),
      name: dm.exists ? dm.name : mv, moveName: dm.exists ? dm.name : mv, kind: 'move', failed: true,
      type: dm.type || '?', category: dm.category || '?', bp: dm.basePower || 0,
      accuracy: dm.accuracy === true ? 100 : (dm.accuracy || 100), priority: dm.priority || 0,
      pctLo: 0, pctHi: 0, koChance: 0, expPct: 0, turnsToKO: Infinity,
      immune: false, kills: false,
      verdict: '伤害计算失败（形态名或机制不被计算器支持）—— 不要用这个选项的数字做判断',
    });
  }
  for (const b of (me.bench || [])) {
    if (b.hpPercent <= 0) continue;
    actions.push(switchFeature(b.set || {}, opp.sets || {}, opp.revealedMoves || {}, b.species,
      opp.active.species, opp.active.hpPercent, b.hpPercent, risk));
  }
  // ══════════ 死招：唯一能点的招对当前对手【完全无效】══════════
  // ★★ 这时「出招」根本不是真选项，必须从选项里【拿掉】。★★
  //   实测（用户当场指出，讲究眼镜锁流星群 vs 妖精）：面板在那一行写了「【对当前对手无效，不要选】」，
  //   Jev 照样选它（置信 0.56，修完换人事实后仍 0.40）。原因是两条叠加：
  //     ① 【否定标签打不过具体代价】——「不要选」是空的，而 5 个换人选项每个都写着
  //        「会白送对手一次攻击」这种具体代价；模型宁可选那个「已经说了会挨打」的招。
  //     ② 【票数摊薄】—— 5 个换人各分走一点概率，唯一那个「出招」选项成了最高票。
  //   这和太晶那次是同一条红线：能用代码判定的硬事实，不能做成摆在模型面前的选项。
  //   所以：唯一能点的招打不出伤害（immune）、没有可用的强化招、且场下还有活的宝可梦
  //   ⇒ 【不生成这些招选项】，只留换人，并在 instructions 里说明为什么。
  const benchAlive = (me.bench || []).filter(b => b.hpPercent > 0).length;
  const attackActs = actions.filter(a => a.kind === 'move');
  const hasSetup = actions.some(a => a.kind === 'setup');
  const deadLock = attackActs.length > 0 && attackActs.every(a => a.immune)
    && !hasSetup && benchAlive > 0;
  let deadNote = '';
  if (deadLock) {
    const names = attackActs.map(a => a.nameZh || a.name).join(' / ');
    deadNote = '⚠️【本回合出招 = 空过】你唯一能点的招（' + names + '）对场上的 ' +
      (zhInfo('pokemon', opp.active.species).zh || opp.active.species) + '【完全无效，一点伤害都打不出】；' +
      (lockedAway.length ? '而且讲究道具会一直把你锁在这一招上 —— 只要你不换人，接下来【每个回合】都是空过。' : '') +
      '所以下面【没有出招选项，只有换人】。换人这一回合的代价你本来就要付（出招也是白送），' +
      '请直接选【换上谁最有利】，不要幻想留在场上能打出伤害。';
    const keep = actions.filter(a => a.kind !== 'move');
    actions.length = 0;
    for (const a of keep) actions.push(a);
    console.log('[警告] 唯一能点的招对当前对手完全无效（' + names + '）—— 已从选项里移除，本回合只给换人');
  }

  // ★ 我方布置的场地招 → 对应场地名。已在对方场上的要标出来：
  //   事实层解析出了 hazards，但此前 buildQuestion 【完全没有引用它】，
  //   结果模型每回合都推荐重复铺钉（实测：隐形岩第 1 回合就铺好了，之后每回合还在推）。
  // （HAZARD_OF 已经提到模块作用域 —— buildTeamPreviewQuestion 也要用它）
  const theirHazards = (state._hazards && state._hazards.theirs) || [];

  // 锁招提示：Jev 和玩家都要看得见「为什么只剩这几招」
  const lockNote = (lockedAway.length && !deadLock)
    ? '⚠️【锁招】你现在被道具锁住了（讲究围巾/头巾/眼镜一类）：本回合【只能点 ' + moveList.join(' / ') +
      '】。' + lockedAway.join('、') + ' 在客户端是灰的，点了也没用。'
    : '';
  const fallbackNote = moveFallback
    ? '⚠️【异常】request 里我方所有招式都是 disabled，下面的选项是退回队伍文件生成的 —— ' +
      '不代表客户端真的能点，先确认客户端上你到底能点什么。'
    : '';

  // ★ 本回合「挨打要挨多少」算一次 —— 攻击选项和强化选项必须共用同一个数，
  //   否则两边不在一个尺度上（见下面 costNote 的说明）。
  const incoming = worstIncoming(me.active.species, mySet, threats, opp.sets || {});
  // ★ 对手最痛的一手【能把你打死】时，必须明说 —— 不能只丢一个「约 104%」让人自己换算。
  //   实测（决策日志一开就看见了）：厄鬼椪 100% 血 vs 钢铠鸦，每个选项都写着
  //   「它最痛的 Brave Bird 打你约 104%」，Jev 照样点棘藤棒（0.52）——
  //   因为「104%」到「我这回合会倒」这一步要读者自己推，而【能算的不要交给模型算】。
  //   ⚠️ 措辞不能写成「你必定倒下」：对手也可能换人。所以写成【它只要打出来】的条件句。
  //   ⚠️ 也不能写成「一定会打死你」：worstIncoming 取的是【最大乱数】（hitOnMe 用 Math.max），
  //   所以是「最坏乱数能打死」。数字没带口径就是假事实 —— 本项目的老毛病。
  const incomingFatal = !!(incoming && incoming.pct >= me.active.hpPercent);
  // ★★ 代价句只写一次，所有选项共用同一句。★★
  //   以前它只挂在攻击/强化选项上，普通状态招和钉子招一个字都不提 ——
  //   于是模型看到的是「出招要挨打、撒钉不用挨打」，可实际上都要挨同一发。
  //   这就是那条红线：真事实被不对称地放在一边，比较就整体失真。
  // ★ 对手场上那一只的招式我们【一条都不知道】时，必须说出来。
  //   静默失败的红线：不在使用率表里、又还没出过手的宝可梦，revealedMoves 是空数组 ⇒
  //   threats 为空 ⇒ incoming 为 null ⇒ 所有选项的代价句【一起消失】，面板读起来像「它没威胁」。
  //   实测：火神蛾不在 meta-sets.json 的 452 只里，就是这个状态。
  const oppActiveMoves = ((opp.revealedMoves || {})[opp.active.species] || []);
  const unknownNote = oppActiveMoves.length ? ''
    : '⚠️【威胁未知】对手场上的 ' + opp.active.species + ' 我们一条招式都不知道（不在使用率表里、' +
      '也还没出过手）—— 下面所有「你会吃多少」都【算不出来，不代表它没威胁】。' +
      '判它会不会换人时请把这一点算进去。';
  // 这套 set 里有没有钉子招？有就把 hazardFeature 的事实整段带出来（换人场景复用同一份数字）。
  const hazardSetterOf = (set) => {
    if (!set || !set.moves) return null;
    const mv = set.moves.find(x => HAZARD_OF[Dex.moves.get(x).id]);
    if (!mv) return null;
    try { const tip = hazardFeature(state, mv); return tip ? { move: mv, tip } : null; }
    catch (e) { return null; }
  };

  const costClause = incoming
    // ★ 我方有替身时「你会吃 X%」是假话 —— 那一发先打在替身上（见 worstIncoming 里的说明）
    ? (incoming.subbedByUs
        ? '；注意本回合它最痛的 ' + incoming.move + '（打你约 ' + incoming.pct.toFixed(0) +
          '%）会先打在你的【替身】上 —— 你本体这一回合不掉血，但替身最多还能吸收 ' +
          incoming.subbedPctMax + '% 最大血（日志不公开替身剩余血量，这是上限）'
        : '；注意本回合无论如何你都会吃一次攻击：它最痛的 ' + incoming.move +
          ' 打你约 ' + incoming.pct.toFixed(0) + '%' +
          (incomingFatal
            ? '（这一发【最坏乱数就能打倒你】—— 你现在只有 ' + me.active.hpPercent + '% 血；' +
              '它只要打出来，你这一手就是拿自己换它这点血）'
            : ''))
    : '';

  const criteria = {};
  for (const a of actions) {
    // 场地招是否已经铺过（放在分支外面算 —— 状态招走的是 else 分支，
    // 之前只在 move 分支里算，导致「隐形岩」这条最重要的重复提示反而没有）
    const _hz = HAZARD_OF[a.id.slice(5)];
    const hzNote = (_hz && theirHazards.includes(_hz))
      ? ' —— 【' + _hz + ' 已经铺在对方场上了，再点等于浪费一个回合】' : '';

    // 本回合必死对「出招」和「强化」同样成立：先制招优先度更高 ⇒ 还没出手就被打倒
    const isAct = a.kind === 'move' || a.kind === 'setup';
    // ★ 同为先制等级时用【速度】分先后 —— 以前一律写成「谁先手比速度」却不给速度值。
    const doomed = isAct && lethal.length > 0 &&
      (a.priority < maxLethalP || (a.priority === maxLethalP && outsped));
    const tied = isAct && lethal.length > 0 && a.priority === maxLethalP && !outsped && speedTie;
    const doom = doomed
      ? '⚠️【本回合必死】' + lethalText + ' 会抢在你前面击倒我方当前宝可梦' +
        '（我方仅剩 ' + me.active.hpPercent + '% 血；' +
        (maxLethalP > 0 ? '它先制+' + maxLethalP : '它更快 ' + oppSpe + ' > 你 ' + mySpe) +
        '），这一手【根本打不出去】。 '
      : tied
      ? '⚠️ 与它同级先制（先制+' + maxLethalP + '）而双方【同速 ' + mySpe + '】—— 谁先手看乱数；对手：' + lethalText + '。 '
      : '';

    if (a.kind === 'setup') {
      criteria[a.id] = doom + setupText(a.setup, risk) + speedClause + hzNote;
    } else if (a.kind === 'move') {
      criteria[a.id] = a.failed
        ? '⚠️【计算失败】' + a.name + ' —— 计算器算不出这一发（对手形态名或机制不被支持），' +
          '本选项的伤害数字不可信，请优先考虑其他选项。'
        : doom + a.name + ' (' + a.type + ' ' + a.category + ', ' + a.bp + ' 威力, 命中' + a.accuracy + ')' +
        (a.immune ? ' —— 【对当前对手无效，不要选】'
          : a.blockedBy ? ' —— 【被' + a.blockedBy + '挡下，这一击打不出伤害，不要当它是一击必杀】'
          // ★★ 必死的招不许再挂【正面标签】★★
          //   实测（跨 6 局、286 个 move 决策点）：面板报了「本回合必死」的 44 个点里，
          //   Jev 仍然点出招的 23 个（52.3%）、点的【正是那个必死招】的 21 个（47.7%）。
          //   根因是同一个选项字符串里同时写着「这一手【根本打不出去】」和「**可一击必杀**」——
          //   正面标签压过了死刑宣判。这和 deadLock 是同一个坑（否定标签打不过具体代价），
          //   只是当时只处理了「唯一能点的招完全无效」，更常见的「本回合必死」一直没管。
          //   伤害数字保留（对手换人/你先手时照样兑现），但**判读必须撤掉**并明说这一回合不会发生。
          : doomed ? ' —— 打掉约 ' + a.pctLo.toFixed(0) + '-' + a.pctHi.toFixed(0) + '% 血，' +
              '但【这一回合兑现不了】：上面这个数只有在对手换人、或你先手打出去时才成立'
          : ' —— 打掉约 ' + a.pctLo.toFixed(0) + '-' + a.pctHi.toFixed(0) + '% 血，' + a.verdict) +
        (a.priority > 0 ? '，先制 +' + a.priority + '（无视速度）' : '') +
        (a.multiHit ? '【多段招：这是按 ' + a.hits + ' 下算出的【合计】区间；命中数本身可变（如种子机关枪 2-5 下）时这是估算】' : '') +
        // ★★ 代价必须【两边都写】★★
        //   强化选项里一直写着「这一回合你会白挨 X%」，而攻击选项一个字都没提 ——
        //   于是模型看到「强化有代价、攻击没代价」，可实际上两者【都要挨同一发】。
        //   这和画皮那次是同一个形状：真事实被不对称地放在同一边，比较就整体失真。
        //   实测后果：整场比赛一次强化都不点。
        speedClause + costClause + hzNote;
    } else if (a.kind === 'switch') {
      const pw = a.priorityWorst;
      // ★ 必须把「对手根本没有先制招」和「有但我们算不出」分开说。
      //   原来两种情况都写成「对手先制招对它的伤害未知」—— 而前者是【已知的没有】，
      //   说成「未知」等于凭空制造不确定性（本项目红线：数字/结论离开口径就是假事实）。
      const anyPri = Object.values(opp.revealedMoves || {})
        .some(list => (list || []).some(mv => { const m = Dex.moves.get(mv); return m.exists && (m.priority || 0) > 0; }));
      const priNote = lethal.length
        ? (pw
            ? '；换上来同样躲不掉先制——会先吃 ' + pw.from + ' 的 ' + pw.mv + '（先制+' + pw.priority + '，约 ' + pw.pct.toFixed(0) + '%）'
            : (anyPri
                ? '；对手有先制招，但算不出它对换上这只的伤害（换上这只可能刚好不怕）'
                : '；对手已知的招式里【没有】先制招（不排除它还有没见过的招），所以换人能躲开这一回合'))
        : '';
      const canDo = a.myOutput
        ? '；换上来后它最强的一手能打 ' + (a.myOutputPct || 0).toFixed(0) + '%（' + a.myOutput.name + '）' +
          ((a.myKoChance || 0) > 0.5 ? '【大概率击杀对面】' : '')
        : '；换上来后没有已知的有效输出';
      // ★ 换人选项也要按「对手换 / 不换」两个走向给数 —— 否则没法跟强化招放在一个尺度上比
      const riskNote = '。对手换不换见 opp_switch 问题' +
        (a.vsAnswer
          ? '——若它换成 ' + a.vsAnswer.species + '：你换上的这只打它 ' + a.vsAnswer.myPct.toFixed(0) +
            '%（' + a.vsAnswer.myMove + '），它反手用 ' + a.vsAnswer.theirMove + ' 打你 ' + a.vsAnswer.theirPct.toFixed(0) + '%'
          : '——它后排没有真正能挡你的，换上来对位不会更差');
      // ★ 死招时【不能】再写「会白送对手一次攻击」：你出招同样是空过，换人并没有多亏一个回合。
      //   这句话原来无条件写着，等于把换人说得比出招更贵 —— 又是一次「真事实只放在一边」。
      const waste = deadLock
        ? '）。⚠️ 本回合你出招【同样等于空过】（唯一能点的招对它一点伤害都没有），所以换人并不会比出招更亏'
        : '），会白送对手一次攻击';
      // ★★ 换人代价必须给出【判读】，不能只丢一个百分比。★★
      //   实测（2026-09-26 那局）：面板对 Brute Bonnet 一直写「换上 铁辙迹，吃约 89%」，
      //   Jev 照选（0.53）—— 下一回合铁辙迹就被 Close Combat 打死（日志 #27）。
      //   89% 这个数【没人替它解读】，而旁边攻击选项都带「需 N 回合 / 可一击必杀」这种判读。
      //   这又是「真事实只放在一边」：攻击有判读、换人只有裸数字。
      const inFrac = (a.worst && a.hpPercent) ? a.worst.pct / a.hpPercent : null;
      const swapVerdict = inFrac == null ? ''
        : inFrac >= 1 ? '——【换上来就会被一击必杀，绝对别选它】'
        : inFrac >= 0.7 ? '——【换上来只剩两三成血，基本等于白送】'
        : inFrac >= 0.5 ? '——【换上来要掉一半以上，只有换上就能立刻反打才划算】'
        : '';
      // ★ 对称事实：你留在场上这一回合也活不了的话，换人的这份代价【不是额外的】。
      //   不说这句，模型会以为「换人 = 白挨 89%」而攻击 = 没事 —— 可两条路都会掉这一只。
      const swapSym = incomingFatal
        ? '（注意：你留在场上这一回合同样会被打死，所以这个代价并不是换人额外多付的）' : '';
      // ★★ 换上来的这只是不是【撒钉手】—— 这件事换人文案里以前一个字都没有。★★
      //   实测（2026-09-27 battle-20260927-115708）：我方 Glimmora 是队里唯一的撒钉手
      //   （招式里有 Earth Power 这样的输出，换人文案写着「吃 180%，绝对别选它」「能打 166%」），
      //   撒钉这一整类价值完全缺席 ⇒ 它永远是最差的选项，整局一次都没上过场。
      //   这和强化招、钉子招当年是同一个坑：**没有标签的选项 = 不存在的选项**。
      // ★★ 换出去又换回来 = 白送对手两个回合。★★
      //   换人是对称的，所以只要「刚换下去的那只又能换回来」，模型就会来回换 ——
      //   实测两次陷入循环（alomomola↔greattusk 一直换到 140 回合；
      //   2026-09-27 battle-20260927-123200 的 landorus↔irontreads 连换 4 回合）。
      //   根因是【永远不告诉模型"你上一手刚把它换下去"】—— 它看到的永远是「换上它能少挨 10%」。
      //   ⚠️ 2026-10-01 收窄：窗口原来是【最近 3 只】，实测在 150 个真实决策点上
      //   **78% 的点都挂上了这句话**，而高手实际选择换人的 37 次里有 14 次正好被它贴中。
      //   可措辞是「再换回来等于把刚才那一回合白送对手」—— 那只在【隔一回合】时成立；
      //   28 回合的对战里 A→B→A 的正常轮转到处都是，把"3 回合前换下过"也说成"白送一回合"
      //   就是**把真事实夸大**（本项目红线：比较因此整体失真）。
      //   现在只认【真的是上一回合】，真正的来回换（landorus↔irontreads 那种）照样抓得住。
      const justOut = (state._myHistory || []).slice(0, 1);
      const backIdx = justOut.indexOf(a.name);
      const backNote = backIdx >= 0
        ? '。⚠️ 【你最近刚把它换下去过' + (backIdx === 0 ? '（就在上一回合）' : '（' + (backIdx + 1) + ' 回合前）') +
          '】—— 再换回来等于把刚才那一回合白送对手，来回换是对称的、谁也占不到便宜。' +
          '除非局面确实变了（它换人/你换了道具/血量关键档位变了），否则别往回换'
        : '';
      const hzSet = hazardSetterOf(a.set);
      const hzSetNote = hzSet ? '。★ 换上它就能【撒钉子】：' + hzSet.tip.replace(/^【钉子】/, '') : '';
      criteria[a.id] = '换上 ' + a.name + '（' + (a.worst ? '若它不换、直接攻击：你预测要吃约 ' + a.worst.pct.toFixed(0) + '%（' + a.worst.from + ' 的 ' + a.worst.mv + '）' : '暂无已知威胁') + swapVerdict + swapSym + waste + priNote + canDo + hzSetNote + backNote + riskNote;
    } else {
      // ★ 普通状态招：至少把【中文效果描述】写进去。
      //   原来这里只有「名称（状态招，不造成伤害）」—— 模型据此没有任何可判断的信息，
      //   于是它永远去点那些带百分比的攻击招。描述来自 data/zh-ps.json 的 shortDesc。
      const zh = zhInfo('moves', a.moveName || a.name);
      const desc = oneLine(zh.shortDesc || zh.desc || a.note || '');
      const mv0 = Dex.moves.get(a.moveName || a.name);
      let healNote = '';
      if (mv0.exists && Array.isArray(mv0.heal) && me.active.hpPercent < 100) {
        const frac = mv0.heal[1] ? mv0.heal[0] / mv0.heal[1] : 0;
        if (frac > 0) healNote = '。它能把你的血从 ' + me.active.hpPercent + '% 拉回到约 ' +
          Math.min(100, Math.round(me.active.hpPercent + frac * 100)) + '%';
      }
      // ★ 钉子招换成【带数字】的文案；已经铺过就不换（hzNote 已经说了再点等于浪费）。
      //   其余状态招照旧只有中文描述 —— 比不上钉子那么可算，但至少共用同一句代价。
      const hzTxt = (!_hz || !theirHazards.includes(_hz)) ? hazardFeature(state, a.moveName || a.name) : null;
      criteria[a.id] = doom + (hzTxt || ((zh.zh || a.name) + '（' + desc + '）' + healNote)) + costClause + hzNote;
    }
  }

  // ══════════ 太晶：独立成一个问题 ══════════
  // ★ 关键设计：太晶【与选哪一招是正交的】—— 太晶是「宣告太晶」+「出招」两步，宣告之后照样点任意一招。
  //   所以它不该做成「招1 / 招1+太晶 / 招2 / 招2+太晶 …」这种选项：选项数翻倍，还把真正重要的
  //   选择淹掉（这正是本项目的的老毛病：选项一多，模型就挑最显眼的那个）。
  //   做成【第二个问题】才对——Jev 一次调用可以同时回答多个问题（questions 就是一本字典）。
  //   「还能不能太晶」是服务端从 room.request.active[0].canTerastallize 读来的事实，不是猜的：
  //   用掉之后该字段消失，这里自然就不再问太晶。静态队伍文件（loadTeam）没这个字段，按「还能太晶」处理。
  // ★★「太晶只能用一次」必须是【代码里的硬规则】，绝不能只写在 instructions 或 criteria 里。★★
  //   实测踩过（用户当场指出）：我把 use/save 两个选项都摆给 Jev，还在 use 的文案里明写
  //   「当前局面没有明确的收益，用掉大概率是浪费」—— 它照样选了 use（置信 0.52），
  //   面板于是在第 1 回合就建议「太晶 + 点大地之力」，把整局唯一一次机会浪费掉。
  //   原因正是本项目的红线：【抽象规则打不过具体标签】。选项一旦存在，标签上的收益就在眼前。
  //   要修的是【事实层】—— 算不出收益时压根不生成这个问题，面板直接说「保留太晶」。
  const teraInfo = mySet.teraAvailable ? analyzeTera(state, mySet, oppSet, threats) : null;
  const teraPayoff = !!(teraInfo && (teraInfo.isBreakthrough || teraInfo.savedCount > 0));

  const questions = {
    action: {
      type: 'choice',
      instructions:
        (deadNote ? deadNote + ' ' : '') + speedFact + ' ' + (unknownNote ? unknownNote + ' ' : '') +
        (lockNote ? lockNote + ' ' : '') + (fallbackNote ? fallbackNote + ' ' : '') +
        riskLine + ' ' +
        '【强化技 vs 换人】这两件事的价值几乎完全取决于对手会不会换人 —— ' +
        '它不换，你强化就是白挨一发；它换，你白赚一回合、但要面对它换上来的那一只。' +
        '所以每个强化选项和换人选项里都分别给了「它不换 / 它换」两个走向的数字，照着比。' +
        '选择最可能赢下【整场】战斗的单一行动，而不是只看这一回合。' +
        '每个选项都附了计算器给出的事实：属性克制、打掉目标剩余血量的比例、需要几回合击倒。' +
        '未公开招式的伤害属于推测风险，不是事实；对手没公开的道具/特性/努力值只有【最常见配置】，同样是推测 —— ' +
        '遇到「换上来的那一只」「预测要吃多少」这类数字时请记住这一点。' +
        '规则：①【先制招无视速度】——若对手有先制招能秒杀我方当前宝可梦，则出手攻击可能来不及，必须优先考虑避开或换人；' +
        '②有确定的一击必杀就选它；③不要把宝可梦换进会被一击必杀的招；' +
        '④为对手剩余队伍保留健康的答案；⑤我方已经赢下换血竞赛时优先攻击；' +
        '⑥换人会白送对手一次攻击；' +
        '⑦太晶化由另一个独立的问题（tera）决定，与选哪一招无关 —— 太晶之后你照样可以点任意一个招；' +
        '⑦b. 对手会不会换人由 opp_switch 问题决定 —— 那是你自己的判断，不是别人给你的数字；' +
        '出招时请把它和这里的两个走向对上（强化选项和换人选项里都给了「它不换 / 它换」各自的数）；' +
        '⑧强化招（剑舞/诡计/龙之舞/冥想…）和攻击【都要挨对手这一发】—— 差别只在「这一回合的伤害」换成「之后每一击都更强」。' +
        '所以不要因为强化选项里写了挨打多少就回避它：攻击选项里同样写了。' +
        '判据看【回合数】：强化后把「需 N 回合」压缩到更小的 M 回合、或从打不死变成一击必杀 → 值得；' +
        '★★但【总回合数一样 ≠ 不值得】★★ —— 若「1 回合强化 + M 回合打死」正好等于「N 回合直接打死」，' +
        '两条路挨打的次数和花的回合【完全相同】，唯一区别是强化这条路结束时你手里多一个 +能力，' +
        '而且它【会一直带到后面每一只】（面板会给「带过去之后」那几只怕什么变快）。' +
        '这种打平是【白赚】，面板会明确写【★白赚】；把它读成「没差别」就等于白扔一个 +能力。' +
        '真正不值得的只有三类：①强化后反而【多花】回合；②对手已经残血、或你本回合就能击杀它（先杀人）；' +
        '③对手这回合大概率换人/回复，把你买的这一回合拿回去。' +
        '只回答一个选项 id。',
      criteria,
    },
  };
  // 三个问题在同一次调用里一起回答：①出哪一招 ②这次要不要用太晶 ③对手会不会换人
  // 太晶没有收益时【不问】（Jev 就没有机会浪费那唯一一次机会）
  if (teraPayoff) Object.assign(questions, buildTeraQuestion(teraInfo));
  Object.assign(questions, buildOppSwitchQuestion(risk, state));
  return { actions, questions, state, threats, tera: teraInfo, teraPayoff, lockNote, moveFallback, risk,
    lockedMoves: { only: moveList, blocked: lockedAway } };
}

// ★ 最终裁定「这次到底用不用太晶」—— 【代码说了算，不是模型说了算】。
//   三道闸：①代码先算出没有收益就直接否决；②换人时不可能太晶；
//   ③进攻型太晶只对特定招生效，Jev 点了别的招就等于白用。
export function resolveTera(teraInfo, teraPayoff, jevSaidUse, chosen) {
  if (!teraInfo || !teraPayoff || !jevSaidUse) return false;
  if (!chosen || chosen.kind !== 'move') return false;
  const offensive = teraInfo.isBreakthrough && chosen.moveName === (teraInfo.best && teraInfo.best.move);
  const defensive = teraInfo.savedCount > 0;
  return !!(offensive || defensive);
}

// ---------- 2.5) 强制换人（场上宝可梦倒下） ----------
// ★ 实测的重大缺陷：我方宝可梦倒下时，Showdown 发的是【只有 forceSwitch、没有 active】的请求
//   （sim 源 battle.mjs:1245 → requests[i] = { forceSwitch: switchTable, side: ... }）。
//   此前不看这个字段，照常按「出招」组装问题，于是面板在晶光花 0% 血时让玩家「点大地之力」——
//   那一手在客户端【根本点不下去】。用户当场指出：「强制换人的情况下不会告诉我换谁」。
export function buildForceSwitchQuestion(state) {
  const opp = state.opp || {};
  const oppActive = opp.active || {};
  const actions = [];
  for (const b of (state.me.bench || [])) {
    if (b.hpPercent <= 0) continue;
    actions.push(switchFeature(b.set || {}, opp.sets || {}, opp.revealedMoves || {}, b.species,
      oppActive.species, oppActive.hpPercent, b.hpPercent));
  }
  const criteria = {};
  for (const a of actions) {
    const parts = [];
    if (a.hpPercent < 100) parts.push('它自己只剩 ' + a.hpPercent + '% 血');
    if (a.worst) {
      parts.push('换上来这一回合要吃约 ' + a.worst.pct.toFixed(0) + '% 伤害（' + a.worst.from + ' 的 ' + a.worst.mv + '）');
      if (a.worst.pct >= a.hpPercent) parts.push('【换上来就会被一击必杀，绝对别选它】');
    } else {
      parts.push('暂无已知的换入威胁');
    }
    parts.push(a.myOutput
      ? '它最强的一手能打 ' + (a.myOutputPct || 0).toFixed(0) + '%（' + a.myOutput.name + '）'
      : '没有已知的有效输出');
    if (a.priorityWorst && a.priorityWorst.priority > 0) {
      parts.push('注意对手的 ' + a.priorityWorst.mv + ' 是先制+' + a.priorityWorst.priority + '，换上躲避不掉');
    }
    criteria[a.id] = '换上 ' + a.name + '：' + parts.join('；') + '。';
  }
  const questions = actions.length ? {
    action: {
      type: 'choice',
      instructions:
        '你场上的宝可梦已经倒下，本回合【必须换人，不能出招】。' +
        '换上来之后对手会立刻攻击它，所以要优先选「扛得住、而且换上来还能打」的那一只。' +
        '规则：①换上来会被一击必杀的绝对不要选；②换完就是新回合，要挑对整局展开有利的对位；' +
        '③血太少的别急着送上去。只回答一个选项 id。',
      criteria,
    },
  } : null;
  return { actions, questions, threats: [], forceSwitch: true };
}

// ---------- 3) 演示局面 ----------
const DEMO = {
  turn: 20,
  me: { active: { species: 'Dragapult', hpPercent: 30, set: { ability: 'Infiltrator', item: 'Choice Specs', nature: 'Timid', evs: { spa: 252, spe: 252 }, moves: ['Shadow Ball', 'Draco Meteor', 'U-turn', 'Fire Blast'] } },
        bench: [{ species: 'Great Tusk', hpPercent: 0, set: { ability: 'Protosynthesis', item: 'Leftovers', nature: 'Impish', evs: { hp: 252, def: 252 }, moves: ['Headlong Rush', 'Rapid Spin', 'Ice Spinner', 'Knock Off'] } }] },
  opp: { active: { species: 'Mimikyu', hpPercent: 87 },
         revealed: ['Swampert', 'Corviknight', 'Dragapult', 'Rillaboom', 'Rotom-Heat', 'Mimikyu'],
         revealedMoves: { Mimikyu: ['Play Rough', 'Shadow Claw', 'Shadow Sneak', 'Swords Dance'] },
         sets: { Mimikyu: { ability: 'Disguise', item: 'Life Orb', nature: 'Jolly', evs: { atk: 252, spe: 252 } } } },
};

if (process.argv[1] && process.argv[1].endsWith('harness.mjs')) {
  const mock = process.argv.includes('--mock');
  const demo = process.argv.includes('--demo');
  const fileArg = process.argv.slice(2).find(a => !a.startsWith('--'));
  const state = demo || !fileArg ? DEMO : JSON.parse(readFileSync(fileArg, 'utf8'));
  if (!mock && !jevAvailable()) {
    console.log('⚠️ 没有可用凭据。二选一：');
    console.log('   A) TYPESAFE_API_KEY — 官方已暂停新注册');
    console.log('   B) CF_ACCOUNT_ID + CF_API_TOKEN — Cloudflare Workers AI（免费额度即可跑 Jev）');
    console.log('   先用 --mock 验证流程。');
  }
  // ★ 这里【不再有第二条决策流水线】。线的调度在 serve.mjs（唯一的入口），
  //   这个 CLI 只是「把问题组装出来 + 问一次 Jev」的自检，用来看清喂进去的东西长什么样。
  const built = buildQuestion(state);
  const jevInput = {
    position: { turn: state.turn,
      our_active: { species: state.me.active.species, hp_percent: state.me.active.hpPercent },
      opponent_active: { species: state.opp.active.species, hp_percent: state.opp.active.hpPercent } },
    actions: built.actions.map(a => ({ id: a.id, name: a.name, verdict: a.verdict || null })),
  };
  const res = mock ? await askJevMock(jevInput, built.questions) : await askJev(jevInput, built.questions, {});
  const pick = res.answers && res.answers.action && res.answers.action.choice;
  const chosen = built.actions.find(a => a.id === pick) || null;
  const useTera = resolveTera(built.tera, built.teraPayoff, !!(res.answers.tera && res.answers.tera.choice === 'use'), chosen);
  console.log(JSON.stringify({ pick, name: chosen && chosen.name, useTera,
    oppSwitch: res.answers.opp_switch ? res.answers.opp_switch.choice : null,
    confidence: res.answers.action && res.answers.action.confidence, model: res.model, elapsedMs: res.elapsedMs }, null, 2));
  console.log('\n可选行动：');
  for (const a of built.actions) console.log('  ' + a.id.padEnd(26) + (built.questions.action.criteria[a.id] || ''));
  for (const q of ['tera', 'opp_switch']) {
    if (!built.questions[q]) continue;
    console.log('\n【' + q + '】');
    for (const [k, v] of Object.entries(built.questions[q].criteria)) console.log('  ' + k.padEnd(11) + v.slice(0, 260));
  }
}

// ---------- 5) 选人阶段（team preview）：推荐先发 ----------
// 这一手在全局权重极高 —— 先发送错，整局就被动。
// 事实层：我方 6 只（队伍文件，配置确定）× 对方 6 只（队伍预览【只给物种】，
// 配置走 meta-sets 最常见配置，属于【假设】不是事实）。
function bestMoveOf(atkSp, atkSet, defSp, defSet) {
  let best = null;
  for (const mv of (atkSet.moves || [])) {
    const f = moveFeature(atkSp, atkSet, defSp, defSet, mv, 100);
    if (f && f.kind === 'move' && (!best || (f.expPct || 0) > (best.expPct || 0))) best = f;
  }
  return best;
}

export function buildTeamPreviewQuestion(state) {
  const myTeam = state.me.team || [];
  const oppTeam = state.opp.team || [];
  if (!myTeam.length || !oppTeam.length) return null;

  // ★★ 先发选项必须贴出「它能不能撒钉 / 除钉」这个标签。★★
  //   下面的总则②早就写了「先发能设置场地（隐形岩/撒菱）或能清除场地（高速旋转）通常加分」——
  //   可**每个选项里一个字都没有**，模型只能靠猜谁有这个招。规则写在总则里、事实不在选项上，
  //   结果就是选不出来（「没有标签的选项 = 不存在的选项」，本项目第 5 次，2026-09-27）。
  //   钉子收益逐只可算：隐形岩 = 最大血 / 8 × 岩石相性（对手 6 只是公开信息）。
  const hzShim = { opp: { revealed: oppTeam.map(x => x.species) } };
  const REMOVER_OF = { rapidspin: '高速旋转', defog: '清除浓雾', mortalspin: '晶光转转',
    tidyup: '大扫除', courtchange: '换场' };
  const roleOf = (set) => {
    const mvs = (set.moves || []).map(m => Dex.moves.get(m)).filter(m => m.exists);
    return {
      setter: mvs.find(m => HAZARD_OF[m.id]) || null,
      remover: mvs.find(m => REMOVER_OF[m.id]) || null,
    };
  };

  const actions = [];
  for (const me of myTeam) {
    const mySet = me.set || {};
    const rows = [];
    let bestOut = null, worstIn = null;
    for (const op of oppTeam) {
      const oppSet = op.set || {};
      const out = bestMoveOf(me.species, mySet, op.species, oppSet);
      const inn = bestMoveOf(op.species, oppSet, me.species, mySet);
      let mySpe = 0, opSpe = 0;
      try { mySpe = mk(me.species, mySet).stats.spe; } catch (e) {}
      try { opSpe = mk(op.species, oppSet).stats.spe; } catch (e) {}
      rows.push({ opp: op.species, out, inn, mySpe, opSpe, faster: mySpe > opSpe });
      if (out && (!bestOut || (out.expPct || 0) > (bestOut.expPct || 0))) bestOut = { pct: out.expPct, name: out.name, vs: op.species };
      if (inn && (!worstIn || (inn.expPct || 0) > (worstIn.expPct || 0))) worstIn = { pct: inn.expPct, name: inn.name, from: op.species };
    }
    const role = roleOf(mySet);
    actions.push({
      id: 'lead:' + Dex.species.get(me.species).id,
      name: me.species, kind: 'lead',
      item: mySet.item, ability: mySet.ability,
      hazardSetter: role.setter ? role.setter.name : null,
      hazardRemover: role.remover ? role.remover.name : null,
      bestOut, worstIn,
      fasterCount: rows.filter(r => r.faster).length,
      total: rows.length,
      rows,
    });
  }

  const criteria = {};
  for (const a of actions) {
    const parts = [];
    if (a.bestOut) parts.push('最能打 ' + a.bestOut.vs + '（' + a.bestOut.name + ' ' + (a.bestOut.pct || 0).toFixed(0) + '%）');
    if (a.worstIn) {
      parts.push('最怕 ' + a.worstIn.from + '（' + a.worstIn.name + ' ' + (a.worstIn.pct || 0).toFixed(0) + '%' +
        ((a.worstIn.pct || 0) >= 100 ? '，可秒杀' : '') + '）');
    }
    parts.push('速度 ' + Math.max(...a.rows.map(r => r.mySpe)) + '，快过 ' + a.fasterCount + '/' + a.total);
    // ★ 撒钉 / 除钉：整段事实（每只吃多少、收益高不高）直接复用 hazardFeature 的同一份数字
    if (a.hazardSetter) {
      let tip = '';
      try { tip = hazardFeature(hzShim, a.hazardSetter).replace(/^【钉子】/, ''); } catch (e) { tip = ''; }
      parts.push('★ 它能【撒钉子】：' + (tip || a.hazardSetter + '（算不出对方 6 只的吃到量）'));
    }
    if (a.hazardRemover) {
      parts.push('★ 它能【除钉】：' + a.hazardRemover + '（对手铺的钉子会被清掉）');
    }
    if (!a.hazardSetter && !a.hazardRemover) parts.push('它【不会撒钉、也不会除钉】');
    criteria[a.id] = '先发 ' + a.name + '（' + (a.item || '无道具') + '·' + (a.ability || '?') + '）：' + parts.join('；');
  }

  const questions = {
    action: {
      type: 'choice',
      instructions:
        '选择这局的【先发】（第一只上场）。这是整局的起点，权重极高。' +
        '对手 6 只的【物种】已公开，但它们的招式/道具/努力值只有【最常见配置】——属于推测，不是事实。' +
        '规则：①绝不要先发会被对手多只宝可梦一击必杀的；' +
        '②先发能设置场地（隐形岩/撒菱）或能清除场地（高速旋转）通常加分 —— ' +
        '每个选项末尾都标了【它能撒钉子】/【它能除钉】/【都不会】以及具体的吃到量，照那个看；' +
        '③注意免疫关系与先制招（先制无视速度）；' +
        '④不只看第一回合，要考虑整局展开；' +
        '⑤速度快的先发能抢先手，但被先制招克制时无效。只回答一个选项 id。',
      criteria,
    },
  };
  return { actions, questions, preview: true };
}

export async function decideLead(state, opts = {}) {
  const built = buildTeamPreviewQuestion(state);
  if (!built) return null;
  const jevInput = {
    phase: 'teampreview',
    my_team: (state.me.team || []).map(m => ({ species: m.species, item: (m.set || {}).item })),
    opponent_team: (state.opp.team || []).map(m => ({ species: m.species, likely_config: (m.set || {}).item,
      config_is_assumed: !!(m.set || {}).assumed })),
    candidates: built.actions.map(a => ({ id: a.id, species: a.name,
      best_damage_vs: a.bestOut, worst_incoming: a.worstIn,
      faster_than: a.fasterCount + '/' + a.total })),
  };
  const res = opts.mock ? await askJevMock(jevInput, built.questions) : await askJev(jevInput, built.questions, opts);
  const pick = res.answers && res.answers.action && res.answers.action.choice;
  return {
    action: built.actions.find(a => a.id === pick) || null,
    pick, confidence: res.answers && res.answers.action && res.answers.action.confidence,
    probabilities: res.answers && res.answers.action && res.answers.action.probabilities,
    elapsedMs: res.elapsedMs, model: res.model, actions: built.actions, questions: built.questions,
  };
}
