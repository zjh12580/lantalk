# LanTalk 云聊 · 开发环境运行说明

这是一份「拿到就能跑」的开发环境说明。本包包含**局域网版**与**云端版**两套代码，主程序**零第三方依赖**，只有跑冒烟测试才需要装一个 jsdom。

---

## 一、目录结构

```
lantalk-dev/
├── package.json          # 顶层：npm scripts + 测试依赖（jsdom）
├── README.md             # 项目总览（功能/架构/云端表结构）
├── RUNNING.md            # 本文件：怎么跑起来
├── LanTalk.html          # 局域网版（单文件，推荐）：既是网页又是 Node 服务器
├── LanTalk/              # 局域网版（多文件拆分）：功能相同，结构更清晰
│   ├── server.js         #   HTTP 接口 + WebSocket + 静态服务（零依赖）
│   ├── lib/              #   store.js(JSON存储) / ws.js(RFC6455) / presence.js(在线)
│   ├── public/           #   前端（原生 HTML/CSS/JS）
│   ├── test/             #   冒烟测试
│   ├── deploy/           #   systemd 服务文件
│   └── start.sh / stop.sh
└── cloud/                # 云端版（推荐线上共用）
    ├── index.html        #   单文件前端，连云端 Postgres + 对象存储
    └── test-load.js      #   桩 SDK 冒烟测试（18+ 项）
```

---

## 二、环境要求

| 用途 | 依赖 | 说明 |
|------|------|------|
| 局域网版运行 | Node.js **16+** | 零 npm 依赖，装好 Node 直接跑 |
| 云端版运行 | 浏览器即可 | 线上已发布，打开网址就能用 |
| 跑测试 | Node.js + jsdom | 首次 `npm install` 装一次 jsdom |

**安装 Node.js**（Ubuntu/Debian 示例）：

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # 需 >= v16
```

**安装测试依赖**（在包根目录）：

```bash
npm install        # 只装 jsdom，用于跑测试；主程序不需要
```

---

## 三、局域网版：三步跑起来

```bash
# 1. 进入目录
cd LanTalk

# 2. 启动（前台运行，Ctrl+C 停止）
chmod +x start.sh && ./start.sh

# 后台运行：./start.sh -d   （日志 lantalk.log，停止 ./stop.sh）
```

启动后按提示访问：

```
本机访问:   http://localhost:3000
局域网访问: http://<服务器IP>:3000
```

同一局域网内任意电脑/手机，浏览器打开 `http://<服务器IP>:3000` 即可，无需装客户端。

**单文件版等价命令**：`node LanTalk.html`（在包根目录执行）。

**常用配置**：

```bash
PORT=8080 ./start.sh                          # 换端口
LANCHAT_DATA=/data/lantalk ./start.sh         # 换数据目录
```

详见 `LanTalk/README.md`（含 systemd 开机自启、防火墙放行、数据备份）。

---

## 四、跑测试

```bash
# 后端冒烟（局域网多文件版，29 项，零依赖）
cd LanTalk && node test/smoke.js

# 前端运行时（需 jsdom，先 npm install）
cd LanTalk && node test/ui-check.js          # 多文件版 14 项
node LanTalk/test/ui-single.js               # 单文件版 16 项

# 云端版冒烟（需 jsdom，桩 SDK，18+ 项）
node cloud/test-load.js
```

**一键跑主要测试**（包根目录）：

```bash
npm test          # = lan:test(后端) + cloud:test(云端)
npm run lan:ui    # 前端运行时
```

---

## 五、云端版

### 线上地址

| 环境 | 地址 | 说明 |
|------|------|------|
| 旧版（原数据） | https://lan-talk.app.workbuddy.host/ | 最早发布，存量用户/数据在这里 |
| 新版（最新改动） | https://lan-talk-v2.app.workbuddy.host/ | 2026-09-20 新建，含 UI 改动与闪动修复 |

两个环境相互独立，账号数据不互通。

### 改完代码怎么上线

云端版靠 WorkBuddy 云服务发布，代码里的 `ENDPOINT`/`PUBKEY` 决定了连哪个云端环境：

1. 改 `cloud/index.html`
2. 自测：`npm run cloud:test`
3. 重新发布（复用同一个应用 ID，域名和登录态不变）

> ⚠️ 云端 SDK 只在应用自己的 HTTPS 域名下工作，用 `file://` 或 `localhost` 打开会被源校验拒绝。要真实预览必须发布到线上。

云端版数据库 schema（6 张表 + 23 条 RLS + 2 个鉴权函数）详见根目录 `README.md` 的「云端版」章节。

---

## 六、常见问题

- **同事打不开页面**：防火墙放行端口；同一网段；`curl http://服务器IP:3000` 本机自测。
- **脚本报 `bad interpreter` / `^M`**：Windows 拷过去的换行符问题，`sed -i 's/\r$//' start.sh stop.sh`。
- **测试报 `Cannot find module 'jsdom'`**：忘了 `npm install`，在包根执行一次即可。
- **数据在哪**：局域网版全部在 `LanTalk/data/`（或 `LANCHAT_DATA` 指定目录），备份拷该目录即可。
