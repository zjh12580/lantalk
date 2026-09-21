#!/usr/bin/env python3
"""合并后复原被对方版本覆盖的两处资产：暗色壁纸规则 + 小美头像图片。

数据源：cloud/assets/gen/*.b64（与提交 c564bf1 中的完全一致）
"""
import base64
import os
import re
import sys

ROOT = "/Users/dzp/WorkBuddy/2026-09-20-17-09-13/lantalk"
GEN = os.path.join(ROOT, "cloud/assets/gen")
TARGET = os.path.join(ROOT, "cloud/index.html")

dark_b64 = open(os.path.join(GEN, "chatbg-dark.jpg.b64")).read().strip()
xmei_b64 = open(os.path.join(GEN, "xiaomei.jpg.b64")).read().strip()

html = open(TARGET, encoding="utf-8").read()
before = len(html)

# 1) 暗色壁纸规则：紧跟在亮色规则之后（若已存在则跳过）
if "body.theme-dark .msgs" in html:
    print("= 暗色壁纸规则已存在，跳过")
else:
    light = re.search(r"^\.msgs\{background:var\(--bg\) url\(data:image/jpeg;base64,[^\n]*\n", html, re.M)
    if not light:
        print("✗ 未找到亮色壁纸规则行，无法定位插入点")
        sys.exit(1)
    rule = "body.theme-dark .msgs{background-image:url(data:image/jpeg;base64,%s)}\n" % dark_b64
    html = html[: light.end()] + rule + html[light.end() :]
    print("✓ 已补回暗色壁纸规则")

# 2) 小美头像：把 emoji 换回图片 data URI
old = "var BOT = { id: 'bot_xiaomei', name: '小美', avatar: '"
i = html.find(old)
if i < 0:
    print("✗ 未找到 BOT 定义")
    sys.exit(1)
j = html.find("'", i + len(old))
cur = html[i + len(old) : j]
if cur.startswith("data:image"):
    print("= 小美头像已是图片，跳过")
else:
    html = html[: i + len(old)] + "data:image/jpeg;base64,%s" % xmei_b64 + html[j:]
    print("✓ 小美头像已替换为图片（原为 %r）" % cur)

open(TARGET, "w", encoding="utf-8").write(html)
print("文件增长 %d 字节" % (len(html) - before))
