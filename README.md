# pkmn-brain

**打 Pokémon Showdown 天梯时的实时决策面板** —— 对战页左下角直接告诉你「这回合点啥 / 换谁 / 用不用太晶」。

它读对战页 → 本地解析局面 → 调 [Jev](https://typesafe.ai)（专做模糊判断的小模型，一次约 0.4–1.0 秒）→ 显示建议。

> **分工是刻意的**：代码只负责**算事实**（伤害、几确、免疫、先后手、太晶收益、钉子价值），
> Jev 只负责**做选择**（该攻击还是该强化、对手会不会换人）。算得清的不交给模型，算不清的才交给它。

```bash
git clone https://github.com/silicon-sbt/pkmn-brain.git && cd pkmn-brain && npm install
```

需要的数据、中文名表、队伍解析都已经在 `toolkit/` 里跟着来了 —— **克隆一个仓库就能跑**。

---

## 三步开始

1. 把 `config.example.json` 复制成 **`config.json`**，填上 `jev.apiKey`
   （去 <https://console.typesafe.ai/keys> 领；不想用官方也可以改走 Cloudflare 路线）
2. 双击 **`启动外接大脑.bat`**（Windows）/ `node start.mjs`
3. 浏览器访问 <http://127.0.0.1:7777/pkmn-brain.user.js> —— Tampermonkey 会自己弹出安装提示

完事。打开 Showdown 打一局，面板自己会出现。

> 不填密钥也能起服务，只是面板不会给建议 —— 它会明确告诉你缺什么，不会装作没事。

---

## 它长什么样

纯文字、无背景、无 emoji，钉在对战页左下角那块空白，`pointer-events: none` 不挡操作：

```
T5 · 厄鬼椪 84%  vs  钢铠鸦 100% · 512ms
点 棘藤棒
需 3 回合 · 保留太晶（这次不值得用）
剑舞 10%   拍落 4%   木角 2%
队伍: 正在用的队（本地「ou-c」· local-数值核对通过，努力值/性格/个体值精确）
```

- **「点」后面就是要点的那一手**；出现「太晶 + 点 X」= 先点太晶按钮再点 X（两步是分开的）
- 低置信会加前缀**【把握不大】** —— 那一手本来就说不准，别当成确定的建议
- `Alt+J` 隐藏 / 恢复；最后一行是**故意留的诊断行**，出问题直接看它，不用翻黑窗口

### 每次决策都留了底

面板显示的原话会完整落盘到 `logs/`，事后可以和 Showdown 的日志逐行对照 ——
**「它当时为什么建议这个」只有原文能回答**。

```bash
node logview.mjs              # 列出打过的对局
node logview.mjs <key>        # 一次决策一节：局面 → Showdown 实际发生 → 面板原文 → 模型回答
node logview.mjs <key> --turn 7 --brief
```

---

## 配置：`config.json`

模板是 `config.example.json`。**优先级：环境变量 → `config.json` → `.env` → 内置默认值。**

```jsonc
{
  "jev":      { "apiKey": "", "cfAccountId": "", "cfApiToken": "",
                "model": "jev-latest", "timeoutMs": 30000, "retries": 3 },
  "server":   { "port": 7777, "rateMaxPerMinute": 40 },
  "team":     { "default": "teams/ou-a.txt" },
  "logging":  { "enabled": true }
}
```

启动时会打一行告诉你**实际用的哪一份凭据**（密钥对不上时，第一件要确认的就是这个）：

```
[凭据] brain/config.json 的 jev.apiKey
```

配置写错**不会静默兜底** —— 未知键、类型不对、数值越界都会打到控制台。`node _verify-config.mjs` 有自检。

---

## 文件

| 文件 | 作用 |
|---|---|
| `serve.mjs` | 本地 HTTP 服务（127.0.0.1:7777）+ 唯一的决策调度入口 |
| `harness.mjs` | **事实层**：伤害 / 几确 / 免疫 / 先后手 / 太晶 / 强化 / 换人，组装给 Jev 的问题 |
| `log2state.mjs` | Showdown 原始日志 → 结构化局面 |
| `jev.mjs` / `dnsfix.mjs` | Jev 客户端（网络重试 + DoH 兜底）/ DNS 污染绕行 |
| `config.mjs` | 统一配置加载与校验 |
| `decide-log.mjs` / `logview.mjs` | 决策日志落盘 / 查看器 |
| `pkmn-brain.user.js` | Tampermonkey 面板 |
| `start.mjs` / `启动外接大脑.bat` | 启动器（中文只写在 `.mjs` 里，见下） |
| `toolkit/` | **内联的离线工具与数据**（见文末） |
| `sync-toolkit.mjs` | 把 `toolkit/` 刷成上游最新 |
| `_sample-teams.mjs` | 自检用的内置样板队伍 |
| `regress.mjs` / `verify_firsthit.mjs` / `_verify-*.mjs` | 自检与回归 |

### 自检

```bash
npm run verify   # 11 个自检套件，全部不联网、不烧 Jev 额度
npm run regress  # 端到端回归（真引擎 + 真 Jev，跑四条阶段）

# npm run verify 里包含的（按你关心的挑）：
node _verify-team-local.mjs # 队伍是从哪认出来的（唯一解 / 数值消歧 / 孪生队要拒绝 / 道具消耗后仍要认得出）
node _verify-disguise.mjs   # 画皮：从真引擎日志里解出「已经破了」
node _verify-loop.mjs       # 换人循环：往回换会被告知「你上一手刚把它换下去」
node _verify-team-e2e.mjs   # 上面那件事的端到端：真起服务看黑窗口说了什么
node _verify-sub.mjs        # 替身：打不打得动、穿不穿得过去、我方替身挡不挡得住
node _verify-hazard.mjs     # 钉子：带数字 + 撒钉手标签 + 换人判读 + 威胁未知可见
node _verify-setup.mjs      # 强化技文案（「回合打平」要写成【★白赚】）
node _verify-paradox.mjs    # 古代活性/夸克充能的 ×1.3（含真跑引擎对拍）
node _verify-dmg.mjs        # 伤害对拍：calc 的预测 vs 引擎实跑
node _verify-decidelog.mjs  # 决策日志端到端（自己在 7799 起服务，不打扰你在用的 7777）
```

自检用的队伍有内置样板 —— **没有队伍文件也能直接跑**。
`_verify-team-e2e.mjs` 和 `_verify-decidelog.mjs` 会自己起一个临时服务，
**故意不配密钥**，所以一次 Jev 额度都不烧。

---

## 已知限制（诚实的）

- **对手配置是推测**：没见过的宝可梦用 Smogon 使用率最常见配置兜底，不是真配置。面板上会标「按使用率配置估」。
- **速度只能估**：`@smogon/calc` 0.12 不含道具 / 特性 / 能力等级，得自己补；补不齐的会写进口径。
- **古代活性 / 夸克充能（驱动能量）**：`@smogon/calc` 完全不建，面板自己按引擎源码的
  `chainModify([5325,4096])` = ×1.30005 缩放（提的是速度时不加成伤害；对手提了防会除回去）。
  已验证：开关前后正好 ×1.300，且真跑 80 局引擎对拍得到 ×1.301。
- **队伍来自浏览器本地存的队，认不出来才退回反解**：先按「物种 + 特性 + 4 招」在 `PS.teams.list` 里匹配，
  再用对局里的最终数值**核对**（能复现同一组数值才算认对）。认出来时性格 / 努力值 / 个体值**是精确的**。
  认不出来会退回从实时数值反解 —— L100 上反解也精确，但**这只倒下了（`0 fnt`）时 HP 努力值会读成 0**、
  **等级非 100（VGC/Champions）时反解会放弃**。两种情况都会在面板的 `队伍:` 那行写清楚；
  认不出时还会**逐字段打出差在哪一项**。
  ⚠️ 道具**不参与**匹配（驱动能量 / 披带 / 树果会被消耗，也会被拍落、被戏法换走）——
  拿它当条件是错的，会造成「开局认得出、随后整局认不出」。
- **撒钉只算得出「对手每次换人掉多少」**，算不出「逼它不敢随便换人」那一层战略价值。
- **替身只能说到「上限」**：Showdown 的日志**不公开替身剩余血量**，所以面板只能说
  「替身最多还能吸收 25% 最大血」，说不清它现在还剩多少。
- **撒钉 / 除钉只在有钉子招时才算得出来**：每个先发选项和换人选项都会贴
  「★ 它能【撒钉子】：<对方每只吃多少>」/「★ 它能【除钉】」/「它【不会撒钉、也不会除钉】」。
  对面的努力值/道具仍是推测配置，所以「吃到多少」跟着一起是估的。
- **只算当前回合的威胁**：后排宝可梦这一回合打不到你，所以不算。
- **会调外部 API**：这不是纯离线工具，需要 Jev 的额度。

---

## 安全

- 服务**只监听 127.0.0.1**，且**不发任何 CORS 头** ⇒ 网页 JS 读不到响应。
- 要求自定义头 `X-Pkmn-Brain: 1` 挡掉跨站表单提交（表单发不出自定义头）。
- 每分钟调用上限（`server.rateMaxPerMinute`）防止脚本失灵烧额度。
- **API 密钥只在服务端**（`config.json` / `.env`，都已 gitignore），**绝不进浏览器**。

---

## 免责

这是**辅助你在客户端手动出招**的面板：它只显示建议，不代替你点击，也不自动打天梯。
请遵守 Pokémon Showdown 的服务条款。

---

## 关于 `toolkit/`：它从哪来、怎么更新

为了让你**克隆一个仓库就能跑**，离线工具与数据（中文名表、队伍解析、伤害库、meta 配置、AI 技能）
已经内联在 `toolkit/` 里 —— 它原本是独立仓库 [**pkmn-toolkit**](https://github.com/silicon-sbt/pkmn-toolkit)。
两边都是 MIT，随你怎么用。

内联的代价是会漂移，所以留了个同步脚本：

```bash
node sync-toolkit.mjs --check   # 只看差多少（逐个比内容，不动文件）
node sync-toolkit.mjs           # 刷成上游最新，然后 git commit
```

**只想要离线工具、不想要对战辅助？** 那就直接去 **[silicon-sbt/pkmn-toolkit](https://github.com/silicon-sbt/pkmn-toolkit)** ——
那个仓库是自包含的，克隆下来 `npm install` 就能用，不需要这个仓库。
