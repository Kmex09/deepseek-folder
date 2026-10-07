#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 DeepSeek Folder 应用图标（桌面版 exe / 窗口 / 网页 favicon）
--------------------------------------------------------------------------
用法：
    python tools/make_icons.py <源图片>            # 默认使用下面的 DEFAULT_SRC
    python tools/make_icons.py <源图片> --square   # 非正方形时居中裁剪（默认行为）

产出：
    build/icon.ico        多尺寸 Windows 图标（16/24/32/48/64/128/256），
                          electron-builder 打包 exe 用
    assets/icon-512.png   大图（备用 / 文档）
    assets/icon-256.png   Electron 窗口与任务栏图标
    assets/icon-64.png    网页 favicon
说明：
    源图若不是正方形，会按短边居中裁剪为正方形，再做高质量缩放（LANCZOS），
    并按 EXIF 方向自动旋正。
"""
import argparse
import os
import sys

try:
    from PIL import Image, ImageOps
except ImportError:
    print('[错误] 需要 Pillow：python -m pip install pillow')
    sys.exit(1)

# 控制台编码兜底（Windows 默认 GBK 时避免 UnicodeEncodeError）
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

DEFAULT_SRC = r'D:\GORILLA\1\295C408255FAF0926AEFBEBDA350DB5A.jpg'

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD_DIR = os.path.join(ROOT, 'build')
ASSETS_DIR = os.path.join(ROOT, 'assets')

ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def square(img):
    """居中裁剪为正方形（按短边）"""
    w, h = img.size
    if w == h:
        return img
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    return img.crop((left, top, left + side, top + side))


def main():
    ap = argparse.ArgumentParser(description='生成 DeepSeek Folder 应用图标')
    ap.add_argument('source', nargs='?', default=DEFAULT_SRC, help='源图片路径')
    args = ap.parse_args()

    if not os.path.exists(args.source):
        print('[错误] 找不到源图片：%s' % args.source)
        sys.exit(1)

    os.makedirs(BUILD_DIR, exist_ok=True)
    os.makedirs(ASSETS_DIR, exist_ok=True)

    with Image.open(args.source) as raw:
        print('源图：%s  尺寸=%dx%d  模式=%s' % (args.source, raw.width, raw.height, raw.mode))
        img = ImageOps.exif_transpose(raw)
        # 统一为 RGB（JPEG 无 alpha；PNG 源保留透明度）
        if img.mode not in ('RGB', 'RGBA'):
            img = img.convert('RGB')
        img = square(img)

        # 先做一张 512 的基准图，再由此派生各尺寸，保证缩放质量一致
        base = img.resize((512, 512), Image.LANCZOS)

        base.save(os.path.join(ASSETS_DIR, 'icon-512.png'), 'PNG')
        base.resize((256, 256), Image.LANCZOS).save(os.path.join(ASSETS_DIR, 'icon-256.png'), 'PNG')
        base.resize((64, 64), Image.LANCZOS).save(os.path.join(ASSETS_DIR, 'icon-64.png'), 'PNG')

        ico_path = os.path.join(BUILD_DIR, 'icon.ico')
        base.save(ico_path, format='ICO', sizes=ICO_SIZES)

    for p in ['build/icon.ico', 'assets/icon-512.png', 'assets/icon-256.png', 'assets/icon-64.png']:
        full = os.path.join(ROOT, p.replace('/', os.sep))
        print('  OK  %-22s %6.1f KB' % (p, os.path.getsize(full) / 1024.0))
    print('图标生成完成。')


if __name__ == '__main__':
    main()
