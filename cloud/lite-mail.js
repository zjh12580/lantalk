/* ============================================================================
 * lite-mail.js —— 极简 SMTP 发信（零第三方依赖）
 * ----------------------------------------------------------------------------
 * 只做一件事：把 6 位验证码/重置码发到用户邮箱。
 * 之所以不用 nodemailer：这台机器没有 root，装包要联网 + 占空间，
 * 而 SMTP 的 AUTH LOGIN 流程本身很短，自己实现约 120 行、只依赖 Node 内置 tls/net。
 *
 * 支持两种常见端口：
 *   465 —— 直连 SSL（tls.connect）
 *   587 —— 明文连接后 STARTTLS 升级
 * ==========================================================================*/
'use strict';

const net = require('net');
const tls = require('tls');

function readLine(socket) {
  // SMTP 响应可能是多行（250-xxx 续行），这里按「一行一读」的粒度交给调用方判断
  return new Promise((resolve, reject) => {
    const onData = (chunk) => { cleanup(); resolve(chunk); };
    const onErr = (e) => { cleanup(); reject(e); };
    const onEnd = () => { cleanup(); reject(new Error('smtp_closed')); };
    const to = setTimeout(() => { cleanup(); reject(new Error('smtp_timeout')); }, 15000);
    function cleanup() {
      clearTimeout(to);
      socket.removeListener('data', onData);
      socket.removeListener('error', onErr);
      socket.removeListener('end', onEnd);
      socket.removeListener('close', onEnd);
    }
    socket.on('data', onData);
    socket.on('error', onErr);
    socket.on('end', onEnd);
    socket.on('close', onEnd);
  });
}

function cmd(socket, line) {
  socket.write(line + '\r\n');
  return readLine(socket).then((buf) => String(buf || ''));
}

function expect(resp, codes) {
  const lines = String(resp).split(/\r?\n/).filter(Boolean);
  const last = lines.length ? lines[lines.length - 1] : '';
  const code = parseInt(last.slice(0, 3), 10);
  if (codes.indexOf(code) >= 0) return { code, lines };
  throw new Error('smtp_unexpected: ' + last.trim());
}

function b64(s) { return Buffer.from(String(s), 'utf8').toString('base64'); }
function mimeSubject(s) { return '=?UTF-8?B?' + Buffer.from(String(s), 'utf8').toString('base64') + '?='; }

function handshake(socket, opt) {
  return cmd(socket, 'EHLO lantalk').then((r) => {
    const info = expect(r, [250]);
    const txt = info.lines.join('|').toUpperCase();
    // 465 直连 SSL 不需要再 STARTTLS；587 需要
    if (opt.starttls && txt.indexOf('STARTTLS') >= 0) {
      return cmd(socket, 'STARTTLS').then((r2) => {
        expect(r2, [220]);
        const secure = tls.connect({ socket, rejectUnauthorized: false });
        return new Promise((resolve, reject) => {
          secure.once('secureConnect', () => resolve(secure));
          secure.once('error', reject);
        });
      });
    }
    return socket;
  });
}

function authenticate(socket, opt) {
  return cmd(socket, 'AUTH LOGIN').then((r) => {
    expect(r, [334]);
    return cmd(socket, b64(opt.user));
  }).then((r) => {
    expect(r, [334]);
    return cmd(socket, b64(opt.pass));
  }).then((r) => {
    expect(r, [235]);
    return socket;
  });
}

function send(socket, opt) {
  return cmd(socket, 'MAIL FROM:<' + opt.from + '>').then((r) => {
    expect(r, [250]);
    return cmd(socket, 'RCPT TO:<' + opt.to + '>');
  }).then((r) => {
    expect(r, [250, 251]);
    return cmd(socket, 'DATA');
  }).then((r) => {
    expect(r, [354]);
    const body = [
      'From: ' + opt.fromName + ' <' + opt.from + '>',
      'To: <' + opt.to + '>',
      'Subject: ' + mimeSubject(opt.subject),
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(String(opt.text), 'utf8').toString('base64'),
      '.',
    ].join('\r\n');
    socket.write(body + '\r\n');
    return readLine(socket);
  }).then((r) => {
    expect(String(r), [250]);
    try { socket.write('QUIT\r\n'); } catch (e) { /* 已关闭就算了 */ }
    return true;
  });
}

/**
 * 发一封纯文本邮件。
 * opt = { host, port, secure, user, pass, from, fromName, to, subject, text }
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
function sendMail(opt) {
  const port = Number(opt.port || 465);
  const useSSL = port === 465 || opt.secure === true;
  const starttls = !useSSL;
  return new Promise((resolve) => {
    const done = (r) => resolve(r);
    const fail = (e) => done({ ok: false, error: String(e && e.message || e) });

    const onConn = (socket) => {
      let s = socket;
      socket.once('error', fail);
      // 服务器会先发 220 欢迎语
      readLine(socket).then((greet) => {
        expect(String(greet), [220]);
        return handshake(s, { starttls });
      }).then((sec) => {
        s = sec;
        s.once('error', fail);
        if (starttls) return readLine(s).then((r) => { expect(String(r), [250]); return cmd(s, 'EHLO lantalk'); }).then(() => s);
        return s;
      }).then((sec) => authenticate(sec, opt))
        .then((sec) => send(sec, opt))
        .then(() => done({ ok: true }))
        .catch(fail)
        .finally(() => { try { s.destroy(); } catch (e) { /* noop */ } });
    };

    try {
      const socket = useSSL
        ? tls.connect({ host: opt.host, port, rejectUnauthorized: false, servername: opt.host }, onConn)
        : net.connect({ host: opt.host, port }, onConn);
      socket.setTimeout(20000, () => { try { socket.destroy(); } catch (e) { /* noop */ } fail(new Error('smtp_timeout')); });
      if (useSSL) socket.once('secureConnect', () => onConn(socket));
    } catch (e) { fail(e); }
  });
}

module.exports = { sendMail };
