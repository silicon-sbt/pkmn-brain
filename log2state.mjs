// Showdown 原始对战日志 → harness state 适配器
//
// 这是"让 Jev 能在真实对局里用上"唯一缺的一环：
//   harness.buildQuestion 吃结构化 state，而实战里有的是 Showdown 日志。
//
// 信息来源（严格限定在实战能知道的范围）：
//   我方  —— 队伍文件（招式/道具/特性/努力值自己清楚）+ 日志里的当前 HP 与能力等级
//   对方  —— 只认日志里【已公开】的招式/道具/特性/太晶；未公开的走 meta-sets 最常见配置兜底
//
// ★ 两个必须按 (side, 物种) 双键的坑（都实际踩过）：
//   ① Showdown 的槽位标签【带名字】：`|switch|p1a: Glimmora|...`，换人后标签会变，
//      用整条标签当 key 会导致同一位置记成多条。
//   ② 双方可能有【同名宝可梦】（实测镜像局两边都有雄伟牙）。只用物种名当 key，
//      两边的 HP / 能力等级 / 招式会互相覆盖 —— 这个 bug 极隐蔽。
import { readFileSync } from 'node:fs';

const HP_RE = /^(\d+)\/(\d+)$/;
const key = (side, sp) => side + ':' + sp;
const cap = (n) => Math.max(-6, Math.min(6, n));

export function parseLog(log) {
  const out = {
    players: {}, slot: {}, species: {},           // species['p1a'] = 该位置【当前】是谁
    preview: { p1: [], p2: [] },                  // 队伍预览公开的 6 只
    everSeen: { p1: new Set(), p2: new Set() },   // 出过场的（含已下场的）
    hp: {}, fainted: {}, moves: {}, items: {}, abilities: {}, tera: {}, boosts: {}, broken: {},
    // ★ 先后手要用到的三样，以前【一个都没记】，所以面板从来没算对过顺序。
    weather: null,            // 'RainDance' / 'SunnyDay' / 'Sandstorm' / 'Snow' / null
    status: {},               // status['p1a: Kyurem' 的 key] = 'par' | 'brn' | ...
    speedFlag: {},            // 夸克充能/古代活性 的【提速】档（保留给旧调用方；等价于 paradox === 'spe'）
    // ★ 古代活性 / 夸克充能【提的是哪一项】：'atk'|'def'|'spa'|'spd'|'spe'
    //   引擎日志是 |-start|p1a: 大伟牙|protosynthesisatk —— 以前只认 ...spe，攻击档全丢了。
    paradox: {},
    hazards: { p1: [], p2: [] }, turn: 0,
  };
  for (const raw of log) {
    if (typeof raw !== 'string' || !raw.startsWith('|')) continue;
    const p = raw.split('|');
    const kind = p[1];
    const label = p[2] || '';
    const slot = label.slice(0, 3);                 // 'p1a: Glimmora' -> 'p1a'
    const side = slot.slice(0, 2);                  // 'p1a' -> 'p1'
    const sp = out.species[slot];                   // 该位置【当前】是谁
    const K = sp ? key(side, sp) : null;

    if (kind === 'player') { out.players[p[2]] = p[3]; continue; }
    if (kind === 'turn') { out.turn = Number(p[2]) || out.turn; continue; }
    if (kind === 'poke') {                       // ★ 队伍预览：这 6 只是公开信息
      const name = (p[3] || '').split(',')[0].trim();
      if (name && out.preview[p[2]]) out.preview[p[2]].push(name);
      continue;
    }

    if (kind === 'switch' || kind === 'drag' || kind === 'replace') {
      const name = (p[3] || '').split(',')[0].trim();
      if (!name) continue;
      // ★ 换下场，能力等级清零（游戏规则）。日志【不会】替我们发一条 clearboost，
      //   所以必须自己清 —— 否则「它换下去又换上来」会带着上次的 +6，伤害凭空翻几倍。
      //   drag（被吼叫/吹飞）同样清零；replace（幻觉破除）不算换人，不清。
      const prev = out.species[slot];
      if (prev && prev !== name && (kind === 'switch' || kind === 'drag')) {
        delete out.boosts[key(side, prev)];
        delete out.paradox[key(side, prev)];   // 古代活性/夸克充能 的 volatile 也随换人消失
        out.speedFlag[key(side, prev)] = false;
      }
      out.species[slot] = name;
      out.everSeen[side] && out.everSeen[side].add(name);
      const m = (p[4] || '').match(HP_RE);
      out.hp[key(side, name)] = m ? Math.round(Number(m[1]) / Number(m[2]) * 100) : 100;
      continue;
    }
    if (kind === 'detailschange' || kind === 'formechange') {
      const name = (p[3] || '').split(',')[0].trim();
      if (!name || !sp) continue;
      out.hp[key(side, name)] = out.hp[K] ?? 100;   // 形态变了，血跟着走
      out.species[slot] = name;
      continue;
    }
    // ★ 场地事件必须在 if (!K) 之前处理 —— 它是【场地级】的，
    //   槽位标签是 'p2: 名字'，取不到具体宝可梦，K 恒为 null。
    //   放在后面会被 continue 直接跳过（实测：场地一直显示为空）。
    if (kind === '-sidestart' || kind === '-sideend') {
      const s = label.slice(0, 2);               // 'p2: 122866ff' -> 'p2'
      const what = (p[3] || '').replace(/^move: /, '');
      if (!what || !out.hazards[s]) continue;
      if (kind === '-sidestart') { if (!out.hazards[s].includes(what)) out.hazards[s].push(what); }
      else out.hazards[s] = out.hazards[s].filter(x => x !== what);
      continue;
    }

    if (!K) continue;

    // ★ 天气是【场地级】的，标签不是宝可梦槽位 —— 必须在 if (!K) 之前处理。
    if (kind === '-weather') { out.weather = (p[2] && p[2] !== 'none') ? p[2] : null; continue; }

    if (kind === '-damage' || kind === '-heal' || kind === '-sethp') {
      const m = (p[3] || '').match(HP_RE);
      if (m) out.hp[K] = Math.round(Number(m[1]) / Number(m[2]) * 100);
      continue;
    }
    if (kind === 'faint') { out.hp[K] = 0; out.fainted[K] = true; continue; }

    if (kind === 'move') { if (p[3]) (out.moves[K] ||= new Set()).add(p[3]); continue; }
    if (kind === '-item') { out.items[K] = p[3]; continue; }
    if (kind === '-enditem') { if (!out.items[K]) out.items[K] = '(已消耗) ' + (p[3] || ''); continue; }
    if (kind === '-ability') { out.abilities[K] = p[3]; continue; }
    if (kind === '-activate') {
      // ★ 画皮 / 结冻头 被打破时，Showdown 发的是 |-activate|p2a: Mimikyu|Disguise。
      //   不记这一下，harness.firstHitBlock 会【整局】都以为它还有画皮，
      //   把真实伤害一直报成 0 —— 面板会一直说「这一击被画皮挡下，打不死」。
      const what = String(p[3] || '').toLowerCase().replace(/[^a-z]/g, '');
      if (what === 'disguise' || what === 'iceface') out.broken[K] = what;
      continue;
    }
    if (kind === '-terastallize') { out.tera[K] = p[3]; continue; }

    if (kind === '-boost' || kind === '-unboost' || kind === '-setboost') {
      const stat = p[3], amt = Number(p[4]) || 0;
      out.boosts[K] ||= {};
      const cur = out.boosts[K][stat] || 0;
      out.boosts[K][stat] = kind === '-setboost' ? cap(amt) : cap(cur + (kind === '-unboost' ? -amt : amt));
      continue;
    }
    if (kind === '-clearboost') { out.boosts[K] = {}; continue; }

    // ★ 麻痹会让速度减半（第九世代 ×0.5）—— 不记它，先后手就会算反。
    if (kind === '-status') { if (p[3]) out.status[K] = p[3]; continue; }
    if (kind === '-curestatus') { delete out.status[K]; continue; }
    // ★ 夸克充能 / 古代活性 的提速档（实测日志：|-start|p2a: Iron Treads|quarkdrivespe）。
    //   它决定了铁辙迹能不能先手 —— 不记这一条，速度比较就是错的。
    if (kind === '-start' || kind === '-end') {
      const what = String(p[3] || '').toLowerCase().replace(/[^a-z]/g, '');
      const px = /^(protosynthesis|quarkdrive)(atk|def|spa|spd|spe)$/.exec(what);
      if (px) {
        if (kind === '-start') { out.paradox[K] = px[2]; out.speedFlag[K] = (px[2] === 'spe'); }
        else { delete out.paradox[K]; out.speedFlag[K] = false; }
      } else if (kind === '-end' && (what === 'quarkdrive' || what === 'protosynthesis')) {
        delete out.paradox[K]; out.speedFlag[K] = false;
      }
      continue;
    }

  }
  return out;
}

// meSide: 'p1'|'p2'；myTeam: 队伍数组；META: data/meta-sets.json
export function stateFromLog(log, meSide, myTeam, META) {
  const P = parseLog(log);
  const oppSide = meSide === 'p1' ? 'p2' : 'p1';
  const myActive = P.species[meSide + 'a'];
  const oppActive = P.species[oppSide + 'a'];
  if (!myActive || !oppActive) return null;

  // ★ 形态会变（Palafin-Hero / Morpeko-Hangry / Ogerpon-Wellspring-Tera…），日志里的名字
  //   就不再等于队伍里的名字。精确匹配失败时必须逐段砍后缀再试 —— 否则 set 会变成 {}，
  //   道具/特性/性格/努力值全丢，整局伤害数字都是错的，而且【没有任何提示】。
  const findMine = (sp) => {
    let hit = myTeam.find(m => m.species === sp);
    if (hit) return hit;
    const parts = String(sp).split('-');
    for (let i = parts.length - 1; i >= 1; i--) {
      hit = myTeam.find(m => m.species === parts.slice(0, i).join('-'));
      if (hit) return hit;
    }
    return null;
  };
  // ★ 太晶的两层语义必须分开存（这里差点埋一个 33% 的错）：
  //   teraType      = 这只【已经太晶了】→ 传给 @smogon/calc 后它会按太晶后的属性算攻防
  //   teraAvailable = 它的太晶属性是什么（还没用掉太晶时才给）→ 用来生成「太晶版招式」选项
  //   混成一个字段的后果：还没太晶的宝可梦被当成已太晶，所有伤害凭空多出 1/3 的 STAB。
  const teraOf = (sp) => P.tera[key(meSide, sp)] || undefined;
  const setOf = (m, sp) => ({
    ability: m.ability, item: m.item, nature: m.nature, evs: m.evs, moves: m.moves,
    boosts: P.boosts[key(meSide, sp)] || {},
    paradox: P.paradox[key(meSide, sp)] || null,
    teraType: teraOf(sp),
    teraAvailable: (!teraOf(sp) && m.teraType) ? m.teraType : undefined,
    intact: P.broken[key(meSide, sp)] ? false : undefined,
  });

  // ★ 对手名单 = 队伍预览的 6 只（实战里公开）∪ 实际出过场的
  const seenOpp = [...new Set([...(P.preview[oppSide] || []), ...P.everSeen[oppSide]])];

  const revealedMoves = {}, oppSets = {};
  for (const sp of seenOpp) {
    const K = key(oppSide, sp);
    const known = P.moves[K] ? [...P.moves[K]] : [];
    const meta = META[sp] || {};
    revealedMoves[sp] = [...new Set([...known, ...(meta.moves || [])])];
    oppSets[sp] = {
      ability: P.abilities[K] || meta.ability,
      item: P.items[K] || meta.item,
      // ★★ 对手的【能力等级】以前【根本没往这里放】—— 于是 calc 全程按 +0 算对手的输出。★★
      //   实测（2026-09-26 第三局）：玛力露丽腹鼓 +6 攻之后，面板还写着
      //   「它打你很痛（Liquidation 66%）」，而 +6 的真实值是 223-263%；
      //   更要命的是 +6 的 Aqua Jet 是 105-124%（先制、必杀），
      //   可按 +0 只有 27-31% ⇒ kills_our_active=false ⇒【先制必杀警告一次都没触发】，
      //   面板连着让 5 只上去送。详见 brain/AGENTS.md「对手的能力等级」。
      boosts: P.boosts[K] || {},
      paradox: P.paradox[K] || null,
      nature: meta.nature, evs: meta.evs,
      assumed: !P.abilities[K] || !P.items[K],
      // ★ 画皮/结冻头已经用掉了就必须告诉 calc 那一侧，否则 firstHitBlock 会一直拦着
      intact: P.broken[K] ? false : undefined,
      // ★ 对手太晶后，防御面按太晶属性算（实测：太晶飞行的赛富豪吃地面招 = 0 伤害）。
      //   字段名必须是 teraType —— @smogon/calc 只认这个名字，认不出 'tera'（静默忽略）。
      teraType: P.tera[K] || undefined,
    };
  }

  const bench = myTeam
    .filter(m => m.species !== myActive)
    .filter(m => P.hp[key(meSide, m.species)] !== 0)
    .map(m => ({ species: m.species, hpPercent: P.hp[key(meSide, m.species)] ?? 100, set: setOf(m, m.species) }));

  const meMon = findMine(myActive);
  return {
    turn: P.turn,
    me: {
      active: { species: myActive, hpPercent: P.hp[key(meSide, myActive)] ?? 100,
                set: meMon ? setOf(meMon, myActive) : {} },
      bench,
    },
    opp: {
      active: { species: oppActive, hpPercent: P.hp[key(oppSide, oppActive)] ?? 100 },
      revealed: seenOpp,
      revealedMoves,
      sets: oppSets,
    },
    _hazards: { mine: P.hazards[meSide], theirs: P.hazards[oppSide] },
    // ★ 先后手三件套，交给 harness 算最终速度
    _weather: P.weather,
    _status: { mine: P.status[key(meSide, myActive)] || null, theirs: P.status[key(oppSide, oppActive)] || null },
    _mySpeedFlag: !!P.speedFlag[key(meSide, myActive)],
    _oppSpeedFlag: !!P.speedFlag[key(oppSide, oppActive)],
    _players: P.players,
    // ★ 我方条目找不到时，后面所有伤害数字都不可信 —— 必须让上层能喊出来，不能静默
    _warnings: meMon ? [] : ['我方「' + myActive + '」在队伍数据里找不到条目（形态变化？）—— 道具/特性/努力值全丢，本回合数字不可信'],
  };
}

// ---------- 选人阶段（team preview）的 state ----------
// 这时还没有 |switch|，stateFromLog 会返回 null —— 但队伍预览已经把
// 【双方 6 只的物种】都公开了（|poke| 行），足以推荐先发。
// 我方配置来自队伍文件（确定）；对方只有物种，配置走 meta-sets 最常见配置（假设）。
export function isTeamPreview(log) {
  const P = parseLog(log);
  const started = Object.keys(P.species).length > 0;   // 有 |switch| 记录就说明已开场
  return !started && (P.preview.p1.length > 0 || P.preview.p2.length > 0);
}

// oppTeamOverride: 由浏览器脚本从 battle.farSide.pokemon 直接取来的对手 6 只物种。
// ★ 为什么需要它：客户端把队伍预览存进 battle 的 side 对象（battle.ts:3730-3737 的
//   case 'poke' → rememberTeamPreviewPokemon → sides[n].addPokemon），
//   【不保证】|poke| 行会进入 battle.stepQueue。实测选人阶段拿不到 |poke| 行，
//   所以让浏览器侧直接给，比赌日志格式可靠。
export function previewStateFromLog(log, meSide, myTeam, META, oppTeamOverride) {
  const P = parseLog(log);
  const oppSide = meSide === 'p1' ? 'p2' : 'p1';
  const oppSpecies = (oppTeamOverride && oppTeamOverride.length)
    ? oppTeamOverride
    : (P.preview[oppSide] || []);
  if (!oppSpecies.length) return null;
  const mySetOf = (m) => ({ ability: m.ability, item: m.item, nature: m.nature, evs: m.evs, moves: m.moves });
  const oppSetOf = (sp) => {
    const meta = META[sp] || {};
    return { ability: meta.ability, item: meta.item, nature: meta.nature, evs: meta.evs,
             moves: meta.moves || [], assumed: true };
  };
  return {
    phase: 'teampreview',
    turn: P.turn,
    me: { team: myTeam.map(m => ({ species: m.species, set: mySetOf(m) })) },
    opp: { team: oppSpecies.map(sp => ({ species: sp, set: oppSetOf(sp) })), unknownConfig: true },
    _preview: P.preview,
    _players: P.players,
  };
}
