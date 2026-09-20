# LanTalk · 局域网即时通讯系统

一套可在 **Linux 服务器/本机** 上运行的局域网聊天系统，功能对齐微信/企业微信的日常使用场景：
私聊、群聊、@提醒、好友申请、文件图片传输、消息撤回、已读回执、桌面通知……

**零第三方依赖**，只依赖 Node.js 内置模块，不需要 npm install，不需要数据库，不需要外网。

---

## 一、功能清单

| 分类 | 能力 |
|------|------|
| 账号 | 注册 / 登录 / 昵称 / 个性签名 / 多设备同时在线 / 登录状态 90 天 |
| 好友 | 搜索用户名或昵称、发送好友申请、接受/拒绝、备注名、删除好友 |
| 私聊 | 文字、表情、图片、文件、引用回复、撤回（2 分钟内）、已读回执、正在输入提示、历史消息分页 |
| 群聊 | 建群、邀请成员、移出成员、退出群、解散群、改群名、群公告、群成员列表、消息免打扰 |
| 提醒 | @指定成员 / @全体成员（红框高亮 + 系统通知 + 提示音）、未读红点计数、浏览器标签标题未读数 |
| 消息 | 实时收发、按日期分组、系统消息、撤回、复制、引用回复、全文搜索（跨会话） |
| 文件 | 图片/任意文件发送（≤25MB）、在线预览图片、下载、鉴权访问 |
| 其他 | 深色/浅色主题、在线状态、断线自动重连、会话列表实时排序 |

---

## 二、在 Linux 上快速开始

### 1. 安装 Node.js（16 及以上）

```bash
# Ubuntu / Debian
sudo apt update && sudo apt install -y nodejs npm
# 版本过低时用 NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# CentOS / RHEL
sudo yum install -y nodejs

# 验证
node -v    # 需要 >= v16
```

### 2. 上传并启动

把整个 `LanTalk` 目录放到服务器（例如 `/opt/lantalk`）：

```bash
cd /opt/lantalk
chmod +x start.sh stop.sh

./start.sh          # 前台运行（Ctrl+C 停止）
./start.sh -d       # 后台运行，日志 lantalk.log
```

启动后会打印访问地址：

```
本机访问:   http://localhost:3000
局域网访问: http://192.168.1.23:3000
```

同一局域网内的任意电脑/手机，用浏览器打开 `http://<服务器IP>:3000` 即可，无需安装客户端。

> 想当成"桌面应用"用：Chrome/Edge 打开后点菜单 →「安装此站点为应用」或「创建快捷方式」，就有了独立窗口，体验和本地程序几乎一样。

### 3. 常用配置

```bash
PORT=8080 ./start.sh              # 换端口
LANCHAT_DATA=/data/lantalk ./start.sh   # 换数据目录（默认 ./data）
```

停止：`./stop.sh`

---

## 三、开机自启（systemd）

```bash
sudo useradd -r -s /sbin/nologin lantalk          # 建专用用户（可选）
sudo mkdir -p /opt/lantalk && sudo cp -r LanTalk/* /opt/lantalk/
sudo chown -R lantalk:lantalk /opt/lantalk

sudo cp deploy/lantalk.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lantalk
sudo systemctl status lantalk
```

日志：`journalctl -u lantalk -f` 或 `/var/log/lantalk.log`

---

## 四、防火墙

```bash
# firewalld（CentOS / RHEL）
sudo firewall-cmd --permanent --add-port=3000/tcp && sudo firewall-cmd --reload

# ufw（Ubuntu）
sudo ufw allow 3000/tcp

# 或者直接放行来源网段
sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="192.168.1.0/24" port protocol="tcp" port="3000" accept'
```

---

## 五、目录结构

```
LanTalk/
├── server.js            # 主服务：HTTP 接口 + WebSocket + 静态资源
├── lib/
│   ├── ws.js            # 零依赖 WebSocket 协议实现（RFC 6455）
│   ├── store.js         # JSON 持久化存储（用户/好友/群/消息/文件）
│   └── presence.js      # 在线状态管理
├── public/              # 前端（原生 HTML/CSS/JS，无框架无 CDN）
│   ├── index.html
│   ├── style.css
│   └── app.js
├── data/                # 运行时数据（首次启动自动创建）
│   ├── db.json          # 全部业务数据
│   └── files/           # 上传的图片与文件
├── deploy/lantalk.service
├── start.sh / stop.sh
└── test/                # 冒烟测试
```

---

## 六、数据与备份

- 所有数据都在 `data/` 目录，**备份只需拷贝整个 data 目录**。
- `db.json` 采用原子写入（临时文件 + rename），掉电不会写坏。
- 每个会话最多保留 5000 条历史消息，超出自动滚动裁剪。
- 单文件上限 25MB，单条消息上限 20000 字符。

---

## 七、自测

```bash
node server.js &                      # 先起服务
node test/smoke.js                    # 后端 29 项：注册/加好友/私聊/建群/@/文件/撤回/搜索/权限
npm i jsdom && node test/ui-check.js  # 前端 14 项：真实 DOM 跑通注册→建群→发消息
```

---

## 八、安全说明

- 定位是**内网办公/团队自用**，默认监听 `0.0.0.0`，请勿直接暴露到公网。
- 密码使用 `scrypt` 加盐哈希存储，不明文保存。
- 所有接口需要 token 鉴权，文件下载同样需要登录态，非会话成员无法读取消息。
- 若要放到公网，请务必加 HTTPS 反向代理（Nginx）并限制来源 IP。

---

## 九、常见问题

**Q：同事打不开页面？**
A：确认服务器防火墙放行端口；在同一网段；`curl http://服务器IP:3000` 在服务器本机先自测。

**Q：提示"无法连接服务器"一直重连？**
A：服务进程是否还在（`ps -ef | grep server.js`）；端口是否被占用（`ss -lntp | grep 3000`）。

**Q：脚本报 `bad interpreter` 或 `^M`？**
A：Windows 拷贝过去的脚本换行符问题，执行 `sed -i 's/\r$//' start.sh stop.sh`。

**Q：忘了密码怎么办？**
A：停服务后编辑 `data/db.json`，删除对应用户对象即可重新注册（或直接删库重来）。

**Q：想让所有人可见（免注册）？**
A：目前需要注册账号。如需匿名模式可在 `server.js` 中增加一个自动注册的游客逻辑。
