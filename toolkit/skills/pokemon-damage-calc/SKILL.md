---
name: pokemon-damage-calc
description: 用本地伤害计算引擎算宝可梦的伤害区间、击杀线（几确/乱数）和速度线对比。用于"这发能不能秒""要不要拉速度""抗不抗得住"。全部离线，结果可复现。
whenToUse: 需要判断伤害、击杀线、耐久、速度先后手时。
---

# 伤害计算与速度线

> 路径以**本仓库根**为基准。若本仓库是别的项目的子目录（如 `toolkit/`），
> 把 `tools/` 读作 `toolkit/tools/`、`teams/` 读作 `toolkit/teams/`。

## 关键原则：先有队伍文件，再算伤害
不要凭记忆填 EV/性格/道具。先把双方配置写成 importable 文件（见 pokemon-team-intake），
再用 `--attacker-file` / `--defender-file` 传入整只配置，这样种族值、性格、EV、
道具、太晶属性都会真实参与计算。

## 伤害

```powershell
# 完整配置（推荐）：文件里第一只宝可梦即当作攻/守方
node tools/pkmn.mjs calc --attacker-file teams/me.txt --defender-file teams/opp.txt --move "Earthquake"

# 快速估算：只给物种，用默认配置
node tools/pkmn.mjs calc --attacker "Garchomp" --defender "Flutter Mane" --move "Earthquake"
```

输出包含：可读描述、防守方血量、伤害区间、百分比、**koChance（几确）**、16 个伤害乱数。

- 多词名字必须加引号：`--defender "Flutter Mane"`，否则会被拆成两个参数。
- 双打要加 `--field doubles`（影响部分招式与天气/场地判定）。

## 速度线

```powershell
node tools/pkmn.mjs speed --attacker "Garchomp" --defender "Flutter Mane" --scarf p1 --tailwind p2 --para p1
```

- 基准是 **Lv50 / 满速 EV / Jolly 或 Timid**，与实际队伍不符时用
  `--attacker-file` 传真实配置。
- 修正开关：`--scarf p1`（围巾×1.5）、`--tailwind p2`（顺风×2）、`--para p1`（麻痹×0.5），
  可组合，逗号分隔，取值是 `p1`/`p2`。

## 特性 / 道具效果：必须查，不要凭记忆

伤害算错最常见的原因不是算术，而是**特性或道具的效果记错了**。

```powershell
node tools/pkmn.mjs ability "威吓"      # 中文描述，含免疫该效果的特性列表
node tools/pkmn.mjs item "突击背心"     # 中文描述
node tools/pkmn.mjs move "地震"         # 招式的 shortDescZh / descZh
```

中文名、官方译名、社区俗称都能查（`剩饭` = `吃剩的东西` = Leftovers）。
返回的 `shortDescZh`（简）与 `descZh`（详）来自 PS 官方中文数据，
**凡是涉及特性/道具的结论，都要引用查到的描述，不要自己复述记忆里的效果。**

注意：计算器会代入你传入的特性，但**不会替你想起来该传哪个**。
比如对方是 Multiscale（多重鳞片）还是 Rough Skin（粗糙皮肤），结论完全不同。

## 报告习惯
给用户结论时**同时给出前提**：几确、在什么条件下（太晶/道具/场地/天气）、
以及乱数区间。只写"能秒"是误导——写出"91-109，36.2%-43.4%，确定 3 确"。
