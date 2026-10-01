# pkmn-toolkit

**离线宝可梦对战工具箱** —— 伤害计算 / 对局模拟 / 中文数据 / 给 AI 助手用的技能。
支持**中文名与中文队伍文本**，单打与双打/VGC 都行。**全部离线**，每个数字都能自己复现。

```bash
git clone https://github.com/silicon-sbt/pkmn-toolkit.git && cd pkmn-toolkit && npm install

node tools/pkmn.mjs dex 耿鬼            # 查资料（中英文皆可）
node tools/pkmn.mjs calc --attacker "Garchomp" --defender "Flutter Mane" --move "Earthquake"
node tools/pkmn.mjs sim --p1 a.txt --p2 b.txt --n 200
```

---

## 它是什么 / 不是什么

**是**：一个真能算伤害、真能跑对局的本地引擎；外加一套让 AI 助手**正确使用它**的技能 ——
把「不许凭记忆报数字」「必须给几确和前提」这些纪律固化成了可执行的文件。

**不是**：能替你打对战的外挂。`sim` 里双方都是引擎随机出招，它衡量的是**队伍强度**，
不是**你的操作水平** —— 拿它下「我能不能赢他」的结论就是误用。

---

## 快速开始

需要 **Node.js ≥ 20**（开发环境 24）。零配置，中文数据表已经随仓库带上。

### 1. 查资料（中英文皆可）

```bash
node tools/pkmn.mjs dex 耿鬼        # 种族值 / 属性 / 特性
node tools/pkmn.mjs move 地震        # 威力 / 属性 / 分类 / PP / 优先度 + 中文效果描述
node tools/pkmn.mjs ability 威吓     # 特性中文描述
node tools/pkmn.mjs item 剩饭        # 道具中文描述
```

### 2. 存队伍并校验

把 Showdown 导出的 importable 文本存成 `teams/xxx.txt`（中英文均可，格式见 [`teams/README.md`](teams/README.md)）。

```bash
node tools/pkmn.mjs set  teams/me.txt
node tools/pkmn.mjs team teams/me.txt --format gen9ou
```

> ⚠️ 校验会跑**两个校验器**，只有 `verified: true` 才算真合法。
> `pokemon-showdown` 的比 `@pkmn/sim` 严格，会执行 sim 漏掉的规则 —— 只信一个会拿到**假的 OK**
> （实测：某招学习表只标了 Gen8 来源，sim 判通过，PS 判「无法从 Gen8 传送」）。

### 3. 算伤害与击杀线

```bash
node tools/pkmn.mjs calc --attacker-file teams/me.txt --defender-file teams/opp.txt --move 地震
node tools/pkmn.mjs calc --attacker "Garchomp" --defender "Flutter Mane" --move "Earthquake" --doubles
# 古代活性/夸克充能：calc 完全不建，必须显式告诉它【提的是哪一项】（不给就是 ×1）
node tools/pkmn.mjs calc --attacker "Great Tusk" --defender "Garganacl" --move "Ice Spinner" --paradox-p1 atk
node tools/pkmn.mjs speed --attacker 烈咬陆鲨 --defender 振翼发 --scarf p1 --tailwind p2
```

多词**英文**名要加引号（`--defender "Flutter Mane"`），中文名不用。
`speed` 会自动读配置里的讲究围巾 / 天气特性；另有 `--weather --para --booster --boost-pN` 描述额外假设。

### 4. 跑对局

```bash
node tools/pkmn.mjs sim --p1 teams/a.txt --p2 teams/b.txt --n 200
node tools/pkmn.mjs sim --p1 teams/a.txt --p2 teams/b.txt --n 1 --seed 1,2,3,4   # 可复现
```

### 5. 其余工具

```bash
node tools/pkmn.mjs formats champions                  # 列出可用格式
node tools/battlecard.mjs teams/me.txt teams/opp.txt   # 赛前速查卡（含速度顺序 / 钉子价值）
node tools/matchup.mjs teams/me.txt teams/opp.txt      # 对阵报告
node tools/q.mjs 雄伟牙 天蝎王                          # 战斗中 0.16 秒的快捷查询
```

### 自检

```bash
node tools/_verify-core.mjs    # 多段招二维数组 + 速度修正 + 古代活性倍率（32 项断言，不联网）
npm run mcp:test               # MCP 握手 + 8 个工具各调一次
```

---

## 中文支持（不只是名字，是**描述**）

```bash
$ node tools/pkmn.mjs ability 威吓
  nameZh      威吓
  shortDescZh 出场时使对手的攻击降低1级。
  descZh      …特性为精神力、迟钝、我行我素、胆量的宝可梦和处于替身状态的宝可梦不受影响。
```

三个离线数据源互补：

| 文件 | 来源 | 提供 | 覆盖 |
|---|---|---|---|
| `data/zh-ps.json`（**主源**） | Pokémon Showdown 官方中文 | 译名 + **描述**，键与 `@pkmn/dex` 同构 | 宝可梦 1559 / 招式 953 / 特性 320 / 道具 583 |
| `data/zh-names.json` | PokeAPI 官方简中 | 译名 | 与主源在 59 条上译法不同，两套都保留 |
| `data/zh-aliases.json` | 社区俗称 / 旧译 | 译名 | 人工维护，可自由增补 |

`归天之翼`(PS) 和 `死亡之翼`(PokeAPI) 都能查到 Oblivion Wing；`剩饭`、`吃剩的东西`、`Leftovers` 三者等价。
查名顺序 **主源 → 补充源 → 俗称表**；查不到时先怀疑是俗称/新旧译法，往 `zh-aliases.json` 加一条即可。

**中文队伍文本可以直接用**：

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

想重新生成中文表（需联网，各一次，在仓库根目录跑）：

```bash
node tools/fetch-zh-ps.mjs     # data/zh-ps.json    ← Pokémon Showdown 官方中文（含描述）
node tools/fetch-zh.mjs        # data/zh-names.json ← PokeAPI 官方简中译名
```

---

## 给 AI 助手用：三种集成层次

| 层次 | 位置 | 说明 |
|---|---|---|
| **CLI** | `tools/pkmn.mjs` | 零门槛，任何终端 / 任何 AI 都能用 |
| **技能** | `skills/` | 6 个 `SKILL.md`，教 AI 什么时候调什么命令、结果怎么读 |
| **MCP** | `mcp/pokemon-server.mjs` | 类型化参数，免掉 shell 引号问题 |

### 技能

`skills/` 下是标准 `SKILL.md` 包，任何支持该格式的客户端都能用（DSH / Claude Code 等）。
技能里的命令都以**仓库根目录**为工作目录。

| 技能 | 什么时候用 |
|---|---|
| `pokemon-team-intake` | 「我要用这套队」—— 录入并校验 |
| `pokemon-damage-calc` | 「这发能秒吗」「要不要拉速度」 |
| `pokemon-battle-sim` | 「这条线能不能成」「哪套队更强」 |
| `pokemon-vgc-doubles` | 双打专属：扩散招式 0.75 倍、目标指定、顺风 |
| `pokemon-matchup-report` | 「我该怎么打他这套队」 |
| `pokemon-battle-prep` | 赛前准备 + 战斗中的应答纪律 |

接进你的项目，任选一种（以 DSH 为例）：

```bash
# 方式一：直接放进项目的默认技能根
cp -r skills/* <你的项目>/.dsh/skills/

# 方式二：配置一个自定义技能根（DSH 的 customSkillDirs，优先级 300）
#   在你的补丁层里：
#   - insert:
#       - id: skills-pkmn
#         name: '@deepseek-ai/dsh-skill-filesystem'
#         config:
#           providerName: pkmn
#           includeDefaultRoots: false
#           customSkillDirs:
#             - /绝对路径/pkmn-toolkit/skills
```

### MCP 服务器

`mcp/pokemon-server.mjs` 暴露 8 个工具：`dex` `move` `ability` `item` `calc` `speed` `validate_team` `sim`。

```yaml
# DSH 补丁层片段（改完需重启）
- insert:
    - id: mcp-pokemon
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: pokemon
        transport: stdio
        command: node
        args:
          - /绝对路径/pkmn-toolkit/mcp/pokemon-server.mjs
        cwd: /绝对路径/pkmn-toolkit
        toolCallTimeoutMs: 300000
```

---

## 双引擎

| 引擎 | 格式数 | Champions / VGC 2026 | 说明 |
|---|---|---|---|
| [`@pkmn/sim`](https://github.com/pkmn/ps) | 201 | **0** ❌ | 轻量纯 ESM，默认引擎 |
| [`pokemon-showdown`](https://github.com/smogon/pokemon-showdown) | 334 | **15** ✅ | 官方完整包 |

格式 id 含 `champions` 自动走 `pokemon-showdown`，其余走 `@pkmn/sim`；
`--engine sim|showdown|auto` 可强制指定，输出里的 `engine` 字段说明实际用了哪个。

```bash
node tools/pkmn.mjs formats champions
node tools/pkmn.mjs sim --p1 a.txt --p2 b.txt --n 30 --format gen9championsdoublescustomgame
```

> **Champions 的数值系统与主线不同**：队伍文本里的 `EVs:` 是 Stat Points（单项上限 32、总上限 66、IV 固定 31）。
> 外部导出的 Champions 队伍**经常把 Stat Points 丢成全 0** —— 全 0 能通过校验，
> 但代表完全没投入，据此算伤会偏低 15–20%。看到全 0 请先确认真实分配。

---

## 目录

```
tools/pkmn.mjs          统一 CLI（中文名 / 中文队伍 / 双引擎）
tools/lib.mjs           库：队伍解析、中文映射、无头对战、damageRolls()、finalSpeed()、tpath()
tools/engine.mjs        双引擎路由
tools/battlecard.mjs    赛前速查卡（速度顺序 / 钉子价值 / 先制威胁）
tools/matchup.mjs       对阵报告
tools/q.mjs             战斗中的极速查询（0.16s）
tools/rag.mjs           零依赖 BM25 离线检索
tools/fetch-*.mjs       数据生成（联网，一次性）
teams/                  你的队伍（*.txt 不入库，格式见 teams/README.md）
data/zh-*.json          中文数据（译名 + 描述）
data/meta-sets.json     Smogon 真实使用率配置（452 只）
skills/                 6 个 AI 技能（SKILL.md）
mcp/pokemon-server.mjs  项目级 MCP 服务器
workflows/              工作流模板
AGENTS.md               给 AI 的项目约定（引擎踩坑、纪律）
```

---

## 已验证 / 已知限制

**已实测**：伤害计算（整队配置、太晶、双打扩散招式 0.75 倍）、速度线（围巾 / 顺风 / 麻痹）、
队伍解析与**双校验器**校验、无头对战（单打 / 双打 / VGC 共 140 局，0 stalled 0 undecided）、
MCP 完整握手 + 8 工具调用。

**已知限制（诚实的）**：

- `sim` 双方随机出招，**只反映队伍强度，不代表操作水平**。
- **戏法空间、冻风 / 电网等场上降速不在计算器里**，需要手动折算或跑 `sim` 观察。
- 双打里的集火、守住读招、队友联动属于决策，工具不替你判断。
- 中文数据依赖 PokeAPI 官方译名 + 社区俗称表；**未收录的俗称会查不到**。
- 道具只覆盖对战相关项（例如「精灵球」不在对战数据里，属正常）。
- `@smogon/calc` 的部分机制要自己补（画皮、结冻头、结实、气势披带、**替身**），
  另一些它已经建了（多重鳞片、幻影防守）—— **具体清单见 [`AGENTS.md`](AGENTS.md)**。
  ⚠️ 它**不会替你检测**这些机制什么时候生效（例如「对手现在有没有替身」），
  得你自己从日志里读出来，再决定要不要按上面那套规则折算。
- **古代活性 / 夸克充能（含驱动能量）calc 完全不建**（实测：四种写法伤害一模一样）。
  `calc` 用 `--paradox-p1 atk`（攻方被提的那一项）、`--paradox-p2 spd`（守方）显式打开，
  倍率取自引擎源码 `chainModify([5325,4096])` = **×1.30005**。
  **不给参数就是 ×1 —— 代码不猜「它多半提了攻」**；猜出来的数字是假事实。
  提的是速度时对伤害没有影响，别顺手乘。

---

## 许可

代码以 **MIT** 发布。内置数据的第三方来源与归属见 [`LICENSE`](LICENSE)。

Pokémon、宝可梦及相关名称为任天堂 / Creatures Inc. / GAME FREAK inc. 的商标。
本项目为非官方粉丝工具，与上述公司及 Smogon、Pokémon Showdown 无关联。

---

## 想要「打着打着自动告诉我点啥」？

这个仓库是**离线**的那一半：你问它，它才算。
如果你要的是**打天梯时实时给建议的面板**（读对战页 → 调小模型 → 左下角显示「点啥 / 换谁 / 用不用太晶」），
那是另一半：**[silicon-sbt/pkmn-brain](https://github.com/silicon-sbt/pkmn-brain)**。
它已经把本仓库内联了一份，所以克隆那一个就够用。
