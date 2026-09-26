// ==UserScript==
// @name         宝可梦外接大脑 (Jev)
// @namespace    pkmn-brain
// @version      1.0.0
// @description  在对战页左下角以纯文字显示 Jev 的实时决策建议
// @match        https://play.pokemonshowdown.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==

// 两个必须知道的坑：
// ① Tampermonkey 沙箱下 window 是白名单代理，读页面全局必须用 unsafeWindow（否则 PS 恒为 undefined）。
// ② 轮询要等【轮到我方】才发请求。判断依据是 BattleRoom.request（见 panel-battle.tsx:157/294/419）：
//      room.request && room.request.requestType !== 'wait' && !room.choices.isDone()
//    之前不看这个，导致对手回合也去问、反复问，既浪费额度又显示过期建议。

const SERVICE = 'http://127.0.0.1:7777';
const TEAM_FILE = 'teams/ou-a.txt';
const POLL_MS = 1000;
const SHOW_OPTIONS = 4;

(function () {
  'use strict';
  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

  const panel = document.createElement('div');
  panel.id = 'pkmn-brain-panel';
  panel.innerHTML = [
    '<div class="pb-status">初始化…</div>',
    '<div class="pb-main">—</div>',
    '<div class="pb-sub"></div>',
    '<div class="pb-opts"></div>',
    '<div class="pb-opp"></div>',
    '<pre class="pb-diag"></pre>'
  ].join('');
  const style = document.createElement('style');
  // ★ 纯文字、无背景、无 emoji，锁在左下角那块空白（对战日志下方）。
  //   pointer-events:none 保证不挡住对战操作；只有诊断区可滚动。
  //   文字用深色 + 极淡白描边 —— 不是背景，只是为了在深浅不一的战斗背景上都看得清。
  style.textContent = [
    '#pkmn-brain-panel{position:fixed;left:0;bottom:0;width:34%;max-width:680px;z-index:99999;',
    '  background:transparent;border:none;box-shadow:none;',
    '  font:13px/1.5 system-ui,"Microsoft YaHei",sans-serif;',
    '  color:#1a1a1a;text-shadow:0 0 2px rgba(255,255,255,.55);',
    '  padding:6px 10px 10px;max-height:30vh;overflow:hidden;pointer-events:none}',
    '#pkmn-brain-panel.pb-hidden{display:none}',
    '#pkmn-brain-panel .pb-status{font-size:11px;color:#5a5a5a}',
    '#pkmn-brain-panel .pb-main{font-size:19px;font-weight:700;color:#0d3d0d;letter-spacing:.3px}',
    '#pkmn-brain-panel .pb-sub{font-size:12px;color:#333}',
    '#pkmn-brain-panel .pb-opts{font-size:12px;color:#5a5a5a;margin-top:2px}',
    '#pkmn-brain-panel .pb-opp{font-size:11px;color:#6a6a6a;margin-top:3px}',
    '#pkmn-brain-panel .pb-warn{color:#b00020;font-weight:600}',
    '#pkmn-brain-panel .pb-err{color:#b00020}',
    '#pkmn-brain-panel .pb-wait{color:#7a7a7a}',
    '#pkmn-brain-panel .pb-diag{font:11px/1.45 Consolas,monospace;color:#333;',
    '  white-space:pre-wrap;margin:4px 0 0;max-height:26vh;overflow:auto;',
    '  pointer-events:auto;text-shadow:0 0 2px rgba(255,255,255,.6)}',
    '#pkmn-brain-panel.pb-have-battle .pb-diag{display:none}'
  ].join('');
  document.head.appendChild(style);
  document.body.appendChild(panel);
  const $ = (s) => panel.querySelector(s);

  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.key.toLowerCase() === 'j') { panel.classList.toggle('pb-hidden'); e.preventDefault(); }
  });

  // ── 找对战房间 ────────────────────────────────────────────
  const tried = [];
  // ★★ 判定「这是不是对战对象」不能只认 stepQueue。★★
  //   stepQueue 是 PS 的【内部字段】（线上源码 battle.js：`this.stepQueue = options.log || []`，
  //   构造期先是 `void 0`）。只认一个字段的后果是：它一改名/一变形态，
  //   整块面板立刻报「未找到对战」，而且【看不出为什么】—— 这正是静默失败那条红线。
  //   现在同时认几组稳定特征，并且把每个候选房间【为什么被拒】记进 tried，诊断区会打出来。
  function shapeOf(v) {
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    if (typeof v !== 'object') return typeof v;
    const keys = Object.keys(v).slice(0, 12).join(',');
    return '{' + keys + '}' + (Array.isArray(v) ? '[len ' + v.length + ']' : '');
  }
  function isBattle(v) {
    if (!v || typeof v !== 'object') return false;
    if (Array.isArray(v.stepQueue)) return true;          // 原来只认这一个
    if (Array.isArray(v.sides) && typeof v.turn === 'number') return true;
    if (Array.isArray(v.sides) && Array.isArray(v.log)) return true;
    return false;
  }

  function roomIn(holder, label) {
    if (!holder || !holder.rooms) return null;
    const ids = Object.keys(holder.rooms);
    const ordered = ids.filter(id => id.startsWith('battle-')).concat(ids.filter(id => !id.startsWith('battle-')));
    for (const id of ordered) {
      const room = holder.rooms[id];
      if (!room) { tried.push(label + ".rooms['" + id + "'] = null"); continue; }
      // 只有 battle- 开头的房间才值得记进诊断，否则聊天室会把诊断刷满
      const note = id.startsWith('battle-') ? (t) => tried.push(label + ".rooms['" + id + "'] " + t) : () => {};
      if (isBattle(room.battle)) return { room, battle: room.battle, via: label + ".rooms['" + id + "']" };
      if (isBattle(room)) return { room, battle: room, via: label + ".rooms['" + id + "']（房间本身）" };
      note('不是对战：room.battle=' + shapeOf(room.battle) + '  room 自己=' + shapeOf(room) +
        '  requestType=' + (room.request ? room.request.requestType : 'null') +
        '  roomType=' + (room.type || room.roomType || '?'));
    }
    return null;
  }

  function findRoom() {
    tried.length = 0;
    let hit = roomIn(W.PS, 'unsafeWindow.PS');
    if (!hit) hit = roomIn(W.app, 'unsafeWindow.app');
    if (!hit) {
      for (const k of Object.keys(W)) {
        let v; try { v = W[k]; } catch (e) { continue; }
        if (v && typeof v === 'object' && v.rooms) { hit = roomIn(v, 'unsafeWindow.' + k); if (hit) break; }
      }
    }
    return hit;
  }

  function diag() {
    const lines = ['—— 诊断（v1.0.0）——'];
    lines.push('  unsafeWindow 可用 = ' + (W !== window));
    lines.push('  unsafeWindow.PS  = ' + (W.PS ? typeof W.PS : 'undefined'));
    lines.push('  PS.rooms 存在    = ' + !!(W.PS && W.PS.rooms));
    if (W.PS && W.PS.rooms) {
      const ids = Object.keys(W.PS.rooms);
      lines.push('  [PS.rooms] ' + (ids.length ? ids.join(', ') : '(空的 —— 页面还没连上服务器？)'));
      for (const id of ids.filter(x => x.startsWith('battle-'))) {
        const room = W.PS.rooms[id];
        lines.push('  ' + id + ': battle=' + (room.battle ? 'yes' : 'no') +
          ' stepQueue=' + ((room.battle && room.battle.stepQueue) || []).length +
          ' requestType=' + (room.request ? room.request.requestType : 'null') +
          ' choicesDone=' + (room.choices && room.choices.isDone ? room.choices.isDone() : '?'));
      }
    }
    // ★ 把 findRoom 每个候选【为什么没被认成对战】原样打出来。
    //   以前这里只报结论，于是「未找到对战」永远只能靠猜 —— 现在它自己会说原因。
    if (tried.length) {
      lines.push('  [候选房间判定]');
      for (const t of tried.slice(0, 12)) lines.push('    ' + t);
    } else {
      lines.push('  [候选房间判定] 一个候选都没扫到（PS.rooms 为空，或房间对象没有 rooms）');
    }
    // 全局扫一圈，看看 battle 对象是不是换地方了
    const found = [];
    for (const k of Object.keys(W)) {
      let v; try { v = W[k]; } catch (e) { continue; }
      if (v && typeof v === 'object' && v.rooms) found.push('unsafeWindow.' + k + '.rooms(' + Object.keys(v.rooms).length + ')');
    }
    if (found.length) lines.push('  [页面全局里带 rooms 的对象] ' + found.join('  '));
    const txt = lines.join('\n');
    $('.pb-diag').textContent = txt;
    return txt;
  }

  // 对手 6 只的物种。来源：客户端把 |poke| 存进了 side 对象的 pokemon 数组
  // （battle.ts:3730 case 'poke' → rememberTeamPreviewPokemon → sides[n].addPokemon），
  // 每个对象带 details，形如 "Glimmora, F"。farSide 就是对手那一边。
  function oppTeamOf(battle) {
    try {
      const far = battle.farSide || battle.p2;
      if (!far || !far.pokemon) return null;
      const names = far.pokemon
        .map(p => (p.details || p.species && p.species.name || '').split(',')[0].trim())
        .filter(Boolean);
      return names.length ? names : null;
    } catch (e) { return null; }
  }

  function myName() {
    try {
      const u = (W.PS && W.PS.user) || (W.app && W.app.user);
      return (u && (u.name || (u.get && u.get('name')))) || '';
    } catch (e) { return ''; }
  }

  let lastKey = '', inflight = false, failures = 0;

  // 无 emoji、无背景，纯文字。中文优先，英文名只在没有中文时才显示。
  const zhOf = (o) => (o.nameZh && o.nameZh !== o.name) ? o.nameZh : o.name;

  function render(res) {
    if (!res || !res.ok) {
      $('.pb-status').textContent = (res && (res.msg || res.reason)) || '无结果';
      $('.pb-main').textContent = '—';
      $('.pb-sub').textContent = ''; $('.pb-opts').textContent = ''; $('.pb-opp').textContent = '';
      return;
    }

    // ★ 强制换人：场上宝可梦倒下了，这一手【只能换人，不能出招】。
    //   之前不区分这个阶段，面板会在 0% 血的宝可梦身上显示「点大地之力」——那一手根本点不下去。
    if (res.phase === 'forceswitch') {
      $('.pb-status').textContent = '换人（' + (res.fainted || '场上') + ' 已倒下） · ' +
        (res.jevMs || res.ms) + 'ms' + (res.confidence != null ? ' · 置信 ' + res.confidence.toFixed(2) : '');
      $('.pb-main').textContent = '换 ' + zhOf(res);
      $('.pb-sub').textContent = res.verdict || '';
      const os = (res.allOptions || []).filter(o => o.id !== res.pick).slice(0, SHOW_OPTIONS);
      $('.pb-opts').textContent = os.map(o => zhOf(o) +
        (o.tera === undefined ? '' : '')).join('   ');
      $('.pb-opp').textContent = res.teamSource ? '队伍: ' + res.teamSource : '';
      return;
    }

    // ★ 选人阶段：还没有 me.species / opp.species，是 me.team / opp.team
    if (res.phase === 'teampreview') {
      $('.pb-status').textContent = '选人阶段 · ' + (res.jevMs || res.ms) + 'ms';
      $('.pb-main').textContent = '先发 ' + zhOf(res);
      $('.pb-sub').textContent = (res.verdict || '') +
        (res.confidence != null ? ' · 置信 ' + res.confidence.toFixed(2) : '');
      const os = (res.allOptions || []).filter(o => o.id !== res.pick).slice(0, SHOW_OPTIONS);
      $('.pb-opts').textContent = os.map(o =>
        zhOf(o) + ' ' + (o.expPct != null ? o.expPct + '%' : '-')).join('   ');
      // ★ 队伍来源必须在这里也显示。之前这一行被「对手：…」整个覆盖掉了，
      //   而选人阶段恰恰是最需要确认「用的是不是我这套队」的时刻。
      $('.pb-opp').textContent = (res.teamSource ? '队伍: ' + res.teamSource : '') +
        (res.opponent && res.opponent.length ? '   |   对手：' + res.opponent.join(' / ') : '');
      return;
    }

    $('.pb-opp').textContent = (res.teamSource ? '队伍: ' + res.teamSource + '   |   ' : '') + teamDiag;
    $('.pb-status').textContent = 'T' + res.turn + ' · ' + res.me.species + ' ' + res.me.hp + '%  vs  ' +
      res.opp.species + ' ' + res.opp.hp + '%  ·  ' + (res.jevMs || res.ms) + 'ms';
    // ★ 太晶是独立于出招的一步：显示成「太晶 + 点 大地之力」，玩家就照着先点太晶再点招。
    // ★ 低置信要让玩家一眼看见。实测同一回合两次请求给出的是 0.33（换酋雷姆）和
    //   0.28（点铁壁）—— 两个完全不同的答案，面板却和 0.99 那个长得一模一样。
    //   这和 opp_switch 的「置信 <0.4 显示成说不准」是同一条规则，只是以前没管这一行。
    const weak = (res.confidence != null && res.confidence < 0.4);
    $('.pb-main').textContent = (weak ? '【把握不大】' : '') +
      (res.useTera ? '太晶 + 点 ' : '点 ') + zhOf(res);
    const bits = [];
    if (res.verdict) bits.push(res.verdict);
    if (res.koChance > 0) bits.push('击杀概率 ' + Math.round(res.koChance * 100) + '%');
    // 太晶状态常驻显示：不管用不用，玩家都该知道这一次机会还在不在
    if (res.tera) bits.push(res.useTera
      ? '用太晶（' + (res.tera.typeZh || res.tera.type) + '）'
      : (res.tera.payoff ? '保留太晶' : '保留太晶（这次不值得用）'));
    // 对手会不会换人 —— 这是 Jev 自己的判断（不是代码算的概率）
    if (res.oppSwitch) {
      const c = res.oppSwitch.confidence;
      let jd = { stay: '不会换', switch: '会换', uncertain: '说不准' }[res.oppSwitch.choice] || res.oppSwitch.choice;
      // ★ 置信度是信号：Jev 用「不会换@0.14」表达的意思就是「说不准」（实测它这么答过）。
      //   照字面显示成「不会换」会让玩家以为模型很确定 —— 低置信直接显示成说不准。
      if (c != null && c < 0.4 && res.oppSwitch.choice !== 'uncertain') jd = '说不准';
      bits.push('对手换人：' + jd + (c != null ? '（' + c.toFixed(2) + '）' : ''));
    }
    if (res.confidence != null) bits.push('置信 ' + res.confidence.toFixed(2));
    $('.pb-sub').textContent = bits.join(' · ');
    if (res.threats && res.threats.length) {
      const t = res.threats[0];
      const w = document.createElement('span');
      w.className = 'pb-warn';
      w.textContent = ' · 对手 ' + t.move + '（先制+' + t.priority + '）可击倒你';
      $('.pb-sub').appendChild(w);
    }
    // 判断依据（可算的事实）—— 摆出来是为了 Jev 的判断可以被复核，而不是让玩家自己下判断
    if (res.switchFacts) {
      const sf = res.switchFacts;
      const sr = document.createElement('span');
      sr.className = 'pb-sub';
      sr.textContent = '   ｜ 留场理由：' + (sf.stay.join('；') || '无') +
        ' ｜ 换人理由：' + (sf.switch.join('；') || '无') +
        (sf.answer ? ' ｜ 最可能换上 ' + sf.answer : '');
      $('.pb-sub').appendChild(sr);
    }
    // 锁招（讲究道具）：必须常驻可见 —— 玩家要立刻知道自己只剩哪几招能点
    if (res.locked && res.locked.blocked && res.locked.blocked.length) {
      const w = document.createElement('span');
      w.className = 'pb-warn';
      w.textContent = ' · 锁招：只能点 ' + res.locked.only.join('/') + '（' + res.locked.blocked.join('、') + ' 已锁）';
      $('.pb-sub').appendChild(w);
    }
    const opts = (res.allOptions || []).filter(o => o.id !== res.pick).slice(0, SHOW_OPTIONS);
    // 强化招没有百分比，显示它的加成标签（攻击 +2 / 特攻 +2、速度 +1 …）
    $('.pb-opts').textContent = opts.map(o =>
      zhOf(o) + ' ' + (o.tag ? o.tag : (o.expPct != null ? o.expPct + '%' : '-'))).join('   ');
    // 队伍识别情况直接写在这一行 —— 不用翻黑窗口就能判断哪一环断了
    $('.pb-opp').textContent = (res.teamSource ? '队伍: ' + res.teamSource + '   |   ' : '') + teamDiag;
  }

  let inflightSince = 0;

  // ★ 看门狗：GM_xmlhttpRequest 的 timeout 在某些情况下不触发，
  //   一旦漏掉回调，inflight 会永远为 true，面板就永久卡在「计算中…」再也不更新。
  //   这里强制复位，保证最坏情况 8 秒后能重试。
  function watchdog() {
    if (!inflight) return;
    const secs = (Date.now() - inflightSince) / 1000;
    // ★ 阈值必须大于服务端的最坏耗时：jev.mjs 现在有 3 次重试 + DoH 兜底，最坏能到 10 秒以上。
    //   阈值太小会在请求还没回来时就复位，于是下一轮再发一次 —— 双倍烧额度、面板还可能显示旧结果。
    if (secs > 25) {
      inflight = false;
      $('.pb-status').innerHTML = '<span class="pb-err">请求无响应 ' + secs.toFixed(0) + 's，已复位重试</span>';
      console.log('[外接大脑] 看门狗触发：请求超过 ' + secs.toFixed(1) + 's 无响应，已复位');
    }
  }

  // ★ 整包 request 原样发给服务端。
  //   之前是浏览器侧挑字段（ident/details/stats/moves/item/ability/teraType）再发，
  //   挑漏一个字段服务端完全看不出来 —— 实测 myTeam 恒为空，服务端悄悄退回 teams/ou-a.txt，
  //   于是「换了队也不生效」。挑字段这件事本身就是静默失败源，去掉它。
  function safeClone(v) { try { return v == null ? null : JSON.parse(JSON.stringify(v)); } catch (e) { return null; } }

  function ask(logLines, name, oppTeam, request) {
    if (inflight) return;
    inflight = true;
    inflightSince = Date.now();
    let body;
    try {
      body = JSON.stringify({
        log: logLines.join('\n'), me: name, team: TEAM_FILE,
        oppTeam: oppTeam || null,
        request: safeClone(request),
      });
    } catch (e) {
      body = JSON.stringify({ log: logLines.join('\n'), me: name, team: TEAM_FILE });
    }
    GM_xmlhttpRequest({
      method: 'POST', url: SERVICE + '/decide',
      // X-Pkmn-Brain 是防跨站闸：普通网页表单发不出自定义头（会触发预检，而本服务不发 CORS 头）
      headers: { 'Content-Type': 'application/json', 'X-Pkmn-Brain': '1' },
      data: body,
      timeout: 30000,
      onload: (r) => {
        const ms = Date.now() - inflightSince;
        inflight = false; failures = 0;
        console.log('[外接大脑] 服务返回 HTTP ' + r.status + '  ' + ms + 'ms');
        try {
          const j = JSON.parse(r.responseText);
          if (!j.ok) console.log('[外接大脑] 服务说不行:', JSON.stringify(j).slice(0, 300));
          render(j);
        } catch (e) {
          $('.pb-status').innerHTML = '<span class="pb-err">解析返回失败</span>';
          console.log('[外接大脑] 返回原文前 300 字:', String(r.responseText).slice(0, 300));
        }
      },
      onerror: () => {
        inflight = false; failures++;
        $('.pb-status').innerHTML = '<span class="pb-err">✗ 连不上本地服务 ' + SERVICE + ' —— 先双击 启动外接大脑.bat</span>';
        $('.pb-main').textContent = '—';
      },
      ontimeout: () => { inflight = false; $('.pb-status').textContent = '✗ 服务超时'; }
    });
  }

  // 面板上直接显示队伍识别情况，省去翻黑窗口
  let teamDiag = '(未检查)';
  // 一行说清「队伍从哪儿来、太晶还能不能用」——不用翻黑窗口就能定位断点。
  function refreshTeamDiag(room) {
    try {
      const req = room && room.request;
      const hasPS = !!(W.PS && W.PS.teams);
      const list = hasPS ? (W.PS.teams.list || W.PS.teams.teams || null) : null;
      const n = list ? list.length : 0;
      const packedN = list ? list.filter(x => x && x.packedTeam).length : 0;
      const mons = (req && req.side && req.side.pokemon) || null;
      const act = (req && req.active && req.active[0]) || null;
      teamDiag = 'request=' + (req ? '有' : '无') +
        ' side.pokemon=' + (mons ? mons.length : '无') +
        ' 首只招式=' + (mons && mons[0] && mons[0].moves ? mons[0].moves.length : '?') +
        ' 太晶=' + (act ? (act.canTerastallize || '不可') : '-') +
        ' PS.teams=' + (hasPS ? n + '队/packed' + packedN : '无');
    } catch (e) { teamDiag = '读取异常: ' + String(e).slice(0, 80); }
  }

  let ticks = 0;
  setInterval(() => {
    ticks++;
    watchdog();
    refreshTeamDiag(findRoom() && findRoom().room);
    const hit = findRoom();
    if (!hit) {
      panel.classList.remove('pb-have-battle');
      if (ticks % 5 === 0) { $('.pb-status').textContent = '未找到对战 —— 下方是诊断'; diag(); }
      return;
    }
    panel.classList.add('pb-have-battle');
    const { room, battle } = hit;
    if (battle.ended) { $('.pb-status').textContent = '对战已结束'; $('.pb-main').textContent = '—'; return; }

    // ★ 只在【轮到我方操作】时才请求
    //   requestType 取值（源码 battle-choices.ts:65/74/82/92）：
    //     move=正常回合 / switch=强制换人 / team=选人阶段 / wait=等对手
    const req = room.request;
    const done = room.choices && room.choices.isDone ? room.choices.isDone() : false;
    const log = battle.stepQueue || [];
    const pokeCount = log.filter(l => typeof l === 'string' && l.startsWith('|poke|')).length;

    // 状态栏常驻关键信息：阶段 / 回合 / 日志行数 / 预览行数
    // （找不到先发建议时，这几项能直接告诉我们是哪一环断了）
    const meta = (req ? req.requestType : 'null') + ' · T' + battle.turn +
      ' · log=' + log.length + ' · poke=' + pokeCount + (done ? ' · 已选' : '');

    if (!req || req.requestType === 'wait') {
      $('.pb-status').innerHTML = '<span class="pb-wait">对手思考中… [' + meta + ']</span>';
      return;
    }
    if (done) {
      $('.pb-status').innerHTML = '<span class="pb-wait">已选定，等对手… [' + meta + ']</span>';
      return;
    }
    // 选人阶段：若 stepQueue 里没有 |poke| 行，说明队伍预览数据不在 battle.stepQueue 里，
    // 服务端拿不到对手 6 只 → 无法推先发。这里直接报出来，别让它静默失败。
    if (req.requestType === 'team' && pokeCount === 0) {
      $('.pb-status').innerHTML = '<span class="pb-err">选人阶段但日志里没有 |poke| 行（' + meta + '）—— 预览数据不在 stepQueue</span>';
      return;
    }
    // ★★ 去重键只能由【这次决策的身份】决定。★★
    //   原来把 log.length 也算进去 —— 可 stepQueue 的长度会因为战斗计时器之类的原因变动，
    //   于是同一个回合被问了两次。实测（决策日志 battle-20260926-142031）：
    //   **每一回合都正好两次请求，logLines 完全相同**。代价是双倍烧 Jev 额度，
    //   而且两次答案可能不一样（#2 switch:kyurem 0.33 / #3 move:irondefense 0.28），
    //   面板显示哪个全看谁后回来 —— 玩家看到的是随机的那个。
    //   一个回合只该问一次：turn + requestType + rqid 就是这次决策的全部身份。
    const key = battle.turn + '/' + req.requestType + '/' + (req.rqid || '');
    if (key === lastKey) return;
    lastKey = key;
    if (failures >= 3) { $('.pb-status').innerHTML = '<span class="pb-err">连续失败，暂停。刷新页面重试。</span>'; return; }
    // 选人阶段把对手 6 只一并送过去（不依赖日志里有没有 |poke| 行）
    const opp = (req.requestType === 'team') ? oppTeamOf(battle) : null;
    if (req.requestType === 'team') {
      $('.pb-status').textContent = '选人阶段 · 计算中… 对手 ' + (opp ? opp.length + ' 只' : '未知') + ' [' + meta + ']';
    } else {
      $('.pb-status').textContent = '计算中… (' + req.requestType + ')';
    }
    ask(log, myName(), opp, req);
  }, POLL_MS);

  console.log('[外接大脑] ===== 已注入 v1.0.0 =====');
})();
