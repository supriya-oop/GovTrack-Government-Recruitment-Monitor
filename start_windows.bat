@echo off
setlocal
pushd "%~dp0"

echo === Starting GovTrack (FastAPI Backend + React Frontend) ===

if not exist "backend\.venv\Scripts\python.exe" (
  echo [ERROR] Python virtual environment not found. Please run setup_windows.bat first.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [ERROR] node_modules not found. Please run setup_windows.bat first.
  pause
  exit /b 1
)

if not exist "backend\.env" if exist "backend\.env.example" (
  copy /Y "backend\.env.example" "backend\.env" >nul
)

start "GovTrack FastAPI Backend" cmd /k "cd /d "%~dp0backend" && ".venv\Scripts\python.exe" -m uvicorn app.main:app --host 127.0.0.1 --port 8000"

echo Waiting for FastAPI backend on http://127.0.0.1:8000 ...
timeout /t 4 /nobreak > nul

start "GovTrack Frontend" cmd /k "cd /d "%~dp0" && set VITE_API_PROXY_TARGET=http://127.0.0.1:8000&& npm run dev:frontend"

echo GovTrack started:
echo   Frontend: http://127.0.0.1:3000
echo   Backend:  http://127.0.0.1:8000/api/health
popd
