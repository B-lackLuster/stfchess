@echo off
rem 局域网模式：启动服务器并监听所有网卡，手机/平板可通过 http://电脑IP:8152 访问
rem （需在同一 WiFi 下；Windows 首次运行请允许防火墙放行 Python）
cd /d %~dp0
.venv\Scripts\python.exe -c "import socket; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.connect(('8.8.8.8',80)); print('手机请访问: http://%s:8134/' %% s.getsockname()[0]); s.close()"
.venv\Scripts\python.exe -m uvicorn server:app --host 0.0.0.0 --port 8134
