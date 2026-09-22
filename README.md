# LanTalk · 云聊

聊天应用，**云端版单一代码库**：邮箱登录、数据存云端 Postgres + 对象存储、带 AI 伙伴「小美」。

| 项 | 说明 |
|----|------|
| 访问 | <https://lan-talk-v2.app.workbuddy.host/>（最新改动）· <https://lan-talk.app.workbuddy.host/>（旧版旧数据） |
| 数据存储 | 云端 Postgres（6 张表，均已开启 RLS）+ 云端对象存储 |
| 身份 | 邮箱登录（验证码 / 密码），登录后设置昵称 |
| 实时性 | 轮询拉取（前台约 2.5 秒一轮，后台退避到 30 秒） |
| 代码位置 | `cloud/` |

> 两个域名是相互独立的环境，账号数据不互通。

---

## 功能一览

| 分类 | 能力 |
|------|------|
| 进入 | 邮箱登录（验证码 / 密码）、昵称唯一校验、表情头像（48 个可选）/ 昵称首字头像、个性签名 |
| 聊天 | 大厅公共频道、私聊、群聊、文字/表情/图片/文件（≤25MB）、**Ctrl+V 直接粘贴截图发送**、引用回复、消息撤回（2 分钟内）、**点头像即开私聊** |
| 已读 | 私聊每条自己的消息显示「已读 / 未读」；群聊自己的最后一条显示「N/M 已读」；未读红点、未读筛选、打开会话自动标记已读 |
| 群聊 | 建群（可直接从大厅成员里点选）、邀请、踢人、退出、解散、改群名、群公告、群成员、**消息免打扰** |
| 提醒 | **@某人 / @全体成员**（消息红框高亮 + 桌面通知 + 提示音 + 侧栏"[有人@我]"）、未读红点、标签页未读数、OneSignal Web Push |
| 好友 | 搜昵称加好友、好友申请/接受/拒绝、备注名、删除好友 |
| 智能体 | 「小美」AI 伙伴：真 LLM Agent 主循环 + function calling（联网检索 / 天气 / 时间），多模型通道自动回退 |
| 聊天洞察 | 情绪 / 意图 / 好感 / 回复质量结构化打分，并按聊天记录生成 3 条建议话术 |
| 小游戏 | 五子棋 / 围棋 / 象棋对局，邀请卡片随对局状态实时更新 |
| 其他 | 一起看直播、正在输入提示、在线状态、历史消息分页、跨会话消息搜索、聊天记录导出/导入、深色/浅色主题 |

---

## 目录结构

```
cloud/
├── index.html                # 单文件前端（含样式与全部逻辑）
├── server.js                 # 静态托管 + /api/intent、/api/chat、/api/analyze 代理（密钥只留服务端）
├── agent.js                  # 小美智能体引擎：多源联网检索 + 工具定义 + Agent 主循环
├── OneSignalSDKWorker.js     # Web Push Service Worker
├── test-load.js              # 云端版逻辑冒烟（jsdom + 桩 SDK）
├── test-intent.js            # 意图识别与 LLM 通道链冒烟
└── assets/                   # 内置图片素材
```

---

## 环境要求

| 用途 | 依赖 |
|------|------|
| 运行 | Node.js **16+**（`server.js` 只用内置模块，无第三方运行时依赖） |
| 跑测试 | Node.js + `jsdom`（首次 `npm install` 装一次） |

```bash
npm install
```

---

## 跑测试

```bash
npm test              # 全量（test-load 379 项 + test-intent）
npm run test:load     # 只跑云端版逻辑冒烟
npm run test:intent   # 只跑意图识别 / 模型通道
```

`test-load.js` 用 jsdom 加载真实页面、注入桩 SDK，覆盖登录 → 设昵称 → 进大厅 → 发消息 → 撤回 → 建群 → 好友 → 下棋 → 围棋 → 输入面板等全流程。
**改动 `cloud/index.html` 后务必先跑通再发布。**

---

## 本地起服务（可选）

```bash
npm start              # 等价于 node cloud/server.js，默认 8080
PORT=9000 npm start
```

> ⚠️ 云端 SDK 只在应用自己的 HTTPS 域名下工作，用 `file://` 或 `localhost` 打开会被源校验拒绝。
> 本地起服务只用于验证服务端接口（`/api/*`），**真实页面预览必须发布到线上域名**。

---

## 服务端接口

| 接口 | 说明 |
|------|------|
| `GET /api/intent` | 探活：意图识别是否可用、置信度阈值、模型名 |
| `POST /api/intent` | 意图识别（行情 / 天气 / 联网 / 分析 / 闲聊…），带 5 分钟内存缓存 |
| `GET /api/chat` | 探活：列出可用模型通道链 |
| `POST /api/chat` | 小美智能体，Agent 主循环（模型自主决定联网 / 调工具） |
| `GET /api/analyze` | 探活：聊天洞察是否可用 |
| `POST /api/analyze` | 聊天洞察：情绪 / 意图 / 好感 / 质量 / 下一步建议 |

### 密钥与模型通道

密钥**只留服务端**，优先级：环境变量 > 本地配置文件（均已 gitignore）。

| 环境变量 | 说明 |
|----------|------|
| `PORT` | 监听端口（默认 8080） |
| `TYPESAFE_API_KEY` | 意图识别 / 聊天洞察的 Jev 通道 Key（缺失时前端自动降级） |
| `TYPESAFE_BASE_URL` | 覆盖基地址（默认 `https://api.typesafe.ai`，测试可指向 mock） |
| `TYPESAFE_MODEL` | 覆盖模型名（默认 `jev-latest`） |
| `INTENT_MIN_CONF` | 最低置信度阈值（默认 0.6） |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` | 小美模型通道（兼容旧部署） |
| `LLM_GATEWAY_BASE_URL` / `LLM_GATEWAY_API_KEY` / `LLM_GATEWAY_MODEL` | 云端免密钥网关通道 |

**推荐用法**：把模型通道写进不入库的 `cloud/.llm.json`，按数组顺序尝试、失败自动切下一个。
换模型只改这个文件，不动代码。只要是 OpenAI 兼容端点（`/chat/completions`）都能接：

```json
{
  "channels": [
    { "name": "glm", "base_url": "https://open.bigmodel.cn/api/paas/v4",
      "api_key": "xxx", "model": "glm-4-flash", "free": true }
  ]
}
```

---

## 云端数据表（均已开启 RLS 行级安全）

| 表 | 内容 | 谁能读 | 谁能写 |
|----|------|--------|--------|
| `profiles` | 昵称、表情头像、颜色、签名、最近在线时间 | 所有登录用户 | 只能改自己那行 |
| `groups` | 群（含内置「大厅」） | 群成员（大厅对所有人可见） | 群主可改名/公告/解散 |
| `group_members` | 群成员与免打扰标记 | 登录用户 | 本人加入/退出，群主可增删成员 |
| `messages` | 消息正文、@列表、引用、撤回标记、附件路径 | 会话参与者（非成员读不到） | 只有发送者本人可发/撤回 |
| `reads` | 每个会话的已读位置 | 自己 | 自己 |
| `friends` | 好友关系与备注 | 关系双方 | 发起方/双方 |
| `games` / `live` | 对局状态 / 直播状态 | 登录用户 | 参与方 / 主播 |

配套两个 `SECURITY DEFINER` 函数 `chat_can_read(conv)` / `chat_is_owner(gid)`，用于跨用户判断"你有没有权限读这个会话"。

> 建表与 RLS 的完整 DDL 见 `cloud/schema.sql`。

---

## 图片和文件

上传后存到云端对象存储的 `shared/<uid>/chat/` 下，消息里只存路径；展示/下载时现场换取 10 分钟有效的签名 URL，不暴露长期直链。单文件上限 25MB。

---

## 改完代码怎么上线

1. 改 `cloud/index.html`
2. 自测：`npm test`
3. 重新发布（复用同一个应用 ID，域名和云端登录保持不变）

---

## 协作

多人协作、Git 认证配置、提交约定见 [`TEAM_SETUP.md`](TEAM_SETUP.md)。
