/**
 * 意图路由端到端测试（不需要真实 TypeSafe 密钥）
 * 启动本地 mock 冒充 api.typesafe.ai，再启动 cloud/server.js 指向它，
 * 验证：能力探测 / 中文意图映射 / 置信度合成 / 缓存 / 上游故障降级。
 *
 * 运行：node cloud/test-intent.js
 */
'use strict';
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
const log = (ok, name, extra) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- mock TypeSafe ---------- */
const seen = [];
let mockMode = 'ok';
function mockAnswer(payload) {
  const text = JSON.stringify(payload && payload.state || '');
  let intent = 'chitchat', kind = 'none', crypto = 'none', hasAsset = 0.05, intentConf = 0.9, kindConf = 0.9, coinProb = 0;
  if (/btc|比特币|大饼/i.test(text)) { intent = 'crypto_quote'; kind = 'crypto'; crypto = 'bitcoin'; hasAsset = 0.97; coinProb = 0.95; }
  else if (/eth|以太/i.test(text)) { intent = 'crypto_quote'; kind = 'crypto'; crypto = 'ethereum'; hasAsset = 0.96; coinProb = 0.93; }
  else if (/茅台|腾讯|600519|股价|股票/i.test(text)) { intent = 'stock_quote'; kind = 'stock'; hasAsset = 0.92; }
  else if (/天气/.test(text)) { intent = 'weather'; kind = 'none'; hasAsset = 0.1; }
  else if (/有什么功能|怎么用/.test(text)) { intent = 'help'; kind = 'none'; hasAsset = 0.05; }
  return {
    model: 'jev-1.13.0',
    answers: {
      intent: { type: 'choice', choice: intent, probabilities: { [intent]: intentConf, chitchat: 1 - intentConf }, confidence: intentConf },
      has_asset: { type: 'noul', noul: hasAsset },
      asset_kind: { type: 'choice', choice: kind, probabilities: { [kind]: kindConf, none: 1 - kindConf }, confidence: kindConf },
      crypto_asset: { type: 'choice', choice: crypto, probabilities: { [crypto]: coinProb, none: 1 - coinProb }, confidence: Math.max(coinProb, 1 - coinProb) },
    },
    usage: { input_tokens: 320, output_tokens: 24 },
  };
}

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (mockMode === 'down') { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"detail":"boom"}'); }
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch (e) {}
    seen.push({ auth: req.headers.authorization || '', payload });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(mockAnswer(payload)));
  });
});

function postJSON(port, pathname, obj) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(obj));
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json: j, raw: b }); });
    });
    req.on('error', reject);
    req.end(data);
  });
}
function getJSON(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json: j, raw: b }); });
    }).on('error', reject);
  });
}

(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockPort = mock.address().port;
  const serverPath = path.join(__dirname, 'server.js');

  console.log('\n=== 云端意图路由（server.js + mock TypeSafe）===');

  // 场景 1：未配置密钥 → 能力声明为关闭（前端保持原行为）
  const OFF_PORT = 5891;
  const off = spawn(process.execPath, [serverPath], {
    env: Object.assign({}, process.env, { PORT: String(OFF_PORT), TYPESAFE_API_KEY: '', TYPESAFE_BASE_URL: 'http://127.0.0.1:' + mockPort }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const offPort = await waitPort(OFF_PORT);
  log(!!offPort, '服务端启动成功（无密钥）', String(offPort));
  const st = await getJSON(offPort, '/api/intent');
  log(st.json && st.json.enabled === false, '无密钥时 /api/intent 能力声明 enabled=false', st.raw.slice(0, 120));
  const offRes = await postJSON(offPort, '/api/intent', { text: '比特币现在多少钱' });
  log(offRes.json && offRes.json.ok === false && offRes.json.reason === 'no_key', '无密钥时调用返回 ok=false/no_key（前端据此降级）', offRes.raw.slice(0, 120));
  off.kill('SIGKILL');

  // 场景 2：配置密钥 → 中文意图识别
  const ON_PORT = 5892;
  const on = spawn(process.execPath, [serverPath], {
    env: Object.assign({}, process.env, { PORT: String(ON_PORT), TYPESAFE_API_KEY: 'test_key_123', TYPESAFE_BASE_URL: 'http://127.0.0.1:' + mockPort, INTENT_MIN_CONF: '0.6' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const onPort = await waitPort(ON_PORT);
  log(!!onPort, '配置密钥后服务端启动成功', String(onPort));
  const st2 = await getJSON(onPort, '/api/intent');
  log(st2.json && st2.json.enabled === true && st2.json.min_confidence === 0.6, '有密钥时能力声明 enabled=true 且带阈值', st2.raw.slice(0, 140));

  seen.length = 0;
  const r1 = await postJSON(onPort, '/api/intent', { text: '比特币现在多少钱', context: ['小明: 在吗'] });
  log(r1.json && r1.json.intent === 'crypto_quote' && r1.json.crypto === 'bitcoin', '「比特币现在多少钱」→ crypto_quote / bitcoin', r1.raw.slice(0, 160));
  log(seen.length === 1 && seen[0].auth === 'Bearer test_key_123', '调用上游时携带服务端密钥（密钥不出服务端）', seen[0] && seen[0].auth);
  log(seen[0] && seen[0].payload.model === 'jev-latest' && seen[0].payload.questions && seen[0].payload.questions.intent.type === 'choice',
    '上游请求体含 model=jev-latest 与 choice 型问题', JSON.stringify(Object.keys((seen[0] && seen[0].payload.questions) || {})).slice(0, 120));
  log(r1.json.confidence <= Math.min(r1.json.intent_confidence, r1.json.crypto_confidence) + 1e-6,
    '合成置信度取各项判断的最小值（避免单项误判触发）', JSON.stringify({ c: r1.json.confidence, i: r1.json.intent_confidence, k: r1.json.crypto_confidence }));
  log(r1.json.confidence >= 0.6, '该请求置信度达到默认阈值', String(r1.json.confidence));

  const r2 = await postJSON(onPort, '/api/intent', { text: '比特币现在多少钱', context: ['小明: 在吗'] });
  log(r2.json && r2.json.cached === true, '重复提问命中缓存（省 token）', r2.raw.slice(0, 100));
  log(seen.length === 1, '缓存命中未再打上游', 'upstream calls=' + seen.length);

  const r3 = await postJSON(onPort, '/api/intent', { text: '茅台现在多少钱' });
  log(r3.json && r3.json.intent === 'stock_quote' && r3.json.kind === 'stock', '「茅台现在多少钱」→ stock_quote', r3.raw.slice(0, 160));

  const r4 = await postJSON(onPort, '/api/intent', { text: '今天心情不错呀' });
  log(r4.json && r4.json.intent === 'chitchat', '闲聊不会被识别成功能（不误触发）', r4.raw.slice(0, 160));

  // 场景 3：上游故障 → 返回 ok:false，前端静默降级
  mockMode = 'down';
  const r5 = await postJSON(onPort, '/api/intent', { text: '随机故障测试 abc123' });
  log(r5.status === 200 && r5.json && r5.json.ok === false && r5.json.reason === 'upstream', '上游 500 时返回 ok=false（不抛错给前端）', r5.raw.slice(0, 140));
  mockMode = 'ok';

  // 参数校验
  const r6 = await postJSON(onPort, '/api/intent', { text: '   ' });
  log(r6.status === 400 && r6.json && r6.json.reason === 'empty_text', '空文本返回 400/empty_text', r6.raw.slice(0, 100));

  on.kill('SIGKILL');
  await sleep(150);

  // 场景 4：没有环境变量时，密钥可来自不入库的 cloud/.typesafe.json
  const cfgPath = path.join(__dirname, '.typesafe.json');
  const hadCfg = require('fs').existsSync(cfgPath);
  const prevCfg = hadCfg ? require('fs').readFileSync(cfgPath, 'utf8') : null;
  try {
    require('fs').writeFileSync(cfgPath, JSON.stringify({ api_key: 'file_key_456', base_url: 'http://127.0.0.1:' + mockPort, min_confidence: 0.55 }));
    const FILE_PORT = 5893;
    const f = spawn(process.execPath, [serverPath], { env: Object.assign({}, process.env, { PORT: String(FILE_PORT), TYPESAFE_API_KEY: '', TYPESAFE_BASE_URL: '' }), stdio: ['ignore', 'pipe', 'pipe'] });
    const fp = await waitPort(FILE_PORT);
    const st3 = await getJSON(fp, '/api/intent');
    log(st3.json && st3.json.enabled === true && st3.json.min_confidence === 0.55, '配置文件里的密钥/阈值生效（env 为空时）', st3.raw.slice(0, 120));
    seen.length = 0;
    await postJSON(fp, '/api/intent', { text: 'eth 行情 现在多少' });
    log(seen.length === 1 && seen[0].auth === 'Bearer file_key_456', '使用配置文件中的密钥调用上游', seen[0] && seen[0].auth);
    f.kill('SIGKILL');
  } finally {
    if (hadCfg) require('fs').writeFileSync(cfgPath, prevCfg);
    else { try { require('fs').unlinkSync(cfgPath); } catch (e) {} }
  }

  mock.close();
  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

/* 轮询等待端口就绪 */
function waitPort(port, tries) {
  return new Promise((resolve) => {
    let n = 0;
    const tick = () => {
      n++;
      http.get({ host: '127.0.0.1', port, path: '/api/intent' }, (res) => { res.resume(); resolve(port); })
        .on('error', () => {
          if (n >= (tries || 40)) return resolve(0);
          setTimeout(tick, 100);
        });
    };
    tick();
  });
}
