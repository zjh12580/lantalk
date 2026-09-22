# 小美接入 DeepSeek 大模型 —— 技术方案

> 目标：把当前「关键词规则 + 固定话术」的小美，升级为真正能对话、能接梗、能答疑的 AI 助手。
> 环境约束：**纯静态托管**（无自建后端），后端只有 WorkBuddy Cloud（Postgres + 对象存储 + 用户体系）。

---

## 一、现状与差距

| 维度 | 现状 | 目标 |
|---|---|---|
| 回复机制 | `botAnswer()` 正则匹配 + `BOT_LINES` 随机话术 | LLM 生成自然语言 |
| 知识范围 | 内置笑话/故事/诗词/天气/新闻（假数据） | 任意话题 |
| 记忆 | 无，每次独立 | 多轮上下文 |
| 触发 | @小美 / 私聊小美 | 不变（已按需求关掉主动冒泡） |

**核心矛盾**：DeepSeek API 需要一个 **API Key**，而静态前端把 Key 写进 `index.html` = 全互联网可见，会被盗刷。

---

## 二、方案对比

### 方案 A：WorkBuddy Cloud Service 免密钥 LLM（推荐）

WorkBuddy 云端已提供 **keyless LLM** 能力（`workbuddy_cloudservice_llm_list_models` 可列模型），本质是平台代管 Key、按 appId 鉴权，前端拿到的是短期票据而非真实密钥。

- **优点**：零密钥泄漏风险；无需自建服务；与现有 `db` 客户端同源，一个 SDK 搞定；可限流。
- **缺点**：模型由平台托管，未必是 DeepSeek 原版（需先查可用模型列表）；有平台配额。
- **适用**：本项目首选。

```
前端  --(SDK, appId 鉴权)-->  WorkBuddy Cloud LLM Gateway  -->  模型(DeepSeek/其他)
```

### 方案 B：自建轻量代理（可控性最高）

用 **Node.js / Serverless Function** 做一层转发，Key 只存在服务端环境变量。

- **优点**：可锁定 `deepseek-chat`、可记录 token 消耗、可做敏感词过滤、可注入人设 prompt。
- **缺点**：需要一个能跑 Node 的托管（Vercel / 腾讯云函数 / 自建），运维成本 +1。
- **适用**：要对模型版本/成本做强管控时。

```
前端 --(POST /api/chat)--> 代理(Node) --(Bearer DEEPSEEK_KEY)--> api.deepseek.com
                            └── Key 存环境变量，前端永远看不到
```

### 方案 C：本地直连（已废弃）

早期局域网版跑在用户自己机器上，Key 存本地 `config.json`，由本地 Node 直接转发。

- **现状**：局域网版已随本次整理下线，方案 C 不再适用。云端版一律走服务端代理，Key 不出服务端。

---

## 三、推荐落地方案（A 为主，B 为备）

### 3.1 先确认平台可用模型

```js
// 一次性探查，确认是否有 deepseek 系模型
await LT.cloud.llm.listModels();
```

- 若有 DeepSeek 系 → 直接切 A。
- 若没有 → 走 **B**，或 A 用平台现有模型（对用户体验无差异，小美只需要「会说话」）。

### 3.2 改造 `botReply()`：同步规则 → 异步 LLM

现状（`index.html` 约 875 行）：

```js
function botReply(conv, text, who) {
  botTyping(conv);
  var ans = botAnswer(text, who, conv);          // 同步
  Promise.resolve(ans).then(function (s) { ... botSay(conv, out); });
}
```

改造要点：**保持函数签名和 `Promise` 链路不变**，只把 `botAnswer` 内部换成 LLM 调用 —— 上层 `botSay` / `botLeader` / 防重复逻辑全部零改动。

```js
// 新增：LLM 调用（走 Cloud Service，无密钥）
function botLLM(messages) {
  return LT.cloud.llm.chat({
    model: 'deepseek-chat',                       // 或平台实际模型 id
    messages: messages,
    temperature: 0.8,
    max_tokens: 300,
  }).then(function (r) { return (r && r.content) || ''; });
}

// 人设 System Prompt
var XIAOMEI_SYS =
  '你是「小美」，云聊聊天室的气氛组组长，24 小时在线。\n' +
  '性格：活泼、俏皮、爱接梗但不油腻，偶尔自称「本小姐」。\n' +
  '规则：\n' +
  '1. 回复控制在 80 字以内，口语化，不要 markdown 列表。\n' +
  '2. 群聊里只回应 @你的人，别抢别人话头。\n' +
  '3. 不确定的事就大方承认，别编造事实。\n' +
  '4. 涉及政治敏感、违法、色情内容一律礼貌拒绝并转移话题。\n' +
  '5. 可以用 emoji，但一条最多 3 个。';

function botReply(conv, text, who) {
  if (!conv) return;
  botTyping(conv);
  var ctx = botCtx(conv, who);                    // 组装最近 N 条历史
  Promise.resolve(botLLM([{ role: 'system', content: XIAOMEI_SYS }].concat(ctx)))
    .then(function (s) {
      var bar = $('#typBar'); if (bar) bar.classList.add('hidden');
      var out = s || botPick(BOT_LINES);          // LLM 失败 → 回退固定话术
      return botSay(conv, out);
    })
    .catch(function () {
      var bar = $('#typBar'); if (bar) bar.classList.add('hidden');
      return botSay(conv, '哎呀，我这边卡了一下，{n}再说一遍好不好 🥺'.replace(/\{n\}/g, who || '你'));
    });
}
```

### 3.3 组装多轮上下文 `botCtx()`

```js
function botCtx(conv, who) {
  var arr = (S.msgs[conv] || []).slice(-8);       // 最近 8 条足够，省 token
  var out = arr.map(function (m) {
    var isBot = m.sender_id === BOT.id;
    var nm = isBot ? '小美' : (m.sender_name || '用户');
    return { role: isBot ? 'assistant' : 'user', content: nm + '：' + (m.text || '[图片]') };
  });
  if (!out.length) out.push({ role: 'user', content: (who || '用户') + '：' + text });
  return out;
}
```

### 3.4 双重限流（防止刷爆配额）

```js
var LLM_LIMIT = { min: 3000, last: 0, day: 0, dayKey: '' };   // 3 秒/次 + 每日次数上限

function botLLMGuarded(messages) {
  var now = Date.now();
  var key = new Date().toISOString().slice(0, 10);
  if (key !== LLM_LIMIT.dayKey) { LLM_LIMIT.dayKey = key; LLM_LIMIT.day = 0; }
  if (now - LLM_LIMIT.last < LLM_LIMIT.min) return Promise.resolve('');  // 太频 → 沉默
  if (LLM_LIMIT.day >= 500) return Promise.resolve('本小姐今天话太多啦，明天再聊 🌸');
  LLM_LIMIT.last = now; LLM_LIMIT.day++;
  return botLLM(messages);
}
```

> 服务端限流（方案 B）更可靠：以 `uid` 为维度，DB 记 `llm_usage(uid, day, count)`。

### 3.5 保留降级链路

```
LLM 可用 ──→ 大模型回复
   │失败/超时(6s)
   ▼
内置规则 botAnswer（笑话/诗词/天气）  ← 现有能力全部保留，作为兜底
   │也无匹配
   ▼
BOT_LINES 随机话术
```

这样即使 Key 失效、网络抖动、模型限流，小美也不会「哑巴」，体验不降级。

---

## 四、成本估算（方案 B，DeepSeek 官方价）

| 项 | 值 |
|---|---|
| 模型 | `deepseek-chat`（V3） |
| 上下文 | ~8 条历史 + system ≈ 600 tokens |
| 输出 | ≤ 300 tokens |
| 单次成本 | 约 ¥0.002 ~ 0.004（缓存命中更低） |
| 1000 次/天 | 约 ¥2 ~ 4 / 天 |

对内部聊天室规模（日活几十人）**几乎可以忽略**。

---

## 五、合规与安全清单

- [ ] **密钥绝不出现在前端**（方案 A 无此问题；方案 B 走环境变量）
- [ ] System Prompt 内写明：拒绝政治敏感 / 违法 / 色情内容
- [ ] 对 LLM 输出做长度截断（≤ 500 字）再入库，防超大内容
- [ ] 输出侧继续走现有 `esc()` 转义渲染，防 XSS（现有链路已覆盖）
- [ ] 服务端以 `uid` 限流 + 日配额，防单用户刷爆
- [ ] 记录调用日志（uid / 时间 / token），便于审计与成本分析

---

## 六、实施步骤（建议顺序）

1. **探查**：`LT.cloud.llm.listModels()` 确认可用模型 → 定 A 还是 B
2. **改造**：替换 `botReply()`，新增 `botLLM` / `botCtx` / `botLLMGuarded`
3. **降级**：保留 `botAnswer` 作为兜底，串成三级链路
4. **限流**：前端节流 + （方案 B 时）服务端配额
5. **联调**：扩充 `test-load.js` —— mock LLM 返回，断言「@小美 → 走 LLM → 消息入库」
6. **发布**：`git fetch` + merge dev → 部署 → 线上验证

---

## 七、一句话结论

**首选方案 A（WorkBuddy Cloud 免密钥 LLM）**：零密钥风险、零后端运维、与现有 SDK 同源；
若平台无 DeepSeek 系模型或需强管控成本，再切 **方案 B（Node 代理）**。
无论哪条路，都保留现有规则引擎作为降级兜底，保证小美「永不掉线」。
