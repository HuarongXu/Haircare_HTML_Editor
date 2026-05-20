@echo off
chcp 936 >nul
echo.
echo  ========================================
echo   Haircare HTML Editor
echo   Starting on http://localhost:9001
echo  ========================================
echo.

cd /d "%~dp0"

if exist "node_modules" (
    node server.js
) else (
    echo  Installing dependencies...
    npm install
    echo.
    node server.js
)
pause
