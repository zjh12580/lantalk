'use strict';
/**
 * 数据持久化层：单文件 JSON + 原子写入（无需任何数据库依赖）
 * 数据目录默认 ./data ，可用 LANCHAT_DATA 环境变量覆盖。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.LANCHAT_DATA || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const FILES_DIR = path.join(DATA_DIR, 'files');

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });
}

const empty = () => ({
  users: [],        // {id, username, name, passHash, salt, color, signature, createdAt, lastSeen}
  friends: [],      // {id, a, b, status:'pending'|'accepted', from, remark:{uid:name}, createdAt}
  groups: [],       // {id, name, owner, members:[], announcement, color, createdAt, mute:{uid:true}}
  messages: {},     // convKey -> [msg]
  reads: {},        // convKey -> { uid: lastReadMsgId }
  files: {},        // fileId -> {name, size, mime, path, uploader, createdAt}
  seq: 0,
});

let db = empty();
let saveTimer = null;

function load() {
  ensureDirs();
  if (fs.existsSync(DB_FILE)) {
    try {
      db = Object.assign(empty(), JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
    } catch (e) {
      const bak = DB_FILE + '.broken.' + Date.now();
      try { fs.copyFileSync(DB_FILE, bak); } catch (_) {}
      console.error('[store] 数据库损坏，已备份到 ' + bak + '，使用空库启动');
      db = empty();
    }
  } else {
    db = empty();
  }
  return db;
}

function saveNow() {
  ensureDirs();
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; try { saveNow(); } catch (e) { console.error(e); } }, 300);
}

const uid = (p) => p + '_' + crypto.randomBytes(8).toString('hex');
const now = () => Date.now();

/* ---------------- 会话 key ---------------- */
const convKey = {
  private: (a, b) => 'p:' + [a, b].sort().join('~'),
  group: (gid) => 'g:' + gid,
  parse(key) {
    if (key.startsWith('g:')) return { type: 'group', id: key.slice(2) };
    const parts = key.slice(2).split('~');
    return { type: 'private', users: parts };
  },
};

/* ---------------- 用户 ---------------- */
function hashPassword(pw, salt) {
  return crypto.scryptSync(pw, salt, 32).toString('hex');
}
const PALETTE = ['#e8644a', '#f0a03c', '#3ba55d', '#3d8bfd', '#8b5cf6', '#e0518f', '#0aa4a4', '#c0842f'];

function createUser({ username, password, name }) {
  if (db.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    throw new Error('该用户名已被注册');
  }
  const salt = crypto.randomBytes(8).toString('hex');
  const user = {
    id: uid('u'),
    username,
    name: name || username,
    passHash: hashPassword(password, salt),
    salt,
    color: PALETTE[db.users.length % PALETTE.length],
    signature: '',
    createdAt: now(),
    lastSeen: now(),
  };
  db.users.push(user);
  save();
  return user;
}

function verifyUser(username, password) {
  const u = db.users.find((x) => x.username.toLowerCase() === String(username).toLowerCase());
  if (!u) return null;
  return hashPassword(password, u.salt) === u.passHash ? u : null;
}

const getUser = (id) => db.users.find((u) => u.id === id) || null;
const findByName = (q) => db.users.filter((u) => u.username.toLowerCase().includes(String(q).toLowerCase()) || u.name.toLowerCase().includes(String(q).toLowerCase()));

function publicUser(u, viewerId) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, name: u.name, color: u.color,
    signature: u.signature || '', lastSeen: u.lastSeen,
    online: require('./presence').isOnline(u.id),
    remark: getRemark(viewerId, u.id),
  };
}

/* ---------------- 好友 ---------------- */
function getFriendship(a, b) {
  return db.friends.find(
    (f) => (f.a === a && f.b === b) || (f.a === b && f.b === a)
  ) || null;
}
const isFriend = (a, b) => { const f = getFriendship(a, b); return !!f && f.status === 'accepted'; };

function getRemark(ownerId, peerId) {
  const f = getFriendship(ownerId, peerId);
  if (!f || !f.remark) return '';
  return f.remark[ownerId] || '';
}
function setRemark(ownerId, peerId, remark) {
  const f = getFriendship(ownerId, peerId);
  if (!f) return;
  f.remark = f.remark || {};
  if (remark) f.remark[ownerId] = remark; else delete f.remark[ownerId];
  save();
}

function friendIds(userId) {
  return db.friends
    .filter((f) => f.status === 'accepted' && (f.a === userId || f.b === userId))
    .map((f) => (f.a === userId ? f.b : f.a));
}

function pendingRequests(userId) {
  return db.friends
    .filter((f) => f.status === 'pending' && f.b === userId)  // 约定：from=a 发起，b 接收
    .map((f) => ({ id: f.id, from: publicUser(getUser(f.a), userId), message: f.message || '', createdAt: f.createdAt }));
}
function sentRequests(userId) {
  return db.friends
    .filter((f) => f.status === 'pending' && f.a === userId)
    .map((f) => ({ id: f.id, to: publicUser(getUser(f.b), userId), createdAt: f.createdAt }));
}

function addFriendRequest(from, to, message) {
  const exist = getFriendship(from, to);
  if (exist) {
    if (exist.status === 'accepted') throw new Error('你们已经是好友了');
    if (exist.a === from) throw new Error('请求已发送，等待对方确认');
    // 对方曾向我发起请求 -> 直接互加好友
    exist.status = 'accepted';
    save();
    return { accepted: true, friendship: exist };
  }
  const f = { id: uid('f'), a: from, b: to, status: 'pending', message: message || '', remark: {}, createdAt: now() };
  db.friends.push(f);
  save();
  return { accepted: false, friendship: f };
}

function respondFriendRequest(userId, requestId, accept) {
  const f = db.friends.find((x) => x.id === requestId && x.b === userId && x.status === 'pending');
  if (!f) throw new Error('请求不存在');
  if (accept) { f.status = 'accepted'; f.acceptedAt = now(); }
  else db.friends.splice(db.friends.indexOf(f), 1);
  save();
  return f;
}

function removeFriend(userId, peerId) {
  const f = getFriendship(userId, peerId);
  if (f) { db.friends.splice(db.friends.indexOf(f), 1); save(); }
}

/* ---------------- 群组 ---------------- */
function createGroup({ name, owner, members }) {
  const g = {
    id: uid('g'),
    name: name || '未命名群聊',
    owner,
    members: Array.from(new Set([owner, ...(members || [])])),
    announcement: '',
    color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
    mute: {},
    createdAt: now(),
  };
  db.groups.push(g);
  save();
  return g;
}
const getGroup = (id) => db.groups.find((g) => g.id === id) || null;
const groupsOf = (userId) => db.groups.filter((g) => g.members.includes(userId));

function addGroupMembers(groupId, userIds) {
  const g = getGroup(groupId);
  if (!g) throw new Error('群聊不存在');
  let added = 0;
  for (const id of userIds) {
    if (!g.members.includes(id)) { g.members.push(id); added++; }
  }
  save();
  return added;
}
function removeGroupMember(groupId, userId) {
  const g = getGroup(groupId);
  if (!g) throw new Error('群聊不存在');
  const i = g.members.indexOf(userId);
  if (i >= 0) g.members.splice(i, 1);
  save();
}
function setGroupMuted(groupId, userId, muted) {
  const g = getGroup(groupId);
  if (!g) return;
  g.mute = g.mute || {};
  if (muted) g.mute[userId] = true; else delete g.mute[userId];
  save();
}
const isMuted = (groupId, userId) => !!(getGroup(groupId) || { mute: {} }).mute?.[userId];

/* ---------------- 消息 ---------------- */
function addMessage(msg) {
  const list = db.messages[msg.conv] || (db.messages[msg.conv] = []);
  msg.id = msg.id || uid('m');
  msg.seq = ++db.seq;
  msg.createdAt = msg.createdAt || now();
  list.push(msg);
  // 每个会话最多保留 5000 条，防止无限膨胀
  if (list.length > 5000) db.messages[msg.conv] = list.slice(list.length - 5000);
  save();
  return msg;
}

function history(conv, { before, limit = 30 } = {}) {
  const list = db.messages[conv] || [];
  let res = list;
  if (before) {
    const idx = list.findIndex((m) => m.id === before);
    res = idx > 0 ? list.slice(0, idx) : [];
  }
  return res.slice(Math.max(0, res.length - limit));
}

function lastMessage(conv) {
  const list = db.messages[conv];
  return list && list.length ? list[list.length - 1] : null;
}

function revokeMessage(conv, msgId, userId) {
  const list = db.messages[conv] || [];
  const m = list.find((x) => x.id === msgId);
  if (!m) throw new Error('消息不存在');
  if (m.from !== userId) throw new Error('只能撤回自己的消息');
  if (now() - m.createdAt > 2 * 60 * 1000) throw new Error('超过 2 分钟的消息无法撤回');
  m.revoked = true;
  m.text = '';
  save();
  return m;
}

function searchMessages(userId, keyword, convs) {
  const kw = String(keyword || '').toLowerCase();
  if (!kw) return [];
  const out = [];
  for (const conv of convs) {
    for (const m of db.messages[conv] || []) {
      if (m.type === 'text' && m.text && m.text.toLowerCase().includes(kw) && !m.revoked) {
        out.push({ conv, ...m });
      }
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
}

/* ---------------- 已读 ---------------- */
function markRead(conv, userId, msgId) {
  db.reads[conv] = db.reads[conv] || {};
  const prev = db.reads[conv][userId];
  if (!prev || (msgId && msgId > prev)) {
    db.reads[conv][userId] = msgId || lastMessage(conv)?.id || '';
    save();
  }
}
function unreadCount(conv, userId) {
  const list = db.messages[conv] || [];
  const lastRead = db.reads[conv]?.[userId];
  if (!list.length) return 0;
  if (!lastRead) {
    // 从未读过：只统计别人发的
    return list.filter((m) => m.from !== userId && !m.revoked).length;
  }
  const idx = list.findIndex((m) => m.id === lastRead);
  const start = idx >= 0 ? idx + 1 : 0;
  return list.slice(start).filter((m) => m.from !== userId && !m.revoked).length;
}
const lastReadOf = (conv, userId) => db.reads[conv]?.[userId] || '';

/* ---------------- 文件 ---------------- */
function saveFile({ name, size, mime, data, uploader }) {
  const id = uid('file');
  const safe = path.basename(name || 'file').replace(/[\\/:*?"<>|]/g, '_');
  const rel = id + '_' + safe;
  fs.writeFileSync(path.join(FILES_DIR, rel), data);
  db.files[id] = { id, name: safe, size, mime: mime || 'application/octet-stream', rel, uploader, createdAt: now() };
  save();
  return db.files[id];
}
const getFile = (id) => db.files[id] || null;
const filePath = (f) => path.join(FILES_DIR, f.rel);

module.exports = {
  DATA_DIR, FILES_DIR, load, save, saveNow,
  db: () => db,
  convKey, uid, now,
  createUser, verifyUser, getUser, findByName, publicUser,
  getFriendship, isFriend, friendIds, pendingRequests, sentRequests, addFriendRequest,
  respondFriendRequest, removeFriend, setRemark, getRemark,
  createGroup, getGroup, groupsOf, addGroupMembers, removeGroupMember, setGroupMuted, isMuted,
  addMessage, history, lastMessage, revokeMessage, searchMessages,
  markRead, unreadCount, lastReadOf,
  saveFile, getFile, filePath,
};
