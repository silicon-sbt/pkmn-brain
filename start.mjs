#!/usr/bin/env node
// 启动器：检查环境 → 打印中文界面 → 起服务
// 中文不写在 .bat 里：cmd 按 GBK 解析整个 .bat，UTF-8 中文会变乱码并破坏命令解析（实测）。
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { cfg, announceConfig, configPresent } from './config.mjs';
import { jevAvailable, jevRoute, credentialSource } from './jev.mjs';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.JEV_PORT || cfg.server.port);
const line = (s = '') => console.log(s);
const die = (msgs) => { for (const m of msgs) line(m); line(); process.exit(1); };

line();
line('  ============================================');
line('     宝可梦外接大脑  -  Jev 决策服务');
line('  ============================================');
line();

// ── ① 另一半在不在 ────────────────────────────────────────
// 本仓库【不是自包含的】：中文名、队伍解析、data/、teams/ 全在 pkmn-toolkit。
// 两个仓库必须克隆成【同级目录】（代码里的相对路径就是按这个写的）。
// 缺了就必须【当场报错】，否则会在解析队伍时炸在很深的地方，看不出原因。
const TK = fileURLToPath(new URL('../toolkit/', import.meta.url));
if (!existsSync(TK + 'tools/lib.mjs')) {
  die([
    '  [错误] 找不到另一半：' + TK,
    '         本仓库依赖 pkmn-toolkit（数据、中文名、队伍解析都在那边）。',
    '         请把它克隆成【同级目录】：',
    '           某个目录/',
    '             ├── pkmn-brain/      ← 本仓库',
    '             └── pkmn-toolkit/    ← https://github.com/silicon-sbt/pkmn-toolkit',
  ]);
}
line('  [检查] 另一半 toolkit 找到了');

// ── ② 凭据 ───────────────────────────────────────────────
// 密钥可能在 config.json、也可能在 .env 或环境变量里 —— 不再只看 .env（那是旧的唯一来源）。
announceConfig();
if (!jevAvailable()) {
  die([
    '  [错误] 没有可用的 Jev 凭据。三种填法任选一种：',
    '         1) brain/config.json 的 jev.apiKey        （推荐，见 config.example.json）',
    '         2) brain/.env 里的 TYPESAFE_API_KEY       （照 .env.example 复制）',
    '         3) 环境变量 TYPESAFE_API_KEY',
    '         走 Cloudflare 路线则填 cfAccountId + cfApiToken。',
    configPresent() ? '' : '         （另外：还没有 brain/config.json）',
  ].filter(Boolean));
}
line('  [检查] 凭据 OK  (' + (jevRoute() === 'typesafe' ? 'TypeSafe 官方' : 'Cloudflare') +
  '，来自 ' + credentialSource() + ')');

// ── ③ 端口 ───────────────────────────────────────────────
const busy = await new Promise((resolve) => {
  const s = createServer();
  s.once('error', () => resolve(true));
  s.once('listening', () => s.close(() => resolve(false)));
  s.listen(PORT, '127.0.0.1');
});
if (busy) {
  line('  [提示] 端口 ' + PORT + ' 已被占用 —— 服务可能已经在运行了。');
  line('         本窗口直接退出，不影响已在跑的服务。');
  line();
  process.exit(0);
}
line('  [检查] 端口 ' + PORT + ' 可用');
line();
line('  [启动] 决策服务中…… 关掉本窗口即停止');
line();
// 不用框线：中文在终端是双宽，padEnd 按字符数补空格必然对不齐（实测歪掉）
line('   · 对战页下方会自动显示决策建议');
line('   · 没显示？确认 Tampermonkey 脚本已装好');
line('   · Alt+J 可隐藏 / 再按一次恢复');
line();

// ★ 必须显式调用 startService()，光 import 不会启动 ——
//   serve.mjs 的入口守卫在 import 时判定为「不是直接运行」（实测踩过）
const { startService } = await import('./serve.mjs');
startService();
