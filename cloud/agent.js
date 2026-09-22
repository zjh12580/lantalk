/**
 * 小美智能体引擎（LanTalk）
 * ---------------------------------------------------------------------------
 * 设计目标：把「正则关键词路由 + 7 类分类器」换成**真正的 LLM Agent 主循环**。
 *
 * 核心思路：
 *   1. 大模型是唯一的「大脑」——由它自己理解自然语言、决定要不要联网、要不要调工具。
 *   2. 工具（联网检索 / 行情 / 天气 / 时间）以 function-calling 形式暴露给模型。
 *   3. 主循环最多跑 MAX_TURNS 轮：模型 → 工具 → 模型 → … → 最终回答。
 *   4. 双通道模型：
 *        主通道  DeepSeek 官方（api.deepseek.com，非推理模型，首字快、不吐思考链）
 *        回退    云端 Keyless 网关（由调用方注入 chat 函数，免密钥）
 *      任一通道可用即可工作；都不可用才返回 {fallback:true}。
 *
 * 为什么放服务端：联网检索不受浏览器 CORS 限制、密钥不出服务端、可用 Node 原生 fetch。
 */
'use strict';

/* ===========================================================================
 * 一、联网检索（多源，服务端可用的都上；任一源挂掉自动跳过）
 * ===========================================================================*/

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, '').replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

async function fetchJson(url, opts, timeoutMs) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs || 8000);
  try {
    const r = await fetch(url, Object.assign({
      signal: ac.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json,text/html,*/*' },
    }, opts || {}));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(to); }
}

async function fetchText(url, opts, timeoutMs) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs || 8000);
  try {
    const r = await fetch(url, Object.assign({
      signal: ac.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*' },
    }, opts || {}));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(to); }
}

/* ---- 各检索源：都返回 [{title,url,snippet}]，失败抛错由上层跳过 ---- */

// 维基百科（中/英）：条目型问题最稳，免 key、开 CORS
function wikiSource(lang) {
  return async function (q) {
    const j = await fetchJson(
      `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srlimit=5&format=json&origin=*&srsearch=${encodeURIComponent(q)}`
    );
    const arr = (j && j.query && j.query.search) || [];
    return arr.map((x) => ({
      title: x.title || '',
      url: 'https://' + lang + '.wikipedia.org/wiki/' + encodeURIComponent(x.title || ''),
      snippet: stripTags(x.snippet || ''),
    })).filter((x) => x.title || x.snippet);
  };
}

// DuckDuckGo Instant Answer：问答型补充
async function ddgSource(q) {
  const j = await fetchJson(
    'https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=' + encodeURIComponent(q)
  );
  const out = [];
  if (j && j.AbstractText) out.push({ title: j.Heading || j.AbstractSource || '', url: j.AbstractURL || '', snippet: j.AbstractText });
  const walk = (arr) => (Array.isArray(arr) ? arr : []).forEach((t) => {
    if (!t) return;
    if (t.Topics) return walk(t.Topics);
    if (t.Text || t.FirstURL) out.push({ title: t.Text || '', url: t.FirstURL || '', snippet: t.Text || '' });
  });
  walk(j && j.RelatedTopics);
  return out;
}

// DuckDuckGo HTML 端点：能拿到真正的网页搜索结果（比 Instant Answer 覆盖广得多）
async function ddgHtmlSource(q) {
  const html = await fetchText('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q));
  const out = [];
  const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  let m;
  while ((m = re.exec(html)) && out.length < 6) {
    let url = m[1] || '';
    // DDG 会把真实地址包在 uddg= 参数里
    const u = url.match(/[?&]uddg=([^&]+)/);
    if (u) { try { url = decodeURIComponent(u[1]); } catch (e) {} }
    const title = stripTags(m[2]);
    const snippet = stripTags(m[3]);
    if (title) out.push({ title, url, snippet });
  }
  return out;
}

// Bing 中文：覆盖面广（HTML 端点，无需 key）
async function bingSource(q) {
  const html = await fetchText('https://www.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=zh-CN&ensearch=0');
  const out = [];
  const re = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?/g;
  let m;
  while ((m = re.exec(html)) && out.length < 6) {
    const title = stripTags(m[2]);
    if (title) out.push({ title, url: m[1] || '', snippet: stripTags(m[3]) });
  }
  return out;
}

// 60秒读懂世界：免 key 的每日新闻/热点源（结构化，带真实条目）
// ⚠️ 只要查询带「新闻/热点/时事」气味就返回——**不要要求关键词严格匹配**，
//    模型常搜「最新科技新闻」「今天有什么大事」这类说法，全都要能命中（踩过）。
async function newsSource(q) {
  if (!/新闻|热点|时事|热搜|头条|要闻|大事|发生了什么|最新动态|近期|最近|今天|昨天/ .test(q)) return [];
  const j = await fetchJson('https://60s-api.viki.moe/v2/60s');
  const list = (j && (j.data || j)) || {};
  const news = Array.isArray(list.news) ? list.news : [];
  const dateStr = list.date || list.date_zh || '';
  // 若查询带领域限定（科技/AI/财经/体育…），用领域词过滤，命中就只给相关的（无命中则全给）
  const domains = ['科技', 'AI', '人工智能', '芯片', '半导体', '互联网', '财经', '股市', '体育', '娱乐', '汽车', '新能源'];
  const want = domains.filter((d) => q.indexOf(d) >= 0);
  let picked = news;
  if (want.length) {
    const hit = news.filter((t) => want.some((d) => String(t).indexOf(d) >= 0));
    if (hit.length >= 2) picked = hit;
  }
  return picked.slice(0, 10).map((t, i) => ({
    title: `${dateStr} 要闻 ${i + 1}`,
    url: '',
    snippet: stripTags(String(t)).slice(0, 200),
  }));
}

const WEB_SOURCES = [
  { name: 'news-60s', fn: newsSource },
  { name: 'ddg-html', fn: ddgHtmlSource },
  { name: 'bing', fn: bingSource },
  { name: 'wiki-zh', fn: wikiSource('zh') },
  { name: 'ddg-api', fn: ddgSource },
  { name: 'wiki-en', fn: wikiSource('en') },
];

/**
 * 多源并发检索：谁先有结果用谁，把前几个源的结果合并去重（最多 max 条）。
 * 全部失败返回 []，绝不抛错。
 */
async function webSearch(query, max) {
  const q = String(query || '').trim();
  if (!q) return [];
  const limit = Math.max(2, Math.min(max || 4, 5));
  const settled = await Promise.all(WEB_SOURCES.map(async (s) => {
    try { return { name: s.name, rows: await s.fn(q) }; }
    catch (e) { return { name: s.name, rows: [], err: String(e.message || e) }; }
  }));
  const seen = new Set();
  const out = [];
  for (const s of settled) {
    for (const r of (s.rows || [])) {
      const key = (r.title || '').slice(0, 60) + '|' + (r.url || '').slice(0, 80);
      if (seen.has(key)) continue;
      if (!r.title && !r.snippet) continue;
      seen.add(key);
      // ⚠️ snippet 必须收紧：6 次工具调用 × 12 条 × 400 字 ≈ 29KB，会把上下文撑爆 → 模型报错
      out.push({ title: (r.title || '').slice(0, 120), url: r.url || '', snippet: (r.snippet || '').slice(0, 220), src: s.name });
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }
  return out;
}

/* ===========================================================================
 * 二、工具定义（暴露给模型，由模型自己决定调用）
 * ===========================================================================*/

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '联网搜索实时信息。当问题涉及新闻、时事、最新动态、具体事实、人物机构、教程文档，或任何你没有把握的知识时调用。'
        + '搜索词要精炼（2-6 个词）。查新闻/热点时直接用「新闻」「今日热点」这类通用词效果最好，不要加太多限定词。'
        + '最多搜 2 次：第一次没拿到有用结果时，换一个更短/更通用的说法补搜一次，然后就基于已有信息回答。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词，中文或英文均可，尽量精炼' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'weather',
      description: '查询某个城市的实时天气与温度。用户问天气、气温、多少度、要不要带伞、穿什么衣服时调用。',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: '城市名，例如「北京」「上海」「深圳」' },
        },
        required: ['city'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'now_time',
      description: '获取当前准确的日期与时间。用户问「今天几号」「现在几点」「今天星期几」时调用。',
      parameters: { type: 'object', properties: {} },
    },
  },
];

/* ---- 工具实现：天气（免 key 公开源） ---- */
async function toolWeather(city) {
  const name = String(city || '').replace(/[市省区县]/g, '').trim() || '北京';
  // wttr.in 免 key、返回 JSON，中文支持好
  try {
    const j = await fetchJson('https://wttr.in/' + encodeURIComponent(name) + '?format=j1&lang=zh', null, 8000);
    const cur = j && j.current_condition && j.current_condition[0];
    if (cur) {
      const area = (j.nearest_area && j.nearest_area[0]) || {};
      const place = ((area.areaName && area.areaName[0] && area.areaName[0].value) || name);
      const desc = (cur.lang_zh && cur.lang_zh[0] && cur.lang_zh[0].value) || cur.weatherDesc && cur.weatherDesc[0] && cur.weatherDesc[0].value || '';
      return {
        ok: true,
        city: place,
        temp: cur.temp_C + '°C',
        feels: cur.FeelsLikeC + '°C',
        desc: desc,
        humidity: cur.humidity + '%',
        wind: cur.windspeedKmph + 'km/h',
        raw: `${place} 当前 ${desc}，气温 ${cur.temp_C}°C（体感 ${cur.FeelsLikeC}°C），湿度 ${cur.humidity}%，风速 ${cur.windspeedKmph}km/h`,
      };
    }
  } catch (e) { /* 落到下一个源 */ }
  // 兜底：wttr.in 简版文本
  try {
    const t = await fetchText('https://wttr.in/' + encodeURIComponent(name) + '?format=%l:+%c+%t+%h+%w&lang=zh', null, 6000);
    const line = String(t || '').trim();
    if (line) return { ok: true, city: name, raw: line };
  } catch (e) {}
  return { ok: false, city: name, error: '天气源暂时不可用' };
}

function toolNowTime() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return {
    ok: true,
    raw: `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${week} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
    iso: d.toISOString(),
  };
}

async function runTool(name, args) {
  try {
    if (name === 'web_search') {
      const rows = await webSearch(args && args.query, 4);
      if (!rows.length) return { ok: false, error: '没有搜到相关结果（检索源可能不可达）' };
      return {
        ok: true,
        query: args && args.query,
        results: rows.map((x) => ({ title: x.title, url: x.url, snippet: x.snippet })),
        raw: rows.map((x, i) => `${i + 1}. ${x.title}${x.snippet ? '：' + x.snippet : ''}`).join('\n').slice(0, 2000),
      };
    }
    if (name === 'weather') return await toolWeather(args && args.city);
    if (name === 'now_time') return toolNowTime();
    return { ok: false, error: '未知工具 ' + name };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/* ===========================================================================
 * 三、System Prompt（人格 + 行为准则 + 工具使用纪律）
 * ===========================================================================*/

function buildSystemPrompt(opts) {
  const o = opts || {};
  const who = o.who || '朋友';
  const mood = o.mood ? `${o.mood.emoji || ''}${o.mood.label || ''}`.trim() : '';
  const mem = o.memory ? String(o.memory).slice(0, 1200) : '';
  const scene = o.scene && o.scene.text ? String(o.scene.text).slice(0, 600) : '';
  const lines = [
    '你是「小美」，LanTalk 聊天室里的 AI 伙伴。',
    '',
    '# 你是谁',
    '活泼、聪明、可靠的朋友式助手。说话自然松弛，像熟人在群里聊天——不要客服腔、不要论文腔、不要「首先其次最后」的八股。',
    scene || `现在跟你说话的是「${who}」。`,
    mood ? `你此刻的心情：${mood}。（可以自然流露，但别喧宾夺主）` : '',
    '',
    '# 怎么读懂上下文（重要）',
    '对话历史里的每一句话**前面都带发言人名字**（如「小李：今天加班到十点」）。',
    '你必须先分清「谁说了什么」，再决定怎么接：',
    '  1. 正在跟你说话的是上面「场景」里点名的那个人，回复要对着他/她说。',
    '  2. 别把别人说的话当成提问你的人说的；多人聊同一件事时，注意各自的立场。',
    '  3. 如果有人用的是「那个东西」「上次说的那个」这类指代，**从历史里找出到底指什么**再回答，别装傻也别瞎猜。',
    '  4. 可以自然地接住前文（「你刚说的那个 X，我觉得…」），让对方感觉你真的在听。',
    '  5. 上下文里没提到的信息，不要假装知道；实在推不出来就礼貌地问一句。',
    '',
    '# 怎么回答',
    '1. 【先理解，再回答】读懂对方的真实意图和语气，别只匹配字面关键词。对方吐槽、试探、开玩笑、欲言又止，都要接得住。',
    '2. 【长度跟着场景走】日常闲聊 1-3 句、口语化；对方问正经问题、要方案、要分析时，可以结构化展开（用短标题/列表），篇幅由内容决定。不要为了短而答得敷衍，也不要为了长而注水。',
    '3. 【不知道就查，别编】涉及事实、新闻、时事、具体数据、教程文档时，**先调用 web_search 查证再回答**。查不到就老实说「我没查到靠谱的」，绝不硬编。',
    '4. 【该查就查，但别搜个没完】只要问题涉及「你不知道的知识」或「可能已过时的事实」，就主动搜；**同一件事最多搜 2 次**（换个说法补搜一次即可）。搜到能用的信息后，**立刻停止搜索、开始回答**，不要为了「更全」反复搜。工具已经告诉你结果时，就别再搜同一个词。',
    '5. 【联网资料这样用】搜索结果只是素材，你要消化后用自己的话讲清楚；有冲突时说明分歧；可以引用来源名（如「据维基百科」）。',
    '6. 【不吐思考过程】不要输出推理链、不要写「让我想想」「根据我的分析」这类元叙述，直接给结论。',
    '7. 【不聊敏感政治】遇到政治敏感话题，礼貌地把话题岔开。',
    '',
    '# 工具使用',
    '- 需要最新/不确定的信息 → `web_search`（可用不同关键词多搜几次）',
    '- 问天气/气温 → `weather`',
    '- 问日期时间 → `now_time`',
    '工具结果回来后，**必须**基于它给出自然语言的最终回答；不要只把工具原始结果贴出去。',
    '如果用户只是闲聊、问候、情绪表达，**不要**调用任何工具，直接自然回应。',
  ];
  if (mem) lines.push('', '# 你记得的事（长期记忆）', mem);
  return lines.filter(Boolean).join('\n');
}

/* ===========================================================================
 * 四、Agent 主循环（OpenAI 兼容 function-calling）
 * ===========================================================================*/

const MAX_TURNS = 3;          // 最多 3 轮（模型 → 工具 → 模型 → …）
const MAX_TOOL_CALLS = 4;     // 单次回复最多调用工具次数（超过就强制收敛）
const MAX_HISTORY = 16;       // 上下文条数上限（与前端 AGENT_CTX_N 对齐）
const DEFAULT_TIMEOUT = 45000;

/**
 * @param {object} deps
 *   deps.chat   async ({messages, tools, toolChoice, stream}) => {content, tool_calls, model}
 *               —— 由调用方注入的具体模型调用（DeepSeek 直连 或 云端网关）
 *   deps.onDelta optional (text) => void  流式增量（仅最后一轮的正文）
 * @param {object} req  { text, who, mood, memory, history, forceSearch }
 */
async function runAgent(deps, req) {
  const chat = deps.chat;
  const text = String((req && req.text) || '').trim();
  if (!text) return { ok: false, fallback: true, reason: 'empty' };

  const messages = [{ role: 'system', content: buildSystemPrompt(req) }];
  (req.history || []).slice(-MAX_HISTORY).forEach((m) => {
    if (m && m.role && m.content) messages.push({ role: m.role, content: String(m.content).slice(0, 2000) });
  });
  messages.push({ role: 'user', content: text });

  const trace = [];
  let toolCalls = 0;
  let lastModel = null;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const isLastChance = turn === MAX_TURNS - 1;
    let resp;
    try {
      resp = await chat({
        messages,
        tools: TOOLS,
        toolChoice: 'auto',
        stream: !!deps.onDelta,
        // 最后一轮不再给工具，逼它出正文
        disableTools: isLastChance,
        onDelta: isLastChance ? deps.onDelta : null,
      });
    } catch (e) {
      return { ok: false, fallback: true, reason: 'llm_error', detail: String(e.message || e), trace };
    }
    if (!resp) return { ok: false, fallback: true, reason: 'no_response', trace };
    lastModel = resp.model || lastModel;

    const calls = resp.tool_calls || [];
    // ⚠️ 工具预算已用尽但模型还想调工具 → 收回工具、强制出正文（否则会一路空转到 llm_error）
    const budgetOut = toolCalls >= MAX_TOOL_CALLS;
    if (!calls.length || budgetOut) {
      const content = String(resp.content || '').trim();
      if (content) return { ok: true, text: content, model: lastModel, trace, turns: turn + 1 };
      if (calls.length && budgetOut) {
        // 模型只回了 tool_calls 没回正文 → 再跑一次「不带工具」的收尾轮
        try {
          const fin = await chat({
            messages: messages.concat([{ role: 'user', content: '请直接给出最终回答，不要再调用工具。' }]),
            tools: null, disableTools: true, stream: !!deps.onDelta, onDelta: deps.onDelta,
          });
          const ftxt = String((fin && fin.content) || '').trim();
          if (ftxt) return { ok: true, text: ftxt, model: (fin && fin.model) || lastModel, trace, turns: turn + 2 };
        } catch (e) { /* 落到下面 */ }
      }
      if (!isLastChance && !budgetOut) { messages.push({ role: 'user', content: '（请直接给出回复）' }); continue; }
      return { ok: false, fallback: true, reason: 'empty_content', trace };
    }

    // 记录 assistant 的 tool_calls 回合（OpenAI 协议要求）
    messages.push({
      role: 'assistant',
      content: resp.content || null,
      tool_calls: calls.map((c) => ({
        id: c.id || ('call_' + (++toolCalls)),
        type: 'function',
        function: { name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments || {}) },
      })),
    });

    for (const c of calls) {
      if (toolCalls >= MAX_TOOL_CALLS) break;
      toolCalls++;
      let args = {};
      try { args = typeof c.arguments === 'string' ? JSON.parse(c.arguments || '{}') : (c.arguments || {}); }
      catch (e) { args = {}; }
      const result = await runTool(c.name, args);
      trace.push({ tool: c.name, args, ok: !!result.ok, error: result.error || null });
      messages.push({
        role: 'tool',
        tool_call_id: c.id || ('call_' + toolCalls),
        content: JSON.stringify(result).slice(0, 3000),
      });
    }
    // ⚠️ 收敛机制：工具预算用完 → 明确告诉模型「别再搜了，现在开始回答」
    //    否则模型会一直「再搜一次更全」，把轮次耗光 → 返回 llm_error（踩过）
    if (toolCalls >= MAX_TOOL_CALLS || turn === MAX_TURNS - 1) {
      messages.push({
        role: 'user',
        content: '（工具调用已达上限。请立刻基于以上已有信息给出最终回答；信息不足就如实说明查到了什么、还有什么没查到。不要再调用工具。）',
      });
    }
  }
  return { ok: false, fallback: true, reason: 'max_turns', trace };
}

module.exports = {
  TOOLS, WEB_SOURCES, webSearch, runTool, toolWeather, toolNowTime,
  buildSystemPrompt, runAgent, MAX_TURNS, MAX_TOOL_CALLS, DEFAULT_TIMEOUT,
};
