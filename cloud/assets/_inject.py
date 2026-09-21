#!/usr/bin/env python3
"""把生成的图片 data URI 注入 cloud/index.html 与 LanTalk.html 的占位符。"""
import os

ROOT = "/Users/dzp/WorkBuddy/2026-09-20-17-09-13/lantalk"
GEN = os.path.join(ROOT, "cloud/assets/gen")


def duri(name):
    with open(os.path.join(GEN, name)) as f:
        return "data:image/jpeg;base64," + f.read().strip()


repl = {
    "__XIAOMEI_AV__": duri("xiaomei.jpg.b64"),
    "__CHATBG_L__": duri("chatbg-light.jpg.b64"),
    "__CHATBG_D__": duri("chatbg-dark.jpg.b64"),
}

for rel in ["cloud/index.html", "LanTalk.html"]:
    p = os.path.join(ROOT, rel)
    with open(p) as f:
        s = f.read()
    n = 0
    for k, v in repl.items():
        n += s.count(k)
        s = s.replace(k, v)
    with open(p, "w") as f:
        f.write(s)
    left = sum(s.count(k) for k in repl)
    print(f"{rel}: replaced {n} placeholders, {left} left, size {len(s)//1024}KB")
print("done")
