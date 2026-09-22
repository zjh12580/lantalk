#!/usr/bin/env node
/**
 * 校验 cloud/index.html 的内联 <script> 能否通过 ESLint。
 *
 * 为什么需要它：ESLint 不能直接解析 .html，而项目主体就是这个单文件。
 * 做法是把每段内联脚本临时落到 .inline.js 再交给 ESLint，
 * 这样既能抓到 no-undef / no-unused-vars，又不用把 HTML 拆开。
 *
 * 用法：node scripts/lint-html.mjs [file]
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(ROOT, process.argv[2] || 'cloud/index.html');

if (!existsSync(target)) {
  console.error(`✗ 找不到文件：${target}`);
  process.exit(1);
}

const html = readFileSync(target, 'utf8');
const re = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g;

const pieces = [];
let m;
while ((m = re.exec(html))) {
  const code = m[1];
  const before = html.slice(0, m.index);
  const line = before.split('\n').length;      // 内联脚本首行在 HTML 里的行号
  if (code.trim().length < 200) continue;      // 跳过小片段（如主题预设）
  pieces.push({ code, line });
}

if (!pieces.length) {
  console.log('没有找到需要校验的内联脚本');
  process.exit(0);
}

const tmp = join(tmpdir(), 'lantalk-lint-' + Date.now());
mkdirSync(tmp, { recursive: true });

// 每段脚本前面补足空行，让 ESLint 报出的行号能对上 HTML 原文件
const files = pieces.map((p, i) => {
  const pad = '\n'.repeat(Math.max(0, p.line - 1));
  const f = join(tmp, `inline-${i}.inline.js`);
  writeFileSync(f, pad + p.code);
  return f;
});

let failed = false;
try {
  execFileSync('npx', ['eslint', ...files, '--no-eslintrc', '--resolve-plugins-relative-to', ROOT,
    '--config', join(ROOT, '.eslintrc.cjs')], { cwd: ROOT, stdio: 'inherit' });
} catch (e) {
  failed = true;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ESLint 输出的行号是临时文件的，这里提示换算关系
if (failed) {
  console.error('\n提示：上面报的行号对应 cloud/index.html 中的实际行号（已补空行对齐）。');
  process.exit(1);
}
console.log(`✓ ${files.length} 段内联脚本通过 ESLint 校验`);
