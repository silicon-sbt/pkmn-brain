# 队伍文件

**这个目录里的 `*.txt` 不进版本库**（`.gitignore` 已排除）—— 队伍是个人配置，
别人的队伍更不该进公开仓库。

把你自己的队伍存成这个目录下的一个 `.txt`，用 Pokemon Showdown 导出的 **importable** 文本格式。

## 格式

```
地龙 @ 剩饭
特性: 粗糙皮肤
等级: 100
太晶属性: 钢
努力值: 252 攻击 / 4 特防 / 252 速度
性格: 开朗
- 地震
- 龙爪
- 剑舞
- 尖石攻击
```

**中英文都可以**，标签和名字都认（`特性:` / `Ability:`、`地震` / `Earthquake` 等价）：

```
Garchomp @ Leftovers
Ability: Rough Skin
Level: 100
Tera Type: Steel
EVs: 252 Atk / 4 SpD / 252 Spe
Jolly Nature
- Earthquake
- Dragon Claw
- Swords Dance
- Stone Edge
```

## 用起来

```bash
node tools/pkmn.mjs set  teams/me.txt                       # 解析并检查结构
node tools/pkmn.mjs team teams/me.txt --format gen9ou       # 合法性校验
node tools/pkmn.mjs calc --attacker-file teams/me.txt --defender "Flutter Mane" --move "Earthquake"
node tools/pkmn.mjs sim  --p1 teams/me.txt --p2 teams/opp.txt --n 200
```

> ⚠️ 校验要**两个校验器都过**才算真合法（`verified: true`）。
> `pokemon-showdown` 的校验器比 `@pkmn/sim` 严格，只信一个会给你**假的 OK**。
