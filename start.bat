@echo off
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python not found. You can still open index.html directly in your browser.
  pause
  exit /b
)
python serve.py
pause
