# LanTalk 回退点

## `pre-conv-isolation` — 会话隔离改造前的稳定基线

**指向提交**：`b71c6d4`（docs: 会话隔离改造方案）

**当时状态**
- 逻辑冒烟：379 通过 / 0 失败
- 接口与模型通道：18 通过 / 0 失败
- ESLint：0 error（7 warning，均为已标注的「保留待用」项）

**包含的提交**
| 提交 | 内容 |
|---|---|
| `e74e212` | P0 会话隔离与稳定性修复 |
| `28bd173` | 收敛为云端版单一代码库 |
| `0f23e9c` | 工程化基建（schema / CI / lint / LICENSE） |
| `5d5ff9c` | 桩 SDK 补齐过滤器 + 未实现方法报错 |
| `b71c6d4` | 会话隔离改造方案文档 |

## 如何回退

```bash
git reset --hard pre-conv-isolation
```

⚠️ 会丢弃该 tag 之后的所有提交。执行前先确认没有想要保留的新增内容：
```bash
git log --oneline pre-conv-isolation..HEAD   # 看看会丢什么
```

如果想保留改造内容、只是临时回到旧状态，改用分支而不是 reset：
```bash
git branch keep-conv-isolation HEAD   # 先把现状存下来
git checkout pre-conv-isolation       # 再切到旧状态（游离 HEAD）
```

## 回退后需要做的事

```bash
npm ci && npm test && npm run lint
```

预期：379 + 18 通过，0 失败。
若数字对不上，说明有其他未提交的本地改动干扰（`git status` 检查）。
