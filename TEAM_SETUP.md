# 团队协作入门（LanTalk / Let's Talk）

本仓库支持多人协作。任何被邀请为 **Collaborator** 的成员，按本文档配置**一次**，之后即可长期 `clone` / `push`。

> 仓库地址：`git@github.com:zjh12580/lantalk.git`（HTTPS 对应 `https://github.com/zjh12580/lantalk.git`）

---

## 0. 前置条件

- 你的 GitHub 账号已被仓库所有者邀请为 **Collaborator**（仓库 → Settings → Collaborators，接受邀请）。
- 你的 WorkBuddy / 开发机可访问 `github.com`。

> ⚠️ Git 推送认的是**你自己的 GitHub 账号**。别人配好的密钥在你机器上无效，必须配你自己的。

---

## 1. 找到 git / ssh / ssh-keygen（WorkBuddy 内置 PortableGit）

WorkBuddy 自带 Git，但**可能不在 PATH**。每个终端会话先执行：

```bash
export PATH="/usr/bin:/bin:$PATH"
GIT=$(find "$HOME/.workbuddy/binaries" -iname "git.exe" 2>/dev/null | head -1)
SSH=$(find "$HOME/.workbuddy/binaries" -iname "ssh.exe" 2>/dev/null | grep -i "usr/bin" | head -1)
SSHKEYGEN=$(find "$HOME/.workbuddy/binaries" -iname "ssh-keygen.exe" 2>/dev/null | head -1)
echo "git=$GIT"; echo "ssh=$SSH"; echo "keygen=$SSHKEYGEN"
```

若你机器上 `git` 已在 PATH，直接用 `git` 即可，可跳过本节变量。

---

## 2. 配置 GitHub 认证（二选一）

### 方案 A：SSH（推荐，一次配置长期有效）

**① 生成密钥**（若 `~/.ssh/id_ed25519` 已存在可跳过）：

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
"$SSHKEYGEN" -t ed25519 -C "your-name@lantalk" -f ~/.ssh/id_ed25519 -N "" -q
```

**② 打印公钥**，复制**整行**：

```bash
cat ~/.ssh/id_ed25519.pub
```

**③ 加到 GitHub**：右上头像 → **Settings** → **SSH and GPG keys** → **New SSH key**
- Title 随便填（如 `WorkBuddy-dev`），Key 粘上面那行 → **Add SSH key**

**④ 验证**：

```bash
"$SSH" -o StrictHostKeyChecking=accept-new -T git@github.com
# 期望输出：Hi <你的用户名>! You've successfully authenticated ...
```

### 方案 B：HTTPS + 访问令牌（PAT）

1. GitHub → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → Generate，勾选对本仓库的 **Contents: Read and write**。
2. 用 token 克隆（`<TOKEN>` 换成你的令牌）：

```bash
"$GIT" clone https://<TOKEN>@github.com/zjh12580/lantalk.git
```

> 注意：token 会**明文**保存在 `.git/config`，请妥善保管；共享机器上不推荐。

---

## 3. 克隆仓库

```bash
"$GIT" clone git@github.com:zjh12580/lantalk.git
cd lantalk
```

---

## 4. 日常提交与推送

```bash
"$GIT" pull --rebase        # 先拉最新，避免和别人的改动冲突
# ... 改代码 ...
"$GIT" add -A
"$GIT" commit -m "feat: 说明你改了什么"
"$GIT" push
```

**第一次提交前**记得设身份（仅影响提交记录，可自定义）：

```bash
"$GIT" config user.name "你的名字"
"$GIT" config user.email "你的邮箱"
```

---

## 5. 协作约定

- **推之前先 `pull --rebase`**，能大幅减少冲突。
- 提交信息前缀建议：`feat:` 新功能 / `fix:` 修 bug / `docs:` 文档 / `chore:` 杂项。
- 较大改动建议开分支，推上去后开 Pull Request 由所有者合并：
  ```bash
  git checkout -b feat/your-topic
  # ... 改 ...
  git push -u origin feat/your-topic
  ```

---

## 6. 云端版改动后的上线提醒

云端版（`cloud/index.html`）只能在线上 HTTPS 域名下工作，本地 `file://` 打不开。
改完代码后：

```bash
cd cloud && npm run test    # 或：node test-load.js  （需先 npm install 装 jsdom）
```

验证通过后，**需要由所有者重新发布**才能生效（复用应用 ID，域名与登录态不变）。发布入口：设置—数据管理—应用。

---

## 常见问题

| 现象 | 原因 / 处理 |
|------|------------|
| `Permission denied (publickey)` | 公钥没加到 GitHub，或加成别人的账号了 —— 必须是你自己的账号 |
| `Repository not found` | 账号未被邀请为 Collaborator，或仓库名写错 |
| `git: command not found` | 没 `export PATH` 或用绝对路径，见第 1 节 |
| `push` 被拒 / 冲突 | 先 `git pull --rebase` 再 `push` |
