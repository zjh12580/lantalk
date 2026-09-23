#!/usr/bin/env node
/**
 * 把当前 git 提交写入版本常量（以 git 提交号作为版本标识）。
 *
 * 用法：node scripts/stamp-version.mjs   /   npm run stamp
 *
 * 写入位置（行尾带 // LT_BUILD 标记，脚本按标记整行替换）：
 *   - cloud/index.html  页面脚本里的 var BUILD
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['cloud/index.html'];
const MARK = /^.*\/\/ LT_BUILD\s*$/m;

// 时间精确到分钟（用户要求「版本后面的时间精确到分钟」）。
// ⚠️ 原 --date=short 只产出 2026-09-21 这种纯日期，看不到几点发布。
// ⚠️ 用 %cd(commit date) 而非 %ad(author date)：rebase / cherry-pick 之后 %ad 仍是原始作者时间，
//    而 %cd 才是「这次提交真正落库」的时刻，更贴近「版本发布时间」的语义。
// ⚠️⚠️ 必须用 spawnSync 传参数数组，不能 execSync 拼字符串：Windows 下 execSync 走 cmd.exe，
//    会把 %H / %Y 当环境变量展开 → git 收到乱参数报 `invalid object name '%H'`（踩过）。
const gl = spawnSync(
  'git',
  ['log', '-1', '--format=%h%x1f%cd%x1f%s', '--date=format:%Y-%m-%d %H:%M'],
  { cwd: ROOT, encoding: 'utf8' }
);
if (gl.status !== 0 || !gl.stdout) {
  console.error('✗ git log 失败：' + String(gl.stderr || '').trim());
  process.exit(1);
}
const raw = gl.stdout.trim();
const [sha, date, subject] = raw.split('\x1f');

// 单引号/反斜杠转义 + 折行合并 + 打散 */（避免提交标题里的 */ 破坏注释结构）
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
  // 文件被移除（如 LanTalk.html 收敛到单一代码库后已删）→ 跳过，不要整个脚本崩掉
  if (!existsSync(file)) {
    console.log(`- ${rel} 不存在，跳过`);
    continue;
  }
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
