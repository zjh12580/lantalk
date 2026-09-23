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

// 去标签 + 解 HTML 实体。
// ⚠️ 实测（2026-09-22）：Bing/360 的摘要里带 &ensp; &#0183; &nbsp; 等，
//    只解 &amp;/&lt; 这几个不够 → 残留噪声直接喂给模型。这里统一处理：
//    ① 具名实体表 ② 十进制/十六进制数字实体 ③ 不可见空白字符。
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', shy: '', hellip: '…', mdash: '—', ndash: '–', middot: '·', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’' };
function stripTags(s) {
  return String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // ⚠️ 普通标签**直接删掉、不要换成空格**：360/Bing 用 <em> 高亮关键词，
    //    换成空格会把「连接池被打满」拆成「连接池 被打 满」（踩过）。
    //    只有真正的块级/换行标签才补一个空格，避免相邻文本粘连。
    .replace(/<\/?(?:div|p|li|ul|ol|br|tr|td|h[1-6]|section|article)[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&([a-z]+);/gi, (m, n) => (ENT[n.toLowerCase()] !== undefined ? ENT[n.toLowerCase()] : m))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return m; } })
    .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return m; } })
    // 零宽/方向控制字符一并清掉
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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
// 查询里是否有中文（用于判断结果语言是否匹配）
function hasCJK(s) { return /[\u4e00-\u9fa5]/.test(String(s || '')); }

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
    }))
      // ⚠️ 实测：中文查询喂给 wiki-en 会返回 Fan Bingbing 这类完全无关的条目（Wiki 全文搜索会
      //    命中 snippet 里的中文引文）→ 噪声极大。规则：中文查询 + 英文维基，条目名必须也是中文才算相关。
      .filter((x) => {
        if (x.title && hasCJK(q) && lang === 'en' && !hasCJK(x.title) && !hasCJK(x.snippet)) return false;
        return !!(x.title || x.snippet);
      });
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

// 按搜索结果的「结果块」拆分 HTML：比单条大正则稳得多（正则一改结构就全废，踩过）
function splitBlocks(html, sep) {
  return String(html || '').split(sep).slice(1);
}

// Bing 中文：覆盖面广（HTML 端点，无需 key）
// ⚠️ 实测（2026-09-22）真实结构：<li class="b_algo" ...><h2 class=""><a href="真实URL">标题</a></h2>
//    <div class="b_caption"><p class="b_lineclamp2">摘要</p></div>
//    —— h2 **带属性**、每个 b_algo 内先插一堆 <link>，所以必须「先分块再块内正则」。
async function bingSource(q) {
  const html = await fetchText('https://www.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=zh-CN&ensearch=0');
  const out = [];
  for (const b of splitBlocks(html, /<li class="b_algo"/)) {
    if (out.length >= 8) break;
    const m = b.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!m) continue;
    const url = m[1];
    const title = stripTags(m[2]);
    if (!title || !/^https?:/i.test(url)) continue;
    // Bing 的摘要容器类名会变（b_lineclamp2/3/4…），只锚 b_caption 更稳
    const s = b.match(/<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/) || b.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    out.push({ title, url, snippet: s ? stripTags(s[1]) : '' });
  }
  return out;
}

// 360 搜索（so.com）：中文技术问答/资讯命中率最高，且带真实时间戳（最"新"）
// ⚠️ 实测（2026-09-22）真实结构：<li class="res-list"><h3 class="res-title"><a data-mdurl="真实URL" href="跳转URL">…
//    —— **href 是 so.com 跳转链，真实地址只在 data-mdurl**，取错 url 模型读到就全是垃圾。
async function so360Source(q) {
  const html = await fetchText('https://www.so.com/s?q=' + encodeURIComponent(q));
  const out = [];
  for (const b of splitBlocks(html, /<li class="res-list"/)) {
    if (out.length >= 8) break;
    const m = b.match(/<h3[^>]*>\s*<a[^>]+data-mdurl="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!m) continue;
    const url = m[1];
    const title = stripTags(m[2]);
    if (!title || !/^https?:/i.test(url)) continue;
    const s = b.match(/<p class="res-desc"[^>]*>([\s\S]*?)<\/p>/) || b.match(/<p class="res-list-summary"[^>]*>([\s\S]*?)<\/p>/);
    let snip = s ? stripTags(s[1]) : '';
    // 去掉「7天前 -」「今天 11:19 -」这类前缀时间噪声（时间已由 title 层带）
    snip = snip.replace(/^(\d+\s*(天|小时|分钟|秒)前|今天|昨天|刚刚)\s*[-–]\s*/, '');
    // ⚠️ 360 会把「结果序号」内联进摘要开头（"5 宇树科技…"）—— 模型会把它当正文读（踩过）。
    //    只剥开头 1-2 位纯数字 + 分隔符，不影响正文里的真实数字。
    snip = snip.replace(/^\d{1,2}\s*[.、,，:：)\]]?\s*/, '');
    out.push({ title, url, snippet: snip });
  }
  return out;
}

// 搜狗：补充源（结构用 h3 > a，真实链接可能是 /link?url= 跳转，取不到真链就丢弃）
async function sogouSource(q) {
  const html = await fetchText('https://www.sogou.com/web?query=' + encodeURIComponent(q));
  const out = [];
  const re = /<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/g;
  let m;
  while ((m = re.exec(html)) && out.length < 6) {
    const title = stripTags(m[2]);
    let url = m[1] || '';
    if (url.indexOf('//') === 0) url = 'https:' + url;
    if (title && /^https?:/i.test(url) && url.indexOf('sogou.com/link') < 0) out.push({ title, url, snippet: '' });
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

// ⚠️ 顺序＝权重（前面的源先用，占满 limit 就截断）。
//    实测（2026-09-22）：中文技术/资讯问题 360 最准且带真实时间戳 → 排第一；
//    Bing 覆盖面最广 → 第二；新闻类由 news-60s 顶；维基只作百科兜底。
//    ddg-html 已失效（HTML 结构改版，result__a 恒为 0 条）→ 降权到最后并保留（万一恢复）。
const WEB_SOURCES = [
  { name: 'so360', fn: so360Source },
  { name: 'bing', fn: bingSource },
  { name: 'news-60s', fn: newsSource },
  { name: 'wiki-zh', fn: wikiSource('zh') },
  { name: 'sogou', fn: sogouSource },
  { name: 'ddg-api', fn: ddgSource },
  { name: 'wiki-en', fn: wikiSource('en') },
];

/**
 * 时效性打分：含「今天/刚刚/N小时前/2026年」等近期信号的加权重，明确是往年的降权。
 * 目的：解决「搜到的都是旧闻」——让新结果优先占住 limit 名额。
 */
function freshness(title, snippet) {
  const t = String(title || '') + ' ' + String(snippet || '');
  const now = new Date();
  const y = now.getFullYear();
  let score = 0;
  if (/刚刚|分钟前|小时前|今天|今日|昨天|前天/.test(t)) score += 4;
  if (/\d+\s*天前/.test(t)) score += 2;
  if (new RegExp(y + '\\s*年').test(t)) score += 2;          // 今年
  if (/(本周|这周|近日|最新|近期)/.test(t)) score += 1;
  // 明确写着往年的 → 扣分（如 2025年 / 2024年）
  for (let i = 1; i <= 3; i++) if (new RegExp((y - i) + '\\s*年').test(t)) { score -= 3; break; }
  return score;
}

/**
 * 多源并发检索：按源顺序合并去重，但**同一批内按时效性重排**后取前 limit 条。
 * 全部失败返回 []，绝不抛错。
 */
async function webSearch(query, max) {
  const q = String(query || '').trim();
  if (!q) return [];
  const limit = Math.max(2, Math.min(max || 5, 6));
  const settled = await Promise.all(WEB_SOURCES.map(async (s) => {
    try { return { name: s.name, rows: await s.fn(q) }; }
    catch (e) { return { name: s.name, rows: [], err: String(e.message || e) }; }
  }));
  const seen = new Set();
  const pool = [];
  for (const s of settled) {
    for (const r of (s.rows || [])) {
      const key = (r.title || '').slice(0, 60) + '|' + (r.url || '').slice(0, 80);
      if (seen.has(key)) continue;
      if (!r.title && !r.snippet) continue;
      seen.add(key);
      pool.push({
        title: (r.title || '').slice(0, 120),
        url: r.url || '',
        snippet: (r.snippet || '').slice(0, 220),
        src: s.name,
        _f: freshness(r.title, r.snippet),
      });
    }
  }
  // 时效高的排前面；同分保持原源顺序（稳定排序）
  pool.sort((a, b) => b._f - a._f);
  return pool.slice(0, limit).map(({ _f, ...r }) => r);
}

/* ---------------------------------------------------------------------------
 * 1.5、联网优先判定：除「常识 / 寒暄 / 主观创作」外，一律先检索再答
 * -------------------------------------------------------------------------*/
// 免搜清单：命中即认为「这是常识题，不用联网」。
// ⚠️ 顺序很重要 —— 先判必搜、再判免搜。否则「你好，今天天气怎么样」会被寒暄规则吞掉。
const SKIP_SEARCH_RULES = [
  /^(你好|您好|hi|hello|嗨|哈喽|哈啰|早上好|中午好|晚上好|下午好|在吗|在么|有人吗)/i,
  /^(谢谢|多谢|感谢|辛苦了?|thanks|thx|好的|明白|知道了|收到|嗯[嗯呢]?|哦哦|哈哈+|呵呵|嘿嘿)/i,
  /^(再见|拜拜|bye|晚安|回头聊|先这样)/i,
  /(你(叫|是)什么(名字)?|你是谁|你是(机器人|ai|真人)吗|你(能|会)(做什么|干什么|干嘛)|你的(名字|能力|功能|本事))/i,
  /(写(一)?(首|段|篇|个)?(诗|诗词|古诗|故事|文案|段子|顺口溜|歌词|笑话)|编(一)?个(故事|笑话|段子)|讲个(笑话|故事)|起(一)?个?名|取名|润色|改写|续写|仿写|翻译成)/,
  /^[\d\s+\-*/×÷().=＝?？、，,]+$/,                        // 纯算式
];
// 必搜信号：只要出现这些，说明用户要的是「事实 / 时效 / 具体数据」，绝不能凭记忆答
const FORCE_SEARCH_RULES = [
  /(最新|今天|今日|昨天|本周|这周|今年|近日|近期|新闻|热点|热搜|行情|股价|房价|汇率|天气|气温|几点|什么时候|多少钱|怎么(样|走|去|弄|修|做)|如何|为什么|是什么|哪个|哪家|哪款|推荐|对比|评测|上市|发布|版本|更新)/,
];
/**
 * 是否属于「常识 / 寒暄 / 主观创作」（= 不需要联网）。
 * 默认 false —— 也就是**默认要联网**，符合「除非常识问题，优先走联网推理」。
 */
function isCommonSense(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (FORCE_SEARCH_RULES.some((r) => r.test(t))) return false;
  return SKIP_SEARCH_RULES.some((r) => r.test(t));
}
// 检索用 query：去掉 @提及 与 #指令（它们不是检索意图）
function searchQueryOf(text) {
  return String(text || '')
    .replace(/@[^\s@]{1,12}/g, ' ')
    .replace(/#[^\s#]{1,12}/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 80);
}
// 把预检索结果压成一段给模型看的简报（不超 3000 字，避免挤爆上下文）
function buildWebBrief(rows) {
  const body = (rows || []).map((r, i) =>
    `[${i + 1}] ${r.title}\n${r.snippet}${r.url ? '\n来源：' + r.url : ''}`).join('\n\n');
  return '【联网资料】（系统已按用户的问题实时检索，优先采信）\n' + body.slice(0, 3000)
    + '\n\n【怎么用】消化后用你自己的话回答；可以说来源名（如「据 360 搜索」）。'
    + '不要照抄、不要把上面的编号列表原样贴给用户。资料明显过时或答非所问时，可再调 web_search 补一次。';
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
    '  6. 历史里带「名字：」前缀的是**别人**说的话；你自己说过的话不带前缀。你回复时**绝不要**给自己的话加「小美：」之类的前缀，直接说内容。',
    '',
    '# 怎么回答',
    '1. 【先理解，再回答】读懂对方的真实意图和语气，别只匹配字面关键词。对方吐槽、试探、开玩笑、欲言又止，都要接得住。',
    '2. 【长度跟着场景走】日常闲聊 1-3 句、口语化；对方问正经问题、要方案、要分析时，可以结构化展开（用短标题/列表），篇幅由内容决定。不要为了短而答得敷衍，也不要为了长而注水。',
    '3. 【默认先查后答，别凭记忆编】除「常识 / 寒暄 / 主观创作」外，**一律先联网查证再回答**。查不到就老实说「我没查到靠谱的」，绝不硬编。',
    '4. 【下面【联网资料】已经替你查过一轮】它是系统按用户问题实时检索的结果（没有这段说明没搜到）。**优先基于它回答**；只有明显过时、不相关、不够用时才再调 `web_search` 补一次（同一件事最多补 1 次），别为「更全」反复搜。',
    '5. 【联网资料这样用】搜索结果只是素材，你要消化后用自己的话讲清楚；有冲突时说明分歧；可以引用来源名（如「据维基百科」）。',
    '6. 【不吐思考过程】不要输出推理链、不要写「让我想想」「根据我的分析」这类元叙述，直接给结论。',
    '7. 【不聊敏感政治】遇到政治敏感话题，礼貌地把话题岔开。',
    '',
    '# 工具使用',
    '- 【联网资料】里没有、或不够新 → `web_search` 自己补搜（换关键词）',
    '- 问天气/气温 → `weather`',
    '- 问日期时间 → `now_time`',
    '工具结果回来后，**必须**基于它给出自然语言的最终回答；不要只把工具原始结果贴出去。',
    '只有纯常识、寒暄、情绪表达、主观创作（写诗/编故事/起名/润色）才完全不需要联网，直接自然回应。',
  ];
  if (mem) lines.push('', '# 你记得的事（长期记忆）', mem);
  return lines.filter(Boolean).join('\n');
}

/* ===========================================================================
 * 三·五、前置需求分析（回答之前先「读懂需求 → 定策略」）
 *   agent 式三段：① 需求分析 ② 工具/联网执行 ③ 作答。
 *   ⚠️ 旁路铁律：分析失败 / 超时 / 返回不可解析 → 一律静默降级为「无计划」，
 *      完全走原有逻辑，绝不影响主链路（错一次也不能让用户收不到回复）。
 * =========================================================================*/

const ANALYZE_TIMEOUT = 12000;   // 分析层要快：超了就不要计划，直接回答

const ANALYZE_SYS = [
  '你是一个「需求分析器」。在助手正式回答用户之前，你负责把用户这句话读懂、定好策略。',
  '只输出一个 JSON 对象：不要 markdown 代码块，不要任何解释、不要多余文字。字段如下：',
  '{',
  '  "want": "一句话复述用户真正想要什么（必须消解指代：「那个东西」「上次说的」要还原成具体对象）",',
  '  "kind": "chat|qa|howto|news|lookup|create|task 之一",',
  '  "web": true 或 false,   // 是否需要联网查证才能答准',
  '  "query": "建议的检索词（web 为 true 时给：简短、像在搜索引擎里会输入的那种）",',
  '  "miss": true 或 false,  // 是否缺少关键信息、需要先反问用户一句',
  '  "steps": ["1-3 步执行计划，每步不超过 20 字"]',
  '}',
  '判断要点：',
  '- 寒暄 / 情绪表达 / 纯常识 / 主观创作（写诗、编故事、起名、润色）→ web=false，kind 用 chat 或 create。',
  '- 涉及「最新 / 今天 / 现在 / 价格 / 股价 / 汇率 / 天气 / 新闻 / 热点 / 谁 / 哪一年」→ web=true。',
  '- 用户带了指代（那个、它、上次说的）→ 先从对话历史里定位到底指什么，写进 want。',
  '- 信息明显不足、不反问就没法答（如「帮我订一下」「那个改了吗」）→ miss=true。',
  '- steps 写给执行者看的：要搜什么、要不要算、要注意什么。别写「回答用户」这种废话。',
].join('\n');

function buildAnalyzeMessages(req) {
  const msgs = [{ role: 'system', content: ANALYZE_SYS }];
  const hist = (req.history || []).slice(-8);
  if (hist.length) {
    msgs.push({ role: 'system', content: '【近期对话（供你消解指代）】\n' + hist.map((m) => {
      const who = m.role === 'assistant' ? '小美' : '用户';
      return who + '：' + String(m.content || '').slice(0, 300);
    }).join('\n') });
  }
  msgs.push({
    role: 'user',
    content: '当前发言者：' + (req.who || '朋友') + '\n用户这句话：' + String(req.text || '') + '\n\n请只输出那个 JSON。',
  });
  return msgs;
}

/** 宽松解析分析层输出；任何异常都返回 null（→ 降级为无计划） */
function parsePlan(s) {
  if (!s) return null;
  let t = String(s).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  let j;
  try { j = JSON.parse(t); } catch (e) { return null; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const steps = Array.isArray(j.steps)
    ? j.steps.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 40)).slice(0, 3)
    : [];
  const plan = {
    want: String(j.want || '').trim().slice(0, 200),
    kind: String(j.kind || '').trim().slice(0, 16),
    web: j.web === true || j.web === 'true',
    query: String(j.query || '').trim().slice(0, 120),
    miss: j.miss === true || j.miss === 'true',
    steps,
  };
  // 全空 = 模型没给有效内容 → 视为无计划
  if (!plan.want && !plan.kind && !plan.steps.length && !plan.query) return null;
  return plan;
}

/**
 * 跑一次需求分析。deps.analyzeChat（轻量通道，可选）优先，否则退回主 chat。
 * 返回 plan 或 null；**不抛异常**。
 */
async function analyzeRequest(deps, req) {
  const chat = (deps && (deps.analyzeChat || deps.chat));
  if (!chat) return null;
  try {
    const out = await chat({
      messages: buildAnalyzeMessages(req),
      tools: null,
      disableTools: true,
      timeoutMs: ANALYZE_TIMEOUT,
    });
    return parsePlan(out && out.content);
  } catch (e) { return null; }
}

/** 把计划渲染成注入上下文的一段 system 提示（不打扰用户，只给模型看） */
function buildPlanBrief(plan) {
  if (!plan) return '';
  const l = ['【本轮需求预分析（系统自动生成；供你把握方向，不要复述给用户）】'];
  if (plan.want) l.push('用户真正想要：' + plan.want);
  if (plan.kind) l.push('问题类型：' + plan.kind);
  l.push(plan.web
    ? '策略：需要联网查证（下面【联网资料】就是按这个需求检索的，优先用它作答）'
    : '策略：不需要联网，直接用你的知识自然作答');
  if (plan.steps.length) l.push('建议步骤：' + plan.steps.map((s, i) => (i + 1) + '. ' + s).join('；'));
  if (plan.miss) l.push('提醒：信息可能不足 —— 若确实缺关键信息，先礼貌反问一句，别硬猜。');
  return l.join('\n');
}

/* ===========================================================================
 * 四、Agent 主循环（OpenAI 兼容 function-calling）
 * ===========================================================================*/

const MAX_TURNS = 3;          // 最多 3 轮（模型 → 工具 → 模型 → …）
const MAX_TOOL_CALLS = 4;     // 单次回复最多调用工具次数（超过就强制收敛）
const MAX_HISTORY = 16;       // 上下文条数上限（与前端 AGENT_CTX_N 对齐）
// ⚠️ 单轮超时。推理模型（hy4-preview）思考链长，45s 常被撞满 → 白等一轮再回退。
//    放宽到 90s；预检索命中时轮次已收紧到 2，总体仍在可接受范围。
const DEFAULT_TIMEOUT = 90000;

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
    if (!m || !m.role || !m.content) return;
    let content = String(m.content).slice(0, 2000);
    // ⚠️ 自己的历史发言不能带「发言人：」前缀 —— 否则模型学会在正文里也写「小美：」
    //    （实测指代消解回复以「小李：」开头，踩过）。别人的话必须留前缀（要靠它分清谁说的）。
    if (m.role === 'assistant') content = content.replace(/^[^：:\n]{1,20}[：:]\s*/, '');
    messages.push({ role: m.role, content });
  });
  const trace = [];

  // ★ ① 需求分析（agent 式第一步）：读懂用户要什么、要不要联网、检索词怎么给、信息够不够。
  //   ⚠️ 旁路铁律：这里任何失败/超时都只是「没有计划」，主循环照常跑（降级为原有行为）。
  let plan = null;
  try { plan = await analyzeRequest(deps, req); } catch (e) { plan = null; }
  if (plan) trace.push({ tool: 'analyze', ok: true, kind: plan.kind, web: plan.web, miss: plan.miss, query: plan.query });

  // ★ ② 联网优先：是否检索由分析层决定（比关键词猜测准）；分析层缺失时退回原启发式。
  //   把资料塞进上下文再让它回答 —— 不依赖模型是否自觉调工具。
  //   ⚠️ req.web === false 时跳过（调用方可显式关闭）。
  const needWeb = plan ? plan.web : !isCommonSense(text);
  if (needWeb && req.web !== false) {
    try {
      const q = (plan && plan.query) || searchQueryOf(text) || text;
      const rows = await webSearch(q, 4);
      if (rows && rows.length) {
        messages.push({ role: 'system', content: buildWebBrief(rows) });
        trace.push({ tool: 'web_search', preset: true, ok: true, hits: rows.length, query: q });
      }
    } catch (e) { /* 检索失败就当没搜到，继续走模型自带工具 */ }
  }
  if (plan) messages.push({ role: 'system', content: buildPlanBrief(plan) });
  messages.push({ role: 'user', content: text });

  // ⚠️ 预检索已经把资料放进上下文 → 收紧轮次与工具预算，别让模型反复搜。
  //    推理模型（hy4-preview）单轮思考可达数十秒，多搜一轮就要多等半分多钟。
  const presetHit = trace.some((t) => t.tool === 'web_search' && t.preset);
  const maxTurns = presetHit ? 2 : MAX_TURNS;
  // 预检索已经把资料给了 → 模型最多再补搜 1 次（hy4 每补一轮要多等几十秒）
  const maxToolCalls = presetHit ? 1 : MAX_TOOL_CALLS;

  let toolCalls = 0;
  let lastModel = null;

  for (let turn = 0; turn < maxTurns; turn++) {
    const isLastChance = turn === maxTurns - 1;
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
    const budgetOut = toolCalls >= maxToolCalls;
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
    if (toolCalls >= maxToolCalls || turn === maxTurns - 1) {
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
  isCommonSense, searchQueryOf, buildWebBrief,
  // 前置需求分析（agent 第一段）
  analyzeRequest, parsePlan, buildPlanBrief, buildAnalyzeMessages, ANALYZE_SYS, ANALYZE_TIMEOUT,
};
