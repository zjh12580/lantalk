# LanTalk · 局域网聊天

本项目现在有**两个版本**，按需选用：

| 版本 | 文件 | 数据存哪 | 身份 | 访问方式 |
|------|------|----------|------|----------|
| 局域网版（免登录） | `LanTalk.html` | 服务端本地 `data/db.json` | 一个内网 IP 一个用户，昵称免密进入 | `http://<内网IP>:3000` |
| **云端版（推荐共用）** | `cloud/index.html` | 云端 Postgres + 云端对象存储 | 邮箱登录（验证码/密码） | <https://lan-talk-v2.app.workbuddy.host/>（最新改动）/ <https://lan-talk.app.workbuddy.host/>（旧数据） |

下面 1~3 节是**局域网版**的用法；**云端版**直接看最后一节。

---

## 局域网版：怎么用（三步）

## 怎么用（三步）

### 1. 启动服务（每台机器只需一次）

在 `LanTalk.html` 所在目录执行：

```bash
node LanTalk.html
```

看到类似输出就成功了：

```
本机访问:   http://localhost:3000
局域网访问: http://192.168.1.23:3000
```

想换端口：`PORT=8080 node LanTalk.html`

### 2. 打开聊天

- 这台机器：浏览器打开 `http://localhost:3000`
- 同事的电脑/手机（同一局域网）：打开 `http://192.168.1.23:3000`
- 也可以直接**双击 `LanTalk.html`**，页面会自动连本机 `127.0.0.1:3000`（服务要先启动）

### 3. 输入昵称，开始聊

**身份按机器（内网 IP）绑定**：一台机器只对应一个用户。

- 第一次进：输入昵称（**全服不可重复**），可选表情头像，不选则用昵称第一个字 + 随机颜色；
- 之后再打开：**直接进聊天**，不再问昵称（换浏览器、清缓存也一样，靠 IP 认人）；
- 想换昵称：进来后点左上角自己的头像 → 「我的资料」里改，或者在进入页填新昵称，都会**把原来的身份改名**（不会变成第二个人），大厅会提示"「A」更名为「B」"，历史消息里的名字也会跟着更新。

进来就自动在 **🏠 大厅**（全员公共频道）里，直接说话即可。

两个快捷操作：

- **点大厅里任意一条消息的头像** → 直接打开和那个人的私聊窗口；
- **点右上角 ＋ 建群** → 弹窗里直接列出"大厅成员"，点一下就把人拉进群，不用先搜昵称；
- **截图后直接 Ctrl+V** → 剪贴板里的图片自动上传并发送（不用先保存到本地再选文件）。

---

## 功能一览

| 分类 | 能力 |
|------|------|
| 进入 | **一个 IP 一个身份**（老用户免输入直接进入，换昵称=改名）、昵称唯一校验、表情头像（48 个可选）/ 昵称首字头像、个性签名 |
| 聊天 | 大厅公共频道、私聊、群聊、文字/表情/图片/文件（≤25MB）、**Ctrl+V 直接粘贴截图发送**、引用回复、消息撤回（2 分钟内）、**点头像即开私聊** |
| 已读 | 私聊每条自己的消息显示「已读 / 未读」；群聊自己的最后一条显示「N/M 已读」；未读红点、未读筛选、打开会话自动标记已读 |
| 群聊 | 建群（可直接从大厅成员里点选）、邀请、踢人、退出、解散、改群名、群公告、群成员、**消息免打扰** |
| 提醒 | **@某人 / @全体成员**（消息红框高亮 + 桌面通知 + 提示音 + 侧栏"[有人@我]"）、未读红点、标签页未读数 |
| 好友 | 搜昵称加好友、好友申请/接受/拒绝、备注名、删除好友 |
| 其他 | 正在输入提示、在线状态、历史消息分页、跨会话消息搜索、深色/浅色主题、断线自动重连 |

---

## 在 Linux 上跑

```bash
# 安装 Node.js（16+）
sudo apt install -y nodejs          # Ubuntu/Debian
sudo yum install -y nodejs          # CentOS/RHEL

# 把 LanTalk.html 拷到服务器，例如 /opt/lantalk/
node /opt/lantalk/LanTalk.html
```

后台常驻：

```bash
nohup node /opt/lantalk/LanTalk.html > /opt/lantalk/lantalk.log 2>&1 &
```

开机自启（systemd）：

```ini
[Unit]
Description=LanTalk
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/lantalk/LanTalk.html
WorkingDirectory=/opt/lantalk
Restart=always

[Install]
WantedBy=multi-user.target
```

防火墙放行：`sudo ufw allow 3000/tcp` 或 `sudo firewall-cmd --permanent --add-port=3000/tcp && sudo firewall-cmd --reload`

---

## 数据与备份

- 全部数据存同目录 `data/`（可用 `LANCHAT_DATA=xxx node LanTalk.html` 改位置）
- `data/db.json` 原子写入，掉电不损坏；备份直接拷 `data/` 目录
- `data/files/` 存上传的图片和文件
- IP 与用户的对应关系也在 `data/db.json` 的 `ips` 字段里，删掉某个 IP 的条目，那台机器下次就会重新要求输入昵称

### 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | 3000 | 监听端口 |
| `LANCHAT_DATA` | 同目录 `data/` | 数据目录 |
| `LANCHAT_BIND_IP` | 开启 | 设为 `0` 关闭「一个 IP 一个用户」，退回每个浏览器各用各的昵称 |
| `LANCHAT_TRUST_PROXY` | 关闭 | 部署在 nginx 等反向代理**后面**时设为 `1`，用 `X-Forwarded-For` 识别真实内网 IP；直连部署不要开，否则客户端可伪造 IP 冒用他人身份 |

---

## 这个文件为什么能"既是网页又是服务器"？

文件开头用了 HTML 注释与 JS 注释的兼容写法：

```
<!--            <- 浏览器：HTML 注释开始；Node：行注释
  服务端 JS 代码  <- 浏览器：跳过；Node：执行
/*-->           <- 浏览器：注释结束；Node：块注释开始（吞掉后面的 HTML）
<!DOCTYPE html> ...
<script>前端代码</script>
<!--PAGE_END
*/              <- Node：块注释结束
-->
```

所以：
- **浏览器打开** → 只看到 HTML，正常渲染
- **`node LanTalk.html`** → 只执行服务端代码，并把内嵌的页面发给浏览器

不需要 npm install、不需要数据库、不需要外网。

---

## 云端版：数据存在云端（cloud/index.html）

访问：<https://lan-talk-v2.app.workbuddy.host/>（最新改动）/ <https://lan-talk.app.workbuddy.host/>（旧版旧数据）。两个环境相互独立，账号数据不互通。

### 和局域网版的区别

| 项 | 局域网版 | 云端版 |
|----|----------|--------|
| 数据存储 | 服务端本地 JSON 文件 | 云端 Postgres（6 张表）+ 云端对象存储 |
| 身份 | 一个内网 IP 一个用户，昵称免密 | **邮箱登录**（验证码 / 密码），登录后设置昵称 |
| 实时性 | WebSocket 推送（毫秒级） | 轮询拉取（约 2.5 秒一轮） |
| 适用范围 | 同一局域网 | 有网就能用，可跨网段、跨机器 |
| 换机器/重装 | 数据要拷 `data/` | 数据始终在云端，不丢 |

### 云端数据表（均已开启 RLS 行级安全）

| 表 | 内容 | 谁能读 | 谁能写 |
|----|------|--------|--------|
| `profiles` | 昵称、表情头像、颜色、签名、最近在线时间 | 所有登录用户 | 只能改自己那行 |
| `groups` | 群（含内置「大厅」） | 群成员（大厅对所有人可见） | 群主可改名/公告/解散 |
| `group_members` | 群成员与免打扰标记 | 登录用户 | 本人加入/退出，群主可增删成员 |
| `messages` | 消息正文、@列表、引用、撤回标记、附件路径 | 会话参与者（非成员读不到） | 只有发送者本人可发/撤回 |
| `reads` | 每个会话的已读位置 | 自己 | 自己 |
| `friends` | 好友关系与备注 | 关系双方 | 发起方/双方 |

配套两个 `SECURITY DEFINER` 函数 `chat_can_read(conv)` / `chat_is_owner(gid)`，用于跨用户判断"你有没有权限读这个会话"。

### 图片和文件

上传后存到云端对象存储的 `shared/<uid>/chat/` 下，消息里只存路径；展示/下载时现场换取 10 分钟有效的签名 URL，不暴露长期直链。单文件上限 25MB。

### 本地改代码后怎么同步上线

1. 改 `cloud/index.html`
2. 自测：`node cloud/test-load.js`（桩 SDK 跑通登录→设昵称→进大厅→发消息→撤回→建群，18 项）
3. 重新发布（复用同一个应用 ID，域名和云端登录保持不变）

> 注意：云端 SDK 只在应用自己的 HTTPS 域名（`lan-talk.app.workbuddy.host`）下工作，用 `file://` 或 `localhost` 打开会被源校验拒绝——这是云端版必须发布后才能用的原因。

---

## 目录说明

```
LanTalk.html        ← 主文件（单文件版，推荐）
LanTalk/            ← 早期的多文件拆分版（功能相同，可选；不需要可删除）
data/               ← 运行时数据（自动生成）
```

自测脚本（可选）：

```bash
node LanTalk.html &                 PORT=3010 node LanTalk/test/single-smoke.js   # 后端 23 项
PORT=3010 node LanTalk/test/ui-single.js                                          # 前端 16 项（需 jsdom）
```
