'use strict';
/** jsdom 加载单文件版页面，验证：昵称进入 -> 表情头像 -> 自动进大厅 -> 发消息，且无 JS 异常 */
const { JSDOM } = require('jsdom');
const BASE = 'http://127.0.0.1:' + (process.env.PORT || 3010);

const errors = [];
let pass = 0, fail = 0;
const log = (ok, name, extra) => {
  if (ok) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra ? ' -> ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\n== LanTalk 单文件版 前端运行时检查 ==' + '\n');
  const html = await (await fetch(BASE + '/')).text();
  const dom = new JSDOM(html, {
    url: BASE + '/',
    resources: 'usable',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.WebSocket = global.WebSocket;
      win.Notification = undefined;
      win.fetch = (u, o) => fetch(new URL(u, BASE).toString(), o);
    },
  });
  const w = dom.window;
  w.addEventListener('error', (e) => errors.push('error: ' + ((e.error && e.error.stack) || e.message)));
  w.addEventListener('unhandledrejection', (e) => errors.push('rejection: ' + e.reason));
  w.WebSocket = global.WebSocket;
  w.Notification = undefined;
  await new Promise((r) => w.addEventListener('load', r));
  await sleep(400);

  const D = w.document;
  log(!!D.querySelector('#join'), '页面加载：显示昵称进入页');
  log(!D.querySelector('#app').classList.contains('hidden') === false, '主界面初始隐藏');
  log(D.querySelectorAll('#jEmo span').length > 20, '表情头像候选已渲染', D.querySelectorAll('#jEmo span').length);

  const nick = '界面测试' + Date.now().toString().slice(-5);
  D.querySelector('#jName').value = nick;
  D.querySelector('#jName').dispatchEvent(new w.Event('input', { bubbles: true }));
  // 选一个表情
  const emo = D.querySelectorAll('#jEmo span')[3];
  const chosen = emo.textContent;
  emo.click();
  await sleep(100);
  log(D.querySelector('#jPrev').textContent === chosen, '选择表情后预览头像同步', D.querySelector('#jPrev').textContent);

  D.querySelector('#jGo').click();
  await sleep(1200);

  log(D.querySelector('#join').classList.contains('hidden'), '输入昵称后直接进入主界面（免登录）');
  log(D.querySelector('#meName').textContent === nick, '顶栏显示昵称', D.querySelector('#meName').textContent);
  log(D.querySelector('#meAv').textContent === chosen, '头像显示为所选表情', D.querySelector('#meAv').textContent);
  log(D.querySelector('#conn').textContent === '已连接', 'WebSocket 已连接', D.querySelector('#conn').textContent);

  const convs = D.querySelectorAll('#cList .conv');
  log(convs.length >= 1, '会话列表含自动加入的大厅', convs.length);
  const hallOpened = !D.querySelector('#cMain').classList.contains('hidden');
  log(hallOpened, '进入后自动打开大厅会话');
  log(D.querySelector('#cName').textContent.indexOf('大厅') >= 0, '当前会话是大厅', D.querySelector('#cName').textContent);

  // 在大厅发一条消息
  const text = '来自单文件页面的消息 ' + Date.now();
  D.querySelector('#input').value = text;
  D.querySelector('#bSend').click();
  await sleep(900);
  const bubbles = D.querySelectorAll('#mList .bub');
  const hit = Array.prototype.some.call(bubbles, (b) => b.textContent.indexOf(text) >= 0);
  log(hit, '大厅消息发送并渲染到页面', bubbles.length);

  // 侧栏会话名是否包含大厅
  log(D.querySelector('#cList').textContent.indexOf('大厅') >= 0, '侧栏显示大厅会话');

  // 搜索框可用
  D.querySelector('#bSearch').click();
  await sleep(100);
  log(!D.querySelector('#sRow').classList.contains('hidden'), '搜索框可展开');

  // 主题切换
  D.querySelector('#bTheme').click();
  await sleep(100);
  log(D.body.className === 'theme-light', '主题切换生效', D.body.className);

  // ---- 大厅头像点击 -> 输入框 @ 该成员 ----
  const nick2 = '头像测试' + Date.now().toString().slice(-5);
  // 用另一个 IP 建人，避免被本页所在 IP（127.0.0.1）的身份绑定"吞掉"
  const r2 = await (await fetch(BASE + '/api/join', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.9.9.2' },
    body: JSON.stringify({ name: nick2, avatar: '🐧' }),
  })).json();
  const uid2 = r2.user.id;
  await new Promise((resolve, reject) => {
    const ws2 = new WebSocket(BASE.replace('http', 'ws') + '/ws');
    ws2.onopen = () => {
      ws2.send(JSON.stringify({ t: 'hello', d: { token: r2.token } }));
      ws2.send(JSON.stringify({ t: 'chat', d: { conv: 'g:hall', type: 'text', text: '大家好，我是 ' + nick2, mentions: [] } }));
      setTimeout(() => { ws2.close(); resolve(); }, 600);
    };
    ws2.onerror = reject;
  });
  await sleep(900);

  const av2 = D.querySelector('.mav[data-u="' + uid2 + '"]');
  log(!!av2, '大厅消息渲染出可点击的他人头像');
  if (av2) av2.click();
  await sleep(600);
  log(D.querySelector('#input').value.indexOf('@' + nick2) >= 0,
    '点击大厅头像后在输入框插入 @昵称', JSON.stringify(D.querySelector('#input').value));
  D.querySelector('#input').value = '';

  // ---- 新建群聊时可从大厅拉人 ----
  D.querySelector('#bNew').click();
  await sleep(1000);
  const hchips = D.querySelectorAll('#nhp .chip[data-h]');
  log(hchips.length >= 2, '建群弹窗列出大厅成员', hchips.length);
  log(Array.prototype.some.call(hchips, (c) => c.dataset.h === uid2), '大厅成员包含刚加入的用户');
  for (let i = 0; i < 2; i += 1) {
    const cs = D.querySelectorAll('#nhp .chip[data-h]');
    let target = null;
    for (const c of cs) { if (!c.classList.contains('on')) { target = c; break; } }
    if (!target) break;
    target.click();
    await sleep(150);
  }
  log(D.querySelectorAll('#ns .chip').length === 2, '从大厅选中 2 位成员', D.querySelectorAll('#ns .chip').length);
  const gname = '界面建群' + Date.now().toString().slice(-4);
  D.querySelector('#ng').value = gname;
  D.querySelector('#ncreate').click();
  await sleep(1800);
  log(D.querySelector('#cName').textContent === gname, '用大厅成员创建群聊并自动进入', D.querySelector('#cName').textContent);
  log(D.querySelector('#cList').textContent.indexOf(gname) >= 0, '侧栏出现新建的群聊');

  // ---- 同一台机器再次打开（模拟换浏览器/清缓存）：免输入直接进 ----
  const dom2 = new JSDOM(html, {
    url: BASE + '/',
    resources: 'usable',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.WebSocket = global.WebSocket;
      win.Notification = undefined;
      win.fetch = (u, o) => fetch(new URL(u, BASE).toString(), o);
    },
  });
  const w2 = dom2.window;
  w2.WebSocket = global.WebSocket;
  w2.Notification = undefined;
  await new Promise((r) => w2.addEventListener('load', r));
  await sleep(1600);
  const D2 = w2.document;
  log(D2.querySelector('#join').classList.contains('hidden'), '同一台机器重新打开：跳过昵称页直接进聊天');
  log(D2.querySelector('#meName').textContent === nick, '重新打开后身份与之前一致', D2.querySelector('#meName').textContent);

  // ---- 改名：我的资料里改昵称 ----
  const newNick = nick + '改';
  D.querySelector('#meBox').click();
  await sleep(300);
  log(!!D.querySelector('#mName'), '「我的资料」里可编辑昵称');
  D.querySelector('#mName').value = newNick;
  D.querySelector('#mSave').click();
  await sleep(1500);
  log(D.querySelector('#meName').textContent === newNick, '改名后顶栏昵称已更新', D.querySelector('#meName').textContent);
  await sleep(700);
  log(D2.querySelector('#meName').textContent === newNick, '改名实时同步到同一身份的其他窗口', D2.querySelector('#meName').textContent);

  log(errors.length === 0, '运行期间无 JS 异常', errors.join(' | '));
  if (errors.length) console.log('\n异常详情:\n' + errors.join('\n'));

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败' + '\n');
  w2.close();
  w.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('检查异常:', e); process.exit(1); });
