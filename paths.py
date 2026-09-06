"""路径解析：开发环境按源码目录，PyInstaller 打包后按 exe 所在目录。"""
import os
import sys


def get_base_dir() -> str:
    if getattr(sys, "frozen", False):  # PyInstaller 打包后
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


BASE_DIR = get_base_dir()
