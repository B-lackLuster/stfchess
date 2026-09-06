@echo off
rem 一键构建 Windows 桌面版：dist\stfchess\stfchess.exe（需保留同级 engines/ static/ 目录）
cd /d %~dp0
.venv\Scripts\python.exe -m PyInstaller --noconfirm --clean --name stfchess --windowed ^
  --collect-all uvicorn --collect-all webview desktop.py || goto :err
xcopy /E /I /Y engines dist\stfchess\engines >nul || goto :err
xcopy /E /I /Y static dist\stfchess\static >nul || goto :err
echo 构建完成: dist\stfchess\stfchess.exe
exit /b 0
:err
echo 构建失败
exit /b 1
