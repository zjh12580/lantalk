'use strict';
/**
 * LanTalk —— 局域网即时通讯服务端
 * 零第三方依赖（仅 Node 内置模块），Node >= 16 即可运行。
 * 启动： node server.js        端口： PORT 环境变量，默认 3000
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const store = require('./lib/store');
const presence = require('./lib/presence');
const ws = require('./lib/ws');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

store.load();
const db = store.db();
db.sessions = db.sessions || {};

/* ================= 工具 ================= */
const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
};
const ok = (res, obj) => json(res, 200, Object.assign({ ok: true }, obj));
const fail = (res, msg, code = 400) => json(res, code, { ok: false, error: msg });

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function tokenOf(req, url) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  if (url.searchParams.get('token')) return url.searchParams.get('token');
  return '';
}
function userByToken(req, url) {
  const t = tokenOf(req, url);
  if (!t || !db.sessions[t]) return null;
  const s = db.sessions[t];
  if (s.expires && s.expires < Date.now()) { delete db.sessions[t]; return null; }
  return store.getUser(s.userId);
}
function newSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = { userId, createdAt: Date.now(), expires: Date.now() + 90 * 24 * 3600 * 1000 };
  store.save();
  return token;
}

/* ================= 会话与推送 ================= */
function convMembers(conv) {
  const p = store.convKey.parse(conv);
  if (p.type === 'group') return (store.getGroup(p.id) || { members: [] }).members;
  return p.users;
}

function push(conv, event, excludeConn) {
  const members = convMembers(conv);
  for (const uid of members) {
    for (const conn of presence.list(uid)) {
      if (conn === excludeConn) continue;
      try { conn.sendJSON(event); } catch (e) { /* ignore */ }
    }
  }
}
function pushTo(uid, event) {
  for (const conn of presence.list(uid)) {
    try { conn.sendJSON(event); } catch (e) {}
  }
}
function broadcast(event, excludeUserId) {
  for (const uid of presence.onlineIds()) {
    if (uid === excludeUserId) continue;
    pushTo(uid, event);
  }
}

/** 构造会话摘要（列表用） */
function convSummary(userId) {
  const list = [];
  const seen = new Set();
  // 群聊
  for (const g of store.groupsOf(userId)) {
    const conv = store.convKey.group(g.id);
    const last = store.lastMessage(conv);
    list.push({
      conv, type: 'group', id: g.id, name: g.name, color: g.color,
      memberCount: g.members.length, members: g.members,
      announcement: g.announcement || '', owner: g.owner,
      muted: !!g.mute?.[userId],
      last: last || null,
      unread: store.unreadCount(conv, userId),
      createdAt: g.createdAt,
    });
    seen.add(conv);
  }
  // 私聊：好友 + 有过消息往来的人
  const peers = new Set(store.friendIds(userId));
  for (const conv of Object.keys(db.messages)) {
    if (!conv.startsWith('p:')) continue;
    const p = store.convKey.parse(conv);
    if (!p.users.includes(userId)) continue;
    peers.add(p.users[0] === userId ? p.users[1] : p.users[0]);
  }
  for (const pid of peers) {
    const peer = store.getUser(pid);
    if (!peer || pid === userId) continue;
    const conv = store.convKey.private(userId, pid);
    if (seen.has(conv)) continue;
    const last = store.lastMessage(conv);
    list.push({
      conv, type: 'private', id: pid, name: store.getRemark(userId, pid) || peer.name,
      username: peer.username, color: peer.color, online: presence.isOnline(pid),
      lastSeen: peer.lastSeen,
      isFriend: store.isFriend(userId, pid),
      muted: false,
      last: last || null,
      unread: store.unreadCount(conv, userId),
      createdAt: peer.createdAt,
    });
  }
  list.sort((a, b) => (b.last?.createdAt || b.createdAt || 0) - (a.last?.createdAt || a.createdAt || 0));
  return list;
}

/* ================= HTTP ================= */
const routes = {
  'POST /api/register': async (req, res, url, body) => {
    const { username, password, name } = JSON.parse(body || '{}');
    if (!username || !password) return fail(res, '用户名和密码不能为空');
    if (!/^[\w一-龥.@-]{2,24}$/.test(username)) return fail(res, '用户名需 2-24 位，仅支持中英文、数字、下划线');
    if (String(password).length < 3) return fail(res, '密码至少 3 位');
    const user = store.createUser({ username, password, name });
    ok(res, { token: newSession(user.id), user: store.publicUser(user, user.id) });
  },

  'POST /api/login': async (req, res, url, body) => {
    const { username, password } = JSON.parse(body || '{}');
    const user = store.verifyUser(username, password);
    if (!user) return fail(res, '用户名或密码错误', 401);
    user.lastSeen = Date.now();
    store.save();
    ok(res, { token: newSession(user.id), user: store.publicUser(user, user.id) });
  },

  'GET /api/me': async (req, res, url, body, user) => {
    ok(res, {
      user: store.publicUser(user, user.id),
      conversations: convSummary(user.id),
      requests: store.pendingRequests(user.id),
      sent: store.sentRequests(user.id),
      onlineCount: presence.count(),
    });
  },

  'POST /api/logout': async (req, res, url, body, user) => {
    const t = tokenOf(req, url);
    if (t) { delete db.sessions[t]; store.save(); }
    ok(res, {});
  },

  'POST /api/profile': async (req, res, url, body, user) => {
    const { name, signature } = JSON.parse(body || '{}');
    if (name) user.name = String(name).slice(0, 24);
    if (signature !== undefined) user.signature = String(signature).slice(0, 60);
    store.save();
    broadcast({ t: 'profile', d: store.publicUser(user, user.id) });
    ok(res, { user: store.publicUser(user, user.id) });
  },

  'GET /api/search': async (req, res, url, body, user) => {
    const q = url.searchParams.get('q') || '';
    if (!q) return ok(res, { users: [], groups: [] });
    const users = store.findByName(q).slice(0, 20).map((u) => store.publicUser(u, user.id));
    const groups = db.groups.filter((g) => !g.members.includes(user.id) && g.name.toLowerCase().includes(q.toLowerCase())).slice(0, 10)
      .map((g) => ({ id: g.id, name: g.name, memberCount: g.members.length, color: g.color }))
      .filter((g) => g.name.length > 0);
    ok(res, { users, groups });
  },

  'POST /api/friend/request': async (req, res, url, body, user) => {
    const { to, message } = JSON.parse(body || '{}');
    const target = store.getUser(to);
    if (!target) return fail(res, '用户不存在');
    if (to === user.id) return fail(res, '不能添加自己');
    const r = store.addFriendRequest(user.id, to, message);
    if (r.accepted) {
      pushTo(to, { t: 'friend', d: { action: 'accepted', user: store.publicUser(user, to), conv: store.convKey.private(user.id, to) } });
      pushTo(user.id, { t: 'friend', d: { action: 'accepted', user: store.publicUser(target, user.id), conv: store.convKey.private(user.id, to) } });
    } else {
      pushTo(to, { t: 'friend', d: { action: 'request', request: { id: r.friendship.id, from: store.publicUser(user, to), message: message || '', createdAt: r.friendship.createdAt } } });
    }
    ok(res, { accepted: r.accepted });
  },

  'POST /api/friend/respond': async (req, res, url, body, user) => {
    const { requestId, accept } = JSON.parse(body || '{}');
    const f = db.friends.find((x) => x.id === requestId && x.b === user.id && x.status === 'pending');
    if (!f) return fail(res, '请求不存在或已处理');
    const fromId = f.a;
    store.respondFriendRequest(user.id, requestId, accept);
    const conv = store.convKey.private(user.id, fromId);
    if (accept) {
      pushTo(fromId, { t: 'friend', d: { action: 'accepted', user: store.publicUser(user, fromId), conv } });
      pushTo(user.id, { t: 'friend', d: { action: 'accepted', user: store.getUser(fromId) ? store.publicUser(store.getUser(fromId), user.id) : null, conv } });
      const sys = store.addMessage({ conv, from: 'system', type: 'system', text: '你们已成为好友，打个招呼吧' });
      push(conv, { t: 'msg', d: toWire(sys) });
    }
    ok(res, {});
  },

  'DELETE /api/friend': async (req, res, url, body, user) => {
    const peerId = url.searchParams.get('peer');
    store.removeFriend(user.id, peerId);
    pushTo(peerId, { t: 'friend', d: { action: 'removed', userId: user.id } });
    ok(res, {});
  },

  'POST /api/remark': async (req, res, url, body, user) => {
    const { peerId, remark } = JSON.parse(body || '{}');
    store.setRemark(user.id, peerId, String(remark || '').slice(0, 24));
    ok(res, {});
  },

  'POST /api/group/create': async (req, res, url, body, user) => {
    const { name, members } = JSON.parse(body || '{}');
    const g = store.createGroup({ name: String(name || '').slice(0, 30) || '未命名群聊', owner: user.id, members: (members || []).filter((m) => store.getUser(m)) });
    const conv = store.convKey.group(g.id);
    const sys = store.addMessage({ conv, from: 'system', type: 'system', text: `群聊「${g.name}」创建成功` });
    for (const m of g.members) {
      pushTo(m, { t: 'conv', d: { action: 'added', group: groupView(g, m) } });
    }
    push(conv, { t: 'msg', d: toWire(sys) });
    ok(res, { group: groupView(g, user.id) });
  },

  'POST /api/group/invite': async (req, res, url, body, user) => {
    const { groupId, members } = JSON.parse(body || '{}');
    const g = store.getGroup(groupId);
    if (!g) return fail(res, '群聊不存在');
    if (!g.members.includes(user.id)) return fail(res, '你不是该群成员');
    const added = store.addGroupMembers(groupId, (members || []).filter((m) => store.getUser(m) && !g.members.includes(m)));
    const conv = store.convKey.group(groupId);
    const names = (members || []).map((m) => store.getUser(m)?.name).filter(Boolean).join('、');
    if (added) {
      const sys = store.addMessage({ conv, from: 'system', type: 'system', text: `${user.name} 邀请 ${names} 加入群聊` });
      push(conv, { t: 'msg', d: toWire(sys) });
      for (const m of g.members) pushTo(m, { t: 'conv', d: { action: 'updated', group: groupView(g, m) } });
    }
    ok(res, { added });
  },

  'POST /api/group/kick': async (req, res, url, body, user) => {
    const { groupId, userId } = JSON.parse(body || '{}');
    const g = store.getGroup(groupId);
    if (!g) return fail(res, '群聊不存在');
    if (g.owner !== user.id) return fail(res, '只有群主可以移出成员');
    if (userId === g.owner) return fail(res, '不能移出群主');
    store.removeGroupMember(groupId, userId);
    const conv = store.convKey.group(groupId);
    const sys = store.addMessage({ conv, from: 'system', type: 'system', text: `${store.getUser(userId)?.name || '成员'} 已被移出群聊` });
    push(conv, { t: 'msg', d: toWire(sys) });
    pushTo(userId, { t: 'conv', d: { action: 'removed', groupId } });
    ok(res, {});
  },

  'POST /api/group/leave': async (req, res, url, body, user) => {
    const { groupId } = JSON.parse(body || '{}');
    const g = store.getGroup(groupId);
    if (!g) return fail(res, '群聊不存在');
    if (g.owner === user.id) return fail(res, '群主不能退出群聊，可先转让或解散');
    store.removeGroupMember(groupId, user.id);
    const conv = store.convKey.group(groupId);
    const sys = store.addMessage({ conv, from: 'system', type: 'system', text: `${user.name} 退出了群聊` });
    push(conv, { t: 'msg', d: toWire(sys) });
    ok(res, {});
  },

  'POST /api/group/dismiss': async (req, res, url, body, user) => {
    const { groupId } = JSON.parse(body || '{}');
    const g = store.getGroup(groupId);
    if (!g) return fail(res, '群聊不存在');
    if (g.owner !== user.id) return fail(res, '只有群主可以解散群聊');
    const members = g.members.slice();
    db.groups.splice(db.groups.indexOf(g), 1);
    delete db.messages[store.convKey.group(groupId)];
    store.save();
    for (const m of members) pushTo(m, { t: 'conv', d: { action: 'removed', groupId } });
    ok(res, {});
  },

  'POST /api/group/update': async (req, res, url, body, user) => {
    const { groupId, name, announcement, muted } = JSON.parse(body || '{}');
    const g = store.getGroup(groupId);
    if (!g) return fail(res, '群聊不存在');
    if (!g.members.includes(user.id)) return fail(res, '你不是该群成员');
    if (name !== undefined) {
      if (g.owner !== user.id) return fail(res, '只有群主可以修改群名');
      g.name = String(name).slice(0, 30);
    }
    if (announcement !== undefined) {
      if (g.owner !== user.id) return fail(res, '只有群主可以修改群公告');
      g.announcement = String(announcement).slice(0, 500);
    }
    if (muted !== undefined) store.setGroupMuted(groupId, user.id, !!muted);
    store.save();
    const conv = store.convKey.group(groupId);
    if (announcement !== undefined && announcement) {
      const sys = store.addMessage({ conv, from: 'system', type: 'system', text: `群公告已更新：${g.announcement}` });
      push(conv, { t: 'msg', d: toWire(sys) });
    }
    for (const m of g.members) pushTo(m, { t: 'conv', d: { action: 'updated', group: groupView(g, m) } });
    ok(res, { group: groupView(g, user.id) });
  },

  'GET /api/group/members': async (req, res, url, body, user) => {
    const g = store.getGroup(url.searchParams.get('id'));
    if (!g) return fail(res, '群聊不存在');
    ok(res, { members: g.members.map((m) => store.publicUser(store.getUser(m), user.id)) });
  },

  'GET /api/history': async (req, res, url, body, user) => {
    const conv = url.searchParams.get('conv');
    const before = url.searchParams.get('before') || null;
    const limit = Math.min(Number(url.searchParams.get('limit') || 30), 100);
    if (!canAccess(user.id, conv)) return fail(res, '无权访问该会话', 403);
    const list = store.history(conv, { before, limit });
    ok(res, { messages: list.map(toWire), hasMore: (db.messages[conv] || []).length > list.length });
  },

  'POST /api/read': async (req, res, url, body, user) => {
    const { conv, msgId } = JSON.parse(body || '{}');
    if (!canAccess(user.id, conv)) return fail(res, '无权访问', 403);
    store.markRead(conv, user.id, msgId);
    push(conv, { t: 'read', d: { conv, userId: user.id, msgId: store.lastReadOf(conv, user.id) } }, null);
    ok(res, {});
  },

  'POST /api/revoke': async (req, res, url, body, user) => {
    const { conv, msgId } = JSON.parse(body || '{}');
    const m = store.revokeMessage(conv, msgId, user.id);
    push(conv, { t: 'revoked', d: { conv, msgId } });
    ok(res, { message: toWire(m) });
  },

  'GET /api/search/message': async (req, res, url, body, user) => {
    const q = url.searchParams.get('q') || '';
    const convs = convSummary(user.id).map((c) => c.conv);
    const res_ = store.searchMessages(user.id, q, convs);
    ok(res, { messages: res_.map(toWire) });
  },

  'POST /api/upload': async (req, res, url, body, user) => {
    if (body.length > 25 * 1024 * 1024) return fail(res, '文件不能超过 25MB');
    if (!body.length) return fail(res, '空文件');
    const name = decodeURIComponent(url.searchParams.get('name') || 'file');
    const f = store.saveFile({ name, size: body.length, mime: url.searchParams.get('mime') || 'application/octet-stream', data: body, uploader: user.id });
    ok(res, { file: { id: f.id, name: f.name, size: f.size, mime: f.mime } });
  },

  'POST /api/conv/open': async (req, res, url, body, user) => {
    const { peerId } = JSON.parse(body || '{}');
    if (!store.getUser(peerId)) return fail(res, '用户不存在');
    const conv = store.convKey.private(user.id, peerId);
    if (!db.messages[conv]) { db.messages[conv] = []; store.save(); }
    ok(res, { conv });
  },

  'GET /api/conversations': async (req, res, url, body, user) => {
    ok(res, { conversations: convSummary(user.id) });
  },

  'GET /api/online': async (req, res, url, body, user) => {
    ok(res, { online: presence.onlineIds(), count: presence.count() });
  },
};

function groupView(g, viewerId) {
  return {
    id: g.id, name: g.name, owner: g.owner, color: g.color,
    members: g.members.slice(), announcement: g.announcement || '',
    muted: !!g.mute?.[viewerId], createdAt: g.createdAt,
    memberViews: g.members.map((m) => store.publicUser(store.getUser(m), viewerId)).filter(Boolean),
  };
}
function toWire(m) {
  const u = m.from !== 'system' ? store.getUser(m.from) : null;
  return {
    id: m.id, conv: m.conv, from: m.from, type: m.type,
    fromName: u ? u.name : '系统', fromColor: u ? u.color : '#888',
    text: m.text || '', fileName: m.fileName || '', fileId: m.fileId || '',
    fileSize: m.fileSize || 0, mime: m.mime || '',
    replyTo: m.replyTo || null, mentions: m.mentions || [],
    revoked: !!m.revoked, createdAt: m.createdAt,
  };
}
function canAccess(userId, conv) {
  if (!conv) return false;
  const p = store.convKey.parse(conv);
  if (p.type === 'group') return (store.getGroup(p.id) || { members: [] }).members.includes(userId);
  return p.users.includes(userId);
}

/* 静态文件 */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  try {
    // 文件下载
    if (url.pathname.startsWith('/api/file/')) {
      const user = userByToken(req, url);
      if (!user) return fail(res, '未登录', 401);
      const f = store.getFile(url.pathname.slice('/api/file/'.length));
      if (!f) return fail(res, '文件不存在', 404);
      const dl = url.searchParams.get('dl') === '1';
      res.writeHead(200, {
        'Content-Type': dl ? 'application/octet-stream' : f.mime,
        'Content-Length': f.size,
        'Content-Disposition': (dl ? 'attachment' : 'inline') + "; filename*=UTF-8''" + encodeURIComponent(f.name),
      });
      fs.createReadStream(store.filePath(f)).pipe(res);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      const key = req.method + ' ' + url.pathname;
      const route = routes[key];
      if (!route) return fail(res, '接口不存在: ' + key, 404);
      const needsAuth = !(key === 'POST /api/register' || key === 'POST /api/login');
      let user = null;
      if (needsAuth) {
        user = userByToken(req, url);
        if (!user) return fail(res, '登录已失效，请重新登录', 401);
      }
      const body = (req.method === 'POST' || req.method === 'DELETE') ? await readBody(req, 26 * 1024 * 1024) : Buffer.alloc(0);
      await route(req, res, url, body, user);
      return;
    }
    serveStatic(req, res, url);
  } catch (e) {
    console.error('[http]', e);
    if (!res.headersSent) fail(res, e.message || '服务器内部错误', 500);
  }
});

/* ================= WebSocket ================= */
ws.attach(server, (conn) => {
  conn.user = null;
  conn.on('message', (raw) => {
    let pkt;
    try { pkt = JSON.parse(String(raw)); } catch (e) { return; }
    handleWS(conn, pkt);
  });
  conn.on('close', () => {
    if (!conn.user) return;
    presence.remove(conn.user.id, conn);
    if (!presence.isOnline(conn.user.id)) {
      conn.user.lastSeen = Date.now();
      store.save();
      broadcast({ t: 'presence', d: { userId: conn.user.id, online: false, lastSeen: conn.user.lastSeen } });
    }
  });
});

function handleWS(conn, pkt) {
  const { t, d = {} } = pkt;
  if (t === 'hello') {
    const user = db.sessions[d.token] ? store.getUser(db.sessions[d.token].userId) : null;
    if (!user) { conn.sendJSON({ t: 'error', d: { message: '登录失效' } }); conn.close(); return; }
    conn.user = user;
    conn.token = d.token;
    const wasOffline = !presence.isOnline(user.id);
    presence.add(user.id, conn);
    user.lastSeen = Date.now();
    store.save();
    conn.sendJSON({ t: 'ready', d: { user: store.publicUser(user, user.id) } });
    if (wasOffline) broadcast({ t: 'presence', d: { userId: user.id, online: true, lastSeen: user.lastSeen } }, user.id);
    // 上线补发在线名单
    conn.sendJSON({ t: 'presence-list', d: { online: presence.onlineIds() } });
    return;
  }

  const user = conn.user;
  if (!user) { conn.sendJSON({ t: 'error', d: { message: '未认证' } }); return; }

  if (t === 'ping') { conn.sendJSON({ t: 'pong', d: {} }); return; }

  if (t === 'chat') {
    const { conv, type = 'text', text = '', fileId, fileName, fileSize, mime, replyTo, mentions = [], tempId } = d;
    if (!canAccess(user.id, conv)) { conn.sendJSON({ t: 'error', d: { message: '无权在该会话发言' } }); return; }
    if (type === 'text' && !text.trim()) return;
    const msg = store.addMessage({
      conv, from: user.id, type,
      text: String(text).slice(0, 20000),
      fileId: fileId || '', fileName: fileName || '', fileSize: fileSize || 0, mime: mime || '',
      replyTo: replyTo || null, mentions,
    });
    const wire = toWire(msg);
    wire.tempId = tempId || null;
    push(conv, { t: 'msg', d: wire });
    // 被 @ 的人额外强提醒
    if (mentions && mentions.length) {
      push(conv, { t: 'mention', d: { conv, from: user.id, fromName: user.name, mentions, text: String(text).slice(0, 100), msgId: msg.id } });
    }
    return;
  }

  if (t === 'typing') {
    const { conv, on } = d;
    if (!canAccess(user.id, conv)) return;
    push(conv, { t: 'typing', d: { conv, userId: user.id, name: user.name, on: !!on } }, conn);
    return;
  }

  if (t === 'read') {
    const { conv, msgId } = d;
    if (!canAccess(user.id, conv)) return;
    store.markRead(conv, user.id, msgId);
    push(conv, { t: 'read', d: { conv, userId: user.id, msgId: store.lastReadOf(conv, user.id) } }, conn);
    return;
  }

  if (t === 'revoke') {
    try {
      const m = store.revokeMessage(d.conv, d.msgId, user.id);
      push(d.conv, { t: 'revoked', d: { conv: d.conv, msgId: d.msgId } });
    } catch (e) { conn.sendJSON({ t: 'error', d: { message: e.message } }); }
    return;
  }
}

/* ================= 启动 ================= */
function localIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

server.listen(PORT, HOST, () => {
  const ips = localIPs();
  console.log('');
  console.log('  LanTalk 已启动');
  console.log('  ────────────────────────────────────────');
  console.log('  本机访问:   http://localhost:' + PORT);
  ips.forEach((ip) => console.log('  局域网访问: http://' + ip + ':' + PORT));
  console.log('  数据目录:   ' + store.DATA_DIR);
  console.log('  停止服务:   Ctrl+C');
  console.log('');
});

process.on('SIGINT', () => { store.saveNow(); process.exit(0); });
process.on('SIGTERM', () => { store.saveNow(); process.exit(0); });
