@echo off
chcp 936 >nul
echo.
echo  ========================================
echo   Haircare HTML Editor
echo   Starting on http://localhost:9001
echo  ========================================
echo.

cd /d "%~dp0"

echo  Checking port 9001...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":9001" ^| findstr "LISTENING"') do (
    echo  Stopping old instance PID %%P
    taskkill /PID %%P /F >nul 2>&1
)

if exist "node_modules" (
    node server.js
) else (
    echo  Installing dependencies...
    npm install
    echo.
    node server.js
)
pause
