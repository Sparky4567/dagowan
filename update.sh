#!/usr/bin/env bash
# Fetch + pull latest remote changes — with safety guards.
#
# Guards mirror git.sh (added after the 2026-10-03 incident where a
# conflicted rebase left the repo in detached HEAD):
#  - refuse to run during an in-progress rebase/merge/cherry-pick
#  - refuse to run on detached HEAD
#  - never leave a failed pull --rebase unexplained (print recovery steps)
set -e

fail() { echo "❌ $*" >&2; exit 1; }

GIT_DIR=$(git rev-parse --git-dir 2>/dev/null) || fail "Not a git repository."

# --- Guard 1: never start from a half-finished rebase/merge/cherry-pick ---
if [ -d "$GIT_DIR/rebase-merge" ] || [ -d "$GIT_DIR/rebase-apply" ]; then
    fail "Rebase in progress. Finish it first: git status → fix files → git add <files> → git rebase --continue (or git rebase --abort). Then re-run this script."
fi
if [ -f "$GIT_DIR/MERGE_HEAD" ]; then
    fail "Merge in progress. Finish it first: git status → fix files → git add <files> → git commit (or git merge --abort). Then re-run this script."
fi
if [ -f "$GIT_DIR/CHERRY_PICK_HEAD" ]; then
    fail "Cherry-pick in progress. Finish it first (git cherry-pick --continue/--abort). Then re-run this script."
fi

# --- Guard 2: never pull from detached HEAD ---
git symbolic-ref -q HEAD >/dev/null || fail "Detached HEAD. Check out your branch first (e.g. git checkout main), then re-run this script."

echo "⏳ Fetching latest remote changes..."
git fetch origin || fail "git fetch failed. Check your network connection and remote URL (git remote -v)."

echo "🔄 Pulling latest remote changes..."
if ! git pull --rebase origin main; then
    echo "❌ git pull --rebase failed — most likely a merge conflict." >&2
    echo "   The rebase is paused; your local work is safe. To recover:" >&2
    echo "   1. git status                    # see conflicted files" >&2
    echo "   2. fix the files (no '<<<<<<<' markers left, JSON must parse)" >&2
    echo "   3. git add <fixed files>" >&2
    echo "   4. git rebase --continue (or git rebase --abort to give up)" >&2
    echo "   5. re-run this script to retry" >&2
    exit 1
fi

# --- Guard 3: pull --rebase must have left us on a branch, not detached ---
git symbolic-ref -q HEAD >/dev/null || fail "Detached HEAD after rebase. Run git status / git rebase --continue first."

echo "🎉 Successfully updated!"
