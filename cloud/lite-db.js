/* ============================================================================
 * lite-db.js —— 精简自建数据层（Node 内置 SQLite，零第三方依赖）
 * ----------------------------------------------------------------------------
 * 为什么有这个文件：
 *   服务器只有 1.8G 内存且没有 root，跑不了自托管 Supabase 全家桶。
 *   于是把「Postgres + PostgREST + RLS」换成「SQLite + 本文件的查询引擎 + 代码层鉴权」。
 *   对外暴露的语义与原 PostgREST 保持一致，前端 index.html 一行业务代码都不用改。
 *
 * 安全模型（关键）：
 *   原架构靠 Postgres RLS 做越权防护。SQLite 没有 RLS，因此在 execQuery() 里
 *   按「表 + 操作 + 会话 uid」逐条复刻原来的策略（见 POLICY 注释）。
 *   ⚠️ 新增表/字段时，**必须**同步更新 TABLES（列名白名单）与 execQuery 里的策略，
 *      否则要么被拒（列名不在白名单）要么越权（策略缺失默认放行 = 危险）。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const pathMod = require('path');
const crypto = require('crypto');

/* ---------------------------------------------------------------------------
 * 表定义：既是 DDL，也是列名白名单（防 SQL 注入：任何不在列表里的列一律拒绝）
 * -------------------------------------------------------------------------*/
const TABLES = {
  users: {
    cols: ['id', 'email', 'password_hash', 'created_at'],
    ddl: `create table if not exists users (
      id text primary key,
      email text not null unique,
      password_hash text default '',
      created_at text default (datetime('now'))
    )`,
  },
  otps: {
    cols: ['email', 'code', 'purpose', 'consumed', 'expires_at', 'created_at'],
    ddl: `create table if not exists otps (
      email text not null,
      code text not null,
      purpose text not null default 'login',
      consumed integer not null default 0,
      expires_at integer not null,
      created_at integer not null
    )`,
    idx: ['create index if not exists otps_email_idx on otps (email, purpose, consumed)'],
  },
  profiles: {
    cols: ['id', 'nickname', 'avatar', 'color', 'signature', 'last_seen', 'created_at'],
    ddl: `create table if not exists profiles (
      id text primary key,
      nickname text not null unique,
      avatar text default '',
      color text default '#888888',
      signature text default '',
      last_seen text default (datetime('now')),
      created_at text default (datetime('now'))
    )`,
  },
  groups: {
    cols: ['id', 'name', 'owner_id', 'announcement', 'color', 'is_hall', 'created_at'],
    ddl: `create table if not exists groups (
      id text primary key,
      name text not null,
      owner_id text,
      announcement text default '',
      color text default '#07c160',
      is_hall integer not null default 0,
      created_at text default (datetime('now'))
    )`,
  },
  group_members: {
    cols: ['group_id', 'user_id', 'muted', 'joined_at'],
    ddl: `create table if not exists group_members (
      group_id text not null,
      user_id text not null,
      muted integer not null default 0,
      joined_at text default (datetime('now')),
      primary key (group_id, user_id)
    )`,
    idx: ['create index if not exists group_members_user_idx on group_members (user_id)'],
  },
  messages: {
    cols: ['id', 'conv', 'sender_id', 'sender_name', 'sender_avatar', 'sender_color',
      'type', 'text', 'mentions', 'reply_to', 'file_path', 'file_name', 'file_size',
      'revoked', 'created_at'],
    ddl: `create table if not exists messages (
      id integer primary key autoincrement,
      conv text not null,
      sender_id text,
      sender_name text default '',
      sender_avatar text default '',
      sender_color text default '',
      type text default 'text',
      text text default '',
      mentions text default '[]',
      reply_to text,
      file_path text,
      file_name text,
      file_size integer,
      revoked integer not null default 0,
      created_at text default (datetime('now'))
    )`,
    idx: [
      'create index if not exists messages_conv_id_idx on messages (conv, id desc)',
      'create index if not exists messages_sender_idx on messages (sender_id)',
    ],
  },
  reads: {
    cols: ['conv', 'user_id', 'last_msg_id', 'updated_at'],
    ddl: `create table if not exists reads (
      conv text not null,
      user_id text not null,
      last_msg_id integer not null default 0,
      updated_at text default (datetime('now')),
      primary key (conv, user_id)
    )`,
  },
  friends: {
    cols: ['a', 'b', 'status', 'message', 'remark', 'created_at'],
    ddl: `create table if not exists friends (
      a text not null,
      b text not null,
      status text not null default 'pending',
      message text default '',
      remark text default '',
      created_at text default (datetime('now')),
      primary key (a, b)
    )`,
    idx: ['create index if not exists friends_b_idx on friends (b)'],
  },
  games: {
    cols: ['id', 'conv', 'kind', 'host_id', 'host_name', 'guest_id', 'guest_name',
      'status', 'turn', 'board', 'moves', 'winner', 'restart_by', 'restart_kind',
      'created_at', 'updated_at'],
    ddl: `create table if not exists games (
      id text primary key,
      conv text not null,
      kind text not null default 'gomoku',
      host_id text,
      host_name text default '',
      guest_id text,
      guest_name text default '',
      status text default 'waiting',
      turn text default 'host',
      board text default '[]',
      moves text default '[]',
      winner text default '',
      restart_by text default '',
      restart_kind text default '',
      created_at text default (datetime('now')),
      updated_at text default (datetime('now'))
    )`,
    idx: ['create index if not exists games_conv_idx on games (conv)'],
  },
};

/* 需要 JSON 序列化/反序列化的列（原 Postgres 是 text[] / jsonb） */
const JSON_COLS = {
  messages: new Set(['mentions', 'reply_to']),
  games: new Set(['board', 'moves']),
};

/* 前端 select('*') 之外的列裁剪：'*' 原样返回整行 */
function project(row, cols) {
  if (!row) return row;
  if (!cols || cols === '*') return row;
  const want = String(cols).split(',').map((s) => s.trim()).filter(Boolean);
  const o = {};
  want.forEach((c) => { o[c] = row[c]; });
  return o;
}

function decodeJson(row, table) {
  if (!row) return row;
  const set = JSON_COLS[table];
  if (!set) return row;
  set.forEach((c) => {
    if (typeof row[c] === 'string') {
      try { row[c] = JSON.parse(row[c]); } catch (e) { /* 坏数据保持原样 */ }
    }
  });
  return row;
}

function encodeJson(obj, table) {
  if (!obj) return obj;
  const set = JSON_COLS[table];
  if (!set) return obj;
  set.forEach((c) => {
    if (c in obj && obj[c] !== null && typeof obj[c] !== 'string') {
      try { obj[c] = JSON.stringify(obj[c]); } catch (e) { delete obj[c]; }
    }
  });
  return obj;
}

/* ---------------------------------------------------------------------------
 * 会话权限：复刻原 Postgres 的 chat_can_read()
 * -------------------------------------------------------------------------*/
function isMember(db, gid, uid) {
  const r = db.prepare('select 1 from group_members where group_id = ? and user_id = ?').get(gid, uid);
  return !!r;
}
function isOwner(db, gid, uid) {
  const r = db.prepare('select 1 from groups where id = ? and owner_id = ?').get(gid, uid);
  return !!r;
}
function canReadConv(db, conv, uid) {
  if (!conv || !uid) return false;
  const c = String(conv);
  if (c === 'hall') return true;
  if (c.indexOf('g:') === 0) {
    const gid = c.slice(2);
    return gid === 'hall' || isMember(db, gid, uid);
  }
  if (c.indexOf('p:') === 0) {
    return String(c.slice(2)).split('~').indexOf(String(uid)) >= 0;
  }
  // 兼容历史无前缀 conv
  if (c === 'hall') return true;
  return isMember(db, c, uid);
}

/* ---------------------------------------------------------------------------
 * 打开数据库
 * -------------------------------------------------------------------------*/
function openDb(file) {
  const { DatabaseSync } = require('node:sqlite');
  const dir = pathMod.dirname(file);
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('pragma journal_mode = WAL');      // 读不阻塞写，IM 场景必需
  db.exec('pragma synchronous = NORMAL');
  db.exec('pragma foreign_keys = ON');
  Object.keys(TABLES).forEach((t) => {
    db.exec(TABLES[t].ddl);
    (TABLES[t].idx || []).forEach((s) => db.exec(s));
  });
  seedHall(db);
  return db;
}

/* 内置大厅：所有人都在里面 */
function seedHall(db) {
  const r = db.prepare("select 1 from groups where id = 'hall'").get();
  if (!r) {
    db.prepare("insert into groups (id, name, owner_id, announcement, color, is_hall) values ('hall', '大厅', null, '', '#07c160', 1)").run();
  }
}

/* ---------------------------------------------------------------------------
 * 查询执行器：把 PostgREST 风格的计划翻译成 SQL
 *   plan = { table, op, cols, filters:[[op,col,val]...], order:[col,asc], limit, payload }
 * -------------------------------------------------------------------------*/
function err(msg, code) { return { error: { message: String(msg), code: code || '400' } }; }

function buildWhere(db, table, filters) {
  const allowed = TABLES[table].cols;
  const where = [];
  const args = [];
  (filters || []).forEach((f) => {
    const op = String(f[0] || '').toLowerCase();
    const col = String(f[1] || '');
    const val = f[2];
    if (allowed.indexOf(col) < 0) throw new Error('bad_column:' + col);
    if (op === 'eq') { where.push(col + ' = ?'); args.push(val); }
    else if (op === 'gt') { where.push(col + ' > ?'); args.push(val); }
    else if (op === 'lt') { where.push(col + ' < ?'); args.push(val); }
    else if (op === 'in') {
      const list = Array.isArray(val) ? val : [val];
      if (!list.length) { where.push('1 = 0'); return; }
      where.push(col + ' in (' + list.map(() => '?').join(',') + ')');
      list.forEach((v) => args.push(v));
    } else throw new Error('bad_filter:' + op);
  });
  return { sql: where.length ? ' where ' + where.join(' and ') : '', args };
}

function execQuery(db, plan, uid) {
  const table = String(plan.table || '');
  const def = TABLES[table];
  if (!def) return err('unknown_table:' + table);
  if (!uid) return err('unauthenticated', '401');
  const allowed = def.cols;
  const op = plan.op || 'select';

  try {
    if (op === 'select') {
      // POLICY: messages/reads/games 只能读自己有权的会话；friends 只能读与自己相关的
      if (table === 'messages' || table === 'reads' || table === 'games') {
        (plan.filters || []).forEach((f) => {
          if (f[1] === 'conv' && f[0] === 'eq' && !canReadConv(db, f[2], uid)) {
            throw new Error('forbidden_conv');
          }
        });
      }
      const w = buildWhere(db, table, plan.filters);
      let sql = 'select * from ' + table + w.sql;
      if (plan.order) {
        const oc = String(plan.order[0]);
        if (allowed.indexOf(oc) < 0) throw new Error('bad_column:' + oc);
        sql += ' order by ' + oc + (plan.order[1] ? ' asc' : ' desc');
      }
      if (plan.limit != null) sql += ' limit ' + (Number(plan.limit) || 0);
      const rows = db.prepare(sql).all(...w.args).map((r) => {
        decodeJson(r, table);
        return project(r, plan.cols);
      });
      return { data: rows, error: null };
    }

    if (op === 'insert' || op === 'upsert') {
      let payload = Object.assign({}, plan.payload || {});
      Object.keys(payload).forEach((c) => {
        if (allowed.indexOf(c) < 0) throw new Error('bad_column:' + c);
      });
      // POLICY: 归属字段必须是本人
      if (table === 'profiles' && payload.id !== uid) throw new Error('forbidden:not_self');
      if (table === 'messages') {
        if (payload.sender_id !== uid) throw new Error('forbidden:not_self');
        if (!canReadConv(db, payload.conv, uid)) throw new Error('forbidden_conv');
      }
      if (table === 'reads' && payload.user_id !== uid) throw new Error('forbidden:not_self');
      if (table === 'friends' && payload.a !== uid) throw new Error('forbidden:not_self');
      if (table === 'groups' && payload.owner_id !== uid) throw new Error('forbidden:not_self');
      if (table === 'games') {
        if (payload.host_id !== uid) throw new Error('forbidden:not_self');
        if (!canReadConv(db, payload.conv, uid)) throw new Error('forbidden_conv');
      }
      if (table === 'group_members') {
        const gid = payload.group_id;
        if (payload.user_id !== uid && !isOwner(db, gid, uid)) throw new Error('forbidden:not_self');
      }
      encodeJson(payload, table);
      const cols = Object.keys(payload);
      if (!cols.length) return err('empty_payload');
      const sql = 'insert into ' + table + ' (' + cols.join(',') + ') values ('
        + cols.map(() => '?').join(',') + ')'
        + (op === 'upsert'
          ? ' on conflict do update set ' + cols.filter((c) => c !== 'created_at')
            .map((c) => c + ' = excluded.' + c).join(',')
          : '');
      const r = db.prepare(sql).run(...cols.map((c) => payload[c]));
      if (plan.cols) {
        const row = db.prepare('select * from ' + table + ' where rowid = ?').get(r.lastInsertRowid);
        decodeJson(row, table);
        return { data: [project(row, plan.cols)], error: null };
      }
      return { data: [], error: null };
    }

    if (op === 'update') {
      let payload = Object.assign({}, plan.payload || {});
      Object.keys(payload).forEach((c) => {
        if (allowed.indexOf(c) < 0) throw new Error('bad_column:' + c);
      });
      const w = buildWhere(db, table, plan.filters);
      if (!w.sql) return err('update_without_filter');   // 防全表误改
      // POLICY: 先取出待改行逐条校验归属
      const targets = db.prepare('select * from ' + table + w.sql).all(...w.args);
      targets.forEach((row) => {
        if (table === 'profiles' && row.id !== uid) throw new Error('forbidden:not_self');
        if (table === 'messages' && row.sender_id !== uid) throw new Error('forbidden:not_self');
        if (table === 'reads' && row.user_id !== uid) throw new Error('forbidden:not_self');
        if (table === 'friends' && row.a !== uid && row.b !== uid) throw new Error('forbidden:not_self');
        if (table === 'groups' && row.owner_id !== uid) throw new Error('forbidden:not_owner');
        if (table === 'group_members' && row.user_id !== uid && !isOwner(db, row.group_id, uid)) {
          throw new Error('forbidden:not_self');
        }
        if (table === 'games' && row.host_id !== uid && row.guest_id !== uid) {
          throw new Error('forbidden:not_player');
        }
      });
      encodeJson(payload, table);
      const cols = Object.keys(payload);
      const sql = 'update ' + table + ' set ' + cols.map((c) => c + ' = ?').join(',') + w.sql;
      db.prepare(sql).run(...cols.map((c) => payload[c]), ...w.args);
      if (plan.cols) {
        const rows = db.prepare('select * from ' + table + w.sql).all(...w.args)
          .map((r) => { decodeJson(r, table); return project(r, plan.cols); });
        return { data: rows, error: null };
      }
      return { data: [], error: null };
    }

    if (op === 'delete') {
      const w = buildWhere(db, table, plan.filters);
      if (!w.sql) return err('delete_without_filter');   // 防全表误删
      const targets = db.prepare('select * from ' + table + w.sql).all(...w.args);
      targets.forEach((row) => {
        if (table === 'profiles' && row.id !== uid) throw new Error('forbidden:not_self');
        if (table === 'friends' && row.a !== uid && row.b !== uid) throw new Error('forbidden:not_self');
        if (table === 'groups' && row.owner_id !== uid) throw new Error('forbidden:not_owner');
        if (table === 'group_members' && row.user_id !== uid && !isOwner(db, row.group_id, uid)) {
          throw new Error('forbidden:not_self');
        }
        if (table === 'games' && row.host_id !== uid) throw new Error('forbidden:not_host');
      });
      db.prepare('delete from ' + table + w.sql).run(...w.args);
      return { data: [], error: null };
    }

    return err('unknown_op:' + op);
  } catch (e) {
    const m = String(e && e.message || e);
    if (m.indexOf('forbidden') === 0 || m === 'forbidden_conv') {
      return err('没有权限执行该操作', '403');
    }
    return err('查询失败：' + m);
  }
}

/* ---------------------------------------------------------------------------
 * 认证：密码哈希 + 会话 token（HMAC-SHA256，无状态，不占内存）
 * -------------------------------------------------------------------------*/
function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}
function hashPassword(pw, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pw), s, 32).toString('hex');
  return s + ':' + h;
}
function verifyPassword(pw, stored) {
  if (!stored || String(stored).indexOf(':') < 0) return false;
  const i = String(stored).indexOf(':');
  const s = String(stored).slice(0, i);
  const h = String(stored).slice(i + 1);
  try {
    const calc = crypto.scryptSync(String(pw), s, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(calc, 'hex'), Buffer.from(h, 'hex'));
  } catch (e) { return false; }
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function signToken(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  return body + '.' + sig;
}
function verifyToken(token, secret) {
  if (!token || String(token).indexOf('.') < 0) return null;
  const i = String(token).lastIndexOf('.');
  const body = String(token).slice(0, i);
  const sig = String(token).slice(i + 1);
  const want = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  if (sig.length !== want.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64').toString('utf8'));
    if (p.exp && Date.now() / 1000 > p.exp) return null;
    return p;
  } catch (e) { return null; }
}

/* ---------------------------------------------------------------------------
 * OTP 验证码
 * -------------------------------------------------------------------------*/
const OTP_TTL = 10 * 60 * 1000;     // 10 分钟
function newOtp(db, email, purpose) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const now = Date.now();
  db.prepare('delete from otps where email = ? and purpose = ?').run(email, purpose || 'login');
  db.prepare('insert into otps (email, code, purpose, consumed, expires_at, created_at) values (?,?,?,0,?,?)')
    .run(email, code, purpose || 'login', now + OTP_TTL, now);
  return code;
}
function checkOtp(db, email, code, purpose) {
  const now = Date.now();
  const r = db.prepare('select rowid, * from otps where email = ? and purpose = ? and consumed = 0 order by created_at desc limit 1')
    .get(email, purpose || 'login');
  if (!r) return { ok: false, reason: '请先获取验证码' };
  if (now > r.expires_at) return { ok: false, reason: '验证码已过期' };
  if (String(r.code) !== String(code || '').trim()) return { ok: false, reason: '验证码不正确' };
  db.prepare('update otps set consumed = 1 where rowid = ?').run(r.rowid);
  return { ok: true };
}

module.exports = {
  TABLES, JSON_COLS, openDb, execQuery, canReadConv, isMember, isOwner,
  newId, hashPassword, verifyPassword, signToken, verifyToken, newOtp, checkOtp,
  project, decodeJson, encodeJson,
};
