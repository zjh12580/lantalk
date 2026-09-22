# LanTalk 云聊 · 开发环境运行说明

拿到就能跑：本仓库只维护**云端版**一套代码（`cloud/`）。

---

## 一、目录结构

```
lantalk/
├── package.json          # npm scripts + 测试依赖（jsdom）
├── README.md             # 项目总览（功能 / 接口 / 数据表）
├── RUNNING.md            # 本文件：怎么跑起来
├── TEAM_SETUP.md         # 多人协作与 Git 认证配置
└── cloud/                # 云端版（唯一维护版本）
    ├── index.html        #   单文件前端
    ├── server.js         #   静态托管 + /api/* 代理（密钥只留服务端）
    ├── agent.js          #   小美智能体引擎
    ├── schema.sql        #   数据库 DDL（表 + RLS + 鉴权函数）
    ├── test-load.js      #   逻辑冒烟（jsdom + 桩 SDK）
    └── test-intent.js    #   意图识别 / 模型通道冒烟
```

---

## 二、环境要求

| 用途 | 依赖 | 说明 |
|------|------|------|
| 运行服务端 | Node.js **16+** | 只用内置模块，零第三方运行时依赖 |
| 跑测试 | Node.js + jsdom | 首次 `npm install` 装一次 |

**安装 Node.js**（Ubuntu/Debian 示例）：

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # 需 >= v16
```

**安装测试依赖**：

```bash
npm install        # 只装 jsdom，用于跑测试
```

---

## 三、跑测试

```bash
npm test              # 全量：test-load → test-intent
npm run test:load     # 只跑逻辑冒烟（约 379 项）
npm run test:intent   # 只跑意图识别 / 模型通道
```

`test-load.js` 用 jsdom 加载真实页面并注入桩 SDK，覆盖登录 → 设昵称 → 进大厅 → 发消息 → 撤回 → 建群 → 好友 → 五子棋 → 围棋 → 输入面板等全流程。

> **改动 `cloud/index.html` 后必须先跑通 `npm test` 再发布。**
> 这套测试的价值很高：它曾精确捕获「邀请卡片不随对局状态更新」「消息前缀被模型模仿」等回归。

---

## 四、本地起服务（可选）

```bash
npm start              # node cloud/server.js，默认 8080
PORT=9000 npm start
```

打开 <http://localhost:8080> 可以验证 `/api/*` 接口是否正常（探活接口返回通道链）。

> ⚠️ **云端页面本身在 localhost 打不开**：云端 SDK 只在应用自己的 HTTPS 域名下工作，
> 用 `file://` 或 `localhost` 会被源校验拒绝。本地服务只用于验证服务端接口，
> 真实页面预览必须发布到线上域名。

---

## 五、密钥配置

密钥**只留服务端、不入库**，优先级：环境变量 > 本地配置文件。

| 文件 | 用途 |
|------|------|
| `cloud/.typesafe.json` | 意图识别 / 聊天洞察（Jev）的 key |
| `cloud/.llm.json` | 小美的模型通道链（推荐：换模型只改这里） |
| `cloud/.deepseek.json` | 兼容旧部署的单通道配置 |

`.llm.json` 支持任意 OpenAI 兼容端点，按数组顺序尝试、失败自动切下一个：

```json
{
  "channels": [
    { "name": "glm", "base_url": "https://open.bigmodel.cn/api/paas/v4",
      "api_key": "xxx", "model": "glm-4-flash", "free": true }
  ]
}
```

三个文件都已在 `.gitignore` 里，不会进仓库。

---

## 六、数据库

建表与 RLS 的完整 DDL 见 `cloud/schema.sql`（6 张业务表 + `games`/`live`，含全部 RLS 策略与两个 `SECURITY DEFINER` 鉴权函数）。

新环境部署时**先执行 schema.sql**，再起服务。

---

## 七、常见问题

| 现象 | 原因 / 处理 |
|------|------------|
| 页面白屏、提示「云端组件加载失败」 | 网络不通，或不在应用自己的 HTTPS 域名下打开 |
| 测试报 `Cannot find module 'jsdom'` | 忘了 `npm install` |
| 意图识别不生效 | 没配 `TYPESAFE_API_KEY`；前端会自动降级为本地关键词路由 |
| 小美不回复 | 没配任何模型通道；`GET /api/chat` 会返回 `channels: []` |
| 改了代码线上没变化 | 云端版需要重新发布才生效（复用应用 ID，域名与登录态不变） |
| 脚本报 `bad interpreter` / `^M` | Windows 换行符问题，`sed -i 's/\r$//' <script>` |
