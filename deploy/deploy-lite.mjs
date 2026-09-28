/* ============================================================================
 * deploy-lite.mjs —— 把云聊「精简自建版」部署到一台没有 root 的 Linux 服务器
 * ----------------------------------------------------------------------------
 * 适用：1~2G 内存的小鸡（跑不动 Supabase 全家桶的场景）。
 * 做法：代码传到 ~/lantalk/cloud，用用户态 Node 起 server.js（SQLite 数据层），
 *       靠 crontab 每分钟保活（没有 root 装不了 systemd 单元）。
 *
 * 用法：
 *   SSH_USER=zhangsan SSH_PASS=xxx \
 *   [SMTP_HOST=smtp.qq.com SMTP_PORT=465 SMTP_USER=me@qq.com SMTP_PASS=授权码] \
 *   [PORT=3000] [OTP_ECHO=1] \
 *   node deploy/deploy-lite.mjs
 *
 * 环境变量：
 *   SSH_HOST / SSH_USER / SSH_PASS   服务器登录（默认 112.74.95.74 / 22）
 *   PORT                             监听端口（默认 3000）
 *   SMTP_*                           邮箱发信配置；不配则验证码只写日志
 *   OTP_ECHO=1                       ⚠️ 把验证码回显到接口（无 SMTP 时临时用，有 SMTP 后务必关掉）
 * ==========================================================================*/
'use strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
// ⚠️ ESM 里 NODE_PATH 不生效，ssh2（装在工作区）必须用 createRequire 走 CJS 解析才能找到
const require = createRequire(import.meta.url);
const { Client } = require('ssh2');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLOUD = path.join(HERE, '..', 'cloud');

const HOST = process.env.SSH_HOST || '112.74.95.74';
const PORT_SSH = Number(process.env.SSH_PORT || 22);
const USER = process.env.SSH_USER || '';
const PASS = process.env.SSH_PASS || '';
const APP_PORT = Number(process.env.PORT || 3000);
const REMOTE = '/home/' + USER + '/lantalk';
const REMOTE_CLOUD = REMOTE + '/cloud';

const FILES = [
  'index.html', 'styles.css', 'server.js', 'agent.js',
  'cloud-shim.js', 'lite-db.js', 'lite-mail.js', 'OneSignalSDKWorker.js',
  '.llm.json',
];

if (!USER || !PASS) { console.error('缺少 SSH_USER / SSH_PASS'); process.exit(1); }

function sh(c, cmd) {
  return new Promise((resolve, reject) => {
    c.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '', errOut = '';
      stream.on('data', (d) => out += d);
      stream.stderr.on('data', (d) => errOut += d);
      stream.on('close', (code) => resolve({ code, out, err: errOut }));
    });
  });
}

const c = new Client();
c.on('ready', async () => {
  console.log('[ssh] 已连接 ' + USER + '@' + HOST);

  console.log('\n=== 1. 准备目录 ===');
  let r = await sh(c, `mkdir -p ${REMOTE_CLOUD} ${REMOTE}/data && echo OK`);
  console.log(r.out.trim() || r.err.trim());

  console.log('\n=== 2. 上传代码 ===');
  await new Promise((resolve, reject) => {
    c.sftp((err, sftp) => {
      if (err) return reject(err);
      let i = 0;
      const next = () => {
        if (i >= FILES.length) { sftp.end(); return resolve(); }
        const f = FILES[i++];
        const local = path.join(CLOUD, f);
        if (!fs.existsSync(local)) { console.log('  跳过（本地不存在）: ' + f); return next(); }
        sftp.fastPut(local, REMOTE_CLOUD + '/' + f, (e) => {
          if (e) { console.log('  失败: ' + f + ' — ' + e.message); sftp.end(); return reject(e); }
          console.log('  ✓ ' + f + '  (' + Math.round(fs.statSync(local).size / 1024) + ' KB)');
          next();
        });
      };
      next();
    });
  });

  console.log('\n=== 3. 写运行时配置（lite 模式）===');
  const runtimeCfg = `/* 由 deploy-lite.mjs 生成：精简自建模式 */
window.__LT_CONFIG__ = {
  mode: 'lite',
  apiBase: '',                 /* 空串 = 同源 */
  endpoint: '',
  publishableKey: 'lt-self-hosted'
};
`;
  const smtp = {
    smtpHost: process.env.SMTP_HOST || '',
    smtpPort: Number(process.env.SMTP_PORT || 465),
    smtpUser: process.env.SMTP_USER || '',
    smtpPass: process.env.SMTP_PASS || '',
    otpEcho: process.env.OTP_ECHO === '1',
  };
  const liteCfg = JSON.stringify({ dataDir: REMOTE + '/data', db: REMOTE + '/data/lantalk.db', storage: REMOTE + '/data/storage', ...smtp }, null, 2);

  await new Promise((resolve, reject) => {
    c.sftp((err, sftp) => {
      if (err) return reject(err);
      const ws = [];
      ws.push(new Promise((res, rej) => {
        const s = sftp.createWriteStream(REMOTE_CLOUD + '/runtime-config.js');
        s.on('close', res); s.on('error', rej); s.end(runtimeCfg);
      }));
      ws.push(new Promise((res, rej) => {
        const s = sftp.createWriteStream(REMOTE_CLOUD + '/.lite.json');
        s.on('close', res); s.on('error', rej); s.end(liteCfg);
      }));
      Promise.all(ws).then(() => { sftp.end(); resolve(); }).catch(reject);
    });
  });
  console.log('  ✓ runtime-config.js（mode: lite）');
  console.log('  ✓ .lite.json' + (smtp.smtpHost ? '（含 SMTP）' : '（⚠️ 无 SMTP，验证码只写日志）'));

  console.log('\n=== 4. 写保活脚本 ===');
  // ⚠️ 两个坑：
  //   1. 不能用 `pgrep -f "node server.js"` 判断存活 —— crontab 调起脚本时，
  //      脚本自身的命令行也含这个字符串，会把自己匹配进去然后被 kill（实测踩过）。
  //      改用 pidfile + kill -0，只看具体 PID。
  //   2. 用绝对路径的 node，crontab 环境里 PATH 不含 ~/.local/node22/bin。
  const runSh = `#!/bin/bash
# 无 root 环境下的「伪 systemd」：由 crontab 每分钟调用，进程不在就拉起来
PIDF="${REMOTE}/server.pid"
if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then exit 0; fi
cd "${REMOTE_CLOUD}" || exit 1
PORT=${APP_PORT} LITE=1 nohup /home/${USER}/.local/node22/bin/node server.js \\
  >> ${REMOTE}/server.log 2>&1 &
echo $! > "$PIDF"
`;
  await new Promise((resolve, reject) => {
    c.sftp((err, sftp) => {
      if (err) return reject(err);
      const s = sftp.createWriteStream(REMOTE + '/run-lite.sh');
      s.on('close', () => { sftp.end(); resolve(); });
      s.on('error', reject);
      s.end(runSh);
    });
  });
  r = await sh(c, `chmod +x ${REMOTE}/run-lite.sh && echo OK`);
  console.log('  ' + (r.out.trim() || r.err.trim()));

  console.log('\n=== 5. 停旧进程并启动 ===');
  r = await sh(c, `pkill -f "lantalk/cloud/server.js" 2>/dev/null; sleep 1; ${REMOTE}/run-lite.sh; sleep 3; pgrep -af "lantalk/cloud/server.js" | head -2`);
  console.log((r.out || '').trim() || '(未看到进程)');

  console.log('\n=== 6. 配置 crontab 保活 ===');
  r = await sh(c, `(crontab -l 2>/dev/null | grep -v 'run-lite.sh'; echo "* * * * * ${REMOTE}/run-lite.sh") | crontab - 2>&1; crontab -l 2>/dev/null | grep run-lite || echo "(crontab 未生效/不可用)"`);
  console.log((r.out || '').trim());

  console.log('\n=== 7. 自检 ===');
  r = await sh(c, `sleep 2; curl -s -o /dev/null -w "首页 HTTP %{http_code}\\n" http://127.0.0.1:${APP_PORT}/; curl -s http://127.0.0.1:${APP_PORT}/api/auth/session; echo; echo "--- 最近日志 ---"; tail -6 ${REMOTE}/server.log 2>/dev/null`);
  console.log((r.out || '').trim());
  console.log((r.err || '').trim());

  console.log('\n完成。外部访问地址: http://' + HOST + ':' + APP_PORT + '  （需云服务器安全组放行该端口）');
  c.end();
});
c.on('error', (e) => { console.error('[ssh] 错误: ' + e.message); process.exit(1); });
c.connect({ host: HOST, port: PORT_SSH, username: USER, password: PASS, readyTimeout: 20000 });
