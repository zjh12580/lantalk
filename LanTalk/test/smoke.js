'use strict';
/** 冒烟测试：模拟 3 个客户端完成注册/加好友/私聊/建群/@/文件/撤回/搜索 全流程 */
const BASE = 'http://127.0.0.1:' + (process.env.PORT || 3999);
let pass = 0, fail = 0;
const log = (ok, name, extra) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' -> ' + extra : '')); }
};

async function api(path, opts = {}) {
  const headers = {};
  if (opts.token) headers['Authorization'] = 'Bearer ' + opts.token;
  if (opts.body && typeof opts.body !== 'string' && !(opts.body instanceof Buffer)) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(BASE + path, { method: opts.method || 'GET', headers, body: opts.body });
  const data = await res.json().catch(() => ({ ok: false, error: 'bad json' }));
  if (!data.ok) throw new Error((path + ': ' + (data.error || res.status)));
  return data;
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + (process.env.PORT || 3999) + '/ws');
    const q = [];
    const waiters = [];
    ws.onmessage = (ev) => {
      const p = JSON.parse(ev.data);
      q.push(p);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].match(p)) { waiters[i].resolve(p); waiters.splice(i, 1); }
      }
    };
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', d: { token } }));
      resolve({
        ws,
        wait(match, ms = 3000) {
          const m = typeof match === 'string' ? (p) => p.t === match : match;
          const hit = q.find(m);
          if (hit) { q.splice(q.indexOf(hit), 1); return Promise.resolve(hit); }
          return new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('等待事件超时: ' + match)), ms);
            waiters.push({ match: m, resolve: (p) => { clearTimeout(t); resolve(p); } });
          });
        },
        send: (t, d) => ws.send(JSON.stringify({ t, d })),
        close: () => ws.close(),
      });
    };
    ws.onerror = reject;
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\n== LanTalk 冒烟测试 ==\n');
  const suffix = Date.now().toString().slice(-6);

  // 1. 注册三个用户
  const A = await api('/api/register', { method: 'POST', body: { username: 'alice' + suffix, password: '123', name: '爱丽丝' } });
  const B = await api('/api/register', { method: 'POST', body: { username: 'bob' + suffix, password: '123', name: '鲍勃' } });
  const C = await api('/api/register', { method: 'POST', body: { username: 'carol' + suffix, password: '123', name: '卡罗尔' } });
  log(!!A.token && !!B.token && !!C.token, '注册三个账号');

  // 重复用户名应报错
  let dupErr = false;
  try { await api('/api/register', { method: 'POST', body: { username: 'alice' + suffix, password: '1' } }); } catch (e) { dupErr = true; }
  log(dupErr, '重名注册被拒绝');

  // 2. 登录
  const login = await api('/api/login', { method: 'POST', body: { username: 'alice' + suffix, password: '123' } });
  log(login.user.id === A.user.id, '登录返回正确用户');

  // 3. 连接 WebSocket
  const ca = await connect(A.token), cb = await connect(B.token), cc = await connect(C.token);
  await Promise.all([ca.wait('ready'), cb.wait('ready'), cc.wait('ready')]);
  log(true, '三个客户端 WebSocket 握手与鉴权');

  // 4. 加好友
  await api('/api/friend/request', { method: 'POST', token: A.token, body: { to: B.user.id, message: '交个朋友' } });
  const reqEvt = await cb.wait('friend');
  log(reqEvt.d.action === 'request', 'B 实时收到好友请求');
  const me = await api('/api/me', { token: B.token });
  log(me.requests.length === 1, 'B 的待处理请求列表正确');
  await api('/api/friend/respond', { method: 'POST', token: B.token, body: { requestId: me.requests[0].id, accept: true } });
  const accEvt = await ca.wait((p) => p.t === 'friend' && p.d.action === 'accepted');
  log(true, 'A 实时收到好友通过通知');

  // 5. 私聊
  const pconv = 'p:' + [A.user.id, B.user.id].sort().join('~');
  ca.send('chat', { conv: pconv, type: 'text', text: '你好，鲍勃！' });
  const m1 = await cb.wait((p) => p.t === 'msg' && p.d.text === '你好，鲍勃！');
  log(m1.d.from === A.user.id, 'B 收到私聊消息');
  cb.send('chat', { conv: pconv, type: 'text', text: 'hi，收到了' });
  const m2 = await ca.wait((p) => p.t === 'msg' && p.d.text === 'hi，收到了');
  log(m2.d.from === B.user.id, 'A 收到私聊回复');

  // 历史记录
  const hist = await api('/api/history?conv=' + encodeURIComponent(pconv), { token: A.token });
  log(hist.messages.length >= 3, '私聊历史可拉取（含系统消息）', hist.messages.length);

  // 6. 建群
  const g = await api('/api/group/create', { method: 'POST', token: A.token, body: { name: '项目组', members: [B.user.id, C.user.id] } });
  const gconv = 'g:' + g.group.id;
  await cb.wait((p) => p.t === 'conv' && p.d.action === 'added');
  await cc.wait((p) => p.t === 'conv' && p.d.action === 'added');
  log(true, 'B/C 实时收到入群通知');

  // 7. 群聊 + @提醒
  ca.send('chat', { conv: gconv, type: 'text', text: `@${B.user.name} 记得提交周报`, mentions: [B.user.id] });
  const gm = await cb.wait((p) => p.t === 'msg' && p.d.text.includes('周报'));
  const mentionEvt = await cb.wait('mention');
  log(gm.d.from === A.user.id, '群消息送达');
  log(mentionEvt.d.mentions.includes(B.user.id), '@提醒事件送达被 @ 的人');
  const gmA = await ca.wait((p) => p.t === 'msg' && p.d.text.includes('周报'));
  log(gmA.d.text.includes('周报'), '发送者自己也收到回显（多端同步）');

  // 8. 群公告
  await api('/api/group/update', { method: 'POST', token: A.token, body: { groupId: g.group.id, announcement: '每周五下午周会' } });
  const annoMsg = await cc.wait((p) => p.t === 'msg' && p.d.text.includes('周会'));
  log(annoMsg.d.text.includes('周会'), '群公告以系统消息广播');

  // 9. 文件上传与消息
  const payload = Buffer.from('hello lantalk file content\n中文测试');
  const up = await api('/api/upload?name=' + encodeURIComponent('测试文件.txt') + '&mime=text/plain', {
    method: 'POST', token: A.token, body: payload,
  });
  log(!!up.file.id, '文件上传成功');
  ca.send('chat', { conv: gconv, type: 'file', fileId: up.file.id, fileName: up.file.name, fileSize: up.file.size, mime: 'text/plain' });
  const fm = await cb.wait((p) => p.t === 'msg' && p.d.type === 'file');
  log(fm.d.fileName === '测试文件.txt', '文件消息送达');
  const dl = await fetch(`${BASE}/api/file/${up.file.id}?dl=1&token=${B.token}`);
  const buf = Buffer.from(await dl.arrayBuffer());
  log(buf.equals(payload), '文件下载内容一致');
  const dl401 = await fetch(`${BASE}/api/file/${up.file.id}`);
  log(dl401.status === 401, '未登录下载被拒绝');

  // 10. 撤回
  ca.send('chat', { conv: pconv, type: 'text', text: '这条要撤回' });
  const rm = await cb.wait((p) => p.t === 'msg' && p.d.text === '这条要撤回');
  await sleep(50);
  ca.send('revoke', { conv: pconv, msgId: rm.d.id });
  const rv = await cb.wait('revoked');
  log(rv.d.msgId === rm.d.id, '撤回事件广播给对方');

  // 11. 消息搜索
  const s = await api('/api/search/message?q=' + encodeURIComponent('周报'), { token: B.token });
  log(s.messages.length >= 1, '消息搜索可用');

  // 12. 已读
  cb.send('read', { conv: pconv, msgId: rm.d.id });
  const rd = await ca.wait('read');
  log(rd.d.userId === B.user.id, '已读回执回传');

  // 13. 正在输入
  ca.send('typing', { conv: pconv, on: true });
  const tp = await cb.wait('typing');
  log(tp.d.on === true, '正在输入状态同步');

  // 14. 在线状态
  const online = await api('/api/online', { token: A.token });
  log(online.count >= 3, '在线人数统计正确', online.count);

  // 15. 权限：非成员不能发言
  const D = await api('/api/register', { method: 'POST', body: { username: 'dave' + suffix, password: '123', name: '戴夫' } });
  const cd = await connect(D.token);
  await cd.wait('ready');
  let denied = false;
  const h = await api('/api/history?conv=' + encodeURIComponent(gconv), { token: D.token }).catch(() => null);
  denied = (h === null);
  log(denied, '非群成员访问群历史被拒绝');

  // 16. 会话列表 & 未读
  await ca.send('chat', { conv: gconv, type: 'text', text: '未读测试' });
  await sleep(300);
  const convs = await api('/api/conversations', { token: C.token });
  const gc = convs.conversations.find((x) => x.conv === gconv);
  log(gc && gc.unread > 0, '未读计数正确', gc && gc.unread);

  // 17. 免打扰
  await api('/api/group/update', { method: 'POST', token: C.token, body: { groupId: g.group.id, muted: true } });
  const convs2 = await api('/api/conversations', { token: C.token });
  log(convs2.conversations.find((x) => x.conv === gconv).muted === true, '群消息免打扰设置生效');

  // 18. 退出群聊
  await api('/api/group/leave', { method: 'POST', token: C.token, body: { groupId: g.group.id } });
  const convs3 = await api('/api/conversations', { token: C.token });
  log(!convs3.conversations.some((x) => x.conv === gconv), '退群后会话移除');

  // 19. 超大消息：验证 WebSocket 分片帧解析（服务端单条上限 20000 字符）
  const big = 'x'.repeat(80000);
  ca.send('chat', { conv: pconv, type: 'text', text: big });
  const bm = await cb.wait((p) => p.t === 'msg' && p.d.text.length === 20000, 5000);
  log(!!bm, '80KB 超大消息分片帧传输正常（截断到上限 20000）');

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败\n`);
  ca.close(); cb.close(); cc.close(); cd.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
