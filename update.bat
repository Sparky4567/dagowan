@echo off
REM ==============================================================================
REM Port of update.sh — fetch + pull latest remote changes.
REM
REM WARNING: this folder contains git.bat, so plain `git` would resolve back
REM to that script (infinite recursion). Every git call below therefore uses
REM git.exe explicitly. Do NOT rename the inner calls back to `git`.
REM
REM Guards (mirroring git.sh / git.bat, added after the 2026-10-03 incident
REM where a conflicted rebase left the repo in detached HEAD):
REM  - refuse to run during an in-progress rebase/merge/cherry-pick
REM  - refuse to run on detached HEAD
REM  - never leave a failed pull --rebase unexplained (print recovery steps)
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
  echo   5. re-run this script to retry
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

REM --- Guard 2: never pull from detached HEAD ---
git.exe symbolic-ref -q HEAD >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Detached HEAD. Check out your branch first ^(e.g. git.exe checkout main^), then re-run this script.
  exit /b 1
)

echo Fetching latest remote changes...
git.exe fetch origin
if errorlevel 1 (
  echo [ERROR] git.exe fetch failed. Check your network connection and remote URL ^(git.exe remote -v^).
  exit /b 1
)

echo Pulling latest remote changes...
git.exe pull --rebase origin main
if errorlevel 1 (
  echo [ERROR] git pull --rebase failed - most likely a merge conflict.
  echo Your local work is safe; the rebase is paused. To recover:
  echo   1. git.exe status
  echo   2. fix the files
  echo   3. git.exe add ^<fixed files^>
  echo   4. git.exe rebase --continue ^(or git.exe rebase --abort to give up^)
  echo   5. re-run this script to retry
  exit /b 1
)

REM --- Guard 3: pull --rebase must have left us on a branch, not detached ---
git.exe symbolic-ref -q HEAD >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Detached HEAD after rebase. Run git.exe status and finish the rebase first.
  exit /b 1
)

echo Successfully updated!
