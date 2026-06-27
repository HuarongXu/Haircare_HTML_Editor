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
set /a PORTTRIES=0
:killport
set "PORTBUSY="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":9001" ^| findstr "LISTENING"') do (
    set "PORTBUSY=1"
    echo  Stopping old instance PID %%P
    taskkill /PID %%P /F >nul 2>&1
)
if not defined PORTBUSY goto portfree
set /a PORTTRIES+=1
if %PORTTRIES% GEQ 6 (
    echo  WARNING: could not free port 9001 after several tries, continuing anyway.
    goto startserver
)
timeout /t 1 /nobreak >nul
goto killport

:portfree
echo  Port 9001 is free.

:startserver
if exist "node_modules" (
    node server.js
) else (
    echo  Installing dependencies...
    npm install
    echo.
    node server.js
)
pause
