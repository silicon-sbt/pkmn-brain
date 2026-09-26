#!/usr/bin/env node
// 项目级离线 RAG 索引 —— 零依赖、纯 Node、不联网、不调模型。
//
// 为什么不用向量检索：
//   1. 本项目全离线。向量要么调 API（破坏原则、还要密钥），要么本地跑 embedding 模型（重）；
//   2. 语料是中文+英文混排的技术文档，在这个规模（约 20 万字符）上 BM25 + 中文字符二元组足够好用；
//   3. 索引是确定性构建 —— 同一份语料永远得到同一个索引，可复现、可 diff。
//
// ★ 界限（很重要）：RAG 只索引【散文/知识】，不索引【事实数据】。
//   种族值/伤害/招式一律走 tools/pkmn.mjs 精确查询，绝不许从检索结果里读数字 ——
//   这条是项目核心原则，RAG 不能成为绕过它的后门。
//   所以 data/zh-ps.json、data/meta-sets.json 这类精确数据表【刻意不索引】。
//
// 用法：
//   node tools/rag.mjs build                    # 重建 data/rag-index.json
//   node tools/rag.mjs query "画皮 先制" -k 5    # 检索
//   node tools/rag.mjs stats                    # 看索引概况
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const INDEX_PATH = join(ROOT, 'data', 'rag-index.json');

// ---------- 收哪些料 ----------
const INCLUDE = [
  /^AGENTS\.md$/,
  /^README\.md$/,
  /^\.dsh[\\/]skills[\\/].*\.md$/,
  /^docs[\\/].*\.md$/,
  /^data[\\/].*\.md$/,
  /^side[\\/].*\.md$/,
  /^teams[\\/].*\.txt$/,
  /^workflows[\\/].*\.(js|md)$/,
  /^mcp[\\/].*\.(mjs|md)$/,
  /^tools[\\/].*\.mjs$/,
];
// ★ 绝不索引 api.md：里面是明文 API key。索引会进 git，等于泄密。
const EXCLUDE = [/^api\.md$/, /^data[\\/]rag-index\.json$/, /node_modules/, /^\.git[\\/]/];

function shouldIndex(rel) {
  if (EXCLUDE.some(re => re.test(rel))) return false;
  return INCLUDE.some(re => re.test(rel));
}

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.isFile()) acc.push(full);
  }
  return acc;
}

// ---------- 分词：拉丁词 + 中文一元/二元 ----------
export function tokenize(text) {
  const s = String(text).toLowerCase();
  const toks = [];
  for (const m of s.matchAll(/[a-z0-9][a-z0-9._@+/-]*/g)) toks.push(m[0]);
  for (const run of s.match(/[\u4e00-\u9fff]+/g) || []) {
    for (let i = 0; i < run.length; i++) {
      toks.push(run[i]);
      if (i + 1 < run.length) toks.push(run.slice(i, i + 2)); // 中文靠二元组
    }
  }
  return toks;
}

// ---------- 切块：先按标题，再按长度 ----------
const MAX_LEN = 900;

function splitLong(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const parts = [];
  let buf = '';
  for (const para of text.split(/\n{2,}/)) {
    if (buf && buf.length + para.length + 2 > maxLen) { parts.push(buf); buf = ''; }
    buf = buf ? buf + '\n\n' + para : para;
  }
  if (buf) parts.push(buf);
  // 单段就超长的，硬切
  const out = [];
  for (const p of parts) {
    if (p.length <= maxLen * 1.5) out.push(p);
    else for (let i = 0; i < p.length; i += maxLen) out.push(p.slice(i, i + maxLen));
  }
  return out;
}

export function chunkMarkdown(text) {
  const lines = text.split(/\r?\n/);
  const chunks = [];
  let headingPath = [];
  let buf = [];
  let bufHeading = '(前言)';

  const flush = () => {
    const body = buf.join('\n').trim();
    if (body) {
      for (const piece of splitLong(body, MAX_LEN)) {
        chunks.push({ heading: bufHeading, text: piece });
      }
    }
    buf = [];
  };

  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      flush();
      const level = m[1].length;
      headingPath = headingPath.slice(0, level - 1);
      headingPath[level - 1] = m[2].trim();
      bufHeading = headingPath.filter(Boolean).join(' > ');
      buf.push(line);
    } else {
      buf.push(line);
    }
  }
  flush();
  return chunks;
}

// ---------- 构建 ----------
export function build() {
  const files = walk(ROOT).map(f => relative(ROOT, f).split(sep).join('/')).filter(shouldIndex).sort();
  const docs = [];
  for (const rel of files) {
    const raw = readFileSync(join(ROOT, rel), 'utf8');
    const isMd = /\.md$/i.test(rel);
    const chunks = isMd ? chunkMarkdown(raw)
      : splitLong(raw, MAX_LEN).map(t => ({ heading: rel, text: t }));
    chunks.forEach((c, i) => {
      docs.push({ id: rel + '#' + i, path: rel, heading: c.heading, text: c.text });
    });
  }
  // 倒排
  const df = Object.create(null);
  const postings = Object.create(null);
  const len = [];
  docs.forEach((d, di) => {
    const tfHere = Object.create(null);
    const toks = tokenize(d.heading + '\n' + d.text);
    len[di] = toks.length;
    for (const t of toks) tfHere[t] = (tfHere[t] || 0) + 1;
    for (const t of Object.keys(tfHere)) {
      (postings[t] || (postings[t] = [])).push([di, tfHere[t]]);
      df[t] = (df[t] || 0) + 1;
    }
  });
  const index = {
    builtAt: new Date().toISOString(),
    version: 1,
    docCount: docs.length,
    avgLen: len.reduce((a, b) => a + b, 0) / Math.max(1, len.length),
    df, postings, len,
    docs: docs.map(d => ({ id: d.id, path: d.path, heading: d.heading, text: d.text })),
  };
  writeFileSync(INDEX_PATH, JSON.stringify(index), 'utf8');
  return { files: files.length, docs: docs.length, terms: Object.keys(df).length };
}

// ---------- BM25 检索 ----------
export function load() { return JSON.parse(readFileSync(INDEX_PATH, 'utf8')); }

export function search(index, query, k = 5) {
  const K1 = 1.2, B = 0.75;
  const N = index.docCount;
  const scores = new Map();
  for (const t of new Set(tokenize(query))) {
    const pl = index.postings[t];
    if (!pl) continue;
    const idf = Math.log(1 + (N - index.df[t] + 0.5) / (index.df[t] + 0.5));
    for (const [di, tf] of pl) {
      const norm = 1 - B + B * (index.len[di] / index.avgLen);
      const s = idf * (tf * (K1 + 1)) / (tf + K1 * norm);
      scores.set(di, (scores.get(di) || 0) + s);
    }
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, k)
    .map(([di, score]) => ({ ...index.docs[di], score: Math.round(score * 100) / 100 }));
}

// ---------- CLI ----------
if (process.argv[1] && process.argv[1].endsWith('rag.mjs')) {
  const cmd = process.argv[2];
  if (cmd === 'build') {
    const r = build();
    console.log('索引已重建: ' + r.files + ' 个文件 / ' + r.docs + ' 个块 / ' + r.terms + ' 个词条');
    console.log('输出: data/rag-index.json');
  } else if (cmd === 'query') {
    const q = process.argv[3];
    const kIdx = process.argv.indexOf('-k');
    const k = kIdx > 0 ? Number(process.argv[kIdx + 1]) : 5;
    if (!q) { console.log('用法: node tools/rag.mjs query "关键词" [-k 5]'); process.exit(1); }
    const idx = load();
    const hits = search(idx, q, k);
    console.log('查询: ' + q + '  (索引 ' + idx.docCount + ' 块)');
    for (const h of hits) {
      console.log('\n--- [' + h.score + '] ' + h.path + '  § ' + h.heading);
      console.log(h.text.split('\n').slice(0, 6).join('\n').slice(0, 420));
    }
  } else if (cmd === 'stats') {
    const idx = load();
    const byPath = {};
    for (const d of idx.docs) byPath[d.path] = (byPath[d.path] || 0) + 1;
    console.log('构建时间: ' + idx.builtAt);
    console.log('块数: ' + idx.docCount + '  |  词条数: ' + Object.keys(idx.df).length + '  |  平均块长: ' + Math.round(idx.avgLen));
    console.log('\n来源:');
    for (const [p, n] of Object.entries(byPath).sort()) console.log('  ' + String(n).padStart(4) + '  ' + p);
  } else {
    console.log('用法:');
    console.log('  node tools/rag.mjs build                   重建索引');
    console.log('  node tools/rag.mjs query "画皮 先制" -k 5    检索');
    console.log('  node tools/rag.mjs stats                   概况');
  }
}
