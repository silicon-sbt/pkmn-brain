---
name: pokemon-battle-sim
description: 用本地宝可梦对战引擎无头运行真实对局，验证某条战术线是否成立，或跑蒙特卡洛估算两套队伍的胜率区间。用于"这条线能不能成""哪套队更强"。
whenToUse: 需要验证战术执行、评估两队强弱、复现某个回合序列时。
---

# 无头对战模拟

> 路径以**本仓库根**为基准。若本仓库是别的项目的子目录（如 `toolkit/`），
> 把 `tools/` 读作 `toolkit/tools/`、`teams/` 读作 `toolkit/teams/`。

不是嘴上推演，而是**让引擎把对局跑出来**。

## 两队对打的胜率（蒙特卡洛）

```powershell
node tools/pkmn.mjs sim --p1 teams/me.txt --p2 teams/opp.txt --n 200
```

输出：p1Wins / p2Wins / undecided / p1WinRate / avgTurns / stalled。
- **必须检查 `stalled` 和 `undecided`**。如果 stalled > 0，说明有回合没能推进，
  这个胜率不可信，要先去排查（常见原因：招式全无 PP、队伍只剩 0 只）。
- `avgTurns` 太短（比如 2-3 回合）通常意味着配置有问题（等级/格式不匹配）。

## 固定随机种子（可复现）

```powershell
node tools/pkmn.mjs sim --p1 teams/me.txt --p2 teams/opp.txt --n 1 --seed 1,2,3,4
```

同一个 seed 完全可复现，方便对比"改了配置后同一局会怎样"。

## 这个工具**不**做什么（重要）
引擎里的双方都是**随机出招**，所以：
- 它衡量的是**队伍强度**，不是**你的操作水平**。
- 不要拿它当"我这套队能不能赢他"的结论，只能当"这套队的底子如何"。
- 想验证具体操作线，请让引擎跑到指定回合，然后用 `tools/lib.mjs` 的
  `runBattle` 自行写脚本指定 choice（见下）。

## 自定义操作线（进阶）
`tools/lib.mjs` 导出了 `decide(battle, side)` 和 `runBattle(...)`。
要指定某回合的出招，复制 `tools/example-scripted-line.mjs` 的写法，把 `decide` 换成你写死的
choice 字符串（`'move 2'`、`'switch 2'`）即可。

**注意**：`switch N` 里的 N 是**队伍槽位**（第几只），不是场上位置——这是最容易踩的坑。
