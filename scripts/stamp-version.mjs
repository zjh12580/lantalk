#!/usr/bin/env node
/**
 * 把当前 git 提交写入版本常量（以 git 提交号作为版本标识）。
 *
 * 用法：node scripts/stamp-version.mjs   /   npm run stamp
 *
 * 写入位置（行尾带 // LT_BUILD 标记，脚本按标记整行替换）：
 *   - cloud/index.html  页面脚本里的 var BUILD
 *   - LanTalk.html      页面脚本里的 var BUILD
 * 提示：LanTalk.html 页面区被包在 node 块注释里，因此提交标题中的 "*\/" 会被打散，避免提前闭合注释。
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['cloud/index.html', 'LanTalk.html'];
const MARK = /^.*\/\/ LT_BUILD\s*$/m;

const raw = execSync('git log -1 --format=%h%x1f%ad%x1f%s --date=short', { cwd: ROOT })
  .toString()
  .trim();
const [sha, date, subject] = raw.split('\x1f');

// 单引号/反斜杠转义 + 折行合并 + 打散 */（保护 LanTalk.html 的块注释）
const esc = (s) =>
  String(s || '')
    .replace(/\*\//g, '* /')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");

const line =
  `var BUILD = { sha: '${esc(sha)}', date: '${esc(date)}', subject: '${esc(subject)}' }; // LT_BUILD`;

let updated = 0;
for (const rel of FILES) {
  const file = resolve(ROOT, rel);
  const src = readFileSync(file, 'utf8');
  if (!MARK.test(src)) {
    console.error(`✗ ${rel}: 未找到版本标记行（// LT_BUILD）`);
    process.exitCode = 1;
    continue;
  }
  const out = src.replace(MARK, () => line);
  if (out === src) {
    console.log(`= ${rel} 已是 ${sha}`);
  } else {
    writeFileSync(file, out);
    updated++;
    console.log(`✓ ${rel} → ${sha} · ${date}`);
  }
}
console.log(`完成：${updated} 个文件更新，版本 ${sha} (${date})`);
