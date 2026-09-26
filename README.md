# 宝可梦外置大脑（Jev）

打 Pokémon Showdown 天梯时的**实时决策辅助**：Tampermonkey 脚本读对战页 → 本地服务解析局面 →
调 [Jev](https://typesafe.ai)（专做模糊判断的小模型，单次约 0.4–1.0 秒）→ 面板在页面左下角显示
「这回合点啥 / 换谁 / 用不用太晶」。

**分工是刻意的**：代码只负责**算事实**（伤害、几确、免疫、先后手、太晶收益、钉子价值），
Jev 只负责**做选择**（该攻击还是该强化、对手会不会换人）。算得清的不交给模型，算不清的才交给它。

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

每次决策的**完整面板原文**都会落盘（`logs/`），事后可以直接和 Showdown 的日志逐行对照 ——
「它当时为什么建议这个」只有原文能回答。

---

## 它依赖 `pkmn-toolkit`（重要）

这个仓库**不是自包含的**。数据和工具在另一半：

> **https://github.com/silicon-sbt/pkmn-toolkit**

两个仓库**必须克隆成同级目录**（代码里的相对路径就是按这个写的）：

```
某个目录/
  ├── pkmn-brain/      ← 本仓库
  └── pkmn-toolkit/    ← 另一半（提供中文名、队伍解析、data/、teams/）
```

依赖方向是**单向**的：`brain → toolkit`。toolkit 里不会 import brain。

---

## 快速开始

1. **准备两个仓库**（同级目录，见上）
2. **填凭据**：把 `config.example.json` 复制成 `config.json`，填 `jev.apiKey`
   （或 `cfAccountId` + `cfApiToken` 走 Cloudflare 路线）。`config.json` 已 gitignore。
3. **起服务**：双击 `启动外接大脑.bat`（Windows）/ `node start.mjs`
4. **装面板**：浏览器访问 `http://127.0.0.1:7777/pkmn-brain.user.js`，Tampermonkey 会自动提示安装
5. 打开 Showdown 打一局，面板自己会出现

改代码之后：**改了服务端要重启 bat，改了 `.user.js` 要重装脚本。只做一半 = 表现成「改了没生效」。**

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

配置写错不会静默兜底 —— 未知键、类型不对、数值越界都会打到控制台（`node _verify-config.mjs` 有自检）。

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
| `regress.mjs` / `verify_firsthit.mjs` / `_verify-*.mjs` | 各种自检与回归 |

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
```

除 `regress.mjs` 外都不需要联网；`_verify-*.mjs` 用手写局面，结果确定。

---

## 已知限制（诚实的）

- **对手配置是推测**：没见过的宝可梦用 Smackdown 使用率最常见配置兜底，不是真配置。
  面板上会标「按使用率配置估」。
- **速度只能估**：`@smogon/calc` 0.12 不含道具/特性/能力等级，得自己补；补不齐的会写进口径。
- **驱动能量 / 古代活性 / 夸克充能的【攻击】加成**（×1.3）目前没进伤害计算 ——
  速度那一档处理了，攻击档还没有。
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

这是**辅助你在客户端手动出招**的面板，不代替你点击，也不自动打天梯。
请遵守 Pokémon Showdown 的服务条款。
