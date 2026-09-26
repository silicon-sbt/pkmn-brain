#!/usr/bin/env node
// 把 ./toolkit/ 刷成上游 pkmn-toolkit 的最新版本。
//
//   node sync-toolkit.mjs               # 优先用同级的 ../toolkit（你自己的开发副本），没有就去 GitHub 拉
//   node sync-toolkit.mjs --from <dir>  # 指定一个本地 pkmn-toolkit 仓库
//   node sync-toolkit.mjs --check       # 只看差多少，不改文件
//
// 为什么需要它：./toolkit/ 是【内联进来的一份副本】，本仓库因此自包含、克隆下来就能跑。
// 代价是两边会漂移 —— 所以改了上游之后记得跑一次这个，它会打印两边的 commit 让你看清差在哪。
import { existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DEST = HERE + 'toolkit';
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? (process.argv[i + 1] ?? true) : d; };
const CHECK = process.argv.includes('--check');
const UPSTREAM = 'https://github.com/silicon-sbt/pkmn-toolkit.git';

const line = (s = '') => console.log(s);
const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8' });

// 找源：显式指定 > 同级 ../toolkit > 临时克隆上游
let SRC = arg('--from', null) || (existsSync(HERE + '../toolkit/.git') ? HERE + '../toolkit' : null);
let tmpClone = null;
if (!SRC) {
  tmpClone = HERE + '.toolkit-upstream';
  line('未找到本地 pkmn-toolkit，从上游临时克隆……');
  if (existsSync(tmpClone)) rmSync(tmpClone, { recursive: true, force: true });
  const r = spawnSync('git', ['clone', '--depth', '1', UPSTREAM, tmpClone], { stdio: 'inherit' });
  if (r.status !== 0) { line('❌ 克隆失败（网络/代理）——也可以 --from 指定本地副本'); process.exit(1); }
  SRC = tmpClone;
}

const srcHead = (git(['rev-parse', '--short', 'HEAD'], SRC).stdout || '').trim();
const srcFiles = (git(['ls-files'], SRC).stdout || '').split(/\r?\n/).filter(Boolean);
line('源：' + SRC);
line('    commit ' + srcHead + '   跟踪文件 ' + srcFiles.length + ' 个');

if (CHECK) {
  let same = 0, diff = 0, missing = 0;
  for (const f of srcFiles) {
    const d = DEST + '/' + f;
    if (!existsSync(d)) { missing++; continue; }
    const a = (git(['hash-object', '--', f], SRC).stdout || '').trim();
    const b = (git(['hash-object', '--', f], DEST).stdout || '').trim();
    if (a && a === b) same++; else diff++;
  }
  line('');
  line('  相同 ' + same + '   不同 ' + diff + '   缺失 ' + missing);
  line(diff + missing ? '  ⚠️ 需要同步：node sync-toolkit.mjs' : '  ✅ 已经是最新');
  if (tmpClone) rmSync(tmpClone, { recursive: true, force: true });
  process.exit(0);
}

// 用 git archive 导出【已跟踪的文件】—— 队伍文件等本机私有内容本来就不在版本控制里，自然不会被带过来
if (existsSync(DEST)) rmSync(DEST, { recursive: true, force: true });
const tar = HERE + '.toolkit-sync.tar';
if (git(['archive', '--format=tar', '-o', tar, 'HEAD'], SRC).status !== 0) { line('❌ git archive 失败'); process.exit(1); }
spawnSync('mkdir', [DEST], { shell: true });
const x = spawnSync('tar', ['-xf', tar, '-C', DEST], { stdio: 'inherit' });
rmSync(tar, { force: true });
if (tmpClone) rmSync(tmpClone, { recursive: true, force: true });
if (x.status !== 0) { line('❌ 解包失败'); process.exit(1); }

const n = readdirSync(DEST).length;
line('');
line('✅ ./toolkit/ 已同步到 ' + srcHead + '（顶层 ' + n + ' 项）');
line('   别忘了 git add toolkit && git commit —— 这份副本是【要提交的】。');
