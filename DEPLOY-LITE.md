# 云聊 · 精简自建（lite）部署与运维手册

> 适用服务器：**阿里云 `112.74.95.74`**（`ecs.e-c1m1.large`，2 vCPU / **1.8 Gi 内存**）
> 登录：`ssh zhangsan@112.74.95.74`（⚠️ zhangsan **不在 sudoers**，没有 root）
> 部署位置：`/home/zhangsan/lantalk/`，端口 **3000**

---

## 一、为什么不用 Supabase 了

| 约束 | 实测 | 后果 |
|---|---|---|
| 内存 | 1.8 Gi | Supabase 全家桶官方建议 8G、最低 4G → **必 OOM** |
| 权限 | `zhangsan is not in sudoers` | 装不了 Docker / 系统级 Postgres / Nginx，改不了 firewalld |
| 预装 | 无 node / docker / git / nginx | 一切都得用户态装 |

**改成**：Node 22（用户态解压）+ **Node 内置 SQLite**（零依赖）+ 自建鉴权/存储。
常驻内存占用 **不到 200MB**，1.8G 机器绰绰有余。

架构对照：

| 原方案 | 现在 |
|---|---|
| Postgres + RLS | SQLite + 代码层鉴权（`cloud/lite-db.js`） |
| PostgREST | `/api/db`（PostgREST 风格子集） |
| Supabase Auth | `/api/auth/*`（邮箱验证码 + HMAC 签名会话） |
| Supabase Storage | `/api/storage/*`（本地文件目录） |
| Docker Compose | 无（直接 `node server.js`） |
| systemd | crontab 每分钟保活（无 root） |

> 前端 `index.html` **一行没改**：`cloud-shim.js` 的 `lite` 模式把几十处 `CLOUD.*`
> 调用翻译成对上述接口的请求。

---

## 二、当前状态

- ✅ 代码已部署到 `/home/zhangsan/lantalk/cloud`
- ✅ 服务运行中（PID 记在 `/home/zhangsan/lantalk/server.pid`），监听 `0.0.0.0:3000`
- ✅ 服务器本地自检全通：首页 200、`/api/auth/session` 正常
- ✅ 服务器本地端到端 **32/0**（注册→登录→建资料→进大厅→发消息→传图→读图→改密码）
- ⚠️ **外网 3000 端口被拦**（安全组未放行）
- ⚠️ **未配 SMTP** → 验证码发不出去（目前靠回显，见下）

---

## 三、你要做的两件事

### 1. 放行 3000 端口（必须）

阿里云控制台 → 云服务器 ECS → 实例 → **安全组** → 配置规则 → 入方向 → 添加：

```
协议类型: TCP   端口范围: 3000/3000   授权对象: 0.0.0.0/0
```

放行后用 `http://112.74.95.74:3000` 访问。

> 若放行后仍不通，是服务器上的 firewalld 在拦（**需要 root** 才能开）：
> `sudo firewall-cmd --add-port=3000/tcp --permanent && sudo firewall-cmd --reload`

### 2. 配 SMTP（否则收不到验证码邮件）

以 QQ 邮箱为例：设置 → 账户 → 开启 **SMTP 服务** → 拿到 16 位**授权码**（不是 QQ 密码）。

然后告诉我要这四个值，我改配置并重启：

```
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_USER=你的邮箱@qq.com
SMTP_PASS=授权码
```

**当前临时状态**：没配 SMTP，验证码会**回显到接口**（浏览器控制台可见）以便先跑通。
⚠️ 这意味着任何人调 `sendotp` 都能拿到验证码 —— **配好 SMTP 后必须关掉**。

---

## 四、日常运维

```bash
# 看服务状态
cat ~/lantalk/server.pid | xargs -r kill -0 && echo "运行中" || echo "已停止"

# 看日志（最近 50 行）
tail -50 ~/lantalk/server.log

# 手动重启
kill $(cat ~/lantalk/server.pid); sleep 1; ~/lantalk/run-lite.sh

# crontab 保活（每分钟检查一次，进程没了自动拉起）
crontab -l | grep run-lite
```

### 备份数据库（重要）

SQLite 是单文件，备份就是拷文件。但**必须先停服务或用 `VACUUM INTO`**（直接 cp 可能拷到写了一半的状态）：

```bash
# 方式一（推荐，不停机）
sqlite3 ~/lantalk/data/lantalk.db "VACUUM INTO '/home/zhangsan/backup-$(date +%F).db'"
# 服务器没装 sqlite3 的话，用 Node 代替：
~/lantalk/node -e "..."   # 或直接用下面这条
cp ~/lantalk/data/lantalk.db ~/lantalk/data/lantalk-$(date +%F).db   # 停机时才能这么干
```

数据库和上传的文件都在 `~/lantalk/data/`：

```
~/lantalk/data/lantalk.db         # 主库（用户/消息/群/好友/对局）
~/lantalk/data/storage/{uid}/...  # 聊天图片与文件
```

### 改小美的模型通道

`~/lantalk/cloud/.llm.json`（不进 Git，需单独维护）。改完重启服务。

### 更新代码

```bash
# 从我本机重新推一次（推荐，我会跑完测试再推）
# 或者你自己：
cd ~/lantalk && ~/lantalk/run-lite.sh     # 换完文件后重启即生效
```

---

## 五、故障排查

| 现象 | 排查 |
|---|---|
| 打不开页面 | ① 安全组放行 3000 了吗 ② `cat ~/lantalk/server.pid \| xargs kill -0` 还活着吗 ③ `tail ~/lantalk/server.log` |
| 端口被占用（EADDRINUSE） | 有残留实例：`ps aux \| grep server.js` 找到后 kill，再 `~/lantalk/run-lite.sh` |
| 收不到验证码 | 检查 `.lite.json` 里 smtpHost/smtpUser/smtpPass；看 `server.log` 里有没有 `验证码（未配 SMTP` |
| 图片显示不出来 | 登录时 cookie `lt_tok` 有没有写入（`document.cookie`）；`/api/storage/f/<path>` 直接访问试试 |
| 提示「没有权限」 | 代码层鉴权拦住了（复刻原 RLS）。确认操作对象是自己的数据 |
| 数据库锁死 | SQLite 开了 WAL，极少发生。真遇到就停服务、`PRAGMA wal_checkpoint`、重启 |

---

## 六、已知限制

1. **SQLite 并发写弱于 Postgres** —— 单写者模型。小规模（几十人以内）IM 完全够，
   真的到几百人并发要换 Postgres（那时服务器也得升配）。
2. **没有 root** —— 装不了系统级组件、改不了防火墙规则、服务无法用 systemd 托管（用 cron 代替）。
3. **验证码回显开着**（临时）—— 配好 SMTP 后必须关。
4. **单点** —— 这台机器挂了服务就没了，数据库务必定期备份到别处。
