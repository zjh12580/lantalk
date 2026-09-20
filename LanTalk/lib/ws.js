'use strict';
/**
 * 零依赖 WebSocket (RFC 6455) 实现 —— 仅服务端
 * 只依赖 Node 内置模块，避免在内网/离线 Linux 机器上 npm install。
 */
const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 完成握手，返回 true 表示成功接管该 socket */
function handshake(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) return false;
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  return true;
}

class WSConn {
  constructor(socket, opts = {}) {
    this.socket = socket;
    this.maxPayload = opts.maxPayload || 32 * 1024 * 1024; // 32MB，够传 20MB 文件(base64)
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragOpcode = 0;
    this.closed = false;
    this.remoteAddress = socket.remoteAddress;

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._emitClose());
    socket.on('error', () => this._emitClose());
    socket.on('timeout', () => this.close());
  }

  on(event, fn) {
    if (event === 'message') this.onmessage = fn;
    else if (event === 'close') this.onclose = fn;
    else if (event === 'error') this.onerror = fn;
  }

  _emitClose() {
    if (this.closed) return;
    this.closed = true;
    if (this.onclose) this.onclose();
  }

  _onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    // 循环中尽可能解析出完整帧
    while (true) {
      const consumed = this._parseFrame();
      if (!consumed) break;
    }
  }

  _parseFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return false;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (buf.length < offset + 2) return false;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return false;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(this.maxPayload)) { this.close(); return false; }
      len = Number(big);
      offset += 8;
    }
    if (len > this.maxPayload) { this.close(); return false; }

    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return false;
      maskKey = buf.slice(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return false; // 帧未完整到达

    const payload = Buffer.from(buf.slice(offset, offset + len));
    if (maskKey) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
    }
    this.buffer = buf.slice(offset + len);

    switch (opcode) {
      case 0x0: // continuation
        this.fragments.push(payload);
        if (fin) this._deliver(this.fragOpcode, Buffer.concat(this.fragments));
        break;
      case 0x1: // text
      case 0x2: // binary
        if (fin) {
          this._deliver(opcode, payload);
        } else {
          this.fragOpcode = opcode;
          this.fragments = [payload];
        }
        break;
      case 0x8: // close
        this.close();
        return false;
      case 0x9: // ping
        this._writeFrame(0xA, payload);
        break;
      case 0xA: // pong
        break;
      default:
        this.close();
        return false;
    }
    return true;
  }

  _deliver(opcode, payload) {
    this.fragments = [];
    if (!this.onmessage) return;
    if (opcode === 0x1) this.onmessage(payload.toString('utf8'));
    else this.onmessage(payload);
  }

  _writeFrame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode; // FIN + opcode，服务端不掩码
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch (e) {
      this.close();
    }
  }

  send(data) {
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    this._writeFrame(0x1, payload);
  }

  sendJSON(obj) {
    this.send(JSON.stringify(obj));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.write(Buffer.from([0x88, 0x00])); // close frame
      this.socket.destroy();
    } catch (e) { /* ignore */ }
    if (this.onclose) this.onclose();
  }
}

/** 绑定 http server 的 upgrade 事件 */
function attach(server, onConnection) {
  server.on('upgrade', (req, socket, head) => {
    const upgrade = (req.headers.upgrade || '').toLowerCase();
    if (upgrade !== 'websocket') { socket.destroy(); return; }
    if (!handshake(req, socket)) { socket.destroy(); return; }
    const conn = new WSConn(socket);
    if (head && head.length) conn._onData(head);
    onConnection(conn, req);
  });
}

module.exports = { attach, WSConn };
