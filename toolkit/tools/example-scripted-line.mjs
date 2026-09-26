// 示例：跑一条指定操作线（其余交给引擎随机出招）
// 这是验证"这条线能不能成"的核心用法。
import { loadTeam, runBattle, tpath } from './lib.mjs';
import * as sim from '@pkmn/sim';

const p1 = loadTeam(tpath('teams', 'vgc-a.txt'));
const p2 = loadTeam(tpath('teams', 'vgc-b.txt'));

const r = await runBattle(sim, p1, p2, 'gen9doublescustomgame', [1, 2, 3, 4], {
  // scripted 每回合调用一次，返回 { p1?, p2? } 的招法字符串。
  // 没指定的那一方由引擎自动随机出招；返回 {} 表示双方都随机。
  scripted: (battle, turn) => {
    if (battle.turn === 1) {
      // 双打：手动出招必须自带目标。'move 1 1' = 第1个招式打对方1号位。
      // 目标：1 / 2 = 对方场位，-1 = 自己队友。
      // 扩散招式（地震、热风）和自身招式（守住、剑舞）不能带目标。
      return { p1: 'move 1 1, move 3' };
    }
    return {};
  },
});

console.log('RESULT:', JSON.stringify({ winner: r.winner, turn: r.turn, ended: r.ended, stalled: r.stalled, errors: r.errors }));
console.log('日志末尾：');
console.log(r.log.slice(-12).join('\n'));
