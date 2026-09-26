// 决策日志 —— 每次决策写一行 JSONL，另存一份当时的 Showdown 原始日志。
//
// 为什么需要它（用户 2026-09 要求）：面板说的和 Showdown 实际发生的事对不上时，
// 没有现场就只能猜。brain 服务端原本【不写任何文件】，黑窗口滚过去就没了。
//
// 两个文件，都在 brain/logs/：
//   <key>.jsonl  每次决策一行：局面 + 发给 Jev 的面板原文 + Jev 的答案
//   <key>.log    当时的 Showdown 日志全文（累积的，每次覆盖成最新的那份）
//
// 怎么判断「这是新的一局」：Showdown 的日志是【累积】的 —— 新一局的日志不会是
// 上一局日志的延伸。所以 `本回合的日志.startsWith(上一回合的日志)` 成立就是同一局，
// 否则就是新的一局。这样【不需要用户脚本传房间号】也能分开存档。
// （用户脚本若传了 room 就用它当文件名，更好认。）
//
// ⚠️ 写日志失败【绝不能静默】，也不能拖垮这一回合的决策 —— 所以 catch 里必须打出来。
import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cfg } from './config.mjs';

export const LOG_DIR = fileURLToPath(new URL('./logs/', import.meta.url));

// 当前这一局的存档位置。服务是单进程单用户，用模块级变量足够。
let cur = null;

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
const safe = (s) => String(s || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);

// 供自检脚本重置当前局面（正常服务不需要）
export function resetDecisionLog() { cur = null; }

export function logDecision({ raw, body, out, ms }) {
  if (!cfg.logging.enabled) return;   // 配置里关掉就完全不落盘
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const log = String(raw || '');
    const room = body && body.room ? safe(body.room) : null;
    const sameBattle = !!(cur && cur.lastLog && log && log.startsWith(cur.lastLog));
    if (!sameBattle) {
      const key = room || ('battle-' + stamp());
      cur = { key, file: LOG_DIR + key + '.jsonl', logFile: LOG_DIR + key + '.log',
              lastLog: '', seq: 0, startedAt: new Date().toISOString() };
      console.log('[日志] 新的一局 → logs/' + key + '.jsonl' +
        (room ? '' : '（用户脚本没传房间号，用开始时间当名字）'));
    }
    cur.lastLog = log;
    cur.seq++;
    const rec = {
      at: new Date().toISOString(),
      seq: cur.seq,
      turn: out && out.turn != null ? out.turn : null,
      shape: (out && out.phase) || 'move',
      ok: !(out && out.ok === false),
      reason: (out && (out.reason || out.msg)) || null,
      me: (out && out.me) || null,
      opp: (out && out.opp) || null,
      teamSource: (out && out.teamSource) || null,

      panel: {
        pick: (out && out.pick) || null,
        nameZh: (out && out.nameZh) || null,
        verdict: (out && out.verdict) || null,
        confidence: out && out.confidence != null ? out.confidence : null,
        useTera: !!(out && out.useTera),
        oppSwitch: (out && out.oppSwitch) || null,
      },
      locked: (out && out.locked) || null,
      switchFacts: (out && out.switchFacts) || null,
      options: (out && out.allOptions) || null,
      // ★★ 这一项最值钱：发给 Jev 的【面板原文】逐字留档。
      //   面板是纯文字，文案就是全部信息 —— 事后只能靠它复盘「当时到底告诉模型什么了」。
      criteria: (out && out._criteria) || null,
      instructions: (out && out._instructions) || null,
      answers: (out && out._answers) || null,
      ms: ms != null ? ms : null,
      jevMs: out && out.jevMs != null ? out.jevMs : null,
      logLines: log.split(/\r?\n/).length,
    };
    appendFileSync(cur.file, JSON.stringify(rec) + '\n', 'utf8');
    writeFileSync(cur.logFile, log, 'utf8');
  } catch (e) {
    // 日志坏了是小事，但【必须让人看见】—— 静默失败是本项目的头号红线
    console.log('[日志] ⚠️ 写决策日志失败: ' + ((e && e.message) || e));
  }
}
