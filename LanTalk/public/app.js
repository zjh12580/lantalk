'use strict';
/* LanTalk 前端 —— 原生 JS，无框架无 CDN 依赖 */

const state = {
  token: localStorage.getItem('lantalk_token') || '',
  me: null,
  convs: [],
  current: null,
  msgs: {},            // conv -> [msg]
  requests: [],
  online: new Set(),
  typing: {},          // conv -> {userId: {name, ts}}
  theme: localStorage.getItem('lantalk_theme') || 'dark',
  sound: localStorage.getItem('lantalk_sound') !== 'off',
  replyTo: null,
  mentions: [],
  hasMore: {},
  filter: 'all',
  ws: null,
  showInfo: false,
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const convsMap = () => new Map(state.convs.map((c) => [c.conv, c]));

/* ================= 通用 UI ================= */
function toast(msg, type) {
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'err' ? ' err' : '');
  el.textContent = msg;
  el.onclick = () => el.remove();
  $('#toastWrap').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
function fmtTime(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function fmtDay(ts) {
  const d = new Date(ts); const t = new Date();
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, t)) return '今天';
  const y = new Date(t.getTime() - 86400000);
  if (same(d, y)) return '昨天';
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
function fmtListTime(ts) {
  const d = new Date(ts); const t = new Date();
  if (d.toDateString() === t.toDateString()) return fmtTime(ts);
  const y = new Date(t.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return '昨天';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function fmtSize(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
  while (n >= 1024 && i < 3) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(1)) + u[i];
}
function avatarHtml(name, color, cls) {
  return `<div class="avatar ${cls || ''}" style="background:${esc(color || '#888')}">${esc(String(name || '?').trim().charAt(0).toUpperCase())}</div>`;
}
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 660; o.type = 'sine';
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
    o.start(); o.stop(ctx.currentTime + 0.24);
    setTimeout(() => ctx.close(), 400);
  } catch (e) { /* 忽略 */ }
}
function notify(title, body, conv) {
  if (document.hasFocus() && state.current === conv) return;
  beepOn();
  try {
    if (window.Notification && Notification.permission === 'granted') {
      const n = new Notification(title, { body, icon: '/icon.svg', tag: conv });
      n.onclick = () => { window.focus(); if (conv) openConv(conv); };
    }
  } catch (e) { /* 忽略 */ }
}
function beepOn() { if (state.sound) beep(); }
function askNotify() {
  if (window.Notification && Notification.permission === 'default') Notification.requestPermission();
}

/* ================= API ================= */
async function api(path, opts = {}) {
  const headers = {};
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  if (opts.body && !(opts.body instanceof FormData) && typeof opts.body !== 'string') {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  let res;
  try {
    res = await fetch(path, { method: opts.method || 'GET', headers, body: opts.body });
  } catch (e) {
    throw new Error('无法连接服务器');
  }
  let data;
  try { data = await res.json(); } catch (e) { throw new Error('服务器响应异常'); }
  if (!data.ok) {
    if (res.status === 401) { logout(); }
    throw new Error(data.error || '请求失败');
  }
  return data;
}

/* ================= 登录 / 注册 ================= */
let authMode = 'login';
$$('.auth-tab').forEach((b) => b.onclick = () => {
  authMode = b.dataset.tab;
  $$('.auth-tab').forEach((x) => x.classList.toggle('active', x === b));
  $('#au-name').classList.toggle('hidden', authMode !== 'register');
  $('#authForm button').textContent = authMode === 'login' ? '登录' : '注册';
  $('#authError').textContent = '';
});
$('#authForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#authError').textContent = '';
  const username = $('#au-username').value.trim();
  const password = $('#au-password').value;
  const name = $('#au-name').value.trim();
  try {
    const r = await api(authMode === 'login' ? '/api/login' : '/api/register', {
      method: 'POST', body: { username, password, name },
    });
    state.token = r.token;
    localStorage.setItem('lantalk_token', r.token);
    askNotify();
    await boot();
  } catch (err) {
    $('#authError').textContent = err.message;
  }
};

function logout() {
  state.token = '';
  localStorage.removeItem('lantalk_token');
  if (state.ws) { state.ws.close(); state.ws = null; }
  location.reload();
}

/* ================= 启动 ================= */
async function boot() {
  const me = await api('/api/me');
  state.me = me.user;
  state.convs = me.conversations;
  state.requests = me.requests || [];
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  applyTheme();
  renderMe();
  renderConvs();
  connect();
  if (!state.msgs[state.current] && state.current) loadHistory(state.current);
}

function renderMe() {
  $('#meName').textContent = state.me.name;
  $('#meAvatar').textContent = state.me.name.charAt(0).toUpperCase();
  $('#meAvatar').style.background = state.me.color;
}

/* ================= WebSocket ================= */
function connect() {
  if (state.ws) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ t: 'hello', d: { token: state.token } }));
    setConn(true);
  };
  ws.onmessage = (ev) => {
    let p; try { p = JSON.parse(ev.data); } catch (e) { return; }
    onEvent(p);
  };
  ws.onclose = () => {
    state.ws = null;
    setConn(false);
    setTimeout(() => { if (state.token) connect(); }, 3000);
  };
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
}
function setConn(ok) {
  const el = $('#connState');
  el.textContent = ok ? '已连接' : '重连中…';
  el.className = ok ? 'conn-ok' : 'conn-bad';
}
function send(type, data) {
  if (!state.ws || state.ws.readyState !== 1) { toast('连接未就绪，请稍候', 'err'); return false; }
  state.ws.send(JSON.stringify({ t: type, d: data || {} }));
  return true;
}

function onEvent(p) {
  const { t, d } = p;
  switch (t) {
    case 'ready':
      break;
    case 'presence-list':
      state.online = new Set(d.online);
      updateOnlineInfo();
      renderConvs();
      break;
    case 'presence':
      state.online[d.online ? 'add' : 'delete'](d.userId);
      updateOnlineInfo();
      renderConvs();
      break;
    case 'msg':
      onMessage(d);
      break;
    case 'mention':
      if (d.mentions.includes(state.me.id)) {
        const c = convsMap().get(d.conv);
        notify(`${d.fromName} 在 ${c ? c.name : '群聊'} 中@了你`, d.text, d.conv);
        toast(`🔔 ${d.fromName} @了你：${d.text.slice(0, 30)}`);
        const cc = convsMap().get(d.conv);
        if (cc) cc.mentionMe = true;
        renderConvs();
      }
      break;
    case 'typing': {
      const key = d.conv;
      state.typing[key] = state.typing[key] || {};
      if (d.on) state.typing[key][d.userId] = { name: d.name, ts: Date.now() };
      else delete state.typing[key][d.userId];
      renderTyping();
      clearTimeout(state.typing._timer);
      state.typing._timer = setTimeout(renderTyping, 3500);
      break;
    }
    case 'read':
      if (d.conv === state.current) renderMsgs();
      break;
    case 'revoked': {
      const list = state.msgs[d.conv];
      if (list) { const m = list.find((x) => x.id === d.msgId); if (m) { m.revoked = true; m.text = ''; } }
      if (d.conv === state.current) renderMsgs();
      renderConvs();
      break;
    }
    case 'friend':
      refreshConvs();
      if (d.action === 'request') {
        toast('收到一条好友请求');
        beepOn();
      } else if (d.action === 'accepted') {
        toast(`${d.user ? d.user.name : ''} 已通过好友请求`);
      }
      break;
    case 'conv':
      refreshConvs();
      if (d.action === 'added') toast(`你被拉入群聊「${d.group ? d.group.name : ''}」`);
      if (d.action === 'removed' && state.current === store_convGroup(d.groupId)) closeConv();
      break;
    case 'profile':
      refreshConvs();
      break;
    case 'error':
      toast(d.message, 'err');
      break;
  }
}
const store_convGroup = (gid) => 'g:' + gid;

function onMessage(m) {
  const list = state.msgs[m.conv] || (state.msgs[m.conv] = []);
  if (!list.some((x) => x.id === m.id)) list.push(m);
  const c = convsMap().get(m.conv);
  if (c) {
    c.last = m;
    if (m.conv !== state.current && m.from !== state.me.id) {
      c.unread = (c.unread || 0) + 1;
      const muted = c.muted;
      notify(`${c.name}`, preview(m), m.conv);
      if (muted) toast(`[免打扰] ${c.name}：${preview(m)}`);
    }
  } else {
    refreshConvs();
  }
  if (m.conv === state.current) {
    renderMsgs();
    markRead(m.conv);
  } else {
    renderConvs();
  }
  updateTitle();
}
function preview(m) {
  if (m.revoked) return '[消息已撤回]';
  if (m.type === 'image') return '[图片]';
  if (m.type === 'file') return '[文件] ' + (m.fileName || '');
  return m.text || '';
}

/* ================= 会话列表 ================= */
function renderConvs() {
  const box = $('#convList');
  let list = state.convs.slice();
  if (state.filter === 'unread') list = list.filter((c) => (c.unread || 0) > 0);
  if (state.filter === 'group') list = list.filter((c) => c.type === 'group');
  if (state.filter === 'friend') return renderRequests();

  const total = state.convs.reduce((a, c) => a + (c.unread || 0), 0);
  $('#unreadTotal').textContent = total > 99 ? '99+' : total;
  $('#unreadTotal').classList.toggle('hidden', !total);
  $('#reqBadge').textContent = state.requests.length;
  $('#reqBadge').classList.toggle('hidden', !state.requests.length);

  if (!list.length) {
    box.innerHTML = `<div style="padding:28px 16px;text-align:center;color:var(--text-3);font-size:13px">暂无会话<br><small>点击 ＋ 建群或加好友</small></div>`;
    return;
  }
  box.innerHTML = list.map((c) => {
    const online = c.type === 'private' && state.online.has(c.id);
    const last = c.last;
    const atMe = c.mentionMe && (c.unread || 0) > 0;
    const previewText = last ? `${c.type === 'group' && last.from !== state.me.id ? last.fromName + '：' : ''}${preview(last)}` : '暂无消息';
    return `
      <div class="conv ${state.current === c.conv ? 'active' : ''}" data-conv="${esc(c.conv)}">
        <div style="position:relative">
          ${avatarHtml(c.name, c.color)}
          ${online ? '<span style="position:absolute;right:-2px;bottom:-2px;width:10px;height:10px;border-radius:50%;background:#07c160;border:2px solid var(--bg-2)"></span>' : ''}
        </div>
        <div class="conv-body">
          <div class="conv-top">
            <span class="conv-name">${esc(c.name)}${c.type === 'group' ? ` <span style="color:var(--text-3);font-size:11px">(${c.memberCount})</span>` : ''}</span>
            <span class="conv-time">${last ? fmtListTime(last.createdAt) : ''}</span>
          </div>
          <div class="conv-last">
            <span class="${atMe ? 'at-me' : ''}">${atMe ? '[有人@我] ' : ''}${esc(previewText)}</span>
          </div>
        </div>
        ${(c.unread || 0) > 0 ? `<span class="badge ${c.muted ? 'mute' : ''}">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}
        ${c.muted ? '<span style="font-size:11px;color:var(--text-3)">🔇</span>' : ''}
      </div>`;
  }).join('');
  box.querySelectorAll('.conv').forEach((el) => el.onclick = () => openConv(el.dataset.conv));
}

function renderRequests() {
  const box = $('#convList');
  if (!state.requests.length) {
    box.innerHTML = `<div style="padding:28px 16px;text-align:center;color:var(--text-3);font-size:13px">暂无好友请求</div>`;
    return;
  }
  box.innerHTML = state.requests.map((r) => `
    <div class="conv" data-req="${esc(r.id)}">
      ${avatarHtml(r.from.name, r.from.color)}
      <div class="conv-body">
        <div class="conv-top"><span class="conv-name">${esc(r.from.name)}</span></div>
        <div class="conv-last">${esc(r.message || '请求添加你为好友')}</div>
        <div style="margin-top:6px;display:flex;gap:6px">
          <button class="btn primary" data-accept="${esc(r.id)}" style="padding:3px 12px;font-size:12px">接受</button>
          <button class="btn ghost" data-reject="${esc(r.id)}" style="padding:3px 12px;font-size:12px">拒绝</button>
        </div>
      </div>
    </div>`).join('');
  box.querySelectorAll('[data-accept]').forEach((b) => b.onclick = async (e) => {
    e.stopPropagation();
    await api('/api/friend/respond', { method: 'POST', body: { requestId: b.dataset.accept, accept: true } });
    toast('已添加好友');
    refreshConvs();
  });
  box.querySelectorAll('[data-reject]').forEach((b) => b.onclick = async (e) => {
    e.stopPropagation();
    await api('/api/friend/respond', { method: 'POST', body: { requestId: b.dataset.reject, accept: false } });
    refreshConvs();
  });
}

async function refreshConvs() {
  const r = await api('/api/conversations');
  state.convs = r.conversations;
  const me = await api('/api/me');
  state.requests = me.requests || [];
  renderConvs();
  if (state.showInfo && state.current) renderInfo();
}
function updateOnlineInfo() {
  $('#onlineInfo').textContent = `在线 ${state.online.size + (state.online.has(state.me?.id) ? 0 : 1)} 人`;
}
function updateTitle() {
  const total = state.convs.reduce((a, c) => a + (c.unread || 0), 0);
  document.title = total ? `(${total}) LanTalk` : 'LanTalk · 局域网即时通讯';
}

/* ================= 打开会话 ================= */
async function openConv(conv) {
  state.current = conv;
  state.replyTo = null;
  $('#chatEmpty').classList.add('hidden');
  $('#chatMain').classList.remove('hidden');
  const c = convsMap().get(conv);
  if (!c) return;
  c.unread = 0; c.mentionMe = false;
  $('#chatName').textContent = c.name;
  $('#chatSub').textContent = c.type === 'group'
    ? `${c.memberCount} 位成员`
    : (state.online.has(c.id) ? '在线' : `最近活跃 ${fmtListTime(c.lastSeen || Date.now())}`);
  $('#announceBar').classList.toggle('hidden', !(c.type === 'group' && c.announcement));
  if (c.announcement) $('#announceBar').textContent = '📢 ' + c.announcement;
  $('#btnAt').classList.toggle('hidden', c.type !== 'group');
  $('#replyBar').classList.add('hidden');
  renderConvs();
  if (c.type === 'group') {
    api('/api/group/members?id=' + c.id).then((r) => {
      state.groupCache = state.groupCache || {};
      state.groupCache[c.id] = { members: r.members };
    }).catch(() => {});
  }
  await loadHistory(conv);
  markRead(conv);
  updateTitle();
  if (state.showInfo) renderInfo();
}

async function loadHistory(conv, before) {
  const r = await api(`/api/history?conv=${encodeURIComponent(conv)}${before ? '&before=' + before : ''}&limit=40`);
  const list = r.messages;
  if (before) state.msgs[conv] = list.concat(state.msgs[conv] || []);
  else state.msgs[conv] = list;
  state.hasMore[conv] = r.hasMore;
  renderMsgs(before ? 'keep' : 'bottom');
}
function closeConv() {
  state.current = null;
  $('#chatMain').classList.add('hidden');
  $('#chatEmpty').classList.remove('hidden');
  $('#infobar').classList.add('hidden');
}
function markRead(conv) {
  const list = state.msgs[conv] || [];
  if (!list.length) return;
  send('read', { conv, msgId: list[list.length - 1].id });
}

/* ================= 消息渲染 ================= */
function renderMsgs(scroll) {
  const box = $('#msgList');
  const list = state.msgs[state.current] || [];
  const prevH = box.scrollHeight;
  let html = '';
  if (state.hasMore[state.current]) {
    html += `<div class="msg-day"><span style="cursor:pointer" id="loadMore">加载更早的消息</span></div>`;
  }
  let lastDay = '';
  for (const m of list) {
    const day = fmtDay(m.createdAt);
    if (day !== lastDay) { html += `<div class="msg-day"><span>${day}</span></div>`; lastDay = day; }
    if (m.type === 'system') {
      html += `<div class="sys-msg"><span>${esc(m.text)}</span></div>`;
      continue;
    }
    const self = m.from === state.me.id;
    let inner = '';
    if (m.revoked) {
      inner = `<div class="revoked">${self ? '你' : esc(m.fromName)} 撤回了一条消息</div>`;
    } else {
      let body = '';
      if (m.replyTo) {
        body += `<div class="quote">${esc(m.replyTo.fromName || '')}：${esc(m.replyTo.text || (m.replyTo.fileName ? '[文件]' : ''))}</div>`;
      }
      if (m.type === 'image') {
        body += `<img class="attach" src="/api/file/${m.fileId}?token=${state.token}" alt="${esc(m.fileName || '图片')}" onclick="viewImage('${m.fileId}')">`;
      } else if (m.type === 'file') {
        body += `<div class="file-card" onclick="downloadFile('${m.fileId}',1)">
          <span class="fi">${fileIcon(m.fileName)}</span>
          <div><div class="fn">${esc(m.fileName)}</div><div class="fs">${fmtSize(m.fileSize)} · 点击下载</div></div>
        </div>`;
      } else {
        const mentioned = (m.mentions || []).includes(state.me.id);
        body += `<span class="${mentioned ? 'at-text' : ''}">${renderText(m.text, m.mentions || [])}</span>`;
        if (mentioned) body = body.replace('<span class="at-text">', '').replace('</span>', '');
      }
      inner = `<div class="bubble ${(m.mentions || []).includes(state.me.id) ? 'mention' : ''}">${body}</div>`;
    }
    const ops = m.revoked ? '' : `<div class="msg-ops">
        <button data-act="reply" data-id="${m.id}">回复</button>
        <button data-act="copy" data-id="${m.id}">复制</button>
        ${self && Date.now() - m.createdAt < 120000 ? `<button data-act="revoke" data-id="${m.id}">撤回</button>` : ''}
      </div>`;
    html += `<div class="msg ${self ? 'self' : ''}" data-msg="${m.id}">
      ${avatarHtml(m.fromName, m.fromColor, 'sm')}
      <div class="msg-body">
        ${state.current.startsWith('g:') && !self ? `<div class="msg-meta"><span>${esc(m.fromName)}</span></div>` : ''}
        ${inner}
        <div class="msg-meta"><span>${fmtTime(m.createdAt)}</span>${self && state.current.startsWith('p:') ? `<span>${readState(m)}</span>` : ''}</div>
        ${ops}
      </div>
    </div>`;
  }
  box.innerHTML = html;
  const lm = $('#loadMore');
  if (lm) lm.onclick = () => loadHistory(state.current, list[0] && list[0].id);
  box.querySelectorAll('.msg-ops button').forEach((b) => b.onclick = () => msgAction(b.dataset.act, b.dataset.id));

  if (scroll === 'keep') box.scrollTop = box.scrollHeight - prevH;
  else box.scrollTop = box.scrollHeight;
}
function readState(m) {
  const peer = state.current.slice(2).split('~').find((x) => x !== state.me.id);
  if (state.online.has(peer) && m.from === state.me.id) return '已送达';
  return '';
}
function renderText(text, mentions) {
  let h = esc(text);
  h = h.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" style="color:#4a8cf7">$1</a>');
  h = h.replace(/@([\u4e00-\u9fa5\w-]{1,20})/g, (mm, name) => {
    const hit = (mentions || []).length;
    return hit ? `<span class="at">${mm}</span>` : mm;
  });
  return h;
}
function fileIcon(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return '🖼';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '🗜';
  if (['pdf'].includes(ext)) return '📕';
  if (['doc', 'docx'].includes(ext)) return '📘';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📗';
  if (['mp4', 'avi', 'mov', 'mkv'].includes(ext)) return '🎬';
  if (['mp3', 'wav', 'flac'].includes(ext)) return '🎵';
  if (['sh', 'py', 'js', 'tcl', 'c', 'cpp', 'java', 'go'].includes(ext)) return '📜';
  return '📄';
}
function msgAction(act, id) {
  const m = (state.msgs[state.current] || []).find((x) => x.id === id);
  if (!m) return;
  if (act === 'reply') {
    state.replyTo = { id: m.id, fromName: m.fromName, text: m.text || m.fileName || '[文件]' };
    $('#replyBar').classList.remove('hidden');
    $('#replyText').textContent = `回复 ${m.fromName}：${m.text || m.fileName}`;
    $('#input').focus();
  } else if (act === 'copy') {
    navigator.clipboard.writeText(m.text || '').then(() => toast('已复制'), () => toast('复制失败', 'err'));
  } else if (act === 'revoke') {
    send('revoke', { conv: state.current, msgId: id });
  }
}
function renderTyping() {
  const c = state.current;
  const t = state.typing[c] || {};
  const names = Object.values(t).filter((x) => Date.now() - x.ts < 3500).map((x) => x.name);
  const bar = $('#typingBar');
  if (!names.length) { bar.classList.add('hidden'); bar.textContent = ''; return; }
  bar.classList.remove('hidden');
  bar.textContent = `${names.join('、')} 正在输入…`;
}
window.viewImage = (id) => openModal(`<h3>图片预览</h3><img src="/api/file/${id}?token=${state.token}" style="max-width:100%;border-radius:8px"><div class="modal-actions"><button class="btn" onclick="closeModal()">关闭</button><button class="btn primary" onclick="downloadFile('${id}',1)">下载</button></div>`);
window.downloadFile = (id) => {
  const a = document.createElement('a');
  a.href = `/api/file/${id}?dl=1&token=${state.token}`;
  a.click();
};

/* ================= 发送 ================= */
async function doSend() {
  const input = $('#input');
  const text = input.value.replace(/\s+$/, '');
  if (!text.trim()) return;
  if (!state.current) return;
  const mentions = detectMentions(text);
  const payload = {
    conv: state.current, type: 'text', text,
    mentions,
    replyTo: state.replyTo ? { id: state.replyTo.id, fromName: state.replyTo.fromName, text: state.replyTo.text } : null,
    tempId: 'tmp_' + Date.now(),
  };
  input.value = '';
  autoHeight();
  state.replyTo = null;
  $('#replyBar').classList.add('hidden');
  send('chat', payload);
  send('typing', { conv: state.current, on: false });
}
function detectMentions(text) {
  const c = convsMap().get(state.current);
  const out = [];
  if (c && c.type === 'group') {
    const g = state.groupCache && state.groupCache[c.id];
    if (g) {
      for (const m of g.members) {
        if (text.includes('@' + m.name) || text.includes('@' + m.username)) {
          if (!out.includes(m.id)) out.push(m.id);
        }
      }
      if (text.includes('@全体成员') || text.includes('@all')) out.push(...g.members.filter((x) => x !== state.me.id));
    }
  }
  return out;
}
async function uploadAndSend(file, type) {
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) { toast('文件不能超过 25MB', 'err'); return; }
  toast('正在上传…');
  try {
    const r = await api(`/api/upload?name=${encodeURIComponent(file.name)}&mime=${encodeURIComponent(file.type || 'application/octet-stream')}`, {
      method: 'POST', body: file,
    });
    send('chat', {
      conv: state.current, type, fileId: r.file.id, fileName: r.file.name,
      fileSize: r.file.size, mime: r.file.mime, text: '', mentions: [],
    });
  } catch (e) { toast(e.message, 'err'); }
}

/* ================= 输入框 ================= */
let composing = false;
const input = $('#input');
input.addEventListener('compositionstart', () => composing = true);
input.addEventListener('compositionend', () => composing = false);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !composing) { e.preventDefault(); doSend(); return; }
  send('typing', { conv: state.current, on: true });
  clearTimeout(input._t);
  input._t = setTimeout(() => send('typing', { conv: state.current, on: false }), 2500);
});
function autoHeight() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 140) + 'px';
}
input.addEventListener('input', autoHeight);

$('#btnSend').onclick = doSend;
$('#btnEmoji').onclick = (e) => {
  const pop = $('#emojiPop');
  if (!pop.classList.contains('hidden')) { pop.classList.add('hidden'); return; }
  const emojis = ['😀','😄','😁','😂','🤣','😊','😍','😘','😎','🤔','😅','😭','😡','🥳','👍','👏','🙏','💪','🎉','❤️','🔥','✨','✅','❌','⭐','🌙','☕','🍺','🐶','🐱','🚀','💡','📌','📎','🕐','😴','🤝','👀','🧠','💰'];
  pop.innerHTML = emojis.map((x) => `<span>${x}</span>`).join('');
  pop.style.left = Math.min(e.clientX, innerWidth - 340) + 'px';
  pop.style.top = (e.clientY - 260) + 'px';
  pop.classList.remove('hidden');
  pop.querySelectorAll('span').forEach((s) => s.onclick = () => {
    input.value += s.textContent;
    pop.classList.add('hidden');
    input.focus();
  });
};
$('#btnAt').onclick = (e) => {
  const c = convsMap().get(state.current);
  if (!c) return;
  openMention(c, e);
};
input.addEventListener('keyup', (e) => {
  if (e.key === '@' && state.current && state.current.startsWith('g:')) {
    openMention(convsMap().get(state.current));
  }
});
function openMention(c, e) {
  const g = state.groupCache && state.groupCache[c.id];
  if (!g) { input.value += '@'; input.focus(); return; }
  const pop = $('#mentionPop');
  pop.innerHTML = `<div class="mention-item" data-all="1">👥 全体成员</div>` +
    g.members.map((m) => `<div class="mention-item" data-uid="${m.id}" data-name="${esc(m.name)}">${avatarHtml(m.name, m.color, 'sm')} ${esc(m.name)}</div>`).join('');
  const r = input.getBoundingClientRect();
  pop.style.left = r.left + 'px';
  pop.style.top = (r.top - Math.min(230, pop.scrollHeight + 10) - 6) + 'px';
  pop.classList.remove('hidden');
  pop.querySelectorAll('.mention-item').forEach((it) => it.onclick = () => {
    if (it.dataset.all) input.value += '@全体成员 ';
    else { input.value += '@' + it.dataset.name + ' '; state.pendingMention = it.dataset.uid; }
    pop.classList.add('hidden');
    input.focus();
  });
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('#emojiPop') && !e.target.closest('#btnEmoji')) $('#emojiPop').classList.add('hidden');
  if (!e.target.closest('#mentionPop') && !e.target.closest('#btnAt')) $('#mentionPop').classList.add('hidden');
});
$('#btnImage').onclick = () => $('#imageInput').click();
$('#btnFile').onclick = () => $('#fileInput').click();
$('#imageInput').onchange = (e) => { uploadAndSend(e.target.files[0], 'image'); e.target.value = ''; };
$('#fileInput').onchange = (e) => { uploadAndSend(e.target.files[0], 'file'); e.target.value = ''; };
$('#btnHistory').onclick = () => {
  const list = state.msgs[state.current] || [];
  if (list.length) loadHistory(state.current, list[0].id);
};
$('#replyCancel').onclick = () => { state.replyTo = null; $('#replyBar').classList.add('hidden'); };

/* ================= 顶部按钮 ================= */
$('#btnLogout').onclick = logout;
$('#btnTheme').onclick = () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('lantalk_theme', state.theme);
  applyTheme();
};
function applyTheme() {
  document.body.className = 'theme-' + state.theme;
  $('#btnTheme').textContent = state.theme === 'dark' ? '🌙' : '☀️';
}
$('#btnVoice').onclick = () => {
  state.sound = !state.sound;
  localStorage.setItem('lantalk_sound', state.sound ? 'on' : 'off');
  $('#btnVoice').classList.toggle('off', !state.sound);
  toast(state.sound ? '提示音已开启' : '提示音已关闭');
};
$('#btnVoice').classList.toggle('off', !state.sound);

$('#meBox').onclick = () => {
  openModal(`
    <h3>我的资料</h3>
    <label>昵称</label><input class="input" id="pfName" value="${esc(state.me.name)}">
    <label>个性签名</label><input class="input" id="pfSig" value="${esc(state.me.signature || '')}" placeholder="一句话介绍自己">
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn primary" id="pfSave">保存</button>
    </div>`);
  $('#pfSave').onclick = async () => {
    try {
      await api('/api/profile', { method: 'POST', body: { name: $('#pfName').value, signature: $('#pfSig').value } });
      state.me.name = $('#pfName').value; state.me.signature = $('#pfSig').value;
      renderMe(); closeModal(); toast('已保存');
    } catch (e) { toast(e.message, 'err'); }
  };
};

$('#btnNew').onclick = () => showNewModal();
$('#btnSearch').onclick = () => {
  const row = $('#searchRow');
  row.classList.toggle('hidden');
  if (!row.classList.contains('hidden')) $('#searchInput').focus();
};
$('#btnInfo').onclick = () => {
  state.showInfo = !state.showInfo;
  $('#infobar').classList.toggle('hidden', !state.showInfo);
  if (state.showInfo) renderInfo();
};
$('#btnSearchInConv').onclick = () => showSearchModal();
$('#announceBar').onclick = () => showGroupModal(convsMap().get(state.current).id);

$$('.conv-tab').forEach((b) => b.onclick = () => {
  state.filter = b.dataset.filter;
  $$('.conv-tab').forEach((x) => x.classList.toggle('active', x === b));
  renderConvs();
});

/* ================= 弹窗 ================= */
function openModal(html) {
  $('#modal').innerHTML = html;
  $('#modalWrap').classList.remove('hidden');
}
window.closeModal = () => $('#modalWrap').classList.add('hidden');
$('#modalWrap').onclick = (e) => { if (e.target.id === 'modalWrap') closeModal(); };

function showNewModal() {
  openModal(`
    <h3>发起会话</h3>
    <label>搜索用户名或昵称，添加好友 / 拉进群聊</label>
    <input class="input" id="nuSearch" placeholder="输入关键字">
    <div class="result-list" id="nuResults"></div>
    <div class="chip-list" id="nuSelected"></div>
    <label>群聊名称（选择 2 人及以上可建群）</label>
    <input class="input" id="nuGroupName" placeholder="例如：项目周会">
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">关闭</button>
      <button class="btn primary" id="nuCreate">创建群聊</button>
    </div>`);
  const selected = new Map();
  const render = () => {
    $('#nuSelected').innerHTML = Array.from(selected.values())
      .map((u) => `<div class="chip on" data-id="${u.id}">${esc(u.name)} ✕</div>`).join('');
    $('#nuSelected').querySelectorAll('.chip').forEach((c) => c.onclick = () => { selected.delete(c.dataset.id); render(); });
  };
  let timer;
  $('#nuSearch').oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = $('#nuSearch').value.trim();
      if (!q) { $('#nuResults').innerHTML = ''; return; }
      const r = await api('/api/search?q=' + encodeURIComponent(q));
      $('#nuResults').innerHTML = r.users.map((u) => `
        <div class="result-item" data-id="${u.id}" data-name="${esc(u.name)}" data-username="${esc(u.username)}" data-color="${esc(u.color)}">
          ${avatarHtml(u.name, u.color, 'sm')}
          <div class="ri-body"><div class="ri-name">${esc(u.name)}</div><div class="ri-sub">@${esc(u.username)} ${u.isFriend ? '' : '· 非好友'}</div></div>
          <button class="btn ${selected.has(u.id) ? '' : 'primary'}" style="padding:4px 12px;font-size:12px">${selected.has(u.id) ? '移除' : (u.isFriend ? '选择' : '加好友')}</button>
        </div>`).join('') || '<div style="padding:12px;color:var(--text-3);font-size:13px">未找到用户</div>';
      $('#nuResults').querySelectorAll('.result-item').forEach((it) => it.onclick = async () => {
        const uid = it.dataset.id;
        if (selected.has(uid)) { selected.delete(uid); render(); return; }
        const isFriend = state.convs.some((c) => c.type === 'private' && c.id === uid && c.isFriend);
        if (!isFriend) {
          try { await api('/api/friend/request', { method: 'POST', body: { to: uid, message: '你好，加个好友' } }); toast('好友请求已发送'); }
          catch (e) { toast(e.message, 'err'); }
        }
        selected.set(uid, { id: uid, name: it.dataset.name });
        render();
      });
    }, 250);
  };
  $('#nuCreate').onclick = async () => {
    const ids = Array.from(selected.keys());
    if (ids.length < 2) { toast('请至少选择 2 位成员', 'err'); return; }
    const name = $('#nuGroupName').value.trim() || `${state.me.name}、${Array.from(selected.values()).slice(0, 2).map((u) => u.name).join('、')} 等`;
    try {
      const r = await api('/api/group/create', { method: 'POST', body: { name, members: ids } });
      closeModal();
      await refreshConvs();
      openConv('g:' + r.group.id);
    } catch (e) { toast(e.message, 'err'); }
  };
}

function showSearchModal() {
  openModal(`
    <h3>查找聊天记录</h3>
    <input class="input" id="smInput" placeholder="输入关键字搜索所有会话">
    <div class="result-list" id="smResults"></div>
    <div class="modal-actions"><button class="btn" onclick="closeModal()">关闭</button></div>`);
  let timer;
  $('#smInput').oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = $('#smInput').value.trim();
      if (!q) { $('#smResults').innerHTML = ''; return; }
      const r = await api('/api/search/message?q=' + encodeURIComponent(q));
      const map = convsMap();
      $('#smResults').innerHTML = r.messages.length ? r.messages.map((m) => {
        const c = map.get(m.conv);
        return `<div class="result-item" data-conv="${esc(m.conv)}">
          ${avatarHtml(m.fromName, m.fromColor, 'sm')}
          <div class="ri-body"><div class="ri-name">${esc(m.fromName)} · ${esc(c ? c.name : '')}</div>
          <div class="ri-sub">${esc(m.text.slice(0, 40))}</div></div>
          <span style="font-size:11px;color:var(--text-3)">${fmtListTime(m.createdAt)}</span>
        </div>`;
      }).join('') : '<div style="padding:12px;color:var(--text-3);font-size:13px">没有找到相关消息</div>';
      $('#smResults').querySelectorAll('.result-item').forEach((it) => it.onclick = () => {
        closeModal(); openConv(it.dataset.conv);
      });
    }, 250);
  };
}

$('#searchInput').oninput = () => {
  const q = $('#searchInput').value.trim().toLowerCase();
  if (!q) { renderConvs(); return; }
  const list = state.convs.filter((c) => c.name.toLowerCase().includes(q));
  $('#convList').innerHTML = list.length ? list.map((c) => `
    <div class="conv" data-conv="${esc(c.conv)}">
      ${avatarHtml(c.name, c.color)}
      <div class="conv-body"><div class="conv-top"><span class="conv-name">${esc(c.name)}</span></div>
      <div class="conv-last">${esc(preview(c.last || {}))}</div></div>
    </div>`).join('') : '<div style="padding:20px;color:var(--text-3);font-size:13px;text-align:center">无匹配会话</div>';
  $('#convList').querySelectorAll('.conv').forEach((el) => el.onclick = () => openConv(el.dataset.conv));
};

/* ================= 右侧信息栏 ================= */
async function renderInfo() {
  const c = convsMap().get(state.current);
  if (!c) return;
  const bar = $('#infobar');
  if (c.type === 'group') {
    const r = await api('/api/group/members?id=' + c.id);
    state.groupCache = state.groupCache || {};
    state.groupCache[c.id] = { members: r.members };
    const isOwner = c.owner === state.me.id;
    bar.innerHTML = `
      <div class="info-section" style="text-align:center">
        ${avatarHtml(c.name, c.color, 'lg')}
        <div style="margin-top:8px;font-weight:600">${esc(c.name)}</div>
        <div style="font-size:12px;color:var(--text-3)">${c.memberCount} 位成员</div>
      </div>
      <div class="info-section">
        <h4>群成员</h4>
        <div class="member-grid">
          ${r.members.map((m) => `<div class="member" data-uid="${m.id}">${avatarHtml(m.name, m.color, 'sm')}<span>${esc(m.name)}${m.id === c.owner ? ' 👑' : ''}</span></div>`).join('')}
          ${isOwner ? '<div class="member" id="inviteBtn"><div class="avatar sm" style="background:var(--bg-hover);color:var(--text-2)">＋</div><span>邀请</span></div>' : ''}
        </div>
      </div>
      <div class="info-section">
        <h4>设置</h4>
        <div class="info-row"><span>消息免打扰</span><button class="btn ghost" id="muteBtn" style="padding:4px 12px;font-size:12px">${c.muted ? '已开启' : '已关闭'}</button></div>
        ${isOwner ? '<div class="info-row"><span>群名称</span><button class="btn ghost" id="renameBtn" style="padding:4px 12px;font-size:12px">修改</button></div>' : ''}
        ${isOwner ? '<div class="info-row"><span>群公告</span><button class="btn ghost" id="annoBtn" style="padding:4px 12px;font-size:12px">编辑</button></div>' : ''}
      </div>
      <div class="info-section">
        <button class="btn ${isOwner ? 'danger' : 'ghost'} block" id="leaveBtn">${isOwner ? '解散群聊' : '退出群聊'}</button>
      </div>`;
    bar.querySelectorAll('.member[data-uid]').forEach((m) => m.onclick = () => openPrivate(m.dataset.uid));
    const inv = $('#inviteBtn');
    if (inv) inv.onclick = () => showInviteModal(c);
    $('#muteBtn').onclick = async () => {
      await api('/api/group/update', { method: 'POST', body: { groupId: c.id, muted: !c.muted } });
      await refreshConvs(); toast(c.muted ? '已关闭免打扰' : '已开启免打扰');
    };
    if ($('#renameBtn')) $('#renameBtn').onclick = () => promptModal('修改群名称', c.name, async (v) => {
      await api('/api/group/update', { method: 'POST', body: { groupId: c.id, name: v } });
      await refreshConvs(); toast('已修改');
    });
    if ($('#annoBtn')) $('#annoBtn').onclick = () => promptModal('编辑群公告', c.announcement || '', async (v) => {
      await api('/api/group/update', { method: 'POST', body: { groupId: c.id, announcement: v } });
      await refreshConvs(); toast('已更新');
    }, true);
    $('#leaveBtn').onclick = async () => {
      confirmModal(isOwner ? '确定解散该群聊？所有消息将被删除。' : '确定退出该群聊？', async () => {
        await api(isOwner ? '/api/group/dismiss' : '/api/group/leave', { method: 'POST', body: { groupId: c.id } });
        closeModal(); closeConv(); await refreshConvs();
      });
    };
  } else {
    const peer = state.convPeerInfo(c);
    bar.innerHTML = `
      <div class="info-section" style="text-align:center">
        ${avatarHtml(c.name, c.color, 'lg')}
        <div style="margin-top:8px;font-weight:600">${esc(c.name)}</div>
        <div style="font-size:12px;color:var(--text-3)">@${esc(c.username || '')}</div>
        <div style="font-size:12px;color:var(--text-3);margin-top:4px">${state.online.has(c.id) ? '🟢 在线' : '⚪ 离线'}</div>
        ${peer && peer.signature ? `<div style="font-size:12px;color:var(--text-2);margin-top:8px">${esc(peer.signature)}</div>` : ''}
      </div>
      <div class="info-section">
        <h4>设置</h4>
        <div class="info-row"><span>备注名</span><button class="btn ghost" id="remarkBtn" style="padding:4px 12px;font-size:12px">${esc(state.getRemark ? '' : '')}修改</button></div>
        ${c.isFriend ? '<div class="info-row"><span>好友关系</span><button class="btn ghost" id="delFriendBtn" style="padding:4px 12px;font-size:12px;color:var(--danger)">删除好友</button></div>' : '<div class="info-row"><span>非好友</span><button class="btn primary" id="addFriendBtn" style="padding:4px 12px;font-size:12px">加为好友</button></div>'}
      </div>
      <div class="info-section">
        <button class="btn block" id="clearBtn" onclick="closeConv()">关闭会话</button>
      </div>`;
    $('#remarkBtn').onclick = () => promptModal('设置备注名', c.name, async (v) => {
      await api('/api/remark', { method: 'POST', body: { peerId: c.id, remark: v } });
      await refreshConvs(); toast('已保存');
    });
    if ($('#delFriendBtn')) $('#delFriendBtn').onclick = () => confirmModal('确定删除该好友？', async () => {
      await api('/api/friend?peer=' + c.id, { method: 'DELETE' });
      closeModal(); closeConv(); await refreshConvs();
    });
    if ($('#addFriendBtn')) $('#addFriendBtn').onclick = async () => {
      await api('/api/friend/request', { method: 'POST', body: { to: c.id, message: '你好，加个好友' } });
      toast('好友请求已发送');
    };
  }
}
state.convPeerInfo = () => null;

async function openPrivate(uid) {
  try {
    const r = await api('/api/conv/open', { method: 'POST', body: { peerId: uid } });
    await refreshConvs();
    openConv(r.conv);
  } catch (e) { toast(e.message, 'err'); }
}

function showInviteModal(c) {
  openModal(`
    <h3>邀请成员</h3>
    <input class="input" id="ivSearch" placeholder="搜索用户名">
    <div class="result-list" id="ivResults"></div>
    <div class="modal-actions"><button class="btn" onclick="closeModal()">关闭</button></div>`);
  let timer;
  $('#ivSearch').oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = $('#ivSearch').value.trim();
      if (!q) return;
      const r = await api('/api/search?q=' + encodeURIComponent(q));
      const inGroup = new Set(c.members || []);
      $('#ivResults').innerHTML = r.users.map((u) => `
        <div class="result-item" data-id="${u.id}">
          ${avatarHtml(u.name, u.color, 'sm')}
          <div class="ri-body"><div class="ri-name">${esc(u.name)}</div><div class="ri-sub">@${esc(u.username)}</div></div>
          <button class="btn ${inGroup.has(u.id) ? '' : 'primary'}" style="padding:4px 12px;font-size:12px" ${inGroup.has(u.id) ? 'disabled' : ''}>${inGroup.has(u.id) ? '已在群内' : '邀请'}</button>
        </div>`).join('');
      $('#ivResults').querySelectorAll('.result-item').forEach((it) => it.onclick = async () => {
        await api('/api/group/invite', { method: 'POST', body: { groupId: c.id, members: [it.dataset.id] } });
        toast('已邀请');
        await refreshConvs();
        if (state.showInfo) renderInfo();
      });
    }, 250);
  };
}

function promptModal(title, value, onOk, textarea) {
  openModal(`
    <h3>${esc(title)}</h3>
    ${textarea
      ? `<textarea class="input" id="pmInput" rows="4" style="resize:vertical">${esc(value)}</textarea>`
      : `<input class="input" id="pmInput" value="${esc(value)}">`}
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn primary" id="pmOk">确定</button>
    </div>`);
  $('#pmOk').onclick = async () => { await onOk($('#pmInput').value.trim()); closeModal(); };
}
function confirmModal(text, onOk) {
  openModal(`
    <h3>确认操作</h3>
    <p style="color:var(--text-2);line-height:1.7">${esc(text)}</p>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn danger" id="cfOk">确定</button>
    </div>`);
  $('#cfOk').onclick = onOk;
}

/* ================= 启动 ================= */
(async function init() {
  applyTheme();
  if (!state.token) { $('#auth').classList.remove('hidden'); return; }
  try {
    await boot();
  } catch (e) {
    state.token = '';
    localStorage.removeItem('lantalk_token');
    $('#auth').classList.remove('hidden');
  }
})();
