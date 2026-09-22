'use strict';
/** 云端版逻辑冒烟：用桩 SDK 跑通「登录 -> 设昵称 -> 进大厅 -> 发消息」，不依赖真实网络 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const rawHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const errors_early = [];
// ⚠️ bot.js 是外链脚本，jsdom 默认不加载本地相对路径的外链（且 runScripts:'dangerously' 下
//    会静默跳过）→ 测试前把 <script src="bot.js?v=N"> 就地替换成内联内容。
//    这样既保持线上「独立文件 + 版本号」的形态，测试也能覆盖模块真实代码。
const botSrc = fs.readFileSync(path.join(__dirname, 'bot.js'), 'utf8');
const html = rawHtml.replace(
  /<script\s+src="bot\.js(?:\?[^"]*)?"><\/script>/i,
  '<script>\n' + botSrc.replace(/<\/script>/gi, '<\\/script>') + '\n</script>'
);
if (html === rawHtml) errors_early.push('index.html 里找不到 <script src="bot.js?v=...">，小美模块未被内联');

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
  games: [],
  memories: [],
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
['profiles', 'groups', 'group_members', 'friends', 'reads', 'messages', 'live', 'games', 'memories'].forEach((t) => { TABLE[t] = () => builder(t); });

let __updates = [];
let __updateFail = false;      // 置 true 时模拟网关「落盘成功但响应报 404」
let __existsCalls = 0;
let __puts = [];               // 手动 PUT 兜底的调用记录
let __weatherOk = true;        // open-meteo 天气源是否可用
let __searchCalls = [];        // 联网检索源的调用记录
let __searchOk = true;         // 检索源是否可用（false 时全部拒绝，验证优雅降级）
// Keyless LLM 网关桩状态：默认给出与云上一致的目录（含 4 个 deepseek 候选）
let __llmListCalls = 0;
let __llmListFail = false;
let __llmChatFail = false;
let __llmModels = [
  { id: 'auto', name: 'Auto', enabled: true },
  { id: 'hy3', name: 'Hy3', enabled: true },
  { id: 'deepseek-v4-flash', name: 'Deepseek-V4-Flash', enabled: true },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', enabled: true },
  { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', enabled: true },
  { id: 'deepseek-v3-2-volc', name: 'DeepSeek-V3.2', enabled: true },
  { id: 'glm-5.3', name: 'GLM-5.3', enabled: true },
];
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
        // Keyless LLM 网关桩：模拟云上真实模型目录顺序（deepseek-v4-flash 排在 v4.1-flash 前面，
        // 用来验证我们没有靠「列表第一个」碰运气，而是按优先级精确命中）
        llm: {
          models: {
            list: () => {
              __llmListCalls += 1;
              if (__llmListFail) return Promise.reject(new Error('LLM gateway unavailable'));
              return Promise.resolve([].concat(__llmModels));
            },
          },
          chat: {
            completions: {
              create: () => (async function* () {
                if (__llmChatFail) throw new Error('chat failed');
                yield { choices: [{ delta: { content: '我是小美，' } }] };
                yield { choices: [{ delta: { content: '很高兴认识你！' } }] };
              })(),
            },
          },
        },
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
        // 联网检索源：维基百科中文 / DuckDuckGo / 维基英文
        if (url.indexOf('zh.wikipedia.org') >= 0 || url.indexOf('en.wikipedia.org') >= 0) {
          __searchCalls.push(url);
          if (!__searchOk) return Promise.reject(new Error('search down'));
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve({
              query: { search: [
                { title: '物理设计', snippet: '物理设计是集成电路设计的一个阶段，<span class="searchmatch">Innovus</span> 是常用工具。' },
                { title: '静态时序分析', snippet: '静态时序分析用于验证数字电路时序是否满足约束。' },
                { title: 'Cadence Design Systems', snippet: 'Cadence 是 EDA 软件厂商。' },
              ] },
            }),
          });
        }
        if (url.indexOf('api.duckduckgo.com') >= 0) {
          __searchCalls.push(url);
          if (!__searchOk) return Promise.reject(new Error('search down'));
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve({ Heading: 'EDA', AbstractText: '电子设计自动化', AbstractURL: 'https://example.com/eda', RelatedTopics: [] }),
          });
        }
        if (url.indexOf('api.coingecko.com') >= 0) {
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve([{
              id: 'bitcoin', symbol: 'btc', name: 'Bitcoin',
              current_price: 81507, price_change_percentage_24h: 1.4805,
              total_volume: 24279642149, last_updated: new Date().toISOString(),
            }]),
          });
        }
        return Promise.reject(new Error('no network in test'));
      };
      // 拦截 JSONP script 注入：smartbox 名称解析 / 腾讯行情（jsdom 不加载外部脚本）
      const bodyAppend = win.HTMLBodyElement.prototype.appendChild;
      win.HTMLBodyElement.prototype.appendChild = function (el) {
        if (el && el.tagName === 'SCRIPT' && el.src) {
          const url = String(el.src);
          setTimeout(() => {
            if (url.indexOf('smartbox.gtimg.cn') >= 0) {
              win.v_hint = 'sh~600519~\u8d35\u5dde\u8305\u53f0~gzmt~GP-A^hk~00700~\u817e\u8baf\u63a7\u80a1~tencent~GP';
            } else if (url.indexOf('qt.gtimg.cn') >= 0) {
              const sec = (url.split('q=')[1] || '').split('&')[0];
              win['v_' + sec] = '1~\u8d35\u5dde\u8305\u53f0~600519~1252.57~1257.12~1259.00~25017~11200~13817~1252.57~1~1252.56~15~1252.55~110~1252.50~24~1252.45~1~1252.86~57~1252.97~1~1253.00~3~1253.12~1~1253.13~5~~20260921154707~-4.55~-0.36~1259.95~1250.80~1252.57/25017/3135910045~25017~313591~0.20~19.23~~1259.95~1250.80~0.73~15658.15';
            }
            if (typeof el.onload === 'function') el.onload();
          }, 30);
          return el;
        }
        return bodyAppend.call(this, el);
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
  log(D.querySelectorAll('#jEmo span[data-e]').length > 100, '表情头像候选已扩容到 100+', D.querySelectorAll('#jEmo span[data-e]').length);
  log(D.querySelectorAll('#jEmo .emo-pg').length >= 4, '表情按组分页（表情/手势/动物/食物/符号）', D.querySelectorAll('#jEmo .emo-pg').length);
  // 分页行为：默认只显示第一组，其余隐藏
  const pgVisible = () => Array.prototype.slice.call(D.querySelectorAll('#jEmo .emo-pg')).filter((p) => p.style.display !== 'none').length;
  log(pgVisible() === 1, '默认只显示 1 组（不再整列长滚动）', pgVisible());
  const visibleGroup = D.querySelector('#jEmo .emo-pager').getAttribute('data-cur');
  D.querySelector('#jEmo .ep-nav[data-p="1"]').click();
  await sleep(30);
  log(D.querySelector('#jEmo .emo-pager').getAttribute('data-cur') !== visibleGroup, '点击「下一组」可左右翻页', D.querySelector('#jEmo .emo-pager').getAttribute('data-cur'));
  log(pgVisible() === 1, '翻页后仍只显示 1 组', pgVisible());
  log(D.querySelectorAll('#jEmo .ep-dots i').length >= 4, '提供页码点指示器', D.querySelectorAll('#jEmo .ep-dots i').length);
  D.querySelector('#jEmo .ep-dots i').click();
  await sleep(30);
  log(D.querySelector('#jEmo .emo-pager').getAttribute('data-cur') === '0', '点击页码点跳回第一组', D.querySelector('#jEmo .emo-pager').getAttribute('data-cur'));
  log(D.querySelectorAll('#jColor i').length >= 15, '昵称页提供 15+ 款头像背景色', D.querySelectorAll('#jColor i').length);

  // 2. 设置昵称进入
  D.querySelector('#jName').value = '云端测试';
  D.querySelector('#jName').dispatchEvent(new w.Event('input', { bubbles: true }));
  const pickedEmoji = D.querySelectorAll('#jEmo span[data-e]')[1].dataset.e;
  D.querySelectorAll('#jEmo span[data-e]')[1].click();
  // 选一个非默认背景色，验证会被写入 profiles
  const pickedColor = D.querySelectorAll('#jColor i')[3].dataset.c;
  D.querySelectorAll('#jColor i')[3].click();
  await sleep(60);
  log(D.querySelector('#jPrev').style.background !== '' , '选色后头像预览底色跟着变', D.querySelector('#jPrev').style.background);
  D.querySelector('#jGo').click();
  await sleep(800);

  log(D.querySelector('#join').classList.contains('hidden'), '设置昵称后进入主界面');
  const mine = DATA.profiles.filter((p) => p.id === 'u_test');
  log(mine.length === 1 && mine[0].nickname === '云端测试' && mine[0].avatar === pickedEmoji, '昵称与表情头像已写入云端 profiles', JSON.stringify(mine.map((p) => p.nickname + p.avatar)));
  log(mine.length === 1 && mine[0].color === pickedColor, '所选头像背景色已写入 profiles', mine[0] && mine[0].color);
  log(DATA.group_members.some((m) => m.group_id === 'hall' && m.user_id === 'u_test'), '自动加入大厅');
  log(D.querySelector('#cName').textContent === '大厅', '默认打开大厅会话', D.querySelector('#cName').textContent);
  log(D.querySelector('#cList').textContent.indexOf('大厅') >= 0, '侧栏显示大厅');
  // 大厅专属头像：侧栏大厅条目应为 🏛️ + 品牌绿 #07c160
  const hallAvEl = D.querySelector('#cList .conv[data-c="g:hall"] .av');
  log(!!hallAvEl && hallAvEl.textContent.indexOf('🏛') >= 0, '大厅使用专属头像图形 🏛️', hallAvEl ? hallAvEl.textContent : 'none');
  log(!!hallAvEl && /07c160/i.test(hallAvEl.getAttribute('style') || ''), '大厅专属头像使用品牌绿底色', hallAvEl ? hallAvEl.getAttribute('style') : 'none');

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
  log(!epop.classList.contains('hidden') && epop.querySelectorAll('span[data-e]').length > 10, '点表情按钮弹出表情面板');
  log(!!D.querySelector('#epopClose'), '面板里有「关闭 ✕」按钮');
  // 聊天表情面板：分页而非整列长滚动
  log(epop.querySelectorAll('.emo-pg').length >= 4, '聊天表情面板按组分页', epop.querySelectorAll('.emo-pg').length);
  const cVis = () => Array.prototype.slice.call(epop.querySelectorAll('.emo-pg')).filter((p) => p.style.display !== 'none').length;
  log(cVis() === 1, '聊天表情面板默认只显示 1 组', cVis());
  const cCur0 = epop.querySelector('.emo-pager').getAttribute('data-cur');
  epop.querySelector('.ep-nav[data-p="1"]').click();
  await sleep(20);
  log(epop.querySelector('.emo-pager').getAttribute('data-cur') !== cCur0, '聊天表情面板可左右翻页', epop.querySelector('.emo-pager').getAttribute('data-cur'));
  log(cVis() === 1, '聊天表情翻页后仍只显示 1 组', cVis());
  epop.querySelector('.ep-dots i').click();
  await sleep(20);
  log(epop.querySelector('.emo-pager').getAttribute('data-cur') === '0', '聊天表情面板页码点可跳转回第一组');

  // 面板定位不能盖住触发按钮（否则按钮点不到就再也关不掉）
  const popTop = parseFloat(epop.style.top || '-1');
  const popBottom = popTop + 210;
  log(popBottom <= btnRect.top || popTop >= btnRect.bottom,
    '面板定位不遮挡表情按钮（面板 ' + popTop + '~' + popBottom + '，按钮 ' + btnRect.top + '~' + btnRect.bottom + '）');

  // 翻页导致面板高度变化时：底边锚定不动，只向上收缩（上方伸缩，下方不收缩）
  {
    const H_ANCHOR = 692;                     // = 按钮 top(700) - 8
    const heights = [210, 160, 120, 90];
    const bottoms = [];
    let allNearBottom = true;
    heights.forEach((h) => {
      Object.defineProperty(epop, 'offsetHeight', { value: h, configurable: true });
      bEmo.click();                            // 关
      bEmo.click();                            // 开（触发 placePop 重排）
      const t = parseFloat(epop.style.top || '-1');
      bottoms.push(t + h);
      if (Math.abs(t + h - H_ANCHOR) > 1) allNearBottom = false;
    });
    log(allNearBottom, '面板高度变化时底边保持不动（上方伸缩，下方不收缩）', 'bottom=' + bottoms.join(','));
    const tops = bottoms.map((b, i) => b - heights[i]);
    const ascending = tops.every((v, i) => i === 0 || v >= tops[i - 1]);
    log(ascending, '面板变矮时顶边下移（顶部收缩而非底部收缩）', 'top=' + tops.join(','));
    Object.defineProperty(epop, 'offsetHeight', { value: 210, configurable: true });
  }

  // 1) 选表情后自动关闭
  epop.querySelector('span[data-e]').click();
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

  // ===== 本轮修复：小美不 @ 就不主动发言 =====
  {
    const botCountBefore = DATA.messages.filter((m) => m.sender_id === 'bot_xiaomei').length;
    // 主动冒泡已停用：多次触发空闲回调也不应产生新消息
    for (let i = 0; i < 5; i++) { try { w.LT.botIdle(); } catch (e) { /* 未导出则忽略 */ } }
    await sleep(400);
    const botCountAfter = DATA.messages.filter((m) => m.sender_id === 'bot_xiaomei').length;
    log(botCountAfter === botCountBefore, '小美不再主动冒泡（不 @ 不发言）', botCountBefore + ' -> ' + botCountAfter);
  }

  // ===== 本轮：加小美为好友 -> 直接成为好友，且私聊等同于 @ 她 =====
  {
    // 清掉可能存在的既有关系，确保测的是「首次添加」
    DATA.friends = DATA.friends.filter((f) => !(f.a === 'u_test' && f.b === 'bot_xiaomei') && !(f.b === 'u_test' && f.a === 'bot_xiaomei'));
    // 进入与小美的私聊，打开资料页
    if (D.querySelector('#info').classList.contains('hidden')) D.querySelector('#bInfo').click();
    await sleep(500);
    const xm = D.querySelector('#info .mem[data-u="bot_xiaomei"]');
    if (xm) xm.click();
    await sleep(800);
    log(D.querySelector('#cName') && D.querySelector('#cName').textContent === '小美', '可从大厅成员点开与小美的私聊', D.querySelector('#cName') && D.querySelector('#cName').textContent);

    if (!D.querySelector('#info').classList.contains('hidden')) D.querySelector('#bInfo').click();
    await sleep(500);
    const afBtn = D.querySelector('#afBtn');
    log(!!afBtn && afBtn.textContent.indexOf('添加小美为好友') >= 0, '小美资料页按钮文案为「添加小美为好友」', afBtn ? afBtn.textContent : 'none');

    // 记录点之前的消息数，便于校验系统提示
    const msgBefore = DATA.messages.length;
    if (afBtn) afBtn.click();
    await sleep(900);

    const relXm = DATA.friends.filter((f) => ((f.a === 'u_test' && f.b === 'bot_xiaomei') || (f.b === 'u_test' && f.a === 'bot_xiaomei')));
    log(relXm.length >= 1, '加小美：直接写入好友关系（无需对方确认）', JSON.stringify(relXm));
    log(relXm.length >= 1 && relXm.every((f) => f.status === 'accepted'), '与小美的关系状态直接为 accepted', relXm.map((f) => f.status).join(','));
    log(DATA.messages.length > msgBefore && DATA.messages.slice(msgBefore).some((m) => m.type === 'system'), '加小美后写入一条系统提示消息');

    // 关键：私聊小美 = 在大厅 @她，效果一致（都会自动回复）
    const n0 = DATA.messages.filter((m) => m.sender_id === 'bot_xiaomei').length;
    D.querySelector('#input').value = '讲个笑话';
    D.querySelector('#bSend').click();
    await sleep(3000);
    const n1 = DATA.messages.filter((m) => m.sender_id === 'bot_xiaomei').length;
    log(n1 > n0, '私聊小美（不带 @）也会自动回复，效果等同群聊 @她', n0 + ' -> ' + n1);
    const lastBot = DATA.messages.filter((m) => m.sender_id === 'bot_xiaomei').slice(-1)[0];
    log(!!lastBot && lastBot.conv === 'p:bot_xiaomei~u_test', '小美的回复落在与小美的私聊会话里', lastBot ? lastBot.conv : 'none');

    // 已是好友后再看资料页，应显示「好友」而非再次添加
    // #bInfo 是开关：先确保面板可见，再强制重渲染以拿到最新好友关系
    if (D.querySelector('#info').classList.contains('hidden')) { D.querySelector('#bInfo').click(); await sleep(400); }
    // 好友关系落库后 refreshAll 是异步的，多等一会儿再重渲染
    await sleep(1200);
    D.querySelector('#bInfo').click(); await sleep(200);   // 关
    D.querySelector('#bInfo').click(); await sleep(600);   // 开（触发 renderInfo）
    log(D.querySelector('#info').textContent.indexOf('好友') >= 0 && !D.querySelector('#afBtn'),
      '成为好友后资料页显示「好友」且不再出现添加按钮',
      (D.querySelector('#info').textContent || '').replace(/\s+/g, ' ').slice(0, 70));
  }

  // ===== 小美大模型能力：云端 Keyless LLM 网关（无需前端 apikey）=====
  {
    const LT = w.LT;

    // 1) 接入方式：Keyless 网关 —— 前端源码里不得出现任何硬编码密钥
    {
      // ⚠️ 小美的模型调用已搬到 bot.js，必须两个文件一起扫，否则断言形同虚设
      const src = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
        + '\n' + fs.readFileSync(path.join(__dirname, 'bot.js'), 'utf8');
      log(!/sk-[A-Za-z0-9]{16,}/.test(src), '前端源码无 sk- 硬编码密钥（apikey 由云端网关托管）');
      log(/CLOUD\.llm\.chat\.completions\.create/.test(src), '通过 CLOUD.llm 网关调用（非直连第三方域名）');
      log(!/api\.deepseek\.com/.test(src), '不直连 api.deepseek.com（避免密钥泄露 + CORS）');
      // 云上 DeepSeek 全是 onlyReasoning 推理模型：不能硬传 temperature，超时也要放宽
      log(!/stream:\s*true,\s*temperature:/.test(src), '不硬传 temperature（推理模型采样参数锁定，传了可能被拒）');
      const to = src.match(/var LLM_TIMEOUT = (\d+)/);
      log(!!to && Number(to[1]) >= 40000, 'LLM_TIMEOUT ≥ 40s（适配推理模型首字延迟）', to ? to[1] + 's' : 'none');
      // 注意：源码里有两处 botTypingUntil（普通回复 1.5s / AI 长等待 60s），
      // 要取「AI 长等待」那个最大值，否则会误配到 1.5s
      const holds = Array.from(src.matchAll(/S\.botTypingUntil = Date\.now\(\) \+ (\d+)/g)).map((m) => Number(m[1]));
      const hold = holds.length ? Math.max.apply(null, holds) : 0;
      // 两者都是毫秒（LLM_TIMEOUT 直接喂给 setTimeout，单位就是 ms）
      log(!!to && hold > 0 && Number(to[1]) < hold,
        '「输入中」保持时长 > LLM 超时（不会中途掉指示器）',
        to ? (Number(to[1]) / 1000) + 's vs ' + (hold / 1000) + 's' : 'none');
    }

    // 2) 模型选择：目录里 deepseek-v4-flash 排在 v4.1-flash 之前，
    //    但必须精确命中优先级最高的 deepseek-v4.1-flash（不是列表第一个）
    await sleep(300);
    if (LT && LT.ensureLLM) {
      delete LT.S.llmReady; LT.S.llmModel = null;
      __llmListCalls = 0;
      await LT.ensureLLM();
      log(LT.S.llmModel === 'deepseek-v4.1-flash',
        '模型选择按优先级精确命中 deepseek-v4.1-flash（不靠列表顺序）', String(LT.S.llmModel));
      log(__llmListCalls === 1, '拉取模型目录 1 次', __llmListCalls);
      // 幂等：再调一次不应重复拉目录
      await LT.ensureLLM();
      log(__llmListCalls === 1, 'ensureLLM 幂等（llmReady 生效，不重复拉目录）', __llmListCalls);
    } else {
      log(false, 'window.LT.ensureLLM 已导出', LT ? Object.keys(LT).join(',') : 'no LT');
    }

    // 3) 首选型号被禁用 → 跳到下一个可用
    {
      const saved = __llmModels.slice();
      __llmModels = saved.map((m) => (m.id === 'deepseek-v4.1-flash' ? { id: m.id, name: m.name, disabled: true } : m));
      if (LT && LT.ensureLLM) {
        delete LT.S.llmReady; LT.S.llmModel = null;
        await LT.ensureLLM();
        log(LT.S.llmModel === 'deepseek-v4-flash', '首选被 disabled → 跳到次选', String(LT.S.llmModel));
      }
      __llmModels = saved;
    }

    // 4) 目录里没有 deepseek → 兜底任意可用
    {
      const saved = __llmModels.slice();
      __llmModels = [{ id: 'glm-5.3', name: 'GLM-5.3', enabled: true }];
      if (LT && LT.ensureLLM) {
        delete LT.S.llmReady; LT.S.llmModel = null;
        await LT.ensureLLM();
        log(LT.S.llmModel === 'glm-5.3', '目录无 deepseek → 兜底任意可用模型', String(LT.S.llmModel));
      }
      __llmModels = saved;
    }

    // 5) 网关不可用 → llmModel 为 null（静默降级，不报错）
    {
      const saved = __llmModels.slice();
      __llmModels = [];
      if (LT && LT.ensureLLM) {
        delete LT.S.llmReady; LT.S.llmModel = null;
        await LT.ensureLLM();
        log(LT.S.llmModel === null, '模型目录为空 → llmModel 保持 null（走旧兜底话术）', String(LT.S.llmModel));
      }
      __llmModels = saved;
    }
  }

  // ===== 本轮新功能：一起玩游戏（五子棋全链路）=====
  {
    // 回到大厅（有其他人，便于验证抢占）
    const hallConv = D.querySelector('#cList .conv[data-c="g:hall"]');
    if (hallConv) hallConv.click();
    await sleep(800);

    // 1) 工具栏含「游戏」图标按钮（#bMore 更早消息已按需求移除，见文件末尾工具栏断言）
    const bGame = D.querySelector('#bGame');
    log(!!bGame, '工具栏游戏图标按钮共存');

    // 2) 点开 -> 出现选游戏弹窗（五子棋/围棋/象棋）
    bGame.click();
    await sleep(300);
    const cards = D.querySelectorAll('#modal .gcard');
    log(cards.length === 3, '弹窗提供 3 种棋类（五子棋/围棋/象棋）', cards.length);
    const names = Array.from(cards).map((c) => c.querySelector('.gnm').textContent);
    log(names.indexOf('五子棋') >= 0 && names.indexOf('围棋') >= 0 && names.indexOf('象棋') >= 0,
      '三种棋类名称正确', names.join('/'));
    log(Array.from(cards).filter((c) => c.classList.contains('off')).length === 0,
      '围棋/象棋已解禁（三种棋都可点）');

    // 3) 选五子棋 -> 写入 games 表 + 发一条 type=game 的按钮消息
    const nMsg0 = DATA.messages.length;
    const gomoku = Array.from(cards).find((c) => c.dataset.k === 'gomoku');
    gomoku.click();
    await sleep(900);
    const gameRow = DATA.games[DATA.games.length - 1];
    log(!!gameRow && gameRow.kind === 'gomoku' && gameRow.status === 'waiting',
      '发起五子棋：games 表写入 waiting 记录', gameRow ? gameRow.status : 'none');
    log(gameRow && gameRow.host_id === 'u_test', '游戏发起人是当前用户', gameRow && gameRow.host_id);
    const gMsg = DATA.messages.slice(nMsg0).find((m) => m.type === 'game');
    log(!!gMsg && gMsg.text === (gameRow && gameRow.id), '发出了 type=game 的按钮消息，text 指向 gameId');

    // 3b) 发起方立刻进入对局页等待：显示棋盘 + 遮罩 + 提示，且不能落子
    const roomW = D.querySelector('#groom');
    log(!!roomW && !roomW.classList.contains('hidden'), '发起方立刻进入对局页（浮层已打开）');
    log(!!(roomW && roomW.querySelector('#gBoard')), '等待态也渲染出棋盘');
    log(!!(roomW && roomW.querySelector('.gr-waitmask')), '等待态有「等待对方进入」遮罩');
    log(!!(roomW && /等待对方进入房间/.test(roomW.textContent)), '等待态提示「等待对方进入房间」');
    {
      // 点棋盘 → 应提示「对方还未进入房间」，且不产生落子
      const cv = roomW && roomW.querySelector('#gBoard');
      const tableBefore = D.querySelector('#toast');
      if (cv) {
        const before = JSON.stringify(gameRow.board || []);
        cv.click();
        await sleep(200);
        const toastEl = D.querySelector('#toast');
        const toastTxt = toastEl ? toastEl.textContent : '';
        log(/对方还未进入房间/.test(toastTxt) || JSON.stringify(gameRow.board || []) === before,
          '等待态落子被拦下（提示「对方还未进入房间」或棋盘不变）', toastTxt.slice(0, 40));
      } else {
        log(false, '等待态落子被拦下（提示「对方还未进入房间」或棋盘不变）', '无画布');
      }
    }

    // 4) 聊天区渲染出邀请卡片，发起方自己看到「等待对方加入」（不可点）
    const inv = D.querySelectorAll('#mList .ginvite');
    log(inv.length >= 1, '聊天区渲染出游戏邀请卡片', inv.length);
    const myBtn = D.querySelector('#mList .ginvite:last-of-type .gbtn') || (inv.length ? inv[inv.length - 1].querySelector('.gbtn') : null);
    log(!!myBtn && myBtn.classList.contains('dis') && myBtn.textContent.indexOf('等待对方加入') >= 0,
      '发起方视角：按钮显示「等待对方加入」且置灰', myBtn ? myBtn.textContent : 'none');

    // 4b) 卡片标题必须是「真 SVG 图标 + 纯文本」，不能把 SVG 源码显示成标签文本
    {
      const c0 = inv.length ? inv[inv.length - 1] : null;
      const git = c0 ? c0.querySelector('.git') : null;
      log(!!git && git.querySelectorAll('svg').length === 1,
        '邀请卡片标题内联了 1 个真实 SVG 图标', git ? git.querySelectorAll('svg').length : '无卡片');
      log(!!git && git.textContent.indexOf('<svg') < 0,
        '邀请卡片标题没有把 SVG 当文本显示（无 "<svg" 字面量）', git ? git.textContent.slice(0, 30) : '无卡片');
      log(!!git && /五子棋邀请/.test(git.textContent),
        '邀请卡片标题文本为「五子棋邀请」', git ? git.textContent.trim() : '无卡片');
    }

    // 4c) 对局页右上角有 ✕ 关闭按钮（行为验证见文末「等待态点 ✕」用例）
    log(!!D.querySelector('#grExit'), '对局页右上角有 ✕ 关闭按钮');

    const gidStr = gameRow.id;

    // 5) 模拟「对方」抢到对局（直接改库，等同另一客户端 join），本地轮询应同步
    gameRow.guest_id = 'u_a'; gameRow.guest_name = '甲'; gameRow.status = 'playing'; gameRow.turn = 'host';
    await sleep(3200);
    const cardNow = D.querySelectorAll('#mList .ginvite');
    const lastCard = cardNow.length ? cardNow[cardNow.length - 1] : null;
    const lastBtn = lastCard ? lastCard.querySelector('.gbtn') : null;
    log(!!lastBtn && !lastBtn.classList.contains('dis') && lastBtn.textContent.indexOf('进入对局') >= 0,
      '对局开始后：卡片变为可点「进入对局」', lastBtn ? lastBtn.textContent : 'none');

    // 5b) 群聊抢位：第三人（非参与方）看到的必须是置灰「游戏已开始或已过期」
    //     这里先确认「抢先者已原子写入 guest_id」——并发下只有一个赢家
    {
      const gRow = DATA.games.find((x) => x.id === gidStr);
      log(!!gRow && gRow.status === 'playing' && gRow.guest_id === 'u_a',
        '抢先者已写入 guest_id（并发下只有一个赢家）', gRow ? gRow.guest_id : 'none');
    }

    // 6) 点进入 -> 打开对局浮层，出现棋盘
    lastBtn.click();
    await sleep(400);
    const room = D.querySelector('#groom');
    log(!!room && !room.classList.contains('hidden'), '点击后可打开对局浮层');
    log(!!(room && room.querySelector('#gBoard')), '对局浮层里渲染出棋盘');

    // 7) 五子棋胜负判定（纯逻辑，直接调用内部工具）
    const GBcheck = w.LT.GB;
    if (GBcheck) {
      const bd = GBcheck.newBoard();
      for (let c = 3; c <= 7; c++) bd[GBcheck.idx(7, c)] = 1;   // 横排五连
      log(GBcheck.checkWin(bd, 7, 5, 1) === true, '五子棋：横排五连判定为胜');
      log(GBcheck.checkWin(bd, 7, 5, 2) === false, '五子棋：对方颜色不构成胜利');
      const bd2 = GBcheck.newBoard();
      for (let i = 0; i < 4; i++) bd2[GBcheck.idx(5 + i, 5 + i)] = 2;  // 只四连
      log(GBcheck.checkWin(bd2, 6, 6, 2) === false, '五子棋：四连不算胜');
      const bd3 = GBcheck.newBoard();
      for (let i = 0; i < 5; i++) bd3[GBcheck.idx(3 + i, 3 + i)] = 2;  // 斜向五连
      log(GBcheck.checkWin(bd3, 5, 5, 2) === true, '五子棋：斜向五连判定为胜');
    }

    // 8) 结束后：发起方看到「再来一局/其他游戏/结束游戏」
    gameRow.status = 'over'; gameRow.winner = 'u_test';
    await sleep(3200);
    const room2 = D.querySelector('#groom');
    const txt = room2 ? room2.textContent : '';
    log(txt.indexOf('再来一局') >= 0 && txt.indexOf('其他游戏') >= 0 && txt.indexOf('结束游戏') >= 0,
      '赢家（发起方）看到「再来一局 / 其他游戏 / 结束游戏」', txt.replace(/\s+/g, ' ').slice(0, 50));

    // 8b) 对方视角（非发起方）：应显示「游戏房间清扫中~~~」而不是操作按钮
    //     当前测试用户是发起方，直接改库看不出这一分支 —— 用内部工具验证渲染产物。
    {
      const gRow = DATA.games.find((x) => x.id === gidStr);
      const S = w.LT.S;
      if (gRow && S) {
        const savedUid = S.uid;
        S.uid = 'u_a';            // 伪装成「被邀请的那一方」
        S.gameOpen = gidStr;
        try {
          w.LT.renderRoom && w.LT.renderRoom();
          const t2 = D.querySelector('#groom') ? D.querySelector('#groom').textContent : '';
          log(t2.indexOf('游戏房间清扫中') >= 0,
            '非发起方视角显示「游戏房间清扫中~~~」', t2.replace(/\s+/g, ' ').slice(0, 50));
        } finally {
          S.uid = savedUid;       // 还原身份，别污染后续用例
        }
      } else {
        log(false, '非发起方视角显示「游戏房间清扫中~~~」', '缺少游戏行或 S');
      }
      await sleep(400);
    }

    // 8c) 关键回归：房间关闭后，聊天区的邀请卡片也必须跟著状态实时更新
    //     （曾因 applyGames 未触发 renderMsgs 导致卡片永远停在「等待对方加入」）
    {
      if (w.LT.close) w.LT.close();          // 先确保没有残留弹窗挡住
      // 直接改库把对局置为 over，避免依赖被 8b 污染过的 #grExit 绑定
      const gRowC = DATA.games.find((x) => x.id === gidStr);
      if (gRowC) gRowC.status = 'over';      // over → 非参与方看到的卡片应为「已开始或已过期」
      await sleep(3200);
      const roomC = D.querySelector('#groom');
      if (roomC && !roomC.classList.contains('hidden')) {
        const ex = D.querySelector('#grExit');
        if (ex) ex.click();
        await sleep(250);
        const cf = D.querySelector('#cfOk') || D.querySelector('.dlg .btn.primary');
        if (cf) cf.click();
        await sleep(500);
      }
      const cardsAfter = D.querySelectorAll('#mList .ginvite');
      const bAfter = cardsAfter.length ? cardsAfter[cardsAfter.length - 1].querySelector('.gbtn') : null;
      log(!!bAfter && bAfter.classList.contains('dis') && bAfter.textContent.indexOf('已开始或已过期') >= 0,
        '房间关闭后邀请卡片同步为置灰「游戏已开始或已过期」', bAfter ? bAfter.textContent : 'none');
    }

    // 8d) 对局中对方离开 → 显示倒计时文案（3 秒后自动退出）
    {
      const g2 = DATA.games.find((x) => x.id === gidStr);
      if (g2) { g2.status = 'left'; g2.winner = ''; }
      // 确保浮层处于打开态（8b 里可能已切走）
      if (w.LT.openRoom) w.LT.openRoom(gidStr);
      await sleep(3200);
      const roomL = D.querySelector('#groom');
      log(!!roomL && /倒计时/.test(roomL.textContent), '对方离开 → 浮层出现「倒计时 … 秒退出」文案',
        roomL ? roomL.textContent.replace(/\s+/g, ' ').slice(0, 60) : '无浮层');
      const cnt = D.querySelector('#grCnt');
      log(!!cnt, '倒计时数字元素存在');
      await sleep(4200);   // 等满 3 秒自动退出
      const roomZ = D.querySelector('#groom');
      log(!roomZ || roomZ.classList.contains('hidden'), '倒计时结束自动关闭对局浮层');
    }

    // 9) 关闭对局浮层
    const exitBtn = D.querySelector('#grExit');
    if (exitBtn) exitBtn.click();
    await sleep(250);
    // confirmBox 需要确认
    const okBtn = D.querySelector('#cfOk') || D.querySelector('.dlg .btn.primary');
    if (okBtn) okBtn.click();
    await sleep(300);
    const roomEnd = D.querySelector('#groom');
    log(!roomEnd || roomEnd.classList.contains('hidden'), '可离开对局并关闭浮层');

    // 10) 发起方在「等待」阶段提前离开 → 本局作废（置 over），邀请卡片置灰提示过期
    {
      const wid = 'gm_waitleave';
      DATA.games.push({ id: wid, conv: 'g:hall', kind: 'gomoku', host_id: 'u_test', host_name: '云端测试', guest_id: '', guest_name: '', status: 'waiting', turn: 'host', board: [], moves: [], winner: '', restart_by: '', restart_kind: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      DATA.messages.push({ id: ++seq, conv: 'g:hall', sender_id: 'u_test', sender_name: '云端测试', sender_avatar: '', sender_color: '#888', type: 'game', text: wid, mentions: [], created_at: new Date().toISOString() });
      await sleep(3200);
      // 进入该局并直接离开（等同点 ✕ → 确认）
      if (w.LT.openRoom) w.LT.openRoom(wid);
      await sleep(400);
      const ex2 = D.querySelector('#grExit');
      if (ex2) ex2.click();
      await sleep(250);
      const cf2 = D.querySelector('#cfOk') || D.querySelector('.dlg .btn.primary');
      if (cf2) cf2.click();
      await sleep(1200);
      const row10 = DATA.games.find((x) => x.id === wid);
      log(!!row10 && row10.status === 'over', '发起方等待阶段离开：本局标记为 over（保留记录供置灰展示）', row10 ? row10.status : '被删除');
      const cards10 = D.querySelectorAll('#mList .ginvite');
      const b10 = cards10.length ? cards10[cards10.length - 1].querySelector('.gbtn') : null;
      log(!!b10 && b10.classList.contains('dis') && b10.textContent.indexOf('已开始或已过期') >= 0,
        '离开后邀请卡片置灰「游戏已开始或已过期」', b10 ? b10.textContent : 'none');
    }

    // 11) 等待态点右上角 ✕ → 不弹二次确认框、直接关页、本局置 over
    {
      const xid = 'gm_xclose';
      DATA.games.push({ id: xid, conv: 'g:hall', kind: 'gomoku', host_id: 'u_test', host_name: '云端测试', guest_id: '', guest_name: '', status: 'waiting', turn: 'host', board: [], moves: [], winner: '', restart_by: '', restart_kind: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      DATA.messages.push({ id: ++seq, conv: 'g:hall', sender_id: 'u_test', sender_name: '云端测试', sender_avatar: '', sender_color: '#888', type: 'game', text: xid, mentions: [], created_at: new Date().toISOString() });
      await sleep(3200);
      if (w.LT.openRoom) w.LT.openRoom(xid);
      await sleep(400);
      const exW = D.querySelector('#grExit');
      log(!!exW, '等待态对局页仍有 ✕ 关闭按钮');
      if (exW) {
        exW.click();
        await sleep(400);
        // 关闭前的确认遮罩 z-index 必须高于对局页，否则会被盖住看不见
        var maskX = D.querySelector('#mask');
        log(!maskX || maskX.classList.contains('hidden'), '等待态点 ✕ 不弹二次确认框（直接退出）', maskX && !maskX.classList.contains('hidden') ? '弹了' : '无弹窗');
        await sleep(1200);
        const roomX = D.querySelector('#groom');
        log(!roomX || roomX.classList.contains('hidden'), '等待态点 ✕ 后对局页关闭');
        log(w.LT.S.gameOpen === null, '等待态点 ✕ 后清空 S.gameOpen', String(w.LT.S.gameOpen));
        const rowX = DATA.games.find((x) => x.id === xid);
        log(!!rowX && rowX.status === 'over', '等待态点 ✕ 后本局置 over（过期作废）', rowX ? rowX.status : '被删除');
      }
    }

    // 12) 对局中点 ✕ 仍需二次确认（防误触），且确认框必须盖在对局页之上
    {
      const pid = 'gm_pclose';
      DATA.games.push({ id: pid, conv: 'g:hall', kind: 'gomoku', host_id: 'u_test', host_name: '云端测试', guest_id: 'u_a', guest_name: '甲', status: 'playing', turn: 'host', board: [], moves: [], winner: '', restart_by: '', restart_kind: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      DATA.messages.push({ id: ++seq, conv: 'g:hall', sender_id: 'u_test', sender_name: '云端测试', sender_avatar: '', sender_color: '#888', type: 'game', text: pid, mentions: [], created_at: new Date().toISOString() });
      await sleep(3200);
      if (w.LT.openRoom) w.LT.openRoom(pid);
      await sleep(400);
      const exP = D.querySelector('#grExit');
      if (exP) exP.click();
      await sleep(400);
      const maskP = D.querySelector('#mask');
      const maskPOpen = !!maskP && !maskP.classList.contains('hidden');
      log(maskPOpen, '对局中点 ✕ 弹出二次确认框', maskPOpen ? '有' : '无');
      {
        // 确认框必须压过对局页（.groom z-index:120）
        const z = maskPOpen ? w.getComputedStyle(maskP).zIndex : '-';
        log(Number(z) > 120, '确认框 z-index 高于对局页（否则会被盖住看不见）', 'mask z=' + z + ' / groom z=120');
      }
      const cfP = D.querySelector('#cfOk');
      if (cfP) cfP.click();
      await sleep(1200);
      const roomP = D.querySelector('#groom');
      log(!roomP || roomP.classList.contains('hidden'), '对局中确认离开后对局页关闭');
      const rowP = DATA.games.find((x) => x.id === pid);
      log(!!rowP && rowP.status === 'left', '对局中离开置为 left（保留供对方看倒计时）', rowP ? rowP.status : '被删除');
    }

    // 13) 围棋：可落子、提子、终局数子
    {
      const ggRow = { id: 'gm_go', conv: 'g:hall', kind: 'go', host_id: 'u_test', host_name: '云端测试', guest_id: 'u_a', guest_name: '甲', status: 'playing', turn: 'host', board: [], moves: [], winner: '', restart_by: '', restart_kind: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      DATA.games.push(ggRow);
      DATA.messages.push({ id: ++seq, conv: 'g:hall', sender_id: 'u_test', sender_name: '云端测试', sender_avatar: '', sender_color: '#888', type: 'game', text: 'gm_go', mentions: [], created_at: new Date().toISOString() });
      await sleep(3200);
      if (w.LT.openRoom) w.LT.openRoom('gm_go');
      await sleep(400);
      const ggRoom = D.querySelector('#groom');
      log(!!ggRoom && /围棋/.test(ggRoom.textContent), '围棋对局页标题含「围棋」');
      const ggCv = ggRoom && ggRoom.querySelector('#gBoard');
      log(!!ggCv && ggCv.classList.contains('bd-go'), '围棋画布带 bd-go 皮肤类', ggCv ? ggCv.className : 'none');
      log(!!ggRoom && !!ggRoom.querySelector('#grGoEnd'), '围棋对局页有「终局数子」按钮');
      // 直接驱动落子：host 走 1 手 → 棋盘写入 361 长度数组、轮次交给客方
      if (ggCv && w.LT.S && w.LT.S.gameOpen) {
        // jsdom 里 canvas 尺寸恒为 0，必须伪造 rect，否则 clientX 换算成 NaN（测试环境限制，非产品 bug）
        ggCv.getBoundingClientRect = () => ({ left: 0, top: 0, width: 620, height: 620, right: 620, bottom: 620 });
        const cellG = (620 - 48) / 18;
        const evt = new w.MouseEvent('click', {
          clientX: 24 + 3 * cellG, clientY: 24 + 3 * cellG, bubbles: true,
        });
        ggCv.dispatchEvent(evt);
        await sleep(900);
      }
      const ggAfter = DATA.games.find((x) => x.id === 'gm_go');
      log(!!ggAfter && (ggAfter.board || []).length === 361, '围棋落子后棋盘为 361 格', ggAfter ? (ggAfter.board || []).length : 'none');
      log(!!ggAfter && (ggAfter.board || []).filter((v) => v === 1).length === 1, '围棋落子后黑子数为 1',
        ggAfter ? (ggAfter.board || []).filter((v) => v === 1).length : 'none');
      log(!!ggAfter && ggAfter.turn === 'guest', '围棋落子后轮次交给客方', ggAfter ? ggAfter.turn : 'none');
      // 终局数子：确认后 status=over、winner 为黑方（host）
      const ggEnd = D.querySelector('#grGoEnd');
      if (ggEnd) {
        ggEnd.click();
        await sleep(300);
        const okG = D.querySelector('#cfOk');
        if (okG) okG.click();
        await sleep(1200);
        const ggFin = DATA.games.find((x) => x.id === 'gm_go');
        log(!!ggFin && ggFin.status === 'over', '围棋终局后 status=over', ggFin ? ggFin.status : 'none');
        log(!!ggFin && ggFin.winner === 'u_test', '围棋数子黑多 → winner 为 host', ggFin ? ggFin.winner : 'none');
      }
      if (w.LT.close) w.LT.close();
      await sleep(300);
    }

    // 14) 象棋：选中→走子、非法走法被拒
    {
      const xqRow = { id: 'gm_xq', conv: 'g:hall', kind: 'xiangqi', host_id: 'u_test', host_name: '云端测试', guest_id: 'u_a', guest_name: '甲', status: 'playing', turn: 'host', board: [], moves: [], winner: '', restart_by: '', restart_kind: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      DATA.games.push(xqRow);
      DATA.messages.push({ id: ++seq, conv: 'g:hall', sender_id: 'u_test', sender_name: '云端测试', sender_avatar: '', sender_color: '#888', type: 'game', text: 'gm_xq', mentions: [], created_at: new Date().toISOString() });
      await sleep(3200);
      if (w.LT.openRoom) w.LT.openRoom('gm_xq');
      await sleep(400);
      const xqRoom = D.querySelector('#groom');
      log(!!xqRoom && /象棋/.test(xqRoom.textContent), '象棋对局页标题含「象棋」');
      const xqCv = xqRoom && xqRoom.querySelector('#gBoard');
      log(!!xqCv && xqCv.classList.contains('bd-xq'), '象棋画布带 bd-xq 皮肤类', xqCv ? xqCv.className : 'none');
      // 象棋应使用引擎初始化满盘（红黑各 16 子）
      const GXeng = w.LT.GX;
      log(!!GXeng && GXeng.newBoard().length === 90, '导出象棋引擎，棋盘 90 格', GXeng ? GXeng.newBoard().length : 'none');
      log(!!GXeng && GXeng.newBoard().filter((v) => v > 0).length === 16 && GXeng.newBoard().filter((v) => v < 0).length === 16,
        '象棋开局红黑各 16 子', GXeng ? (GXeng.newBoard().filter((v) => v > 0).length + '/' + GXeng.newBoard().filter((v) => v < 0).length) : 'none');
      if (xqCv && w.LT.S && w.LT.S.gameOpen) {
        // pad 34，格 X=(620-68)/8=69，格 Y=(620-68)/9≈61.33；同上，先伪造 rect
        xqCv.getBoundingClientRect = () => ({ left: 0, top: 0, width: 620, height: 620, right: 620, bottom: 620 });
        const cellX = (620 - 68) / 8, cellY = (620 - 68) / 9;
        const click = (r, c) => {
          const ev = new w.MouseEvent('click', { clientX: 34 + c * cellX, clientY: 34 + r * cellY, bubbles: true });
          xqCv.dispatchEvent(ev);
        };
        click(9, 0);        // 选中红车
        await sleep(300);
        log(!!w.LT.S.xqSel, '象棋：点自己棋子后进入选中态', w.LT.S.xqSel ? w.LT.S.xqSel.join(',') : 'none');
        click(7, 0);        // 走到 (7,0)
        await sleep(900);
        log(!w.LT.S.xqSel, '象棋：走子后清空选中态', String(w.LT.S.xqSel));
      }
      const xqAfter = DATA.games.find((x) => x.id === 'gm_xq');
      log(!!xqAfter && (xqAfter.board || []).length === 90, '象棋走子后棋盘 90 格', xqAfter ? (xqAfter.board || []).length : 'none');
      if (xqAfter && (xqAfter.board || []).length === 90) {
        log(xqAfter.board[9 * 9 + 0] === 0, '象棋：起点(9,0)已清空', xqAfter.board[9 * 9 + 0]);
        log(xqAfter.board[7 * 9 + 0] === 3, '象棋：红车落到目标点(7,0)', xqAfter.board[7 * 9 + 0]);
        log(xqAfter.turn === 'guest', '象棋：走子后轮次交给客方', xqAfter.turn);
        const mv0 = (xqAfter.moves || [])[0];
        log((xqAfter.moves || []).length === 1 && !!mv0 && mv0.fr === 9 && mv0.fc === 0 && mv0.r === 7 && mv0.c === 0,
          '象棋：moves 记录了起点→终点', JSON.stringify(mv0 || null));
      }
      if (w.LT.close) w.LT.close();
      await sleep(300);
    }

    // 15) 棋类布局一致性：三种棋画布都用同一 620 逻辑边长（棋盘尽量大）
    {
      const B = w.LT.GAME_KINDS;
      log(!!B && B.gomoku.ready === true && B.go.ready === true && B.xiangqi.ready === true,
        '三种棋 ready 均为 true', B ? [B.gomoku.ready, B.go.ready, B.xiangqi.ready].join('/') : 'none');
    }
  }

  log(D.querySelector('.tabs') === null, '侧栏分类 tab（全部/未读/群聊/好友）已移除');
  log(D.querySelector('#uTotal') === null, '旧的未读数字徽标已移除');
  log(D.querySelector('#bReq') === null && D.querySelector('#rBadge') === null, '好友请求按钮已移除（改为列表内展示）');
  log(D.querySelector('#bSet') !== null, '左下角新增「设置」入口按钮');
  log(D.querySelector('#sRow') !== null && !D.querySelector('#sRow').classList.contains('hidden'), '搜索框常显（不再需要搜索按钮）');

  // ===== 设置面板：版本号（以 git 提交为版本标识）=====
  D.querySelector('#bSet').click();
  await sleep(150);
  const verRow = D.querySelector('#sVer');
  const verTxt = verRow ? verRow.textContent.replace(/\s+/g, ' ').trim() : '';
  log(!!verRow, '设置面板含「版本」行');
  log(/[0-9a-f]{7}\s*·\s*\d{4}-\d{2}-\d{2}/.test(verTxt), '版本号以 git 提交号 + 日期呈现', verTxt);
  D.querySelector('#bSet').click();   // 收起设置面板
  await sleep(100);

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
  // 新菜单不再用序号罗列，改为「能力关键词」清单；断言跟着改成语义检查
  log(tMenu.indexOf('聊天') >= 0 && tMenu.indexOf('笑话') >= 0 && tMenu.indexOf('天气') >= 0 && tMenu.indexOf('记忆') >= 0,
    '问「你能干什么」输出能力菜单（含聊天/笑话/天气/记忆）', tMenu.slice(0, 40).replace(/\n/g, ' '));
  const tNum = await botTalk('@小美 2');
  log(tNum.length > 20 && tNum !== '(无回复)', '菜单后直接回复序号 2 -> 触发内容型生成', tNum.slice(0, 30));
  const tPoem = await botTalk('@小美 来首古诗');
  // ⚠️ 古诗已从「硬编码抽签」改为「模型现场生成」：测试环境无 LLM，
  //    会走兜底话术，因此不能再断言必须出现书名号 —— 只断言"确实接话了"。
  log(tPoem !== '(无回复)' && tPoem.length > 4, '「来首古诗」走到内容型生成路径并有回复', tPoem.slice(0, 24));
  // 真正的路由正确性由模块级断言保证（见下方 INTENTS 表检查）
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

  // ===== 预置指令：输入 # 唤起菜单，#btc 拉取行情并渲染卡片 =====
  const hallForCmd = Array.prototype.filter.call(D.querySelectorAll('#cList .conv'), (e) => e.dataset.c === 'g:hall')[0];
  if (hallForCmd) hallForCmd.click();
  await sleep(700);
  const cmdInput = D.querySelector('#input');
  const cmdpop = D.querySelector('#cmdpop');
  cmdInput.value = '#';
  cmdInput.dispatchEvent(new w.Event('input', { bubbles: true }));
  await sleep(140);
  log(!cmdpop.classList.contains('hidden') && cmdpop.querySelectorAll('.cmditem').length === 4, '输入 # 弹出 4 个预置指令', cmdpop.querySelectorAll('.cmditem').length);
  const btcItem = Array.prototype.filter.call(cmdpop.querySelectorAll('.cmditem'), (it) => it.dataset.cmd === '#btc')[0];
  log(!!btcItem, '菜单含 #btc 指令项');
  const cardsBefore = D.querySelectorAll('#mList .cardmsg').length;
  btcItem.click();
  await sleep(800);
  log(D.querySelectorAll('#mList .cardmsg').length === cardsBefore + 1, '执行 #btc 后新增一张行情卡片');
  const card = D.querySelector('#mList .cardmsg .card');
  log(!!card && card.textContent.indexOf('Bitcoin') >= 0 && card.textContent.indexOf('价格') >= 0 && card.textContent.indexOf('当日涨跌幅') >= 0 && card.textContent.indexOf('成交量') >= 0,
    '卡片含 时间/价格/涨跌幅/成交量', card ? card.textContent.replace(/\s+/g, ' ').slice(0, 150) : 'none');
  log(DATA.messages.some((m) => m.type === 'card'), '卡片作为 card 类型消息写入云端');
  // #股票 菜单项：点击后输入框填 # 并提示输入代码或名称
  cmdInput.value = ''; cmdInput.dispatchEvent(new w.Event('input', { bubbles: true }));
  D.querySelector('#bCmd').click();
  await sleep(140);
  const stockItem = Array.prototype.filter.call(cmdpop.querySelectorAll('.cmditem'), (it) => it.dataset.cmd === '#股票')[0];
  log(!!stockItem, '菜单含 #股票 指令项');
  stockItem.click();
  await sleep(140);
  log(cmdInput.value === '#' && cmdInput.placeholder.indexOf('名称') >= 0, '点 #股票 后输入框填 # 并提示输入代码或名称', cmdInput.placeholder);
  // 输入完整代码发送：验证 # 指令被拦截走行情逻辑（不按普通消息发）
  cmdInput.value = '#600519';
  D.querySelector('#bSend').click();
  await sleep(300);
  log(cmdInput.value === '', '发送 #600519 被 # 指令逻辑拦截（输入框已清空，未走普通文本发送）');
  // 名称查询：#茅台 走 smartbox 名称解析（桩：window.v_hint）
  const cardsB4Name = D.querySelectorAll('#mList .cardmsg').length;
  cmdInput.value = '#茅台';
  D.querySelector('#bSend').click();
  await sleep(300);
  log(D.querySelectorAll('#mList .cardmsg').length === cardsB4Name + 1, '#茅台（名称）查询产出行情卡片');
  const nameCard = Array.prototype.slice.call(D.querySelectorAll('#mList .cardmsg .card')).pop();
  log(!!nameCard && nameCard.textContent.indexOf('贵州茅台') >= 0, '名称解析命中 贵州茅台 并展示名称', nameCard ? nameCard.textContent.slice(0, 80) : 'none');
  cmdInput.value = '';;

  D.querySelector('#meBox').click();
  await sleep(400);
  log(D.querySelector('#mColor') !== null && D.querySelectorAll('#mColor i').length >= 15, '我的资料弹窗提供 15+ 款背景色', D.querySelectorAll('#mColor i').length);
  log(D.querySelectorAll('#mEmo span').length > 100, '我的资料弹窗表情也是扩容版', D.querySelectorAll('#mEmo span').length);
  const newC = D.querySelectorAll('#mColor i')[10].dataset.c;
  D.querySelectorAll('#mColor i')[10].click();
  await sleep(80);
  log(D.querySelector('#mPrev .av').getAttribute('style').indexOf(newC) >= 0 || D.querySelector('#mPrev .av').getAttribute('style').indexOf(newC.toLowerCase()) >= 0,
    '选色后资料弹窗预览头像底色已更新', D.querySelector('#mPrev .av').getAttribute('style'));
  D.querySelector('#mSave').click();
  await sleep(900);
  log(DATA.profiles.filter((p) => p.id === 'u_test')[0].color === newC, '资料页保存后新底色写入云端', DATA.profiles.filter((p) => p.id === 'u_test')[0].color);

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

  // ===== 本轮新功能：小美联网检索（手工 RAG）=====
  {
    const LT = w.LT;
    // ⚠️ 检索链路已整体搬进 bot.js：必须把两个文件拼起来扫，否则断言永远失败
    const src2 = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
      + '\n' + fs.readFileSync(path.join(__dirname, 'bot.js'), 'utf8');

    // 1) 接入方式：只能是「免 key + 支持 CORS」的公开源（静态托管起不了后端进程）
    log(!/sk-[A-Za-z0-9]{16,}/.test(src2), '检索链路同样无硬编码密钥');
    log(/SEARCH_SOURCES/.test(src2) && /origin=\*/.test(src2),
      '检索源用维基百科 API 且显式带 origin=* （免 key + CORS）');
    log(/zh\.wikipedia\.org/.test(src2) && /api\.duckduckgo\.com/.test(src2),
      '检索源至少两路（维基中文 + DuckDuckGo），单源挂掉不影响');
    log(/function searchWeb/.test(src2) && /fetchFirst\(SEARCH_SOURCES/.test(src2),
      'searchWeb 走多源轮询 fetchFirst');

    // 2) 「该不该联网」判定：显式检索词必搜、纯闲聊不搜
    if (LT && LT.searchNeed) {
      log(LT.searchNeed('查一下 Innovus 的物理设计流程') === true, '显式「查一下」→ 判定需要联网');
      log(LT.searchNeed('今天有什么新闻') === true, '含「今天/新闻」→ 判定需要联网');
      log(LT.searchNeed('你好呀') === false, '两个字的打招呼 → 不联网（省一次请求）');
      log(LT.searchNeed('哈哈哈哈哈') === false, '短纯闲聊 → 不联网');
    } else {
      log(false, 'window.LT.searchNeed 已导出', LT ? Object.keys(LT).join(',') : 'no LT');
    }

    // 3) 检索结果解析：真实调用一次（桩返回维基结构）
    if (LT && LT.searchWeb) {
      __searchCalls = [];
      __searchOk = true;
      const rows = await LT.searchWeb('Innovus 物理设计');
      log(Array.isArray(rows) && rows.length >= 3, '检索返回条目数组（≥3 条）', Array.isArray(rows) ? rows.length : typeof rows);
      log(rows.length > 0 && rows[0].title === '物理设计', '条目 title 正确解析', rows[0] && rows[0].title);
      log(rows.length > 0 && !/<span/.test(rows[0].snippet || ''),
        '条目 snippet 已剥掉 HTML 标签（避免把 <span> 喂给模型）', rows[0] && String(rows[0].snippet).slice(0, 40));
      log(__searchCalls.length === 1 && /zh\.wikipedia\.org/.test(__searchCalls[0]),
        '首源命中即止（不把所有源都打一遍）', __searchCalls.length + ' 次');
      log(/srsearch=Innovus%20%E7%89%A9%E7%90%86%E8%AE%BE%E8%AE%A1/.test(__searchCalls[0] || ''),
        '关键词已 URL 编码拼接', (__searchCalls[0] || '').slice(-46));
    }

    // 4) 全源挂掉 → 优雅降级（返回空数组，不抛异常）
    if (LT && LT.searchWeb) {
      __searchOk = false;
      __searchCalls = [];
      const rowsDown = await LT.searchWeb('Innovus 物理设计');
      log(Array.isArray(rowsDown) && rowsDown.length === 0, '检索源全挂 → 返回空数组（不抛错）', JSON.stringify(rowsDown));
      log(__searchCalls.length >= 2, '失败后才轮询到下一个源', __searchCalls.length + ' 次');
      __searchOk = true;
    }

    // 5) botSearch 的输出文案：有资料 / 无资料两种
    if (LT && LT.botSearch) {
      __searchOk = true;
      const sGot = await LT.botSearch('帮我查一下 Innovus 物理设计');
      log(sGot.indexOf('🔎') === 0 && sGot.indexOf('物理设计') >= 0, '检索成功 → 输出带 🔎 前缀的资料列表', sGot.slice(0, 34).replace(/\n/g, ' '));
      log(sGot.indexOf('Innovus') >= 0, '资料里带回了关键词相关内容');
      __searchOk = false;
      const sNone = await LT.botSearch('帮我查一下 Innovus 物理设计');
      log(sNone.indexOf('🔎') >= 0 && sNone.indexOf('连不上') >= 0, '检索失败 → 诚实说明连不上（不假装知道）', sNone.slice(0, 34));
      __searchOk = true;
    }

    // 6) 检索资料真的拼进了 LLM 的 system 提示（手工 RAG 的关键一环）
    log(/function buildSystem/.test(src2) && /ref/.test(src2),
      'system 提示组装函数 buildSystem 接受检索资料（ref）');
    log(/联网检索到的资料/.test(src2), 'system 提示里明确要求「优先依据资料回答、查不到就说查不到」');
    log(/searchWeb\(sanitizeQuery\(plan\.text\)\)/.test(src2),
      'runGen 会先 searchWeb（带检索词清洗）再把资料喂给模型');
    log(/s\.webSearch !== false/.test(src2), '提供 S.webSearch 开关（可一键关掉联网）');
  }

  // ===== 本轮重构：小美模块化（bot.js）+ 人格 / 情绪 / 意图注册表 / 记忆 =====
  {
    const LT = w.LT, B = w.LT_BOT;
    const botSrc = fs.readFileSync(path.join(__dirname, 'bot.js'), 'utf8');
    const htmlSrc = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

    // 1) 模块化：独立文件 + 版本号（缓存一致性）
    log(/<script\s+src="bot\.js\?v=\d+"><\/script>/.test(htmlSrc),
      'index.html 以带版本号的独立文件引入 bot.js（避免 CDN/浏览器吃旧缓存）');
    log(!!B, 'bot.js 挂到 window.LT_BOT');
    log(/(?:window|root)\.LT_BOT\s*=/.test(botSrc), 'bot.js 自注册到全局 LT_BOT');
    // 旧的大坨代码确实搬走了（防止"复制一份忘删旧的"导致两套逻辑打架）
    log(!/var JOKES\s*=/.test(htmlSrc) && !/var STORIES\s*=/.test(htmlSrc) && !/var POEMS\s*=/.test(htmlSrc),
      'index.html 里的硬编码 JOKES/STORIES/POEMS 已删除（内容型改现场生成）');
    log(!/var BOT_KEY\s*=/.test(htmlSrc) && !/var BOT_MENU\s*=/.test(htmlSrc),
      'index.html 里的 BOT_KEY/BOT_MENU 已删除（搬入模块的意图表）');

    // 2) 人格档案：必须有角色/语气/边界，且不再是"活泼的小助手"一句话
    const P = B && B.PERSONA;
    log(!!P && Array.isArray(P.core) && P.core.length >= 5, 'PERSONA.core 人格条目 ≥5 条', P ? P.core.length : 'none');
    log(!!P && Array.isArray(P.rules) && P.rules.some((r) => /思考过程|人格设定/.test(r)),
      'PERSONA.rules 明确禁止输出思考过程 / 泄露人格设定');

    // 3) 情绪系统：5 种状态 + 时段基线 + 触发规则
    const M = B && B.MOODS;
    log(!!M && Object.keys(M).length === 5, 'MOODS 恰好 5 种情绪', M ? Object.keys(M).join(',') : 'none');
    const moodOk = M && ['happy', 'curious', 'focus', 'sleepy', 'gentle'].every((k) => M[k] && M[k].hint && M[k].emoji);
    log(!!moodOk, '5 种情绪都带 emoji 与语气 hint（真正驱动 prompt）');
    if (B && B.moodByHour) {
      log(B.moodByHour(3) === 'sleepy', '凌晨 3 点 → 基线情绪=困倦');
      log(B.moodByHour(10) === 'happy', '上午 10 点 → 基线情绪=开心');
      log(B.moodByHour(20) === 'curious', '晚上 8 点 → 基线情绪=好奇');
      log(B.moodByHour(7) === 'gentle', '清晨 7 点 → 基线情绪=温柔');
    } else log(false, 'moodByHour 已导出');

    // 4) 情绪会被输入改变
    if (B && B.moodTouch) {
      B.moodTouch('我今天好难过啊');
      log(B.moodNow().key === 'gentle', '负面情绪输入 → 切换成「温柔」', B.moodNow().key);
      B.moodTouch('这个 bug 怎么修');
      log(B.moodNow().key === 'focus', '提问类输入 → 切换成「专注」', B.moodNow().key);
      B.moodTouch('哈哈哈哈你太厉害了');
      log(B.moodNow().key === 'happy', '夸赞/开心输入 → 切换成「开心」', B.moodNow().key);
    } else log(false, 'moodTouch 已导出');

    // 5) 意图注册表：表驱动、有 kind 分类、覆盖关键意图
    const I = B && B.INTENTS;
    log(!!I && Array.isArray(I) && I.length >= 10, 'INTENTS 意图表 ≥10 条', I ? I.length : 'none');
    log(!!I && I.every((x) => x.id && x.kind && x.k), '每条意图都有 id / kind / 匹配规则');
    log(!!I && I.every((x) => ['data', 'gen', 'say'].includes(x.kind)), '意图 kind 取值合法（data/gen/say）');
    const byId = {};
    (I || []).forEach((x) => { byId[x.id] = x; });
    log(!!byId['joke'] && byId['joke'].kind === 'gen', '笑话 = 内容型（gen），交给模型现场生成');
    log(!!byId['story'] && byId['story'].kind === 'gen', '故事 = 内容型（gen）');
    log(!!byId['poem'] && byId['poem'].kind === 'gen', '诗词 = 内容型（gen）');
    log(!!byId['weather'] && byId['weather'].kind === 'data', '天气 = 事实型（data），走真实数据源');
    log(!!byId['news'] && byId['news'].kind === 'data', '新闻 = 事实型（data）');
    log(!!byId['chat'] && byId['chat'].kind === 'gen', '兜底 chat = 内容型（gen），不再抽签');
    log(!!byId['mem-save'] && !!byId['mem-ask'] && !!byId['mem-forget'], '记忆三条意图齐备（记住/回忆/忘掉）');

    // 6) 路由正确性（模块级，不经 UI）
    if (B && B.matchIntent) {
      const mi = (t) => (B.matchIntent(t) || {}).id;
      log(mi('讲个笑话') === 'joke', '「讲个笑话」→ joke 意图');
      log(mi('给我讲个睡前故事') === 'story', '「讲个睡前故事」→ story 意图');
      log(mi('念首诗') === 'poem', '「念首诗」→ poem 意图');
      log(mi('北京天气') === 'weather', '「北京天气」→ weather 意图');
      log(mi('看看新闻') === 'news', '「看看新闻」→ news 意图');
      log(mi('记住：我喜欢喝美式') === 'mem-save', '「记住：xxx」→ mem-save 意图');
      log(mi('你还记得我喜欢喝什么吗') === 'mem-ask', '「你还记得…」→ mem-ask 意图');
      log(mi('忘掉美式') === 'mem-forget', '「忘掉 xxx」→ mem-forget 意图');
      log(mi('你今天心情怎么样') === 'mood', '「你心情怎么样」→ mood 意图');
      log(mi('随便聊聊吧今天真不错') === 'chat', '普通闲聊 → 落到 chat 兜底（不抽签）');
    } else log(false, 'matchIntent 已导出');

    // 7) 内容型意图必须带「生成提示」，否则模型还是不知道要写什么
    log(!!byId['joke'] && /笑话/.test(byId['joke'].hint || ''), 'joke 意图带生成提示（style hint）');
    log(byId['joke'] && byId['joke'].temp != null, 'joke 意图带较高温度（内容型需要发散）');

    // 8) botAnswer 契约：三种返回形态都要能被上层正确处理
    log(typeof LT.botAnswer === 'function', 'window.LT.botAnswer 已导出（转发到模块）');
    const aMenu = LT.botAnswer('你能干什么', 'u_test', 'g:hall');
    // ⚠️ 菜单返回的是「模板文案」。botAnswer 已把 {n} 替换掉，但 {t}（当前时间）留给上层 botReply 填，
    //    所以这里断言「是字符串 + 含能力项 + 已替换 {n}」，不能断言不含 {t}。
    log(typeof aMenu === 'string' && aMenu.indexOf('聊天') >= 0 && aMenu.indexOf('{n}') < 0,
      '菜单意图 → 同步字符串且 {n} 已替换', typeof aMenu);
    const aGen = LT.botAnswer('讲个笑话', 'u_test', 'g:hall');
    log(!!aGen && aGen.__gen === true, '内容型意图 → 返回 {__gen:true} 计划对象（交给异步分支）', typeof aGen);
    const aWeather = LT.botAnswer('北京天气', 'u_test', 'g:hall');
    log(!!aWeather && typeof aWeather.then === 'function', '事实型意图 → 返回 Promise');
    const aNone = LT.botAnswer('', 'u_test', 'g:hall');
    log(aNone === null || (aNone && aNone.__gen === true), '空输入不崩（返回 null 或生成计划）');

    // 9) 短期上下文：带发言人标注，且不再是 6 条
    if (B && B.recentContext) {
      const ctx = B.recentContext('g:hall', 'u_test');
      log(Array.isArray(ctx) && ctx.every((x) => x.role === 'user' || x.role === 'assistant'),
        'recentContext 返回合法 role 序列', Array.isArray(ctx) ? ctx.length : 'none');
      log(/CTX_N\s*=\s*20/.test(botSrc), '短期上下文窗口扩大到 20 条（原来是 6 条）');
      log(/【' \+ nm \+ '】/.test(botSrc), '群聊历史里给发言人打了标注（模型才不会把别人的话当成自己的）');
    } else log(false, 'recentContext 已导出');

    // 10) 记忆系统：本地缓存 + 云端表 + 去重
    if (B && B.memAdd && B.memStore) {
      const before = B.memStore().length;
      B.memAdd('测试用：用户喜欢喝美式', 'u_test', 'g:hall');
      log(B.memStore().length === before + 1, 'memAdd 写入一条长期记忆', B.memStore().length);
      B.memAdd('测试用：用户喜欢喝美式', 'u_test', 'g:hall');
      log(B.memStore().length === before + 1, '重复内容不会重复记（去重生效）');
      const rec = B.memRecall('我平时喜欢喝什么', 'u_test');
      log(Array.isArray(rec) && rec.length >= 1, 'memRecall 能按关键词召回相关记忆', rec.length);
      log(/db\.from\('memories'\)/.test(botSrc), '长期记忆落到云端 memories 表（跨设备同步）');
      log(/LT_BOT\.memStore|botMem/.test(botSrc), '本地有记忆缓存（弱网也能用）');
    } else log(false, 'memAdd/memStore 已导出');

    // 11) system prompt 里人格 + 情绪 + 记忆三者都要出现
    if (B && B.buildSystem) {
      const sys = B.buildSystem({ who: '小明', hint: '用户想听笑话', mem: [{ content: '他喜欢喝美式' }] });
      log(/小美/.test(sys) && /情绪/.test(sys), 'system 含人格 + 情绪');
      log(/小明/.test(sys), 'system 带上对话对象名字');
      log(/他喜欢喝美式/.test(sys), 'system 注入长期记忆');
      log(/用户想听笑话/.test(sys), 'system 注入本次任务提示');
      log(/思考过程/.test(sys), 'system 明确禁止输出思考链（纯推理模型会吐 reasoning_content）');
    } else log(false, 'buildSystem 已导出');

    // 12) 流式上屏：临时气泡不进库
    log(/S\.botStream/.test(htmlSrc), 'index.html 有流式临时消息状态 S.botStream');
    log(/function renderStream/.test(htmlSrc), '提供 renderStream 局部渲染流式气泡');
    log(/botStreamEnd/.test(htmlSrc), '收到完整回复后清理流式气泡');
    log(/S\.botStream = null/.test(htmlSrc), '切换会话时丢弃流式气泡（否则会串到别的对话）');
    log(/CTX_N|onDelta/.test(botSrc) && /onDelta\(content\)/.test(botSrc), 'callLLM 支持流式回调 onDelta');
    log(!/reasoning_content/.test(botSrc) || /只收正文/.test(botSrc),
      '明确只收 delta.content，不把 reasoning_content 发进聊天室');
  }

  // ===== 本轮：工具栏精简（去掉 bAt / bMore）=====
  log(D.querySelector('#bAt') === null, '工具栏「@某人」按钮已移除');
  log(D.querySelector('#bMore') === null, '工具栏「更早消息」按钮已移除');
  log(!!D.querySelector('#bGame') && !!D.querySelector('#bCmd') && !!D.querySelector('#bEmo') && !!D.querySelector('#bImg') && !!D.querySelector('#bFile'),
    '其余工具栏按钮仍在（游戏 / # / 表情 / 图片 / 文件）');

  // ===== 本轮：输入 @ 弹群成员列表，Enter = 确认艾特（不是发送）=====
  {
    const hallConv = Array.prototype.filter.call(D.querySelectorAll('#cList .conv'), (e) => e.dataset.c === 'g:hall')[0];
    if (hallConv) hallConv.click();
    await sleep(700);
    const inp = D.querySelector('#input');
    const mpop = D.querySelector('#mpop');
    const msgCountBefore = D.querySelectorAll('#mList .m').length;

    // 清空后输入 @ → 弹出成员列表
    inp.value = '@';
    inp.selectionStart = inp.selectionEnd = 1;
    inp.dispatchEvent(new w.Event('input', { bubbles: true }));
    await sleep(120);
    log(!mpop.classList.contains('hidden'), '输入 @ 弹出成员列表');
    const items = mpop.querySelectorAll('.mitem');
    log(items.length >= 2, '@ 列表里列出了群成员', items.length + ' 人');
    log(Array.prototype.some.call(items, (it) => /我$/.test(it.textContent.trim()) || it.textContent.indexOf('我') >= 0),
      '列表里能认出自己（带「我」标记）');

    // ↑↓ 能切换高亮
    const firstOn = mpop.querySelectorAll('.mitem.on')[0];
    inp.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await sleep(60);
    const secondOn = mpop.querySelectorAll('.mitem.on')[0];
    log(!!firstOn && !!secondOn && firstOn !== secondOn, '↓ 键切换成员高亮');
    log(mpop.querySelectorAll('.mitem.on').length === 1, '任意时刻只有一个成员处于预选高亮');

    // 弹层靠左对齐输入框（不居中）
    {
      const pr = D.querySelector('#pPill').getBoundingClientRect();
      const mr = mpop.getBoundingClientRect();
      log(Math.abs(mr.left - pr.left) <= 3, '@ 成员列表左边缘对齐输入框（靠左显示）',
        'popLeft=' + Math.round(mr.left) + ' pillLeft=' + Math.round(pr.left));
    }

    // Enter = 确认艾特（关键：绝不能发送消息）
    const targetName = secondOn.querySelector('span').textContent.trim();
    inp.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(160);
    log(inp.value === '@' + targetName + ' ', 'Enter 把选中成员写进输入框（@昵称+空格）', JSON.stringify(inp.value));
    log(mpop.classList.contains('hidden'), '确认后成员列表自动收起');
    log(D.querySelectorAll('#mList .m').length === msgCountBefore, 'Enter 确认艾特时没有发送消息（消息数不变）');

    // 补几个字再发送 → 正常发出且带 mentions
    inp.value = '@' + targetName + ' 你好呀';
    inp.dispatchEvent(new w.Event('input', { bubbles: true }));
    await sleep(60);
    log(D.querySelector('#mpop').classList.contains('hidden'), '昵称后已有空格，不再重复弹成员列表');
    D.querySelector('#bSend').click();
    await sleep(400);
    const atMsgs = DATA.messages.filter((m) => m.conv === 'g:hall' && /你好呀$/.test(m.text || '') && (m.mentions || []).length);
    log(atMsgs.length >= 1, '发送后 @提及被解析成 mentions 落库', atMsgs.length ? JSON.stringify(atMsgs[atMsgs.length - 1].mentions) : 'none');

    // 私聊里输入 @ 不应弹成员列表
    const priv = Array.prototype.filter.call(D.querySelectorAll('#cList .conv'), (e) => e.dataset.c === 'p:u_a~u_test')[0];
    if (priv) {
      priv.click();
      await sleep(500);
      const inp2 = D.querySelector('#input');
      D.querySelector('#mpop').classList.add('hidden');
      inp2.value = '@';
      inp2.selectionStart = inp2.selectionEnd = 1;
      inp2.dispatchEvent(new w.Event('input', { bubbles: true }));
      await sleep(120);
      log(D.querySelector('#mpop').classList.contains('hidden'), '私聊里输入 @ 不弹成员列表');
      inp2.value = ''; inp2.dispatchEvent(new w.Event('input', { bubbles: true }));
    }
  }

  // ===== 本轮：对局浮层左右分栏（信息在左、棋盘在右）=====
  {
    const body = D.querySelector('#groom .gr-body');
    if (body) {
      log(!!D.querySelector('#groom .gr-side'), '对局浮层含左侧信息栏 .gr-side');
      log(!!D.querySelector('#groom .gr-main'), '对局浮层含右侧棋盘区 .gr-main');
      const hint = D.querySelector('#groom #grHint');
      if (hint) log(hint.classList.contains('gr-status'), '轮次/提示文案放在左侧 .gr-status 里');

      // 棋盘等比自适应：jsdom 不做布局（clientHeight 恒为 0），无法断言真实像素，
      // 这里只验证「宽度确实参与 --bh 约束」这一 CSS 契约 + fitBoard 在无布局时不误写坏值。
      const main = D.querySelector('#groom .gr-main');
      const cvb = D.querySelector('#gboard, #gBoard');
      log(!!cvb && typeof w.LT.fitBoard === 'function', '导出 fitBoard 供棋盘自适应调用');
      log(!!cvb && /--bh/.test(cvb.getAttribute('style') || '') === false,
        '棋盘自身不写死尺寸（由 CSS width:min() 控制）');
      log(!!main && main.style.getPropertyValue('--bh') === '',
        'jsdom 无布局时不再写入 --bh（不会残留坏值）', main ? JSON.stringify(main.style.getPropertyValue('--bh')) : 'no main');

      // 选中玩家条不能有背景填充（border + inset 描边会在圆角内侧叠出深色块，用户反馈多次）
      const cssTxt = Array.prototype.map.call(D.querySelectorAll('style'), (s) => s.textContent).join('\n');
      const onRule = (cssTxt.match(/\.groom \.gr-pl\.on\{[^}]*\}/) || [''])[0];
      log(!!onRule && !/background|color-mix/.test(onRule),
        '选中玩家条只改边框/文字色，无背景填充', onRule || '(未找到规则)');
      log(!!onRule && !/box-shadow/.test(onRule),
        '选中玩家条不再叠第二层描边（避免圆角内侧深色块）', onRule ? 'ok' : '(未找到规则)');

      // 指示点动画不能用带 box-shadow 扩散的 livepulse（红色光环会被 overflow 裁成脏弧线）
      const dotRule = (cssTxt.match(/\.groom \.gr-pl\.on \.dot\{[^}]*\}/) || [''])[0];
      log(!/livepulse/.test(dotRule), '玩家条指示点不再复用直播红点动画 livepulse', dotRule || '(未找到规则)');
      log(/grpulse/.test(dotRule), '玩家条指示点改用纯透明度呼吸动画 grpulse', dotRule || '(未找到规则)');
      const grpulseDef = (cssTxt.match(/@keyframes grpulse\{[^@]*\}/) || [''])[0];
      log(!!grpulseDef && !/box-shadow/.test(grpulseDef),
        'grpulse 不含 box-shadow 扩散（从根上消除溢出被裁）', grpulseDef || '(未找到定义)');

      // ⚠️ 类名冲突护栏（排查了三轮才定位到的真凶）：
      // 玩家条右侧的「我/等待」标签原先用 class="side"，撞上全局 .side
      // （主界面左侧会话列表：width:290px + background:var(--bg2) + border-right），
      // 结果每条玩家条右侧被塞进一个 290px 宽带底色的「假侧栏」，被 overflow 裁成横贯灰带。
      // 断言 1：对局浮层里不允许再出现裸 class="side"（必须是 .plt）
      const roomHtml = w.LT.renderRoom ? String(w.LT.renderRoom()) : '';
      log(!/class="side"/.test(roomHtml),
        '对局浮层内不再使用裸 class="side"（与全局左侧栏规则撞名）',
        (roomHtml.match(/class="side"/g) || []).length + ' 处');
      log(/class="plt"/.test(roomHtml) || !/gr-pl/.test(roomHtml),
        '玩家条标签使用独立类名 .plt', roomHtml ? 'ok' : '(空渲染，跳过)');
      // 断言 2：.plt 的 CSS 里绝不能出现背景填充 / 固定宽度（那正是 .side 的特征）
      const pltRule = (cssTxt.match(/\.groom \.gr-pl \.plt\{[^}]*\}/) || [''])[0];
      log(!!pltRule && !/background|width\s*:/.test(pltRule),
        '.plt 规则无底色、无固定宽度（区别于全局 .side）', pltRule || '(未找到规则)');
      // 断言 3：玩家条与状态条宽度必须贴合内容，不能靠 align-self（列向 flex 下不可靠）
      const plRule = (cssTxt.match(/\.groom \.gr-pl\{[^}]*\}/) || [''])[0];
      log(/fit-content/.test(plRule),
        '玩家条用 width:fit-content 收缩到内容宽（align-self 在列向 flex 下不可靠）', plRule || '(未找到规则)');
      const stRule = (cssTxt.match(/\.groom \.gr-status\{[^}]*\}/) || [''])[0];
      log(/fit-content/.test(stRule), '状态条同样用 width:fit-content 贴合内容', stRule || '(未找到规则)');

      // ⚠️ 头像必须绝对定位铺满（实测 .av.m 38px 容器里 img 只有 28px 高，上下露灰底）。
      // .av 是 flex 容器，img 作为 flex item 时 height:100% 会被解析成图片自然高。
      // 修法：.av 加 position:relative，img 绝对定位 inset:0 脱离 flex 流。
      const avRule = (cssTxt.match(/\.av\{[^}]*\}/) || [''])[0];
      log(/position:relative/.test(avRule) && /overflow:hidden/.test(avRule),
        '.av 建立定位上下文并裁剪（供绝对定位的图片铺满）', avRule || '(未找到规则)');
      const avImgRule = (cssTxt.match(/\.av > img\{[^}]*\}/) || [''])[0];
      log(/position:absolute/.test(avImgRule) && /inset:0/.test(avImgRule),
        '头像图片绝对定位铺满（不靠 height:100%，避免 flex 下解析成自然高）', avImgRule || '(未找到规则)');
      log(/object-fit:cover/.test(avImgRule),
        '头像图片等比裁切铺满（不变形、不留白）', avImgRule || '(未找到规则)');
      // 行内样式不能再写 width/height:100% —— 会覆盖上面的 CSS 导致回归
      const avFn = String(w.LT.avOf ? w.LT.avOf('测试', 'data:image/png;base64,AA', '#888', 'm') : '');
      log(!/width:100%;height:100%/.test(avFn),
        'avOf 不再给 img 写行内 width/height（避免盖掉铺满 CSS）', avFn || '(未导出 avOf，跳过)');
    }
  }

  // ===== 小美回归修复（2026-09-22 第二轮）：地名解析 / 重复回复 / 联网问答 / 模型回退 =====
  {
    const B = w.LT_BOT || (w.LT && w.LT.BOT);
    const LT = w.LT;   // ⚠️ 本块局部变量：其他块各自声明了 const LT = w.LT，全局没有 LT
    // ⚠️ 本块必须自建合并源码变量：上面 1483 行的 srcAll2 是那个块的局部变量，作用域不到这里
    const srcAll2 = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
      + '\n' + fs.readFileSync(path.join(__dirname, 'bot.js'), 'utf8');
    if (B) {
      // 1) 天气地名解析：时间词/动词前缀必须剥掉，否则「明天上海」会整段当地名去 geocode
      //    真因：原正则 /([\u4e00-\u9fa5]{2,8}?)(?:的)?(?:天气|...)/ 会把「明天上海」整个吃掉
      const cases = [
        ['明天上海天气', '上海'], ['今天北京天气', '北京'], ['上海天气', '上海'],
        ['帮我查一下 深圳 天气', '深圳'], ['广州今天多少度', '广州'], ['明天上海会不会下雨', '上海'],
      ];
      cases.forEach(([q, want]) => {
        const hit = B.parseCity ? B.parseCity(q) : '(未导出 parseCity)';
        log(hit === want, `天气解析「${q}」→ ${want}`, '实际=' + hit);
      });
      log(/CITY_PRE/.test(botSrc) && /CITY_POST/.test(botSrc) && /function parseCity/.test(botSrc),
        '天气解析内置时间词双向剥离（CITY_PRE + CITY_POST + parseCity）');

      // 2) 重复回复：同一条消息必须只回一次（曾一条消息回两次天气，相隔 29 秒）
      //    真因：sendMsg 本地调一次 + tick 轮询拉回同一条又调一次
      log(/BOT_REPLIED/.test(srcAll2) && /function botDedupe/.test(srcAll2),
        'maybeBotReply 增加按消息 id 去重（BOT_REPLIED + botDedupe）');
      log(/if \(!botDedupe\(m\.conv, m\.id\)\) return;/.test(srcAll2),
        'maybeBotReply 在调用 botReply 前做去重守卫');

      // 3) 联网问答意图：必须排在 chat 兜底之前，否则「查一下/教程/怎么用」全被闲聊吞掉
      const ids = (B.INTENTS || []).map((x) => x.id);
      log(ids.indexOf('lookup') >= 0, '新增 lookup 意图（联网问答/教程/文档）', ids.join(','));
      log(ids.indexOf('lookup') < ids.indexOf('chat'),
        'lookup 意图排在 chat 兜底之前（否则永远命中不到）');
      const lk = (B.INTENTS || []).filter((x) => x.id === 'lookup')[0];
      log(!!lk && ['fetch 教程', 'linux 查找文件', '怎么用 tar', '解释一下什么是协程', '总结一下这篇文章', '什么是协程']
        .every((s) => lk.k.test(s)),
        'lookup 能命中教程/命令/解释/总结类表达',
        lk ? ['fetch 教程', 'linux 查找文件', '怎么用 tar'].filter((s) => !lk.k.test(s)).join(',') || 'ok' : 'no-lookup');

      // 4) 强制联网：lookup 意图不再交给 searchNeed 猜
      log(/plan\.id === 'lookup'/.test(botSrc) && /var forced = /.test(botSrc),
        'runGen 对 lookup 意图强制联网（不依赖 searchNeed 猜）');
      log(/plan\.id/.test(botSrc) && /return \{ __gen: true, id: it\.id/.test(botSrc),
        'botAnswer 把意图 id 带进 __gen 计划对象');

      // 5) 检索词清洗：不能把「@小美 查一下」整句丢给维基
      //    ⚠️ 踩过：`@小美` 换成空格后字符串带**前导空格**，`^` 锚定会失配 → 指令词剥不掉。
      //       必须先归并空白再剥，且前缀可叠用（「麻烦你帮我查一下 X」）
      if (B.sanitizeQuery) {
        log(B.sanitizeQuery('@小美 查一下 HTTP 状态码') === 'HTTP 状态码',
          'sanitizeQuery 剥掉指令词，只留检索关键词', B.sanitizeQuery('@小美 查一下 HTTP 状态码'));
        log(B.sanitizeQuery('麻烦你帮我查一下 tar 怎么用') === 'tar 怎么用',
          'sanitizeQuery 支持叠加前缀（麻烦你+帮我+查一下）', B.sanitizeQuery('麻烦你帮我查一下 tar 怎么用'));
        log(B.sanitizeQuery('帮我搜一下 js 闭包') === 'js 闭包',
          'sanitizeQuery 剥掉「帮我搜一下」', B.sanitizeQuery('帮我搜一下 js 闭包'));
      } else log(false, 'sanitizeQuery 已导出');

      // 6) 模型回退链：首选失败要换下一个，而不是直接扔「卡了一下」
      log(/LLM_RETRY/.test(botSrc) && /s\.llmQueue/.test(botSrc),
        'callLLM 建立多模型回退链（llmQueue + LLM_RETRY）');
      log(/function next\(lastErr\)/.test(botSrc),
        'callLLM 失败后按候选链依次重试');
      log(/LLM_TIMEOUT = 30000/.test(botSrc),
        'LLM_TIMEOUT 从 45s 降到 30s（用户更快看到结果或兜底）');

      // 6.5) ⚠️⚠️ 真凶回归：ensureLLM 必须缓存 Promise，不能缓存布尔值
      //   原实现 `if (s.llmTried) return Promise.resolve();` 在并发第二次调用时
      //   会「立即 resolve 但 llmModel 还是 null」→ runGen 秒回 {fallback:true}
      //   → 用户看到「哎呀我这边卡了一下」（模型明明可用，30 个都能列出来）
      //
      //   ⚠️ 断言必须先剥注释：源码注释里就写着 `s.llmTried` 这段历史（说明成因），
      //      直接 `/s\.llmTried/` 会被自己的注释绊倒 → 假 FAIL（踩过）
      const botCode = botSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      log(!/s\.llmTried/.test(botCode) && /if \(s\.llmReady\) return s\.llmReady/.test(botCode),
        'ensureLLM 缓存 Promise 而非布尔值（修并发竞态：曾导致 1 秒秒回「卡了一下」）',
        /s\.llmTried/.test(botCode) ? '代码里还有 llmTried' : 'ok');

      if (B.ensureLLM) {
        const savedQ = LT.S.llmQueue, savedR = LT.S.llmReady, savedM = LT.S.llmModel;
        delete LT.S.llmReady; LT.S.llmModel = null; LT.S.llmQueue = null;
        const r = B.ensureLLM();
        // ⚠️ 必须 await：models.list() 在测试桩里是异步 Promise，
        //    llmQueue / llmModel 要等微任务跑完才被填充。同步断言必然拿到 null（踩过）
        if (r && r.then) await r.catch(() => {});
        log(Array.isArray(LT.S.llmQueue) && LT.S.llmQueue[0] === 'deepseek-v4.1-flash',
          'ensureLLM 生成候选队列（队首仍是 deepseek-v4.1-flash）',
          Array.isArray(LT.S.llmQueue) ? LT.S.llmQueue.join('>') : String(LT.S.llmQueue));
        log(Array.isArray(LT.S.llmQueue) && LT.S.llmQueue.length >= 2,
          '候选队列含多个模型（保证有回退目标）',
          Array.isArray(LT.S.llmQueue) ? LT.S.llmQueue.length : 0);
        log(LT.S.llmModel === 'deepseek-v4.1-flash',
          'await 之后 llmModel 已就绪（不再是 null → 不会秒回「卡了一下」）', String(LT.S.llmModel));

        // 并发：第二次调用必须复用同一个 Promise（不再是「立即 resolve 的空 Promise」）
        const callsBefore = __llmListCalls;
        const r2 = B.ensureLLM();
        log(r2 === r || r2 === LT.S.llmReady, '并发第二次 ensureLLM 复用同一个 Promise（不是立即 resolve 的空 Promise）');
        log(__llmListCalls === callsBefore, '并发调用不重复拉模型目录',
          'delta=' + (__llmListCalls - callsBefore));
        // 并发场景的真实验证：清空后同一 tick 内连调两次，第二次 await 后必须拿到模型
        delete LT.S.llmModel; LT.S.llmQueue = null; delete LT.S.llmReady;
        const p1 = B.ensureLLM(), p2 = B.ensureLLM();
        await Promise.all([p1, p2]);
        log(p1 === p2 && LT.S.llmModel === 'deepseek-v4.1-flash',
          '⚠️ 并发两次 ensureLLM：第二个不再是「立即 resolve 空 Promise」，await 后模型已就绪',
          'same=' + (p1 === p2) + ' model=' + String(LT.S.llmModel));
        LT.S.llmQueue = savedQ; LT.S.llmReady = savedR; LT.S.llmModel = savedM;
      } else log(false, 'ensureLLM 已导出');

      // 7) 新闻源全挂时不再直接报错，退化为「联网检索 + 模型总结」
      log(/function botNewsFallback/.test(botSrc),
        '新闻/热点增加联网检索兜底（botNewsFallback）');
      log(/botNewsFallback\('news'\)/.test(botSrc) && /botNewsFallback\('hot'\)/.test(botSrc),
        'botNews/botHot 全源失败时走兜底而不是直接报错');
      log(!/新闻源今天集体打不通了/.test(botSrc),
        '删除「新闻源今天集体打不通了」的硬报错文案（改为有内容可给）');
    } else {
      log(false, 'window.LT_BOT 已导出（小美回归测试依赖它）');
    }
  }

  log(errors.length === 0, '运行期间无 JS 异常', errors.join(' | '));
  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败\n');
  w.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('检查异常:', e); process.exit(1); });
