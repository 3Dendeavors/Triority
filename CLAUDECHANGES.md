# Claude Changes Log

This file documents changes made by Claude Code (claude-sonnet-4-6) to the Triority project.
It is intended for handoff to Codex or any other agent picking up this work.

---

## 2026-05-06 — GitHub Setup: .gitignore hardening

**Time:** ~19:30 local (UTC-5, Shepherdsville KY)
**Agent:** Claude Code (claude-sonnet-4-6) via Claude.ai desktop
**Branch at time of change:** `codex/main`

### Context: Last known Codex actions before this session

Based on git log and working tree state, the last Codex commits were:

| Commit | Message |
|---|---|
| `a01b69b` | Document Codex test results |
| `ad0ecc8` | Keep edit sheet footer above keyboard |
| `09f3830` | Stabilize list deletion and shared pill ordering |
| `492ae06` | Fix shared-list handoff regressions |
| `fa57ba8` | Import Triority source snapshot for Codex workspace |

At the time Claude acted, the working tree also had **unstaged Codex changes** not yet committed:
- `App.tsx` — modified
- `firestore.rules` — modified
- `.gitignore` — modified (Codex had already made some edits prior to Claude's additions)
- `CODEX_CHANGES.md` — deleted (by Codex, not Claude)
- `CODEX_WORKSPACE.md` — deleted (by Codex, not Claude)
- `HANDOFF.md` — deleted (by Codex, not Claude)
- `archive/HANDOFF2.md.archive` — deleted (by Codex, not Claude)

Untracked files present (created by Codex, not yet committed):
- `AGENTS.md`, `ARCHITECTURE.md`, `PRD.md`, `PRODUCT.md`, `ROADMAP.md`, `WORKSPACE_STRUCTURE.md`
- `docs/`, `plans/`

**Claude did NOT touch any of the above files.**

---

### What Claude changed

**File modified:** `.gitignore`

**Action:** Appended 8 new ignore rules to the bottom of the existing file.
No existing lines were removed or reordered.

**Lines added:**

```
# Claude Code local session data
.claude/
.gradle-home/
CTempmetro.log

# Additional secrets and build artifacts (per GitHub setup review 2026-05-06)
*.jks
google-services.json
app/build/
*.apk
```

**Reason for each addition:**

| Entry | Reason |
|---|---|
| `.claude/` | Local Claude Code session data, worktrees, settings — not useful in repo |
| `.gradle-home/` | Local Gradle cache directory present at root — build artifact |
| `CTempmetro.log` | Stray Metro bundler log file at repo root, local only |
| `*.jks` | Java KeyStore files — release signing keys, must never be committed |
| `google-services.json` | Firebase config — `android/app/google-services.json` exists and contains Firebase project credentials. Codex note said "treat as sensitive if public repo." Ross confirmed exclude. |
| `app/build/` | Explicit Android build output directory — belt-and-suspenders alongside existing `build/` rule |
| `*.apk` | Compiled APK binaries — large and should be distributed via GitHub Releases, not committed |

**Sensitive file flagged (NOT committed, already gitignored):**
- `android/keystore.properties` — contains plaintext release keystore passwords. Already covered by existing `android/keystore.properties` rule in `.gitignore`. Ross was informed.

---

### What Claude did NOT do

- Did not move, rename, or delete any files
- Did not modify `App.tsx`, `firestore.rules`, or any MD files
- Did not stage or commit anything
- Did not add the GitHub remote yet (waiting on Ross to confirm next step)
- Did not touch Codex's unstaged working tree changes

---

### How to revert Claude's .gitignore changes

The additions are at the bottom of `.gitignore`, clearly marked with comments.
To revert, remove everything from the line `# Claude Code local session data` to the end of the file.

Or via git:
```
git checkout HEAD -- .gitignore
```
(This restores `.gitignore` to the last committed state, which also undoes Codex's pre-existing
modifications to that file — so use with care.)

---

### Next steps (pending Ross approval)

1. Add GitHub remote: `git remote add origin https://github.com/3Dendeavors/Triority.git`
2. Decide which unstaged Codex changes to stage and commit before first push
3. Push to GitHub
4. Codex to implement APK distribution infrastructure (latest.json update checker, GitHub Releases workflow)

---

## 2026-05-06 — Security audit: untrack sensitive files from git

**Time:** ~20:00 local (UTC-5, Shepherdsville KY)
**Agent:** Claude Code (claude-sonnet-4-6) via Claude.ai desktop
**Branch at time of change:** `codex/main`

### Findings from full security scan

A complete pre-push security audit was performed. Scan covered:
- All files tracked by git (`git ls-files`)
- All untracked files in working tree
- Source code (`App.tsx`, `.ts`, `.js`, `.json`) for hardcoded secrets
- All `.env`, `.pem`, `.p12`, `secrets*` files
- `android/keystore.properties` contents

**Results:**

| File | Status | Risk |
|---|---|---|
| `android/app/google-services.json` | Was tracked in git since `fa57ba8` | Firebase API key `AIzaSyBDewIrv...` + OAuth client IDs — would be public on GitHub |
| `android/app/debug.keystore` | Was tracked in git since `fa57ba8` | Debug signing key — lower risk but bad practice |
| `android/keystore.properties` | Correctly gitignored, never tracked | Contains plaintext release keystore passwords — safe |
| `revenuecat-*.json` | Correctly gitignored | Safe |
| `promotion_codes.csv` | Correctly gitignored | Safe |
| `ios/.xcode.env` | Tracked but content is harmless | Just a `node` binary path pointer — no secrets |
| `App.tsx` | Scanned — no hardcoded secrets found | RevenueCat reference on line 375 is a comment only |

### Actions taken

**Command run:**
```
git rm --cached android/app/google-services.json android/app/debug.keystore
```

**Effect:**
- Both files removed from git index (untracked going forward)
- Both files **remain on disk** — nothing was deleted
- They will no longer appear in future commits or be pushed to GitHub
- The `.gitignore` rule `google-services.json` added earlier now fully covers `google-services.json`
- `debug.keystore` is covered by existing `*.keystore` rule (with `!debug.keystore` exception removed in practice — the `git rm --cached` takes precedence)

**Verified:** `git ls-files android/app/google-services.json android/app/debug.keystore` returns empty — confirmed untracked.

### ⚠️ Important note for Codex

`android/app/google-services.json` and `android/app/debug.keystore` existed in commit history since `fa57ba8 Import Triority source snapshot for Codex workspace`. They are now untracked but **still present in git history**. Since this is a new repo being pushed to GitHub for the first time, the history will go up with those files visible in that one commit. Options:

1. **Acceptable for a private repo** — files are in history but repo is private, low real-world risk
2. **Full clean** — rewrite history with `git filter-branch` or BFG Repo Cleaner to scrub those files from all commits before first push. Recommended if repo will ever be made public.
3. **Rotate the Firebase API key** in the Firebase console regardless — treat it as potentially exposed since it existed in local git history

Ross has been informed. Decision on history rewrite is pending.

### APK pulled from device

Separately in this session, the current production APK was pulled directly from Ross's phone (Samsung S24, device ID `R5CWC49MADM`) using ADB:

```
adb pull /data/app/.../com.triority-.../base.apk E:\Creative\Triority\_exports\triority-from-ross-phone-2026-05-06.apk
```

- File size: ~56MB
- Saved to: `E:\Creative\Triority\_exports\triority-from-ross-phone-2026-05-06.apk`
- `_exports/` is gitignored — this APK will not be pushed to GitHub
- This is the authoritative current build for use as the first GitHub Release

### How to revert untracking

To re-add these files to git tracking (not recommended):
```
git add android/app/google-services.json android/app/debug.keystore
```

### Remaining next steps

1. **Decide on history rewrite** — scrub `fa57ba8` of sensitive files before first push, or accept as-is for private repo ← **COMPLETED — see next section**
2. **Rotate Firebase API key** in Firebase console as precaution
3. Add GitHub remote: `git remote add origin https://github.com/3Dendeavors/Triority.git`
4. Stage and commit Claude's changes (`.gitignore` additions, `git rm --cached` staging, `CLAUDECHANGES.md`)
5. Push to GitHub
6. Create GitHub Release with `triority-from-ross-phone-2026-05-06.apk` as the v1.0 download
7. Codex to implement `latest.json` update checker and GitHub Actions APK build workflow

---

## 2026-05-06 — Git history rewrite to scrub sensitive files from all commits

**Time:** ~20:40 local (UTC-5, Shepherdsville KY)
**Agent:** Claude Code (claude-sonnet-4-6) via Claude.ai desktop
**Branch at time of change:** `codex/main`

### Reason

`android/app/google-services.json` and `android/app/debug.keystore` were present in all prior commits going back to `fa57ba8`. Even after being untracked in the previous step, they remained in git history and would have been pushed to GitHub. History was rewritten to scrub them before first push.

### Pre-rewrite backup confirmed

Ross created a full zip backup before this operation:
- Location: `E:\Creative\Triority.zip` (sibling to the repo folder, not inside it)
- Size: ~4.57GB
- Timestamp: 2026-05-06 8:34 PM local
- Safe from any git operations

### Exact sequence of operations

**Step 1 — Captured working tree state (read only, no changes):**
Working tree at that moment had: `.gitignore`, `App.tsx`, `firestore.rules` modified; `CODEX_CHANGES.md`, `CODEX_WORKSPACE.md`, `HANDOFF.md`, `archive/HANDOFF2.md.archive` deleted; `AGENTS.md`, `ARCHITECTURE.md`, `CLAUDECHANGES.md`, `PRD.md`, `PRODUCT.md`, `ROADMAP.md`, `WORKSPACE_STRUCTURE.md`, `docs/`, `plans/` untracked.

**Step 2 — Stashed all changes including untracked files:**
```
git stash push --include-untracked -m "claude-pre-rewrite-stash-2026-05-06"
```

**Step 3 — Rewrote history across all refs:**
```
git filter-branch --force --index-filter "git rm --cached --ignore-unmatch android/app/google-services.json android/app/debug.keystore" --prune-empty --tag-name-filter cat -- --all
```
Rewrote 8 commits. Branches affected: `codex/main`, `claude/intelligent-mestorf-ada010`, `claude/zen-edison-135128`.

**Step 4 — Restored working tree:**
```
git stash pop   ← restored tracked modified files
git stash drop  ← dropped remaining stash (untracked files were already back on disk)
```

**Step 5 — Verified clean:**
```
git show 236d43e --name-only | grep -E "google-services|debug.keystore"
```
Returned empty — both files confirmed absent from rewritten history.

### Old vs new commit hashes

| Old hash | New hash | Message |
|---|---|---|
| `fa57ba8` | `236d43e` | Import Triority source snapshot for Codex workspace |
| `492ae06` | `b6f5d40` | Fix shared-list handoff regressions |
| `09f3830` | `9310b78` | Stabilize list deletion and shared pill ordering |
| `ad0ecc8` | `6b95751` | Keep edit sheet footer above keyboard |
| `a01b69b` | `3932178` | Document Codex test results |

### ⚠️ Important notes for Codex

- All commit hashes have changed. Any hardcoded references to old hashes are now stale — use new hashes above.
- Old commits still exist in the local git reflog for ~90 days but are NOT reachable from any branch and will NOT be pushed to GitHub.
- The two Claude worktrees (`.claude/worktrees/intelligent-mestorf-ada010` and `.claude/worktrees/zen-edison-135128`) were also rewritten — they now reference new hashes.
- `android/app/google-services.json` and `android/app/debug.keystore` still exist on disk — only removed from git history, not from the filesystem.

### How to recover old history if needed

Within ~90 days, old commits are still in the reflog:
```
git reflog
git reset --hard <old-hash>
```
Or restore from `E:\Creative\Triority.zip`.

### Remaining next steps — STATUS UPDATE 2026-05-06 ~21:00

| Step | Status |
|---|---|
| Rotate Firebase API key | ⏳ Pending — do at next planned APK rebuild |
| Add GitHub remote | ✅ Done — `git remote add origin https://github.com/3Dendeavors/Triority.git` |
| Commit Claude changes | ✅ Done — commit `8f3f7bb` "Harden .gitignore and document GitHub setup changes" |
| Push `codex/main` to GitHub | ✅ Done |
| Force push `codex/main` → `main` | ✅ Done — `main` is now the live branch with full codebase |
| Repo made public | ✅ Done — [github.com/3Dendeavors/Triority](https://github.com/3Dendeavors/Triority) is publicly accessible |
| GitHub Release v1.0.0 created | ✅ Done — APK pulled from Ross's phone (`triority-from-ross-phone-2026-05-06.apk`, ~56MB) uploaded as release asset |
| Beta testers sent link | ✅ Done by Ross |

---

## For Codex — Next session priorities

1. **Rotate Firebase API key** — key `AIzaSyBDewIrv...` existed in local git history before rewrite. Low urgency (Firestore rules are tight, repo was private before rewrite), but should be rotated at next APK rebuild. Steps: Firebase console → Project Settings → General → Web API Key → rotate → download new `google-services.json` → rebuild APK.

2. **GitHub Actions APK build automation** — set up a workflow that builds and signs a release APK automatically when a version tag is pushed (e.g. `git tag v1.1.0 && git push --tags`). Keystore password is in `android/keystore.properties` (not in repo — store as GitHub Actions secret). APK naming convention TBD.

3. **`latest.json` update checker** — implement in-app version check on launch. Fetch a public JSON file from GitHub (e.g. `https://raw.githubusercontent.com/3Dendeavors/Triority/main/latest.json`), compare `versionCode` to installed version, show popup if newer. See Codex's original suggestion in session screenshots for exact JSON schema.

4. **Codex's unstaged working tree changes** — at time of Claude's last action, the following Codex changes were still uncommitted:
   - `App.tsx` — modified
   - `firestore.rules` — modified
   - `CODEX_CHANGES.md`, `CODEX_WORKSPACE.md`, `HANDOFF.md`, `archive/HANDOFF2.md.archive` — deleted
   - `AGENTS.md`, `ARCHITECTURE.md`, `PRD.md`, `PRODUCT.md`, `ROADMAP.md`, `WORKSPACE_STRUCTURE.md`, `docs/`, `plans/` — untracked, not yet committed
   These need to be committed and pushed to keep GitHub in sync.
