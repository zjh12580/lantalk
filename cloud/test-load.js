'use strict';
/** 云端版逻辑冒烟：用桩 SDK 跑通「登录 -> 设昵称 -> 进大厅 -> 发消息」，不依赖真实网络 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const errors = [];
let pass = 0, fail = 0;
const log = (ok, name, extra) => {
  if (ok) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra ? ' -> ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 内存里的"云端数据库"
const DATA = {
  profiles: [],
  groups: [{ id: 'hall', name: '大厅', owner_id: 'system', announcement: '欢迎', color: '#07c160', is_hall: true, created_at: new Date().toISOString() }],
  group_members: [],
  friends: [],
  reads: [],
  messages: [],
  live: [],
};
let seq = 0;
const TABLE = {};
function builder(table) {
  let res = null;
  let filters = [];
  let ord = null;
  let lim = null;
  let pendingOp = null; // 'update' | 'delete'，惰性：在 .then() 时（filters 补全后）才执行
  const matchRows = () => {
    let rows = (DATA[table] || []).slice();
    filters.forEach((f) => { rows = rows.filter((r) => String(r[f[0]]) === String(f[1])); });
    return rows;
  };
  const b = {
    select() { return b; },
    eq(c, v) { filters.push([c, v, '=']); return b; },
    gt(c, v) { filters.push([c, v, '>']); return b; },
    lt(c, v) { filters.push([c, v, '<']); return b; },
    ilike() { return b; },
    order(c, o) { ord = [c, (o && o.ascending === false) ? -1 : 1]; return b; },
    limit(n) { lim = n; return b; },
    single() { return b; },
    insert(rows) {
      const list = Array.isArray(rows) ? rows : [rows];
      list.forEach((r) => {
        if (table === 'messages' || table === 'profiles') { if (!r.id) r.id = ++seq; }
        if (table === 'live') { if (!r.id) r.id = ++seq; if (!r.started_at) r.started_at = new Date().toISOString(); }
        // 真实库里 sender_id 由 DEFAULT auth.uid() 填充，桩里补上
        if (table === 'messages' && !r.sender_id) r.sender_id = 'u_test';
        if (table === 'messages' && !r.created_at) r.created_at = new Date().toISOString();
        DATA[table].push(r);
      });
      res = list;
      return b;
    },
    upsert(rows) { // 按主键覆盖：reads 用 conv+user_id，friends 用 a+b
      const list = Array.isArray(rows) ? rows : [rows];
      const same = table === 'friends'
        ? (x, r) => x.a === r.a && x.b === r.b
        : (x, r) => x.conv === r.conv && x.user_id === r.user_id;
      list.forEach((r) => {
        const i = DATA[table].findIndex((x) => same(x, r));
        if (i >= 0) DATA[table][i] = Object.assign({}, DATA[table][i], r);
        else DATA[table].push(r);
      });
      res = list;
      return b;
    },
    update(patch) {
      // 惰性：把 patch 记下，等 .then()（filters 补全）再应用，避免 update().eq() 链里 update 先于 eq 执行
      pendingOp = { type: 'update', patch };
      return b;
    },
    delete() { pendingOp = { type: 'delete' }; return b; },
    then(fn) {
      if (pendingOp) {
        if (pendingOp.type === 'update') {
          matchRows().forEach((r) => Object.assign(r, pendingOp.patch));
          res = matchRows();
        } else {
          const del = matchRows();
          del.forEach((r) => { const i = DATA[table].indexOf(r); if (i >= 0) DATA[table].splice(i, 1); });
          res = del;
        }
        pendingOp = null;
      }
      let rows = res !== null ? res.slice() : (DATA[table] || []).slice();
      if (res === null) {
        filters.forEach(function (f) {
          if (f[2] === '=') rows = rows.filter((r) => String(r[f[0]]) === String(f[1]));
          else if (f[2] === '>') rows = rows.filter((r) => Number(r[f[0]]) > Number(f[1]));
          else rows = rows.filter((r) => Number(r[f[0]]) < Number(f[1]));
        });
      }
      if (ord) rows.sort((x, y) => (x[ord[0]] > y[ord[0]] ? ord[1] : x[ord[0]] < y[ord[0]] ? -ord[1] : 0));
      if (lim && rows.length > lim) rows = ord && ord[1] === -1 ? rows.slice(0, lim) : rows.slice(-lim);
      return Promise.resolve({ data: rows, error: null }).then(fn);
    },
  };
  return b;
}
['profiles', 'groups', 'group_members', 'friends', 'reads', 'messages', 'live'].forEach((t) => { TABLE[t] = () => builder(t); });

let __updates = [];
let __updateFail = false;      // 置 true 时模拟网关「落盘成功但响应报 404」
let __existsCalls = 0;
let __puts = [];               // 手动 PUT 兜底的调用记录
let __weatherOk = true;        // open-meteo 天气源是否可用
function makeStub() {
  return {
    createWorkBuddyCloud(opts) {
      if (!opts.endpoint || !opts.publishableKey) throw new Error('缺少 endpoint/publishableKey');
      return {
        _opts: opts,
        auth: {
          getSession: () => Promise.resolve({ data: { user: { id: 'u_test' } }, error: null }),
          getAccessToken: () => Promise.resolve('tok_test'),
          signOut: () => Promise.resolve({ data: null, error: null }),
        },
        database: { from: (t) => TABLE[t]() },
        storage: {
          sharedPath: (uid, p) => 'shared/' + uid + '/' + p,
          upload: () => Promise.resolve({ data: { path: 'shared/u_test/x' }, error: null }),
          update: (path, file, opts) => {
            __updates.push({ path, opts });
            if (__updateFail) return Promise.resolve({ data: null, error: { message: 'HTTP 404: {"code":"STORAGE_BUCKET_NOT_FOUND"}' } });
            return Promise.resolve({ data: { path }, error: null });
          },
          exists: (path) => { __existsCalls += 1; return Promise.resolve({ data: true, error: null }); },
          createSignedUrl: () => Promise.resolve({ data: { signedUrl: 'https://example.com/x' }, error: null }),
        },
      };
    },
  };
}

// 预置另外两名大厅成员，便于验证建群时可拉人（last_seen 设为一小时前 = 不在线，让小美回复由本端代发）
['u_a', 'u_b'].forEach((id, i) => {
  DATA.profiles.push({ id, nickname: i ? '乙' : '甲', avatar: '', color: i ? '#555' : '#e8644a', last_seen: new Date(Date.now() - 3600000).toISOString(), created_at: new Date().toISOString() });
  DATA.group_members.push({ group_id: 'hall', user_id: id });
});

(async () => {
  console.log('\n== LanTalk 云端版 逻辑冒烟 ==\n');
  const vc = new VirtualConsole();
  vc.on('log', (...a) => console.log('[page]', ...a));
  vc.on('jsdomError', (e) => console.log('[jsdomError]', e && e.message, e && e.detail && e.detail.stack));
  const dom = new JSDOM(html, {
    url: 'https://lan-talk.app.workbuddy.host/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(win) {
      win.WorkBuddyCloud = makeStub();
      // 拦截网络：上传/天气源返回可配置的固定响应（其余一律断网，验证页面不依赖其他网络请求）
      win.__uploads = [];
      win.fetch = (u, o) => {
        const url = String(u);
        const method = (o && o.method) || 'GET';
        if (url.indexOf('/.cloud/storage/object/') >= 0 && method === 'POST') {
          win.__uploads.push({ url, hasAuth: !!(o.headers && o.headers.Authorization), hasUpsert: !!(o.headers && ('x-upsert' in o.headers)) });
          return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(''), json: () => Promise.resolve({}) });
        }
        if (url.indexOf('/.cloud/storage/object/') >= 0 && method === 'PUT') {
          __puts.push({ url, hasAuth: !!(o.headers && o.headers.Authorization) });
          return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(''), json: () => Promise.resolve({}) });
        }
        if (url.indexOf('geocoding-api.open-meteo.com') >= 0) {
          if (!__weatherOk) return Promise.reject(new Error('weather down'));
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ results: [{ name: '北京', latitude: 39.9, longitude: 116.4 }] }) });
        }
        if (url.indexOf('api.open-meteo.com') >= 0) {
          if (!__weatherOk) return Promise.reject(new Error('weather down'));
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve({
              current: { temperature_2m: 21.3, apparent_temperature: 20.1, relative_humidity_2m: 40, weather_code: 1, wind_speed_10m: 9.2 },
              daily: { time: ['2026-09-18', '2026-09-19'], temperature_2m_max: [26, 27], temperature_2m_min: [15, 16], weather_code: [0, 2] },
            }),
          });
        }
        return Promise.reject(new Error('no network in test'));
      };
      win.Notification = undefined;
    },
  });
  const w = dom.window;
  w.addEventListener('error', (e) => errors.push('error: ' + ((e.error && e.error.stack) || e.message)));
  w.addEventListener('unhandledrejection', (e) => errors.push('rejection: ' + e.reason));
  await sleep(500);
  const D = w.document;

  // 1. 未设昵称 -> 停在昵称页
  log(!D.querySelector('#join').classList.contains('hidden'), '已登录但未设昵称：显示昵称设置页');
  log(D.querySelectorAll('#jEmo span').length > 20, '表情头像候选已渲染', D.querySelectorAll('#jEmo span').length);

  // 2. 设置昵称进入
  D.querySelector('#jName').value = '云端测试';
  D.querySelector('#jName').dispatchEvent(new w.Event('input', { bubbles: true }));
  D.querySelectorAll('#jEmo span')[5].click();
  D.querySelector('#jGo').click();
  await sleep(800);

  log(D.querySelector('#join').classList.contains('hidden'), '设置昵称后进入主界面');
  const mine = DATA.profiles.filter((p) => p.id === 'u_test');
  log(mine.length === 1 && mine[0].nickname === '云端测试' && mine[0].avatar === '😊', '昵称与表情头像已写入云端 profiles', JSON.stringify(mine.map((p) => p.nickname + p.avatar)));
  log(DATA.group_members.some((m) => m.group_id === 'hall' && m.user_id === 'u_test'), '自动加入大厅');
  log(D.querySelector('#cName').textContent === '大厅', '默认打开大厅会话', D.querySelector('#cName').textContent);
  log(D.querySelector('#cList').textContent.indexOf('大厅') >= 0, '侧栏显示大厅');

  // 3. 发消息
  D.querySelector('#input').value = '云端第一条消息';
  D.querySelector('#bSend').click();
  await sleep(600);
  const sent = DATA.messages.filter((m) => m.text === '云端第一条消息');
  log(sent.length === 1 && sent[0].conv === 'g:hall' && sent[0].sender_name === '云端测试' && sent[0].sender_id === 'u_test',
    '消息写入云端 messages 表', '匹配 ' + sent.length + ' 条');
  log(D.querySelector('#mList').textContent.indexOf('云端第一条消息') >= 0, '消息渲染到界面');

  // 4. 撤回
  const revokeBtn = Array.prototype.filter.call(D.querySelectorAll('#mList .ops button'), (b) => b.dataset.a === 'revoke')[0];
  log(!!revokeBtn, '自己的消息出现撤回按钮');
  if (revokeBtn) {
    const revId = revokeBtn.dataset.i;
    revokeBtn.click();
    await sleep(500);
    // 撤回后 text 被清空，故按消息 id 定位并验证 revoked 标记
    log(DATA.messages.some((m) => String(m.id) === String(revId) && m.revoked === true), '撤回后云端记录标记 revoked');
  }

  // 5. 建群：从大厅成员里选 2 人 + 创建
  D.querySelector('#bNew').click();
  await sleep(400);
  const chips = D.querySelectorAll('#nhp .chip');
  log(chips.length === 3 && D.querySelector('#nhp').textContent.indexOf('小美') >= 0,
    '建群弹窗列出大厅其他成员（甲、乙、小美）', chips.length);
  chips[0].click(); chips[1].click();
  await sleep(200);
  log(D.querySelectorAll('#ns .chip').length === 2, '已选中 2 位成员');
  D.querySelector('#ng').value = '测试群';
  D.querySelector('#ncreate').click();
  await sleep(900);
  const g = DATA.groups.filter((x) => x.name === '测试群')[0];
  log(!!g, '群聊已写入云端 groups 表');
  log(!!g && DATA.group_members.filter((m) => m.group_id === g.id).length === 3, '群成员（含自己）写入 group_members');
  log(D.querySelector('#cName').textContent === '测试群', '创建后自动进入新群', D.querySelector('#cName').textContent);

  // 6. 点头像开私聊
  D.querySelector('#input').value = '大家好';
  D.querySelector('#bSend').click();
  await sleep(500);
  const av = D.querySelector('#mList .mav');
  log(!!av && av.dataset.u === 'u_test', '消息头像带发送者 id（自己的不可点）');

  // 表情面板：能开、能关
  const epop = D.querySelector('#epop');
  const bEmo = D.querySelector('#bEmo');
  log(!!epop && epop.classList.contains('hidden'), '表情面板初始是关闭的');

  // 模拟按钮在视口 y=700 处；jsdom 无排版，手造 rect 才能验证定位是否遮挡按钮
  const btnRect = { x: 300, y: 700, top: 700, bottom: 730, left: 300, right: 330, width: 30, height: 30 };
  bEmo.getBoundingClientRect = () => btnRect;

  bEmo.click();
  log(!epop.classList.contains('hidden') && epop.querySelectorAll('span').length > 10, '点表情按钮弹出表情面板');
  log(!!D.querySelector('#epopClose'), '面板里有「关闭 ✕」按钮');

  // 面板定位不能盖住触发按钮（否则按钮点不到就再也关不掉）
  const popTop = parseFloat(epop.style.top || '-1');
  const popBottom = popTop + 210;
  log(popBottom <= btnRect.top || popTop >= btnRect.bottom,
    '面板定位不遮挡表情按钮（面板 ' + popTop + '~' + popBottom + '，按钮 ' + btnRect.top + '~' + btnRect.bottom + '）');

  // 1) 选表情后自动关闭
  epop.querySelector('span').click();
  log(epop.classList.contains('hidden'), '选中表情后面板自动关闭');
  log(D.querySelector('#input').value.indexOf('😀') >= 0, '表情已插入输入框', JSON.stringify(D.querySelector('#input').value));
  D.querySelector('#input').value = '';

  // 2) 再点按钮可反复开关
  bEmo.click();
  log(!epop.classList.contains('hidden'), '再次点击按钮可打开');
  bEmo.click();
  log(epop.classList.contains('hidden'), '再次点击按钮可关闭（按钮未被面板遮住）');

  // 3) 点空白关闭
  bEmo.click();
  D.body.click();
  log(epop.classList.contains('hidden'), '点击空白处关闭面板');

  // 4) 点关闭按钮
  bEmo.click();
  D.querySelector('#epopClose').click();
  log(epop.classList.contains('hidden'), '点「关闭 ✕」关闭面板');

  // 5) Esc 关闭
  bEmo.click();
  D.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  log(epop.classList.contains('hidden'), '按 Esc 关闭面板');

  // ===== 需求 1：Ctrl+V 粘贴图片 -> 先进待发送区，还能输入文字，点发送才发 =====
  const pv = new w.Event('paste', { bubbles: true, cancelable: true });
  const imgFile = new w.File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' });
  pv.clipboardData = { items: [{ kind: 'file', type: 'image/png', getAsFile: () => imgFile }] };
  const nBefore = DATA.messages.length;
  D.querySelector('#input').dispatchEvent(pv);
  await sleep(700);
  log(DATA.messages.length === nBefore, '粘贴图片：不立刻发送（此时还没有产生新消息）');
  const attBar = D.querySelector('#attBar');
  log(!attBar.classList.contains('hidden') && attBar.querySelectorAll('.attchip').length === 1,
    '粘贴的图片出现在输入框上方的待发送区', attBar.textContent);
  log(w.__uploads.length === 0 && __updates.length === 0, '未点发送前不会上传');

  // 还能继续输入文字，再点发送
  D.querySelector('#input').value = '看看这张图';
  D.querySelector('#bSend').click();
  await sleep(1400);
  const pasted = DATA.messages.filter((m) => m.type === 'image');
  log(pasted.length === 1, '点发送后发出 1 条图片消息');
  log(pasted.length === 1 && /^shared\/u_test\/chat\/\d+-paste-\d{8}-\d{6}\.png$/.test(pasted[0].file_path),
    '上传路径符合云端存储约定', pasted.length ? pasted[0].file_path : '');
  log(pasted.length === 1 && pasted[0].text === '看看这张图', '文字和图片一起发出（一条带说明的图片消息）',
    pasted.length ? JSON.stringify(pasted[0].text) : 'none');
  log(attBar.classList.contains('hidden'), '发送后待发送区清空');
  log(__updates.length === 1 && /^shared\/u_test\/chat\//.test(__updates[0].path),
    '上传走 SDK update（PUT，无 x-upsert 头，规避 CORS 预检失败）', JSON.stringify(__updates));
  log(__updates.length === 1 && __updates[0].opts && __updates[0].opts.contentType === 'image/png',
    '上传带正确 contentType', JSON.stringify(__updates[0] && __updates[0].opts));

  // ===== 需求 3：好友请求实时到达 + 直接显示在列表 + 处理完消失 =====
  DATA.friends.push({ a: 'u_a', b: 'u_test', status: 'pending', message: 'hi', created_at: new Date().toISOString() });
  await sleep(3300);
  const reqEntry = D.querySelector('#cList .conv.req[data-u="u_a"]');
  log(!!reqEntry, '对方发来请求：好友请求条目直接出现在左侧列表（不用刷新）');
  log(!!reqEntry && reqEntry.textContent.indexOf('想加你为好友') >= 0, '请求条目显示「想加你为好友」文案', reqEntry ? reqEntry.textContent : 'none');
  if (reqEntry) reqEntry.querySelector('.req-acts .ok').click();
  await sleep(900);
  log(DATA.friends.some((f) => f.a === 'u_a' && f.b === 'u_test' && f.status === 'accepted'),
    '接受后好友关系变为 accepted', JSON.stringify(DATA.friends));
  log(D.querySelector('#cList .conv.req[data-u="u_a"]') === null, '处理完后好友请求条目消失');
  const convKeys = Array.prototype.map.call(D.querySelectorAll('#cList .conv'), (e) => e.dataset.c);
  log(convKeys.indexOf('p:u_a~u_test') >= 0, '接受后私聊会话出现在侧栏', JSON.stringify(convKeys));

  // ===== 需求 2：已读 / 未读 =====
  const pri = Array.prototype.filter.call(D.querySelectorAll('#cList .conv'), (e) => e.dataset.c === 'p:u_a~u_test')[0];
  pri.click();
  await sleep(700);
  log(D.querySelector('#cName').textContent === '甲', '打开与「甲」的私聊', D.querySelector('#cName').textContent);
  D.querySelector('#input').value = '在吗';
  D.querySelector('#bSend').click();
  await sleep(900);
  const myMsg = DATA.messages.filter((m) => m.conv === 'p:u_a~u_test' && m.sender_id === 'u_test' && m.type === 'text')[0];
  log(!!myMsg, '私聊消息已发出');
  const rd1 = D.querySelector('#mList .m.self .rd');
  log(!!rd1 && rd1.textContent === '未读', '对方还没看：显示「未读」', rd1 ? rd1.textContent : 'none');
  log(DATA.reads.some((r) => r.conv === 'p:u_a~u_test' && r.user_id === 'u_test'), '我打开会话时写入了自己的已读位置');

  DATA.reads.push({ conv: 'p:u_a~u_test', user_id: 'u_a', last_msg_id: myMsg.id + 100, updated_at: new Date().toISOString() });
  await sleep(11500); // 等一次重轮询（每 4 次 tick 拉一次 reads）
  const rd2 = D.querySelector('#mList .m.self .rd');
  log(!!rd2 && rd2.textContent === '已读', '对方已读后自动变成「已读」', rd2 ? rd2.textContent : 'none');

  // ===== 群聊（大厅）已读详情 =====
  const hallConv = Array.prototype.filter.call(D.querySelectorAll('#cList .conv'), (e) => e.dataset.c === 'g:hall')[0];
  hallConv.click();
  await sleep(700);
  D.querySelector('#input').value = '群已读测试';
  D.querySelector('#bSend').click();
  await sleep(900);
  const gMsg = DATA.messages.filter((m) => m.conv === 'g:hall' && m.sender_id === 'u_test' && m.text === '群已读测试')[0];
  log(!!gMsg, '大厅消息已发出');
  const grd0 = D.querySelector('#mList .m.self .rd');
  log(!!grd0 && grd0.textContent === '0/2 已读', '群聊 0 人已读也显示「0/2 已读」', grd0 ? grd0.textContent : 'none');
  DATA.reads.push({ conv: 'g:hall', user_id: 'u_a', last_msg_id: gMsg.id, updated_at: new Date().toISOString() });
  await sleep(11500);
  const grd1 = D.querySelector('#mList .m.self .rd');
  log(!!grd1 && grd1.textContent === '1/2 已读', '1 人已读后显示「1/2 已读」', grd1 ? grd1.textContent : 'none');
  grd1.click();
  await sleep(400);
  const mh = D.querySelector('#modal').textContent;
  log(mh.indexOf('已读详情') >= 0 && mh.indexOf('甲') >= 0 && mh.indexOf('乙') >= 0, '点击「1/2 已读」弹出详情弹窗', mh.slice(0, 60));
  log(/已读（1）/.test(mh) && /未读（1）/.test(mh) && mh.indexOf('甲') < mh.indexOf('乙'), '详情正确：甲已读、乙未读');

  // ===== 重复点「加为好友」不再报错 =====
  // 先关掉已读详情弹窗、回到与「甲」的私聊（好友按钮在私聊资料面板里）
  const mclose = D.querySelector('#modal .acts .btn');
  if (mclose) mclose.click();
  await sleep(200);
  const pri2 = Array.prototype.filter.call(D.querySelectorAll('#cList .conv'), (e) => e.dataset.c === 'p:u_a~u_test')[0];
  pri2.click();
  await sleep(500);
  D.querySelector('#bInfo').click();
  await sleep(400);
  const dfBtn = D.querySelector('#dfBtn');
  log(!!dfBtn, '已是好友：显示「删除好友」');
  if (dfBtn) dfBtn.click();
  await sleep(300);
  const cfOk = D.querySelector('#modal #cfOk');
  if (cfOk) cfOk.click();
  await sleep(1000);
  const afBtn = D.querySelector('#afBtn');
  log(!!afBtn, '删除好友后显示「加为好友」');
  if (afBtn) { afBtn.click(); afBtn.click(); } // 连点两次
  await sleep(1200);
  const dup = DATA.friends.filter((f) => (f.a === 'u_test' && f.b === 'u_a') || (f.a === 'u_a' && f.b === 'u_test'));
  log(dup.length === 1, '连点两次只产生 1 条请求（不再撞主键报错）', JSON.stringify(dup));
  log(dup.length === 1 && dup[0].status === 'pending', '请求状态为 pending');
  log(!!D.querySelector('#cfBtn'), '按钮变「撤销」，无法重复发送');
  const toastTxt = D.querySelector('#toasts').textContent;
  log(toastTxt.indexOf('失败') < 0, '连点两次没有报错提示', toastTxt);

  // ===== 需求 2：点图片弹大图，而不是直接下载 =====
  const grpConv = Array.prototype.filter.call(D.querySelectorAll('#cList .conv'), (e) => e.textContent.indexOf('测试群') >= 0)[0];
  if (grpConv) grpConv.click();
  await sleep(700);
  const imgEl = D.querySelector('#mList img[data-t="image"]');
  log(!!imgEl, '图片消息渲染为可点击的图片元素');
  if (imgEl) {
    imgEl.click();
    await sleep(500);
    const vw = D.querySelector('#viewer');
    log(!vw.classList.contains('hidden'), '点图片弹出大图查看器（不再直接下载）');
    log((vw.querySelector('#viewerImg').getAttribute('src') || '').indexOf('example.com') >= 0,
      '查看器里加载的是云端原图', vw.querySelector('#viewerImg').getAttribute('src'));
    log(!!D.querySelector('#viewerDl'), '查看器里保留「下载原图」入口');
    D.querySelector('#viewerClose').click();
    log(vw.classList.contains('hidden'), '点 ✕ 关闭大图');
    imgEl.click();
    await sleep(300);
    D.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    log(vw.classList.contains('hidden'), '按 Esc 关闭大图');
  }

  // ===== 需求 3：未读强提醒（标题闪烁 + 侧栏脉动 + 页签闪烁）=====
  DATA.messages.push({
    id: ++seq, conv: 'g:hall', sender_id: 'u_a', sender_name: '甲', sender_avatar: '', sender_color: '#e8644a',
    type: 'text', text: '在吗在吗', mentions: [], created_at: new Date().toISOString(),
  });
  await sleep(3400);
  log(/新消息|\(\d+\)/.test(D.title), '收到未读：浏览器标题变成闪烁的新消息提醒', D.title);
  log(D.body.classList.contains('unread-glow') === false, '窗口可见时不加红色描边（未读提醒走标题闪烁）');
  const hallEl = Array.prototype.filter.call(D.querySelectorAll('#cList .conv'), (e) => e.dataset.c === 'g:hall')[0];
  if (hallEl) hallEl.click();
  await sleep(900);
  log(D.title.indexOf('新消息') < 0 && !/\(\d+\)/.test(D.title), '点开会话读完：标题恢复正常', D.title);

  // ===== 需求 4：气氛组机器人小美 =====
  if (D.querySelector('#info').classList.contains('hidden')) D.querySelector('#bInfo').click();
  await sleep(600);
  log(D.querySelector('#info').textContent.indexOf('小美') >= 0, '大厅成员列表里有小美',
    D.querySelector('#info').textContent.slice(0, 60));
  D.querySelector('#input').value = '@小美 你好呀';
  D.querySelector('#bSend').click();
  await sleep(2600);
  const botMsgs = DATA.messages.filter((m) => m.sender_id === 'bot_xiaomei');
  log(botMsgs.length >= 1, '@小美 之后她会自动接话', JSON.stringify(botMsgs.map((m) => m.text)));
  log(botMsgs.length >= 1 && botMsgs[0].sender_name === '小美' && botMsgs[0].conv === 'g:hall',
    '小美以「小美」的身份在大厅发言');
  log(D.querySelector('#mList').textContent.indexOf('小美') >= 0, '小美的消息渲染在聊天区');

  // ===== 本轮修复：侧栏不再有分类 tab =====
  log(D.querySelector('.tabs') === null, '侧栏分类 tab（全部/未读/群聊/好友）已移除');
  log(D.querySelector('#uTotal') === null, '旧的未读数字徽标已移除');
  log(D.querySelector('#bReq') === null && D.querySelector('#rBadge') === null, '好友请求按钮已移除（改为列表内展示）');
  log(D.querySelector('#bSet') !== null, '左下角新增「设置」入口按钮');
  log(D.querySelector('#sRow') !== null && !D.querySelector('#sRow').classList.contains('hidden'), '搜索框常显（不再需要搜索按钮）');

  // ===== 本轮修复：小美 24 小时在线 =====
  // 在大厅成员列表点小美头像，打开与她的私聊，头部应显示「在线」
  const xiaomeiMem = D.querySelector('#info .mem[data-u="bot_xiaomei"]');
  if (xiaomeiMem) xiaomeiMem.click();
  await sleep(800);
  log(D.querySelector('#cSub') && D.querySelector('#cSub').textContent === '在线',
    '打开与小美的私聊，头部显示「在线」（24 小时在线）', D.querySelector('#cSub') && D.querySelector('#cSub').textContent);

  // ===== 本轮修复：消息不重复显示 =====
  // 切回大厅，同一消息 id 重复到达（模拟轮询再次推送到 onNew），应只保留一条
  const hallConv2 = Array.prototype.filter.call(D.querySelectorAll('#cList .conv'), (e) => e.dataset.c === 'g:hall')[0];
  if (hallConv2) hallConv2.click();
  await sleep(600);
  const dupMsg = { id: ++seq, conv: 'g:hall', sender_id: 'u_a', sender_name: '甲', sender_avatar: '', sender_color: '#e8644a', type: 'text', text: '去重测试', mentions: [], created_at: new Date().toISOString() };
  DATA.messages.push(dupMsg);
  await sleep(3400);
  const mListText = D.querySelector('#mList').textContent;
  const cnt = (mListText.match(/去重测试/g) || []).length;
  log(cnt === 1, '同一消息 id 重复到达时只显示一条（不重复）', '出现次数=' + cnt);

  // ===== 本轮修复：好友备注显示 =====
  // 通过真实 UI：打开甲的私聊 -> 信息面板 -> 修改备注 -> 保存 -> 头部/侧栏显示备注
  let fRel = DATA.friends.find((x) => x.a === 'u_test' && x.b === 'u_a');
  if (!fRel) { DATA.friends.push({ a: 'u_test', b: 'u_a', status: 'accepted', message: '', remark_a: '', remark_b: '', created_at: new Date().toISOString() }); fRel = DATA.friends[DATA.friends.length - 1]; }
  fRel.status = 'accepted';
  const jiaConv = Array.prototype.filter.call(D.querySelectorAll('#cList .conv'), (e) => e.dataset.c === 'p:u_a~u_test')[0]
    || Array.prototype.filter.call(D.querySelectorAll('#cList .conv'), (e) => /p:.*u_a/.test(e.dataset.c))[0];
  if (jiaConv) jiaConv.click(); else {
    // 若无私聊条目，先点小美的私聊再点甲的（通过搜索创建）——直接用现有打开逻辑兜底
    const anyMem = D.querySelector('#info .mem[data-u="u_a"]');
    if (anyMem) anyMem.click();
  }
  await sleep(800);
  // 打开信息面板
  D.querySelector('#bInfo').click();
  await sleep(400);
  const rmBtn = D.querySelector('#rmBtn');
  if (rmBtn) {
    rmBtn.click();
    await sleep(300);
    const pb = D.querySelector('#pb');
    if (pb) { pb.value = '老甲'; }
    D.querySelector('#pbOk').click();
    await sleep(800);
    log(D.querySelector('#cName').textContent === '老甲', '修改备注后，会话头部显示备注名', D.querySelector('#cName').textContent);
    const names = Array.prototype.map.call(D.querySelectorAll('#cList .conv .cnm'), (e) => e.textContent);
    log(names.indexOf('老甲') >= 0, '侧栏会话名同步显示备注', JSON.stringify(names));
  } else {
    log(false, '打开甲的私聊信息面板后出现「修改备注」按钮');
  }

  // ===== 本轮：上传网关 404 误报也能发出去（update 报错 -> exists 验证已落盘 -> 视为成功）=====
  const hallBack = Array.prototype.filter.call(D.querySelectorAll('#cList .conv'), (e) => e.dataset.c === 'g:hall')[0];
  if (hallBack) hallBack.click();
  await sleep(600);
  const pv2 = new w.Event('paste', { bubbles: true, cancelable: true });
  const imgFile2 = new w.File([new Uint8Array([137, 80, 78, 71])], 'b404.png', { type: 'image/png' });
  pv2.clipboardData = { items: [{ kind: 'file', type: 'image/png', getAsFile: () => imgFile2 }] };
  D.querySelector('#input').dispatchEvent(pv2);
  await sleep(500);
  __updateFail = true;
  D.querySelector('#bSend').click();
  await sleep(2000);
  // 粘贴的图片会被重命名为 paste-<时间戳>.png（产品设计：粘贴截图无原始文件名）
  const b404 = DATA.messages.filter((m) => m.type === 'image' && /^paste-.*\.png$/.test(m.file_name || ''));
  log(b404.length === 2, 'update 报 404 但对象已落盘（exists）-> 图片消息照常发出', '消息数=' + b404.length);
  log(__existsCalls >= 1, '失败后用 exists 验证落盘状态', 'exists 调用 ' + __existsCalls + ' 次');
  log(D.querySelector('#toasts').textContent.indexOf('发送失败') < 0, '用户侧不再看到「发送失败」红字');
  __updateFail = false;

  // ===== 本轮：回复图片消息显示缩略图，点击弹大图 =====
  DATA.messages.push({
    id: ++seq, conv: 'g:hall', sender_id: 'u_a', sender_name: '甲', sender_avatar: '', sender_color: '#e8644a',
    type: 'text', text: '看这张',
    reply_to: { id: 999, senderName: '乙', text: '', file_path: 'shared/u_b/chat/old.png', file_type: 'image', file_name: 'old.png' },
    mentions: [], created_at: new Date().toISOString(),
  });
  await sleep(3400);
  const qimg = D.querySelector('#mList .quote.qimg');
  log(!!qimg && !!qimg.querySelector('img.qthumb'), '回复图片的消息在引用条里显示缩略图（不再是纯文件名）');
  log(!!qimg && qimg.dataset.f === 'shared/u_b/chat/old.png', '缩略图引用条带原图路径');
  if (qimg) {
    qimg.click();
    await sleep(600);
    const vw2 = D.querySelector('#viewer');
    log(!vw2.classList.contains('hidden'), '点击回复里的图片直接弹出大图');
    D.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    log(vw2.classList.contains('hidden'), 'Esc 可关闭该大图');
  }

  // ===== 本轮：点击聊天头像直接艾特 =====
  const otherMav = D.querySelector('#mList .mav[data-u="u_a"]');
  log(!!otherMav, '别人的消息头像可点');
  if (otherMav) {
    D.querySelector('#input').value = '';
    otherMav.click();
    log(D.querySelector('#input').value.indexOf('@甲') >= 0, '点击头像直接在输入框插入 @昵称', JSON.stringify(D.querySelector('#input').value));
    otherMav.click();
    const v2 = D.querySelector('#input').value;
    log((v2.match(/@甲/g) || []).length === 1, '重复点同一头像不会重复插入', JSON.stringify(v2));
  }

  // ===== 本轮：小美技能箱 =====
  async function botTalk(text, waitMs) {
    const n0 = DATA.messages.filter((m) => m.sender_id === 'bot_xiaomei').length;
    D.querySelector('#input').value = text;
    D.querySelector('#bSend').click();
    await sleep(waitMs || 2600);
    const arr = DATA.messages.filter((m) => m.sender_id === 'bot_xiaomei');
    return arr.length > n0 ? arr[arr.length - 1].text : '(无回复)';
  }
  const tJoke = await botTalk('@小美 讲个笑话');
  log(tJoke.length > 10, '「讲个笑话」有回复', tJoke.slice(0, 30));
  const tMenu = await botTalk('@小美 你能干什么');
  log(tMenu.indexOf('笑话') >= 0 && tMenu.indexOf('古诗') >= 0 && tMenu.indexOf('天气') >= 0,
    '问「你能干什么」输出技能菜单（带 6 个序号技能）', tMenu.slice(0, 40).replace(/\n/g, ' '));
  const tNum = await botTalk('@小美 2');
  log(tNum.length > 20 && tNum !== '(无回复)', '菜单后直接回复序号 2 -> 触发讲故事', tNum.slice(0, 30));
  const tPoem = await botTalk('@小美 来首古诗');
  log(tPoem.indexOf('《') >= 0, '「来首古诗」返回古诗（带书名号标题）', tPoem.slice(0, 24));
  const tW = await botTalk('@小美 北京天气', 3200);
  log(tW.indexOf('°C') >= 0 && tW.indexOf('北京') >= 0, '「北京天气」返回 open-meteo 真实天气', tW.slice(0, 40).replace(/\n/g, ' '));
  const tN = await botTalk('@小美 看看新闻', 3600);
  log(tN.indexOf('新闻') >= 0, '「看新闻」有响应（测试环境源全挂 -> 走降级文案）', tN.slice(0, 36).replace(/\n/g, ' '));

  // ===== 本轮：手机端侧栏 ☰ / 遮罩 =====
  log(D.querySelector('#bSide') !== null, '侧栏 ☰ 展开按钮存在（窄屏下显示）');
  const sideEl = D.querySelector('.side');
  D.querySelector('#bSide').click();
  log(sideEl.classList.contains('open') && !D.querySelector('#sideMask').classList.contains('hidden'), '点 ☰ 展开侧栏并显示遮罩');
  D.querySelector('#sideMask').click();
  log(!sideEl.classList.contains('open'), '点遮罩收起侧栏');

  // ===== 本轮修复：侧栏「未读红点」与「最新消息预览」同步 =====
  // 场景：与「甲」私聊，切到大厅；甲连发 2 条 -> 侧栏该会话应出现红点 2 且预览为最后一条
  const priA = Array.prototype.filter.call(D.querySelectorAll('#cList .conv'), (e) => e.dataset.c === 'p:u_a~u_test')[0];
  if (priA) priA.click();
  await sleep(700);
  const hallEl2 = Array.prototype.filter.call(D.querySelectorAll('#cList .conv'), (e) => e.dataset.c === 'g:hall')[0];
  if (hallEl2) hallEl2.click();          // 离开私聊，切到大厅（此时甲的消息算未读）
  await sleep(700);
  DATA.messages.push({ id: ++seq, conv: 'p:u_a~u_test', sender_id: 'u_a', sender_name: '甲', sender_avatar: '', sender_color: '#e8644a', type: 'text', text: '同步测试第一条', mentions: [], created_at: new Date().toISOString() });
  DATA.messages.push({ id: ++seq, conv: 'p:u_a~u_test', sender_id: 'u_a', sender_name: '甲', sender_avatar: '', sender_color: '#e8644a', type: 'text', text: '同步测试第二条', mentions: [], created_at: new Date().toISOString() });
  await sleep(3400);
  const priEl = Array.prototype.filter.call(D.querySelectorAll('#cList .conv'), (e) => e.dataset.c === 'p:u_a~u_test')[0];
  log(!!priEl, '私聊会话仍在侧栏');
  const badge = priEl ? priEl.querySelector('.badge') : null;
  log(!!badge && badge.textContent === '2', '侧栏未读红点显示 2 条', badge ? badge.textContent : 'none');
  const lastTxt = priEl ? priEl.querySelector('.clast').textContent : '';
  log(lastTxt.indexOf('同步测试第二条') >= 0, '侧栏最新消息预览为最后一条', lastTxt);
  const sortedFirst = D.querySelectorAll('#cList .conv')[0];
  log(sortedFirst && sortedFirst.dataset.c === 'p:u_a~u_test', '有新消息的会话置顶', sortedFirst ? sortedFirst.dataset.c : 'none');
  // 等一次 heavy 轮询（每 4 tick = 10s），确认红点不会被 buildConvs 冲掉
  await sleep(11000);
  const priEl2 = Array.prototype.filter.call(D.querySelectorAll('#cList .conv'), (e) => e.dataset.c === 'p:u_a~u_test')[0];
  const badge2 = priEl2 ? priEl2.querySelector('.badge') : null;
  log(!!badge2 && badge2.textContent === '2', 'heavy 轮询后未读红点仍为 2（不再被冲掉）', badge2 ? badge2.textContent : 'none');
  const lastTxt2 = priEl2 ? priEl2.querySelector('.clast').textContent : '';
  log(lastTxt2.indexOf('同步测试第二条') >= 0, 'heavy 轮询后最新消息预览仍正确', lastTxt2);
  // 点开该会话 -> 红点消失，且预览保持
  priEl2.click();
  await sleep(900);
  const priEl3 = Array.prototype.filter.call(D.querySelectorAll('#cList .conv'), (e) => e.dataset.c === 'p:u_a~u_test')[0];
  log(!priEl3.querySelector('.badge'), '点开会话后未读红点消失');
  log(priEl3.querySelector('.clast').textContent.indexOf('同步测试第二条') >= 0, '读完后预览仍为最后一条');
  // 切回大厅，便于后续直播用例
  const hallEl3 = Array.prototype.filter.call(D.querySelectorAll('#cList .conv'), (e) => e.dataset.c === 'g:hall')[0];
  if (hallEl3) hallEl3.click();
  await sleep(700);

  // ===== 本轮修复：自己发消息后，侧栏预览/时间不回退（对应截图 dzp 那条） =====
  DATA.messages.push({ id: ++seq, conv: 'p:u_test~u_b', sender_id: 'u_b', sender_name: '乙', sender_avatar: '', sender_color: '#555', type: 'text', text: '乙的旧消息', mentions: [], created_at: new Date(Date.now() - 3600000).toISOString() });
  DATA.friends.push({ a: 'u_test', b: 'u_b', status: 'accepted', created_at: new Date().toISOString() });
  await sleep(3000);
  const priB = Array.prototype.filter.call(D.querySelectorAll('#cList .conv'), (e) => e.dataset.c === 'p:u_b~u_test')[0];
  if (priB) priB.click();
  await sleep(800);
  D.querySelector('#input').value = '我刚发的最后一条';
  D.querySelector('#bSend').click();
  await sleep(900);
  const priB2 = Array.prototype.filter.call(D.querySelectorAll('#cList .conv'), (e) => e.dataset.c === 'p:u_b~u_test')[0];
  log(!!priB2 && priB2.querySelector('.clast').textContent.indexOf('我刚发的最后一条') >= 0,
    '自己发消息后，侧栏预览立即变为该条', priB2 ? priB2.querySelector('.clast').textContent : 'none');
  // 关键回归：等 heavy 轮询（buildConvs 会重算），预览不能被旧消息顶回去
  await sleep(11000);
  const priB3 = Array.prototype.filter.call(D.querySelectorAll('#cList .conv'), (e) => e.dataset.c === 'p:u_b~u_test')[0];
  log(!!priB3 && priB3.querySelector('.clast').textContent.indexOf('我刚发的最后一条') >= 0,
    'heavy 轮询后侧栏预览仍为自己发的那条（不被 recent 回退）', priB3 ? priB3.querySelector('.clast').textContent : 'none');
  log(!!priB3 && !priB3.querySelector('.badge'), '自己发消息不产生未读红点');

  // 私聊未读：切走后来消息必须有红点
  const hallElX = Array.prototype.filter.call(D.querySelectorAll('#cList .conv'), (e) => e.dataset.c === 'g:hall')[0];
  if (hallElX) hallElX.click();
  await sleep(700);
  DATA.messages.push({ id: ++seq, conv: 'p:u_b~u_test', sender_id: 'u_b', sender_name: '乙', sender_avatar: '', sender_color: '#555', type: 'text', text: '私聊未读测试', mentions: [], created_at: new Date().toISOString() });
  await sleep(3400);
  const priB4 = Array.prototype.filter.call(D.querySelectorAll('#cList .conv'), (e) => e.dataset.c === 'p:u_b~u_test')[0];
  const bdg = priB4 ? priB4.querySelector('.badge') : null;
  log(!!bdg && bdg.textContent === '1', '私聊收到消息：侧栏出现未读红点', bdg ? bdg.textContent : 'none');
  await sleep(11000);
  const priB5 = Array.prototype.filter.call(D.querySelectorAll('#cList .conv'), (e) => e.dataset.c === 'p:u_b~u_test')[0];
  const bdg2 = priB5 ? priB5.querySelector('.badge') : null;
  log(!!bdg2 && bdg2.textContent === '1', 'heavy 轮询后私聊未读红点仍在', bdg2 ? bdg2.textContent : 'none');

  // ===== 本轮：大厅直播 =====
  // 回到大厅
  const hallGo = Array.prototype.filter.call(D.querySelectorAll('#cList .conv'), (e) => e.dataset.c === 'g:hall')[0];
  if (hallGo) hallGo.click();
  await sleep(500);
  log(D.querySelector('#liveBar').classList.contains('hidden'), '无人直播时，公告下无直播提示行');

  // 打开大厅资料页 -> 应有「开启直播」按钮
  D.querySelector('#bInfo').click();
  await sleep(400);
  const lvGo1 = D.querySelector('#liveGo');
  log(!!lvGo1 && lvGo1.textContent.indexOf('开启直播') >= 0, '大厅资料页有「开启直播」入口', lvGo1 ? lvGo1.textContent : 'none');

  // 开启直播
  lvGo1.click();
  await sleep(900);
  log(DATA.live.length === 1 && DATA.live[0].status === 'live', '开启直播写入 live 表（status=live）', JSON.stringify(DATA.live));
  log(DATA.live[0] && DATA.live[0].host_id === 'u_test', '直播记录归属于本人');
  log(!D.querySelector('#live').classList.contains('hidden'), '开启后自动进入直播间浮层');
  log(D.querySelector('#lvAct').textContent === '结束直播', '自己直播时按钮显示「结束直播」', D.querySelector('#lvAct').textContent);

  // 观众视角：另一个人（simulate）此时 startLive 应被唯一索引挡住 / 前端先拦截
  const lvEnd = D.querySelector('#lvAct');
  lvEnd.click();               // 点「结束直播」会弹确认框，先确认结束
  await sleep(300);
  const cOk2 = D.querySelector('#modal #cfOk');
  if (cOk2) cOk2.click();
  await sleep(900);
  log(DATA.live.length === 0, '结束直播后记录被删除', JSON.stringify(DATA.live));
  log(D.querySelector('#live').classList.contains('hidden'), '结束后直播间浮层关闭');
  log(D.querySelector('#liveBar').classList.contains('hidden'), '结束后提示行隐藏');

  // 他人直播：直接塞一条别人的记录，走一次轮询应看到提示行 + 资料页不可开启
  DATA.live.push({ id: 999, host_id: 'u_a', host_name: '甲', host_avatar: '', host_color: '#888', title: '甲的直播', status: 'live', viewers: 0, started_at: new Date().toISOString() });
  await sleep(3000);               // 等一次轮询（2.5s tick）
  log(!D.querySelector('#liveBar').classList.contains('hidden'), '他人直播时，大厅公告下出现提示行');
  log(D.querySelector('#liveBar').textContent.indexOf('大厅直播中') >= 0, '提示行文案为「大厅直播中，点击进入~」', D.querySelector('#liveBar').textContent);

  // 点提示行进入直播间
  D.querySelector('#liveBar').click();
  await sleep(400);
  log(!D.querySelector('#live').classList.contains('hidden'), '点提示行进入直播间');
  log(D.querySelector('#lvHost').textContent.indexOf('甲') >= 0, '直播间显示主播昵称', D.querySelector('#lvHost').textContent);
  log(D.querySelector('#lvAct').textContent === '离开', '观众视角按钮为「离开」', D.querySelector('#lvAct').textContent);
  D.querySelector('#lvAct').click();
  await sleep(300);
  log(D.querySelector('#live').classList.contains('hidden'), '观众点「离开」关闭浮层');

  // 他人直播时，我的资料页不应出现「开启直播」，而应显示可进入
  D.querySelector('#bInfo').click();
  await sleep(400);
  const lvGo2 = D.querySelector('#liveGo');
  log(!!lvGo2 && lvGo2.textContent.indexOf('开启直播') < 0, '他人直播时，资料页入口不再是「开启直播」', lvGo2 ? lvGo2.textContent : 'none');

  // 清理：移除模拟的他人在播记录
  DATA.live.length = 0;
  await sleep(3000);
  log(D.querySelector('#liveBar').classList.contains('hidden'), '主播下线后提示行自动隐藏');

  log(errors.length === 0, '运行期间无 JS 异常', errors.join(' | '));
  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败\n');
  w.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('检查异常:', e); process.exit(1); });
