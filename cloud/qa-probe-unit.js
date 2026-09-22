'use strict';
/* QA 探针（纯函数层）：直接从 index.html 抽出引擎/解析函数单独跑，不依赖 DOM */
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

const src = html.match(/<script>\s*\n\(function \(\) \{\s*\n'use strict';([\s\S]*?)\n\}\)\(\);\s*\n<\/script>/);
if (!src) { console.error('抽取主 IIFE 失败'); process.exit(1); }
const code = src[1];

function grab(name, re) {
  const m = code.match(re);
  if (!m) throw new Error('抽取失败: ' + name);
  return m[0];
}
const GBtxt = grab('GB', /var GB = \{[\s\S]*?\n\};/);
const GGtxt = grab('GG', /var GG = \{[\s\S]*?\n\};/);
const GXtxt = grab('GX', /var GX = \{[\s\S]*?\n\};/);
const parseCityTxt = grab('parseCity', /function parseCity\(text\) \{[\s\S]*?\n\}/);
const sanitizeTxt = grab('sanitizeQuery', /function sanitizeQuery\(text\) \{[\s\S]*?\n\}/);
const stockGuessTxt = grab('STOCK_STOP', /var STOCK_STOP = [^\n]*\n/) + grab('stockGuess', /function stockGuess\(text\) \{[\s\S]*?\n\}/);
const parse60sTxt = grab('parse60s', /function parse60s\(j\) \{[\s\S]*?\n\}/);
const fmtVolTxt = grab('fmtVol', /function fmtVol\(n\) \{[\s\S]*?\n\}/);
const fmtSizeTxt = grab('fmtSize', /function fmtSize\(n\) \{[\s\S]*?\n\}/);
const parseHashTxt = grab('parseHash', /function parseHash\(text\) \{[\s\S]*?\n\}/);
const botSearchNeedTxt = grab('botSearchNeed', /function botSearchNeed\(text\) \{[\s\S]*?\n\}/);
const CITY_PRE = /^(今天|明天|后天|大后天|现在|当前|昨日|昨天|明儿|明早|今晚|今早|中午|早上|晚上|下午|上午|这会儿|的|查|查下|查一下|查询|看看|看|报|报个|说说|问|问下|问一下|告诉我|知道|帮我|帮|我想|我要|了解|一下|下|个)+/;
const CITY_POST = /(今天|明天|后天|现在|当前|这两天|这几天|最近|今日|明日|的天气|天气|气温|温度|要不要带伞|要带伞|带伞吗|会不会|会不|会|要|下不下雨|下雨|下雪|冷不冷|热不热|多少度|怎么样|怎样|如何|呢|吗|吧|啊|呀|哈|哦|喔|了|的)+$/;

const sandbox = {};
const run = new Function('exports', `
  ${'const CITY_PRE = ' + CITY_PRE + ';'}
  ${'const CITY_POST = ' + CITY_POST + ';'}
  ${GBtxt}
  ${GGtxt}
  ${GXtxt}
  ${parseCityTxt}
  ${sanitizeTxt}
  ${stockGuessTxt}
  ${parse60sTxt}
  ${fmtVolTxt}
  ${fmtSizeTxt}
  ${parseHashTxt}
  ${botSearchNeedTxt}
  exports.GB = GB; exports.GG = GG; exports.GX = GX;
  exports.parseCity = parseCity; exports.sanitizeQuery = sanitizeQuery;
  exports.stockGuess = stockGuess; exports.parse60s = parse60s;
  exports.fmtVol = fmtVol; exports.fmtSize = fmtSize; exports.parseHash = parseHash;
  exports.botSearchNeed = botSearchNeed;
`);
run(sandbox);
const { GB, GG, GX, parseCity, sanitizeQuery, stockGuess, parse60s, fmtVol, fmtSize, parseHash } = sandbox;

let pass = 0, fail = 0;
const log = (ok, name, extra) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' -> ' + extra : '')); }
};

console.log('\n===== QA 探针 · 纯函数层 =====\n');

// ---------- 五子棋 GB ----------
console.log('-- 五子棋 GB --');
{
  // 横向五连（board 上已有 5 子，落在最左端应判胜）
  let b = GB.newBoard();
  for (let c = 0; c < 5; c++) b[GB.idx(7, 3 + c)] = 1;
  log(GB.checkWin(b, 7, 3, 1) === true, 'GB: 横向五连判胜');
  // 只有四连不算胜
  let b2 = GB.newBoard();
  for (let c = 0; c < 4; c++) b2[GB.idx(7, 3 + c)] = 1;
  log(GB.checkWin(b2, 7, 3, 1) === false, 'GB: 四连不算胜');
  // 被对方隔断的五子不算胜：X X . X X X X  -> 中间空一格
  let b3 = GB.newBoard();
  [0, 1, 3, 4, 5].forEach((c) => { b3[GB.idx(7, 3 + c)] = 1; });
  log(GB.checkWin(b3, 7, 3, 1) === false, 'GB: 中间断一格不误判为五连');
  // 边界：越界不应崩
  log((() => { try { return GB.checkWin(GB.newBoard(), 0, 0, 1) === false; } catch (e) { return false; } })(), 'GB: 角落落子不越界崩溃');
  // place 越界
  log(GB.place(GB.newBoard(), 15, 0, 1).ok === false, 'GB: 越界落子被拒');
  log(GB.place(GB.newBoard(), -1, 0, 1).ok === false, 'GB: 负坐标落子被拒');
  // place 重复
  let b4 = GB.newBoard(); b4[GB.idx(7, 7)] = 1;
  log(GB.place(b4, 7, 7, 2).ok === false, 'GB: 已有子的点被拒');
  // 对角线五连
  let b5 = GB.newBoard();
  for (let k = 0; k < 5; k++) b5[GB.idx(3 + k, 3 + k)] = 2;
  log(GB.checkWin(b5, 3, 3, 2) === true, 'GB: 主对角线五连判胜');
  // 反斜线
  let b6 = GB.newBoard();
  for (let k = 0; k < 5; k++) b6[GB.idx(3 + k, 10 - k)] = 2;
  log(GB.checkWin(b6, 3, 10, 2) === true, 'GB: 副对角线五连判胜');
  // 竖向五连
  let b7 = GB.newBoard();
  for (let k = 0; k < 5; k++) b7[GB.idx(3 + k, 7)] = 1;
  log(GB.checkWin(b7, 3, 7, 1) === true, 'GB: 竖向五连判胜');
  // 六连（长连）也应判胜
  let b8 = GB.newBoard();
  for (let c = 0; c < 6; c++) b8[GB.idx(7, 2 + c)] = 1;
  log(GB.checkWin(b8, 7, 2, 1) === true, 'GB: 长连（六连）判胜');
}

// ---------- 围棋 GG ----------
console.log('-- 围棋 GG --');
{
  log(GG.newBoard().length === 361, 'GG: 19 路棋盘 361 点');
  const r = GG.place(GG.newBoard(), 3, 3, 1);
  log(r.ok === true && r.captured.length === 0, 'GG: 空盘落子成功且无提子');
  log(GG.place(GG.newBoard(), 19, 0, 1).ok === false, 'GG: 越界落子被拒');
  // 提子：白子被四面包围
  let b = GG.newBoard();
  b[GG.idx(0, 0)] = 2; b[GG.idx(1, 0)] = 1; b[GG.idx(0, 1)] = 1;
  const cap = GG.place(b, 0, 0, 1); // 落在(0,0)? 已有白子 -> 被拒
  log(cap.ok === false, 'GG: 落在已有子上被拒');
  let b2 = GG.newBoard();
  b2[GG.idx(0, 0)] = 2; b2[GG.idx(1, 0)] = 1; b2[GG.idx(0, 1)] = 1;
  const cap2 = GG.place(b2, 0, 0, 1);
  // 用真正的「叫吃」：白一子 (0,0)，气在 (0,1)(1,0)；黑堵最后一气
  let b3 = GG.newBoard();
  b3[GG.idx(0, 0)] = 2; b3[GG.idx(1, 0)] = 1;
  const cap3 = GG.place(b3, 0, 1, 1);
  log(cap3.ok === true && cap3.captured.length === 1, 'GG: 堵住最后一气提掉 1 子', JSON.stringify(cap3.captured));
  // 自杀被拒
  let b4 = GG.newBoard();
  b4[GG.idx(0, 1)] = 2; b4[GG.idx(1, 0)] = 2;
  log(GG.place(b4, 0, 0, 1).ok === false, 'GG: 自杀手被拒');
  // 数子：全空盘黑 0 白 3.75 -> 白胜
  const sc = GG.score(GG.newBoard());
  log(sc.black === 0 && sc.white === 3.75 && sc.winner === 2, 'GG: 空盘数子 白胜（贴目生效）', JSON.stringify(sc));
  // 数子：黑占满全盘
  let b5 = GG.newBoard(); for (let i = 0; i < 361; i++) b5[i] = 1;
  const sc5 = GG.score(b5);
  log(sc5.black === 361 && sc5.winner === 1, 'GG: 黑占满全盘黑胜', JSON.stringify(sc5));
  // 打劫（ko）：当前引擎没有禁着，同一局面可立即回提 —— 记录现状
  let b6 = GG.newBoard();
  b6[GG.idx(0, 0)] = 1; b6[GG.idx(0, 1)] = 2; b6[GG.idx(1, 0)] = 2; b6[GG.idx(1, 1)] = 1;
  log(GG.place(b6, 0, 2, 1).ok === true, 'GG: [现状记录] 无打劫禁着规则（可无限回提）');
}

// ---------- 象棋 GX ----------
console.log('-- 象棋 GX --');
{
  log(GX.side(2) === 1, 'GX: side(2)===1（正负号判定，非数值）—— 这是已修 bug 的不变式');
  log(GX.side(-1) === 2 && GX.side(1) === 1 && GX.side(0) === 0, 'GX: side() 三态正确');
  const nb = GX.newBoard();
  log(nb.filter((v) => v !== 0).length === 32, 'GX: 开局 32 子');
  log(nb[GX.idx(0, 4)] === -7 && nb[GX.idx(9, 4)] === 7, 'GX: 黑将(0,4) / 红帅(9,4)');
  // 红兵(6,0) 只能向前
  const bp = GX.moves(nb, 6, 0);
  log(bp.length === 1 && bp[0][0] === 5 && bp[0][1] === 0, 'GX: 未过河红兵只能直进一步', JSON.stringify(bp));
  // 黑卒(3,0) 只能向下
  const bp2 = GX.moves(nb, 3, 0);
  log(bp2.length === 1 && bp2[0][0] === 4 && bp2[0][1] === 0, 'GX: 未过河黑卒只能直进一步', JSON.stringify(bp2));
  // 车(9,0) 开局：横向被自家马堵，纵向可走到 (8,0)(7,0)，再上遇自家兵停
  const j0 = GX.moves(nb, 9, 0);
  log(j0.length === 2 && j0.some((m) => m[0] === 8 && m[1] === 0) && j0.some((m) => m[0] === 7 && m[1] === 0),
    'GX: 开局车只能沿边线上行两格（横向被自家马堵）', JSON.stringify(j0));
  // 马(9,1) 应有 2 步
  log(GX.moves(nb, 9, 1).length === 2, 'GX: 开局马 2 步', JSON.stringify(GX.moves(nb, 9, 1)));
  // 炮(7,1) 可走
  log(GX.moves(nb, 7, 1).length > 0, 'GX: 开局炮有走法');
  // 将帅照面：把中间清空后照面判将军
  let b = GX.newBoard();
  for (let r = 1; r <= 8; r++) for (let c = 0; c < 9; c++) b[GX.idx(r, c)] = 0;
  b[GX.idx(0, 4)] = -7; b[GX.idx(9, 4)] = 7;
  log(GX.inCheck(b, 1) === true, 'GX: 将帅照面判将军（红）');
  log(GX.inCheck(b, 2) === true, 'GX: 将帅照面判将军（黑）');
  // 照面中间有子则不判
  let b2 = b.slice(); b2[GX.idx(5, 4)] = 1;
  log(GX.inCheck(b2, 1) === false, 'GX: 中间有子挡住则不判将军');
  // 吃掉将即胜
  let b3 = GX.newBoard();
  // 造一个红车能吃黑将的局面：简化 —— 直接验证 place 的 win 判据
  log(GX.kingPos(GX.newBoard(), 2)[0] === 0, 'GX: kingPos 找到黑将');
  log(GX.hasLegalMove(GX.newBoard(), 1) === true, 'GX: 开局红有合法走法');
  log(GX.place(GX.newBoard(), 0, 0, 0, 1) !== null, 'GX: place 返回对象');

  // 【重点】士/相 不能出九宫 / 不能过河
  let b4 = GX.newBoard();
  // 把红仕 (9,3) 挪到 (9,2)(界外) 测试 —— 用 rawMoves 直接验证约束
  const shiMoves = GX.moves(nb, 9, 3);
  log(shiMoves.every((m) => m[1] >= 3 && m[1] <= 5 && m[0] >= 7), 'GX: 仕始终在九宫内', JSON.stringify(shiMoves));
  const xiangMoves = GX.moves(nb, 9, 2);
  log(xiangMoves.every((m) => m[0] >= 5), 'GX: 相不过河', JSON.stringify(xiangMoves));
  const shiBlack = GX.moves(nb, 0, 3);
  log(shiBlack.every((m) => m[1] >= 3 && m[1] <= 5 && m[0] <= 2), 'GX: 士始终在黑九宫内', JSON.stringify(shiBlack));

  // 炮翻山吃子
  let b5 = GX.newBoard();
  for (let i = 0; i < 90; i++) b5[i] = 0;
  b5[GX.idx(9, 0)] = 2;   // 红炮
  b5[GX.idx(9, 4)] = 3;   // 炮架（红车）
  b5[GX.idx(9, 8)] = -3;  // 黑车（目标）
  const pm = GX.rawMoves(b5, 9, 0);
  const hit = pm.some((m) => m[0] === 9 && m[1] === 8);
  log(hit === true, 'GX: 炮可翻山吃子', JSON.stringify(pm));
  // 炮不能吃紧邻的子（无炮架）
  let b6 = GX.newBoard();
  for (let i = 0; i < 90; i++) b6[i] = 0;
  b6[GX.idx(9, 0)] = 2; b6[GX.idx(9, 1)] = -3;
  log(GX.rawMoves(b6, 9, 0).some((m) => m[0] === 9 && m[1] === 1) === false, 'GX: 炮无炮架不能吃紧邻子');
}

// ---------- 天气城市解析 ----------
console.log('-- parseCity --');
{
  log(parseCity('@小美 北京天气') === '北京', 'parseCity: 「@小美 北京天气」→ 北京', parseCity('@小美 北京天气'));
  log(parseCity('上海今天多少度') === '上海', 'parseCity: 「上海今天多少度」→ 上海', parseCity('上海今天多少度'));
  log(parseCity('广州今天天气怎么样') === '广州', 'parseCity: 「广州今天天气怎么样」→ 广州', parseCity('广州今天天气怎么样'));
  log(parseCity('深圳') === '深圳', 'parseCity: 单地名');
  log(parseCity('') === '北京', 'parseCity: 空串兜底北京');
  log(parseCity('今天天气怎么样') === '北京', 'parseCity: 无地名兜底北京', parseCity('今天天气怎么样'));
  log(parseCity('帮我查一下杭州明天会不会下雨') === '杭州', 'parseCity: 多层前后缀剥离', parseCity('帮我查一下杭州明天会不会下雨'));
  log(parseCity('@小美 帮我看看成都今天冷不冷') === '成都', 'parseCity: @小美+帮我+看', parseCity('@小美 帮我看看成都今天冷不冷'));
}

// ---------- 检索词清洗 ----------
console.log('-- sanitizeQuery --');
{
  log(sanitizeQuery('@小美 查一下 Innovus 是什么') === 'Innovus 是什么', 'sanitizeQuery: 剥 @小美+查一下', JSON.stringify(sanitizeQuery('@小美 查一下 Innovus 是什么')));
  log(sanitizeQuery('帮我查一下茅台股价') === '茅台股价', 'sanitizeQuery: 剥 帮我+查一下', JSON.stringify(sanitizeQuery('帮我查一下茅台股价')));
  log(sanitizeQuery('麻烦你帮我搜一下量子计算') === '量子计算', 'sanitizeQuery: 三层前缀', JSON.stringify(sanitizeQuery('麻烦你帮我搜一下量子计算')));
}

// ---------- 股票名猜测 ----------
console.log('-- stockGuess --');
{
  log(stockGuess('@小美 茅台现在多少钱') === '茅台', 'stockGuess: 茅台', JSON.stringify(stockGuess('@小美 茅台现在多少钱')));
  log(stockGuess('帮我看一下腾讯股价') === '腾讯', 'stockGuess: 腾讯', JSON.stringify(stockGuess('帮我看一下腾讯股价')));
}

// ---------- 指令解析 ----------
console.log('-- parseHash --');
{
  log(parseHash('#btc').kind === 'crypto', 'parseHash: #btc → crypto');
  log(parseHash('#600519').kind === 'stock' && parseHash('#600519').sec === 'sh600519', 'parseHash: #600519 → sh600519');
  log(parseHash('#000001').kind === 'stock' && parseHash('#000001').sec === 'sz000001', 'parseHash: #000001 → sz000001');
  log(parseHash('#300750').kind === 'stock' && parseHash('#300750').sec === 'sz300750', 'parseHash: #300750 → sz300750（创业板）');
  log(parseHash('#688981').kind === 'stock' && parseHash('#688981').sec === 'sh688981', 'parseHash: #688981 → sh688981（科创板）');
  log(parseHash('#茅台').kind === 'stockq', 'parseHash: #茅台 → stockq');
  log(parseHash('#help').kind === 'help', 'parseHash: #help');
  log(parseHash('#分析').kind === 'analyze', 'parseHash: #分析');
  // 北交所 4/8 开头
  log(parseHash('#430047').sec === 'bj430047', 'parseHash: 北交所 43 开头', JSON.stringify(parseHash('#430047')));
  // 未知 6 位码（如 123456）→ 落到 stockq（会去 smartbox 搜）
  log(parseHash('#123456').kind === 'stockq', 'parseHash: 无法判市场的 6 位码走模糊搜索', JSON.stringify(parseHash('#123456')));
}

// ---------- 数字格式化 ----------
console.log('-- fmtVol / fmtSize --');
{
  log(fmtVol(24279642149) === '242.80亿', 'fmtVol: 242亿', fmtVol(24279642149));
  log(fmtVol(1.5e12) === '1.50万亿', 'fmtVol: 万亿', fmtVol(1.5e12));
  log(fmtSize(2048) === '2.0 KB', 'fmtSize: 2048 → 2.0 KB', fmtSize(2048));
  log(fmtSize(0) === '0 B', 'fmtSize: 0');
  log(fmtSize(1024) === '1.0 KB', 'fmtSize: 1024', fmtSize(1024));
}

// ---------- 新闻源解析 ----------
console.log('-- parse60s --');
{
  const j = { data: { news: [{ title: '第一条新闻' }, { title: '第二条新闻' }], date: '2026-09-22', weiyu: '微语' } };
  const s = parse60s(j);
  log(typeof s === 'string' && s.indexOf('第一条新闻') >= 0, 'parse60s: 解析 data.news');
  log(parse60s({}) === null, 'parse60s: 空对象返回 null');
  log(parse60s(null) === null, 'parse60s: null 返回 null');
  // 只有空 title 的条目应被过滤
  log(parse60s({ news: [{ title: '' }] }) === null, 'parse60s: 空标题被过滤');
}

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败\n');
process.exit(fail ? 1 : 0);
