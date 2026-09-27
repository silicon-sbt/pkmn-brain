#!/usr/bin/env node
// 本地决策服务 —— 让浏览器脚本（Tampermonkey）能直接问 Jev
//
// 为什么不从浏览器直接调 Jev：
//   1. API 密钥绝不能进浏览器（脚本内容别人能看到、能改）
//   2. 日志解析 / state 构建复用 Node 侧现成代码，不在 JS 里重写一遍
//   3. 浏览器脚本只剩两件事：取日志、显示答案
//
// ★ 安全设计：只监听 127.0.0.1，且【不发 CORS 头】。
//   浏览器会拦掉跨源读取，所以网页 JS 调不通；用户脚本必须用 GM_xmlhttpRequest
//   （它绕过 CORS）才能调。这样即使别的网站知道你开了这个端口，也用不了你的额度。
//
// 端点:
//   GET  /health   → { ok, jev }
//   POST /decide   { log: "<对战日志全文>", me?: "<你的PS用户名>", team?: "teams/ou-a.txt",
//                    request: <整包 room.request>, localTeams: [{name, packedTeam}, …] }
//                  ★ request 与 localTeams 都【原样转发】，服务端自己解析并挑来源 ——
//                    浏览器侧挑字段曾经导致「挑空了服务端看不出来、悄悄回退兜底队伍」。
//                  ★ 同一份 log + 同一个 requestType 在 5 分钟内只问 Jev 一次（见 dedupeKey）。
//
// 单独调试（不开服务）:
//   node serve.mjs --log side/jev/_sample-battle.log --me gilicon
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stateFromLog, isTeamPreview, previewStateFromLog } from './log2state.mjs';
import { buildQuestion, buildTeamPreviewQuestion, buildForceSwitchQuestion, decideLead, resolveTera } from './harness.mjs';
import { askJev, jevAvailable } from './jev.mjs';
import { loadTeam, zhInfo } from './toolkit/tools/lib.mjs';
import { pickLocalTeam, alignLocal } from './team-local.mjs';
import { logDecision } from './decide-log.mjs';
import { cfg, announceConfig } from './config.mjs';
announceConfig();

// 外置大脑属于「对战辅助」那一半；数据/队伍/中文表属于「工具与技能」那一半（./toolkit/）
const ROOT = fileURLToPath(new URL('./toolkit/', import.meta.url));
const META = JSON.parse(readFileSync(ROOT + 'data/meta-sets.json', 'utf8'));
// 都能被环境变量临时覆盖，其次是 brain/config.json，再是内置默认值
const PORT = Number(process.env.JEV_PORT || cfg.server.port);
const DEFAULT_TEAM = cfg.team.default;
const { Dex } = await import('@pkmn/dex');

// 简单速率限制：脚本若陷入循环会持续烧 Jev 额度（付费 API）。超限就拒绝，不是静默丢弃。
const RATE_MAX = Number(process.env.JEV_RATE_MAX || cfg.server.rateMaxPerMinute);
// ★★ 同一回合的重复请求：服务端兜底去重（2026-09-27 实测又发生了一次）★★
//   浏览器那侧的去重键是 turn + requestType + rqid，但决策日志显示【每一回合都问了两次】
//   （两三条日志的 logLines 完全相同、间隔 1~3 秒）。原因还没定位到，但代价是确定的：
//   双倍烧 Jev 额度，而且两次答案可能不一样（实测 #8 move:futuresight 0.27 / #9 switch:greattusk 0.31），
//   面板显示哪个全看谁后回来。
//   所以这里再加一道【服务端】兜底：同一份日志 + 同一个 requestType 在 TTL 内只问一次，
//   第二次直接回上一次的答案。**命中要打出来**（静默复用 = 另一种静默失败）。
const recentDecisions = new Map();     // key → { at, out }
const DEDUPE_MS = 5 * 60 * 1000;
function dedupeKey(raw, body) {
  const req = body && body.request;
  const rt = (req && req.requestType) || '?';
  let h = 0x811c9dc5;                                  // FNV-1a，够用就行
  for (let i = 0; i < raw.length; i++) { h ^= raw.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return rt + ':' + raw.length + ':' + h.toString(36);
}

let rateWindow = Date.now(), rateCount = 0;
function rateOk() {
  const now = Date.now();
  if (now - rateWindow > 60000) { rateWindow = now; rateCount = 0; }
  return ++rateCount <= RATE_MAX;
}

// ══════════ 自动读取【你正在用的队伍】 ══════════
// 不再写死 teams/ou-a.txt —— 你换队、换招式、换道具，这里自动跟着变。
//
// 两条路，**本地队伍优先**（判定逻辑在 team-local.mjs，自检在 _verify-team-local.mjs）：
//
//   ① 浏览器转发的 PS.teams.list → packedTeam 解出来带【精确】的 nature/evs/ivs。
//      为什么需要它：request 里根本没有这三项（引擎 pokemon.js:785 getSwitchRequestData 只发最终
//      数值 stats）。从数值反解在 L100 上精确，但两处会坏 —— 这只倒下（condition="0 fnt"）时
//      HP 努力值被当成 0；等级非 100（VGC/Champions）时反解直接放弃、努力值全 0。
//   ② 认不出来才退回 request.side.pokemon[]，每个元素含
//      details(物种) / moves(招式) / item / ability / teraType / stats(精确数值) / condition(当前HP)
//      前四项直接可用；努力值和性格从 stats 反解（L100、IV31 的公式可逆）。
//
// ⚠️ 哪条路成功、失败时为什么，全部由 resolveTeam() 写进 teamSource，黑窗口打一行、
//    面板上也显示一行 —— 这是本项目踩过最多的坑（静默回退兜底队伍，玩家换了队也不生效）。
const NATURES = (() => {
  const out = [];
  const stats = ['atk', 'def', 'spa', 'spd', 'spe'];
  for (const plus of stats) for (const minus of stats) {
    if (plus === minus) continue;
    const nm = { atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };
    out.push({ plus, minus, name: '+' + nm[plus] + ' -' + nm[minus] });
  }
  out.push({ plus: null, minus: null, name: 'Serious' });   // 中性
  return out;
})();
const NATURE_NAME = {
  '+Atk -Def': 'Lonely', '+Atk -SpA': 'Adamant', '+Atk -SpD': 'Naughty', '+Atk -Spe': 'Brave',
  '+Def -Atk': 'Bold', '+Def -SpA': 'Impish', '+Def -SpD': 'Lax', '+Def -Spe': 'Relaxed',
  '+SpA -Atk': 'Modest', '+SpA -Def': 'Mild', '+SpA -SpD': 'Rash', '+SpA -Spe': 'Quiet',
  '+SpD -Atk': 'Calm', '+SpD -Def': 'Gentle', '+SpD -SpA': 'Careful', '+SpD -Spe': 'Sassy',
  '+Spe -Atk': 'Timid', '+Spe -Def': 'Hasty', '+Spe -SpA': 'Jolly', '+Spe -SpD': 'Naive',
  'Serious': 'Serious',
};

// 由观测到的 stats 反解 性格 + 努力值。
// L100/IV31 公式：HP = 2*base + 31 + floor(EV/4) + 110；其他 = floor((2*base + 31 + floor(EV/4) + 5) * 性格系数)
function evsFromStats(species, obs) {
  if (!obs) return null;
  const sp = Dex.species.get(species);
  if (!sp.exists) return null;
  const base = sp.baseStats;
  // ★ 同一组数值常常有【多个性格/努力值组合都成立】。原来直接返回第一个 → 假装精确。
  //   选错性格会让那一项差 10%、并把努力值整错。多解时必须标出来。
  let found = null, hits = 0;
  for (const nat of NATURES) {
    const evs = {}; let ok = true;
    for (const s of ['hp', 'atk', 'def', 'spa', 'spd', 'spe']) {
      const target = obs[s];
      if (target == null) { evs[s] = 0; continue; }
      const mult = nat.plus === s ? 1.1 : nat.minus === s ? 0.9 : 1;
      let hit = -1;
      for (let k = 0; k <= 63; k++) {
        const st = s === 'hp'
          ? 2 * base.hp + 31 + k + 110
          : Math.floor((2 * base[s] + 31 + k + 5) * mult);
        if (st === target) { hit = k; break; }
      }
      if (hit < 0) { ok = false; break; }
      evs[s] = hit * 4;
    }
    if (ok) {
      const total = Object.values(evs).reduce((a, b) => a + Number(b), 0);
      if (total <= 508) { hits++; if (!found) found = { nature: NATURE_NAME[nat.name] || 'Serious', evs }; }
    }
  }
  return found ? { ...found, ambiguous: hits > 1, solutions: hits } : null;   // null = 反解失败（等级不是 100 等）
}

const idName = (kind, id) => {
  if (!id) return undefined;
  const e = Dex[kind].get(id);
  return e && e.exists ? e.name : id;
};

// request.side.pokemon[i] → 本项目的 set 格式。
// 性格与努力值从 request 给的 stats 反解（L100/IV31 的公式可逆，无性格歧义时与精确值等价）。
export function setFromRequest(mon) {
  const species = String(mon.details || '').split(',')[0].trim();
  // ★ request 的 stats 里【没有 HP】—— HP 在 condition（形如 "434/434" 或 "200/434"）。
  //   不补这一项，反解出来 HP 努力值恒为 0（实测：雄伟牙的 252HP 被算成 0）。
  const hpM = String(mon.condition || '').match(/^(\d+)\/(\d+)/);
  const obs = mon.stats ? { ...mon.stats } : null;
  if (obs && hpM) obs.hp = Number(hpM[2]);   // 用最大 HP 反解，不是当前 HP
  // ★ HP 反解不出来时，HP 努力值会静默变成 0，整局伤害偏低 —— 实测踩过一次（雄伟牙 252HP 被算成 0）。
  //   所以把「HP 有没有解出来」放进 _exactSource，让它出现在黑窗口的 [队伍] 行里。
  const hpKnown = !!(obs && obs.hp != null);
  const derived = evsFromStats(species, obs);   // 兜底：从 stats 反解
  const idToName = (kind, v) => idName(kind, v);
  return {
    species,
    item: idToName('items', mon.item),
    ability: idToName('abilities', mon.ability || mon.baseAbility),
    moves: (mon.moves || []).map(m => idName('moves', m)).filter(Boolean),
    teraType: idToName('types', mon.teraType),
    nature: derived ? derived.nature : 'Serious',
    evs: derived ? derived.evs : {},
    _exactSource: !derived ? 'none'
      : !hpKnown ? 'derived-无HP'
      : derived.ambiguous ? 'derived-多解(' + derived.solutions + ')' : 'derived',
  };
}

// ★ 队伍解析：先试【浏览器里本地存着的队伍】（精确），不行再回退反解。
//   为什么值得：request 里【没有努力值/性格/个体值】，反解在 L100 上虽然精确，
//   但 HP 读不出来（condition="0 fnt"）时会当成 0，等级非 100（VGC/Champions）时直接全 0。
//   本地队伍（PS.teams.list[].packedTeam）这几项都是精确的。
//
//   ⚠️ 但它是【第二个真相来源】，本项目在这上面栽过（挑空字段悄悄回退兜底队）。
//      所以规矩是：匹配全部在服务端做、只用它取 nature/evs/ivs、其余字段一律用 request 的，
//      并且「用了哪条路 / 为什么没用本地」都要写进 teamSource 打出来。
//      判定逻辑与自检在 team-local.mjs / _verify-team-local.mjs。
function resolveTeam(mons, localTeams) {
  const loc = pickLocalTeam(localTeams, mons, {
    // 我们的数值模型能不能反解这一只？不能（L50/Champions 的数值系统）就不拿数值当否决条件
    modelFits: (m) => setFromRequest(m)._exactSource !== 'none',
  });
  if (loc.sets) {
    const merged = alignLocal(loc.sets, mons);
    const miss = merged.filter(x => !x._localHit).length;
    const team = merged.map((x, i) => {
      if (x._localHit) return { ...x, _exactSource: 'local' };
      // 理论上一只都不该掉队（特征已经对过）。真掉了就【单只】退回反解 —— 不整队放弃，
      // 也绝不静默：miss 会被写进 teamSource 和黑窗口。
      return { ...setFromRequest(mons[i]), _exactSource: 'request反解(本地没对上)' };
    });
    return { team, detail: loc, miss,
      source: '正在用的队（本地「' + loc.picked + '」· ' + loc.source + '，努力值/性格/个体值精确）' +
        (miss ? ' ⚠️ 有 ' + miss + ' 只本地没对上，已单只退回反解' : '') };
  }
  const team = mons.map(setFromRequest);
  const derived = team.filter(x => x._exactSource === 'derived').length;
  return { team, detail: loc, miss: 0,
    source: '正在用的队（request 反解，' + derived + ' 只由实时数值反解）' +
      (loc.why ? ' ⚠️ 本地队伍没用上：' + loc.why : '') };
}

// 从各种可能的形状里找「我方队伍」，并【说明是在哪儿找到的】。
// 找到 0 只时返回 where='未找到'，调用方会把它连同 request 的完整结构一起打出来。
function pickTeamFromRequest(req) {
  const isMonList = (v) => Array.isArray(v) && v.length &&
    v[0] && typeof v[0] === 'object' && (v[0].details || v[0].species);
  if (req) {
    if (isMonList(req.side && req.side.pokemon)) return { mons: req.side.pokemon, where: 'request.side.pokemon' };
    if (isMonList(req.pokemon)) return { mons: req.pokemon, where: 'request.pokemon' };
    if (isMonList(req.team)) return { mons: req.team, where: 'request.team' };
    if (req.side) return { mons: null, where: 'request有side但side.pokemon不是宝可梦数组' };
  }
  return { mons: null, where: '未找到' };
}

// request 的真实结构 —— 队伍找不到时靠它定位，不用再猜。
function describeReq(req) {
  if (!req) return '无（浏览器没发 request 字段）';
  const side = req.side ? Object.keys(req.side).slice(0, 12).join(',') : '无side';
  const n = (req.side && Array.isArray(req.side.pokemon)) ? req.side.pokemon.length : '-';
  return 'keys=[' + Object.keys(req).slice(0, 12).join(',') + '] side.keys=[' + side +
    '] side.pokemon=' + n + ' active=' + (Array.isArray(req.active) ? req.active.length + '条' : '无');
}

// 选项 id → 中文显示名。★ 太晶选项的 name 带着「（太晶钢）」后缀，
// 直接拿它查中文必然查不到（会退化成英文全称），所以查名要用纯招式名 moveName，后缀再拼回去。
// 「换人」选项没有 verdict 字段（那是 moveFeature 才有的），面板会一片空白。
// 这里给它补一句：换上来吃多少 / 能打多少 —— 强制换人时玩家最需要的就是这两个数。
const verdictOf = (a) => {
  if (!a) return null;
  if (a.kind === 'switch') {
    const parts = [];
    if (a.worst) parts.push('换上来吃约 ' + Math.round(a.worst.pct) + '%（' + a.worst.mv + '）');
    if (a.myOutput) parts.push('能打 ' + Math.round(a.myOutputPct || 0) + '%（' + a.myOutput.name + '）');
    return parts.join(' · ') || null;
  }
  if (a.kind === 'setup' && a.setup && a.setup.after) {
    const s = a.setup;
    return '用完 ' + s.after.move + ' 打到 ' + s.after.pct.toFixed(0) + '%' +
      (s.gain != null ? '（+' + Math.round(s.gain) + ' 个百分点）' : '');
  }
  return a.verdict || null;
};

const zhOfAction = (a) => {
  const base = zhInfo(a.kind === 'switch' ? 'species' : 'moves', a.moveName || a.name).zh;
  return a.tera ? base + '（太晶' + zhInfo('types', a.tera).zh + '）' : base;
};

function sideOf(lines, me) {
  if (!me) return 'p1';
  for (const l of lines) {
    const m = l.match(/^\|player\|(p[12])\|([^|]*)\|/);
    if (m && m[2].trim().toLowerCase() === String(me).trim().toLowerCase()) return m[1];
  }
  // ★ 找不到就必须吼出来。以前静默返回 p1 —— 如果你其实是 p2，整局的敌我都会反过来，
  //   而面板上完全看不出异常（最坏的一种错：看起来一切正常）。
  console.log('[警告] 日志里没有玩家「' + me + '」：' +
    (lines.filter(l => l.startsWith('|player|')).join(' ') || '（日志里连 |player| 行都没有）') +
    ' —— 按 p1 处理；如果你其实是 p2，本局判断整局都是反的');
  return 'p1';
}

export async function decide({ log, me, team, oppTeam, request: reqRaw, localTeams }) {
  const lines = String(log || '').split(/\r?\n/).filter(Boolean);
  const t0 = Date.now();

  // ★ 队伍只有一个来源：整包 room.request（浏览器原样发过来），服务端自己从里面找。
  //   曾经有过第二条路（浏览器侧挑字段再发 body.myTeam），那是静默失败源 ——
  //   挑空了服务端看不出来，会悄悄回退到 teams/ou-a.txt，玩家换了队也不生效。已删除。
  //   找不到时【大声报出来】并打印 request 的真实结构，不靠猜。
  const req = reqRaw || null;
  const teamPick = pickTeamFromRequest(req);
  let myTeam = null, teamSource = '';
  if (teamPick.mons && teamPick.mons.length) {
    try {
      const res = resolveTeam(teamPick.mons, localTeams);
      myTeam = res.team;
      teamSource = res.source;
      console.log('[队伍] ' + teamSource);
      console.log('[队伍] ' + myTeam.map(x => x.species + '(' + (x.item || '无道具') + '/' +
        (x.moves || []).length + '招/太晶' + (x.teraType || '?') + ')' +
        (x._exactSource === 'local' ? '' : ' ⚠️' + x._exactSource)).join(' '));
      if (res.detail && res.detail.broken) {
        console.log('[队伍] ⚠️ 本地队伍里有 ' + res.detail.broken + ' 套解不开（没加载/损坏），已跳过');
      }
    } catch (e) { console.log('[队伍] 解析实时队伍失败，回退文件: ' + String(e.message || e).slice(0, 160)); myTeam = null; }
  } else {
    console.log('[队伍] ⚠️ 没收到你正在用的队伍。request=' + describeReq(req));
    if (req) console.log('[请求原文·前600字] ' + JSON.stringify(req).slice(0, 600));
  }
  if (!myTeam) {
    myTeam = loadTeam(ROOT + (team || DEFAULT_TEAM).replace(/\//g, '\\'));
    teamSource = '⚠️ 兜底 ' + (team || DEFAULT_TEAM) + '（没收到你正在用的队伍，用哪套队是猜的）';
    console.log('[队伍] ' + teamSource);
  }
  if (!myTeam || !myTeam.length) throw new Error('读不到队伍: ' + (team || DEFAULT_TEAM));

  const side = sideOf(lines, me);

  // ★ 选人阶段：这时还没有 |switch|，stateFromLog 会返回 null。
  //   但队伍预览已公开双方 6 只的物种，足以推荐先发 —— 这一手权重极高。
  // 选人阶段：日志里没有 |switch|。若浏览器侧直接给了对手 6 只（推荐做法），
  // 就连 |poke| 行都不需要 —— 客户端把队伍预览存在 battle.farSide.pokemon 里
  // （battle.ts:3730 case 'poke' → rememberTeamPreviewPokemon → sides[n].addPokemon），
  // 那比赌 stepQueue 里有没有 |poke| 行可靠得多。
  const liveState = stateFromLog(lines, side, myTeam, META);
  if (isTeamPreview(lines) || (!liveState && oppTeam && oppTeam.length)) {
    const pv = previewStateFromLog(lines, side, myTeam, META, oppTeam);
    if (!pv) return { ok: false, reason: 'preview-empty', msg: '队伍预览信息不全' };
    const r = await decideLead(pv, {});
    if (!r) return { ok: false, reason: 'preview-no-options', msg: '无法构建先发选项' };
    const acts = r.actions || [];
    return {
      ok: true,
      phase: 'teampreview',
      turn: 0,
      pick: r.pick,
      name: r.action ? r.action.name : r.pick,
      nameZh: r.action ? zhInfo('species', r.action.name).zh : null,
      verdict: r.action && r.action.bestOut ? '最能打 ' + r.action.bestOut.vs + ' ' + (r.action.bestOut.pct || 0).toFixed(0) + '%' : null,
      confidence: r.confidence,
      threats: [],
      allOptions: acts.map(a => ({
        id: a.id, kind: 'lead', name: a.name,
        nameZh: zhInfo('species', a.name).zh,
        expPct: a.bestOut ? Math.round(a.bestOut.pct) : null,
        verdict: a.worstIn ? '最怕 ' + a.worstIn.from + ' ' + Math.round(a.worstIn.pct) + '%' : null,
      })),
      opponent: (pv.opp.team || []).map(t => t.species),
      ms: Date.now() - t0,
      jevMs: r.elapsedMs,
      teamSource,   // 选人阶段也让面板能显示队伍来源
      _criteria: null, _instructions: null, _answers: (r.answers || null),
    };
  }

  const state = liveState;
  if (!state) return { ok: false, reason: 'not-started', msg: '还没进入对战（选人阶段）' };
  // 事实层的警告一律打出来（比如我方条目按形态找不到 → 本回合数字不可信）
  for (const w of (state._warnings || [])) console.log('[警告] ' + w);

  // ★ 本回合还能不能太晶 —— 事实来自 room.request.active[0].canTerastallize
  //   （sim 源 pokemon.mjs:878：能太晶时该字段 = 太晶属性名；用掉后字段消失）。
  //   这比「从队伍文件里假设还能太晶」可靠：整局只能太晶一次，用掉之后必须立刻停止推荐。
  const act0 = (req && Array.isArray(req.active) && req.active[0]) || null;
  // ★ 本回合【真正能点的招式】以 request.active[0].moves 为准 —— 讲究道具会锁招
  //   （其余招式 disabled=true，客户端里是灰的）。side.pokemon[].moves 永远是完整 4 招、
  //   不带锁招信息，读它就会给出「点不下去」的建议（用户实测：土地云带讲究眼镜，面板还让点别的招）。
  if (state.me && state.me.active) {
    state.me.active.choices = (act0 && Array.isArray(act0.moves))
      ? act0.moves.map(m => ({ id: m.id, name: m.move, pp: m.pp, maxpp: m.maxpp, disabled: !!m.disabled }))
      : null;
    if (state.me.active.choices) {
      const can = state.me.active.choices.filter(c => !c.disabled).map(c => c.name);
      const no = state.me.active.choices.filter(c => c.disabled).map(c => c.name);
      if (no.length) console.log('[锁招] 本回合只能点 ' + can.join(' / ') + '；被锁: ' + no.join('、'));
    }
  }

  const canTera = (act0 && act0.canTerastallize) || null;
  if (state.me && state.me.active && state.me.active.set) {
    if (canTera) state.me.active.set.teraAvailable = canTera;
    else if (state.me.active.set.teraAvailable && Array.isArray(req && req.active)) delete state.me.active.set.teraAvailable;
  }
  console.log('[太晶] ' + (canTera ? '本回合可太晶 → ' + canTera : '不可太晶（已用过或不是自己的回合）'));

  // ★ 强制换人：这时 request 【只有 forceSwitch、没有 active】（sim 源 battle.mjs:1245）。
  //   不认这个字段的后果实测过：晶光花 0% 血倒地，面板还在说「点大地之力」—— 那一手根本点不下去。
  const forceSwitch = !!(req && Array.isArray(req.forceSwitch) && req.forceSwitch.some(Boolean));

  const built = forceSwitch ? buildForceSwitchQuestion(state) : buildQuestion(state);
  if (!built.actions.length) {
    return { ok: false, reason: forceSwitch ? 'no-switch' : 'no-options',
      msg: forceSwitch ? '场上宝可梦倒下了，但没有可换的宝可梦' : '没有可用选项' };
  }

  const res = await askJev(built.questions.position || {}, built.questions, {});
  const pick = res.answers && res.answers.action && res.answers.action.choice;
  const chosen = built.actions.find(a => a.id === pick) || null;
  const ans = (res.answers && res.answers.action) || {};
  // ★ 太晶是【第二个问题】的答案，不是某个选项 id —— 太晶与选哪一招正交，所以它单独回答 use/save。
  //   但最终用不用由 resolveTera【代码裁定】：没收益时 harness 压根没生成这个问题，
  //   所以 Jev 根本没有机会把整局唯一一次太晶浪费掉。
  const teraAns = (res.answers && res.answers.tera) || null;
  const useTera = resolveTera(built.tera, built.teraPayoff, !!(teraAns && teraAns.choice === 'use'), chosen);
  // ★【对手会不会换人】= Jev 自己的判断（opp_switch 问题）。代码【不给概率】——
  //   换不换是模糊判断不是可算事实，给数字等于把先验冒充成事实（本项目红线）。
  //   代码只负责把可算的事实（switchFacts）摆出来，判断与出招都由 Jev 一起决定。
  const swAns = (res.answers && res.answers.opp_switch) || null;

  return {
    ok: true,
    // 强制换人时告诉面板「这一手是换人，不是出招」
    phase: forceSwitch ? 'forceswitch' : undefined,
    fainted: forceSwitch ? state.me.active.species : null,
    turn: state.turn,
    side,
    me: { species: state.me.active.species, hp: state.me.active.hpPercent },
    opp: { species: state.opp.active.species, hp: state.opp.active.hpPercent },
    pick,
    name: chosen ? chosen.name : pick,
    // ★ 换人选项给的是【宝可梦名】，不是招式名 —— 一开始统一按 moves 查，
    //   结果换人时显示英文（查不到就退化返回原名）。必须按 kind 分流。
    nameZh: chosen ? zhOfAction(chosen) : null,
    tera: chosen ? (chosen.tera || null) : null,
    verdict: verdictOf(chosen),
    koChance: chosen ? chosen.koChance : null,
    confidence: ans.confidence,
    probabilities: ans.probabilities,
    // 太晶：useTera=这次要不要用掉那唯一一次机会；tera=可用信息（type/typeZh/收益）
    useTera,
    // ★ 对手会不会换人 —— 这是【Jev 自己】下的判断，不是代码算的概率。
    oppSwitch: swAns ? { choice: swAns.choice, confidence: swAns.confidence } : null,
    // 代码只提供可算的事实，两边摆开，便于和 Jev 的判断对照
    switchFacts: built.risk ? {
      stay: (built.risk.stayReasons || []).slice(0, 3),
      switch: (built.risk.switchReasons || []).slice(0, 3),
      answer: built.risk.answer ? built.risk.answer.species : null,
    } : null,
    // 锁招（讲究系列）：面板要能一眼看到「只剩这几招能点」
    locked: built.lockedMoves && built.lockedMoves.blocked && built.lockedMoves.blocked.length
      ? built.lockedMoves : null,
    tera: built.tera
      ? { type: built.tera.type, typeZh: built.tera.typeZh, best: built.tera.best,
          savedCount: built.tera.savedCount, isBreakthrough: !!built.tera.isBreakthrough,
          // payoff=false 时 harness 根本没把问题给 Jev —— 面板要能说出「这次不值得」
          payoff: !!built.teraPayoff, confidence: teraAns ? teraAns.confidence : null }
      : null,
    threats: (built.threats || []).filter(t => t.priority > 0 && t.kills_our_active),
    allOptions: built.actions.map(a => ({
      id: a.id, name: a.name, kind: a.kind, tera: a.tera || null,
      // 强化招没有伤害百分比，改挂「攻+2」这类标签，否则面板上只能显示「-」
      tag: a.setup ? a.setup.boostText : null,
      nameZh: zhOfAction(a),
      expPct: a.expPct != null ? Math.round(a.expPct) : null,
      koChance: a.koChance != null ? Math.round(a.koChance * 100) : null,
      verdict: a.verdict || null,
    })),
    ms: Date.now() - t0,
    jevMs: res.elapsedMs,
    teamSource,
    // ★ 只给决策日志用：事实层发给 Jev 的【原文】。
    //   面板是纯文字，文案就是全部信息 —— 复盘时只有它能说明「当时到底告诉模型什么了」。
    //   发回浏览器前会被删掉（见 HTTP 处理里的 delete）。
    _criteria: (built.questions.action && built.questions.action.criteria) || null,
    _instructions: (built.questions.action && built.questions.action.instructions) || null,
    _answers: res.answers || null,
  };
}

// ---------- HTTP ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => {
      buf += c;
      // ★ 超限必须 reject。以前只 req.destroy()：那个 Promise 永远不会 settle，
      //   客户端拿不到任何响应 —— 安静地挂死到超时。
      if (buf.length > 4e6) { buf = ''; reject(new Error('请求体过大 (>4MB)')); }
    });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  // 只监听 127.0.0.1；这里不发任何 CORS 头 —— 见文件头说明
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  try {
    if (req.method === 'GET' && req.url.startsWith('/health')) {
      return send(200, { ok: true, jev: jevAvailable(), port: PORT });
    }
    // 一键安装用户脚本：访问这个网址，Tampermonkey 会自动弹出安装/更新提示。
    // 比手动复制粘贴友好得多，也免了"版本对不上"的问题。
    if (req.method === 'GET' && req.url.startsWith('/pkmn-brain.user.js')) {
      const js = readFileSync(fileURLToPath(new URL('./pkmn-brain.user.js', import.meta.url)), 'utf8');
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      return res.end(js);
    }
    if (req.method === 'POST' && req.url.startsWith('/decide')) {
      // ★ 防跨站（CSRF）闸：普通网页用 <form> 就能 POST 到 127.0.0.1（不需要 CORS 就能发出去，
      //   只是读不到响应）—— 额度却已经被烧掉了。自定义头会触发预检，而预检必然被我们挡掉
      //   （本服务不发任何 CORS 头），所以「必须带这个头」就够挡掉所有浏览器发起的跨站请求。
      //   GM_xmlhttpRequest 能自由设头，用户脚本不受影响。
      if (req.headers['x-pkmn-brain'] !== '1') {
        return send(403, { ok: false, msg: '缺少 X-Pkmn-Brain 头（防跨站）' });
      }
      if (!rateOk()) {
        console.log('[限流] 一分钟内超过 ' + RATE_MAX + ' 次，已拒绝');
        return send(429, { ok: false, msg: '请求过于频繁（每分钟上限 ' + RATE_MAX + '），已拒绝以保护额度' });
      }
      const body = JSON.parse((await readBody(req)) || '{}');
      const raw = String(body.log || '');
      // ★ 起点日志：判断「请求到没到」和「卡在哪一步」全靠它。
      //   没有这行的话，用户在浏览器端只看到「计算中…」，无法区分是
      //   请求没发出来、还是服务端卡住了。
      console.log('[收到] me=' + (body.me || '-') + ' 日志=' + raw.split(/\r?\n/).length + '行' +
        ' oppTeam=' + ((body.oppTeam || []).length || '无') +
        ' 本地队=' + ((body.localTeams || []).length || '无') +
        ' 含poke=' + (raw.includes('|poke|') ? '是' : '否') +
        ' 含switch=' + (raw.includes('|switch|') ? '是' : '否') +
        ' request=' + (body.request ? '有' : '无'));
      const dk = dedupeKey(raw, body);
      const dup = recentDecisions.get(dk);
      if (dup && Date.now() - dup.at < DEDUPE_MS) {
        console.log('[去重] 和 ' + Math.round((Date.now() - dup.at) / 1000) +
          's 前那次是同一个决策（同一份日志 + 同一个 requestType）→ 直接回上次答案，不再问 Jev');
        return send(200, { ...dup.out, deduped: true });
      }
      const t0 = Date.now();
      let out;
      try {
        out = await decide(body);
      } catch (e) {
        console.log('[出错] ' + (Date.now() - t0) + 'ms  ' + (e.message || e));
        return send(500, { ok: false, msg: String(e.message || e) });
      }
      console.log('[完成] ' + (Date.now() - t0) + 'ms  t' + (out.turn ?? '?') + ' → ' +
        (out.pick || out.reason || out.msg || '?') +
        (out.tera ? (out.useTera ? ' +太晶' : ' [保留太晶]') : '') +
        (out.phase ? '  [' + out.phase + ']' : ''));
      // ★ 先落盘再删字段：面板不需要 _criteria（几 KB 纯文本），但复盘离不开它。
      //   写日志自己吞掉异常（只打控制台），绝不能因为它失败而让这一回合没有建议。
      logDecision({ raw, body, out, ms: Date.now() - t0 });
      delete out._criteria; delete out._instructions; delete out._answers;
      recentDecisions.set(dk, { at: Date.now(), out });
      // 顺手清掉过期的，别让 Map 无限长（一局最多几十个回合，这里只是兜底）
      if (recentDecisions.size > 200) {
        for (const [k, v] of recentDecisions) if (Date.now() - v.at > DEDUPE_MS) recentDecisions.delete(k);
      }
      return send(200, out);
    }
    send(404, { ok: false, msg: 'not found' });
  } catch (e) {
    console.error('[error]', e.message);
    send(500, { ok: false, msg: String(e.message || e) });
  }
});

// ---------- 启动函数 ----------
// 供 start.mjs 导入调用。入口守卫会让「直接运行」也走这里，
// 但【import 时守卫不成立】—— 所以调用方必须显式调用 startService()。
export function startService() {
  if (!jevAvailable()) {
    console.log('⚠️ 没有 Jev 凭据（side/jev/.env 里的 TYPESAFE_API_KEY）');
    process.exit(1);
  }
  server.listen(PORT, '127.0.0.1', () => {
    console.log('Jev 决策服务已启动: http://127.0.0.1:' + PORT);
    console.log('  GET  /health   健康检查');
    console.log('  POST /decide   { log, me?, team? }');
    console.log('默认队伍: ' + DEFAULT_TEAM);
    console.log('按 Ctrl+C 停止。');
  });
}

// ---------- CLI ----------
if (process.argv[1] && process.argv[1].endsWith('serve.mjs')) {
  const a = process.argv.slice(2);
  const arg = (n, d) => { const i = a.indexOf(n); return i >= 0 && a[i + 1] ? a[i + 1] : d; };
  const logFile = arg('--log', null);
  if (logFile) {
    const r = await decide({
      log: readFileSync(ROOT + logFile.replace(/\//g, '\\'), 'utf8'),
      me: arg('--me', null), team: arg('--team', DEFAULT_TEAM),
    });
    console.log(JSON.stringify(r, null, 2));
  } else {
    startService();
  }
}
