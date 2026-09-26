---
name: pokemon-vgc-doubles
description: 双打/VGC 专属的对战分析：场上两只同时行动、扩散招式 0.75 倍、目标指定、顺风/戏法空间的速度博弈。用于"双打怎么打""VGC 这套队行不行"。
whenToUse: 用户提到双打、VGC、64 双打、场上有两只宝可梦、顺风、戏法空间时。
---

# 双打 / VGC

> 路径以**本仓库根**为基准。若本仓库是别的项目的子目录（如 `toolkit/`），
> 把 `tools/` 读作 `toolkit/tools/`、`teams/` 读作 `toolkit/teams/`。

单打的直觉在双打里经常是错的。这个技能补上双打特有的部分；通用流程见
`pokemon-damage-calc` 和 `pokemon-battle-sim`。

## 1. 伤害计算必须开双打场地

```powershell
node tools/pkmn.mjs calc --attacker-file teams/vgc-a.txt --defender "振翼发" --move "地震" --doubles
```

`--doubles` 会把**扩散招式**（地震、热风、魔法闪耀、大声咆哮…）按 **0.75 倍**计算。
实测对照：地震打振翼发，单打 136-162，双打 102-121 —— 正好 75%。

**忘了加 `--doubles` 会把伤害高估 33%，直接导致错误的击杀线判断。**
单体招式（龙爪、冰冻拳）不受影响。

## 2. 目标指定（写自定义操作线时才需要）

双打里单体招式必须说明打谁，否则引擎拒绝：
- `move 1 1` = 用第 1 个招式打**对方 1 号位**
- `move 1 2` = 打对方 2 号位
- `move 1 -1` = 打**自己队友**
- **扩散招式（地震/热风）和自身招式（守住/剑舞）不能带目标**，带了会被拒绝

用 `tools/example-scripted-line.mjs` 跑指定操作线时按这个格式写。
日常的 `sim` 不需要手动指定目标，引擎会自动处理。

## 3. 速度博弈和单打不同

```powershell
node tools/pkmn.mjs speed --attacker "振翼发" --defender "铁臂膀" --tailwind p1
```

- **顺风** `--tailwind p1`：×2，持续 4 回合，是双打控速的核心。
- **麻痹** `--para p1`：×0.5。
- **戏法空间**：本工具**不直接支持**。空间下速度倒序，需要你自己按数值反推
  （速度越低越先动），或改跑 `sim` 观察实际结果。别假装算过。
- 双打常见还有冻风/电网等**场上降速**，同样不在计算器里，需要手动折算。

## 4. 队伍与格式

```powershell
# VGC 队伍必须至少 4 只（登记 6 只、出场 4 只）
node tools/pkmn.mjs team teams/vgc-a.txt --format gen9vgc2025regi
```

- **当前规则是 Champions（VGC 2026）**，只有 `pokemon-showdown` 引擎能跑：
  `gen9championsvgc2026regma` / `regmb`（双打，含 bo3 变体）、
  `gen9championsdoublescustomgame`（无限制，适合测队）。
  格式 id 含 `champions` 会自动路由到 showdown 引擎，不用手动切。
- 旧规则（仍在 @pkmn/sim）：`gen9vgc2025regi`（2025 Reg I）、`gen9vgc2024regg`、
  `gen9doublescustomgame`。
- **别把 `gen9vgc2025regi` 当成当前规则** —— 输出里的 `engine` 字段会告诉你用的是哪个引擎。
- 列格式：`node tools/pkmn.mjs formats vgc` / `formats champions`。
- **VGC 队伍等级是 50 级**，不要用 `gen9ou` 校验（那是 Lv100 格式，会报错）。
- 用 `node tools/pkmn.mjs formats vgc` 列出全部可用 VGC 格式。

## 5. 双打模拟

```powershell
# 当前规则（Champions VGC 2026）
node tools/pkmn.mjs sim --p1 teams/vgc-a.txt --p2 teams/vgc-b.txt --n 100 --format gen9championsdoublescustomgame
# 旧规则
node tools/pkmn.mjs sim --p1 teams/vgc-a.txt --p2 teams/vgc-b.txt --n 100 --format gen9doublescustomgame
```

- 出招由**引擎自带 AI** 处理（随机），双打目标、换人、出场数都已正确处理。
- 看 `gameType` 字段确认跑的是 doubles。`stalled` 必须为 0。
- 同单打：这是**队伍强度**参考，不是操作水平。

## 双打独有的、本工具**不能**替你判断的东西

必须明确告诉用户这些没算：
- 集火 / 单点突破的收益（打一只还是分散打两只）
- 保护（守住）的读招博弈
- 队友的联动（如击掌奇袭锁住对方、威吓压制物理攻击手）
- 出场 4 只的选择（本工具可以算个体对位，但选谁上是决策）
