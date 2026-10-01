# toolkit —— 工具与技能（离线那一半）

纯离线的宝可梦数据 / 伤害 / 对局工具 + AI 技能（`SKILL.md`）。**自包含**，不依赖任何外部服务与其它仓库。

> **路径基准**：本文件与 `skills/` 里出现的命令，路径都以**本仓库根**为工作目录。
> 若本仓库被当作子目录使用（例如放在父项目的 `toolkit/` 下），把 `tools/` 读作 `toolkit/tools/`、
> `teams/` 读作 `toolkit/teams/`。

统一入口：`node tools/pkmn.mjs <子命令>`（Node 24，全离线）。**支持中文名与中文队伍文本。**

| 命令 | 用途 |
|---|---|
| `dex <名称>` | 种族值 / 属性 / 特性（中英文皆可，如 `耿鬼`） |
| `move <名称>` | 招式威力/属性/分类/PP/优先度 + 中文效果描述（如 `地震`） |
| `ability <名称>` | 特性效果（**中文描述**，如 `威吓`） |
| `item <名称>` | 对战道具效果（**中文描述**，如 `剩饭`） |
| `set <队伍文件>` | 解析 importable 队伍 |
| `calc --attacker-file A --defender-file B --move M` | 伤害 + 击杀线（双打加 `--doubles`） |
| `speed --attacker X --defender Y` | 速度线对比 |
| `team <队伍文件> --format <格式>` | 队伍合法性校验（**双校验器**，见下） |
| `sim --p1 a.txt --p2 b.txt --n 200` | 蒙特卡洛胜率（`--format` 决定单/双打） |
| `speed` 修正 | 配置里的讲究围巾/天气特性**自动算**；另有 `--scarf/--tailwind/--para/--weather/--booster/--boost-pN` |
| `node tools/_verify-core.mjs` | 核心库自检（多段招二维数组 + 速度修正 + 古代活性倍率，32 项断言） |
| `formats [关键词]` | 列出可用对战格式（两个引擎合并，标注来源） |

底层库在 `tools/lib.mjs`（`parseImportable` / `loadTeam` / `runBattle` / `zhToEn` / `enToZh` / `tpath`）。
需要写自定义逻辑时 import 它，不要在 `pkmn.mjs` 里加。

## 路径规则（重组后新增，务必遵守）

**所有默认路径必须走 `tpath()`，不要写裸相对路径。**

```js
import { tpath } from './lib.mjs';
loadTeam(tpath('teams', 'ou-a.txt'));       // ✅ 锚定仓库根，从任何 cwd 都成立
loadTeam('teams/ou-a.txt');                  // ❌ 依赖 cwd，从项目根调用就找不到
```

`lib.mjs` 里的 `loadJson` 已经用 `HERE/..` 定位 `data/`，天然正确。
`fetch-*.mjs` 是一次性数据生成脚本，需要在**仓库根目录**下运行（它们的输出路径是 cwd 相对的）。

## ⚠️ Champions 的数值系统与主线不同（已实测确认）

Champions 队伍文本里的 `EVs:` 字段是 **Stat Points**，不是主线的努力值：

| | 主线 | Champions |
|---|---|---|
| 单项上限 | 252 EV | **32 点** |
| 总上限 | 508 EV | **66 点** |
| IV | 0–31 可调 | **固定 31**；写 `IVs: 0` 会被校验直接拒绝 |

**换算（实测验证）**：`evs=32` 与主线 `252EV/31IV` 数值**完全一致** —— **1 点 ≈ 8 点努力值**（第 1 点 ≈ 4）。
引擎内部用 `max(2*点数-1, 0)` 充当主线的 `floor(EV/4)`；喂 `@smogon/calc` 时反过来：
`主线EV = max(8*点数-4, 0)`。

**重大坑**：外部导出的 Champions 队伍**经常把 Stat Points 丢成全 0**。全 0 是**合法的**（校验会通过！），
但代表**完全没投入**，据此算出的伤害偏低约 15–20%。**看到全 0 必须先问用户真实分配，不要直接开算。**

## 双引擎（重要）

| 引擎 | 格式数 | Champions / VGC 2026 | 说明 |
|---|---|---|---|
| `@pkmn/sim` | 201 | **0** ❌ | 轻量纯 ESM，默认引擎 |
| `pokemon-showdown` | 334 | **15** ✅ | 官方完整包，CJS |

**路由**：格式 id 含 `champions` 自动走 `pokemon-showdown`，其余走 `@pkmn/sim`。
`--engine sim|showdown|auto` 可强制，输出里的 `engine` 字段说明实际用了哪个。

当前 VGC 2026（Reg M-C）只有 `pokemon-showdown` 能跑（`gen9championsvgc2026regmb` 等）。
**别拿 `@pkmn/sim` 的 `gen9vgc2025regi` 冒充当前规则。**

**多词英文名必须加引号**：`--defender "Flutter Mane"`。中文名不用。

## 中文支持（两个离线数据源互补）

**主源 `data/zh-ps.json`** —— PS 官方中文（`fetch-zh-ps.mjs`）：键就是 Showdown ID，与 `@pkmn/dex` 同构，
**自带中文描述**（`shortDesc`/`desc`）。覆盖：宝可梦 1559 / 招式 953 / 特性 320 / 道具 583。

**补充源 `data/zh-names.json`** —— PokeAPI 官方简中译名（`fetch-zh.mjs`）。
与主源在 59 条上译名不同，**两套都保留**（`归天之翼`/PS vs `死亡之翼`/PokeAPI）。

**俗称表 `data/zh-aliases.json`** —— 社区俗称/旧译（人工维护，优先级最低）。
Leftovers 官方「吃剩的东西」但大家都说「剩饭」；Jolly 官方「爽朗」而旧译「开朗」。两套都认。

查名顺序：**主源 → 补充源 → 俗称表**。重新生成（需联网，各一次）：
`node tools/fetch-zh-ps.mjs` 和 `node tools/fetch-zh.mjs`（在仓库根目录下跑）。

**凡是涉及特性/道具/招式效果的结论，都要引用查到的中文描述，不要复述记忆。**

## 目录

- `tools/` —— CLI 与库
- `data/` —— 中文表、真实使用率配置（`meta-sets.json`）、RAG 索引
- `teams/` —— 队伍文件（importable 文本，中英文均可）
- `skills/` —— AI 技能（标准 `SKILL.md` 包，任何支持的客户端都能用；接法见 README）
- `mcp/pokemon-server.mjs` —— 项目级 MCP 服务器
- `workflows/` —— 工作流模板
- `docs/` —— 生态调研报告

## 已知坑（全部实际踩过）

**⚠️ 校验必须用两个校验器（最重要的一条）**
- `pokemon-showdown` 的 `TeamValidator` **比 `@pkmn/sim` 的更严格**，会执行 sim 漏掉的规则。
  实测：Slowking-Galar 的 `Scald` 学习表是 `["8M"]`（仅 Gen8 来源），
  **sim 判「通过」，PS 判 "can't be transferred from Gen 8 to 9"**。
- 因此 `pkmn.mjs team` **两个都跑**，输出 `problems` / `strictProblems` / `verified`。
  **只有 `verified: true` 才算真的合法。** 只信一个校验器会给**假的 OK**。

**⚠️ `@smogon/calc` 建了什么、没建什么 —— 必须先写对拍测出来，再决定要不要自己补**
- ✅ **已建模**：多重鳞片 Multiscale、幻影防守 Shadow Shield（实测快龙吃暗影球 199-235 → 99-117，正好一半）
- ❌ **没建模**：画皮 Disguise、结冻头 Ice Face、结实 Sturdy、气势披带 Focus Sash、
  **替身 Substitute**、**古代活性 / 夸克充能（含驱动能量）**
- **替身**：实测 calc 里只有一条招式记录（`{bp: 0, category: 'Status'}`），**伤害路径上没有任何替身机制**
  ⇒ 它会把「打在替身上」照样算成「打在本体上」。规则（引擎 `data/moves.js` 的
  `substitute.onTryPrimaryHit`）：替身血量 = `floor(最大血 / 4)`；
  **伤害超过替身剩余时截到替身剩余 —— 多出来的不结转到本体**；
  三种情况不吃替身：自身指向 / `move.flags.bypasssub`（音波招式）/ `move.infiltrates`（穿透特性）；
  多段招打掉替身后的**后续几下**才打到本体。
  ⚠️ 日志**不公开替身剩余血量**，所以只能说「最多还能吸收 25% 最大血」这个上限。
- **古代活性 / 夸克充能**：实测四种写法（不给 / `ability:'Protosynthesis'` / `item:'Booster Energy'` /
  两者都给）伤害**一模一样**；构造后改 `stats.atk`、`rawStats.atk` 也全被忽略。
  倍率取自引擎源码 `data/abilities.js` 的 `onModifyAtk/Def/SpA/SpD → chainModify([5325, 4096])` = **×1.30005**
  （速度档是 `onModifySpe → chainModify(1.5)`）。
  共享实现在 `lib.mjs` 的 `PARADOX_MULT` / `paradoxStats` / `paradoxMult` ——
  **brain 也 import 这一份**，两边不许各写一个（漂移的方向就是「面板和 CLI 给出不同的数字」）。
  `pkmn.mjs calc` 用 `--paradox-p1 atk` / `--paradox-p2 spd` 显式打开，**不给就是 ×1**（代码不猜它提了哪一项）。
  两个易漏点：**扑击 Body Press 看防御**（提 `def` 才生效）、
  **精神冲击 / 精神击破 / 神秘之剑是特攻招但打物防**（对面提 `def` 要减）。
  另外 `calc` 的 `desc` 字段是 calc 的【原始】文案、不含这个缩放，缩放过会挂一句口径提醒 ——
  两个互相矛盾的数字并排出现就是假事实。
  自检：`node tools/_verify-core.mjs` 的 ③（9 项断言）。
- 我一度凭印象说「Multiscale 我们一个都没建模」——**是错的**，差点双重减半。
  **凡「calc 支不支持 X」，一律先写个对拍测出来。**
- 上面这些没建模的，规则（已对过引擎源码，需要时自己补）：
  **结实 / 气势披带** = 满血时被打倒就把该次伤害截成「留 1 血」（多段招不适用：第一段留 1 血、第二段照样打死）；
  **画皮 / 结冻头** = 该次伤害归 0（画皮再自扣 1/8 最大 HP）。
  引擎源码：`pokemon-showdown/dist/data/abilities.js` 搜 `sturdy` / `disguise`，`data/items.js` 搜 `focussash`。

**⚠️ 多段招的伤害是【二维数组】，而且平铺会静默算错**
- `@smogon/calc` 0.12 对多段招返回的**外层是【第几下】**、内层是这一下的 16 档乱数。
  实测：种子机关枪 3×16、三旋击 3×16（每下递增 20-24 / 39-46 / 57-68）、鼠数儿 10×16。
  **总伤害 = 各下逐档相加**（三旋击 116-138 正好是 desc 里的总区间）。
- 直接 `Math.max(...r.damage)` → **NaN**。
- ⚠️ **更阴的是 `.flat()`：不报错，但语义是错的** —— 给你的是【单下】的区间，
  不是总伤害。种子机关枪会被报成 56-68，而真实总伤害是 **168-204**（差 3 倍）。
  `tools/pkmn.mjs` 和 `mcp/pokemon-server.mjs` 里都真出现过（报 NaN），
  `brain/harness.mjs` 里是 `.flat()` 版本（数字偏小、几确全错）。
- 统一用 `lib.mjs` 导出的这个（**返回 total 和 perHit 两个口径，用的人自己选，别猜**）：

  ```js
  import { damageRolls } from './lib.mjs';
  const { total, perHit, multiHit, hits } = damageRolls(res);
  // total = 合计（判几确、判能不能秒，用这个）
  // perHit = 单下（只在需要说「每下打多少」时用）
  ```
- **多段招的伤害本质是多解 —— 文案必须写「按 N 下算的合计；命中数可变时是估算」，不能当准数。**

**⚠️ 速度：`Pokemon.stats.spe` 不含道具 / 特性 / 能力等级 / 异常状态（实测）**
- 讲究围巾、速度 +2、麻痹 —— **三者都不改变 `stats.spe`**；0.12 也**没有导出 `getFinalSpeed`**。
- 所以必须走 `lib.mjs` 的 `finalSpeed(pokemon, opts)`；它自己读 `pokemon.item` / `pokemon.ability`，
  再叠加 `opts`（`weather` / `tailwind` / `para` / `boost` / `booster`）。
- 踩过的坑：队文件里明明写着 `@ Choice Scarf`，`speed` 却按 309 报，
  还回了句「Iron Valiant 更快」—— **围巾土地云其实是 463，它更快**。数字就在手里却没用。
- 自检：`node tools/_verify-core.mjs`（多段招对拍 desc + 速度修正 + 古代活性倍率，32 项断言，不联网）。

**⚠️ 慢的不是文字，是往返**（与 toolkit 无直接关系，但影响所有「帮我看一眼」的请求）
- 实测每回合固定消耗 15–20 秒往返。**做对战辅助时，一次给决策树，不要一回合给一手。**

**引擎 / API**
- `switch N` 和 `move N` 里的 N 是**队伍槽位**，不是场上位置。
- **网络请求必须带 `AbortController` 超时**：无超时的 fetch 挂起会拖死整个进程。
- `@smogon/calc` 的 KO 方法是**小写** `res.kochance()`，不是 `koChance()`。
- `@pkmn/sim` 的 `Teams` **没有** `parse`，但有 `import`（只吃英文）。
  本仓库用自己的解析器以支持中文，见 `tools/lib.mjs`。
- `Battle` 在 `setPlayer` 第二方后**自动 start**，再调 `start()` 会抛错。
- 出招**一律用 `battle.makeChoices()`**（引擎自带随机 AI），不要自己拼 choice 字符串。

**双打专属**
- **单体招式必须带目标**：`move 1 1`（打对方 1 号位）。扩散/自身招式**不能**带目标。
- `battle.choose()` 失败时**返回 false 而不抛异常** —— 不检查返回值会静默空转成死循环。
- 扩散招式在双打是 **0.75 倍**，`calc` 要加 `--doubles`。

**格式**
- `gen9ou` 是 Lv100 格式，Lv50 队伍校验会报错；VGC 队伍用 `gen9vgc2025regi` / `gen9vgc2024regg`，且**至少 4 只**。
- 可用格式用 `node tools/pkmn.mjs formats` 确认；格式 id 写错不如不写。

**中文**
- 两源译名可能不同（PS 用 `归天之翼`、PokeAPI 用 `死亡之翼`），**都保留、都能查**；新增俗称写进 `data/zh-aliases.json`。
- PS 主源键是 Showdown ID，形态名带后缀（`谢米・陆上`）；查基础形态用不带后缀的名字。
- 未收录的名字会原样透传导致查不到 —— 查不到时先怀疑是俗称/新旧译法问题，而不是数据缺失。
