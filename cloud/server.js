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
      analyze: 'Wants the assistant to analyze the recent conversation — mood, intent, affinity/engagement signal, reply quality. Chinese examples: "分析下这段对话", "帮我看看聊得怎么样", "我们聊得还行吗"',
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

/* 聊天洞察（参考 crush-monitor 第一层 Jev，迁移到小美）：
   给定一段对话的 self/other 消息，并行问 5 个结构化判断：
     - mood        整体氛围的主要情绪（12 类，取概率最高）
     - intent      对方最近一条消息的主要意图（35 类）
     - affinity    对方对说话人的好感/投入信号（5 档）
     - quality     我方最近回复的质量（5 档）
     - next_action 建议下一步动作
   边界继承 crush-monitor：不假定线下关系/性别/附件，概率只来自 Jev，
   解释（如有）不覆盖观察。instructions 用英文（Jev 英文最优），criteria 用中文。 */
const ANALYZE_QUESTIONS = {
  mood: {
    type: 'choice',
    instructions: 'Based ONLY on the conversation messages in state, what is the dominant emotional tone of the recent exchange? Pick the single best fit. Do not assume any off-screen relationship, gender, or attachment. Chinese daily context; sarcasm and jokes happen. If truly unclear pick unknown.',
    criteria: {
      happy: '愉快、满足、开心或兴奋',
      confused: '不理解、好奇、疑问或困惑',
      angry: '真实生气、愤怒或强烈不满',
      sad: '伤心、低落、悲伤',
      shy: '羞涩、难为情或暧昧时不好意思',
      caring: '担心、关切或体贴对方',
      teasing: '开玩笑、逗对方、玩梗或善意戏谑',
      calm: '客观陈述、平静中性交流，无明显情绪',
      annoyed: '厌烦、想赶紧结束、不愿重复解释',
      surprised: '意外、吃惊、超出预期',
      disappointed: '期待落空、委屈、失望',
      unknown: '无法判断主要情绪或以上均不适合'
    }
  },
  intent: {
    type: 'choice',
    instructions: 'Look at the LAST message from "other" (not self, not the assistant) in the conversation. What is its primary communicative intent? Pick the single best fit; competing interpretations are fine, pick the most likely. Chinese context.',
    criteria: {
      share: '主动讲自己的经历、活动或状态，主要是分享而非回答问题',
      answer: '回应前面的具体询问，主要目的是提供所问信息',
      inform: '通知事实、安排或进展',
      ask: '获取事实、原因、安排或情况',
      clarify: '核对自己对前文的理解',
      explain: '澄清原因、误会或补充背景',
      opinion: '陈述看法或评价',
      agree: '赞同对方观点、感受或提议',
      disagree: '提出不同观点、反驳或纠正',
      acknowledge: '简短确认已看到或听懂',
      continue: '接住前文或补充话头，维持对话',
      change: '将交流引向另一个话题',
      joke: '开玩笑、接梗或善意互损',
      vent: '表达困扰或抱怨以释放感受',
      comfort_seek: '通过表达脆弱或委屈，希望得到情绪支持',
      validation: '希望对方肯定自己的感受、看法或价值',
      help: '希望对方提供具体建议、信息或实际帮助',
      advice: '主动提供解决办法或行动建议',
      care: '关注对方状态或需要，主要是关怀',
      comfort: '接住对方困扰、鼓励或给予支持',
      praise: '肯定对方特质或表现',
      thanks: '感谢对方的回应、帮助或付出',
      apologize: '承认不妥、致歉或尝试修复交流关系',
      attention: '希望对方多注意、回应或陪伴自己',
      suggest: '提出做某事的提议',
      invite: '具体邀约对方参与活动',
      refuse: '拒绝请求或提议',
      worry: '表达对某事的担忧',
      plan: '讨论或安排未来计划',
      small_talk: '寒暄、客套或无实质内容的填充',
      unknown: '无法判断主要意图'
    }
  },
  affinity: {
    type: 'choice',
    instructions: 'Only from the actual exchange in state, rate how much positive affinity/engagement signal "other" shows toward "self" (the speaker). Short replies and busyness do NOT automatically mean coldness. Relationship labels are not evidence.',
    criteria: {
      '1_distant': '明确疏远、拒绝或排斥接近',
      '2_polite': '有限的礼貌回应，没有主动延续的信号',
      '3_neutral': '自然交流并有回应，但缺少明显亲密信号',
      '4_warm': '主动关心、延续话题或投入个人细节',
      '5_close': '明确亲密、相互接纳的暧昧或主动接近行动'
    }
  },
  quality: {
    type: 'choice',
    instructions: 'Look at the LAST message sent by "self" in the conversation, considering the context before it. Rate how well it responds to the other person\'s prior message. Do not assume longer is better.',
    criteria: {
      '1_poor': '明显冒犯、强迫或无视已表达的边界',
      '2_awkward': '明显不合语境、施压或错过关键情绪',
      '3_flat': '基本合适但平淡、泛泛，延续空间有限',
      '4_good': '具体接住话题或情绪，自然而不施压',
      '5_great': '非常贴合、有趣或体贴，同时给对方舒适的表达空间'
    }
  },
  next_action: {
    type: 'choice',
    instructions: 'Given the conversation state, what is the single best next move for "self"? Pick the most helpful. If context is insufficient, pick insufficient.',
    criteria: {
      continue: '接住已有话题继续聊',
      ask: '问一个具体轻松问题',
      empathize: '先回应倾诉或不满的感受',
      suggest: '已有相互投入和共同兴趣，可低压力提议一起做点什么',
      invite: '有足够相互投入，可以低压力邀约',
      clarify: '意思关键且含糊，需要温和确认',
      wait: '我方已发出需要对方回应的信息，应先等待',
      close: '对方忙或表达结束，本次先收尾',
      respect: '对方明确拒绝接近或要求停止，要尊重边界',
      insufficient: '上下文不足，无法建议'
    }
  }
};

function shapeAnalyze(j) {
  const a = (j && j.answers) || {};
  const pick = (q) => {
    const x = a[q] || {};
    return {
      choice: x.choice || '',
      probabilities: x.probabilities || {},
      confidence: typeof x.confidence === 'number' ? x.confidence : 0,
    };
  };
  return {
    ok: true,
    mood: pick('mood'),
    intent: pick('intent'),
    affinity: pick('affinity'),
    quality: pick('quality'),
    next_action: pick('next_action'),
    model: j.model || MODEL,
    usage: j.usage || null,
  };
}

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

  // 聊天洞察：把一段对话的 self/other 消息发给 Jev，返回情绪/意图/好感/质量/建议
  if (url.pathname === '/api/analyze' && req.method === 'GET') {
    return send(res, 200, { ok: true, enabled: !!API_KEY, model: MODEL });
  }
  if (url.pathname === '/api/analyze' && req.method === 'POST') {
    if (!API_KEY) return send(res, 200, { ok: false, reason: 'no_key' });
    let payload;
    try { payload = JSON.parse((await readBody(req, 64 * 1024)) || '{}'); }
    catch (e) { return send(res, 400, { ok: false, reason: 'bad_json' }); }
    const msgs = Array.isArray(payload.messages) ? payload.messages.slice(0, 12) : [];
    if (!msgs.length) return send(res, 400, { ok: false, reason: 'empty_messages' });
    const state = {
      messages: msgs.map(function (m) {
        return {
          id: String(m.id || '').slice(0, 80),
          sender: m.sender === 'self' ? 'self' : (m.sender === 'other' ? 'other' : 'unknown'),
          text: String(m.text || '').slice(0, 2000),
          kind: m.kind || 'text',
        };
      }),
    };
    const ck = 'an:' + JSON.stringify(state);
    const hit = cacheGet(ck);
    if (hit) return send(res, 200, Object.assign({ cached: true }, hit));
    try {
      const ac = new AbortController();
      const timer = setTimeout(function () { ac.abort(); }, 8000);
      const r = await fetch(BASE_URL + '/v1/systemone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API_KEY },
        body: JSON.stringify({ state: state, model: MODEL, questions: ANALYZE_QUESTIONS }),
        signal: ac.signal,
      });
      clearTimeout(timer);
      if (!r.ok) {
        const body = await r.text().catch(function () { return ''; });
        return send(res, 200, { ok: false, reason: 'upstream', detail: String(body).slice(0, 200) });
      }
      const out = shapeAnalyze(await r.json());
      cacheSet(ck, out);
      return send(res, 200, out);
    } catch (e) {
      console.warn('[analyze]', e.message);
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
module.exports = { server, QUESTIONS, shapeAnswer, ANALYZE_QUESTIONS, shapeAnalyze };
