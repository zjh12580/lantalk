/**
 * LanTalk 云端版服务端
 * - 托管 cloud/index.html 静态页面
 * - POST /api/intent  →  TypeSafe AI (Jev) 意图识别代理（密钥只留服务端）
 *
 * 环境变量：
 *   PORT                 监听端口（默认 8080）
 *   TYPESAFE_API_KEY     TypeSafe API Key（缺失时 /api/intent 返回 ok:false，前端自动降级）
 *   TYPESAFE_BASE_URL    TypeSafe API 基地址（默认 https://api.typesafe.ai，测试可指向 mock）
 *   TYPESAFE_MODEL       模型名（默认 jev-latest）
 *   INTENT_MIN_CONF      最低置信度阈值（默认 0.6）
 *
 * 密钥优先级：环境变量 > cloud/.typesafe.json（该文件已 gitignore，不会进仓库）
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

// 密钥也可以放在不入库的本地配置文件里，方便没有环境变量的部署环境
function readLocalConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, '.typesafe.json'), 'utf8'));
  } catch (e) { return {}; }
}
const LOCAL = readLocalConfig();

const PORT = process.env.PORT || LOCAL.port || 8080;
const API_KEY = process.env.TYPESAFE_API_KEY || LOCAL.api_key || '';
const BASE_URL = (process.env.TYPESAFE_BASE_URL || LOCAL.base_url || 'https://api.typesafe.ai').replace(/\/+$/, '');
const MODEL = process.env.TYPESAFE_MODEL || LOCAL.model || 'jev-latest';
const MIN_CONF = parseFloat(process.env.INTENT_MIN_CONF || LOCAL.min_confidence || '0.6');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

/* 意图识别的问题定义：一次请求并行问多个判断，代码消费结果。
   instructions/criteria 用英文（Jev 英文最优），并给出中文示例帮助泛化。 */
const QUESTIONS = {
  intent: {
    type: 'choice',
    instructions: 'What does the user want the chat assistant to do with this message?',
    criteria: {
      crypto_quote: 'Wants the live market quote of a specific cryptocurrency — price, 24h change or volume. Chinese examples: "比特币现在多少钱", "BTC 涨了没", "看下 eth 行情"',
      stock_quote: 'Wants the live market quote of a specific stock (A-share / HK / US) — price, daily change or volume. Chinese examples: "茅台多少了", "腾讯股价", "600519 涨跌幅"',
      weather: 'Wants the weather of a place. Chinese example: "北京今天天气"',
      web_search: 'Wants a factual answer that requires looking something up online, not a quote or weather. Chinese example: "帮我查一下 xxx 是什么公司"',
      help: 'Wants to know which commands or features are available. Chinese examples: "有什么功能", "怎么用"',
      chitchat: 'Greeting, small talk, emotion, or anything unrelated to quotes / weather / lookup'
    }
  },
  has_asset: {
    type: 'noul',
    instructions: 'Does the message name a specific cryptocurrency or a specific stock (company)? Answer no if it only asks about the market in general.',
  },
  asset_kind: {
    type: 'choice',
    instructions: 'If a specific asset is named, which kind is it?',
    criteria: {
      crypto: 'A cryptocurrency such as 比特币/BTC, 以太坊/ETH, 狗狗币/DOGE',
      stock: 'A listed company share such as 贵州茅台/600519, 腾讯/00700, 苹果/AAPL',
      none: 'No specific asset named'
    }
  },
  crypto_asset: {
    type: 'choice',
    instructions: 'Which cryptocurrency does the message ask about? Answer none unless one of these is named or clearly implied.',
    criteria: {
      bitcoin: 'Bitcoin — 比特币 / BTC / 大饼',
      ethereum: 'Ethereum — 以太坊 / ETH / 以太',
      dogecoin: 'Dogecoin — 狗狗币 / DOGE',
      none: 'None of these cryptocurrencies'
    }
  }
};

/* ---------- 极简内存缓存，避免同一句话反复计费 ---------- */
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
const CACHE_MAX = 200;
function cacheGet(k) {
  const v = cache.get(k);
  if (!v) return null;
  if (Date.now() - v.t > CACHE_TTL) { cache.delete(k); return null; }
  return v.v;
}
function cacheSet(k, v) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(k, { t: Date.now(), v: v });
}

async function callTypeSafe(text, context) {
  const state = {
    recent_messages: Array.isArray(context) ? context.slice(-4) : [],
    message: String(text || '').slice(0, 2000),
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6000);
  try {
    const r = await fetch(BASE_URL + '/v1/systemone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API_KEY },
      body: JSON.stringify({ state: state, model: MODEL, questions: QUESTIONS }),
      signal: ac.signal,
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      const err = new Error('typesafe ' + r.status + ' ' + body.slice(0, 180));
      err.status = r.status;
      throw err;
    }
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function shapeAnswer(j) {
  const a = (j && j.answers) || {};
  const intent = a.intent || {};
  const kind = a.asset_kind || {};
  const has = a.has_asset || {};
  const ca = a.crypto_asset || {};
  const conf = typeof intent.confidence === 'number' ? intent.confidence : 0;
  const kindConf = typeof kind.confidence === 'number' ? kind.confidence : 0;
  const probs = ca.probabilities || {};
  const coin = ca.choice && ca.choice !== 'none' ? ca.choice : '';
  const coinProb = coin ? (probs[coin] || ca.confidence || 0) : 0;
  // 至少两项判断都比较有把握才行动：一次错误触发就够毁掉体验
  const confidence = Math.min(conf, kindConf || conf, coin ? coinProb : 1);
  return {
    ok: true,
    intent: intent.choice || 'chitchat',
    confidence: Number(confidence.toFixed(3)),
    intent_confidence: Number(conf.toFixed(3)),
    kind: kind.choice || 'none',
    kind_confidence: Number(kindConf.toFixed(3)),
    has_asset: typeof has.noul === 'number' ? Number(has.noul.toFixed(3)) : 0,
    crypto: coin,
    crypto_confidence: Number(coinProb.toFixed(3)),
    model: j.model || MODEL,
    usage: j.usage || null,
  };
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  // 前端启动时查询意图能力是否可用（决定是否走 Jev 路由）
  if (url.pathname === '/api/intent' && req.method === 'GET') {
    return send(res, 200, { ok: true, enabled: !!API_KEY, min_confidence: MIN_CONF, model: MODEL });
  }

  if (url.pathname === '/api/intent' && req.method === 'POST') {
    if (!API_KEY) return send(res, 200, { ok: false, reason: 'no_key' });
    let payload;
    try { payload = JSON.parse((await readBody(req, 32 * 1024)) || '{}'); }
    catch (e) { return send(res, 400, { ok: false, reason: 'bad_json' }); }
    const text = String(payload.text || '').trim();
    if (!text) return send(res, 400, { ok: false, reason: 'empty_text' });
    const ck = text + '|' + (payload.context || []).slice(-2).join('~');
    const hit = cacheGet(ck);
    if (hit) return send(res, 200, Object.assign({ cached: true }, hit));
    try {
      const raw = await callTypeSafe(text, payload.context);
      const out = shapeAnswer(raw);
      out.min_confidence = MIN_CONF;
      cacheSet(ck, out);
      return send(res, 200, out);
    } catch (e) {
      console.warn('[intent]', e.message);
      return send(res, 200, { ok: false, reason: 'upstream', detail: String(e.message || e).slice(0, 200) });
    }
  }

  // 静态文件
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('[cloud] listening on :' + PORT + '  intent=' + (API_KEY ? 'on' : 'off(no TYPESAFE_API_KEY)') + '  model=' + MODEL);
  });
}
module.exports = { server, QUESTIONS, shapeAnswer };
