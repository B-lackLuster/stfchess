@echo off
rem stfchess 启动脚本：启动 Web 服务并打开浏览器
cd /d %~dp0
start "stfchess-server" .venv\Scripts\python.exe -m uvicorn server:app --host 127.0.0.1 --port 8134
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:8134
