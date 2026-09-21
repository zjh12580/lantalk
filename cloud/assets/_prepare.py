#!/usr/bin/env python3
"""处理生成的素材：裁掉右下角水印、压缩为 JPEG、输出 base64 data URI。

背景图（768x768，水印在右下约 y>710 / x>640 区域）→ 左上角裁 672x672（彻底避开水印）。
头像（512x512，无水印）→ 保持方形，轻度压缩。
输出：cloud/assets/gen/{chatbg-light.jpg, chatbg-dark.jpg, xiaomei.jpg} 与对应 .b64 文本。
"""
import base64
import io
import os

from PIL import Image

ASSETS = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ASSETS, "gen")
os.makedirs(OUT, exist_ok=True)

SRCS = {
    # (源文件, JPEG 质量, 混合目标底色 = 主题 --bg, 图案保留强度)
    "chatbg-light.jpg": ("Seamless_tileable_chat_wallpap_2026-09-21T07-03-23.png", 80, (242, 243, 245), 0.45),
    "chatbg-dark.jpg": ("Seamless_tileable_chat_wallpap_2026-09-21T07-03-22.png", 80, (22, 24, 29), 0.50),
    "xiaomei.jpg": ("Cute_friendly_anime_girl_chatb_2026-09-21T07-03-22.png", 86, None, None),
}

for out_name, (src_name, quality, target, strength) in SRCS.items():
    src = os.path.join(ASSETS, src_name)
    im = Image.open(src).convert("RGB")
    w, h = im.size
    if out_name.startswith("chatbg"):
        # 裁掉右下角水印：取左上 672x672
        crop = 672
        im = im.crop((0, 0, min(crop, w), min(crop, h)))
        if target:
            # 向主题底色混合，弱化图案并让壁纸底色与 --bg 无缝衔接
            base = Image.new("RGB", im.size, target)
            im = Image.blend(base, im, strength)
    else:
        # 头像轻微收紧到主体（保留粉色背景，圆形裁切由前端 border-radius 完成）
        pass
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=quality, optimize=True, progressive=True)
    data = buf.getvalue()
    with open(os.path.join(OUT, out_name), "wb") as f:
        f.write(data)
    b64 = base64.b64encode(data).decode("ascii")
    with open(os.path.join(OUT, out_name + ".b64"), "w") as f:
        f.write(b64)
    print(f"{out_name}: {im.size[0]}x{im.size[1]} jpeg={len(data)//1024}KB b64={len(b64)//1024}KB")
print("done")
