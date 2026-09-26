// 配置自检：优先级、默认值、报错可见。
//
//   node _verify-config.mjs
//
// 不联网、不调任何模型。全部用临时文件测，测完还原。
import { readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const DIR = 'E:\\宝可梦\\brain\\';
const P = DIR + 'config.json';
const BAK = DIR + 'config.json.verifybak';
let bad = 0;
const check = (n, ok, extra) => { if (!ok) bad++; console.log((ok ? '  OK   ' : '  FAIL ') + n + (extra ? '   ' + extra : '')); };

// 用一个子进程读配置并回吐结论，避免 import 缓存
const probe = () => {
  // ⚠️ Windows 上动态 import 必须给 file:// 或相对路径；绝对路径 'E:/…' 会报 ERR_UNSUPPORTED_ESM_URL_SCHEME。
  const code = 'import("./config.mjs").then(m => console.log(JSON.stringify({ cfg: m.cfg, errors: m.configErrors(), present: m.configPresent() })))';
  return JSON.parse(execFileSync(process.execPath, ['-e', code], { cwd: DIR, encoding: 'utf8', timeout: 60000 }));
};

const hadCfg = existsSync(P);
if (hadCfg) copyFileSync(P, BAK);

try {
  // ① 没有配置文件 → 全套默认值，且要明说
  if (existsSync(P)) rmSync(P);
  let r = probe();
  check('没有 config.json 时用默认值', r.cfg.server.port === 7777 && r.cfg.team.default === 'teams/ou-a.txt');
  check('明确报告「没有配置文件」', r.present === false);

  // ② 正常配置 → 生效
  writeFileSync(P, JSON.stringify({ jev: { apiKey: 'TESTKEY', model: 'm1' }, server: { port: 7890 }, team: { default: 'teams/ou-c.txt' }, logging: { enabled: false } }, null, 2), 'utf8');
  r = probe();
  check('config.json 的 server.port 生效', r.cfg.server.port === 7890);
  check('config.json 的 team.default 生效', r.cfg.team.default === 'teams/ou-c.txt');
  check('config.json 的 logging.enabled 生效', r.cfg.logging.enabled === false);
  check('config.json 的 jev.apiKey 生效', r.cfg.jev.apiKey === 'TESTKEY');
  check('未填的项回落到默认值', r.cfg.server.rateMaxPerMinute === 40 && r.cfg.jev.retries === 3);

  // ③ 未知键 / 类型错 / 数值越界 → 必须【报出来】且不崩
  writeFileSync(P, JSON.stringify({ server: { port: 99999 }, jev: { retries: 'abc' }, 打错的名字: 1 }, null, 2), 'utf8');
  r = probe();
  check('越界的 port 被拒并退回默认值', r.cfg.server.port === 7777);
  check('类型错的 retries 被拒并退回默认值', r.cfg.jev.retries === 3);
  check('未知键被点名报出来', r.errors.some(e => /不是认识的配置项/.test(e)), String(r.errors.length) + ' 条');
  check('越界也被点名', r.errors.some(e => /超出允许范围/.test(e)));

  // ④ JSON 语法坏 → 大声报错 + 整套默认值
  writeFileSync(P, '{ 这不是 json', 'utf8');
  r = probe();
  check('坏 JSON 被报出来', r.errors.some(e => /解析失败/.test(e)));
  check('坏 JSON 时仍然能跑（用默认值）', r.cfg.server.port === 7777);
} finally {
  if (hadCfg) { copyFileSync(BAK, P); rmSync(BAK); console.log('已还原 config.json'); }
  else if (existsSync(P)) { rmSync(P); console.log('已删除测试用的 config.json'); }
}

console.log(bad ? ('\n❌ ' + bad + ' 项失败') : '\n✅ 全部通过');
process.exit(bad ? 1 : 0);