# 宝可梦外置大脑（Jev）

打 Pokémon Showdown 天梯时的**实时决策辅助**：Tampermonkey 脚本读对战页 → 本地服务解析局面 →
调 [Jev](https://typesafe.ai)（专做模糊判断的小模型，单次约 0.4–1.0 秒）→ 面板在页面左下角显示
「这回合点啥 / 换谁 / 用不用太晶」。

**分工是刻意的**：代码只负责**算事实**（伤害、几确、免疫、先后手、太晶收益、钉子价值），
Jev 只负责**做选择**（该攻击还是该强化、对手会不会换人）。算得清的不交给模型，算不清的才交给它。

> 克隆下来就能跑 —— 需要的数据、中文名表、队伍解析都已经在 `toolkit/` 里跟着一起来了。

---

## 三步开始

```bash
git clone https://github.com/silicon-sbt/pkmn-brain.git
cd pkmn-brain
npm install
```

1. 把 `config.example.json` 复制成 **`config.json`**，填上 `jev.apiKey`
   （去 <https://console.typesafe.ai/keys> 领；不想用官方也可以改走 Cloudflare 路线）
2. 双击 **`启动外接大脑.bat`**（Windows）/ `node start.mjs`
3. 浏览器访问 <http://127.0.0.1:7777/pkmn-brain.user.js> —— Tampermonkey 会自己弹出安装提示

完事。打开 Showdown 打一局，面板自己会出现。

> 不填密钥也能起服务，只是面板不会给建议 —— 它会明确告诉你缺什么，不会装作没事。

---

## 它长什么样

面板是纯文字、无背景、无 emoji，钉在对战页左下角那块空白，`pointer-events: none` 不挡操作：

```
T5 · 厄鬼椪 84%  vs  钢铠鸦 100% · 512ms
点 棘藤棒
需 3 回合 · 保留太晶（这次不值得用）
剑舞 10%   拍落 4%   木角 2%
队伍: 正在用的队（request.side.pokemon，6 只由实时数值反解）
```

每次决策的**完整面板原文**都会落盘到 `logs/`，事后可以直接和 Showdown 的日志逐行对照 ——
「它当时为什么建议这个」只有原文能回答。

```bash
node logview.mjs              # 列出打过的对局
node logview.mjs <key>        # 每次决策一节：局面 → Showdown 实际发生 → 面板原文 → 模型回答
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

配置写错不会静默兜底 —— 未知键、类型不对、数值越界都会打到控制台。`node _verify-config.mjs` 有自检。

---

## 文件

| 文件 | 作用 |
|---|---|
| `serve.mjs` | 本地 HTTP 服务（127.0.0.1:7777）+ 唯一的决策调度入口 |
| `harness.mjs` | **事实层**：伤害 / 几确 / 免疫 / 先后手 / 太晶 / 强化 / 换人，组装给 Jev 的问题 |
| `log2state.mjs` | Showdown 原始日志 → 结构化局面 |
| `jev.mjs` | Jev 客户端（网络重试 + DoH 兜底） |
| `dnsfix.mjs` | DNS 污染绕行（DoH 查真 IP + 直连） |
| `config.mjs` | 统一配置加载与校验 |
| `decide-log.mjs` / `logview.mjs` | 决策日志落盘 / 查看器 |
| `pkmn-brain.user.js` | Tampermonkey 面板 |
| `start.mjs` / `启动外接大脑.bat` | 启动器（中文只写在 `.mjs` 里，见下） |
| `toolkit/` | **内联的离线工具与数据**：中文名表、队伍解析、伤害库、meta 配置、AI 技能 |
| `sync-toolkit.mjs` | 把 `toolkit/` 刷成上游最新（见文末） |
| `regress.mjs` / `verify_firsthit.mjs` / `_verify-*.mjs` | 自检与回归 |

### 自检

```bash
node regress.mjs              # 端到端回归（真引擎 + 真 Jev，跑四条阶段）
node verify_firsthit.mjs      # 结实 / 气势披带 / 多重鳞片 / 多段招
node _verify-speed.mjs        # 先后手
node _verify-hazard.mjs       # 钉子价值 / 换人代价判读
node _verify-oppboost.mjs     # 对手能力等级 / 换场清零
node _verify-deadmove.mjs     # 被锁在一招无效的招式上时只给换人
node _verify-config.mjs       # 配置优先级与报错可见
node _verify-decidelog.mjs    # 决策日志端到端
node _verify-dmg.mjs          # 伤害对拍（calc 预测 vs 引擎实跑）
```

除 `regress.mjs` 外都不需要联网。自检用的队伍有内置样板，**没有队伍文件也能直接跑**。

---

## 已知限制（诚实的）

- **对手配置是推测**：没见过的宝可梦用 Smogon 使用率最常见配置兜底，不是真配置。面板上会标「按使用率配置估」。
- **速度只能估**：`@smogon/calc` 0.12 不含道具/特性/能力等级，得自己补；补不齐的会写进口径。
- **驱动能量 / 古代活性 / 夸克充能的【攻击】加成**（×1.3）目前没进伤害计算 —— 速度那一档处理了，攻击档还没有。
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
node sync-toolkit.mjs --check   # 只看差多少（不动文件）
node sync-toolkit.mjs           # 刷成上游最新，然后 git commit
```

**只想要离线工具、不想要对战辅助？** 那就直接去 **[silicon-sbt/pkmn-toolkit](https://github.com/silicon-sbt/pkmn-toolkit)** ——
那个仓库是自包含的，克隆下来 `npm install` 就能用，不需要这个仓库。
