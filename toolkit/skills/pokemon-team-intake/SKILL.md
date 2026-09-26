---
name: pokemon-team-intake
description: 把玩家的宝可梦队伍（Showdown export 文本 / 截图 / 口述）录入成 teams/ 下的标准队伍文件，并做合法性校验。用于"我要用这套队""帮我存一下我的队""这是对手的队伍"。
whenToUse: 用户提供或粘贴宝可梦队伍、要求保存/解析/校验队伍时。
---

# 队伍录入 (Team Intake)

> 路径以**本仓库根**为基准。若本仓库是别的项目的子目录（如 `toolkit/`），
> 把 `tools/` 读作 `toolkit/tools/`、`teams/` 读作 `toolkit/teams/`。

## 为什么需要
所有分析（伤害计算、对局模拟、针对性分析）都以 `teams/*.txt` 的
Showdown importable 文本为唯一输入格式。先把队伍落盘成文件，后面所有工具才能复用。

## 步骤

1. 把队伍原文写入 `teams/<名字>.txt`，保持 Showdown export 原格式：

```
Garchomp @ Life Orb
Ability: Rough Skin
Level: 50
Tera Type: Steel
EVs: 252 Atk / 4 SpD / 252 Spe
Jolly Nature
- Earthquake
- Dragon Claw
- Protect
- Swords Dance
```

2. 解析并确认结构对不对：

```powershell
node tools/pkmn.mjs set teams/<名字>.txt
```

3. 跑合法性校验（注意格式要选对）：

```powershell
node tools/pkmn.mjs team teams/<名字>.txt --format gen9ou       # 单打 Lv100
node tools/pkmn.mjs team teams/<名字>.txt --format gen9vgc2024regg  # 双打 Lv50
```

## 坑

- **Level: 50 + gen9ou 会报错**。gen9ou 是 Lv100 格式，Lv50 队伍请用 VGC 格式，
  或按提示给某个 EV 加 1 来消除歧义。
- 截图/口述录入时**不要自己发明**招式名、道具名或特性。拿不准就先查：
  `node tools/pkmn.mjs move "招式名"` / `node tools/pkmn.mjs ability "特性名"` /
  `node tools/pkmn.mjs item "道具名"` / `node tools/pkmn.mjs dex "宝可梦名"`。
  猜错会静默算错伤害。中英文名和社区俗称都能查。
- 昵称和物种名用 `昵称 (Species) @ 道具` 格式，否则会被当成物种名。
- 招式名前必须是 `- `（短横线加空格）。
