'use strict';
/** 用 jsdom 真实加载页面，验证前端脚本运行时无异常，并跑通注册->登录->建群->发消息 */
const path = require('path');
const { JSDOM } = require('jsdom');
const BASE = 'http://127.0.0.1:' + (process.env.PORT || 3999);

const errors = [];
let pass = 0, fail = 0;
const log = (ok, name, extra) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' -> ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\n== LanTalk 前端运行时检查（jsdom） ==\n');
  const dom = await JSDOM.fromFile(path.join(__dirname, '..', 'public', 'index.html'), {
    url: BASE + '/',
    resources: 'usable',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.addEventListener('error', (e) => errors.push('window.error: ' + (e.error && e.error.stack || e.message)));
  w.addEventListener('unhandledrejection', (e) => errors.push('unhandledrejection: ' + e.reason));
  // 注入浏览器环境缺失的能力
  w.WebSocket = global.WebSocket;
  w.fetch = (u, o) => fetch(new URL(u, BASE).toString(), o);
  w.Notification = undefined;
  await new Promise((r) => w.addEventListener('load', r));
  await sleep(300);

  log(!!w.document.querySelector('#auth'), '页面加载完成');
  log(!!w.eval('typeof state !== "undefined"'), 'app.js 脚本已执行');

  // 切到注册
  w.document.querySelectorAll('.auth-tab')[1].click();
  const user = 'jsdom' + Date.now().toString().slice(-6);
  w.document.querySelector('#au-username').value = user;
  w.document.querySelector('#au-password').value = '123456';
  w.document.querySelector('#au-name').value = '测试员';
  w.document.querySelector('#authForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(800);

  const appHidden = w.document.querySelector('#app').classList.contains('hidden');
  log(!appHidden, '注册后自动登录并进入主界面');
  log(w.document.querySelector('#meName').textContent === '测试员', '顶栏显示当前用户昵称',
    w.document.querySelector('#meName').textContent);
  log(w.document.querySelector('#connState').textContent === '已连接', 'WebSocket 显示已连接',
    w.document.querySelector('#connState').textContent);

  // 建群需要额外两位成员
  for (const s of ['_b', '_c']) {
    await (await fetch(BASE + '/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user + s, password: '123', name: '同事' + s }),
    })).json();
  }

  w.document.querySelector('#btnNew').click();
  await sleep(100);
  for (const s of ['_b', '_c']) {
    w.document.querySelector('#nuSearch').value = user + s;
    w.document.querySelector('#nuSearch').dispatchEvent(new w.Event('input', { bubbles: true }));
    await sleep(600);
    const results = w.document.querySelectorAll('#nuResults .result-item');
    if (s === '_b') log(results.length >= 1, '搜索用户有结果', results.length);
    if (results.length) results[0].click();
    await sleep(200);
  }
  log(w.document.querySelectorAll('#nuSelected .chip').length === 2, '已选中 2 位成员',
    w.document.querySelectorAll('#nuSelected .chip').length);
  w.document.querySelector('#nuGroupName').value = '自动化测试群';
  w.document.querySelector('#nuCreate').click();
  await sleep(900);

  const convs = await (await fetch(BASE + '/api/conversations', {
    headers: { Authorization: 'Bearer ' + w.localStorage.getItem('lantalk_token') },
  })).json();
  const g = convs.conversations.find((c) => c.name === '自动化测试群');
  log(!!g, '通过界面成功创建群聊');

  // 发消息
  if (g) {
    w.eval(`openConv(${JSON.stringify(g.conv)})`);
    await sleep(400);
    w.document.querySelector('#input').value = '你好，这是一条来自前端的消息';
    w.document.querySelector('#btnSend').click();
    await sleep(600);
    const msgs = w.document.querySelectorAll('#msgList .msg');
    log(msgs.length >= 1, '消息渲染到聊天区', msgs.length);
    const last = msgs[msgs.length - 1];
    log(last && last.textContent.includes('来自前端的消息'), '消息内容正确显示');
    log(w.document.querySelector('#input').value === '', '发送后输入框清空');
  }

  // 会话列表渲染
  log(w.document.querySelectorAll('#convList .conv').length >= 1, '侧边栏会话列表渲染');

  // 主题切换
  w.document.querySelector('#btnTheme').click();
  log(w.document.body.className === 'theme-light', '主题切换生效', w.document.body.className);

  log(errors.length === 0, '运行期间无 JS 异常', errors.join(' | '));
  if (errors.length) console.log('\n异常详情:\n' + errors.join('\n'));

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败\n`);
  dom.window.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('检查异常:', e); process.exit(1); });
