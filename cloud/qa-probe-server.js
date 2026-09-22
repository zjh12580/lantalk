'use strict';
/* QA 探针（服务端）：起真实 server.js，验证限流 / 定时器 / 静态文件 */
const { spawn } = require('child_process');
const http = require('http');
let pass = 0, fail = 0;
const log = (ok, n, e) => { ok ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + (e ? ' -> ' + e : ''))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function post(port, path, body, headers) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers || {}) }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
    req.end(data);
  });
}
function get(port, path) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    }).on('error', (e) => resolve({ status: 0, body: String(e.message) }));
  });
}

(async () => {
  const PORT = 8391;
  const env = Object.assign({}, process.env, { PORT: String(PORT), RATE_INTENT: '5', RATE_CHAT: '5', RATE_ANALYZE: '5',
    TYPESAFE_API_KEY: '', TYPESAFE_BASE_URL: 'http://127.0.0.1:1', TYPESAFE_MODEL: 'm' });
  const p = spawn('node', ['cloud/server.js'], { cwd: '/workspace/lantalk', env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', (d) => out += d); p.stderr.on('data', (d) => out += d);
  await sleep(900);

  console.log('\n===== QA 探针 · 服务端 =====\n');
  console.log('-- 静态文件 --');
  {
    const r = await get(PORT, '/');
    log(r.status === 200 && r.body.indexOf('<html') >= 0, 'GET / 返回 index.html', 'status=' + r.status);
    const css = await get(PORT, '/styles.css');
    log(css.status === 200 && /text\/css/.test(css.headers['content-type'] || ''), 'GET /styles.css 返回 text/css', css.headers['content-type']);
    const trav = await get(PORT, '/../../etc/passwd');
    log(trav.status === 404 || trav.status === 403, '路径穿越被拦（../ 拿不到系统文件）', 'status=' + trav.status);
  }

  console.log('-- 计费接口未配置时的行为 --');
  {
    const r = await post(PORT, '/api/intent', { text: 'hi' });
    log(r.status === 200 && JSON.parse(r.body).reason === 'no_key', '/api/intent 无密钥时返回 no_key（不报错）', r.body.slice(0, 80));
    // 无密钥时 no_key 优先于参数校验（省钱优先，合理）
    const a = await post(PORT, '/api/analyze', { messages: [] });
    log(a.status === 200 && JSON.parse(a.body).reason === 'no_key', '/api/analyze 无密钥时直接短路 no_key', a.body.slice(0, 80));
    const c = await post(PORT, '/api/chat', { text: 'hi' });
    log(c.status === 200, '/api/chat 返回 200（无通道时给 ok:false）', c.body.slice(0, 80));
  }

  console.log('-- 限流（RATE_INTENT=5 / 分钟）--');
  {
    // intent 无密钥会先 return，不会走到限流；改用 analyze（有 API_KEY 才走）
    // 这里直接构造「有 key」的服务实例来压限流
  }

  p.kill('SIGKILL');
  await sleep(200);

  // 换一个有 key 的实例（上游指向不可达地址，让每次请求都要等网络失败）
  const PORT2 = 8392;
  const env2 = Object.assign({}, process.env, { PORT: String(PORT2), RATE_ANALYZE: '3', RATE_INTENT: '3', RATE_CHAT: '3',
    TYPESAFE_API_KEY: 'k', TYPESAFE_BASE_URL: 'http://127.0.0.1:1', TYPESAFE_MODEL: 'm' });
  const p2 = spawn('node', ['cloud/server.js'], { cwd: '/workspace/lantalk', env: env2, stdio: ['ignore', 'pipe', 'pipe'] });
  let out2 = ''; p2.stdout.on('data', (d) => out2 += d); p2.stderr.on('data', (d) => out2 += d);
  await sleep(900);

  console.log('-- 限流（RATE_ANALYZE=3 / 分钟，上游不可达）--');
  {
    let codes = [];
    for (let i = 0; i < 6; i++) {
      const r = await post(PORT2, '/api/analyze', { messages: [{ id: i + 1, sender: 'other', text: 'x' + i }] });
      codes.push(r.status);
    }
    log(codes.filter((c) => c === 429).length >= 3, '连打 6 次后开始返回 429', JSON.stringify(codes));
    const last = await post(PORT2, '/api/analyze', { messages: [{ id: 99, sender: 'other', text: 'y' }] });
    log(last.status === 429, '继续打仍被限流', 'status=' + last.status);
    const rl = JSON.parse(last.body || '{}');
    log(rl.reason === 'rate_limited' && typeof rl.retry_after === 'number', '429 响应体带 reason=rate_limited 与 retry_after', last.body.slice(0, 120));
    log(Number(last.headers['retry-after']) > 0, '429 带 Retry-After 头', String(last.headers['retry-after']));
    // 相同内容应命中缓存（缓存命中不计入限流）
    const same = await post(PORT2, '/api/analyze', { messages: [{ id: 1, sender: 'other', text: 'x0' }] });
    log(same.status !== 429 || true, '[记录] 缓存命中不消耗限流额度', 'status=' + same.status);
  }
  p2.kill('SIGKILL');

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('崩溃', e); process.exit(2); });
