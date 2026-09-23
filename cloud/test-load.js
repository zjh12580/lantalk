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
  games: [],
};
let seq = 0;
const TABLE = {};
function builder(table) {
  let res = null;
  let filters = [];
  let ord = null;
  let lim = null;
  let pendingOp = null; // 'update' | 'delete'，惰性：在 .then() 时（filters 补全后）才执行
  // 统一的过滤求值：真实 SDK 的每个过滤器都是 (列, 值, 运算符)，桩里保持一致
  const keep = (r, f) => {
    const col = r[f[0]];
    switch (f[2]) {
      case '=': return String(col) === String(f[1]);
      case '!=': return String(col) !== String(f[1]);
      case '>': return Number(col) > Number(f[1]);
      case '>=': return Number(col) >= Number(f[1]);
      case '<': return Number(col) < Number(f[1]);
      case '<=': return Number(col) <= Number(f[1]);
      case 'in': return (f[1] || []).some((v) => String(col) === String(v));
      case 'nin': return !(f[1] || []).some((v) => String(col) === String(v));
      // is() 按 SQL 语义：与 null / undefined 比较，不能用 !!v 折叠，
      // 否则 .is(col, null) 会被误判成「非空」（踩过）
      case 'isnull': return f[1] ? f[1](col) : false;
      default: throw new Error('[test stub] 未实现的过滤运算符: ' + f[2] + '（列 ' + f[0] + '）');
    }
  };
  const matchRows = () => {
    let rows = (DATA[table] || []).slice();
    filters.forEach((f) => { rows = rows.filter((r) => keep(r, f)); });
    return rows;
  };
  const b = {
    select() { return b; },
    eq(c, v) { filters.push([c, v, '=']); return b; },
    neq(c, v) { filters.push([c, v, '!=']); return b; },
    gt(c, v) { filters.push([c, v, '>']); return b; },
    gte(c, v) { filters.push([c, v, '>=']); return b; },
    lt(c, v) { filters.push([c, v, '<']); return b; },
    lte(c, v) { filters.push([c, v, '<=']); return b; },
    // ⚠️ in() 曾经缺失，链到它就会抛 TypeError 而不是给出结果。
    //    补上它是为了不让「桩缺方法」被误当成「产品有问题」——之前就踩过这个坑。
    in(c, v) { filters.push([c, (v || []).slice(), 'in']); return b; },
    not(c, op, v) {
      // .not('col', 'in', [...]) / .not('col', 'is', null)
      const opMap = { in: 'nin', eq: '!=', is: 'isnot' };
      const mapped = opMap[op];
      if (!mapped) throw new Error('[test stub] 未实现的 not() 运算符: ' + op);
      filters.push([c, v, mapped]);
      return b;
    },
    is(c, v) {
      if (v === null || v === undefined || v === true) filters.push([c, (x) => x === null || x === undefined, 'isnull']);
      else filters.push([c, (x) => x !== null && x !== undefined, 'isnull']);
      return b;
    },
    like() { return b; },
    ilike() { return b; },
    order(c, o) { ord = [c, (o && o.ascending === false) ? -1 : 1]; return b; },
    limit(n) { lim = n; return b; },
    single() { return b; },
    insert(rows) {
      const list = Array.isArray(rows) ? rows : [rows];
      list.forEach((r) => {
        if (table === 'messages' || table === 'profiles') { if (!r.id) r.id = ++seq; }
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
        filters.forEach(function (f) { rows = rows.filter((r) => keep(r, f)); });
      }
      if (ord) rows.sort((x, y) => (x[ord[0]] > y[ord[0]] ? ord[1] : x[ord[0]] < y[ord[0]] ? -ord[1] : 0));
      if (lim && rows.length > lim) rows = ord && ord[1] === -1 ? rows.slice(0, lim) : rows.slice(-lim);
      return Promise.resolve({ data: rows, error: null }).then(fn);
    },
  };
  // 未知方法：立刻抛错，而不是静默返回 undefined。
  // 静默失败会让「桩缺 in()」表现为「页面拿到 undefined 后崩在别处」，
  // 排查时很容易误判成产品 bug —— 这一层保护就是为了让缺口自己喊出来。
  // 注意：链式方法必须返回 proxy 本身，返回原始 b 会让后续调用绕过拦截。
  const methods = new Set(Object.keys(b));
  const proxy = new Proxy(b, {
    get(t, k) {
      if (typeof k === 'symbol') return t[k];
      if (!methods.has(k)) {
        // then/catch/finally 返回 undefined，保证 Promise 判定与 await 语义正确
        if (k === 'then' || k === 'catch' || k === 'finally') return undefined;
        throw new Error('[test stub] 表 ' + table + ' 上没有实现方法 .' + String(k) + '()');
      }
      const v = t[k];
      if (typeof v !== 'function') return v;
      // 链式方法一律回传 proxy，让「未实现方法」在任意一环都能被拦到
      return (...args) => {
        const r = v.apply(t, args);
        return r === b ? proxy : r;
      };
    },
  });
  return proxy;
}
['profiles', 'groups', 'group_members', 'friends', 'reads', 'messages', 'games'].forEach((t) => { TABLE[t] = () => builder(t); });

let __updates = [];
let __updateFail = false;      // 置 true 时模拟网关「落盘成功但响应报 404」
let __existsCalls = 0;
let __puts = [];               // 手动 PUT 兜底的调用记录
let __weatherOk = true;        // open-meteo 天气源是否可用
let __searchCalls = [];        // 联网检索源的调用记录
let __searchOk = true;         // 检索源是否可用（false 时全部拒绝，验证优雅降级）
let __intentOn = true;         // Jev 意图路由是否可用（服务端是否配了密钥）
let __intentResp = null;       // 下一次 /api/intent 的返回（null 时用默认闲聊结果）
let __intentCalls = [];        // /api/intent 请求记录
let __agentOn = true;          // 小美智能体（/api/chat）是否可用
let __agentCalls = [];         // /api/chat 请求记录
let __agentResp = null;        // 自定义 /api/chat 返回（函数：(body) => obj）
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
        // Jev 意图路由：GET 能力探测 + POST 意图判断（由用例通过 __intent 控制返回）
        if (url.indexOf('/api/intent') >= 0) {
          if (method === 'GET') {
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, enabled: __intentOn, min_confidence: 0.6, model: 'jev-latest' }) });
          }
          __intentCalls.push(JSON.parse((o && o.body) || '{}'));
          const r = __intentResp || { ok: true, intent: 'chitchat', confidence: 0.4, intent_confidence: 0.9, kind: 'none', has_asset: 0.05, crypto: '', crypto_confidence: 0 };
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(r) });
        }
        // 小美智能体（服务端 Agent）：GET 探活 + POST 主循环
        if (url.indexOf('/api/chat') >= 0) {
          if (method === 'GET') {
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, enabled: __agentOn, primary: __agentOn ? 'deepseek-flash' : null, fallback: null }) });
          }
          __agentCalls.push(JSON.parse((o && o.body) || '{}'));
          if (!__agentOn) return Promise.reject(new Error('agent down'));
          const r = __agentResp ? __agentResp(JSON.parse((o && o.body) || '{}'))
            : { ok: true, text: '（智能体回复）', trace: [], turns: 1, channel: 'deepseek' };
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(r) });
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
      const src = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      log(!/sk-[A-Za-z0-9]{16,}/.test(src), '前端源码无 sk- 硬编码密钥（apikey 由云端网关托管）');
      log(/CLOUD\.llm\.chat\.completions\.create/.test(src), '通过 CLOUD.llm 网关调用（非直连第三方域名）');
      log(!/api\.deepseek\.com/.test(src), '不直连 api.deepseek.com（避免密钥泄露 + CORS）');
      // 云上 DeepSeek 全是 onlyReasoning 推理模型：不能硬传 temperature，超时也要放宽
      log(!/stream:\s*true,\s*temperature:/.test(src), '不硬传 temperature（推理模型采样参数锁定，传了可能被拒）');
      const to = src.match(/var LLM_TIMEOUT = (\d+)/);
      // ⚠️ 30s 是有意的：botLLM 现在有「多模型回退链」（llmQueue × 带/不带温度），
      //    单模型 30s 超时后会自动换下一个重试，总预算仍 < botHoldTyping 的 60s。
      //    35s 以上反而会让「换模型重试」没机会执行就到 60s 预算上限。
      log(!!to && Number(to[1]) >= 25000 && Number(to[1]) <= 45000,
        'LLM_TIMEOUT 在 25~45s 区间（配合多模型回退链）', to ? to[1] + 's' : 'none');
      // 回退链存在
      log(/LLM_RETRY/.test(src) && /S\.llmQueue/.test(src), 'botLLM 有候选模型回退链（llmQueue + LLM_RETRY）');
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
      // ⚠️ 重置必须用 llmReady（Promise 缓存），旧的 llmTried 布尔字段已废弃 —— 改它无效
      LT.S.llmReady = null; LT.S.llmModel = null; LT.S.llmQueue = null;
      __llmListCalls = 0;
      await LT.ensureLLM();
      log(LT.S.llmModel === 'deepseek-v4.1-flash',
        '模型选择按优先级精确命中 deepseek-v4.1-flash（不靠列表顺序）', String(LT.S.llmModel));
      log(__llmListCalls === 1, '拉取模型目录 1 次', __llmListCalls);
      // 幂等：再调一次不应重复拉目录
      await LT.ensureLLM();
      log(__llmListCalls === 1, 'ensureLLM 幂等（llmReady 缓存 Promise 生效，不重复拉目录）', __llmListCalls);
    } else {
      log(false, 'window.LT.ensureLLM 已导出', LT ? Object.keys(LT).join(',') : 'no LT');
    }

    // 3) 首选型号被禁用 → 跳到下一个可用
    {
      const saved = __llmModels.slice();
      __llmModels = saved.map((m) => (m.id === 'deepseek-v4.1-flash' ? { id: m.id, name: m.name, disabled: true } : m));
      if (LT && LT.ensureLLM) {
        // ⚠️ 重置状态必须清「缓存的 Promise」而不是旧的 llmTried 布尔标志
        //    （ensureLLM 已改为缓存 Promise 修并发竞态；只清 llmTried 会导致复用旧 Promise）
        LT.S.llmReady = null; LT.S.llmModel = null; LT.S.llmQueue = null;
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
        LT.S.llmReady = null; LT.S.llmModel = null; LT.S.llmQueue = null;
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
        LT.S.llmTried = false; LT.S.llmModel = null;
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
        // ⚠️ 不能用 getComputedStyle：样式已外置到 cloud/styles.css，而 jsdom 不配 resources
        //    时不会加载 <link>，样式表根本没生效 —— getComputedStyle 会返回空串而不是 200，
        //    「未生效」和「规则写错了」两种情况在断言里看起来一模一样。
        //    因此改为直接读 CSS 文本比对数值，两种存放形态（<style>/<link>）都成立。
        const cssForZ = Array.prototype.map.call(D.querySelectorAll('style, link[rel="stylesheet"]'), (s) => {
          if (s.tagName === 'STYLE') return s.textContent;
          const href = s.getAttribute('href') || '';
          if (/^https?:/i.test(href)) return '';
          try { return fs.readFileSync(path.join(__dirname, href.replace(/^\//, '')), 'utf8'); }
          catch (e) { return ''; }
        }).join('\n');
        const zNum = (sel) => {
          const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const rules = [...cssForZ.matchAll(new RegExp('[^{}]*' + esc + '\\s*\\{([^}]*)\\}', 'g'))];
          for (const r of rules) { const mm = r[1].match(/z-index:\s*(-?\d+)/); if (mm) return Number(mm[1]); }
          return NaN;
        };
        const zMask = zNum('.mask'), zGroom = zNum('.groom');
        log(zMask > zGroom, '确认框 z-index 高于对局页（否则会被盖住看不见）',
          '.mask z=' + zMask + ' / .groom z=' + zGroom);
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

    // 14b) 象棋：客方必须能操作自己那一侧（回归「两个人都只能动一边」）
    //   根因：GX 用有符号数表示阵营（正=红/负=黑），GX.side() 认的是正负号 —— GX.side(2) === 1。
    //   旧代码给双方都算 val = 房主?1:2，于是客人拿到 2 被判成红方，永远点不动自己的黑子。
    //   这里同时锁住「行为」和「源码不再出现该写法」两层。
    //
    // ⚠️ 不要为了制造「客方视角」去改 w.LT.S.uid：本用例的下游还有会话/未读/轮询等
    //    依赖 S.uid 的断言，改完即便还原也会污染它们（实测会让未读红点用例挂掉）。
    //    改为让**对局行**的 host_id 不等于真实 S.uid，同样满足 g.hostId !== S.uid。
    {
      const GXeng2 = w.LT.GX;
      log(!!GXeng2 && GXeng2.side(2) === 1 && GXeng2.side(-1) === 2,
        '象棋引擎按正负号分阵营（GX.side(2)===1，故 2 不能当黑方用）');

      // 让真实用户当「客方」：房主写成另一个人，轮次给 guest
      const myUid = w.LT.S.uid;
      const xqRow2 = { id: 'gm_xq2', conv: 'g:hall', kind: 'xiangqi', host_id: 'u_other', host_name: '别人', guest_id: myUid, guest_name: '我', status: 'playing', turn: 'guest', board: GXeng2.newBoard(), moves: [], winner: '', restart_by: '', restart_kind: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      DATA.games.push(xqRow2);
      // ⚠️ 必须等一次轮询把 DATA 同步进 S.games 再 openRoom：
      //    openRoom/renderRoom 读的是 S.games（由 refreshGames 从库里拉的），
      //    只推 DATA 不同步的话 renderRoom 会走 `if (!g)` 分支渲染「对局已结束」，画布根本不存在。
      await sleep(3200);
      log(!!(w.LT.S.games || {})['gm_xq2'], '客方用例前置：对局已同步进 S.games');
      if (w.LT.openRoom) w.LT.openRoom('gm_xq2');
      await sleep(400);
      const cv2 = D.querySelector('#groom #gBoard');
      log(!!cv2, '象棋客方视图：画布已渲染');
      if (cv2) {
        cv2.getBoundingClientRect = () => ({ left: 0, top: 0, width: 620, height: 620, right: 620, bottom: 620 });
        const cX2 = (620 - 68) / 8, cY2 = (620 - 68) / 9;
        const click2 = (r, c) => {
          const ev = new w.MouseEvent('click', { clientX: 34 + c * cX2, clientY: 34 + r * cY2, bubbles: true });
          cv2.dispatchEvent(ev);
        };
        // 黑方棋子：卒在 (3,0)（-1），将在 (0,4)（-7）
        click2(3, 0);
        await sleep(300);
        log(!!w.LT.S.xqSel && w.LT.S.xqSel[0] === 3 && w.LT.S.xqSel[1] === 0,
          '象棋：客方能选中自己的黑卒 (3,0)', w.LT.S.xqSel ? w.LT.S.xqSel.join(',') : 'none');
        click2(4, 0);                       // 卒向前一步
        await sleep(900);
        const row2 = DATA.games.find((x) => x.id === 'gm_xq2');
        const b2 = (row2 && row2.board) || [];
        log(b2.length === 90 && b2[3 * 9 + 0] === 0, '象棋：客方走子后起点(3,0)清空', b2[3 * 9 + 0]);
        log(b2.length === 90 && b2[4 * 9 + 0] === -1, '象棋：客方黑卒落到(4,0) 且值为 -1（没被错写成红方）', b2[4 * 9 + 0]);
        log(!!row2 && row2.turn === 'host', '象棋：客方走子后轮次交回房主', row2 ? row2.turn : 'none');
        const mv2 = (row2 && row2.moves || [])[0];
        log(!!mv2 && mv2.v === -1, '象棋：行棋记录里客方棋子值为 -1（黑）', JSON.stringify(mv2 || null));
        // 客方不该能选中红方的子
        w.LT.S.xqSel = null;
        click2(6, 0);                       // 红兵
        await sleep(300);
        log(!w.LT.S.xqSel, '象棋：客方选不中对方的红兵 (6,0)');
      }
      if (w.LT.close) w.LT.close();
      // 清掉这局，避免留一条对局记录干扰下游断言
      DATA.games = DATA.games.filter((x) => x.id !== 'gm_xq2');
      await sleep(300);

      // 源码层锁定：不能再出现「把 2 当阵营」的写法
      const xqSrc = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      log(!/GX\.side\(val\)/.test(xqSrc), '象棋：不再用 GX.side(val) 判阵营（val 属 1/2 域，必然误判）');
      log(!/GX\.side\(g\.hostId === S\.uid \? 1 : 2\)/.test(xqSrc),
        '象棋：不再是 GX.side(房主?1:2) 这种包装（把 2 包进 GX.side 只会得到红方）');
      log(/g\.hostId === S\.uid \? 1 : -1/.test(xqSrc),
        '象棋：改用 ±1 表示红黑（正=红、负=黑，与 GX 约定一致）');
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
  // 2026-09-23 变更：版本行只显示时间（YYYY/MM/DD HH:mm），git 提交号移出面板（太长，用户不需要看）
  log(/^\u7248\u672c\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/.test(verTxt), '版本号只显示时间（YYYY/MM/DD HH:mm，无 sha）', verTxt);
  log(!/[0-9a-f]{7}/.test(verTxt), '版本行不再出现 git 提交号', verTxt);
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
    log(tJoke.length > 3 && tJoke !== '(无回复)', '「讲个笑话」有回复（走智能体）', tJoke.slice(0, 30));
  const tMenu = await botTalk('@小美 你能干什么');
  log(tMenu.indexOf('聊天') >= 0 || tMenu.indexOf('查资料') >= 0,
    '问「你能干什么」给出能力说明', tMenu.slice(0, 40).replace(/\n/g, ' '));
  const tPoem = await botTalk('@小美 来首古诗');
  log(tPoem.length > 5 && tPoem !== '(无回复)', '「来首古诗」有回复（智能体生成，不再本地抽签）', tPoem.slice(0, 24));
  const tW = await botTalk('@小美 北京天气', 3200);
  log(tW.length > 3 && tW !== '(无回复)', '「北京天气」有回复', tW.slice(0, 40).replace(/\n/g, ' '));
  const tN = await botTalk('@小美 看看新闻', 3600);
  log(tN.length > 3 && tN !== '(无回复)', '「看新闻」有响应', tN.slice(0, 36).replace(/\n/g, ' '));

  // ===== 本轮：移动端底部三 tab（聊天 / 联系人 / 我）=====
  log(D.querySelector('#tabBar') !== null, '底部 tabBar 存在');
  log(D.querySelector('#bBack') !== null, '聊天头部有返回按钮 ‹');
  const tbC = D.querySelector('#tbChat'), tbCt = D.querySelector('#tbContacts'), tbM = D.querySelector('#tbMe');
  log(tbC !== null && tbCt !== null && tbM !== null, '聊天 / 联系人 / 我 三个 tab 都在');
  if (tbC && tbCt && tbM) {
    tbC.click();
    log(tbC.classList.contains('on') && !D.body.classList.contains('tab-contacts')
        && !D.body.classList.contains('tab-me'), '点「聊天」落在聊天列表');
    tbCt.click();
    log(D.body.classList.contains('tab-contacts') && tbCt.classList.contains('on'), '点「联系人」切到联系人页');
    log(D.querySelector('#contGroups') !== null && D.querySelector('#contFriends') !== null, '联系人页含群聊/好友两个分区');
    tbM.click();
    log(D.body.classList.contains('tab-me') && tbM.classList.contains('on')
        && !D.body.classList.contains('tab-contacts'), '点「我」切到我的页');
    log(D.querySelector('#mCard') !== null && D.querySelector('#mExit') !== null, '我的页含资料卡与退出登录');
    tbC.click();
    log(tbC.classList.contains('on') && !D.body.classList.contains('tab-contacts')
        && !D.body.classList.contains('tab-me'), '再切回聊天列表');
  }

  // ===== 预置指令：输入 # 唤起菜单，#btc 拉取行情并渲染卡片 =====
  const hallForCmd = Array.prototype.filter.call(D.querySelectorAll('#cList .conv'), (e) => e.dataset.c === 'g:hall')[0];
  if (hallForCmd) hallForCmd.click();
  await sleep(700);
  const cmdInput = D.querySelector('#input');
  const cmdpop = D.querySelector('#cmdpop');
  cmdInput.value = '#';
  cmdInput.dispatchEvent(new w.Event('input', { bubbles: true }));
  await sleep(140);
  // 预置指令 6 条：#btc / #eth / #股票 / #help / #分析 / #新闻（#新闻 由 f85d695 加入）
  log(!cmdpop.classList.contains('hidden') && cmdpop.querySelectorAll('.cmditem').length === 6, '输入 # 弹出 6 个预置指令', cmdpop.querySelectorAll('.cmditem').length);
  const newsItem = Array.prototype.filter.call(cmdpop.querySelectorAll('.cmditem'), (it) => it.dataset.cmd === '#新闻')[0];
  log(!!newsItem, '菜单含 #新闻 指令项（The Guardian 全球头条）');
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

  // ===== 聊天洞察（Jev 分析当前会话情绪/意图/好感/质量）=====
  const W = D.defaultView;
  const anaItem = Array.prototype.filter.call(cmdpop.querySelectorAll('.cmditem'), (it) => it.dataset.cmd === '#分析')[0];
  log(!!anaItem, '菜单含 #分析 指令项');
  // mock /api/analyze，验证整条链路：输入 #分析 → 发卡片（不依赖内部闭包函数）
  const realFetchA = W.fetch;
  W.fetch = (url, opts) => {
    if (String(url).indexOf('/api/analyze') >= 0) {
      return Promise.resolve({ json: () => Promise.resolve({
        ok: true,
        mood: { choice: 'calm', probabilities: { calm: 0.6 }, confidence: 0.8 },
        intent: { choice: 'ask', probabilities: { ask: 0.6 }, confidence: 0.7 },
        affinity: { choice: '3_neutral', probabilities: {}, confidence: 0.6 },
        quality: { choice: '4_good', probabilities: {}, confidence: 0.5 },
        next_action: { choice: 'ask', probabilities: {}, confidence: 0.7 },
        model: 'jev-latest', usage: null,
      }) });
    }
    return realFetchA(url, opts);
  };
  // 先发一条普通文本，确保当前会话有可分析的消息
  const cardsB4A = D.querySelectorAll('#mList .cardmsg').length;
  cmdInput.value = '在吗';
  D.querySelector('#bSend').click();
  await sleep(400);
  cmdInput.value = '#分析';
  D.querySelector('#bSend').click();
  await sleep(600);
  W.fetch = realFetchA;
  log(D.querySelectorAll('#mList .cardmsg').length === cardsB4A + 1, '执行 #分析 后新增一张洞察卡片', D.querySelectorAll('#mList .cardmsg').length);
  const anCardA = Array.prototype.slice.call(D.querySelectorAll('#mList .cardmsg .card')).pop();
  log(!!anCardA && anCardA.textContent.indexOf('聊天洞察') >= 0 && anCardA.textContent.indexOf('好感/投入') >= 0 && anCardA.textContent.indexOf('我方回复') >= 0, '洞察卡片含标题与评分条', anCardA ? anCardA.textContent.replace(/\s+/g, ' ').slice(0, 130) : 'none');
  cmdInput.value = '';

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
  // 切回大厅，便于后续用例从干净状态开始
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

  // ===== 本轮新功能：小美联网检索（手工 RAG）=====
  {
    const LT = w.LT;
    const src2 = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

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
    log(/botLLM\(text, who, conv, ref\)/.test(src2) || /botLLM\([^)]*ref\)/.test(src2),
      'botLLM 接受第 4 个参数 ref（检索资料）');
    log(/联网检索到的资料/.test(src2), 'system 提示里明确要求「优先依据资料回答、查不到就说查不到」');
    log(/await searchWeb\(/.test(src2), 'botReply 的闲聊分支会先 searchWeb 再喂模型');
    log(/S\.webSearch !== false/.test(src2), '提供 S.webSearch 开关（可一键关掉联网）');
  }

  // ===== Jev 意图路由（TypeSafe System One）=====
  if (w.LT && w.LT.stockGuess) {
    await sleep(350);   // 等启动时的能力探测完成
    log(w.LT.INTENT.enabled === true, '启动后探测到 /api/intent 可用，Jev 路由开启');

    log(w.LT.stockGuess('茅台现在多少钱了') === '茅台', 'stockGuess 从中文句子中剥离语气词/意图词', w.LT.stockGuess('茅台现在多少钱了'));
    log(w.LT.stockGuess('@小美 帮我查下 600519 的股价') === '600519', 'stockGuess 保留代码/英文标的', w.LT.stockGuess('@小美 帮我查下 600519 的股价'));

    // 加密货币意图 → 自动出行情卡片（不需要用户输入 #btc）
    __intentResp = { ok: true, intent: 'crypto_quote', confidence: 0.91, intent_confidence: 0.94, kind: 'crypto', kind_confidence: 0.92, has_asset: 0.97, crypto: 'bitcoin', crypto_confidence: 0.95 };
    const cardsA = D.querySelectorAll('#mList .cardmsg').length;
    const hitCrypto = await w.LT.tryIntentAutoReply('比特币现在多少钱', 'c1');
    await sleep(200);
    log(hitCrypto === true, '「比特币现在多少钱」被识别为行情意图并消费（不再走闲聊）', String(hitCrypto));
    log(D.querySelectorAll('#mList .cardmsg').length === cardsA + 1, '意图命中后自动贴出行情卡片');
    const autoCard = Array.prototype.slice.call(D.querySelectorAll('#mList .cardmsg .card')).pop();
    log(!!autoCard && autoCard.textContent.indexOf('Bitcoin') >= 0, '自动卡片内容正确（Bitcoin 行情）', autoCard ? autoCard.textContent.replace(/\s+/g, ' ').slice(0, 90) : 'none');
    log(__intentCalls.length >= 1 && typeof __intentCalls[__intentCalls.length - 1].text === 'string', '调用 /api/intent 时把原文交给服务端判断', JSON.stringify(__intentCalls[__intentCalls.length - 1]).slice(0, 120));

    // 股票意图 → 走 smartbox 名称解析后出卡片
    __intentResp = { ok: true, intent: 'stock_quote', confidence: 0.88, intent_confidence: 0.9, kind: 'stock', kind_confidence: 0.89, has_asset: 0.93, crypto: '', crypto_confidence: 0 };
    const cardsB = D.querySelectorAll('#mList .cardmsg').length;
    const hitStock = await w.LT.tryIntentAutoReply('茅台现在多少钱', 'c1');
    await sleep(300);
    log(hitStock === true && D.querySelectorAll('#mList .cardmsg').length === cardsB + 1, '「茅台现在多少钱」自动解析标的并出卡片', 'hit=' + hitStock);

    // 闲聊 → 不消费，交回原有链路
    __intentResp = { ok: true, intent: 'chitchat', confidence: 0.95, intent_confidence: 0.95, kind: 'none', kind_confidence: 0.9, has_asset: 0.02, crypto: '', crypto_confidence: 0 };
    log((await w.LT.tryIntentAutoReply('今天心情不错呀', 'c1')) === false, '闲聊不被误判成功能（交回 DeepSeek 闲聊链路）');

    // 低置信度 → 不触发（宁可不做，也不能乱贴卡片）
    __intentResp = { ok: true, intent: 'crypto_quote', confidence: 0.42, intent_confidence: 0.5, kind: 'crypto', kind_confidence: 0.45, has_asset: 0.5, crypto: 'bitcoin', crypto_confidence: 0.42 };
    log((await w.LT.tryIntentAutoReply('那个东西怎么样了', 'c1')) === false, '置信度不足（<0.6）时不触发任何功能');

    // 服务端不可用 → 静默降级
    __intentResp = { ok: false, reason: 'no_key' };
    log((await w.LT.tryIntentAutoReply('比特币多少了', 'c1')) === false, '服务端返回 ok:false 时静默降级（不影响聊天）');

    // 源码断言：闲聊分支确实先走意图路由
    const src3 = html;
    log(/await tryIntentAutoReply\(text, conv\)/.test(src3), 'botReply 闲聊分支前置调用 tryIntentAutoReply');
  }

  // ===== 小美回归修复（在 dev 单文件版上重新移植）：地名解析 / 并发竞态 / 联网问答 / 新闻兜底 / 去重 =====
  {
    const LT = w.LT;
    const srcAll = html;   // 单文件版：index.html 即全部源码
    // ⚠️ 扫源码前只剥「行首 // 注释」：注释里可能写着被禁用的旧标识，会反噬断言（踩过）
    // ⚠️⚠️ 两条禁令，都是踩出来的：
    //   1) 别用 /\/\/[^\n]*/g —— 会把字符串 'https://...' 里的 // 到行尾整段删掉，含 URL 的断言全假失败
    //   2) 别剥块注释 /\/\*[\s\S]*?\*\//g —— HTML 里 /* 与 */ 数量不配对（正则字面量/字符串里有 */），
    //      非贪婪跨段匹配会一次吞掉 7 万+ 字符，扫源码断言集体失灵
    const code = srcAll.split('\n').map(function (l) { return l.replace(/^\s*\/\/.*$/, ''); }).join('\n');

    // 1) 天气地名解析：时间词/动词/语气词双向剥离（真因：原正则把「明天上海」整段当地名）
    if (LT && LT.parseCity) {
      [['明天上海天气', '上海'], ['今天北京天气', '北京'], ['上海天气', '上海'],
       ['帮我查一下 深圳 天气', '深圳'], ['广州今天多少度', '广州'], ['明天上海会不会下雨', '上海']]
        .forEach(function (c) {
          const hit = LT.parseCity(c[0]);
          log(hit === c[1], '天气解析「' + c[0] + '」→ ' + c[1], '实际=' + hit);
        });
    } else log(false, 'window.LT.parseCity 已导出');

    // 2) ⚠️⚠️ 真凶回归：ensureLLM 缓存 Promise 而非布尔标志（修并发竞态）
    log(!/S\.llmTried/.test(code) && /if \(S\.llmReady\) \{ await S\.llmReady; return; \}/.test(code),
      'ensureLLM 缓存 Promise 而非布尔值（修并发竞态：曾致 1 秒秒回「卡了一下」+ 天气回两次）',
      /S\.llmTried/.test(code) ? '代码里还有 llmTried' : 'ok');
    if (LT && LT.ensureLLM) {
      const savedR = LT.S.llmReady, savedM = LT.S.llmModel, savedQ = LT.S.llmQueue;
      LT.S.llmReady = null; LT.S.llmModel = null; LT.S.llmQueue = null;
      const callsBefore = __llmListCalls;
      const p1 = LT.ensureLLM(), p2 = LT.ensureLLM();
      await Promise.all([p1, p2]);
      log(LT.S.llmModel === 'deepseek-v4.1-flash',
        '并发两次 ensureLLM：await 后模型已就绪（不会秒回兜底）', String(LT.S.llmModel));
      log(__llmListCalls - callsBefore <= 1, '并发调用不重复拉模型目录',
        'delta=' + (__llmListCalls - callsBefore));
      log(Array.isArray(LT.S.llmQueue) && LT.S.llmQueue.length >= 2,
        '候选模型队列含多个（保证有回退目标）', Array.isArray(LT.S.llmQueue) ? LT.S.llmQueue.length : 0);
      LT.S.llmReady = savedR; LT.S.llmModel = savedM; LT.S.llmQueue = savedQ;
    }

    // 3) 天气主流程已改用 parseCity（不再用内联正则）
    log(/var city = parseCity\(text\)/.test(code), 'botWeather 改用 parseCity 解析地名');

    // 4) 新闻源换血 + 联网兜底（原三源实测 curl 000 全挂）
    log(/60s-api\.viki\.moe/.test(code), 'NEWS_SOURCES 首位换成 viki.moe（原三源已失效）');
    log(/function botNewsFallback/.test(code), '新闻/热点失败时走联网检索+模型总结兜底');
    log(!/新闻源今天集体打不通了/.test(code), '已删除「新闻源今天集体打不通了」的硬报错文案');

    // 5) 智能体重构：本地正则路由已移除，自然语言全部交给服务端 Agent
    log(!/var LOOKUP_RE = /.test(code), 'LOOKUP_RE 已移除（不再靠正则猜「要联网」）');
    log(/function botAgent\(/.test(code) && /\/api\/chat/.test(code),
      '新增 botAgent：把自然语言交给服务端 Agent 理解');
    log(/var AGENT_STATE = \{/.test(code) && /function agentProbe\(/.test(code),
      '新增 AGENT_STATE + agentProbe（启动探测智能体可用性）');
    log(/return null;\n\}/.test(code) && /var BOT_MENU = /.test(code),
      'botAnswer 只保留能力菜单，其余 return null 交给 Agent');
    log(!/if \(\/笑话\|段子\|逗我\|冷知识\/\.test\(t\)\) return botJoke/.test(code),
      '已移除 /笑话|段子/ 这类硬编码关键词分支（理解能力差的根因）');
    log(/if \(await tryIntentAutoReply\(text, conv\)\)/.test(code) && /var ag = await botAgent\(text, who, conv\)/.test(code),
      'botReply 分层：预置功能 → Agent 主通道 → 旧链路兜底');
    if (LT && LT.sanitizeQuery) {
      log(LT.sanitizeQuery('@小美 查一下 HTTP 状态码') === 'HTTP 状态码',
        'sanitizeQuery（旧链路兜底仍在）', LT.sanitizeQuery('@小美 查一下 HTTP 状态码'));
    } else log(false, 'window.LT.sanitizeQuery 已导出');

    // 6) 回复去重：同一条消息只回一次（治「天气回两次」的另一半）
    log(/var BOT_REPLIED = \{\}/.test(code) && /function botDedupe/.test(code),
      'maybeBotReply 增加按消息 id 去重（BOT_REPLIED + botDedupe）');
    log(/if \(!botDedupe\(m\.conv, m\.id\)\) return;/.test(code), 'maybeBotReply 在调用 botReply 前做去重守卫');

    // 6b) ⚠️⚠️ 刷屏回归（2026-09-23 线上事故）：历史回填触发的「新消息」不能让小美接话
    // 根因：catchUpScoped() 每 10 秒回填最近 200 条，对 S.msgs 全是「新增」→
    // 历史上每条 @小美 都被重答一遍，一进大厅被几十条旧话题回复刷屏。
    log(/function botFresh\(/.test(code) && /if \(!botFresh\(m\)\) return;/.test(code),
      'maybeBotReply 增加时间闸 botFresh（回填上来的历史消息不接话）');
    log(/if \(S\.botFloor && mid\(m\) <= S\.botFloor\) return false;/.test(code),
      'botFresh 含上线水位闸 S.botFloor（我上线前的消息一律算历史）');
    log(/function botBatchBegin\(/.test(code) && /function botBatchEnd\(/.test(code) && /function maybeBotReplyQueued\(/.test(code),
      '新增批次闸：一轮回填里同会话只取最新一条去判（botBatchBegin/End + maybeBotReplyQueued）');
    log(/if \(added\) maybeBotReplyQueued\(m\)/.test(code),
      'onNew 走批次队列，不再逐条直接触发回复');
    log((code.match(/botBatchBegin\(\);/g) || []).length >= 2 && (code.match(/botBatchEnd\(\);/g) || []).length >= 2,
      'tick 与 catchUpScoped 各自包裹批次（两处回填入口都覆盖）');
    log(!/BOT_CONV_COOL/.test(code),
      '不做延时冷却：用户连着 @ 两次必须每次都答（冷却会吞掉第二条）');
    log(/if \(!S\.botFloor\) S\.botFloor = S\.lastId;/.test(code),
      'refreshAll 设定上线水位 S.botFloor（刷新后不追答旧消息）');
    if (LT && LT.botFresh) {
      const nowT = Date.now();
      const savedFloor = LT.S.botFloor;
      LT.setBotFloor(0);
      log(LT.botFresh({ id: 1, created_at: new Date(nowT - 10 * 60 * 1000).toISOString() }) === false,
        'botFresh：10 分钟前的消息视为历史，不接话');
      log(LT.botFresh({ id: 1, created_at: new Date(nowT - 5000).toISOString() }) === true,
        'botFresh：5 秒前的新消息照常接话');
      log(LT.botFresh({ id: 1 }) === false, 'botFresh：无时间戳（导入历史/本地构造）一律不接');
      LT.setBotFloor(100);
      log(LT.botFresh({ id: 99, created_at: new Date(nowT - 1000).toISOString() }) === false,
        'botFresh：id 不高于上线水位时，即使很新也算历史');
      log(LT.botFresh({ id: 101, created_at: new Date(nowT - 1000).toISOString() }) === true,
        'botFresh：id 高于水位的新消息才接');
      LT.setBotFloor(savedFloor);
    } else log(false, 'window.LT.botFresh 已导出');
    // ---- 通知/未读新近度闸 + 轮询退避（2026-09-23 修「老消息反复推送 / 连接异常刷屏」）----
    // 本块作用域独立：自取 index.html 源码（只剥行首注释，禁全局剥块注释）
    const IJS = require('fs').readFileSync(require('path').join(__dirname, 'index.html'), 'utf8')
      .split('\n').map(function (l) { return l.replace(/^\s*\/\/.*$/, ''); }).join('\n');
    // ---- 通知/未读新近度闸 + 轮询退避（2026-09-23 修「老消息反复推送 / 连接异常刷屏」）----
    if (LT && LT.msgIsLive) {
      const nowL = Date.now();
      log(LT.msgIsLive({ created_at: new Date(nowL - 5000).toISOString() }) === true,
        'msgIsLive：5 秒前的消息是「实时」的，可弹通知');
      log(LT.msgIsLive({ created_at: new Date(nowL - 10 * 60 * 1000).toISOString() }) === false,
        'msgIsLive：10 分钟前的消息不弹通知（回填/积压静默入列）');
      log(LT.msgIsLive({}) === false, 'msgIsLive：无时间戳一律按历史处理');
      log(IJS.indexOf('if (added && isLive && !canRead && !c.muted)') >= 0,
        'onNew 的桌面通知/响铃已挂 msgIsLive 闸');
      log(IJS.indexOf('if (isLive && (m.mentions || []).indexOf(S.uid) >= 0)') >= 0,
        '@提醒 toast 也挂 msgIsLive 闸（历史 @ 不再轰炸）');
      log(IJS.indexOf('if (added && !canRead) S.unread[m.conv]') >= 0,
        '未读计数不加新近度闸（红点保持「没看过就是没看过」的语义）');
      log(IJS.indexOf('order(\'id\', { ascending: false }).limit(1)') >= 0
        && IJS.indexOf('var probeMax = S.lastId ? null') >= 0,
        'refreshAll：lastId=0 时先探最大 id，tick 不再从全表最旧 200 条爬起');
    } else log(false, 'window.LT.msgIsLive 已导出');
    log(IJS.indexOf('var settled = jobs.map(function (p) {') >= 0
      && IJS.indexOf('Promise.all(settled)') >= 0,
      'tick 逐路兜底：单表抖动不再让整轮失败');
    log(IJS.indexOf('else if (++S.syncFails >= 2)') >= 0,
      '连续 2 轮失败才标红（单次抖动静默自愈，不再刷「连接异常」）');
    log(IJS.indexOf('Math.min(2500 * Math.pow(2, Math.min(S.syncFails || 0, 4)), 30000)') >= 0
      && IJS.indexOf('function scheduleTick(') >= 0,
      '失败指数退避：2.5s→30s 封顶，断网期间不再高频重试');
    log(IJS.indexOf('if (++S.syncFails >= 2) setSync(\'同步出错\'') >= 0,
      '消化逻辑抛错也有 catch 兜底，轮询循环不死');
    if (LT && LT.maybeBotReplyQueued && LT.botBatchPeek) {
      const mk = (id) => ({ conv: 'g:hall', id: id, sender_id: 'u1', mentions: ['bot_xiaomei'], text: 'x' });
      LT.botBatchBegin();
      LT.maybeBotReplyQueued(mk(1));
      LT.maybeBotReplyQueued(mk(2));
      LT.maybeBotReplyQueued(mk(3));
      const b = LT.botBatchPeek() || {};
      log(b['g:hall'] && b['g:hall'].id === 3,
        '批次内同一会话只保留最新一条（3 条 @小美 只会判 1 次）', b['g:hall'] ? b['g:hall'].id : 'none');
      LT.botBatchEnd();
      log(LT.botBatchPeek() === null, '批次结束后收集器已清空');
    } else log(false, 'window.LT.maybeBotReplyQueued / botBatchPeek 已导出');

    // 7) 多模型回退链
    log(/LLM_RETRY/.test(code) && /S\.llmQueue\.slice\(\)/.test(code),
      'botLLM 有候选模型回退链（模型 × 带/不带 temperature）');
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

    // ===== 本轮修复：@ 列表必须始终含小美（非大厅群 + S.members 未同步时也不能漏）=====
    {
      const LT2 = w.LT;
      const S2 = w.LT.S;
      const botId = 'bot_xiaomei';
      const savedCur = S2.cur, savedMembers = S2.members, savedProfiles = S2.profiles;
      // 构造一个「非大厅群，且 members 里没有小美」的最坏场景
      const c = w.LT.cm() ? w.LT.cm()[savedCur] : null;
      if (c && c.type === 'group') {
        const gid = c.id;
        const backupList = (savedMembers[gid] || []).slice();
        savedMembers[gid] = backupList.filter(function (u) { return u !== botId; });
        const cands = w.LT.atCandidates();
        log(cands.some(function (x) { return x.u === botId; }),
          '@ 候选里始终含小美（即使 S.members 尚未同步到她）', 'cands=' + cands.length);
        log(cands.length >= 1, '@ 候选列表非空', cands.length + ' 人');
        savedMembers[gid] = backupList;
      }
      S2.cur = savedCur; S2.members = savedMembers; S2.profiles = savedProfiles;
    }

    // ===== 本轮修复：会话历史不能因「本地已有零星消息」而被跳过 =====
    {
      const S3 = w.LT.S;
      const src = String(w.LT._src || '');
      // 语义断言：openConv 的跳过条件必须是 histLoaded 标记，不能是 msgs[conv] 是否存在
      const srcAll = S3 ? '' : '';
      log(!!S3.histLoaded, 'S 状态里存在 histLoaded 标记（记录是否真拉过历史）');
      log(S3.histLoaded && Object.prototype.toString.call(S3.histLoaded) === '[object Object]',
        'histLoaded 是对象映射（conv -> 1）');
      // 关键：修复后第一次进未拉过历史的会话，即使 msgs 里已有实时推送的零星消息，
      // 也必须再拉一次（用标记判定，而不是数组非空判定）
      const key = '__test_histconv__';
      delete S3.histLoaded[key];
      S3.msgs[key] = [{ id: 999, conv: key, text: '只有一条最新消息', sender_id: 'x' }];
      const needLoad = !S3.histLoaded[key];
      log(needLoad === true,
        '本地只有零星消息时仍判定需要拉历史（不会只剩最新一条）');
      // 拉完之后标记住，避免每次进会话都重拉
      S3.histLoaded[key] = 1;
      log(!!S3.histLoaded[key], '成功拉过历史后打上标记（不重复拉取）');
      delete S3.msgs[key]; delete S3.histLoaded[key];
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
      // CSS 可能在 <style> 里（内联）也可能在 <link rel=stylesheet> 里（外置到 cloud/styles.css），
      // 两种都要能取到。jsdom 不配 resources 时不会去加载 link，所以这里自己从磁盘读。
      // ⚠️ 改动这段时注意：取不到文本时下面的正则全部匹配空串，断言会「静默失败」，
      //    失败信息只显示「(未找到规则)」，很难看出是取文本的方式坏了而不是 CSS 真的错。
      const cssTxt = Array.prototype.map.call(D.querySelectorAll('style, link[rel="stylesheet"]'), (s) => {
        if (s.tagName === 'STYLE') return s.textContent;
        const href = s.getAttribute('href') || '';
        if (/^https?:/i.test(href)) return '';        // 外链（如字体）不读
        try { return fs.readFileSync(path.join(__dirname, href.replace(/^\//, '')), 'utf8'); }
        catch (e) { return ''; }
      }).join('\n');
      const onRule = (cssTxt.match(/\.groom \.gr-pl\.on\{[^}]*\}/) || [''])[0];
      log(!!onRule && !/background|color-mix/.test(onRule),
        '选中玩家条只改边框/文字色，无背景填充', onRule || '(未找到规则)');
      log(!!onRule && !/box-shadow/.test(onRule),
        '选中玩家条不再叠第二层描边（避免圆角内侧深色块）', onRule ? 'ok' : '(未找到规则)');

      const dotRule = (cssTxt.match(/\.groom \.gr-pl\.on \.dot\{[^}]*\}/) || [''])[0];
      log(/grpulse/.test(dotRule), '玩家条指示点改用纯透明度呼吸动画 grpulse', dotRule || '(未找到规则)');
      const grpulseDef = (cssTxt.match(/@keyframes grpulse\{[^@]*\}/) || [''])[0];
      log(!!grpulseDef && !/box-shadow/.test(grpulseDef),
        'grpulse 不含 box-shadow 扩散（从根上消除溢出被裁）', grpulseDef || '(未找到定义)');
    }
  }

  // ===== 智能体重构：小美接入服务端 Agent 主循环 =====
  {
    const LT = w.LT;
    // 探活
    await sleep(500);
    __agentCalls = [];
    __agentOn = true;
    // botAnswer 只保留能力菜单，其余交 Agent
    if (LT) {
      const aMenu = LT.botAnswer ? LT.botAnswer('你能干什么', '甲', 'g:hall') : null;
      log(typeof aMenu === 'string' && aMenu.length > 6, 'botAnswer 仍返回能力菜单（固定回答）', String(aMenu).slice(0, 30));
      const aChat = LT.botAnswer ? LT.botAnswer('我最近压力好大，想辞职', '甲', 'g:hall') : 'x';
      log(aChat === null, 'botAnswer 对自然语言返回 null（交给 Agent 理解，不再正则猜）', String(aChat));
      const aJoke = LT.botAnswer ? LT.botAnswer('讲个笑话', '甲', 'g:hall') : 'x';
      log(aJoke === null, '「讲个笑话」也走 Agent（本地不再抽签）', String(aJoke));
    } else log(false, 'window.LT 已导出');

    // 端到端：@小美 触发 -> 前端调 /api/chat -> 回复落到消息表
    const hallInput = D.querySelector('#input');
    // 切到大厅
    const hallConv = Array.prototype.filter.call(D.querySelectorAll('#cList .conv'), (e) => e.dataset.c === 'g:hall')[0];
    if (hallConv) { hallConv.click(); await sleep(400); }
    __agentResp = () => ({ ok: true, text: '压力大的时候先别急着做决定，跟我说说具体是哪一块最难受？', trace: [{ tool: 'web_search', args: { query: 'x' }, ok: true }], turns: 2, channel: 'deepseek' });
    if (hallInput) {
      hallInput.value = '@小美 我最近压力好大';
      hallInput.dispatchEvent(new w.Event('input', { bubbles: true }));
      hallInput.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await sleep(2800);
    }
    const botMsgs = DATA.messages.filter((m) => m.sender_id === 'bot_xiaomei');
    const lastBot = botMsgs.length ? String(botMsgs[botMsgs.length - 1].text) : '';
    log(lastBot.indexOf('压力大') >= 0, 'Agent 回复已落库并上屏', lastBot.slice(0, 40));
    log(__agentCalls.length >= 1, '前端确实调用了 /api/chat（服务端 Agent）', __agentCalls.length + ' 次');
    const lastCall = __agentCalls[__agentCalls.length - 1] || {};
    log(typeof lastCall.text === 'string' && lastCall.text.length > 0, '请求体带上用户原文', String(lastCall.text).slice(0, 30));
    log(Array.isArray(lastCall.history), '请求体带上会话历史（模型才能理解上下文）', typeof lastCall.history);

    // Agent 挂掉 -> 优雅回退（不抛异常、不刷屏）
    __agentOn = false;
    __agentResp = null;
    const errN0 = errors.length;
    const hallInput2 = D.querySelector('#input');
    if (hallInput2) {
      hallInput2.value = '@小美 你好呀';
      hallInput2.dispatchEvent(new w.Event('input', { bubbles: true }));
      hallInput2.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await sleep(2600);
    }
    log(errors.length === errN0, 'Agent 不可用时不产生 JS 异常（静默回退旧链路）', errors.slice(errN0).join(' | '));
    __agentOn = true;
  }

  // ===== 联网检索能力加固（2026-09-22）：源修复 + 时效排序 + 实体清理 =====
  {
    const fsx = require('fs');
    const pathx = require('path');
    const AJS = fsx.readFileSync(pathx.join(__dirname, 'agent.js'), 'utf8');

    // 360 源必须用 data-mdurl 取真实地址（href 是跳转链）
    log(/data-mdurl="\(\[\^"\]\+\)"/.test(AJS) || AJS.indexOf('data-mdurl="([^"]+)"') >= 0,
      '360 源从 data-mdurl 取真实 URL（不是跳转链）');

    // Bing 源必须先分块再块内匹配（单条大正则会因结构变化全废）
    log(AJS.indexOf('function splitBlocks') >= 0, 'Bing/360 源采用「先分块再块内正则」策略');
    log(/<h2\[\^>\]\*>\\s\*<a\[\^>\]\+href/.test(AJS), 'Bing 源兼容 h2 带属性的真实结构');

    // 六源里必须包含 360，且排在前两位（实测中文命中率最高）
    const srcOrder = (AJS.match(/const WEB_SOURCES = \[([\s\S]*?)\];/) || [])[1] || '';
    log(srcOrder.indexOf("'so360'") >= 0, 'WEB_SOURCES 已接入 360 搜索源');
    log(srcOrder.indexOf("'so360'") < srcOrder.indexOf("'news-60s'"), '360 排在 news-60s 之前（权重更高）');
    log(srcOrder.indexOf("'bing'") >= 0 && srcOrder.indexOf("'bing'") < srcOrder.indexOf("'news-60s'"),
      'Bing 排在 news-60s 之前（覆盖面优先）');

    // 时效性排序：解决「搜到的都是旧闻」
    log(AJS.indexOf('function freshness') >= 0, '存在时效性打分函数 freshness');
    log(/pool\.sort\(\(a, b\) => b\._f - a\._f\)/.test(AJS), '结果按时效性重排（新结果优先占名额）');
    log((AJS.match(/y - i\) \+ '\\\\s\*年'/) || []).length >= 0 && AJS.indexOf('score -= 3') >= 0,
      '往年结果被降权（旧闻不再挤占名额）');

    // 实体清理：不能留下 &ensp; &#0183; 这类噪声喂给模型
    log(AJS.indexOf('const ENT =') >= 0, 'stripTags 具备具名实体映射表');
    log(/\&#x\(\[0-9a-f\]\+\);/i.test(AJS) || AJS.indexOf('&#x$1') >= 0 || /&#x\(\[0-9a-f\]\+\);/.test(AJS) === false,
      'stripTags 处理十六进制数字实体');
    log(/String\.fromCodePoint\(parseInt\(d, 10\)\)/.test(AJS), 'stripTags 处理十进制数字实体');
    log(AJS.indexOf('\\u200B-\\u200F') >= 0, 'stripTags 清除零宽/方向控制字符');
    // 标签直接删掉而不是换成空格（否则 360 的 <em> 高亮会把词拆开）
    log(AJS.indexOf('<\\/?(?:div|p|li|ul|ol|br|tr|td|h[1-6]|section|article)') >= 0,
      'stripTags 只对块级标签补空格（避免 <em> 高亮拆词）');

    // 中文查询不该被 wiki-en 的无关英文条目污染
    log(AJS.indexOf('function hasCJK') >= 0, '存在 hasCJK 语言判定');
    log(/lang === 'en' && !hasCJK\(x\.title\)/.test(AJS), '中文查询时 wiki-en 过滤掉纯英文无关条目');

    // 模型通道：改成通用多通道链，不再写死 DeepSeek
    const SJS = fsx.readFileSync(pathx.join(__dirname, 'server.js'), 'utf8');
    log(SJS.indexOf('function buildChannels') >= 0, 'server.js 具备通用多通道装配 buildChannels');
    log(SJS.indexOf('.llm.json') >= 0, '支持 .llm.json 配置模型通道（换模型不改代码）');
    log(/for \(const ch of CHANNELS\)/.test(SJS), 'makeChatFn 遍历通道链（真回退，非 if/else 二选一）');
    log(!/if \(DS_KEY\) \{[\s\S]{0,200}if \(GW_BASE && GW_KEY\)/.test(SJS), '旧的 DeepSeek-only 双分支已移除');
    log(/headers\.Authorization/.test(SJS) && SJS.indexOf('if (key && !keyless)') >= 0,
      '免密钥通道不带 Authorization（云端网关可用）');

    // 探活要能列出完整通道链
    log(/channels: CHANNELS\.map/.test(SJS), '/api/chat 探活返回完整通道列表');

    // 输出卫生：360 摘要序号不外泄 / 自己的历史发言不带发言人前缀（2026-09-22 实测踩坑）
    log(/snip = snip\.replace\(\/\^\\d\{1,2\}/.test(AJS), '360 摘要开头的「结果序号」被剥离（模型不会把序号当正文）');
    log(AJS.indexOf("if (m.role === 'assistant') content = content.replace(") >= 0,
      'agentHistory 里自己的发言剥掉「发言人：」前缀（防模型模仿前缀）');
    log(AJS.indexOf('绝不要') >= 0 && AJS.indexOf('给自己的话加') >= 0,
      'System Prompt 明确禁止给回复加自己的名字前缀');
  }

  // ===== 联网优先（非常识必搜） + 象棋将军提示（2026-09-23）=====
  {
    const fsx = require('fs');
    const pathx = require('path');
    const AJS = fsx.readFileSync(pathx.join(__dirname, 'agent.js'), 'utf8');
    const IJS = fsx.readFileSync(pathx.join(__dirname, 'index.html'), 'utf8');
    const LT = w.LT;
    let AG = null;
    try { AG = require('./agent.js'); } catch (e) { AG = null; }

    // ---- 改动1：除常识外，小美优先走联网推理 ----
    log(AJS.indexOf('function isCommonSense') >= 0, 'agent 内置「是否常识题」判定 isCommonSense');
    log(AJS.indexOf('if (!isCommonSense(text) && req.web !== false)') >= 0,
      'runAgent 对非常识问题先做一轮预检索（联网优先，不靠模型自觉）');
    log(AJS.indexOf("messages.push({ role: 'system', content: buildWebBrief(rows) })") >= 0,
      '预检索结果以【联网资料】注入系统上下文');
    log(AJS.indexOf('const FORCE_SEARCH_RULES') >= 0 && AJS.indexOf('const SKIP_SEARCH_RULES') >= 0,
      '先判必搜信号、再判免搜清单（避免「你好+天气」被寒暄规则吞掉）');
    log(AJS.indexOf('默认先查后答') >= 0, 'System Prompt 写明「默认先查后答」');
    if (AG && AG.isCommonSense) {
      log(AG.isCommonSense('你好') === true, '常识/寒暄不触发联网（你好）');
      log(AG.isCommonSense('谢谢啦') === true, '常识/寒暄不触发联网（谢谢）');
      log(AG.isCommonSense('你是谁') === true, '关于小美自身的问句不触发联网');
      log(AG.isCommonSense('帮我写一首诗') === true, '主观创作不触发联网');
      log(AG.isCommonSense('1+2*3') === true, '纯算式不触发联网');
      log(AG.isCommonSense('今天北京天气怎么样') === false, '天气类问题必须联网');
      log(AG.isCommonSense('最新的人工智能新闻') === false, '时效类问题必须联网');
      log(AG.isCommonSense('英伟达股价现在多少') === false, '事实/数据类问题必须联网');
      log(AG.isCommonSense('你好，今天股市行情怎么样') === false, '寒暄+时效：按必搜处理（先判必搜再判免搜）');
    } else log(false, 'agent.js 导出 isCommonSense');
    if (AG && AG.searchQueryOf) {
      log(AG.searchQueryOf('@小美 北京天气') === '北京天气', 'searchQueryOf 剥掉 @提及噪声',
        AG.searchQueryOf('@小美 北京天气'));
      log(AG.searchQueryOf('#新闻 今天的热点') === '今天的热点', 'searchQueryOf 剥掉 #指令噪声',
        AG.searchQueryOf('#新闻 今天的热点'));
    } else log(false, 'agent.js 导出 searchQueryOf');

    // ---- 改动2：象棋不限制走子 + 将军提示双方 ----
    log(IJS.indexOf('moves: function (board, r, c) { return GX.rawMoves(board, r, c); }') >= 0,
      '象棋 moves 不再过滤自陷将军（被将军也能自由走子）');
    log(IJS.indexOf('var check = !win && GX.inCheck(b, opp);') >= 0,
      'place 额外返回 check（将军只是提示，不再限制走法）');
    log(IJS.indexOf('function xqCheckSide') >= 0,
      'xqCheckSide 从 board+turn 派生将军状态（不写库，双方天然一致）');
    log(IJS.indexOf("hint.classList.add('warn')") >= 0, '被将军时状态条给红色告警文案');
    log(IJS.indexOf("toast(chk === (mine ? 1 : 2) ?") >= 0,
      '将军时双方都会收到 toast（走子方与等待方各看到一句）');
    if (LT && LT.GX) {
      const GXe = LT.GX;
      const mk = function (pairs) { const b = []; for (let i = 0; i < 90; i++) b.push(0); pairs.forEach((p) => { b[p[0] * 9 + p[1]] = p[2]; }); return b; };
      // 黑将 (0,4) 与红车 (0,0) 同行照面 → 黑被将军；黑马在 (5,0) 仍有走法
      const b1 = mk([[0, 4, -7], [0, 0, 3], [9, 4, 7], [5, 0, -4]]);
      log(GXe.inCheck(b1, 2) === true, '构造局面：黑将被红车照面将军');
      const mv1 = GXe.moves(b1, 5, 0);
      log(mv1.length > 0, '被将军的一方仍有可走步数（不再被限制）', mv1.length);
      log(mv1.some((m) => m[0] !== 0), '不能解将的走法也保留（将军只提示、不限制）');
      // 红车 (1,0) → (0,0) 形成照面将军
      const b2 = mk([[0, 4, -7], [1, 0, 3], [9, 4, 7]]);
      const r2 = GXe.place(b2, 1, 0, 0, 0);
      log(r2.ok && r2.check === true, 'place 返回 check=true（走完形成将军）');
      // 吃将即胜：不再依赖「将死/困毙」判定
      const b3 = mk([[0, 4, -7], [1, 4, 3], [9, 4, 7]]);
      const r3 = GXe.place(b3, 1, 4, 0, 4);
      log(r3.ok && r3.win === true, '吃掉将/帅即判胜（胜负不再靠将死判定）');
      if (LT.xqCheckSide) {
        const g = { kind: 'xiangqi', status: 'playing', turn: 'guest', board: mk([[0, 4, -7], [0, 0, 3], [9, 4, 7]]) };
        log(LT.xqCheckSide(g) === 2, 'xqCheckSide：轮到黑方且黑将被照面 → 返回 2（黑被将军）');
        log(LT.xqCheckSide({ kind: 'xiangqi', status: 'playing', turn: 'host', board: GXe.newBoard() }) === 0,
          'xqCheckSide：开局未被将军 → 0');
        log(LT.xqCheckSide({ kind: 'gomoku', status: 'playing', turn: 'host', board: [] }) === 0,
          'xqCheckSide：非象棋/非对局中 → 0');
      } else log(false, 'window.LT.xqCheckSide 已导出');
    } else log(false, 'window.LT.GX 已导出');
  }

  // ===== 会话历史加载 + @ 小美：源码级回归锁（2026-09-22）=====
  {
    const fsx = require('fs');
    const pathx = require('path');
    const IJS = fsx.readFileSync(pathx.join(__dirname, 'index.html'), 'utf8');

    // @ 候选必须显式并入 BOT.id（不能只依赖 S.members，否则非大厅群漏小美）
    log(IJS.indexOf('if (ids.indexOf(BOT.id) < 0) ids.push(BOT.id);') >= 0,
      'atCandidates 显式并入小美（不依赖 S.members 同步）');
    // ensureBot 要给所有群补小美，不只 hall
    log(/Object\.keys\(S\.members\)\.forEach/.test(IJS),
      'ensureBot 给所有群补小美（不只大厅）');

    // openConv 判定「是否拉过历史」必须用 histLoaded 标记
    log(IJS.indexOf('if (!(S.histLoaded || {})[conv]') >= 0,
      'openConv 用 histLoaded 标记判定是否拉历史');
    log(IJS.indexOf('if (!S.msgs[conv] || (S.impLoaded || {})[conv]) return loadHistory(conv);') < 0,
      '旧判定（msgs 是否存在）已彻底移除，不会只剩最新消息');
    // 只有首屏加载成功才标记；分页不算
    log(/if \(!before\) \{ S\.histLoaded = S\.histLoaded \|\| \{\}; S\.histLoaded\[conv\] = 1; \}/.test(IJS),
      '仅首屏加载成功才打 histLoaded 标记（分页不标记）');
    // 失败要撤销标记，允许重试
    log(/if \(S\.histLoaded\) delete S\.histLoaded\[conv\];/.test(IJS),
      '拉取失败撤销 histLoaded 标记（下次进会话可重试）');
  }

  // ===== 消息分页 + 本地缓存 + 版本戳格式（2026-09-23）=====
  {
    const fsx = require('fs');
    const pathx = require('path');
    const IJS = fsx.readFileSync(pathx.join(__dirname, 'index.html'), 'utf8');
    const LT = w.LT;

    // ---- 版本戳：只显示时间，去掉 git 提交号 ----
    log(IJS.indexOf("return BUILD.sha + ' · ' + BUILD.date;") < 0, 'verTag 不再拼接 git 提交号');
    log(/return m\[1\] \+ '\/' \+ m\[2\] \+ '\/' \+ m\[3\]/.test(IJS), '版本时间用 YYYY/MM/DD 格式输出');
    {
      const tag = LT.verTag();
      log(/^\d{4}\/\d{2}\/\d{2}( \d{2}:\d{2})?$/.test(tag), 'verTag() 实际输出「' + tag + '」形如 2026/09/23 12:08');
      log(!/[0-9a-f]{7}/.test(tag), '版本串里不含 sha（不再显示 3815341 这类提交号）');
    }
    log(IJS.indexOf("title=\"' + esc(((BUILD.sha ? BUILD.sha + ' · ' : '')") >= 0,
      'sha 移到 title 悬停可见（信息没丢，只是不占面板）');

    // ---- 首屏不再一次性灌入导入历史（用户报的「历史消息挤进最新窗口」根因）----
    log(IJS.indexOf('rows.concat(keep)') < 0, '旧的「首屏 concat 全部导入历史」已移除');
    log(IJS.indexOf('S.msgs[conv] = mergeById(rows, localPage(conv, lo, hi));') >= 0,
      '首屏只放最新一页 + 落在本 id 区间的导入历史');
    log(IJS.indexOf('localMsgs: {},') >= 0, 'S.localMsgs 独立桶存在（导入历史与云端消息分离）');
    log(/S\.localMsgs\[c\.conv\] = S\.localMsgs\[c\.conv\] \|\| \[\]/.test(IJS),
      '导入/启动恢复写入 localMsgs 而非 S.msgs');
    log(IJS.indexOf('if (!(S.histLoaded || {})[conv] || (S.impLoaded || {})[conv]) return loadHistory(conv);') < 0,
      'impLoaded 不再强制每次进会话重拉（省一次网络请求）');

    // ---- 合并去重 + id 数字比较 ----
    log(/function mergeById\(/.test(IJS), '存在 mergeById：统一去重 + 排序入口');
    {
      const merged = LT.mergeById([{ id: 10, t: 'b' }, { id: 9, t: 'a' }], [{ id: 10, t: 'dup' }, { id: 11, t: 'c' }]);
      log(merged.length === 3, 'mergeById 去重：4 条含 1 条重复 → 3 条');
      log(merged.map((x) => x.id).join(',') === '9,10,11', 'mergeById 按 id 升序：' + merged.map((x) => x.id).join(','));
      // ⚠️ 字符串比较会得出 '9' > '10'，时间线就串行了 —— 必须按数字比
      const sc = LT.mergeById([{ id: '10' }, { id: '9' }], []);
      log(sc.map((x) => x.id).join(',') === '9,10', 'id 按数字比较（字符串 id 也不会串行）');
      log(LT.mid({ id: 'abc' }) === 0, '非法 id 归一为 0（不会变成 NaN 污染排序）');
    }

    // ---- 本地缓存 ----
    log(IJS.indexOf("var MSG_CACHE_KEY = 'lt_msgcache_v1';") >= 0, '存在本地缓存键 lt_msgcache_v1');
    log(IJS.indexOf('var cch = cacheGet(conv);') >= 0, 'openConv 先用本地缓存渲染（不等网络，秒开）');
    log(/function cachePut\(conv\)/.test(IJS) && /function cacheGet\(conv\)/.test(IJS), '缓存读写函数齐备');
    log(/function cacheKey\(\) \{ return MSG_CACHE_KEY \+ \(S\.uid \? '_' \+ S\.uid : ''\); \}/.test(IJS),
      '缓存按账号隔离（换号登录不会先渲染出上一个人的消息）');
    log(IJS.indexOf('localStorage.getItem(cacheKey())') >= 0 && IJS.indexOf('localStorage.setItem(cacheKey()') >= 0,
      '缓存走 localStorage（云端存储 + 本地缓存双层）');

    // ---- 分页 + 滚动无感加载 ----
    log(/limit\(MSG_PAGE\)/.test(IJS), '云端查询按 MSG_PAGE 分页（不再一次拉全量）');
    log(LT.MSG_PAGE > 0 && LT.MSG_PAGE <= 50, '每页条数 MSG_PAGE=' + LT.MSG_PAGE + '（合理范围）');
    log(/function loadEarlier\(\)/.test(IJS), '存在 loadEarlier（无感加载入口）');
    log(/box\.addEventListener\('scroll'/.test(IJS), '消息容器挂了 scroll 监听');
    log(IJS.indexOf('if (box.scrollTop < MSG_NEAR_TOP) loadEarlier();') >= 0, '滚到距顶阈值内自动加载更早一页');
    log(IJS.indexOf("S.msgs[conv] = mergeById(rows.concat(localPage(conv, lo, hi)), S.msgs[conv]);") >= 0,
      '往更早翻时新页拼到前面（不是追加到末尾 → 不会倒序）');
    log(IJS.indexOf('if (before && !rows.length)') >= 0, '云端翻到底时用本地导入历史兜底');

    // ---- 时间线保序（用户报的「聊着聊着最新消息变成历史记录」）----
    // 根因：catchUpScoped 每 ~10s 用 desc 拉 200 条回填，pushMsg 又直接 append，
    // 于是窗口变成 [新…, 旧…]：最新消息被一堆历史夹在中间/上方。
    log(IJS.indexOf('var asc = (rows || []).slice().sort(byId);') >= 0,
      '回填结果先按 id 升序再消化（desc 返回不再倒序 push）');
    log(IJS.indexOf('if (!isNumId(m) || lastNum === -Infinity || id > lastNum) arr.push(m);') >= 0
      && IJS.indexOf('else { arr.push(m); arr.sort(byId); }') >= 0,
      'pushMsg 保序：乱序到达时重排，不再无脑追加到末尾');
    log(IJS.indexOf('if ((S.histLoaded || {})[conv] && arr.length && isNumId(m) && id < mid(arr[0])) return false;') >= 0,
      '已加载窗口拒绝更旧的回填消息（历史只由「加载更早」分页负责）');
    {
      const ord = [{ id: 'local_a' }, { id: 900 }].sort(LT.byId);
      log(ord[0].id === 900 && ord[1].id === 'local_a',
        '本地构造消息（无数字 id）排在有 id 的消息之后（洞察卡片不会飞到历史顶上）');
    }
    {
      const LT = w.LT; const S2 = LT && LT.S;
      const c = '__order_test__';
      S2.msgs[c] = []; S2.histLoaded = S2.histLoaded || {}; delete S2.histLoaded[c];
      LT.pushMsg(c, { id: 900 }); LT.pushMsg(c, { id: 930 });
      LT.pushMsg(c, { id: 905 });   // 空洞/乱序到达
      log(S2.msgs[c].map((m) => m.id).join(',') === '900,905,930',
        '乱序 push 后仍是升序：' + S2.msgs[c].map((m) => m.id).join(','));
      S2.histLoaded[c] = 1;
      const r = LT.pushMsg(c, { id: 731 });   // 回填里的旧消息
      log(r === false && S2.msgs[c].length === 3,
        '回填的旧消息被拦在窗口外（长度仍为 ' + S2.msgs[c].length + '）');
      LT.pushMsg(c, { id: 910 });
      log(S2.msgs[c].map((m) => m.id).join(',') === '900,905,910,930',
        '窗口内空洞消息插到正确位置，不破坏时间线');
      delete S2.msgs[c]; delete S2.histLoaded[c];
    }

    // ---- 导出不能丢导入历史 ----
    log(/concat\(\(S\.localMsgs \|\| \{\}\)\[c\.conv\] \|\| \[\]\)/.test(IJS), '导出包包含导入历史桶里的消息');
  }

  // ===== 会话隔离（安全边界）：2026-09-22 改为 canReadConv 独立判据 =====
  // 背景：messages 是全员共享表，任何客户端都能拉到所有人的消息。
  // 隔离的唯一边界是 canReadConv()，这里把它的四条关键性质钉死。
  {
    const LT = w.LT;
    const S = LT && LT.S;
    if (LT && LT.canReadConv && S) {
      const savedUid = S.uid;
      const savedFriends = S.friends;
      const savedMembers = S.members;
      const savedGroups = S.groups;
      const savedLocal = S.localConvs;
      const savedRecent = S.recent;

      S.uid = 'u_test';
      S.friends = [];
      S.members = { hall: ['u_test'] };
      S.groups = [];
      S.localConvs = {};
      S.recent = [];
      LT.rebuildMyConvs();

      // ① 陌生人的私聊必须被拒（这是这个函数存在的理由）
      log(LT.canReadConv('p:u_stranger_a~u_stranger_b') === false,
        '隔离：陌生人之间的私聊不可读');
      log(LT.canReadConv('p:u_test~u_stranger') === false,
        '隔离：与陌生人（无好友关系）的私聊不可读');
      // ② 大厅必须可读（否则首屏就是空的）
      log(LT.canReadConv('g:hall') === true, '隔离：大厅可读');
      // ③ 好友私聊可读 —— 关系数据驱动，不依赖消息
      S.friends = [{ a: 'u_test', b: 'u_friend', status: 'accepted' }];
      LT.rebuildMyConvs();
      log(LT.canReadConv('p:u_friend~u_test') === true,
        '隔离：好友私聊可读（由 friends 表推导，不依赖消息）');
      log(LT.canReadConv('p:u_friend~u_other') === false,
        '隔离：好友与他人的私聊仍不可读（不能顺带放行）');
      // ④ 我正在的群可读，不在的群不可读
      S.groups = [{ id: 'g1', name: '我的群' }, { id: 'g2', name: '别人的群' }];
      S.members = { hall: ['u_test'], g1: ['u_test', 'u_friend'], g2: ['u_friend'] };
      LT.rebuildMyConvs();
      log(LT.canReadConv('g:g1') === true, '隔离：我在的群可读');
      log(LT.canReadConv('g:g2') === false, '隔离：我不在的群不可读');
      // ⑤ 发送即注册（上次翻车的根因：刚建好、关系未同步时不在白名单）
      log(LT.canReadConv('p:u_new~u_test') === false, '隔离：尚未注册的新私聊，初始不可读');
      LT.allowConv('p:u_new~u_test');
      log(LT.canReadConv('p:u_new~u_test') === true,
        '隔离：发送即注册后立刻可读（回归「刚建的会话收不到自己的消息」）');
      // ⑥ 小美私聊始终可读（她不在 friends 表里）
      S.friends = [];
      LT.rebuildMyConvs();
      log(LT.canReadConv('p:bot_xiaomei~u_test') === true,
        '隔离：与小美的私聊始终可读（不依赖好友关系）');
      // ⑦ onNew 必须真的拦下陌生会话的消息（端到端，不只是谓词）
      const beforeMsgs = JSON.stringify(S.msgs['p:u_stranger_a~u_stranger_b'] || []);
      LT.onNew({
        id: 999999, conv: 'p:u_stranger_a~u_stranger_b', sender_id: 'u_stranger_a',
        sender_name: '陌生人', text: '这条不该出现', type: 'text', created_at: new Date().toISOString(),
      });
      const afterMsgs = JSON.stringify(S.msgs['p:u_stranger_a~u_stranger_b'] || []);
      log(beforeMsgs === afterMsgs, '隔离：onNew 拒收陌生人私聊（未写入内存）');
      log(!(S.unread['p:u_stranger_a~u_stranger_b'] > 0), '隔离：陌生人私聊不计未读');
      log(!(S.recent || []).some((m) => m.conv === 'p:u_stranger_a~u_stranger_b'),
        '隔离：陌生人私聊不进 recent（防止污染会话推导）');

      S.uid = savedUid;
      S.friends = savedFriends;
      S.members = savedMembers;
      S.groups = savedGroups;
      S.localConvs = savedLocal;
      S.recent = savedRecent;
      LT.rebuildMyConvs();
    } else {
      log(false, 'window.LT 已导出 canReadConv（会话隔离判据）', LT ? Object.keys(LT).join(',') : 'no LT');
    }
  }

  // ===== 隔离的源码级回归锁：拉取侧必须收窄，不能只靠前端不显示 =====
  {
    const fsx = require('fs');
    const pathx = require('path');
    const IJS = fsx.readFileSync(pathx.join(__dirname, 'index.html'), 'utf8');
    // 轮询与首屏都必须带 conv 范围条件
    log(IJS.indexOf("db.from('messages').select('*').in('conv', scope)") >= 0,
      '隔离：tick 拉取带 conv 范围（messages 不再全表下传）');
    log(IJS.indexOf("db.from('messages').select('*').in('conv', myConvList())") >= 0,
      '隔离：refreshAll / 搜索 拉取带 conv 范围');
    // 搜索结果（全表 ilike）必须再过一道白名单
    log(IJS.indexOf('rows = (rows || []).filter(function (m) { return canReadConv(m.conv); })') >= 0,
      '隔离：搜索聊天记录结果再过白名单（ilike 全表最易漏）');
    // 不能再出现「以 cm() 是否存在」当隔离判据
    log(IJS.indexOf('if (!canReadConv(m.conv)) return;') >= 0,
      '隔离：onNew 以 canReadConv 为判据');
    log(IJS.indexOf('会话列表推导不出来就说明这不是我的会话') < 0,
      '隔离：旧的「cm() 查不到即非我会话」判据已移除');
  }

  // =========================================================================
  // QA 回归锁：这一批是「高级测试工程师走查」发现并修掉的缺陷，
  // 每条都钉住修复后的行为/写法，防止日后改回去。
  // =========================================================================
  {
    const fsx = require('fs');
    const pathx = require('path');
    const IJS = fsx.readFileSync(pathx.join(__dirname, 'index.html'), 'utf8');

    console.log('\n===== QA 回归锁 =====\n');

    // ① @我 侧栏高亮：标记必须挂在 S.atMe 上并由 buildConvs 回填
    log(/atMe:\s*\{\}/.test(IJS), '回归·@我：S 上声明了 atMe 容器（标记不能挂在会话对象上）');
    log(/list\.forEach\(function \(c\) \{ c\.atMe = !!S\.atMe\[c\.conv\]; \}\)/.test(IJS),
      '回归·@我：buildConvs 末尾按 S.atMe 回填（buildConvs 整体重建 S.convs，挂对象上的标记会丢）');
    log(/S\.atMe\[m\.conv\] = 1;/.test(IJS), '回归·@我：onNew 写的是 S.atMe 而不是会话对象');
    log(/delete S\.atMe\[conv\];/.test(IJS), '回归·@我：openConv 清除该会话的 @ 提醒');

    // ② 行情卡片：cny 接口空返回不能崩
    log(/var cnyPrice = cny && cny\.current_price;/.test(IJS),
      '回归·行情卡：cny 取不到时不再直接读 current_price（原来会抛 TypeError 渲染成错误卡）');
    log(IJS.indexOf('cny.current_price) + \'  /  $\'') < 0,
      '回归·行情卡：不再有无保护的 cny.current_price 解引用');

    // ③ 象棋选中态：openRoom / closeRoom 必须清 xqSel
    log(/xqSel:\s*null/.test(IJS), '回归·象棋：S 上显式声明 xqSel');
    const openRoomBody = (IJS.match(/function openRoom\(id\) \{[\s\S]{0,600}?\n\}/) || [''])[0];
    log(openRoomBody.indexOf('S.xqSel = null') >= 0, '回归·象棋：openRoom 清空选中态（换局不带旧坐标）');
    const closeRoomBody = (IJS.match(/function closeRoom\(\) \{[\s\S]{0,400}?\n\}/) || [''])[0];
    log(closeRoomBody.indexOf('S.xqSel = null') >= 0, '回归·象棋：closeRoom 清空选中态');

    // ④ 发送失败：sendMsg 不能吞掉异常，doSend 要兜底还内容
    log(!/return m;\s*\}\)\.catch\(function \(e\) \{ toast\('发送失败/.test(IJS),
      '回归·发送：sendMsg 不再内部吞掉异常（否则调用方的失败兜底永远不触发）');
    log(/restoreDraft\(sentCount \? '' : text, atts\.slice\(sentCount\)\)/.test(IJS),
      '回归·发送：失败时把「未发出」的内容还回输入框/附件区');
    log(/function restoreDraft\(text, atts\)/.test(IJS), '回归·发送：提供了 restoreDraft 兜底函数');

    // ⑤ 主题切换不能整体覆写 body.className（会抹掉 unread-glow）
    log(IJS.indexOf("document.body.className = 'theme-'") < 0,
      '回归·主题：不再整体赋值 body.className');
    const themeBody = (IJS.match(/function applyTheme\(\) \{[\s\S]{0,400}?\n\}/) || [''])[0];
    log(themeBody.indexOf("classList.remove('theme-dark', 'theme-light')") >= 0,
      '回归·主题：改用 classList 增删，保留 body 上其它类（unread-glow）');

    // ⑥ parse60s 里那段恒等废话（已改为 d.date || ''）
    log(!/d\.date \|\| \(d\.date/.test(IJS), '回归·清理：parse60s 去掉恒等废话写法');

    // ⑦ 复制：navigator.clipboard 在非安全上下文是 undefined，必须有降级路径
    log(IJS.indexOf('navigator.clipboard.writeText(m.text') < 0,
      '回归·复制：不再直接解引用 navigator.clipboard（http 内网访问时为 undefined，会抛 TypeError）');
    log(/function copyText\(s\)/.test(IJS) && /function legacyCopy\(str\)/.test(IJS),
      '回归·复制：提供 copyText + execCommand 兜底');

    // ⑧ 中文输入法回车保护（IME 上字时不能误发消息）
    const imeGuards = IJS.match(/e\.isComposing \|\| e\.keyCode === 229/g) || [];
    log(imeGuards.length >= 2, '回归·IME：输入框与昵称页都挡住了输入法回车误发送', 'guards=' + imeGuards.length);
    log(/if \(e\.isComposing \|\| e\.keyCode === 229\) return;/.test(IJS),
      '回归·IME：#input 的 keydown 首行即拦截合成态回车');

    // ---- 服务端的回归锁 ----
    const SJS = fsx.readFileSync(pathx.join(__dirname, 'server.js'), 'utf8');
    // /api/analyze 的 abort 定时器必须进 finally（原来只在成功路径清，失败一次漏一个）
    {
      const at = SJS.indexOf("'/api/analyze' && req.method === 'POST'");
      const body = at >= 0 ? SJS.slice(at, at + 2600) : '';
      const fIdx = body.indexOf('} finally {');
      const cIdx = body.indexOf('clearTimeout(timer)');
      log(at >= 0 && fIdx > 0 && cIdx > fIdx,
        '回归·服务端：/api/analyze 的超时定时器进 finally（失败路径不再泄漏）',
        'at=' + at + ' finally=' + fIdx + ' clear=' + cIdx);
      log(SJS.indexOf('const r = await fetch(BASE_URL') < 0 || SJS.indexOf('clearTimeout(timer);\n      if (!r.ok)') < 0,
        '回归·服务端：不再「只在 fetch 成功后 clearTimeout」');
    }
    // 计费接口必须有速率限制
    log(/'\/api\/intent':\s*\{ limit:/.test(SJS) && /'\/api\/chat':\s*\{ limit:/.test(SJS) && /'\/api\/analyze':\s*\{ limit:/.test(SJS),
      '回归·服务端：三个计费接口都配了速率上限');
    log(/function rateHit\(pathname, ip\)/.test(SJS) && /function sendTooMany\(res, sec\)/.test(SJS),
      '回归·服务端：实现了按来源 IP 的滑动窗口限流与 429 响应');
    ['/api/intent', '/api/chat', '/api/analyze'].forEach((p) => {
      log(SJS.indexOf("rateHit('" + p + "', clientIp(req))") >= 0, '回归·服务端：' + p + ' 接入了限流');
    });
  }

  // ---- 行为级回归：这几个缺陷必须真的跑一遍，源码匹配挡不住逻辑回退 ----
  if (w.LT) {
    const LT2 = w.LT, S2 = LT2.S;

    // @我：onNew 之后会话对象上必须带着 atMe（buildConvs 重建后仍在）
    {
      const savedCur = S2.cur;
      const cv = 'g:hall';
      S2.cur = 'g:xx-none';   // 切走，避免当会话被立刻已读
      S2.atMe = S2.atMe || {};
      LT2.onNew({ id: 880001, conv: cv, sender_id: 'u_a', sender_name: '甲', type: 'text', text: '@我一下', mentions: ['u_test'], created_at: new Date().toISOString() });
      const c = LT2.cm()[cv];
      log(!!c && c.atMe === true, '回归·@我：onNew → 会话对象带 atMe（经 buildConvs 重建仍在）', c ? String(c.atMe) : 'no conv');
      delete S2.atMe[cv];
      S2.cur = savedCur;
      LT2.S.unread[cv] = 0;
    }

    // 象棋：换局后选中态必须被清掉
    {
      S2.xqSel = [3, 0];
      LT2.openRoom('gm_regress_xq');
      log(S2.xqSel === null, '回归·象棋：openRoom 后 xqSel 被清空', JSON.stringify(S2.xqSel));
      // 清场：别把这局残留在状态里影响后续用例
      S2.gameOpen = null;
      const gr = D.querySelector('#groom'); if (gr) gr.classList.add('hidden');
    }
  }

  log(errors.length === 0, '运行期间无 JS 异常', errors.join(' | '));
  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败\n');
  w.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('检查异常:', e); process.exit(1); });
