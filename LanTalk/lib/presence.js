'use strict';
/** 在线状态：一个用户可能开多个标签页/设备，用 Set 记录连接 */
const sockets = new Map(); // userId -> Set<conn>

function add(userId, conn) {
  if (!sockets.has(userId)) sockets.set(userId, new Set());
  sockets.get(userId).add(conn);
}
function remove(userId, conn) {
  const set = sockets.get(userId);
  if (!set) return;
  set.delete(conn);
  if (!set.size) sockets.delete(userId);
}
const isOnline = (userId) => sockets.has(userId) && sockets.get(userId).size > 0;
const list = (userId) => Array.from(sockets.get(userId) || []);
const onlineIds = () => Array.from(sockets.keys());
const count = () => sockets.size;

module.exports = { add, remove, isOnline, list, onlineIds, count };
