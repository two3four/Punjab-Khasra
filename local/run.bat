@echo off
cd /d "%~dp0"
where python >nul 2>nul || (echo Python is not installed. Get it from https://www.python.org/downloads/ and tick "Add to PATH". & pause & exit /b 1)
if not exist .venv (
  echo First run: setting up...
  python -m venv .venv
  .venv\Scripts\python -m pip install --upgrade pip
  .venv\Scripts\python -m pip install -r requirements.txt
)
echo Starting Punjab Cadastral Explorer at http://localhost:8000  (close this window to stop)
.venv\Scripts\python run.py
pause
