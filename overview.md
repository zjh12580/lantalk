# 云聊迁移自托管 · 交付概览

**任务**：WorkBuddy 服务器到期，把云聊迁到用户自己的服务器。
**决策**（用户确认）：服务器已有但不熟悉连接 / 存量数据全新开始 / 走**自托管 Supabase** 路线。

---

## 一、核心判断：代码早就安全，卡住的是托管服务

代码一直在用户自己的 GitHub（`zjh12580/lantalk`）。真正绑死 WorkBuddy 的是 4 个平台服务：

| 平台服务 | 用途 | 自建替代 |
|---|---|---|
| `CLOUD.auth` | 邮箱验证码 / 密码登录 | 自托管 Supabase Auth（GoTrue） |
| `CLOUD.database` | 8 张业务表 + RLS | 自托管 Postgres + PostgREST |
| `CLOUD.storage` | 聊天图片 / 文件 | 自托管 Supabase Storage |
| `CLOUD.llm` | 免密钥大模型网关 | **已有自己的 key** → 自建 `server.js` |

**关键发现**：扒代码后发现云端 SDK 的数据层就是 **Supabase 形态** ——
`schema.sql` 里用的 `auth.uid()` / `auth.users` / `authenticated` 角色 / RLS / SECURITY DEFINER 函数
全是 Supabase 的标准设施。**所以 `schema.sql` 可以零改动直接跑在自托管 Supabase 上。**

---

## 二、交付物

### 前端（业务代码零改动）
| 文件 | 说明 |
|---|---|
| `cloud/cloud-shim.js` **新增** | 自托管适配壳。提供**同名** `window.WorkBuddyCloud.createWorkBuddyCloud`，内部委托 supabase-js。只在 `__LT_CONFIG__.mode==='selfhost'` 时接管，平台模式完全零干预 |
| `cloud/runtime-config.js` **新增** | 运行时开关，入库默认 `{mode:'platform'}`（不影响线上） |
| `cloud/index.html` **改 2 处** | ① head 引入上面两个脚本；② `ENDPOINT/PUBKEY` 支持运行时覆盖，保留原默认值 |
| `cloud/server.js` **新增 2 路由** | `/api/models` + `/api/llm/stream`（复用通道链，OpenAI 风格 SSE，供适配壳 llm 通道） |
| `cloud/.llm.json.example` **新增** | 大模型配置模板（脱敏，`.llm.json` 不入 Git） |

### 部署编排（`deploy/`）
| 文件 | 说明 |
|---|---|
| `setup-server.sh` | **一键部署**：装 Docker/Node22/Caddy → 拉 Supabase 官方 compose → 生成密钥 → 建表 → 写运行时配置 → systemd + Caddy 反代 |
| `gen-supabase-env.mjs` | 生成 Supabase 密钥。**ANON/SERVICE_ROLE key 是用 JWT_SECRET 签出来的 JWT**，手抄必错，必须脚本生成 |
| `bootstrap.sql` | 存储桶 + 访问策略、内置大厅、高频索引 |
| `docker-compose.override.yml` + `templates/magic_link.html` | **注入含 `{{ .Token }}` 的中文验证码邮件模板** |
| `Caddyfile` / `lantalk.service` | 反代 + 自动 HTTPS / 应用守护 |

### 文档
- `MIGRATE-SELFHOST.md` —— 保姆级：从「怎么连服务器」讲起，含两种上传代码方式、验证清单、FAQ、备份与回滚。

---

## 三、三个必踩的坑（已在方案里规避）

1. **GoTrue 内置邮件模板没有 `{{ .Token }}`** —— 只有「点链接登录」。
   不改的话用户收到的邮件里没有 6 位验证码，登录框直接卡死。→ 用 override 挂自定义模板。
2. **Supabase 的 anon / service_role key 不是随机串**，是用 `JWT_SECRET` 签的 JWT。
   → `gen-supabase-env.mjs` 生成，并做了验签自测。
3. **`cloud/.llm.json` 被 gitignore** → 部署时必须单独上传，否则小美不可用。脚本会在缺失时醒目告警。

---

## 四、验证结果

| 验证项 | 结果 |
|---|---|
| 适配壳 + 密钥生成单测 | **23 / 0**（含 JWT 验签、平台模式不接管、auth 字段搬移、storage 路径映射） |
| 全量前端回归 | 见最终提交（合并同事的移动端改动后仍全绿） |
| 语法 / JSON / bash 校验 | 全部通过 |
| 生成脚本幂等性 | 重复执行不覆盖既有密钥 ✅ |
| SMTP 注入（含特殊字符密码） | 正确加引号保护 ✅ |

**合并处理**：远端 `main` 已前进（同事的移动端三 tab）。核查发现其中 `agent.js`/`server.js`
净差异为 **0**（典型的「提交 + 回滚」），实际只需叠加 `index.html`。已在新版本上重新应用改动，
`index.html` diff **精确等于我的 2 处**，对方改动完整保留。

---

## 五、下一步（需要用户）

1. 提供服务器信息（**IP / 系统版本 / 云厂商**）—— 可远程协助，或
2. 照 `MIGRATE-SELFHOST.md` 自行执行（约 40 分钟）

**迁移后的额外收益**：自己服务器没有 WorkBuddy 网关的 **60 秒硬超时**，
之前为绕开它做的妥协（异步轮询、压缩各通道超时预算）都可放宽，小美回答质量可进一步提升。
