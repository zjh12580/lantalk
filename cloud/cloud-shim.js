/* ============================================================================
 * cloud-shim.js —— 自托管适配壳
 * ----------------------------------------------------------------------------
 * 作用：把原本依赖 WorkBuddy 云平台的 window.WorkBuddyCloud SDK，替换为
 *       自托管 Supabase（Auth / PostgREST / Storage）+ 自建 Node 服务的实现。
 *
 * 为什么能这么干：原云端 SDK 的数据层本来就是 Supabase 形态
 *   （db.from('t').select().eq()...、auth.uid()、RLS、authenticated 角色），
 *   所以 database 直接透传 supabase-js 即可，auth / storage 只需做一层字段名映射。
 *
 * 启用条件（两条都满足才接管，否则完全不碰平台 SDK）：
 *   1. window.__LT_CONFIG__.mode === 'selfhost'
 *   2. window.supabase 已加载（shim 会自动注入 supabase-js 的 CDN）
 *
 * 对 index.html 的要求：一行业务代码都不用改。只需在 <head> 里引入本文件。
 * ==========================================================================*/
(function () {
  'use strict';

  var cfg = window.__LT_CONFIG__ || {};
  if (cfg.mode !== 'selfhost') return;            // 平台模式：什么都不做
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

    /* ---------------- llm ---------------- */
    // 前端仅 botLLM 兜底路径用到；转发到自建 server.js 的 /api/llm/stream
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

    /* ---------------- 暴露 ---------------- */
    window.WorkBuddyCloud = {
      createWorkBuddyCloud: function () {
        return { auth: auth, database: database, storage: storage, llm: llm, _selfhost: true };
      },
    };
    window.__LT_SHIM_READY = true;
    console.info('[lt-shim] 自托管适配壳已启用 → ' + cfg.supabaseUrl);
  }

  injectSupabase(wire);
})();
