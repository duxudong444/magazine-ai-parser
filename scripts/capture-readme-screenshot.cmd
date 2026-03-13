@echo off
setlocal
set PATH=C:\Program Files\nodejs;%PATH%
set PORT=3001
set DISABLE_HMR=true

start "" /b cmd /c "node_modules\.bin\tsx.cmd server.ts > screenshot-server.log 2>&1"
timeout /t 8 /nobreak > nul

"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless --disable-gpu --window-size=1440,960 --screenshot="D:\instance\magazine-to-md\docs\app-home.png" http://localhost:3001

for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3001 ^| findstr LISTENING') do taskkill /pid %%a /f > nul 2>&1

endlocal
