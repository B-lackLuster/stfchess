# -*- coding: utf-8 -*-
"""下载 Stockfish 18 引擎到 engines/ 目录（仓库不含二进制，克隆后先跑一次）。

用法: python tools/get_engines.py
"""
import io
import os
import shutil
import subprocess
import sys
import zipfile

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REL = "https://github.com/official-stockfish/Stockfish/releases/download/sf_18"

TARGETS = [
    # (zip 名, 解压后引擎相对路径, 目标相对路径)
    ("stockfish-windows-x86-64-avx2.zip",
     "stockfish/stockfish-windows-x86-64-avx2.exe",
     "engines/avx2/stockfish/stockfish-windows-x86-64-avx2.exe"),
    ("stockfish-windows-x86-64.zip",
     "stockfish/stockfish-windows-x86-64.exe",
     "engines/baseline/stockfish/stockfish-windows-x86-64.exe"),
]


def main():
    for zip_name, inner, dest_rel in TARGETS:
        dest = os.path.join(BASE, dest_rel.replace("/", os.sep))
        if os.path.exists(dest):
            print("已存在，跳过:", dest_rel)
            continue
        zip_path = os.path.join(BASE, "downloads", zip_name)
        os.makedirs(os.path.dirname(zip_path), exist_ok=True)
        if not os.path.exists(zip_path):
            url = f"{REL}/{zip_name}"
            print("下载:", url)
            subprocess.run([sys.executable, "-c",
                            "import urllib.request,sys; urllib.request.urlretrieve(sys.argv[1], sys.argv[2])",
                            url, zip_path], check=True)
        print("解压:", zip_name)
        with zipfile.ZipFile(zip_path) as z:
            z.extract(inner, os.path.join(BASE, "downloads", "_extract"))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.move(os.path.join(BASE, "downloads", "_extract", inner.replace("/", os.sep)), dest)
    print("\n引擎就绪。目录:")
    for _, _, dest_rel in TARGETS:
        p = os.path.join(BASE, dest_rel.replace("/", os.sep))
        print(" ", dest_rel, os.path.getsize(p) if os.path.exists(p) else "(缺失)")


if __name__ == "__main__":
    main()
