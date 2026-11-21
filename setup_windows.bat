@echo off
setlocal enabledelayedexpansion
pushd "%~dp0"

echo === GovTrack Windows Setup ===

where python >nul 2>&1
if %errorlevel% neq 0 (
  where py >nul 2>&1
  if %errorlevel% neq 0 (
    echo [ERROR] Python 3.10+ was not found in PATH. Please install Python and re-run setup_windows.bat.
    pause
    exit /b 1
  )
  set "PY_CMD=py -3"
) else (
  set "PY_CMD=python"
)

if not exist "backend\.venv\Scripts\python.exe" (
  echo Creating Python virtual environment in backend\.venv...
  %PY_CMD% -m venv "backend\.venv"
  if %errorlevel% neq 0 (
    echo [ERROR] Failed to create Python virtual environment.
    pause
    exit /b 1
  )
)

echo Installing Python backend dependencies...
"backend\.venv\Scripts\python.exe" -m pip install --upgrade pip
"backend\.venv\Scripts\python.exe" -m pip install -r "backend\requirements.txt"
if %errorlevel% neq 0 (
  echo [ERROR] Failed to install Python dependencies from backend\requirements.txt.
  pause
  exit /b 1
)

echo Verifying Python backend imports...
"backend\.venv\Scripts\python.exe" -c "import fastapi, uvicorn, sqlalchemy, pydantic, email_validator, requests, certifi, bs4, lxml, pypdf, apscheduler, jwt, bcrypt; print('Python backend dependencies OK.')"
if %errorlevel% neq 0 (
  echo [ERROR] Python dependency verification failed.
  pause
  exit /b 1
)

if not exist "backend\.env" if exist "backend\.env.example" (
  copy /Y "backend\.env.example" "backend\.env" >nul
  echo Created backend\.env from backend\.env.example
)

if not exist ".env" if exist ".env.example" (
  copy /Y ".env.example" ".env" >nul
  echo Created .env from .env.example
)

where npm >nul 2>&1
if %errorlevel% neq 0 (
  echo [ERROR] Node.js / npm was not found in PATH. Please install Node.js 20+ and re-run setup_windows.bat.
  pause
  exit /b 1
)

echo Installing frontend Node.js dependencies...
call npm install
if %errorlevel% neq 0 (
  echo [ERROR] npm install failed.
  pause
  exit /b 1
)

echo.
echo Setup complete! Run start_windows.bat to start GovTrack.
popd
pause
