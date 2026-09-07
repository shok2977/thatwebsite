@echo off
title TubeStream Server
cd /d "C:\Users\asson\Desktop\AGAIN"

echo ============================================
echo   TubeStream Server - http://localhost:3001
echo ============================================
echo   Band karne ke liye ye window close kar dena
echo   (ya Ctrl+C dabana)
echo.

REM Purana server band karo agar chal raha ho
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3001 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1

REM Fresh start (warm pool ~2-3 min mein bharta hai)
node server.js
pause
