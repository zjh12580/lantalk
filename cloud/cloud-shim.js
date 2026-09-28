/* ============================================================================
 * cloud-shim.js —— 自托管适配壳
 * ----------------------------------------------------------------------------
 * 作用：把原本依赖 WorkBuddy 云平台的 window.WorkBuddyCloud SDK，替换为自建实现，
 *       让 index.html 里几十处 CLOUD.* 调用一行业务代码都不用改。
 *
 * 两种自建模式（由 window.__LT_CONFIG__.mode 决定）：
 *
 *   1. 'lite'     —— 精简自建（默认推荐，1~2G 小鸡也能跑）
 *      Node 内置 SQLite + server.js 里的 /api/db、/api/auth、/api/storage。
 *      零第三方依赖、无 Docker、无 Supabase。PostgREST 风格的链式调用由本文件的
 *      查询构建器收集，打包成一份 plan 发给 /api/db 执行。
 *
 *   2. 'selfhost' —— 自托管 Supabase（需 4G+ 内存）
 *      database 直接透传 supabase-js（原云端 SDK 本来就是 Supabase 形态），
 *      auth / storage 只做一层字段名映射。
 *
 * 启用条件：mode 必须是上面两者之一，否则完全不碰平台 SDK（平台模式零干预）。
 *
 * 对 index.html 的要求：只需在 <head> 里引入本文件。
 * ==========================================================================*/
(function () {
  'use strict';

  var cfg = window.__LT_CONFIG__ || {};
  var MODE = cfg.mode;
  if (MODE !== 'lite' && MODE !== 'selfhost') return;    // 平台模式：什么都不做

  var API_BASE = (cfg.apiBase || '').replace(/\/+$/, '');   // 空串 = 同源

  /* ---------------- 两种模式共用：LLM 转发到自建 server.js ---------------- */
  // 前端仅 botLLM 兜底路径用到 /api/llm/stream（OpenAI 风格 SSE）
  function parseSSE(res, onDelta) {
    return new Promise(function (resolve, reject) {
      var reader = res.body.getReader();
      var dec = new TextDecoder();
      var buf = '';
      (function pump() {
        reader.read().then(function (r) {
          if (r.done) return resolve();
          buf += dec.decode(r.value, { stream: true });
          var lines = buf.split('\n');
          buf = lines.pop();
          lines.forEach(function (ln) {
            ln = ln.trim();
            if (ln.indexOf('data:') !== 0) return;
            var payload = ln.slice(5).trim();
            if (payload === '[DONE]') return;
            try { onDelta(JSON.parse(payload)); } catch (e) { /* 忽略心跳等非 JSON 行 */ }
          });
          pump();
        }).catch(reject);
      })();
    });
  }
  var llm = {
    models: {
      list: function () {
        return fetch(API_BASE + '/api/models')
          .then(function (r) { return r.json(); })
          .then(function (j) { return { data: (j && j.data) || [], error: null }; })
          .catch(function (e) { return { data: [], error: e }; });
      },
    },
    chat: {
      completions: {
        // 与原用法一致：async iterable，yield {choices:[{delta:{content}}]}
        create: function (req) {
          var it = (async function* () {
            var res = await fetch(API_BASE + '/api/llm/stream', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: req.model,
                messages: req.messages,
                temperature: req.temperature,
              }),
              signal: req.signal,
            });
            if (!res.ok || !res.body) throw new Error('llm ' + res.status);
            var queue = [];
            await parseSSE(res, function (chunk) { queue.push(chunk); });
            while (queue.length) yield queue.shift();
          })();
          return it;
        },
      },
    },
  };

  /* ---------------- 两种模式共用：组装并暴露 SDK ---------------- */
  function wire_common(parts) {
    window.WorkBuddyCloud = {
      createWorkBuddyCloud: function () {
        return {
          auth: parts.auth, database: parts.database, storage: parts.storage,
          llm: llm, _selfhost: true, _mode: MODE,
        };
      },
    };
    window.__LT_SHIM_READY = true;
  }

  /* ==========================================================================
   * 模式一：lite —— 精简自建（SQLite + 自建鉴权 + 本地存储）
   * ========================================================================*/
  if (MODE === 'lite') {
    var TOKEN_KEY = 'lt_lite_tok';

    function getTok() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
    function setTok(t) {
      try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) { /* 隐私模式 */ }
      // ⚠️ 图片是 <img src> 加载的，不会带 Authorization 头 —— 必须同时写 cookie，
      //    服务端 /api/storage/f/* 才能认出是谁（否则聊天里的图全是 401）。
      try {
        document.cookie = 'lt_tok=' + encodeURIComponent(t || '')
          + '; path=/; max-age=' + (t ? 60 * 60 * 24 * 30 : 0) + '; samesite=lax';
      } catch (e) { /* noop */ }
    }
    function authHeaders() {
      var h = { 'Content-Type': 'application/json' };
      var t = getTok();
      if (t) h.Authorization = 'Bearer ' + t;
      return h;
    }
    function api(pathname, body) {
      return fetch(API_BASE + pathname, {
        method: body ? 'POST' : 'GET',
        headers: authHeaders(),
        body: body ? JSON.stringify(body) : undefined,
      }).then(function (r) { return r.json(); })
        .then(function (j) { return j || { error: { message: '空响应' } }; })
        .catch(function (e) { return { error: { message: String(e && e.message || e) } }; });
    }

    /* ---------------- database：PostgREST 风格查询构建器 ---------------- */
    // 链式调用只负责「攒计划」，真正的执行发生在 then/catch（即 q() 消费时）。
    function qb(table) {
      var st = { table: table, op: 'select', cols: '*', filters: [], order: null, limit: null, payload: null };
      function run() {
        return api('/api/db', st);
      }
      var b = {
        select: function (c) { st.cols = c || '*'; return b; },
        insert: function (o) { st.op = 'insert'; st.payload = o; st.cols = null; return b; },
        upsert: function (o) { st.op = 'upsert'; st.payload = o; st.cols = null; return b; },
        update: function (o) { st.op = 'update'; st.payload = o; st.cols = null; return b; },
        delete: function () { st.op = 'delete'; st.cols = null; return b; },
        eq: function (c, v) { st.filters.push(['eq', c, v]); return b; },
        in: function (c, v) { st.filters.push(['in', c, v]); return b; },
        gt: function (c, v) { st.filters.push(['gt', c, v]); return b; },
        lt: function (c, v) { st.filters.push(['lt', c, v]); return b; },
        order: function (c, o) { st.order = [c, !!(o && o.ascending)]; return b; },
        limit: function (n) { st.limit = n; return b; },
        then: function (a, r) { return run().then(a, r); },
        catch: function (c) { return run().catch(c); },
      };
      if (typeof b.finally === 'undefined') {
        b.finally = function (f) { return run().then(function (v) { f(); return v; }, function (e) { f(); throw e; }); };
      }
      return b;
    }

    /* ---------------- auth ---------------- */
    var auth = {
      sendOtp: function (o) {
        return api('/api/auth/sendotp', { email: o.email }).then(function (r) {
          if (r.error) return { error: r.error };
          if (r.data && r.data.devCode) console.info('[lt] 验证码（未配 SMTP，开发回显）：' + r.data.devCode);
          return { data: r.data };
        });
      },
      verifyOtp: function (o) {
        return api('/api/auth/verify', {
          email: o.email, token: o.token, password: o.password || undefined,
        }).then(function (r) {
          if (r.error) return { error: r.error };
          if (r.data && r.data.session) setTok(r.data.session.access_token);
          return { data: r.data };
        });
      },
      signInWithPassword: function (o) {
        return api('/api/auth/password', { email: o.email, password: o.password }).then(function (r) {
          if (r.error) return { error: r.error };
          if (r.data && r.data.session) setTok(r.data.session.access_token);
          return { data: r.data };
        });
      },
      // ⚠️ 原平台：r.data 直接是 session 对象（有 .user.id），不是 {session}
      getSession: function () {
        return api('/api/auth/session').then(function (r) {
          if (r.error) return { data: null, error: r.error };
          var s = (r.data && r.data.session) || null;
          if (s && s.access_token) setTok(s.access_token);
          return { data: s };
        });
      },
      getAccessToken: function () { return Promise.resolve(getTok()); },
      signOut: function () {
        setTok('');
        return api('/api/auth/signout', {}).then(function () { return { data: {} }; });
      },
      resetPasswordForEmail: function (email) {
        return api('/api/auth/reset', { email: email }).then(function (r) {
          if (r.error) return { error: r.error };
          if (r.data && r.data.devCode) console.info('[lt] 重置码（未配 SMTP，开发回显）：' + r.data.devCode);
          return {
            data: {
              updateUser: function (o) {
                return api('/api/auth/reset/confirm', { email: email, nonce: o.nonce, password: o.password })
                  .then(function (r2) {
                    if (r2.error) return { error: r2.error };
                    if (r2.data && r2.data.session) setTok(r2.data.session.access_token);
                    return { data: r2.data };
                  });
              },
            },
          };
        });
      },
      onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
    };

    /* ---------------- storage ---------------- */
    var storage = {
      sharedPath: function (uid, sub) {
        return String(uid) + '/' + String(sub || '').replace(/^\/+/, '');
      },
      update: function (p, file, opts) {
        opts = opts || {};
        var t = getTok();
        return fetch(API_BASE + '/api/storage/upload?path=' + encodeURIComponent(p), {
          method: 'POST',
          headers: t ? { Authorization: 'Bearer ' + t } : {},
          body: file,
        }).then(function (r) { return r.json(); })
          .then(function (j) { return j || { error: { message: '上传失败' } }; })
          .catch(function (e) { return { error: { message: String(e && e.message || e) } }; });
      },
      exists: function (p) {
        return api('/api/storage/stat?path=' + encodeURIComponent(p)).then(function (r) {
          return { data: !!(r.data && r.data.exists), error: r.error };
        });
      },
      info: function (p) {
        return storage.exists(p).then(function (r) { return { data: { exists: !!r.data }, error: r.error }; });
      },
      // 自建没有签名 URL：图片走 /api/storage/f/<path>，靠 cookie 里的 lt_tok 鉴权
      createSignedUrl: function (p) {
        var u = API_BASE + '/api/storage/f/' + String(p).split('/').map(encodeURIComponent).join('/');
        return Promise.resolve({ data: { signedUrl: u, url: u } });
      },
      remove: function () { return Promise.resolve({ data: {}, error: null }); },
    };

    wire_common({ auth: auth, database: { from: qb }, storage: storage });
    console.info('[lt-shim] 精简自建模式（lite）已启用' + (API_BASE || '（同源）'));
    return;
  }

  /* ==========================================================================
   * 模式二：selfhost —— 自托管 Supabase
   * ========================================================================*/
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    console.error('[lt-shim] __LT_CONFIG__ 缺少 supabaseUrl / supabaseAnonKey，适配壳未启用');
    return;
  }

  var BUCKET = cfg.bucket || 'chat';
  var API_BASE = (cfg.apiBase || '').replace(/\/+$/, '');   // 空串 = 同源
  var SB_CDN = cfg.supabaseCdn
    || 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';

  function injectSupabase(cb) {
    if (window.supabase && window.supabase.createClient) return cb();
    var s = document.createElement('script');
    s.src = SB_CDN;
    s.onload = cb;
    s.onerror = function () { console.error('[lt-shim] supabase-js 加载失败：' + SB_CDN); };
    document.head.appendChild(s);
  }

  function wire() {
    var sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,           // 验证码模式，不用 URL 里的 token
        storageKey: 'lt_sb_session',
      },
    });

    /* ---------------- storage ---------------- */
    // 路径约定与原平台一致：{uid}/chat/xxx、{uid}/avatar/xxx
    var storage = {
      sharedPath: function (uid, sub) {
        return String(uid) + '/' + String(sub || '').replace(/^\/+/, '');
      },
      // 原用法：st.createSignedUrl(path, 600) -> {data:{signedUrl}} / {error}
      createSignedUrl: function (p, ttl) {
        return sb.storage.from(BUCKET).createSignedUrl(p, ttl || 600).then(function (r) {
          if (r.error) return { error: r.error };
          var u = (r.data && r.data.signedUrl) || '';
          return { data: { signedUrl: u, url: u } };
        });
      },
      // 原用法：st.update(path, file, {contentType, cacheControl}) —— 幂等落盘
      update: function (p, file, opts) {
        opts = opts || {};
        return sb.storage.from(BUCKET).upload(p, file, {
          upsert: true,
          contentType: opts.contentType || 'application/octet-stream',
          cacheControl: String(opts.cacheControl || '3600'),
        }).then(function (r) { return { data: r.data, error: r.error }; });
      },
      // 原用法：st.exists(path) -> {data:true|{exists:true}}
      exists: function (p) {
        var i = String(p).lastIndexOf('/');
        var dir = i >= 0 ? String(p).slice(0, i) : '';
        var name = i >= 0 ? String(p).slice(i + 1) : String(p);
        return sb.storage.from(BUCKET).list(dir, { search: name, limit: 100 }).then(function (r) {
          if (r.error) return { data: false, error: r.error };
          var hit = (r.data || []).some(function (o) { return o && o.name === name; });
          return { data: hit };
        });
      },
      info: function (p) {
        return storage.exists(p).then(function (r) {
          return { data: { exists: !!r.data }, error: r.error };
        });
      },
      // 兼容：某些分支可能直接调 remove
      remove: function (paths) {
        return sb.storage.from(BUCKET).remove([].concat(paths)).then(function (r) {
          return { data: r.data, error: r.error };
        });
      },
    };

    /* ---------------- auth ---------------- */
    var auth = {
      // 原用法：sendOtp({email}) -> {data:{verificationId, isExistingUser}} | {error:{message}}
      sendOtp: function (o) {
        return sb.auth.signInWithOtp({
          email: o.email,
          options: { shouldCreateUser: true, emailRedirectTo: undefined },
        }).then(function (r) {
          if (r.error) return { error: r.error };
          // Supabase 不在响应里区分新老用户，也不返回 verificationId；
          // 用邮箱本身当 verificationId 回传给后续 verifyOtp（前端只做等值比较，不解析它）。
          return { data: { verificationId: o.email, isExistingUser: true } };
        });
      },
      // 原用法：verifyOtp({verificationId, token, email, isExistingUser, password?})
      verifyOtp: function (o) {
        return sb.auth.verifyOtp({ email: o.email, token: o.token, type: 'email' })
          .then(function (r) {
            if (r.error) return { error: r.error };
            // 注册模式带 password：登录成功后再补设密码，下次可直接密码登录
            if (o.password) {
              return sb.auth.updateUser({ password: o.password }).then(function (r2) {
                return { data: r.data, error: r2.error };
              });
            }
            return { data: r.data };
          });
      },
      signInWithPassword: function (o) {
        return sb.auth.signInWithPassword({ email: o.email, password: o.password })
          .then(function (r) { return { data: r.data, error: r.error }; });
      },
      // ⚠️ 原平台：r.data 直接是 session 对象（有 .user.id）；Supabase 是 {session}
      getSession: function () {
        return sb.auth.getSession().then(function (r) {
          return { data: (r.data && r.data.session) || null, error: r.error };
        });
      },
      getAccessToken: function () {
        return sb.auth.getSession().then(function (r) {
          var s = r.data && r.data.session;
          return (s && s.access_token) || '';
        });
      },
      signOut: function () {
        return sb.auth.signOut().then(function (r) { return { data: r.data, error: r.error }; });
      },
      // 原用法：resetPasswordForEmail(email) -> {data:{updateUser({nonce,password})}}
      resetPasswordForEmail: function (email) {
        return sb.auth.resetPasswordForEmail(email).then(function (r) {
          if (r.error) return { error: r.error };
          return {
            data: {
              updateUser: function (o) {
                // Supabase 的恢复流程：verifyOtp(type:'recovery') 换取临时会话，再改密码
                return sb.auth.verifyOtp({ email: email, token: o.nonce, type: 'recovery' })
                  .then(function (r2) {
                    if (r2.error) return { error: r2.error };
                    return sb.auth.updateUser({ password: o.password });
                  });
              },
            },
          };
        });
      },
      onAuthStateChange: function (cb) { return sb.auth.onAuthStateChange(cb); },
    };

    /* ---------------- database ---------------- */
    // 同构透传：Supabase 的 from()/rpc() 与原平台完全一致（PostgREST 风格）
    var database = {
      from: function (t) { return sb.from(t); },
      rpc: function (n, p) { return sb.rpc(n, p); },
    };

    /* ---------------- 暴露 ---------------- */
    // llm 与 parseSSE 已提到两种模式共用的外层，这里只组装数据/鉴权/存储
    wire_common({ auth: auth, database: database, storage: storage });
    console.info('[lt-shim] 自托管 Supabase 模式（selfhost）已启用 → ' + cfg.supabaseUrl);
  }

  injectSupabase(wire);
})();
