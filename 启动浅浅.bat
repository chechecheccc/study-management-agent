@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
title 浅浅 qianqian

set "PORT=3000"
set "SETUP_ONLY=0"
if not "%~1"=="" (
  if /i "%~1"=="--setup-only" (set "SETUP_ONLY=1") else (set "PORT=%~1")
)

echo.
echo   ==========================================
echo     浅浅 qianqian  ·  一键启动
echo   ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [x] 没有检测到 Node.js。
  echo       请先安装 Node.js 22 或更高版本： https://nodejs.org/
  echo       装好之后重新双击本文件即可。
  echo.
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do set "NODEVER=%%v"
echo   [OK] Node.js !NODEVER!

if not exist ".env.local" (
  echo   [!] 还没有配置文件，正在从模板生成 .env.local
  copy /y ".env.example" ".env.local" >nul
  echo       马上会打开记事本，请填写 DATABASE_URL（数据库地址）后保存关闭。
  echo       如果数据库还没准备好，可以先关掉，等下按提示做。
  if not "%QIANQIAN_NO_AUTO_OPEN%"=="1" start "" notepad ".env.local"
  pause
)

if not exist "node_modules" (
  echo   [..] 首次运行，正在安装依赖，大约 1 分钟，请稍等...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo   [x] 依赖安装失败，请检查网络后重试。
    echo.
    pause
    exit /b 1
  )
)
echo   [OK] 依赖就绪

echo   [..] 正在初始化数据库（自动建库 / 建表 / 建账号）...
call npm run setup
if errorlevel 1 (
  echo.
  echo   [x] 数据库初始化失败，请按上面的提示处理（通常是 PostgreSQL 没启动，
  echo       或者 .env.local 里的 DATABASE_URL 填错了）。
  echo.
  pause
  exit /b 1
)

if "%SETUP_ONLY%"=="1" (
  echo   [OK] 初始化完成。要启动应用，请再双击一次本文件。
  echo.
  pause
  exit /b 0
)

echo   [..] 正在启动，浏览器会自动打开 http://localhost:%PORT%
echo        （关闭这个黑窗口 = 关闭程序）
echo.
if not "%QIANQIAN_NO_AUTO_OPEN%"=="1" start "" cmd /c "timeout /t 18 >nul & start "" http://localhost:%PORT%"
call npm run dev -- --port %PORT%

pause
