@echo off
chcp 65001 >nul
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python не найден. Установите Python 3 с python.org
  pause
  exit /b 1
)
python serve.py %1
pause
