@echo off
REM ==============================================================================
REM Installation Script for Standard Ubuntu (Desktop / Server / VPS)
REM Windows port of install_ubuntu.sh
REM
REM apt-get / system packages cannot run natively on Windows, so this script
REM forwards to Windows Subsystem for Linux (WSL) and runs install_ubuntu.sh
REM inside the Linux distro (same steps, same output).
REM
REM   install_ubuntu.bat            Run install_ubuntu.sh in WSL (default distro)
REM   install_ubuntu.bat --help     Show this help
REM
REM Prereqs: WSL + an Ubuntu distro. Enable with (admin PowerShell):
REM   wsl --install
REM ==============================================================================
setlocal

if "%~1"=="--help" goto :usage
if "%~1"=="-h" goto :usage
if "%~1"=="help" goto :usage

where wsl.exe >nul 2>nul
if errorlevel 1 (
  echo [ERROR] WSL not found. Ubuntu install requires Windows Subsystem for Linux.
  echo [INFO] Enable it from an admin PowerShell with: wsl --install
  echo [INFO] Then re-run: install_ubuntu.bat
  echo [INFO] ^(Native Windows setup instead: run install.bat^)
  exit /b 1
)

if not exist "%~dp0install_ubuntu.sh" (
  echo [ERROR] install_ubuntu.sh not found next to %~nx0.
  exit /b 1
)

echo [INFO] Starting installation for standard Ubuntu via WSL...
echo [INFO] Forwarding to: bash install_ubuntu.sh
wsl.exe bash -lc "cd \"$(wslpath '%~dp0')\" && bash ./install_ubuntu.sh"
exit /b %ERRORLEVEL%

:usage
echo Usage:
echo   install_ubuntu.bat            Run install_ubuntu.sh inside WSL Ubuntu
echo   install_ubuntu.bat --help     Show this help
echo.
echo Native Windows setup instead: install.bat
exit /b 0
