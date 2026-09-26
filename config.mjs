// 外置大脑的统一配置。
//
// 优先级（从高到低）：**环境变量 → brain/config.json → brain/.env → 内置默认值**。
//   - 环境变量最高：方便临时覆盖 / CI，不用改文件。
//   - config.json 比 .env 高：密钥搬进 config.json 之后，旧的 .env 不该再把它盖掉。
//
// 为什么要有 config.json：密钥 + 端口 + 兜底队伍 + 日志开关放一处，一目了然，
// 散在环境变量里没法一眼看全。密钥可以放这里，因为 **config.json 已 gitignore**；
// 仓库里提交的是 config.example.json（模板）。
//
// ⚠️ 配置读坏了必须【大声报出来】再退回默认值 —— 静默兜底是本项目踩得最多的坑。
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const BRAIN_DIR = fileURLToPath(new URL('.', import.meta.url));
export const CONFIG_PATH = BRAIN_DIR + 'config.json';
export const EXAMPLE_PATH = BRAIN_DIR + 'config.example.json';

export const DEFAULTS = {
  jev: { apiKey: '', cfAccountId: '', cfApiToken: '', model: 'jev-latest', timeoutMs: 30000, retries: 3 },
  server: { port: 7777, rateMaxPerMinute: 40 },
  team: { default: 'teams/ou-a.txt' },
  logging: { enabled: true },
};

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function merge(base, over, path, errors) {
  const out = clone(base);
  if (over == null) return out;
  if (typeof over !== 'object' || Array.isArray(over)) {
    errors.push(path + ' 应该是一个对象，实际是 ' + (Array.isArray(over) ? '数组' : typeof over) + ' —— 这一段已用默认值');
    return out;
  }
  for (const k of Object.keys(over)) {
    if (k.startsWith('_')) continue;   // _注释 之类的说明字段，允许写
    if (!(k in out)) { errors.push(path + '.' + k + ' 不是认识的配置项（已忽略，请对照 config.example.json）'); continue; }
    if (out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = merge(out[k], over[k], path + '.' + k, errors);
    } else {
      if (typeof out[k] !== typeof over[k] && out[k] !== null) {
        errors.push(path + '.' + k + ' 类型不对（期望 ' + typeof out[k] + '，实际 ' + typeof over[k] + '）—— 已忽略');
        continue;
      }
      out[k] = over[k];
    }
  }
  return out;
}

const errors = [];
let cfg = clone(DEFAULTS);
let present = existsSync(CONFIG_PATH);
if (present) {
  try {
    cfg = merge(DEFAULTS, JSON.parse(readFileSync(CONFIG_PATH, 'utf8')), 'config', errors);
  } catch (e) {
    errors.push('config.json 解析失败：' + ((e && e.message) || e) + ' —— 已整套退回默认值');
  }
}

// 数值项做一次范围检查（写错单位的人比写错类型的人多）
const num = (v, name, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) {
    errors.push('config.' + name + ' = ' + JSON.stringify(v) + ' 超出允许范围 [' + lo + ', ' + hi + '] —— 已用默认值');
    return null;
  }
  return n;
};
for (const [k, lo, hi, def] of [
  ['server.port', 1, 65535, DEFAULTS.server.port],
  ['server.rateMaxPerMinute', 1, 10000, DEFAULTS.server.rateMaxPerMinute],
  ['jev.timeoutMs', 1000, 300000, DEFAULTS.jev.timeoutMs],
  ['jev.retries', 0, 10, DEFAULTS.jev.retries],
]) {
  const [a, b] = k.split('.');
  const n = num(cfg[a][b], k, lo, hi);
  if (n == null) cfg[a][b] = def; else cfg[a][b] = n;
}

export function configErrors() { return errors.slice(); }
export function configPresent() { return present; }
export function reloadConfig() { return cfg; }
export { cfg };

// 启动时把配置问题直接打出来（各入口都调一次；重复无害）
let announced = false;
export function announceConfig() {
  if (announced) return;
  announced = true;
  if (!present) {
    console.log('[配置] 没有 brain/config.json —— 全部用默认值（照 config.example.json 复制一份即可）');
  } else {
    console.log('[配置] 已加载 brain/config.json');
  }
  for (const e of errors) console.log('[配置] ⚠️ ' + e);
}
