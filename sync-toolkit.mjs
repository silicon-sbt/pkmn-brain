#!/usr/bin/env node
// 把 ./toolkit/ 刷成上游 pkmn-toolkit 的最新版本。
//
//   node sync-toolkit.mjs               # 优先用同级的 ../toolkit（你自己的开发副本），没有就去 GitHub 拉
//   node sync-toolkit.mjs --from <dir>  # 指定一个本地 pkmn-toolkit 仓库
//   node sync-toolkit.mjs --check       # 只看差多少，不改文件
//
// 为什么需要它：./toolkit/ 是【内联进来的一份副本】，本仓库因此自包含、克隆下来就能跑。
// 代价是两边会漂移 —— 所以改了上游之后记得跑一次这个，它会打印源 commit 让你看清差在哪。
//
// 注：Windows 上 tar 解出来的文件是 CRLF、仓库里存的是 LF —— 提交时 git 会自己规范化，
// 所以 --check 比的是【统一行尾后的内容】而不是原始字节（否则会把 40 个文件全报成不同）。
import { existsSync, rmSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
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
  // ⚠️ 比的是【内容】而不是工作区字节：Windows 上 tar 解出来是 CRLF、仓库里存的是 LF，
  //   拿原始字节比会把 40 个文件全报成「不同」（实测踩过）。所以先统一行尾再比。
  const norm = (p) => { try { return readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); } catch (e) { return null; } };
  let same = 0, missing = 0;
  const diffFiles = [];
  for (const f of srcFiles) {
    const a = norm(SRC + '/' + f);
    const b = norm(DEST + '/' + f);
    if (b === null) { missing++; continue; }
    if (a === b) same++; else diffFiles.push(f);
  }
  line('');
  line('  相同 ' + same + '   不同 ' + diffFiles.length + '   缺失 ' + missing);
  for (const f of diffFiles.slice(0, 10)) line('    · ' + f);
  if (diffFiles.length > 10) line('    …还有 ' + (diffFiles.length - 10) + ' 个');
  line(diffFiles.length + missing ? '  ⚠️ 需要同步：node sync-toolkit.mjs' : '  ✅ 已经是最新');
  if (tmpClone) rmSync(tmpClone, { recursive: true, force: true });
  process.exit(0);
}

// 用 git archive 导出【已跟踪的文件】—— 队伍文件等本机私有内容本来就不在版本控制里，自然不会被带过来
if (existsSync(DEST)) rmSync(DEST, { recursive: true, force: true });
const tar = HERE + '.toolkit-sync.tar';
if (git(['archive', '--format=tar', '-o', tar, 'HEAD'], SRC).status !== 0) { line('❌ git archive 失败'); process.exit(1); }
mkdirSync(DEST, { recursive: true });   // 用 spawnSync('mkdir',{shell:true}) 会有 DeprecationWarning
const x = spawnSync('tar', ['-xf', tar, '-C', DEST], { stdio: 'inherit' });
rmSync(tar, { force: true });
if (tmpClone) rmSync(tmpClone, { recursive: true, force: true });
if (x.status !== 0) { line('❌ 解包失败'); process.exit(1); }

const n = readdirSync(DEST).length;
line('');
line('✅ ./toolkit/ 已同步到 ' + srcHead + '（顶层 ' + n + ' 项）');
line('   别忘了 git add toolkit && git commit —— 这份副本是【要提交的】。');
