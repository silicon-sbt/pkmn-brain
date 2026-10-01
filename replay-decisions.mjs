// 从公开对局记录里提取决策样本：每个回合、每一方各一条。
//
//   node replay-decisions.mjs --in <jsonl> --out <jsonl> [--limit N] [--keep-panel]
//
// 每条样本长这样（够用来评测，不是给人看的）：
//   { rid, turn, side, my, opp, opts:[...], actual:"move:earthquake", hit:true/false, nOpts }
//
// ⚠️ 三个已知偏差（都是"replay 里没有 request"的直接后果，必须写在明面上）：
//   ① 双方的努力值都【不知道】—— 用 toolkit/data/meta-sets.json 的使用率配置估。
//      好处是【两边口径一致】（不会出现"我方精确、对手估算"的不对称）；
//   ② 能点的招 = 日志里【已经暴露过】的招，是真实可用招的【下界】。
//      没出过的招不会出现在选项里 ⇒ hit=false 有一部分是我们的盲区，不是高手选错了。
//      所以另存一个 relaxedHit：把"没暴露的招"也算命中。
//   ③ 状态按【回合边界】重建（就是双方做决策时看到的那个局面），不是局末。
//
// 为什么要走"每个回合重新解析一遍日志"而不是一次解析到底：
//   log2state 只给【最终】局面，而决策发生在每个回合开始时。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));   // 锚在脚本位置，从任何 cwd 都成立
import { stateFromLog } from './log2state.mjs';
import { buildQuestion } from './harness.mjs';
import { askJev } from './jev.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const IN = opt('in', join(HERE, 'toolkit', 'data', 'replays', 'gen9ou.jsonl'));
const OUT = opt('out', join(HERE, 'toolkit', 'data', 'replays', 'decisions.jsonl'));
const LIMIT = Number(opt('limit', 20));
const MIN_TURN = Number(opt('min-turn', 2));
const KEEP_PANEL = argv.includes('--keep-panel');
// --jev N：在整份语料里均匀抽 N 个决策点，真调 Jev，记下它选了什么。
// 均匀抽样（每 stride 个取一个）是为了不让样本全落在前几局的前几回合。
// --only-with-jev <jsonl>：只保留那个文件里【有 jev 字段】的那些点，并且带上面板原文。
// 用途：不给 Jev 再花额度，就能把已经问过的那些点的面板文案捞出来复盘。
const ONLYFILE = opt('only-with-jev', null);
let ONLY = null;
if (ONLYFILE) {
  ONLY = new Set();
  for (const l of readFileSync(ONLYFILE, 'utf8').trim().split('\n')) {
    try { const r = JSON.parse(l); if (r.jev) ONLY.add(r.rid + '|' + r.turn + '|' + r.side); } catch { /* 忽略坏行 */ }
  }
  console.log('[过滤] 只要 ' + ONLY.size + ' 个已问过 Jev 的点（并且带面板原文）');
}
const JEVN = Number(opt('jev', 0));
const JEVSTRIDE = Number(opt('jev-stride', JEVN > 0 ? Math.round(70000 / JEVN) : 0));

// 使用率配置（双方都用它 → 口径一致）
let META = {};
try {
  const raw = JSON.parse(readFileSync(join(HERE, 'toolkit', 'data', 'meta-sets.json'), 'utf8'));
  META = raw.sets || raw;
  console.log('[使用率配置] ' + Object.keys(META).length + ' 只');
} catch (e) { console.log('[警告] 读不到 meta-sets.json：' + e.message + ' —— 用空配置继续（努力值全 0）'); }

const id = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// 第 cut 行之前，这个 side 已经暴露过的东西
function revealed(lines, cut, side) {
  const nickOf = {}, moves = {}, items = {}, abil = {};
  for (let i = 0; i < cut; i++) {
    const l = lines[i];
    let m = l.match(new RegExp('^\\|(?:switch|drag|detailschange)\\|' + side + 'a: ([^|]+)\\|([^,|]+)'));
    if (m) nickOf[m[1].trim()] = m[2].trim();
    m = l.match(new RegExp('^\\|move\\|' + side + 'a: ([^|]+)\\|([^|]+)'));
    if (m && nickOf[m[1].trim()]) (moves[nickOf[m[1].trim()]] ||= new Set()).add(m[2].trim());
    m = l.match(new RegExp('^\\|-item\\|' + side + 'a: ([^|]+)\\|([^|]+)'));
    if (m && nickOf[m[1].trim()]) items[nickOf[m[1].trim()]] = m[2].trim();
    m = l.match(new RegExp('^\\|-ability\\|' + side + 'a: ([^|]+)\\|([^|]+)'));
    if (m && nickOf[m[1].trim()]) abil[nickOf[m[1].trim()]] = m[2].trim();
  }
  return { moves, items, abil };
}

// 日志里的 6 只（Species Clause 保证物种唯一 ⇒ 用物种当身份，不要用昵称）
function roster(lines, side) {
  const out = [];
  const re = new RegExp('^\\|poke\\|' + side + '\\|([^,|]+)');
  for (const l of lines) { const m = l.match(re); if (m) out.push(m[1].trim()); }
  return out;
}

function teamOf(lines, side, cut) {
  const r = revealed(lines, cut, side);
  return roster(lines, side).map((sp) => {
    const s = { species: sp, moves: [...(r.moves[sp] || [])] };
    if (r.items[sp]) s.item = r.items[sp];
    if (r.abil[sp]) s.ability = r.abil[sp];
    return s;
  });
}

const recs = readFileSync(IN, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(0, LIMIT);
console.log('[输入] ' + recs.length + ' 局');

const fh = [];   // 攒起来一次写
let n = 0, hit = 0, relaxed = 0, noOpts = 0, err = 0, turnsSeen = 0;
let sampleIdx = 0, jevCount = 0, jevHit = 0, jevErr = 0, jevHitClean = 0, jevClean = 0;
const t0 = Date.now();
for (const rec of recs) {
  const lines = rec.log.split('\n');
  // 每个 |turn|N| 是一个决策点
  const marks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\|turn\|(\d+)/);
    if (m) marks.push({ turn: Number(m[1]), cut: i + 1 });
  }
  for (let k = 0; k < marks.length; k++) {
    const { turn, cut } = marks[k];
    if (turn < MIN_TURN) continue;
    const end = k + 1 < marks.length ? marks[k + 1].cut : lines.length;
    for (const side of ['p1', 'p2']) {
      // 这一回合这方实际做了什么（决策标签）
      let actual = null;
      for (let i = cut; i < end; i++) {
        let m = lines[i].match(new RegExp('^\\|move\\|' + side + 'a: [^|]+\\|([^|]+)'));
        if (m) { actual = 'move:' + id(m[1]); break; }
        m = lines[i].match(new RegExp('^\\|switch\\|' + side + 'a: [^|]+\\|([^,|]+)'));
        if (m) { actual = 'switch:' + id(m[1]); break; }
      }
      if (!actual) continue;              // 这回合这方没动作（被换下/已倒）
      turnsSeen++;
      if (ONLY && !ONLY.has(rec.id + '|' + turn + '|' + side)) continue;
      const team = teamOf(lines, side, cut);
      if (!team.length) continue;
      const rv = revealed(lines, cut, side);
      try {
        const st = stateFromLog(lines.slice(0, cut), side, team, META);
        if (!st || !st.me || !st.me.active || !st.me.active.species) continue;
        // 能点的招 = 已经暴露过的招（下界）
        const known = [...(rv.moves[st.me.active.species] || [])];
        if (known.length) st.me.active.choices = known.map((mv) => ({ name: mv, disabled: false }));
        const q = buildQuestion(st);
        const opts = Object.keys((q.questions.action && q.questions.action.criteria) || {});
        if (!opts.length) { noOpts++; continue; }
        const isHit = opts.includes(actual);
        // 放宽命中：招不在选项里，但它属于"这只还没暴露过的招" ⇒ 算我们的盲区
        const relaxedHit = isHit || (actual.startsWith('move:') && !known.some((x) => id(x) === actual.slice(5)));
        if (isHit) hit++;
        if (relaxedHit) relaxed++;
        const row = {
          rid: rec.id, rating: rec.rating, turn, side,
          my: st.me.active.species, opp: st.opp.active && st.opp.active.species,
          nOpts: opts.length, opts, actual, hit: isHit, relaxedHit,
          // ★ 两个质检字段：我们知道这只几招（下界），以及选项里是不是【一招都没有】。
          //   known 少的时候 deadLock 会误判（唯一已知的招刚好免疫 ⇒ 以为它只能换人），
          //   于是选项集里一个 move: 都没有。下游要排查/过滤就靠这两个字段。
          known: known.length,
          onlySwitches: !opts.some((o) => o.indexOf('move:') === 0),
        };
        if (KEEP_PANEL || ONLY) {
          row.panel = q.questions.action.criteria;
          row.instr = (q.questions.action && q.questions.action.instructions) || null;
        }
        // 均匀抽 N 个点真调 Jev
        const wantJev = JEVN > 0 && jevCount < JEVN && (sampleIdx % JEVSTRIDE === 0);
        sampleIdx++;
        if (wantJev) {
          try {
            const res = await askJev(q.state, q.questions, {});
            const jp = res.answers && res.answers.action && res.answers.action.choice;
            if (jp) {
              row.jev = jp;
              row.jevConf = (res.answers.action.confidence != null) ? res.answers.action.confidence : null;
              row.jevHit = (jp === actual);
              jevCount++;
              if (row.jevHit) jevHit++;
              // 干净口径：只在【高手那一手确实在我们的选项里】时比 —— 排掉"我们没它的招"这个盲区
              if (isHit) { jevClean++; if (row.jevHit) jevHitClean++; }
            }
          } catch (e) { jevErr++; if (jevErr <= 3) console.log('[Jev 错误] ' + e.message); }
        }
        fh.push(JSON.stringify(row)); n++;
      } catch (e) { err++; if (err <= 3) console.log('[错误] ' + rec.id + ' t' + turn + ' ' + side + '：' + e.message); }
    }
  }
}
writeFileSync(OUT, fh.join('\n') + '\n');
console.log('');
console.log('[完成] 样本 ' + n + ' 条 → ' + OUT);
console.log('  决策点总数         = ' + turnsSeen);
console.log('  选项集含实际选择   = ' + hit + ' / ' + n + '  (' + (100 * hit / Math.max(1, n)).toFixed(1) + '%)');
console.log('  放宽后（算上没暴露的招）= ' + relaxed + ' / ' + n + '  (' + (100 * relaxed / Math.max(1, n)).toFixed(1) + '%)');
console.log('  生成不出选项       = ' + noOpts);
const onlySw = fh.filter((s) => JSON.parse(s).onlySwitches).length;
const knownFull = fh.filter((s) => JSON.parse(s).known >= 4).length;
console.log('  选项里一招都没有   = ' + onlySw + '  (' + (100 * onlySw / Math.max(1, n)).toFixed(1) + '%)  ← deadLock 误判，下游建议排除');
console.log('  已知 4 招的样本    = ' + knownFull + '  (' + (100 * knownFull / Math.max(1, n)).toFixed(1) + '%)');
console.log('  异常               = ' + err);
if (JEVN > 0) {
  console.log('');
  console.log('=== Jev vs 1700+ 高手（抽 ' + JEVN + ' 个点，步长 ' + JEVSTRIDE + '）===');
  console.log('  实际问成           = ' + jevCount + '  (失败 ' + jevErr + ')');
  console.log('  Jev 与高手同选     = ' + jevHit + ' / ' + jevCount + '  (' + (100 * jevHit / Math.max(1, jevCount)).toFixed(1) + '%)');
  console.log('  干净口径（高手那手确实在我们选项里）= ' + jevHitClean + ' / ' + jevClean + '  (' + (100 * jevHitClean / Math.max(1, jevClean)).toFixed(1) + '%)');
}
console.log('  耗时               = ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
