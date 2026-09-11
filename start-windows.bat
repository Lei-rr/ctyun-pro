@echo off
chcp 65001 >nul
title CTYUN-PRO Windows 启动器
color 0B

echo ====================================================
echo       ⚡ CTYUN-PRO Windows 桌面原生启动器
echo ====================================================
echo.

cd /d "%~dp0"

:: 检查并创建本地数据目录
if not exist "data" (
    mkdir data
    echo [INFO] 已自动创建本地数据目录: %cd%\data
)

:: 设置环境变量 (默认端口 3088，数据存放在当前目录的 data 文件夹)
set PORT=3088
set HOST=0.0.0.0
set CTYUN_DATA_DIR=%cd%\data

:: 查找可执行程序
set EXE_FILE=
if exist "ctyun-pro-windows-x64.exe" (
    set EXE_FILE=ctyun-pro-windows-x64.exe
) else if exist "ctyun-pro.exe" (
    set EXE_FILE=ctyun-pro.exe
)

if "%EXE_FILE%"=="" (
    color 0C
    echo [ERROR] 未找到 ctyun-pro-windows-x64.exe 或 ctyun-pro.exe！
    echo 请将本脚本与下载的 exe 程序放在同一个文件夹下。
    echo.
    echo 下载地址: https://github.com/Lei-rr/ctyun-pro/releases/latest
    echo.
    pause
    exit /b 1
)

echo [1/2] 正在启动 CTYUN-PRO 核心服务 (端口: %PORT%)...
echo [2/2] 控制台网址: http://127.0.0.1:%PORT%
echo.
echo ====================================================
echo 服务已在后台运行，请勿关闭本窗口！
echo 首次启动后，可在浏览器访问上面的控制台网址使用。
echo 默认管理员密码: admin123
echo ====================================================
echo.

:: 延时 2 秒后自动在默认浏览器中打开控制台
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://127.0.0.1:%PORT%"

:: 启动程序
"%EXE_FILE%"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] 程序异常退出，错误代码: %ERRORLEVEL%
    pause
)
