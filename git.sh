#!/usr/bin/env bash
# Stage, commit (timestamped), pull --rebase, push — with safety guards.
#
# Guards added after the 2026-10-03 incident (conflicted rebase left the repo
# in detached HEAD with conflict markers committed into chat_sessions.json):
#  - refuse to run during an in-progress rebase/merge/cherry-pick
#  - refuse to run on detached HEAD
#  - refuse to commit staged conflict markers or invalid JSON
#  - never proceed to push if pull --rebase fails
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

# --- Guard 2: never commit/push from detached HEAD ---
BRANCH=$(git symbolic-ref -q --short HEAD) || fail "Detached HEAD. Check out your branch first (e.g. git checkout main), then re-run this script."

echo "⏳ Staging changes..."
# Use || true so a 'Broken pipe' exit code doesn't crash the script
yes | git add -p || true

# Check if anything was actually staged
if git diff --cached --quiet; then
    echo "✅ No data changes detected. Working tree is clean."
    exit 0
fi

# --- Guard 3: never commit conflict markers (git diff --check flags them) ---
if ! git diff --cached --check; then
    fail "Staged changes contain conflict markers or whitespace errors. Unstage, resolve the conflicts, then re-run this script."
fi

# --- Guard 4: never commit invalid JSON (e.g. a badly resolved chat_sessions.json) ---
if command -v python3 >/dev/null 2>&1; then
    invalid=0
    while IFS= read -r -d '' f; do
        if ! git show ":$f" 2>/dev/null | python3 -m json.tool >/dev/null 2>&1; then
            echo "❌ Invalid JSON in staged file: $f" >&2
            invalid=1
        fi
    done < <(git diff --cached --name-only -z --diff-filter=ACM -- '*.json')
    if [ "$invalid" -ne 0 ]; then
        fail "Aborting: fix the JSON files above, stage them, then re-run this script."
    fi
else
    echo "⚠️  python3 not found, skipping JSON validation." >&2
fi

# Generate human-readable timestamp
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

echo "📝 Committing changes with timestamp..."
git commit -m "data update - $TIMESTAMP"

echo "🔄 Pulling latest remote changes..."
if ! git pull --rebase origin main; then
    echo "❌ git pull --rebase failed — most likely a merge conflict." >&2
    echo "   The rebase is paused; your commit is safe. To recover:" >&2
    echo "   1. git status                    # see conflicted files" >&2
    echo "   2. fix the files (no '<<<<<<<' markers left, JSON must parse)" >&2
    echo "   3. git add <fixed files>" >&2
    echo "   4. git rebase --continue (or git rebase --abort to give up)" >&2
    echo "   5. re-run this script to push" >&2
    exit 1
fi

# --- Guard 5: pull --rebase must have left us on a branch, not detached ---
git symbolic-ref -q HEAD >/dev/null || fail "Detached HEAD after rebase. Run git status / git rebase --continue first."

echo "🚀 Pushing data to remote..."
if ! git push; then
    echo "❌ git push failed." >&2
    echo "   If it says 'not currently on a branch', a rebase/merge is still" >&2
    echo "   in progress — run git status and finish it first." >&2
    exit 1
fi

echo "🎉 Successfully synced!"
