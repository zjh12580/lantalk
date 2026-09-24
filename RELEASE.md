# 云聊 LanTalk — 发布速查（新会话直接引用本文件）

> 用途：上下文清理后，只看这一页就能完成「改代码 → 测试 → 提交 → 发布 → 线上验证」全流程。

---

## 一、当前线上状态

| 项 | 值 |
|---|---|
| **访问链接** | https://lan-talk-v2.app.workbuddy.host/ |
| **appId** | `wbapp_MocLqF7DA4TT84NG1dttG2`（归属当前工作区，**勿新建应用**） |
| **部署形态** | Node 服务（`deployedAs: "http-service"`） |
| **最新提交** | `50994bb`（自托管迁移包，测试 **553 通过 / 0 失败**） |
| **自托管迁移** | WorkBuddy 托管到期时的搬迁方案：见 `MIGRATE-SELFHOST.md` + `deploy/`（一键搬到自建 Supabase）。前端靠 `cloud/cloud-shim.js` 适配壳，业务代码零改动 |
| **模型通道** | `tokenhub-hy4:hy4-preview`(serial) **>** `zhipu:glm-4-flash`(免费) **>** `deepseek:deepseek-flash`（前面的失败自动切下一个） |
| **管理入口** | 设置 — 数据管理 — 应用 |

---

## 二、部署参数（照抄）

```
directory    = C:\Users\v-zhaojinhui\WorkBuddy\2026-09-20-10-52-14\cloud   ← 注意是 cloud 子目录
language     = node
startCmd     = node server.js
installCmd   = （空字符串，跳过安装）
appId        = wbapp_MocLqF7DA4TT84NG1dttG2
appName      = 云聊 LanTalk
domainPrefix = lan-talk
updateExistingApp = true
userAskedToPublish = true   ← 仅当用户**本轮**明确说「发布」才置 true
```

---

## 三、发布流程（用户明确要求，六步不可跳）

```bash
# 0) 先 fetch，查 dev 有无新提交
cd /c/Users/v-zhaojinhui/AppData/Local/Temp/lantalk-repo
git fetch origin
git rev-list --count main..origin/dev      # 0 = 无需 merge；非 0 → 先 merge 再往下
git log --oneline main..origin/dev

# 1) 把工作区改好的文件 cp 进 clone 仓库
git add cloud/agent.js cloud/server.js cloud/index.html cloud/test-load.js
git commit -m "..."
git push origin main

# 2) ⭐ 打版本号（用户要求：版本后时间精确到分钟）← 必须在 commit 之后跑
node scripts/stamp-version.mjs
#    → 把当前 HEAD 的 sha + commit 时间(精确到分) 写入 cloud/index.html 与 LanTalk.html 的
#      var BUILD 行（行尾 // LT_BUILD 标记，脚本按标记整行替换）
#    → 会改这两个文件 → 需要再 commit 一次版本标记
git add cloud/index.html LanTalk.html scripts/stamp-version.mjs
git commit -m "chore: 版本戳 <sha>"
git push origin main
# ⚠️ 再把改好的 index.html / LanTalk.html cp 回工作区（否则部署用的是旧版）

# 3) 跑全量测试 ← merge 过或改了 index.html 就必须跑
# 4) 部署（workbuddy_sites_deploy，参数见上）
# 5) 线上验证（见下）
```

> **版本时间的语义**：`BUILD.date` 取的是**最近一次代码提交的时刻**（`%cd`，精确到分钟），
> 不是部署那一刻。所以无代码变更的重复发布，版本号不会变 —— 这是对的（版本 = 代码，不是部署动作）。

**环境准备**（每条 bash 命令开头都要）：
```bash
# ⚠️ 本机 Git Bash 的 PATH 会坏（ls/git/which 全 not found，shim 报 dirname: command not found）
export PATH="/c/Users/v-zhaojinhui/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:/c/Users/v-zhaojinhui/.workbuddy/binaries/PortableGit/versions/1.2.0/cmd:/usr/bin:/bin:$PATH"
# ⚠️ GIT_SSH 必须是 Windows 盘符格式；写成 /c/... 会 "cannot spawn ... No such file or directory"
export GIT_SSH="C:/Users/v-zhaojinhui/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin/ssh.exe"
export NODE_PATH="C:/Users/v-zhaojinhui/.workbuddy/binaries/node/workspace/node_modules"
```
⚠️ `ssh.exe` 在 **`usr/bin/`**（不是 cmd/ 目录）；PATH 要同时含 **cmd + usr/bin**，否则 `unable to fork`。
（只写 `export PATH="/usr/bin:/bin:$PATH"` 已不够 —— 2026-09-23 实测失效，必须显式带上 PortableGit 两个目录。）

---

## 四、跑测试

```bash
cd "C:/Users/v-zhaojinhui/WorkBuddy/2026-09-20-10-52-14/cloud"
export NODE_PATH="C:/Users/v-zhaojinhui/.workbuddy/binaries/node/workspace/node_modules"
node test-load.js        # 约 3m30s，当前基线 553 通过 / 0 失败
```
⚠️ 不带 `NODE_PATH` → `Cannot find module 'jsdom'`。

### 版本戳脚本的正确跑法（工作区无 .git）
`scripts/stamp-version.mjs` 以**自身所在目录的上一级**为 `ROOT` 去跑 `git log`，
所以在工作区直接跑会报 `fatal: not a git repository`。
**把脚本 cp 到临时克隆仓库的 `scripts/` 下再跑**（`ROOT` 变成仓库），跑完把 `cloud/index.html` cp 回工作区：
```bash
cp "$W/scripts/stamp-version.mjs" "$R/scripts/" && cd "$R" && node scripts/stamp-version.mjs
cp "$R/cloud/index.html" "$W/cloud/index.html"
```

---

## 五、线上验证（Node 发请求，别用 curl —— 会被沙箱代理劫持返 502）

```js
// 通道探活
GET https://lan-talk-v2.app.workbuddy.host/api/chat
// 期望：{"ok":true,"primary":"tokenhub-hy4:hy4-preview","fallback":"zhipu:glm-4-flash"}
//   channels 里 hy4 那条应带 (serial) 标记 = 已关闭并发工具调用

// 端到端
POST https://lan-talk-v2.app.workbuddy.host/api/chat
     {"text":"帮我搜一下今天的科技新闻","who":"测试员","history":[]}
// 期望：ok=true，trace 里先有 {"tool":"analyze"} 再有 web_search，回复是真实新闻
```
URL 加 `?nocache=<随机>` 绕 CDN。

### hy4-preview（腾讯云 TokenHub）接入要点 —— 改了别踩回去
| 项 | 值 / 结论 |
|---|---|
| Base URL | `https://tokenhub.tencentmaas.com/v1`（备用 `https://tokenhub.tencentmaas.cn/v1`，**不支持跨地域调用**） |
| 模型 ID | `hy4-preview`（TokenHub 命名，**不带** `tencent/` 前缀） |
| 控制台 | console.cloud.tencent.com/tokenhub/apikey?regionId=1 |
| 能力实测 | 流式 ✅ / function-calling ✅ / 1M 上下文 |
| ⚠️ 推理模型 | 默认高强度思考：**一句「在吗」也要 ~5s**（实测 159 思考 tokens）；只收 `delta.content`，`reasoning_content` 是思考链；**不要传 temperature**；`max_tokens` 给太小会被思考链吃光 → 正文为空 |
| ⚠️⚠️ 流式并发工具名畸形 | 不设 `parallel_tool_calls:false` 时，模型同一轮想调 2 个工具，网关会把多个工具名用内部标记拼成一个畸形 name（`now_time</tool_call:xxx><tool_call:xxx>web_search`）→ 工具无法识别。**`.llm.json` 里该通道必须带 `"parallel_tool_calls": false`** |
| 实测延迟 | 闲聊 1 轮 ~5s；联网问答 2-3 轮 **40~100s**（质量换时间） |

---

## 五·五、小美 = 三段式 agent（2026-09-23 新增「需求分析」段）

```
runAgent():
  ① analyzeRequest()   需求分析 ← 本次新增
       用轻量通道（免费模型优先）跑一次，只输出 JSON：
       { want, kind, web, query, miss, steps }   → 宽松解析（容忍 ```json 围栏/坏输入）
       结论以 buildPlanBrief(plan) 注入 system
  ② 联网执行：needWeb 由 plan.web 决定（没有 plan 才退回 isCommonSense 启发式）
       预检索 webSearch(plan.query || searchQueryOf(text)) → 【联网资料】注入
  ③ 主循环：模型 → tool_calls → 工具 → 模型（≤3 轮 / ≤4 次工具调用）
```

**铁律：① 全程旁路** —— `try { plan = await analyzeRequest(...) } catch { plan = null }`，
分析层失败/超时（`ANALYZE_TIMEOUT=12s`）只是「没有计划」，主链照常跑。
**为什么单独用轻量通道**：分析要快（glm-4-flash ~2-4s），执行才用强模型（hy4-preview）。
**收益**：联网决策从「关键词猜测」升级为「模型判断 + 主动给检索词」，闲聊不再被误触联网；
`miss=true` 时模型会先反问而不是硬猜。

---

## 六、项目文件清单（`工作区/cloud/`）

| 文件 | 说明 |
|---|---|
| `index.html` | 单文件前端（~390KB），小美代码已并回 |
| `server.js` | Node 服务：`/api/chat`(Agent 入口) + `/api/intent`(Jev 代理) + `buildChannels` |
| `agent.js` | Agent 主循环 + 工具 + 多源检索 + System Prompt |
| `test-load.js` | 全量测试（~128KB，510 断言） |
| `test-intent.js` | 意图识别测试 |
| `.llm.json` | **LLM 通道配置**（换模型只改这，不动代码）；gitignore 但**会随部署上传** |
| `.deepseek.json` / `.typesafe.json` | 各 key（同上） |

---

## 六、🔴 远端领先时怎么办（2026-09-23 踩过，很重要）

**部署上传的是「工作区 `cloud/`」，不是仓库！** 若工作区落后于远端，
直接部署 = **把别人的提交全部回退掉**。

```bash
# 征兆：push 被拒
#   ! [rejected] main -> main (fetch first)
#   hint: Updates were rejected because the remote contains work that you do not have locally.

git fetch origin
git log --oneline main..origin/main      # 看远端多了什么（必须先看清，别盲操作）
```

**处理顺序（绝不 `merge --theirs`，绝不硬 push）：**
1. 备份我的改动：`git show <我的sha>:<文件> > 备份`
2. `git reset --hard origin/main` —— 我基于旧基线的提交作废（改动可重现）
3. 在**最新远端基础上重做**我的改动
4. 跑测试 → commit → `git rebase origin/main`（若期间远端又前进）→ push
5. **把远端最新同步回工作区**（见下）→ 再部署

**同步远端回工作区（保住 key 文件）：**
```bash
# ⚠️ 只覆盖仓库里有的文件，绝不能 rm -rf cloud/（会丢 .llm.json / .typesafe.json / .deepseek.json）
for f in $(git ls-tree --name-only origin/main cloud/); do cp "$R/$f" "$W/cloud/$(basename $f)"; done
# ⚠️ assets/ 是目录，上面那条不同步它 —— 必须单独同步（小美头像/聊天背景图在里面）
for f in $(git ls-tree -r --name-only origin/main cloud/assets/); do rel=${f#cloud/}; mkdir -p "$W/cloud/$(dirname $rel)"; cp "$R/$f" "$W/cloud/$rel"; done
```

---

## 七、红线（踩过的坑，别重犯）

1. **发布同意不跨轮传递** —— 上一轮同意过也要重新取得。
2. **「以 X 为准」必须先界定范围** —— 局部模块切换 ≠ 整体分支切换，绝不 `merge --theirs`。
3. **勿新建应用** —— 新域名 → Origin 校验失败 → 登录态/存量数据丢失。
4. **部署偶发 `fetch failed`** → 直接重试，别改参数。
5. **改模型只动 `cloud/.llm.json`** —— 数组顺序即优先级。
6. **智谱必须用 `glm-4-flash`** —— 免费档里唯一「免费 + function-calling + 非推理」。
7. 🔴 **rebase / merge / pull 之后必须「重新同步远端→工作区」+ 逐文件 diff 复查** ——
   同步与部署之间只要插了 rebase，同步就失效了（2026-09-23 实测：rebase 带进
   `1d9a851` 的 `server.js` 改动，工作区没跟上，部署后线上缺 7 行 Node18 守卫）。
   正确顺序：**同步 → 提交 → push → (被拒) rebase → 再同步 → diff 复查 → 部署**。
8. **给 node 传路径用 Windows 原生格式 `C:/Users/...`** —— Git Bash 的 `/c/Users/...`
   会被解析成 `c:\c\Users\...` → `MODULE_NOT_FOUND`。`/c/...` 只给 shell 命令用。
