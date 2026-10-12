@echo off
REM ==============================================================================
REM Port of git.sh — stage, commit (timestamped), pull --rebase, push.
REM
REM WARNING: this file is named git.bat, so plain `git` would resolve back
REM to this script (infinite recursion). Every git call below therefore uses
REM git.exe explicitly. Do NOT rename the inner calls back to `git`.
REM
REM Guards (mirroring git.sh, added after the 2026-10-03 incident where a
REM conflicted rebase left the repo in detached HEAD with conflict markers
REM committed into chat_sessions.json):
REM  - refuse to run during an in-progress rebase/merge/cherry-pick
REM  - refuse to run on detached HEAD
REM  - refuse to commit staged conflict markers or invalid JSON
REM  - never proceed to push if pull --rebase fails
REM ==============================================================================
setlocal
cd /d "%~dp0"

REM --- Guard 0: must be inside a git repo ---
for /f "delims=" %%G in ('git.exe rev-parse --git-dir 2^>nul') do set "GIT_DIR=%%G"
if not defined GIT_DIR (
  echo [ERROR] Not a git repository.
  exit /b 1
)

REM --- Guard 1: never start from a half-finished rebase/merge/cherry-pick ---
if exist "%GIT_DIR%\rebase-merge" (
  echo [ERROR] Rebase in progress. Finish it first:
  echo   1. git.exe status                    ^(see conflicted files^)
  echo   2. fix the files ^(no conflict markers left, JSON must parse^)
  echo   3. git.exe add ^<fixed files^>
  echo   4. git.exe rebase --continue ^(or git.exe rebase --abort to give up^)
  echo   5. re-run this script to push
  exit /b 1
)
if exist "%GIT_DIR%\rebase-apply" (
  echo [ERROR] Rebase/apply in progress. Finish it with git.exe rebase --continue/--abort first.
  exit /b 1
)
if exist "%GIT_DIR%\MERGE_HEAD" (
  echo [ERROR] Merge in progress. Finish it first ^(or git.exe merge --abort^).
  exit /b 1
)
if exist "%GIT_DIR%\CHERRY_PICK_HEAD" (
  echo [ERROR] Cherry-pick in progress. Finish it first ^(git.exe cherry-pick --continue/--abort^).
  exit /b 1
)

REM --- Guard 2: never commit/push from detached HEAD ---
git.exe symbolic-ref -q HEAD >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Detached HEAD. Check out your branch first ^(e.g. git.exe checkout main^), then re-run this script.
  exit /b 1
)

echo Staging changes...
REM `yes | git add -p` has no Windows equivalent; stage everything instead.
REM (Interactive per-hunk staging: run `git.exe add -p` yourself beforehand.)
git.exe add -A
if errorlevel 1 (
  echo [ERROR] git add failed.
  exit /b 1
)

REM Check if anything was actually staged
git.exe diff --cached --quiet
if not errorlevel 1 (
  echo No data changes detected. Working tree is clean.
  exit /b 0
)

REM --- Guard 3: never commit conflict markers (git diff --check flags them) ---
git.exe diff --cached --check
if errorlevel 1 (
  echo [ERROR] Staged changes contain conflict markers or whitespace errors.
  echo Unstage, resolve the conflicts, then re-run this script.
  exit /b 1
)

REM --- Guard 4: never commit invalid JSON (e.g. a badly resolved chat_sessions.json) ---
REM Validates staged *.json worktree files via PowerShell (no python needed).
set "BADJSON="
for /f "delims=" %%F in ('git.exe diff --cached --name-only --diff-filter^=ACM -- "*.json"') do (
  powershell -NoProfile -Command "try { Get-Content -LiteralPath '%%F' -Raw | ConvertFrom-Json | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
  if errorlevel 1 (
    echo [ERROR] Invalid JSON: %%F
    set "BADJSON=1"
  )
)
if defined BADJSON (
  echo [ERROR] Aborting: fix the JSON files above, stage them, then re-run this script.
  exit /b 1
)

REM Generate human-readable timestamp (YYYY-MM-DD HH:MM:SS, like date '+%%Y-%%m-%%d %%H:%%M:%%S')
set "TIMESTAMP="
for /f "delims=" %%T in ('powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'" 2^>nul') do set "TIMESTAMP=%%T"
if not defined TIMESTAMP set "TIMESTAMP=%DATE% %TIME%"

echo Committing changes with timestamp...
git.exe commit -m "data update - %TIMESTAMP%"
if errorlevel 1 exit /b 1

echo Pulling latest remote changes...
git.exe pull --rebase origin main
if errorlevel 1 (
  echo [ERROR] git pull --rebase failed - most likely a merge conflict.
  echo Your commit is safe; the rebase is paused. To recover:
  echo   1. git.exe status
  echo   2. fix the files
  echo   3. git.exe add ^<fixed files^>
  echo   4. git.exe rebase --continue ^(or git.exe rebase --abort to give up^)
  echo   5. re-run this script to push
  exit /b 1
)

REM --- Guard 5: pull --rebase must have left us on a branch, not detached ---
git.exe symbolic-ref -q HEAD >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Detached HEAD after rebase. Run git.exe status and finish the rebase first.
  exit /b 1
)

echo Pushing data to remote...
git.exe push
if errorlevel 1 (
  echo [ERROR] git push failed.
  echo If it says 'not currently on a branch', a rebase/merge is still in progress - run git.exe status and finish it first.
  exit /b 1
)

echo Successfully synced!
