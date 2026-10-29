"""stfchess 桌面模式：内置服务器 + 原生窗口（pywebview / Edge WebView2）。

用法：
  stfchess.exe            打开桌面窗口
  stfchess.exe --server   仅启动服务器（0.0.0.0，供手机局域网访问），不开窗口
"""
import socket
import sys
import threading
import time
import urllib.request

import uvicorn

from paths import BASE_DIR

PORT_START = 8152


def find_free_port() -> int:
    for p in range(PORT_START, PORT_START + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    return PORT_START


def wait_healthy(port: int, timeout: float = 15.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1)
            return True
        except Exception:
            time.sleep(0.2)
    return False


def run_desktop() -> None:
    from server import app

    port = find_free_port()
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)
    threading.Thread(target=server.run, daemon=True, name="uvicorn").start()
    if not wait_healthy(port):
        sys.exit("服务器启动失败")

    import webview
    # pywebview 默认拦截网页下载，「导出棋谱」需要放行（WebView2 会弹出保存对话框）
    webview.settings["ALLOW_DOWNLOADS"] = True
    webview.create_window(
        "stfchess 棋局分析",
        f"http://127.0.0.1:{port}/",
        width=1360,
        height=900,
        min_size=(980, 640),
    )
    webview.start()  # 窗口关闭后进程随之退出（uvicorn 为守护线程）


def run_server() -> None:
    from server import app

    port = find_free_port()
    print(f"stfchess 服务器运行中: http://127.0.0.1:{port}/ （手机请访问本机局域网 IP）")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")


if __name__ == "__main__":
    if "--server" in sys.argv:
        run_server()
    else:
        run_desktop()
