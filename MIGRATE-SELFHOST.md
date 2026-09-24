# 云聊 LanTalk · 迁移到自己服务器的完整指南

> 目标：WorkBuddy 托管到期后，把「云聊」搬到你自己买的服务器上，继续正常使用，
> 包括**邮箱登录、聊天、图片/文件、游戏、小美 AI**全部功能。
>
> 全程大约 **40 分钟**（其中 10 分钟是等 Docker 拉镜像）。不需要你懂 Linux —— 命令都写在下面，复制粘贴即可。

---

## 一、先搞清楚：到底要搬什么

代码本身**早就安全了**（在你的 GitHub 仓库 `zjh12580/lantalk`）。真正需要搬的是 WorkBuddy 平台替你托管的 4 个服务：

| 原来由 WorkBuddy 提供 | 迁移后由谁提供 | 你要做什么 |
|---|---|---|
| 邮箱登录 / 用户账号 | 自托管 Supabase Auth | 配个邮箱（发验证码用） |
| Postgres 数据库（聊天记录等 8 张表） | 自托管 Supabase 数据库 | 脚本自动建表 |
| 图片 / 文件存储 | 自托管 Supabase Storage | 自动 |
| 免密钥大模型网关（小美） | 你自己的 API Key | 上传一个密钥文件 |
| 网站托管 + 域名 | 你的服务器 + Caddy | 买个域名 |

**迁移包已经全部写好**（就在本项目的 `deploy/` 目录），核心思路是：
前端代码**几乎不动**（只需新增一个适配壳文件），后端换成自托管 Supabase。

---

## 二、准备清单（开工前先备齐）

| 项目 | 要求 | 备注 |
|---|---|---|
| **服务器** | 2 核 4G 起，Ubuntu 22.04 / Debian 12 | 内存低于 4G 会比较吃力 |
| **公网 IP** | 服务器自带 | 记下来，比如 `123.45.67.89` |
| **域名** | 任意一个，比如 `chat.yourname.com` | 用于 HTTPS，**必需**（浏览器要求） |
| **邮箱 SMTP** | QQ 邮箱 / 163 / 企业微信邮箱 均可 | 用来发登录验证码 |
| **大模型 Key** | 你已有的 `.llm.json`（里面是 hy4 / glm / deepseek 的 key） | 文件在你电脑上 |

> 💡 **想省钱？** 国内厂商（阿里云/腾讯云/华为云）2 核 4G 轻量应用服务器，学生或新用户常有 ¥50-100/年的活动价。系统选 **Ubuntu 22.04**。

---

## 三、第 1 步：连上你的服务器

### 3.1 拿到登录信息

去云厂商控制台找到你的服务器，你需要三样东西：

- **公网 IP**：形如 `123.45.67.89`
- **登录用户名**：一般是 `root`
- **密码**：如果不知道，控制台里有「**重置密码**」按钮（会重启服务器，1 分钟）

### 3.2 用命令行连上去

**Windows 电脑**（推荐，系统自带工具）：
按 `Win + R` → 输入 `cmd` → 回车，然后输入（把 IP 换成你的）：

```bash
ssh root@123.45.67.89
```

- 第一次连接会问 `Are you sure you want to continue connecting?` → 输入 `yes` 回车
- 然后输入密码（**注意：输入密码时屏幕上不会显示任何字符，这是正常的**，输完直接回车）

看到提示符变成 `root@服务器名:~#` 就说明**登录成功了**。

**不想用命令行？** 每个云厂商控制台都有「**远程连接**」/「**网页终端**」按钮（阿里云叫 Workbench，腾讯云叫 OrcaTerm），点一下就能在浏览器里操作，效果完全一样。

### 3.3 把域名指向服务器

去你买域名的地方（阿里云/腾讯云/Namecheap…），找到「**DNS 解析**」，加一条记录：

| 类型 | 主机记录 | 记录值 |
|---|---|---|
| A | `chat`（想要 `chat.yourname.com` 就填 chat） | 你的服务器公网 IP |

> 如果你想让根域名（`yourname.com`）直接访问，主机记录填 `@`。
> 解析生效通常 1-10 分钟。

### 3.4 开放端口

在云厂商控制台的「**安全组**」/「**防火墙**」里，放行入方向：

- `22`（SSH，一般默认已开）
- `80`（HTTP，用于自动签发 HTTPS 证书）
- `443`（HTTPS）

---

## 四、第 2 步：上传代码（二选一）

### 方式 A：直接上传（**推荐**，不涉及 GitHub 鉴权）

在**你自己的电脑**上，打开项目目录，用 Git Bash 执行：

```bash
cd "C:/Users/v-zhaojinhui/WorkBuddy/2026-09-20-10-52-14"

# 打包（不含 node_modules 和 .git，含你的 .llm.json 密钥）
tar --exclude=node_modules --exclude=.git --exclude=assets/gen -czf lantalk.tar.gz \
    cloud deploy scripts package.json package-lock.json RELEASE.md

# 上传（会提示输入服务器密码）
scp lantalk.tar.gz root@123.45.67.89:/root/
```

然后**回到服务器**，解压到位：

```bash
mkdir -p /opt/lantalk
tar -xzf /root/lantalk.tar.gz -C /opt/lantalk
ls /opt/lantalk          # 应该看到 cloud  deploy  scripts 等目录
```

### 方式 B：服务器直接拉 GitHub

如果仓库是公开的，或你已给服务器配好 SSH key，可以直接：

```bash
# 脚本会自动执行这一步，无需手动操作
```

私有仓库又不想配 key 的话，请用方式 A。

---

## 五、第 3 步：一键部署

在服务器上执行**一条命令**（把域名和邮箱换成你自己的）：

```bash
cd /opt/lantalk

DOMAIN=chat.yourname.com \
SMTP_HOST=smtp.qq.com \
SMTP_PORT=465 \
SMTP_USER=你的邮箱@qq.com \
SMTP_PASS=你的SMTP授权码 \
sudo -E bash deploy/setup-server.sh
```

> ⚠️ `SMTP_PASS` **不是你的邮箱登录密码**，是「**SMTP 授权码**」。
> - QQ 邮箱：设置 → 账户 → 开启 POP3/SMTP 服务 → 生成授权码
> - 163 邮箱：设置 → POP3/SMTP/IMAP → 开启服务 → 获取授权码
> - 企业微信邮箱：直接用邮箱密码即可
>
> 不加 SMTP 参数也能跑完，但**登录验证码不会真发邮件**（只进本地捕获器），只能用于联调。

脚本会自动完成这 7 件事：

1. 装 Docker、Node 22、Caddy
2. 拉 Supabase 官方编排并生成全部密钥
3. 启动数据库、导入 8 张业务表（`schema.sql` + `bootstrap.sql`）
4. 注入中文验证码邮件模板（**这步很关键**，否则你收到的邮件里没有 6 位数验证码）
5. 生成前端配置 `cloud/runtime-config.js`，切到自托管模式
6. 注册 systemd 服务（跑 `cloud/server.js`，负责小美 AI）
7. 配置 Caddy 反代 + 自动申请 HTTPS 证书

**首次运行约 10-15 分钟**（大部分时间在拉 Docker 镜像）。结束时你会看到：

```
============================================================================
✅ 部署完成
  站点地址      https://chat.yourname.com
  应用自检      HTTP 200      （200 = 正常）
  Supabase 自检 HTTP 401      （401/200 = 网关活着）
  小美通道      {"ok":true,"primary":"hy4:hy4-preview",...}
============================================================================
```

> 脚本**可以重复执行**，已生成的密钥和服务不会被覆盖。

---

## 六、第 4 步：确认小美的密钥在位

`.llm.json` 存着大模型 Key，**不在 Git 里**（防泄露）。用方式 A 上传的话它已经在位；否则需要单独传：

```bash
# 在你自己的电脑上执行
scp cloud/.llm.json root@123.45.67.89:/opt/lantalk/cloud/
```

然后确认通道配置正确：

```bash
grep -E '"name"|"model"' /opt/lantalk/cloud/.llm.json
# 期望看到 hy4 / zhipu 等通道
chown lantalk:lantalk /opt/lantalk/cloud/.llm.json
systemctl restart lantalk
```

---

## 七、第 5 步：验证清单

打开 `https://chat.yourname.com`，逐项确认：

| 检查项 | 期望结果 | 出问题看哪 |
|---|---|---|
| 页面能打开 | 出现登录页 | `journalctl -u caddy -n 50` |
| 发验证码 | 邮箱收到 6 位数字 | 服务器上 `docker compose -f /opt/supabase/docker/docker-compose.yml logs auth --tail 50` |
| 注册登录 | 填入验证码 + 昵称，进入大厅 | 浏览器 F12 看 Network |
| 发消息 | 消息出现，刷新后还在 | 同上 |
| 传图片 | 图片显示出来 | Supabase storage 日志 |
| @小美 | 能回复（可能要等十几秒） | `journalctl -u lantalk -f` |
| 手机访问 | 同一域名可用 | — |

---

## 八、迁移带来的一个额外好处

原来 WorkBuddy 网关有 **60 秒硬超时**，为了绕开它，我们做了不少妥协（小美走「提交任务+轮询」、把各通道超时压缩到 55 秒内）。

**现在这些限制没有了。** 你的 Caddy 反代不设超时，可以放宽小美的思考时间，回答质量更好：

编辑 `/opt/lantalk/cloud/.llm.json`，把推理模型的 `timeout_ms` 调大：

```json
{ "name": "hy4", "model": "hy4-preview", "timeout_ms": 180000 }
```

然后 `systemctl restart lantalk`。**这一步可选**，不改也能正常用。

---

## 九、日常运维

```bash
# 应用日志（小美报错看这里）
journalctl -u lantalk -f

# 重启应用
systemctl restart lantalk

# 看数据库/存储等容器状态
cd /opt/supabase/docker && docker compose ps

# 更新代码后重启
cd /opt/lantalk && git pull && systemctl restart lantalk

# 备份数据库（建议每周）
docker compose -f /opt/supabase/docker/docker-compose.yml exec -T db \
  pg_dump -U postgres postgres | gzip > /root/lantalk-backup-$(date +%F).sql.gz
```

**备份自动化**（每天凌晨 3 点）：

```bash
cat > /etc/cron.d/lantalk-backup <<'EOF'
0 3 * * * root docker compose -f /opt/supabase/docker/docker-compose.yml exec -T db pg_dump -U postgres postgres | gzip > /root/lantalk-backup-$(date +\%F).sql.gz
EOF
```

---

## 十、常见问题

**Q：`https://` 打不开，提示证书错误？**
A：三个可能：① 域名没解析到服务器（`ping chat.yourname.com` 看是否等于你的 IP）；② 公网 80/443 没放行（安全组）；③ Caddy 签发失败，看 `journalctl -u caddy -n 80`。DNS 刚改完的话等 10 分钟再试。

**Q：收不到验证码邮件？**
A：① 检查垃圾邮件；② `SMTP_PASS` 用的是登录密码而不是授权码；③ 看 auth 容器日志：`cd /opt/supabase/docker && docker compose logs auth --tail 100`。没配 SMTP 的话，验证码在捕获器里：浏览器打开 `http://你的IP:9000`（需安全组临时放行 9000）。

**Q：小美不回复 / 回「卡了一下」？**
A：① 确认 `/opt/lantalk/cloud/.llm.json` 存在且 key 有效（`systemctl status lantalk`）；② 看 `journalctl -u lantalk -f` 里的通道报错；③ 直接测：`curl -H 'Host: chat.yourname.com' http://127.0.0.1:3000/api/chat`。

**Q：内存吃紧 / 服务器卡？**
A：Supabase 全家桶约吃 1.5-2G。可以关掉用不上的容器，编辑 `/opt/supabase/docker/docker-compose.yml` 注释掉 `studio`、`analytics`、`vector`、`imgproxy`，再 `docker compose up -d`。

**Q：数据库想加内存 / 换机器？**
A：`pg_dump` 导出 → 新机器重跑本指南 → 导入。记得把 `/opt/supabase/docker/.env` 里的密钥一起带过去，否则旧用户登录态失效。

**Q：想回滚到 WorkBuddy 平台？**
A：把 `cloud/runtime-config.js` 改回 `window.__LT_CONFIG__ = { mode: 'platform' };` 即可（前端会自动用原平台 SDK）。平台侧已到期的数据无法找回。

---

## 十一、迁移包文件说明

```
deploy/
├── MIGRATE-SELFHOST.md          ← 本文件
├── setup-server.sh              ← 一键部署脚本（核心）
├── gen-supabase-env.mjs         ← 生成 Supabase 密钥与配置
├── bootstrap.sql                ← 存储桶 / 大厅 / 索引初始化
├── docker-compose.override.yml  ← 注入中文验证码邮件模板
├── templates/magic_link.html    ← 验证码邮件模板（含 {{ .Token }}）
├── Caddyfile                    ← 反代 + 自动 HTTPS
└── lantalk.service              ← systemd 服务单元

cloud/
├── cloud-shim.js                ← 【新增】自托管适配壳（前端零改动关键）
├── runtime-config.js            ← 【新增】运行时配置（平台/自托管切换开关）
└── .llm.json.example            ← 【新增】大模型配置模板（脱敏）
```

---

## 十二、需要我帮忙的话

如果你在任一步卡住，把**这一步的输出**贴给我，我来判断。特别是：

- 服务器连不上 → 告诉我云厂商（阿里云/腾讯云/其他）和系统版本
- 脚本报错 → 把 `[setup]` 开头的报错整段贴过来
- 登录/小美有问题 → 贴 `journalctl -u lantalk -n 50` 或浏览器 F12 的报错
