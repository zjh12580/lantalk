'use strict';
/** 单文件版冒烟测试：昵称进入 / 唯一性 / 大厅 / 私聊 / 群聊 / @ / 文件 / 撤回 / IP 身份绑定
 * 需要服务端以 LANCHAT_TRUST_PROXY=1 启动（测试用 X-Forwarded-For 模拟不同内网 IP） */
const BASE = 'http://127.0.0.1:' + (process.env.PORT || 3010);
let pass = 0, fail = 0;
const log = (ok, name, extra) => {
  if (ok) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra ? ' -> ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, opts = {}) {
  const headers = {};
  if (opts.token) headers['Authorization'] = 'Bearer ' + opts.token;
  if (opts.ip) headers['X-Forwarded-For'] = opts.ip;
  if (opts.body && typeof opts.body !== 'string' && !(opts.body instanceof Buffer)) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(BASE + path, { method: opts.method || 'GET', headers, body: opts.body });
  const data = await res.json().catch(() => ({ ok: false, error: 'bad json' }));
  return { status: res.status, data };
}
async function okApi(path, opts) {
  const r = await api(path, opts);
  if (!r.data.ok) throw new Error(path + ': ' + (r.data.error || r.status));
  return r.data;
}
function connect(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + (process.env.PORT || 3010) + '/ws');
    const q = [];
    const waiters = [];
    ws.onmessage = (ev) => {
      const p = JSON.parse(ev.data);
      q.push(p);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        if (waiters[i].m(p)) { waiters[i].res(p); waiters.splice(i, 1); }
      }
    };
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', d: { token } }));
      resolve({
        wait(m, ms = 3000) {
          const f = typeof m === 'string' ? (p) => p.t === m : m;
          const hit = q.find(f);
          if (hit) { q.splice(q.indexOf(hit), 1); return Promise.resolve(hit); }
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('等待事件超时: ' + m)), ms);
            waiters.push({ m: f, res: (p) => { clearTimeout(t); res(p); } });
          });
        },
        send: (t, d) => ws.send(JSON.stringify({ t, d })),
        close: () => ws.close(),
      });
    };
    ws.onerror = reject;
  });
}

(async () => {
  console.log('\n== LanTalk 单文件版冒烟测试 ==\n');
  const sf = Date.now().toString().slice(-6);

  // 1. 昵称进入（带表情头像）
  const IP_A = '10.0.0.1';
  const A = await okApi('/api/join', { method: 'POST', ip: IP_A, body: { name: '小明' + sf, avatar: '🐱' } });
  log(!!A.token && A.user.name === '小明' + sf, '输入昵称直接进入（无需密码）');
  log(A.user.avatar === '🐱', '表情头像已保存');

  // 2. 昵称不可重复（另一台机器用同名）
  const dup = await api('/api/join', { method: 'POST', ip: '10.0.0.9', body: { name: '小明' + sf, avatar: '' } });
  log(dup.status === 409 && !dup.data.ok, '昵称重复被拒绝');

  // 3. 本人 reclaim
  const back = await okApi('/api/reclaim', { method: 'POST', ip: IP_A, body: { name: '小明' + sf, avatar: '🐱' } });
  log(!!back.token, '昵称占用时可声明本人并恢复进入');

  // 4. 不选手情头像则无 avatar（前端用首字）
  const B = await okApi('/api/join', { method: 'POST', ip: '10.0.0.2', body: { name: '阿强' + sf, avatar: '' } });
  log(B.user.avatar === '', '不选表情则不带头像（前端渲染昵称首字）');
  const C = await okApi('/api/join', { method: 'POST', ip: '10.0.0.3', body: { name: '小美' + sf, avatar: '🌸' } });

  // 5. 自动进入大厅
  const hallA = A.conversations.filter((c) => c.id === 'hall')[0];
  log(!!hallA, '新用户自动加入公共「大厅」');
  const hallB = (await okApi('/api/conversations', { token: B.token })).conversations.filter((c) => c.id === 'hall')[0];
  log(!!hallB, '第二个用户同样在大厅');

  const ca = await connect(A.token), cb = await connect(B.token), cc = await connect(C.token);
  await Promise.all([ca.wait('ready'), cb.wait('ready'), cc.wait('ready')]);
  log(true, '三个客户端 WebSocket 连接成功');

  // 6. 大厅群聊
  ca.send('chat', { conv: 'g:hall', type: 'text', text: '大家好！' });
  const hb = await cb.wait((p) => p.t === 'msg' && p.d.text === '大家好！');
  log(!!hb, '大厅消息全员收到');

  // 7. 私聊
  const pconv = await okApi('/api/conv/open', { method: 'POST', token: A.token, body: { peerId: B.user.id } });
  ca.send('chat', { conv: pconv.conv, type: 'text', text: '阿强在吗' });
  const pm = await cb.wait((p) => p.t === 'msg' && p.d.text === '阿强在吗');
  log(pm.d.fromName === '小明' + sf, '私聊消息送达且显示发送者昵称');
  cb.send('chat', { conv: pconv.conv, type: 'text', text: '在的' });
  const pm2 = await ca.wait((p) => p.t === 'msg' && p.d.text === '在的');
  log(!!pm2, '私聊双向通信正常');

  // 8. 建群 + @提醒
  const g = await okApi('/api/group/create', { method: 'POST', token: A.token, body: { name: '项目组', members: [B.user.id, C.user.id] } });
  await cb.wait((p) => p.t === 'conv' && p.d.action === 'added');
  await cc.wait((p) => p.t === 'conv' && p.d.action === 'added');
  log(true, '建群后成员实时收到通知');
  ca.send('chat', { conv: 'g:' + g.group.id, type: 'text', text: '@' + B.user.name + ' 交一下周报', mentions: [B.user.id] });
  const gm = await cb.wait((p) => p.t === 'msg' && p.d.text.indexOf('周报') >= 0);
  const mt = await cb.wait('mention');
  log(!!gm && mt.d.mentions.indexOf(B.user.id) >= 0, '@提醒事件送达被 @ 的人');
  const noAt = await cc.wait((p) => p.t === 'msg' && p.d.text.indexOf('周报') >= 0);
  log(!!noAt, '未被 @ 的成员也能看到消息');

  // 9. 文件
  const payload = Buffer.from('lantalk single file test 中文内容');
  const up = await okApi('/api/upload?name=' + encodeURIComponent('测试.txt') + '&mime=text/plain', { method: 'POST', token: A.token, body: payload });
  ca.send('chat', { conv: 'g:' + g.group.id, type: 'file', fileId: up.file.id, fileName: up.file.name, fileSize: up.file.size, mime: 'text/plain' });
  const fm = await cb.wait((p) => p.t === 'msg' && p.d.type === 'file');
  log(fm.d.fileName === '测试.txt', '文件消息送达');
  const dl = await fetch(`${BASE}/api/file/${up.file.id}?dl=1&token=${B.token}`);
  log(Buffer.from(await dl.arrayBuffer()).equals(payload), '文件下载内容一致');

  // 10. 撤回
  ca.send('chat', { conv: pconv.conv, type: 'text', text: '撤回我' });
  const rm = await cb.wait((p) => p.t === 'msg' && p.d.text === '撤回我');
  ca.send('revoke', { conv: pconv.conv, msgId: rm.d.id });
  const rv = await cb.wait('revoked');
  log(rv.d.msgId === rm.d.id, '撤回广播正常');

  // 11. 历史 / 搜索 / 在线
  const hist = await okApi('/api/history?conv=' + encodeURIComponent('g:hall'), { token: C.token });
  log(hist.messages.length >= 2, '大厅历史消息可拉取', hist.messages.length);
  const s = await okApi('/api/search/message?q=' + encodeURIComponent('周报'), { token: B.token });
  log(s.messages.length >= 1, '消息搜索可用');
  const onl = await okApi('/api/online', { token: A.token });
  log(onl.count >= 3, '在线人数统计正确', onl.count);

  // 12. 权限
  const h = await api('/api/history?conv=' + encodeURIComponent('g:' + g.group.id), { token: (await okApi('/api/join', { method: 'POST', ip: '10.0.0.4', body: { name: '路人' + sf } })).token });
  log(h.status === 403, '非群成员读取群历史被拒绝');

  // 13. IP 身份绑定：一台机器 = 一个用户
  const oldName = '小明' + sf;
  const newName = '小明改名' + sf;
  const again = await okApi('/api/join', { method: 'POST', ip: IP_A, body: { name: newName, avatar: '🐱' } });
  log(again.user.id === A.user.id && again.renamed === true && again.previousName === oldName,
    '同一 IP 用新昵称进入 = 给原身份改名（不新建用户）');
  log(again.user.name === newName, '改名后返回新昵称', again.user.name);

  const enterBack = await okApi('/api/enter', { ip: IP_A });
  log(enterBack.user && enterBack.user.id === A.user.id && !!enterBack.token && enterBack.bound === true,
    '同一 IP 免输入直接进入（/api/enter 直接返回身份）');

  const enterFresh = await api('/api/enter', { ip: '10.0.0.77' });
  log(enterFresh.data.ok && enterFresh.data.user === null, '陌生 IP 没有身份，需要输入昵称');

  const clash = await api('/api/join', { method: 'POST', ip: '10.0.0.66', body: { name: newName } });
  log(clash.status === 409, '别的机器使用他人昵称仍被拒绝');

  const reuse = await api('/api/join', { method: 'POST', ip: '10.0.0.88', body: { name: oldName } });
  log(reuse.data.ok && reuse.data.user.name === oldName, '改名后旧昵称被释放，可被他人使用');

  const hall2 = await okApi('/api/history?conv=' + encodeURIComponent('g:hall'), { token: C.token });
  log(hall2.messages.some((m) => m.type === 'system' && m.text.indexOf('更名为') >= 0), '大厅收到更名系统消息');
  const mine = hall2.messages.filter((m) => m.from === A.user.id);
  log(mine.length > 0 && mine.every((m) => m.fromName === newName), '历史消息里的显示名同步更新', mine.length);

  const prof = await okApi('/api/profile', { method: 'POST', token: A.token, body: { name: newName + '2' } });
  log(prof.user.name === newName + '2' && prof.previousName === newName, '资料页改名生效');
  const clash2 = await api('/api/profile', { method: 'POST', token: B.token, body: { name: newName + '2' } });
  log(clash2.status === 409, '改名撞他人昵称被拒绝');

  // 13. 页面可访问（服务端内嵌页面提取）
  const page = await fetch(BASE + '/');
  const html = await page.text();
  log(html.indexOf('<div class="join"') >= 0 || html.indexOf('id="join"') >= 0, '服务端返回内嵌页面（含昵称入口）');
  log(html.indexOf('require(') < 0, '页面内容未泄漏服务端源码');

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败\n`);
  ca.close(); cb.close(); cc.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
