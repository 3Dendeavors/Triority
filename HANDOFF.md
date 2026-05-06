# Triority — Session Handoff

**Updated:** 2026-05-05 (session 14 — pivot from Play Store to GitHub distribution, finishing shared lists)
**Repo:** `E:\Creative\Triority\Triority`
**Single source of truth:** `App.tsx` (~5900 lines, everything in one file)

---
new_string: ## 🛑 Session 14 stop point #2 — usage near limit (2026-05-05 ~21:00)

**On-disk state at stop:**
- We're on **release-build dev loop** now (Metro retired). Iteration is `cd android && ./gradlew.bat app:assembleRelease` (~18s on warm cache) → `adb install -r android/app/build/outputs/apk/release/app-release.apk`. Use the same keystore so no uninstall needed between same-keystore release builds (only needed once when swapping debug→release).
- Release APK currently installed on phone is **stale relative to the in-progress edits below**. After signing in, user reported five issues; partial fixes are in `App.tsx` working tree but **not yet committed and not yet rebuilt**.

**Uncommitted edits in App.tsx (need commit + rebuild + install):**
1. ListActionSheet rename input: `selectTextOnFocus={false}` + cursor-at-end on focus (mirror of EditSheet fix). Fixes the first-letter-highlight bug specific to renaming a list (task edit was already fixed).
2. ListActionSheet's Share-this-list button now passes any in-progress rename text up to the parent via a new optional `pendingName` parameter on `onShareList`. **The parent's onShareList handler in `ActiveList` (App.tsx ~4421) still needs to be updated to ACCEPT and USE that parameter** — currently it ignores the param. Without that follow-up, the rename-then-share scenario still produces a shared list with the old name.

**Bugs reported during the post-release-install verification, ordered by severity:**

1. **Personal home icon disappears after sign-in.** Cloud restore overwrites local `lists` with whatever's in the user's Firestore doc — that doc was written before the personal-list redesign existed, so `DEFAULT_LIST_ID` isn't in the restored array, and `isPersonal={l.id === DEFAULT_LIST_ID}` is false on every pill.
   - **Fix:** in the cloud-restore path, if no list has id `DEFAULT_LIST_ID`, prepend an empty Personal list so the user's home base always exists. The restore code is in `TriorityApp` near where `getDoc(users/{uid})` is called and the remote slice is folded back into local state. Find the restore handler that calls `setListsState(remote.data.lists)` and wrap the value with `ensurePersonalListPresent(lists)` (write the helper).

2. **Cannot drag shared list pills.** Private pills drag-reorder fine. Shared pills won't even initiate a drag. Probably a guard in `DraggablePill`'s long-press handler or `ListPillRow` skipping shared. **Not yet investigated.**

3. **Cannot delete shared list.** Owner sees the "Delete List" button (per the sharedMode UI at ~3690-3700) but tapping it doesn't visibly do anything. Possible causes:
   - The `setActionList(null)` + `confirm()` deferred-microtask pattern from earlier this session was applied to the SHARE handler but NOT to the shared-mode `onDelete` handler. When the action sheet unmounts, the confirm dialog's setState may be discarded. **Apply the same `setTimeout(..., 0)` defer pattern to the shared `onDelete` handler at App.tsx ~4502.**
   - OR `deleteSharedList` is throwing silently on the items batch delete — check logcat after a delete attempt.

4. **Slow share + slow delete (5–10s each).** Real Firestore latency, not Metro. Suspects: items batch on big lists, ACL get() for items rule on every item delete, sync engine triggering a debounced write of the user blob mid-promote. Profile before fixing.

5. **EditSheet panel still hides bottom buttons under keyboard.** Original report. Sheet shifts into the visible area but Save/Cancel buttons sit below the keyboard's top edge. Need to either shrink ScrollView maxHeight when keyboard up (currently 248) or ensure footer is positioned outside the scroll. Look at App.tsx ~2110 area.

**Fixed and verified working on phone in this session:**
- Share-this-list works (rules fix + two-phase write + deferred confirm).
- Personal list immutable: no Share, no Delete in its action sheet (verified before sign-in).
- Pill rename input no longer auto-selects on focus.
- The reorder-creates-duplicate bug for private pills (filtered out shared IDs in reorderLists).

**Stashes still sitting (drop with `git stash drop` if no longer needed):**
- `stash@{0}: main-dup-deleteList-fix-2026-05-05`
- `stash@{1}: old-agent-step13-draft-2026-05-05`

**Next session pickup:**
1. Commit the in-progress App.tsx edits with a message explaining the partial state of #2 above.
2. Update parent `onShareList` handler to accept + use `pendingName`.
3. Add `ensurePersonalListPresent` helper + wire into cloud restore path.
4. Defer the shared `onDelete` handler with `setTimeout(..., 0)`.
5. Investigate shared pill drag.
6. Rebuild release APK + install + verify.

Then continue down the bug pile (post-promote code reveal, demote path, grocery delete UX, grocery sharing, sluggish settings, etc.).

## 🧹 Git state confusion — session 14, late session

**Late in session 14 (~2026-05-05 21:00) the git state diverged from the on-disk file in a way I couldn't cleanly untangle.** Symptoms:
- Edits via the Edit tool sometimes wrote to BOTH the worktree checkout AND the main checkout simultaneously (they share `App.tsx` because the worktree's `App.tsx` is the same path the main repo uses — there's only one file on disk).
- I committed the same change on both branches, creating duplicate commits.
- A stash + ff + checkout sequence reverted on-disk changes that were already in git history.
- After the dust settled: git log on `main` shows commits `7719f70`, `7b9fce0`, etc., but the on-disk `App.tsx` does NOT reflect all of those commits — specifically `7b9fce0`'s `deleteList` rewrite was reverted on disk but not in history.

**Decision (Ross's call):** stop trying to reconcile, treat the on-disk file as the truth from here forward. Commit those edits going forward without worrying about past divergence. Future sessions can untangle with a fresh worktree if needed.

**Stashes left for safekeeping (drop with `git stash drop` once confirmed unneeded):**
- `stash@{0}: main-dup-deleteList-fix-2026-05-05` — duplicate of commit `7b9fce0`'s changes that ended up in main's working tree somehow.
- `stash@{1}: old-agent-step13-draft-2026-05-05` — the previous agent's pre-step-13 draft from the very start of session 14.

**What's actually true on disk as of this note:**
- `App.tsx` has all the visible UI fixes (share works, defer-confirm, two-phase write, EditSheet kbHeight/kbAppeared, instrumentation-stripped onShareList).
- `App.tsx` does NOT have the `deleteList` reseed-on-empty rewrite — the file still has the original `if (prev.length <= 1) return prev` guard.
- That guard is being intentionally KEPT now, in favor of the new design Ross described: hard-coded "Personal" list (`DEFAULT_LIST_ID`) is immutable — never deletable, never shareable, lives at the front of the lists row with distinct styling. So the `length <= 1` guard becomes redundant since Personal is always there as a floor, but it does no harm.

---

## 🔁 Mandatory dev-loop sequence after every code edit

Established the hard way in session 14. Skipping any step ends in "no toast / no error / no nothing" silent failures that look like the app code is broken but is actually the stale-bundle problem in disguise. Do all four, in order:

1. **Edit + commit on the worktree branch.**
2. **`git -C E:/Creative/Triority/Triority merge --ff-only <worktree-branch>`** — Metro reads from main, NOT the worktree. Edits committed only to the worktree are invisible to Metro.
3. **`shake → Reload` on the phone.** This re-fetches the bundle from Metro.
4. **Wait for Metro to actually finish bundling.** First reload after `--reset-cache` or after a long-idle Metro instance can take 60–180s. The phone shows the loading spinner on the dev screen during this. If you tap around in the app before bundling finishes, you'll see no UI updates at all — that's normal, just wait.

If bundle build is suspect, verify before testing:
```bash
curl -s --max-time 180 "http://localhost:8081/index.bundle?platform=android&dev=true&minify=false" -o /tmp/b.js
grep -oa "<unique-string-from-your-edit>" /tmp/b.js | head -3
```

When Metro gets really stuck (cache-pollution suspected): kill Metro, wipe `node_modules/.cache` + `%TEMP%/metro-*` + `%TEMP%/haste-map-*`, restart with `npm start -- --reset-cache`. First bundle build after reset is ~180s — be patient.

## ⚠️ Known dev-loop hazard — Metro reload silently serves stale JS on this project

Hit twice in session 14 (2026-05-05). Symptoms: edit App.tsx, see Metro report "Reload" or "Refreshing", launch reload from the phone, but the running JS is still the OLD code. Confirmed by curl-ing the bundle endpoint and grepping for code-shape strings only present in the new edits — bundle still contains the old code.

**Workaround:** rebuild + reinstall the debug APK every iteration. Metro reload is *not* reliable.

```powershell
cd E:\Creative\Triority\Triority\android
.\gradlew.bat app:assembleDebug   # ~24s on a warm cache
adb install -r app\build\outputs\apk\debug\app-debug.apk
adb reverse tcp:8081 tcp:8081     # uninstall drops this; install doesn't, but harmless to re-run
```

Don't `adb uninstall` first — that wipes data. Same-keystore install upgrades cleanly. (We DID uninstall once early in this session because of the release→debug keystore swap, but subsequent debug→debug installs don't need it.)

To verify the served bundle has your edits before testing:
```bash
curl -s --max-time 90 "http://localhost:8081/index.bundle?platform=android&dev=true&minify=false" | grep -c "<unique-string-from-your-edit>"
```

A `0` means Metro is serving stale; rebuild the APK.

**Root cause:** unknown. Possibilities: Metro's haste/watchman not picking up changes from worktree paths; some kind of bundle cache; the `bundleAssetName` config diverging from what the dev server returns. Not worth investigating until distribution settles.

---

## 🛑 Stop point — usage near limit

Stopped 2026-05-05 mid-bug-fix. Pick up in next session from item 1 below.

**State of the world:**
- Steps 13/14/15 are deployed in a fresh debug APK on the S24 (rebuilt + reinstalled to bypass Metro reload silently serving stale JS — that was the entire reason early share attempts failed without surfacing toasts).
- Worktree branch `claude/happy-morse-286d3b` has all the work. Main was fast-forwarded earlier to `7a38500`. New commits since: `92e9a21` (rules fix), `708e192` (EditSheet kbHeight + kbAppeared seed). Worktree is dirty with uncommitted instrumentation toasts in `onShareList` (App.tsx ~4382) — those are debug-only and should either be removed or kept until item 1 is solved, not committed as-is.
- Firebase rules ARE published (Ross did this manually). The `list` rule split is live.
- Latest reproduction (with instrumentation toasts): user tapped Share, saw the "Could not share" toast with permission-denied. So the rules fix unblocked the share-code probe (`getDocs` query against `sharedLists`) — but then the **batched parent + item writes** are still failing because the items rule looks up `acl` via `get(/sharedLists/$listId)` which hits pre-batch state where the parent doesn't exist yet. Classic Firestore foot-gun.

**Next session, do these in order:**

### 1. Fix the items-rule-vs-batched-write deadlock
Two-phase the promote write so the parent doc is committed *before* the items batch runs. The items rule's `get()` will then see the freshly-written parent and admit the item writes.

In `App.tsx` ~892 (`promoteTaskListToShared`):
```ts
// Phase 1: parent doc alone (so the items rule's get() sees it).
await setDoc(parentRef, parentData);
// Phase 2: items batch (rule allowed because get() now returns the acl).
const batch = writeBatch(db);
for (const t of list.tasks) { batch.set(itemRef, ...); }
await batch.commit();
```
Trade-off: not atomic — a network drop between phase 1 and phase 2 leaves a parent with no items. Acceptable for v1; a user who hits this can just delete the empty shared list and retry. If we ever want atomicity, the alternative is widening the items rule to allow create-without-acl-lookup when the writer is the parent's `ownerUid`. That's a rules-only fix, but adds a `get()` for *every* item create which trades correctness for cost.

After applying the fix:
- Strip the instrumentation toasts in the `onShareList` handler (App.tsx ~4382). Restore the original concise toast wording.
- Rebuild + reinstall debug APK (`./gradlew app:assembleDebug` + `adb install -r`).
- Verify share works end-to-end with the same retry, plus join from a second account or device.

### 2. Verify the EditSheet fixes (already in code, unverified on phone)
The fresh APK install should have picked them up. Confirm:
- EditSheet opens with keyboard already up (e.g. type in InputBar, then tap a row's pencil) → panel sits above the IME, not behind it.
- First keystroke after EditSheet opens with keyboard down → not dropped.

### 3. Add a post-promote 'here's your code' reveal
Today the only feedback is a 3.5s toast saying "Tap pencil to see the share code." First-time-share users find this baffling. Want a dedicated reveal modal: big monospaced 6-char code + "Copy" + "Done" buttons, appears immediately after promote success. Replace the toast with this modal as the success surface. Add a `Clipboard.setString(code)` on Copy.

### 4. Owner demote/unshare path
Action-sheet row "Make this private again" (owner-only, only on shared lists). Copies items back to a fresh local list, deletes the shared one (which fans `list_deleted` notifications). Members already have "Leave with copy" per step 10.

### 5. Soften promote confirmation copy
Current: *"Share '[name]'? Items will be moved to a shared list. You can leave or delete it later."*
Suggested: *"Turn '[name]' into a shared list? You'll get a 6-character code to share with friends or family. Either of you can leave or delete it anytime."*

### 6. Remove "pill row" from user-visible copy
Internal name for the horizontal lists strip above the InputBar. Code comments are fine. Search for any toast/sheet/alert/error copy with "pill row" and replace with "lists" or "lists row." Likely candidates to scan: limit toasts, empty-state hints, any tutorial copy in onboarding.

### 7. Grocery delete UX consistency
Today: swipe-left grocery item → opens `ConfirmDialog`. Tasks: swipe-left → reveals pulsing accent trash button → tap = delete (no confirm). Make grocery match. The reveal-trash machinery in `TaskRow` (App.tsx ~2290) is the reference — port the same pattern into `GroceryItemRow`.

### 8. Wire grocery list sharing
Originally deferred (steps 7 + 12) — now wanted. Three pieces:
- Promote-grocery action: entry point in the standalone grocery screen's pencil/share spot (TBD where exactly).
- Shared-grocery items adapter: mirror the shared-tasks adapter at App.tsx:6722.
- Display toggle button in the grocery top bar: only visible when in a shared grocery list, swaps between viewing the local + shared slices.

### 9. Settings tap feels sluggish (low priority)
Noticeable but tolerable. Probably JS bundle bloat from steps 13/14, or the cold-start notifications query running on the same render path. Profile before guessing.

### 10. Step 16 — GitHub release
Once items 1–7 are done and the app is stable. Bump versionCode 17 / versionName 1.5.0. Build SIGNED-RELEASE APK (not debug, not AAB). Generate SHA-256 checksum.

**🔑 BLOCKER before publishing:** verify `triority-release.keystore`'s SHA-256 is registered in Firebase Console → Project Settings → Android app → SHA certificate fingerprints. If missing, sign-in fails with `DEVELOPER_ERROR` and Firestore stays offline.
- Get fingerprint: `keytool -list -v -keystore android/app/triority-release.keystore` (alias is in `android/keystore.properties`).
- Compare against Firebase. Add via the Console UI if missing (no rebuild needed).
- Don't remove the Play App Signing cert until vc16 is unpublished.

Then create GitHub release tag `v1.5.0`, attach APK + checksum + release notes.

---

## 🐛 Live bug pile (2026-05-05, mid-session)

Discovered while testing steps 13/14/15 on the S24 with a debug build off Metro. Order = priority. Update as items land.

**This session's plan:** finish the first three items here (share works, regressions verified, post-promote code reveal), commit, stop. Items 4–10 roll to next session.

1. **Share-this-list silently fails after rules fix.** Confirmation modal completes, action sheet closes, no toast either way, no Firestore activity in logcat, no `users` icon on the active list afterward. Either the promise isn't awaited (handler structure bug) or the success path doesn't update local view (listener attaches but the new ID isn't in `joinedIds` yet). Need to instrument with a pre-write toast or log statement and re-test.
   - File: `App.tsx` around line 4377 (the `onShareList` handler in `ActiveList`'s `<ListActionSheet>` props block).
   - And `App.tsx` around line 892 (`promoteTaskListToShared` in `SharedListsProvider`).
   - The catch path shows a toast, so absence of toast → either the call resolved cleanly or it never ran.

2. **First-keystroke-drop regression introduced this session.** I added `Keyboard.metrics()` seeding for `kbHeight` (legit fix for the IME-overlap-on-open bug) but forgot to also seed `kbAppeared`. That left the 350ms retry loop firing a `blur+focus` even when the IME was already up — exactly the IME bounce that produces the first-keystroke-drop. Fixed in code (App.tsx ~2024) but **unverified on phone** as of this writing.

3. **EditSheet panel hides under keyboard when opened with IME already up.** Cause: `kbHeight` initialized to 0; `keyboardDidShow` doesn't fire on subscribe-while-already-shown; panel's `bottom: panelBottom` reads 0 → sits behind IME. Fixed in code by initializing `kbHeight` from `Keyboard.metrics()?.height ?? 0`. **Unverified on phone**.

4. **Owner has no demote path.** Once a list is shared, the only owner-side exit is "delete list" which deletes for everyone. Need an owner-only "Make this private again" / "Unshare" option in the action sheet that copies items back to a fresh local list, then deletes the shared one (which fans `list_deleted` notifications to other members — that's their notice). Members already have "Leave with copy" per step 10.

5. **Promote confirmation copy reads off-putting.** Current text: *"Share '[name]'? Items will be moved to a shared list. You can leave or delete it later."* Users find "moved" + "leave or delete" combo unsettling. Want softer wording — e.g. "*This will turn '[name]' into a shared list. You'll get a 6-character code to share with friends or family. Either of you can leave or delete it anytime.*"

6. **"Pill row" appears in user-visible copy.** Internal name for the horizontal lists strip above the InputBar. Code comments are fine to keep, but **never use "pill row" in any user-facing string** (toast, alert, sheet copy, etc). Just call it "lists" or "your lists" or "lists row" if needed.

7. **Grocery item delete UX inconsistency.** Tasks: swipe left → reveals pulsing accent-red trash button → tap = delete (no confirm). Grocery: swipe left → opens a `ConfirmDialog` modal. **Make grocery match tasks** — same swipe-to-reveal-trash pattern.

8. **No grocery list sharing UI.** HANDOFF originally deferred steps 7 + 12 (promote-grocery + display toggle). Ross now wants grocery sharing. Means: grocery promote action (entry point in the standalone grocery screen pencil/share spot — TBD where exactly), the shared-grocery items adapter (mirroring the shared-tasks adapter at App.tsx:6722), and the display toggle button in the grocery top bar (only visible when in a shared grocery list, swaps between viewing the local + shared slices).

9. **Post-promote share-code reveal is missing.** Today, after a successful promote, the only feedback is a 3.5s toast: *"Shared list created — Tap pencil to see the share code"*. First-time-share users have no idea what just happened or what to do next. Want a dedicated reveal modal showing the 6-char code in a big monospaced font + "Copy" + "Done" buttons so the user can immediately send it to someone.

10. **Settings tap feels sluggish.** Noticeable but tolerable. Likely culprits: cold-start notifications query (step 14), MemberAvatar/relTime work on every TaskRow render (step 13), or just JS bundle growth. Need profiling, not guessing.

### What's already fixed vs what's still in code

**Committed this session before bugs surfaced:** rules pivot doc, steps 13/14/15.

**Committed mid-session:** rules fix for the `sharedLists` list query (`92e9a21`).

**In code, uncommitted (need to verify on phone first):**
- `kbHeight` init from `Keyboard.metrics()` (App.tsx ~2010) — fixes bug #3
- `kbAppeared` seeded from `Keyboard.metrics()` (App.tsx ~2024) — fixes regression #2

**Not yet started:** bugs 1, 4–10.

---

## 🚨 Strategic pivot — 2026-05-05

**Triority is no longer a Play Store paid app.** Going forward:

- **Distribution:** GitHub Releases (signed APK), free for everyone. No more Play Store uploads.
- **Pricing:** $0 — paywall is being stripped entirely. RevenueCat / IAP code goes dormant or out.
- **Donations:** optional via **Patreon** + **Buy Me a Coffee**. Settings gets a "Donate" row.
- **Future:** a web app (so users can sign in with Google in a browser and see the same data as on mobile). Deferred until after this release ships.
- **Eventual:** personal portfolio website hub linking all of Ross's projects.

**Why:** Google Play requires a publicly-listed business address for paid apps, which Ross is not willing to disclose for privacy/safety reasons. Unpublishing from Play and self-distributing via GitHub side-steps that entirely.

**Security posture:** unchanged. Firestore rules, encrypted local storage for the API key, default-deny everywhere — all of that stays. We're dropping the *commercial channel*, not the security model.

### Concrete consequences for the current session
1. **Finish shared lists (steps 13–14)** as already planned — sync work is uncoupled from distribution.
2. **Step 15 (Pro gate enforcement) is repurposed** to **strip the paywall**: rip out `useIsPaid()` gates, `ProUpsellSheet`, RevenueCat init, Restore Purchase row. Add a Settings → Donate row pointing to Patreon + Buy Me a Coffee.
3. **Step 16 is repurposed** from "Play AAB upload" to "**GitHub Release artifact**": bump version, build a signed APK (not AAB), draft GitHub release notes, attach APK + checksum.
4. **vc16 stays on Play internal track for now**, but **plan to unpublish the listing** once GitHub release is up. Reason: the Play listing currently displays Ross's address publicly. Unpublishing removes that exposure. Tracked as a punch-list item.

### Things this pivot retires (no longer relevant)
- Play Console price changes ($1.99 vs other) — moot.
- Promo codes / license testing list — moot once we unpublish.
- Self-refund of Ross's $1.99 — Ross already opted not to. Strike.
- Privacy Policy URL on the Play listing — still needed for the in-app Settings row + GitHub README, but Play-listing enforcement no longer applies.
- The "AAB build & upload" workflow — replaced by signed-APK release-asset workflow.
- Any future $1.99 → variable-price thinking — gone.

### Things this pivot keeps
- Firestore Phase 1 + Phase 2 sync architecture — unchanged.
- Local AsyncStorage as the offline-first store — unchanged.
- `google-services.json` + Firebase project — unchanged. (Firebase Auth is still how users sign in, even on web later.)
- Encrypted API key storage, ProGuard/R8, default-deny rules — unchanged.

---

## 🏷️ Active checkpoint — `vc16-pre-phase2`

Tagged 2026-05-05 at `1cfdfe4` (the vc16 / 1.4.0 release commit, after Firestore Phase 1 was confirmed working in closed test). Use this to revert all of Phase 2 cleanly:

```
git reset --hard vc16-pre-phase2
```

Each Phase 2 commit lands as its own logical step (data layer, rules, listeners, promote, join, etc. — see plan below) so individual pieces can be reverted without taking the whole feature down.

---

## 🎯 Current focus (session 14) — Phase 2 shared lists

**Status:** design fully locked with Ross 2026-05-05. Implementation starting from step 1.

### Status of session-13 follow-ups (cleared 2026-05-05)
- ✅ **Data Safety in Play Console** updated (email, name, app activity disclosed; Firebase UID may or may not be — Ross unsure, low risk).
- ✅ **Privacy Policy URL** in place on Play Console listing. *NOT yet linked from inside the app — punt to a small Settings row in Phase 2 polish.*
- ✅ **License testing** flipped + working. Ross has promo codes for handouts.
- ❌ **Self-refund** — Ross opted not to refund his own $1.99. Strike from list.
- ✅ **Play Console price** is $1.99.
- ⏳ **Onboarding re-trigger** on version bump — not done. Punt; revisit when we touch onboarding for sharing UX in v2.
- ✅ **vc16 is live on closed testing track.**

### Phase 2 design — LOCKED 2026-05-05

Decisions confirmed with Ross in session 14, in order:

1. **Whole-list sharing.** Items are not assigned to individuals; everyone in the list edits everything.
2. **Short-code invite.** Reusable + regenerable. No email lookup, no Cloud Functions.
3. **Per-item conflict resolution.** Items live in a Firestore subcollection. Per-item last-write-wins. Private lists keep the single-doc Phase 1 model — only shared lists pay the per-item cost.
4. **Pro-gated.** Everything from here forward is paid. Share/join entry points show lock for free users.
5. **Roles:** owner ("admin") + member. Owner can rename, delete (cascade-notifies members), kick, rotate code. Member can add/edit/complete/leave. No ownership transfer in v1.
6. **Owner-deletes-list:** members get a notification ("Kailyn deleted the shared list 'Roadtrip'"). List vanishes from their pill row.
7. **Offline edits:** ride Firestore SDK defaults. Toast on disconnect: "Offline — changes will sync when connection returns." No special handling. Acceptable to lose an entry in extreme races.
8. **Pill row marker:** `users` Feather icon prefix on shared pills. ALL shared lists, regardless of owner-vs-member. Drag/drop reorder remains local-only per user. Try `users` first, fall back to `link` if it reads bad at small size on the S24.
9. **Avatars:** 8 colored dots, first letter of email. Assigned on join from next-free slot. Latest editor's avatar + relative timestamp ("2m ago") on each item. **No real names/emails shown in v1.** Long-press identity reveal annotated as v2 want.
10. **Tasks screen — top-right buttons:**
    - **Pencil** = unified `ListActionSheet`: rename (or pull rename out — see #11), Share this list, Sync settings (members, rotate code, leave/kick), Delete list. Only shows share/sync rows when relevant.
    - **Archive** unchanged.
11. **Inline rename via tap-list-title.** Tap the big list name above the date/counter on the Tasks screen → inline rename. Pulls rename out of the sheet — faster, more direct.
12. **Grocery tab — top-right buttons:**
    - **Share/sync settings button** always present (opens unified sheet).
    - **Display toggle button** — only shown when user is in a shared grocery list. Filled when viewing shared, outlined when viewing private. Tapping swaps which slice you're looking at. Both private grocery and shared grocery exist simultaneously, both editable.
13. **Promote private → shared (way B).** Pencil → "Share this list" copies items into the shared subcollection, removes them from the private slice, replaces the pill entry with a shared-flagged version. Confirm dialog: *"Share '[name]'? Items will be moved to a shared list. You can leave or delete it later."*
14. **Demote shared → private (2-way symmetry).** Approved. Quick "remove from shared, take offline" — items copy back into a new private list, user leaves the shared list (or owner deletes it for everyone). Decide UX: only owner can demote-for-all (which is just delete), members can "take a copy and leave." Cleanest model: members get "Leave with copy" option in the share sheet alongside "Leave" (no copy).
15. **Join limits:** 1 shared grocery list max, 5 shared task lists max. Joining beyond limit shows toast.
16. **Notifications primitive:** scaffolded in v1. Only "owner deleted list" wired. Joins/leaves/kicks/item-level activity punt to v2.5.

### Data model

```
users/{uid}                                  ← Phase 1, additive
  data: { lists, archive, grocery, themes, ... }
  joinedSharedLists: string[]                ← shared list IDs user is in
  syncEnabledForGrocery: boolean             ← display toggle state for grocery

sharedLists/{listId}
  ownerUid: string
  kind: 'tasks' | 'grocery'
  name: string
  acl: string[]
  shareCode: string                          ← 6-char, regenerable
  members: { [uid]: { avatarSlot: 0-7, emailInitial: 'k', joinedAt, lastSeenAt } }
  createdAt, updatedAt

sharedLists/{listId}/items/{itemId}
  text, tier?, completed, reminder?, category?
  createdBy, createdAt
  lastEditedBy, lastEditedAt

users/{uid}/notifications/{notifId}          ← v1 only writes "list_deleted"
  type: 'list_deleted' | (future)
  payload: { listName, ownerInitial, ... }
  readAt: number?
  createdAt
```

### Firestore rules additions (publish manually via Console after step 2 lands)
- `sharedLists/{listId}` read/write: `request.auth.uid in resource.data.acl`.
- Create: any authenticated user; sets `ownerUid = request.auth.uid` + `acl = [request.auth.uid]`.
- Delete: `request.auth.uid == resource.data.ownerUid` only.
- Items subcollection: membership check via `get(/sharedLists/$(listId)).data.acl`.
- Rate limit per-list: 1 write/sec/user.
- Doc size cap on parent `sharedLists/{listId}`: 32 KB. Items uncapped (subcollection).
- Notifications: read/write own; cross-write allowed when deleting client was previously in the list's `acl`. Slight rule complexity — flagging for review.

### Commit-by-commit plan (with completion tracking)

Each step lands as its own commit. Mark `[x]` as done. Step descriptions below in implementation-ready form.

- [x] **Step 1.** Scaffold `sharedLists` data layer — types (`SharedList`, `SharedListItem`, `Notification`), helpers, `joinedSharedLists` + `syncEnabledForGrocery` added to user doc schema (backward-compat read). No UI. → `0d89339`
- [x] **Step 2.** Firestore rules update (`sharedLists` + `sharedLists/items` + `users/{uid}/notifications`). Ross publishes via Console. Build still green pre-publish (writes fail closed). → `bf40fd8`
- [x] **Step 3.** Share-code generator + collision retry. Pure function, 6-char alphanumeric, excluded ambiguous chars (0/O, 1/I/l). → `a1cdc48`
- [x] **Step 4.** Avatar slot allocator — assigns next-free slot 0–7 on join. Pure function. → `f11a7b7`
- [x] **Step 5.** Real-time listeners — `onSnapshot` per joined shared list + items subcollection, fold into local state. Detach on AppState background, reattach on foreground. → `56bafb9`
- [x] **Step 6.** Promote private → shared (Tasks). Confirm dialog, batched write, replace pill entry. → `678a1f8`
- [ ] **Step 7.** Promote private → shared (Grocery) singleton — flips `syncEnabledForGrocery=true`. *(skipped for now — grocery promote/demote left as a follow-up; tasks-only is enough to ship)*
- [x] **Step 8.** Join via share code (Settings row). Limits: 1 grocery, 5 task lists. → `06a0269`
- [x] **Step 9.** Inline rename via tap-list-title (Tasks screen). → `4c256d5`
- [x] **Step 10.** Pencil-driven unified `ListActionSheet` — Share/Sync rows. Owner sees rotate/kick/delete; member sees leave + "Leave with copy" (demote). → `c5987a1`
- [x] **Step 11.** Pill row `users` icon marker on shared pills (visual only). → `1635e73`
- [x] **Step 11b.0/.1/.2/.3** Provider CRUD for shared task items + widen `Task.id` + `ActiveList` `sharedActions` branching + parent adapter. → `cd3ba62 ba2b0b5 730f461 8b88812`
- [ ] **Step 12.** Grocery display toggle button (shown only when in shared grocery). *(deferred with step 7 — tasks ship first)*
- [ ] **Step 13.** Per-item avatar dot + initial + relative timestamp render on Task rows when item belongs to a shared list. *(in progress — previous agent ran out of usage mid-edit; resuming this session)*
- [ ] **Step 14.** Notifications primitive + "list deleted" wiring. Cold-start surfacing.
- [ ] **Step 15. (REPURPOSED)** ~~Pro gate enforcement on share/join entry points.~~ **Strip paywall.** Remove `useIsPaid()` gates, `ProUpsellSheet`, RevenueCat init, Restore Purchase row. Add Settings → "Donate" row pointing at Patreon + Buy Me a Coffee. Everything that was Pro becomes free for everyone.
- [ ] **Step 16. (REPURPOSED)** ~~vc17 / 1.5.0 bump + AAB.~~ **GitHub Release.** Bump versionCode to 17, versionName to 1.5.0. Build **signed APK** (not AAB). Generate SHA-256 checksum. Draft `RELEASE_NOTES.md` for v1.5.0 — "Shared lists, free on GitHub, donate links added." Create GitHub release tag `v1.5.0`. Attach APK + checksum + release notes.

  **🔑 BLOCKER to verify FIRST: Firebase SHA fingerprint registration.** Google Sign-In on Android verifies the calling app's signing cert against fingerprints registered in the Firebase project. If the GitHub APK's signing cert (`triority-release.keystore`) is *not* registered in Firebase Console → Project Settings → Android app → SHA certificate fingerprints, sign-in fails with `DEVELOPER_ERROR` and Firestore sync stays offline.
   - Get the SHA-256: `keytool -list -v -keystore android\app\triority-release.keystore -alias <alias>` (alias is in `android/keystore.properties`).
   - Compare against the fingerprints listed in Firebase Console.
   - If missing, add it via the Firebase Console UI (no rebuild needed; it's a remote registration). google-services.json doesn't need to change.
   - The Play App Signing cert (used for vc14/vc16 distribution copies) was already registered — do NOT remove it until vc16 is unpublished from Play Console, since existing testers' installs are signed with that cert.
   - Once vc16 is unpublished and a few testers have migrated to the GitHub build, the Play App Signing cert can be removed from Firebase to tighten the trust set.

### After step 16 — punch list (post-release)
- **Unpublish vc16 from Play Console.** Reason: the listing displays Ross's address. Once GitHub release is up and a couple of testers have migrated, unpublish.
- **Privacy Policy** as a static page in the GitHub repo (`PRIVACY.md` or `docs/privacy.html`). Wire the link from a Settings → Privacy row.
- **README rewrite** for the GitHub repo: install instructions (download APK, allow unknown sources), screenshots, donation links, "no analytics, no telemetry, BYOK for AI" pitch.
- **Code signing for GitHub APK distribution.** Already signed with `triority-release.keystore` (valid through 2051). Confirm `apksigner verify --print-certs` output looks clean. Document the keystore fingerprint in the README so users can verify upgrades are from the same author.
- **Web app (future track — see "Web app — future scope" section below).**

### Web app — future scope (defer to next session block)

Recorded now so design decisions survive between sessions. **Not implementing this session.**

**Goal:** users can sign in via Google in a browser at e.g. `triority.app` (or whatever domain) and see/edit the same data they see on mobile. Mobile remains the primary surface.

**Two viable approaches — decide when we pick this up:**

1. **Separate Next.js app reading the same Firestore.** Pros: clean web stack, fast iteration, SEO-friendly landing page comes for free. Cons: two codebases to keep in sync; UI must be re-implemented (Tailwind or similar). Best for a deliberately different web UX.
2. **React Native Web** — compile App.tsx itself to a web bundle. Pros: one codebase, near-100% UI reuse. Cons: RN Web is finicky for some libs (`react-native-purchases` (now stripped), `react-native-encrypted-storage`, `@notifee/react-native`, the SwipeRow PanResponder code, the speech-recognition kit) — every native lib needs an audit and likely a `Platform.select` shim or a web stub. Real risk of "it kinda works" eating weeks.

**Tentative recommendation when we pick this up:** **separate Next.js app**, share only the **Firestore data shape + types**. Mobile keeps its native feel; web gets a bookmarkable, keyboard-friendly UI. The shared-lists design already uses Firestore as the source of truth, so a web client just reads/writes the same docs against the same security rules.

**Auth on web:** Firebase Auth web SDK + Google provider. Same `users/{uid}` document. Same `sharedLists/{listId}` ACLs. Zero rule changes needed.

**Hosting candidates:** Vercel (free tier covers a personal app), Cloudflare Pages, GitHub Pages (static-only — won't work if we need server-side Firebase Admin for anything). Vercel is the path of least resistance.

**Domain:** TBD. `triority.app` if available, otherwise something under Ross's eventual portfolio hub domain.

**Not in scope for the web app v1:**
- Push notifications (Firebase Cloud Messaging on web is doable but extra setup — punt to v2).
- AI Triage in browser (BYOK API key in localStorage is fine, but skip until v2).
- Voice input (Web Speech API exists, deprioritize).

**Personal portfolio hub (further future):** a single landing site that links to Triority web app, the WoW/Tribe project, the SVA Medical pages, etc. Probably the same Vercel project or a sibling. Way out, just noted so we don't lose it.

### Annotations (v2 wants — recorded so we don't lose them)
- Long-press item → reveal real name/email of last editor.
- Email-based invites (Cloud Functions for UID lookup).
- Ownership transfer when owner deletes account.
- Soft-delete to handle the offline edit-vs-delete race.
- Rich notifications: joins, leaves, kicks, item activity ("Kailyn added 3 items").
- Onboarding re-trigger covering sharing UX.
- In-app Privacy Policy link (Settings row).
- Custom avatar selection (instead of auto-assigned colored dot + initial).

### Build order (where we actually are)
**Done:** 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 11b.0–11b.3.
**Skipped/deferred:** 7, 12 (grocery share — punt to a follow-up release).
**Remaining this session:** 13 (in-progress), 14, 15-repurposed (strip paywall), 16-repurposed (GitHub release).

### Risks / things to watch
- **Notifications without Cloud Functions:** cross-user subcollection writes need permissive rules. Workable but slightly less clean than a CF.
- **Listener cost:** up to 6 active listeners (5 shared task lists max, plus the eventual grocery one — currently deferred). Fine; just detach on background.
- **Demote/Leave-with-copy semantics** — confirm in build that "leave with copy" creates a *new* private list with a unique name (not silently merging into an existing private list of the same name).
- **Stripping the paywall** is a bigger code change than it sounds. RevenueCat init touches the app root. `useIsPaid()` is referenced from many sites (grocery tab, theme picker, accent picker, multi-list, AI cross-list, Restore row). Plan: **leave RevenueCat dep in package.json but stop initializing it**, and replace `useIsPaid()` with a constant `() => true`. That gives one revertable diff if we change our mind. Settings → "Restore Purchase" row becomes "Donate" row (Patreon + BMAC links via `Linking.openURL`).
- **Future Play unpublish:** confirmed action item. After GitHub release stabilizes, take the listing down so the address stops being public. **Don't unpublish before testers have a way to migrate** (the GitHub APK is signed with the same keystore so installs upgrade in place — no data loss).

---

## ✅ Session 13 result — Firestore Phase 1 done

**Persistence bug fixed.** End-to-end verified on the S24:
1. Sign in with Google → cloud doc created.
2. Add tasks → debounced write to `users/{uid}` lands in ~1s.
3. Uninstall the app → reinstall → sample data shows.
4. Sign in with same account → tasks, lists, themes, accents, archive, grocery, settings all restored within ~1.5s.

The bar set at the start of session 13 is met. Sharing UX, onboarding integration, free/Pro split, JSON export/import, and Auto-Backup XML rule polish all remain deferred to later sessions.

**vc16 / 1.4.0 AAB built and ready for Play Console internal testing track.** Path: `android/app/build/outputs/bundle/release/app-release.aab`. See "Play Console compliance" below before uploading.

### Architecture in one picture
```
User mutation (e.g., addTask)
    ↓
React state setter
    ↓
AsyncStorage.setItem (immediate, offline-safe — same as before)
    ↓
syncedSlice useMemo recomputes (deps: 12 state slices)
    ↓
Watcher useEffect fires
    ↓
800ms debounce timer
    ↓
stripUndefined → setDoc(users/{uid}, {schemaVersion, updatedAt, data})
    ↓
Firestore (rules-validated, 1s rate limit, default-deny on everything else)
```

On sign-in: `getDoc(users/{uid})` first. If `remote.updatedAt > localLastWritten` AND `schemaVersion` matches → restore remote → local + AsyncStorage, suppress watcher 1.5s. Else: do nothing, let the watcher push local up on next change.

### Critical gotcha (saved to memory)
Firestore rejects fields with `undefined` values ("Unsupported field value: undefined"). Optional fields like `Task.reminder` come through as undefined when unset. **`stripUndefined()` JSON-roundtrips the slice before every write** — handles this and any future optional fields automatically. Saved as feedback memory so future-me doesn't re-discover it the hard way.

---

## ⚠️ Play Console compliance for vc16 upload

The new sync feature changes Play Store requirements. Update these BEFORE submitting for review or the rollout gets rejected:

### Data Safety section (changed)
Triority now collects user data. Update Play Console → Data Safety with:

| Data type | Collected | Shared | Optional? | Purpose |
|---|---|---|---|---|
| Email address | Yes | No | Yes (only on sign-in) | Account management |
| Name | Yes | No | Yes | Account management |
| User IDs (Firebase UID) | Yes | No | Yes | Account management |
| App activity → other user-generated content (tasks/lists/grocery) | Yes | No | Yes | App functionality |

For each: mark **"Data is encrypted in transit"** (TLS via Firestore SDK) and **"Users can request data deletion"** (Google account deletion cascades; explicit in-app delete affordance is a Phase 2 item).

### Privacy Policy URL (newly required)
Apps that collect any user data must have a privacy policy URL on the store listing. Triority has none yet. **Blocking for production rollout, NOT blocking for internal testing track.**

Drafting deferred to a follow-up session. Plan: write a Triority-specific 200-word policy (what we collect, that it's stored in Firebase, that we don't share or sell, how to request deletion), host on GitHub Pages or a Notion public page, paste URL into Play Console. Avoid the boilerplate generators — they over-claim partnerships we don't have.

### Permissions (no change)
Google Sign-In uses Play Services without a user-facing permission. INTERNET permission already declared (was already needed for Anthropic API calls). No new declarations needed.

### Content rating (no change)
Sign-in alone doesn't shift the rating. Don't re-take the questionnaire.

### GDPR consent (deferred)
Play's Data Safety disclosure covers baseline compliance. An in-app consent banner before sign-in is a future polish item if EU traffic ramps up. NOT blocking.

### vc16 release notes
```
• Cloud sync via Google Sign-In — your tasks, lists, themes, and
  settings back up automatically and restore on any device.
• Improved app data persistence on reinstall.
```

### Recommended rollout
1. Internal testing track first (no Privacy Policy enforcement).
2. Let it bake 1–2 days on tester devices.
3. Once Privacy Policy URL is in place + tester reports clean → promote to Production.

---

## 🎯 Current focus (session 13 — DONE)

**Landed Firestore Phase 1.** Goal: a user who signs in, adds data, uninstalls, reinstalls, and signs back in gets their data back. That's the bar. Sharing UX, sign-in placement in onboarding, and free/Pro split are deferred — not in this session.

**Dev environment change (2026-05-04):** Ross removed the debug APK from the S24 — too much data loss every time we swap APKs, and the Pixel emulator doesn't reliably reproduce the bugs that matter (IME race, real Auto-Backup behavior). All testing now happens against the **Play Store build** on the S24. That means:
- No Metro hot reload on device. Iteration cycle is: code → build AAB → upload to internal track → wait for Play to push → install → test.
- Logcat still works (`adb logcat` while the Play build runs).
- Don't suggest "let's just sideload a debug APK" as a debugging shortcut. Ross has explicitly opted out of that workflow.

**Deferred to a later session (do not design these now):**
- Sharing UX (invite by email vs. short code).
- Whether sign-in is in onboarding step 7 or only on first Pro use.
- Free vs Pro split for sync.
- Phase 3 JSON export/import.
- Phase 4 Auto-Backup XML rules.

Ross's intent for sharing (record only, do not implement yet): users can share a list with another user, edits propagate both ways, with some rules/settings TBD. Firestore was chosen specifically because shared docs + ACL rules are a primitive there — Phase 2 will reuse the same data model.

---

## ⚠️ ACTIVE ISSUE — Data persistence is broken across uninstall

**User-reported:** vc14 does not save app data (task lists, grocery, settings) when uninstalled and reinstalled via Play Store.

**Investigation (session 12, 2026-05-04):**

1. ~~Session 11's commit message was hallucinated.~~ **Correction (session 13, 2026-05-04):** session 12's claim that the manifest attributes and XML files are missing was itself wrong. Verified directly:
   - `android/app/src/main/AndroidManifest.xml` lines 28–29 *do* have `android:fullBackupContent="@xml/backup_rules"` and `android:dataExtractionRules="@xml/data_extraction_rules"`.
   - `res/xml/backup_rules.xml` and `res/xml/data_extraction_rules.xml` exist and correctly include AsyncStorage's `RKStorage` DB + sharedprefs while excluding `RN_ENCRYPTED_STORAGE_SHARED_PREF.xml`.
   - Session 11's vc15 was a version bump, but the underlying wiring it claimed *was* already correct — sessions 12/13 just couldn't see it on the first pass.

2. **Auto-Backup has never actually run successfully for `com.triority`.** Verified via `adb shell dumpsys backup` on the S24 (2026-05-04, ~17:21):
   - `com.triority` is in the *full backup queue* (queued for the next pass) but **not** in the `Ever backed up` list.
   - Backup destination on the S24 is `ross.t.cole@gmail.com` (one of Ross's accounts but not the primary `3dendeavors2022@gmail.com` MCP account).
   - Backup manager itself is enabled and provisioned — the issue isn't the device.

3. **Why Auto-Backup is fundamentally inadequate for a tasks app** (regardless of whether the rules are correct):
   - First backup runs ~12–24h after install, only when idle + charging + Wi-Fi.
   - Subsequent backups: at most once per 24h, same conditions.
   - **No API to trigger backup on demand** from the app — Android decides.
   - Restores **only** during fresh-install setup (or first launch on same Google account).
   - 25 MB cap.
   - Worst-case scenario: user installs, adds critical tasks, uninstalls within 2 hours → nothing was ever backed up → data lost.
   - The handoff's prior claim that "first backup runs ~24h" is technically right but framing it as "this is fine" is wrong. For a tasks app, it isn't fine.

**Conclusion:** Auto-Backup alone cannot deliver the user expectation of *"my data is safe"*. We need real sync.

---

## Direction (decided 2026-05-04, session 12)

### Goal
Triority should give users genuine confidence their data is safe — and eventually let them share lists with other users (households sharing a grocery list, work teams sharing a task list).

### Plan (in order)

**Phase 1: Real cloud sync (single-user, transparent, no sharing yet)**
- Backend: **TBD next session.** Strong candidates:
  - **Firebase Firestore** — fastest to ship, real-time listeners built-in, generous free tier, OAuth via Google Sign-In (Ross already on the Google ecosystem). Long-term cost risk if user count scales.
  - **Drive `appDataFolder`** — private hidden Drive folder per user, no backend cost, but no real-time multi-user sync (would need to layer it on with conflict-resolution code, which gets messy fast for sharing).
  - **Supabase / custom Postgres + Realtime** — no vendor lock-in to Google, but more ops surface.
- Recommendation: **Firebase Firestore.** Best fit for both phases. Per-user document, real-time listeners, easy to extend to shared docs in Phase 2.
- One-time Google Sign-In on first launch (or in Settings). Sign-in is **optional** — users who don't sign in keep AsyncStorage-only behavior.
- On state change (debounced ~500ms): write the user's full data blob to Firestore.
- On cold start: if signed in and remote is newer than local, restore.
- Conflict resolution: last-write-wins by timestamp (good enough for single-user across devices).

**Phase 2: Shared lists**
- Pro feature. User can share an individual task list or the grocery list with another user via email/UID.
- Shared list = its own Firestore doc with an `acl` array of authorized user UIDs.
- Each device subscribes to the shared doc(s) and folds them into local state alongside private lists.
- Conflict resolution: per-field timestamps + merge (e.g., two users adding items concurrently both win).
- UI: shared lists get a "shared with N" badge in the pill row.

**Phase 3 (escape hatch): JSON export/import**
- Settings → Export: writes a JSON file via SAF (user picks location).
- Settings → Import: user picks a JSON file → strict schema validation → additive merge. Bad rows skipped with a count toasted. Never silently swallow.
- Format chosen: JSON (CSV awkward for nested data; non-human-consumable anyway).
- Use case: cross-device manual transfer, debugging, defensive backup outside our control.

**Phase 4: Re-evaluate Auto-Backup**
- Once sync is the primary mechanism, Auto-Backup becomes a tertiary safety net.
- At minimum: properly add the manifest attributes + XML rules that vc15 falsely claimed were already in place, so encrypted-storage prefs are excluded (encrypted with hardware key — restoring on new device corrupts EncryptedStorage).
- Don't market Auto-Backup as the persistence story; it's just a free belt-and-suspenders layer.

### Non-goals
- We are NOT trying to fix Auto-Backup as the primary mechanism. It's the wrong tool.
- We are NOT going to use external app-specific storage (`getExternalFilesDir()`) — Android deletes it on uninstall, which we incorrectly assumed survived uninstall earlier this session.
- We are NOT going to write to MediaStore/Downloads as a hidden hack.

### Why Firestore over Drive `appDataFolder`
- Drive can hold the user's own data fine, but **multi-user sharing is hard** — you'd be poll-syncing two private Drives, no real-time, no ACL primitive.
- Firestore has shared documents + ACLs as a built-in concept. Phase 2 becomes "add `acl` field, make a security rule" instead of designing a sync protocol from scratch.
- Cost: Firestore free tier is 50k reads / 20k writes / 1 GiB stored per day. Triority's write pattern (1 doc per user, ~10 KB, debounced) is well under that. Even at 10k DAU we'd be on the free tier or pennies on Blaze.

### Open questions for next session
1. ~~Confirm Firebase Firestore as backend.~~ **Decided 2026-05-04: Firestore.** Reason: Phase 2 sharing needs shared docs + ACLs, which Firestore has as primitives.
2. Sign-in placement: onboarding step 7, or only when user opts into a Pro feature? **Deferred.** For Phase 1 a Settings → "Sign in to sync" row is enough — onboarding integration comes when sharing UX lands.
3. Phase 2 sharing: invite by email (requires Cloud Functions to resolve email→UID) or by short code? **Deferred to sharing session.**
4. Free vs Pro split for sync. **Deferred to sharing session.** Phase 1 ships with sync available to anyone signed in; gating decisions happen when Phase 2 lands.

---

## Rollback / safe checkpoint (session 13)

Before starting Firestore work, session 13 created a clean checkpoint so the entire integration can be reverted as one atomic move if needed.

**Anchor tag:** `vc15-pre-firestore` — points at the last commit before any Firestore code, gradle, or native config changes were made. Pre-Firestore state included three pre-checkpoint commits (manifest backup-rules wiring + XML files, google-services.json, this HANDOFF rewrite) that were always-correct-but-uncommitted on disk.

**To completely undo Firestore work and return to a clean tasks-only build:**
```
git reset --hard vc15-pre-firestore
```

**To partially revert (keep Firebase config, drop only the sync code):**
```
git log --oneline   # find the last commit you want to keep
git reset --hard <hash>
```

Each Firestore-related commit lands as its own logical step (gradle plugin, RN packages, Settings UI, sync engine, security rules) so individual pieces can be reverted without taking the whole feature down. If the build breaks during incremental work, the prior commit is always green.

**Files added in checkpoint commits (now tracked):**
- `android/app/src/main/res/xml/backup_rules.xml`
- `android/app/src/main/res/xml/data_extraction_rules.xml`
- `android/app/google-services.json` (Firebase config — not a secret; Firebase enforces access via SHA-1 fingerprint + Firestore rules, not the API key in this file)

**Files added to `.gitignore` in checkpoint commits:**
- `revenuecat-*.json` — RevenueCat service account key, must not be committed.
- `promotion_codes.csv` — tester promo codes; mild leakage risk and no value in versioning.

---

## Security model (Firestore Phase 1)

The trust boundary for Phase 1 is `Firebase Auth + Firestore security rules`. There is no custom backend and no Cloud Functions. Threats and defenses:

| Threat | Defense |
|---|---|
| Signed-in user A reads/writes user B's data | Rule: `users/{uid}` allow only when `request.auth.uid == uid` |
| Unauthenticated writes | Rule: `request.auth != null` required for all reads/writes |
| Write-amp DoS / billing attack | Rule: `request.time - prev.data.updatedAt > 1000ms` rate limit, 250 KB doc-size cap |
| Schema corruption | Rule: required fields + type checks (`updatedAt is number`, `data is map`, `schemaVersion is int`) |
| Stolen Firebase ID token replay | Out-of-band: Firebase signs tokens, 1h auto-expiry, Google validates server-side |
| App impersonation with a different signing cert | SHA-1 cert hash bound in `google-services.json` per registered fingerprint; Firebase rejects mismatched apps |
| MITM on Firestore traffic | TLS + Google cert pinning in the SDK |
| Future routes accidentally opened | Default-deny `match /{document=**} { allow read, write: if false }` catch-all |

**Things deliberately NOT done in Phase 1:**
- **No E2E encryption** — would break Phase 2 sharing (server-side queries on shared docs require server-readable data) and is overkill for a tasks app's threat model.
- **No app-layer MFA** — inherited from the user's Google account.
- **No "wipe local on sign-out"** option — local data persists when signed out (sync just stops). Add later as a toggle if users want it.
- **Pre-existing gap (not introduced by sync):** AsyncStorage is unencrypted on Android. Users who paste API keys / secrets into task text store them in plaintext locally. Same as today; flagging for awareness.

**Rules deployment:** Rules ship as `firestore.rules` in the repo. Ross pastes them into Firebase Console → Firestore Database → Rules → Publish manually. The Firebase CLI route would be cleaner but adds setup overhead — defer until rules need to change frequently. Until rules are published, the very first write will fail with `permission-denied` (correct fail-closed behavior).

**Decided thresholds (session 13, 2026-05-04):**
- Rate limit: 1 write per 1 second per user doc (sync engine debounces at 500ms anyway, so this is paranoia insurance).
- Doc size cap: 250 KB (~25k tasks worth of text). Headroom under Firestore's 1 MB hard cap for Phase 2 shared-list metadata.

---

## Feature inventory (current shipping state, vc14 / 1.3.5)

Everything Triority does today, grouped by surface. Free vs Pro indicated. Internal screen IDs in parens.

### Tasks (`list`) — free
- **3 priority tiers:** High, Medium, Low. Each task belongs to one tier; tiers visually grouped on the active list.
- **Add task** via the bottom InputBar. With no API key set: opens `PriorityPicker` to choose tier. With API key: see AI triage below.
- **Edit task:** tap pencil → `EditSheet` opens with text, priority, and optional reminder.
- **Complete task:** swipe right on the row → moves to archive (with completion timestamp).
- **Delete task:** swipe left → trash icon revealed with accent pulse → tap trash to delete (no confirm).
- **Drag-and-drop reorder within tier:** long-press 400ms → row enters drag mode → vertical pan reorders. Edge-scroll auto-scrolls when finger nears top/bottom of list area. Cross-tier drag not supported.
- **Reminders:** optional per-task. One-shot, every-hour-until-done, or daily-until-done. Past timestamps auto-advance to next future occurrence on cold start. Completing the task cancels its reminder.
- **Per-task date display:** added/edited/reminder times surface contextually.

### Multi-list — Pro (free users get 1 default list)
- Lists rendered as a horizontal pill row above the bottom bar.
- **Add list:** `+` pill at end of pill row (locked icon for free users, opens upsell sheet on tap).
- **Switch list:** tap a pill.
- **Reorder lists:** long-press a pill 400ms + drag → reorder. Order persisted to `tri_list_order`.
- **Rename / delete list:** tap pencil next to active list title (top of Tasks screen) OR long-press a list pill — both open `ListActionSheet`. Free users can't delete their only list.
- **Archive button** sits below the pencil (top-right of Tasks screen) → opens Archive screen filtered to active list.

### Groceries (`grocery`) — Pro
- Static list (always exists, can't be renamed/deleted, doesn't appear in pill row).
- **Categorized view:** items auto-grouped by category (Produce, Dairy, Meat & Seafood, Bakery, Frozen, Canned & Dry Goods, Beverages, Snacks, Household, Personal Care, Other, Uncategorized).
- **A–Z view:** flat alphabetical via toggle pill.
- **Got It section:** pinned at bottom of screen — checked items render strikethrough + dimmed; still in the underlying `groceryItems[]`.
- **Check / uncheck:** swipe right on an active item → moves to Got It. Swipe right on a Got It item → moves back to active.
- **Delete item:** swipe left → confirm dialog → delete.
- **AI Sort pill:** re-categorizes all items in one Claude call. Shows "thinking…" toast while in flight; ignores taps until done. Resets to category view after.
- **Clear pill:** tap = clear Got It items only. Long-press 600ms → confirm → clear *all* (active + Got It).
- **Plain add (no API key):** typed item goes straight into the list, default category Uncategorized.
- **Free users** see the Groceries tab but with a lock icon — tapping opens upsell sheet.

### AI Triage — free (API key required), routing depth gated by Pro
- Hooks into the InputBar. User pastes a free-form brain dump; Claude returns structured tasks, groceries, and reminders.
- **Free, single list:** AI returns tasks (text + tier + optional reminder) only. No grocery items created even if user mentions "milk."
- **Free, multi-list (n/a — multi-list is Pro):**
- **Pro, single list:** tasks + grocery items + reminders.
- **Pro, multi-list:** prompt injects all list names + IDs. AI returns tasks with `listId`. Tasks route to the named list and surface a "Added to [List Name]" toast. Tasks with no `listId` go to active list.
- **Model:** `claude-sonnet-4-20250514`. Direct calls to `api.anthropic.com/v1/messages` over HTTPS. No proxy / no analytics.
- **Personal Context** (Settings → AI Triage): free-form notes string inlined into the system prompt for personalized routing (e.g., "I'm vegetarian, no dairy" influences how grocery items are categorized).
- **API key storage:** EncryptedStorage (Google Tink, hardware-backed). Never plaintext.

### Archive (`archive`)
- Reachable from the archive icon on Tasks screen. Filtered to active list.
- **Week-grouped headers:** This Week / Last Week / dated week ranges. Older weeks auto-collapse.
- **Filter pills:** week / range filters with same selected/unselected styling as list pills.
- **Calendar sheet:** pick start + end dates to filter by date range.
- **Restore:** tap any archived item → restored to its original list at its original tier.
- **Clear All pill:** matches Groceries' Clear-All placement → tap → confirm → permanently delete entire archive.

### Settings (`settings`)
Section order:
1. **Appearance** (mostly Pro)
   - Dark Mode toggle (free).
   - Theme picker: 8 built-in themes — Slate, Glacier, Evergreen, Rosewood, Obsidian Gold, Midnight Copper, Royal Plum, Joker. Free users locked to Slate; PRO pill on locked themes.
   - Custom theme slots (3): empty = dotted `+` card → tap to create. Filled = dashed-border preview → tap to edit, long-press 500ms → confirm → clears slot. Editor opens `CustomThemeSheet` with HSB sliders for Canvas / Surfaces / Text / Highlight (accent), plus surface opacity slider.
   - Accent picker: 8 named colors (Steel, Sky, Green, Crimson, Amber, Copper, Royal, Joker). Hidden when a `custom_*` theme is active (accent lives in the draft). Free users locked.
2. **Help**
   - Replay onboarding row.
3. **AI Triage**
   - API key field (encrypted at rest, hidden by default with eye toggle).
   - Personal Context multi-line text input.
4. **Restore Purchase** (only shown when `!isPaid`) — calls `Purchases.restorePurchases()` on RevenueCat, flips paid flag if entitled.

### Onboarding
- 6-step swipeable carousel shown on first launch. Steps: Welcome (priorities, swipe-to-complete, swipe-to-trash, drag), Multiple lists, Built-in grocery list, AI routes everything (with example), Reminders, Themes & custom colors.
- Replayable from Settings → Help.
- Stored as `tri_onboarded='1'` once seen.

### Voice input
- Mic button on the InputBar uses `react-native-speech-recognition-kit`. Patched to fix silent second-press bug (cancel + destroy + 150ms delay before new recognizer).

### Data persistence
- AsyncStorage for everything except API key (EncryptedStorage).
- **Cloud sync** (vc16+) via Firestore + Google Sign-In. Optional — signed-out users keep AsyncStorage-only behavior. Signed-in users get debounced writes to `users/{uid}` and cold-start restore on reinstall. See "Session 13 result" block at top of this file for architecture.
- **Auto-Backup enabled** (vc11+) via `android:allowBackup="true"` + correct `fullBackupContent` / `dataExtractionRules` (committed in vc16). Now a tertiary safety net behind Firestore sync, not the primary persistence story.
- AppState listener flushes all state to AsyncStorage on `background` / `inactive` to handle force-stop and OS-kill safely.

### Notifications
- Notifee for scheduling. Reminders use `SCHEDULE_EXACT_ALARM` (Android 12+ permission, redirected to system settings if not granted). Notification channel pre-warmed.
- Phantom-reminder safeguard: cold-start sync cancels orphan alarms unconditionally; re-schedules the live ones only if both notif + alarm permissions are granted.

### Pro paywall
- **Single-purchase, $1.99 USD, non-consumable** (`triority_pro` SKU).
- Backed by **RevenueCat** (production key in App.tsx). RC wraps Play Billing 6+ — no native patches required beyond the JVM target patch in `patches/`.
- **Pro unlocks:** Multiple lists, Groceries tab, Themes (non-Slate), Accents, Custom theme builder. AI cross-list routing.
- Upsell sheet (`ProUpsellSheet`) lists all 3 benefits. Buy and Restore both wired.
- Promo codes: 500 codes ("THANK YOU TESTER!", live 2026-05-04 → 2027-05-02). CSV at repo root: `promotion_codes.csv`. Redeem via Play Store → menu → Redeem.

### Bottom tab bar
- 3 tabs: Tasks (`list`), Groceries (`grocery`, basket icon, lock for free), Settings.

### Theming engine
- HSB↔hex conversion utilities. PanResponder-based sliders use `pageX` (re-measured on every grant) — not `locationX` — to avoid drift.
- `draftToThemeDef` converts a `CustomThemeDraft` (canvas/controls/text/accent + opacity) into a full `ThemeDef`. `s1` (modal/sheet bg) always opaque; `s2`/`s3` carry the opacity-derived alpha.
- Light/dark detection on custom themes by canvas brightness (< 50 = dark mode chrome).
- Joker theme tokens are the verbatim output of Ross's saved Joker custom draft — see App.tsx comment for the exact draft.
- Legacy theme IDs remapped via `LEGACY_THEME_IDS`.

### What's deliberately **not** in the app
- No analytics, no telemetry. Network calls go to `api.anthropic.com` (AI Triage) and Firebase (auth + Firestore sync, opt-in via Google Sign-In) only. Sign-out reverts to AsyncStorage-only.
- No subscription pricing — one-time purchase only.
- No hosted AI option — users bring their own Claude API key.
- No list-sharing yet — Phase 2 (deferred).
- Cross-device sync is **opt-in** via Google Sign-In (vc16+). Signed-out behavior is unchanged from pre-vc16.

---

## Completed this session (2026-05-04, session 12)

✅ **Diagnosed the persistence issue properly.** See "ACTIVE ISSUE" block at the top of this file. tl;dr: Auto-Backup never ran for `com.triority`, the manifest was missing the attributes session 11 claimed were present, and Auto-Backup is the wrong mechanism for a tasks app regardless.

✅ **Decided direction:** real sync via Firestore (Phase 1: single-user, Phase 2: shared lists, Phase 3: JSON export/import escape hatch). See "Direction" block above.

✅ **Dev environment back online for the rebuild work:** Play Store install removed (signing mismatch with debug), debug APK built from main repo and installed on S24 (`R5CWC49MADM`), Metro running, port reversed.

⚠️ **vc15 / 1.3.6 should NOT be uploaded to Play Console as-is.** Its commit message claims fixes that aren't in the code. Either roll back the version bump or land the actual sync work first. Decision deferred to next session.

---

## Completed previous session (2026-05-04, session 11)

⚠️ **Session 11 added no real fixes.** The commit `17e4c68` claims "backup exclusion rules verified correct" but no XML rules files exist in the repo and the manifest is missing the attributes that would reference them. The session was effectively a version bump only. Do not trust this commit's message.

---

## Completed previous session (2026-05-04, session 10)

✅ **Android hardware back button — two-stage behavior.** Was exiting from anywhere; now (1) closes top-most portal sheet (EditSheet/ListActionSheet), (2) returns to Tasks if on Archive/Grocery/Settings, (3) only then exits.
- Implementation: extended `PortalCtx` with a `handleBack()` that pops the topmost registered dismiss callback off a stack. `RootPortal` accepts an `onBack` prop that registers/unregisters automatically. New `BackButtonManager` component mounted inside `PortalHost` subscribes to `BackHandler` and runs the cascade. Modal-based sheets (PriorityPicker, ConfirmDialog, ProUpsellSheet, CalendarSheet, Onboarding) keep their existing `onRequestClose` wiring — RN routes Android back to the topmost Modal first, so we never compete.
- EditSheet and ListActionSheet now pass `<RootPortal onBack={cancel}>`.

✅ **Drag-and-drop reorder actually commits.** Was: drag visual worked, drop indicator showed correctly, edge-scroll worked — but releasing the finger never wrote the new order to state.
- Root cause: `TaskRow`'s `PanResponder` is created via `useRef(PanResponder.create(...)).current`, so the closure inside `onPanResponderRelease` permanently captured the *initial* `onDragEnd` prop. When TierGroup re-rendered with updated `dropIndex`, TaskRow's panResponder kept calling the stale callback, which read `dropIndex=null` and bailed before reaching `onReorderInTier`.
- Fix: latest-callback refs (`onLongPressStartRef`, `onDragMoveRef`, `onDragEndRef`) updated on every render, panResponder reads through `.current`. Generic pattern — applies anywhere a `useRef`-frozen PanResponder needs to call into render-scoped state.

✅ **Scroll works when tasks fill the screen.** Was: the Tasks ScrollView refused to scroll vertically because TaskRow's PanResponder claimed every touch with `onStartShouldSetPanResponder: () => true`.
- Fix: flipped to `onStartShouldSetPanResponder: () => false` (also `onStartShouldSetPanResponderCapture: false`). Vertical scroll now passes through to the parent ScrollView. The 400ms long-press timer that arms drag mode moved to `onTouchStart`/`onTouchEnd` on the row's wrapper Animated.View — touch events bubble regardless of responder claim, so the timer still fires reliably without stealing the scroll. Drag claims via `onMoveShouldSetPanResponder` once `dragArmedRef.current === true`, and horizontal swipe still claims via `Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)`.

✅ **EditSheet text input no longer garbles / wrong-char deletes.** First pass added `autoCorrect={false} autoComplete="off" spellCheck={false} importantForAutofill="no"` — not enough on the S24. The deeper cause is React-controlled `value` racing the Android IME's composing region: every keystroke React pushes the value back to the native field, which the IME may have just updated mid-composition, producing cursor jumps and the "delete deletes the wrong character" bug.
- Real fix: switched to **uncontrolled** TextInputs. Native field owns the text via `defaultValue`. `onChangeText` mirrors to a ref (`textRef.current`) for save(), plus a single boolean `hasText` for the Save-button opacity that only flips when emptiness toggles (so we re-render at most twice per editing session).
- Applied to both EditSheet (`text` → `textRef` + `hasText`) and ListActionSheet (`name` → `nameRef`). The autocorrect/spellcheck flags are kept — they don't fix it alone but they reduce IME chatter.

✅ **vc14 / 1.3.5 bumped, AAB built and ready for Play Console internal-testing track upload.**

---

## Completed previous session (2026-05-04, session 9)

✅ **First-keystroke-drop on edit modals — actually fixed.** Verified on the S24.
- Root cause: after the Modal→portal refactor (`e0f9ece`), EditSheet's own `useEffect` runs *before* `PortalHost` re-renders to mount the sheet's children. So `textInputRef.current` was `null` at effect time — the synchronous `focus()` call no-opped, leaving only the 80ms `setTimeout` fallback. That 80ms gap was the IME race that ate the first tap.
- Fix: replaced `useRef + useEffect focus()` with a **callback ref** that focuses the TextInput the instant it mounts inside the portal slot. No setTimeout, no race. Applied identically to `EditSheet` and `ListActionSheet`.
- Pattern: `const setTextInputRef = useCallback((node) => { textInputRef.current = node; if (node && !focusedOnceRef.current) { focusedOnceRef.current = true; node.focus(); } }, []);` — pass `setTextInputRef` as `ref` on the `<TextInput>`.
- Pixel emulator never reproduced this bug (its IME setup latency differs and soft keyboard often doesn't auto-pop on these modals at all). **Always verify on the S24.** Two prior fix attempts (`f6154cd` slide-completion focus, `e0f9ece` portal refactor) both passed emulator review and failed on the phone.

✅ **Auto-Backup enabled** (commit `42e697a`, vc11) — `android:allowBackup="true"` so reinstalls restore tasks via Google Drive. Caveats: first backup takes ~24h (idle + charging + Wi-Fi), only restores during fresh install setup, 25 MB Drive cap per app. Won't recover data lost before vc11.

✅ **Grocery tab rename + icon swap.**
- "Shopping" → "Groceries" everywhere user-visible (bottom-bar tab label, screen title, onboarding step title/body, upsell feature list). Internal screen ID stays `grocery`.
- Tried Ionicons `basket-outline` first — read funky at small sizes. Swapped to Feather `shopping-bag` instead so the icon style matches the rest of the bottom bar (list, archive, settings are all Feather).
- Added both `basket` and `shopping-bag` to `ICON_MAP` — `basket` left in place for future use.

✅ **Debug-APK workflow on the phone.** Released APK ignores Metro (uses bundled JS). For iterative testing on the S24, build `assembleDebug` and `adb install -r`. Required `adb uninstall com.triority` once to clear the Play Store install (signing mismatch) — wiped data, but Auto-Backup will catch the next reset. Debug APK uses the same `com.triority` applicationId so once installed, JS-only changes hot-reload from Metro normally.

✅ **vc13 / 1.3.4 bumped, ready for AAB build + upload to Play Console internal track.** (vc12 was burned on a local-only build before upload — Play Console rejects re-using version codes.)

---

## Completed previous session (2026-05-04, session 8)

✅ **UI polish:**
- Fixed pencil/archive buttons stranded mid-screen (commit `b391f2f`). The absolute-positioned header buttons were incorrectly using `listHeaderTop`'s top edge as origin and adding `insets.top` — double-counting the header's paddingTop. Fixed with absolute positioning: pencil at `top: 0` (title row), archive at `top: 32` (date row).

✅ **UX improvements:**
- AI sort now shows "thinking…" toast while the sorting is in progress; ignores taps until done (commit `c8d8bd1`).
- Added AppState listener that flushes all state to AsyncStorage on `background`/`inactive` — handles force-stop and OS-kill cases safely (commit `c8d8bd1`).

✅ **Testing on Pixel 8 emulator:** UI changes verified. Buttons now correctly positioned on task screen.

✅ **Ready to push to testers:** versionCode 10 / versionName 1.3.2 pending — will build AAB and upload to Play Console internal track.

---

## Session 7 plan (completed)

UI overhaul + crash-safety pass. Worktree branch: `claude/awesome-curie-0487a0`.

**Top bar (Tasks view):**
- Remove Tasks/Grocery nav-button row at top.
- Replace with: `[selected list name] [✎ pencil edit-button]` (pencil = same icon used on tasks). Pencil opens existing ListActionSheet (rename/confirm/delete).
- Edit button x-position is **static** regardless of list-name length (centered horizontally on screen).
- Below: `[date • counter]` — counter moved over from old position; bullet `•` separator.
- Below that: archive button (archive icon) directly under the pencil, also static x-position.

**Top bar (Grocery view):**
- Show "Shopping" as plain title, no edit icon. Date+counter row still present.

**Bottom bar:**
- Bottom-bottom row stays: `[Tasks] [Grocery 🛒] [Settings]` — Grocery sits where Archive used to live (between Tasks and Settings). Archive moved to top stack.
- Lists pill row remains above the bottom bar.

**Settings:**
- Remove Clear All row + Auto-Clear (auto-archive) row.
- (Keep theme/accent/help/AI sections.)

**Archive:**
- Week/range filter pills now use the same selected/unselected styling as the list-name pills (currently ambiguous).
- Add "Clear all" pill matching Grocery's clear-all placement/style → single tap → confirm modal "deletes all permanently".

**Task swipe-to-delete:**
- Replace ConfirmDialog with: swipe reveals trash icon + subtle accent pulse; tap trash to delete immediately. No second confirm.

**Drag-and-drop tasks:**
- Reorder within same tier only. Drop indicator shows landing position. Edge-scroll: dragging near top/bottom of task list area auto-scrolls slowly.
- PanResponder-based (reanimated/draggable-flatlist are dead ends per HANDOFF).

**Grocery AI Sort:**
- Show "thinking…" toast while AI is working; ignore taps until done.

**Crash safety:**
- `AppState` listener flushes all state to AsyncStorage on `background`/`inactive`. Handles force-stop / OS-kill cases.

---

## Current state

- **🎉 Paywall works end-to-end.** Buy flow tested on phone via Play Store internal track install — Google Play sheet shows, purchase completes, RC `purchaseUpdatedListener` fires, entitlement grants, gates unlock (grocery, themes, multi-list, etc.).
- **Latest commit (this session):** versionCode 9 / versionName 1.3.1 — diagnostic toast surfaces real RC error codes; `buyPro()` throws specific messages identifying which offering/package piece is missing.
- **Phone (Samsung S24 Ultra, serial `R5CWC49MADM`):** Running 1.3.1 installed via Play Store internal track. Sideload-with-release-keystore was tried first and Play Billing returned `CONFIGURATION_ERROR` because Play App Signing re-signs distribution copies — only Play-distributed installs work for billing. Lesson: never sideload a release APK to test billing. Always upload AAB → install via Play Store.
- **Play Store:** AAB versionCode 9 (1.3.1) approved, live on internal testing track. `triority_pro` product live, $1.99, 173 countries.
- **RevenueCat:** Production key `goog_NTynbghUvzIZBcUkZQcQPBxcFCG` in App.tsx. All wiring confirmed working in prod.
- **License testing list:** TEST PIGS (20 emails) attached at Play Console → Setup → License testing. License response: `LICENSED` (Ross may want to flip to `RESPOND_NORMALLY` — `LICENSED` doesn't actually exempt billing, only mocks the licensing API).
- **Promo codes:** 500 codes generated under "THANK YOU TESTER!" promo, scheduled live 2026-05-04 → 2027-05-02. CSV at repo root: `promotion_codes.csv`. Q2 2026 quarterly cap is now spent.
- **Ross got self-charged $1.99 on 2026-05-03** during own testing. License testing list either wasn't yet attached at purchase time, or `LICENSED` response doesn't waive billing. Refund pending via Play Console → Monetize → Orders → Refund.
- **Metro:** Not running between sessions. Start fresh each session.
- **Always build/install from the main repo**, not any worktree.

### ⚠️ "Sideload it" workflow — what Ross means
When Ross says "sideload it" / "side load it on my phone", he's asking for an **offline-capable test build** he can take away from the PC (no Metro). This means a **release-signed APK**, not a debug APK (debug needs Metro to load JS). The sequence:

1. **Patch `useIsPaid()` to return `true`** in App.tsx for the duration of the build, so all Pro features are testable on the dev install. Mark the patch with `// DEV-PAID OVERRIDE — REVERT BEFORE NEXT AAB UPLOAD` so it's grep-able.
2. Build: `cd android && .\gradlew.bat app:assembleRelease`. APK lands at `android/app/build/outputs/apk/release/app-release.apk`.
3. If a previous build is installed with a different signature: `adb uninstall com.triority` (warn Ross first if he might have data — but during dev-loop sideloads he's already opted in). Otherwise `adb install -r <apk>` works.
4. Launch: `adb shell monkey -p com.triority -c android.intent.category.LAUNCHER 1`.
5. **Revert the `useIsPaid()` override immediately** so the source on disk is correct for the next AAB upload. The phone keeps the patched build; the repo doesn't.

Why source-patch instead of the SQLite `tri_is_paid='1'` trick: the SQLite approach only flips one row in AsyncStorage and `useIsPaid()` reads from `IAPContext`, not directly from `tri_is_paid`. Patching the hook is what actually unlocks gates. The SQLite trick from the Pixel-emulator section *also* works because `IAPProvider`'s warm-start cache reads `tri_is_paid` — but on a real phone with a working Play account, RC will eventually correct that flag back to false. Source override is deterministic.

The override never ships: revert sits in the same conversation as the build, and the marker comment makes it impossible to miss in `git diff` before AAB upload.

### ⚠️ Worktree deploy — do this every session before reloading the phone
Claude Code runs in git worktrees. Metro serves from the **main repo**. After committing in a worktree, run from the main repo to push changes to Metro:
```powershell
cd "E:\Creative\Triority\Triority"
git merge --ff-only claude/<worktree-branch-name>
# then: adb reverse tcp:8081 tcp:8081  →  Reload on phone
```
Use `--ff-only` — safe, refuses if anything diverged. All history preserved.

---

## How to start a dev session

```powershell
# 1. Start Metro in its own visible window
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd 'E:\Creative\Triority\Triority'; npm start"

# 2. Verify phone is connected
adb devices   # should show R5CWC49MADM

# 3. Reverse Metro port
adb reverse tcp:8081 tcp:8081

# 4. Shake phone → Reload  (or press r in Metro window)
```

**JS-only changes** (App.tsx): Metro reload only, no rebuild.  
**Native changes** (new libs, AndroidManifest, build.gradle): rebuild required:

```powershell
cd E:\Creative\Triority\Triority\android
.\gradlew.bat --stop
# IMPORTANT: delete stale bundle first or APK will serve old JS
Remove-Item -Force ..\app\src\main\assets\index.android.bundle -ErrorAction SilentlyContinue
.\gradlew.bat app:assembleDebug
adb install -r app\build\outputs\apk\debug\app-debug.apk
adb reverse tcp:8081 tcp:8081
```

⚠️ `INSTALL_FAILED_UPDATE_INCOMPATIBLE` = signing mismatch → must uninstall first (warns Ross, wipes data).  
⚠️ **NEVER** `adb uninstall com.triority` without warning Ross — wipes all task data.  
⚠️ **Always delete `index.android.bundle` before building** — stale bundle silently serves old JS even after Metro reload.

If Metro shows `EADDRINUSE`: `netstat -ano | findstr ":8081"` then `taskkill /PID <pid> /F`.

---

## What's in App.tsx

Key components in order:

- **Types:** `Tier`, `Screen`, `TaskList`, `Task`, `ArchivedTask`, `Reminder`, `GroceryItem`, `ThemeTokens`, `ThemeDef`
- **`GROCERY_CATEGORIES`** — ordered category list used by AI prompts and grouping UI. `GROCERY_UNCATEGORIZED = 'Uncategorized'` is the fallback.
- **`hsbToHex` / `hexToHsb`** — pure JS HSB↔hex conversion utilities.
- **`HSBSlider` / `HSBSliders`** — three horizontal sliders (Hue 0-360, Saturation 0-100, Brightness 0-100). Key design notes: (1) PanResponder uses `pageX` minus measured track `pageX` (re-measured on every grant) — not `locationX`. (2) `onTerminationRequest: false` prevents gesture steal. (3) `onChange` callbacks read from `hsbRef.current` not render-captured values. (4) Sync from color prop skipped when incoming hex matches last emitted — prevents `hexToHsb(gray)` from resetting hue to 0 when sat=0.
- **`ScaledPreview`** — renders `MiniMockupPreview` at `width=200` natural size, measures it via `onLayout`, then scales uniformly to fill modal width while capping at `PREVIEW_MAX_H`. Used only inside `CustomThemeSheet`.
- **`CustomThemeSheet`** — swipe-dismissible modal. 4 group pills (Canvas, Surfaces, Text, Highlight — internal keys `canvas`/`controls`/`text`/`accent`) — tap one, sliders below edit that group's anchor color. Sheet chrome derives from the draft (light mode if `canvas.brightness < 50`). Body is a `ScrollView` so Cancel/Save always reachable. Accent lives inside the draft — when a `custom_*` themeId is active, the standalone Accent picker in Settings is hidden. Save writes to `tri_custom_themes` + switches `themeId` to the edited slot.
- **`draftToThemeDef(draft)`** — converts `CustomThemeDraft` (`{ canvas, controls, text, accent, controlsOpacity }`) to a full `ThemeDef`. `s1` (modal/sheet bg) is always fully opaque — only `s2`/`s3` get the alpha from `controlsOpacity`. `resolveThemeId` passes `custom_0/1/2` through unchanged.
- **`DEFAULT_CUSTOM_THEME_DRAFT`** — Slate-dark defaults. `controlsOpacity` 0–100 slider on Surfaces pill blends `s2`/`s3` toward canvas using `blendOver` (produces fully-opaque hex). Borders always solid.
- **`ACCENT_COLORS` / `ACCENT_NAMES`** — 8 colors: Steel, Sky, Green, Crimson, Amber, Copper, Royal (`#FF40C8` — was "Magenta", renamed to avoid confusion with Joker), Joker (`#FF00FF`). Not used by custom slots (accent lives in the draft).
- **`THEMES`** — 8 themes × light/dark: Slate (OLED black dark), Glacier, Evergreen, Rosewood, Obsidian Gold, Midnight Copper, Royal Plum, **Joker**. Joker dark tokens are exact output of `draftToThemeDef` on Ross's saved draft (`canvas:#380057`, `controls:#00eeff`, `text:#00ff22`, `accent:#ff00ff`, `controlsOpacity:39`) — `s2`/`s3` carry the `63` alpha suffix verbatim. Light mode built from `secondary` (`#c458c4`). Default accent `#FF00FF` both modes. Legacy IDs remapped via `LEGACY_THEME_IDS`.
- **`useSwipeToDismiss(onDismiss)`** — reusable hook for all bottom sheets. 80px threshold, springs back on short drags.
- **`IAPProvider`** — wraps the app root. Initializes Google Play Billing, checks existing purchases on mount, caches paid state to `tri_is_paid` in AsyncStorage (warm start). Exposes `isPaid`, `buyPro()`, `restorePurchases()` via `IAPContext`.
- **`useIsPaid()`** — reads from `IAPContext`. Returns real purchase state. No longer stubbed.
- **`useIAP()`** — returns full `{ isPaid, buyPro, restorePurchases }` context. Used by `ProUpsellSheet` and Settings Restore row.
- **`ReminderPicker`** — shared by EditSheet and PriorityPicker. Day spinner + time picker side by side, fixed widths.
- **`EditSheet`** — swipe-to-dismiss. Keyboard tracked via `useState` + Keyboard listeners; ScrollView shrinks to 320 when keyboard up. Input focused via ref + 320ms setTimeout. `includeFontPadding: false` on textarea fixes Android top-text-clip bug.
- **`ListActionSheet`** — swipe-to-dismiss. Opens via long-press on Tasks nav button (400ms) OR long-press on list pill (400ms). Input focused via ref + 220ms setTimeout.
- **`PriorityPicker`, `ConfirmDialog`, `ProUpsellSheet`, `CalendarSheet`** — all swipe-to-dismiss.
- **`DraggablePill`** — owns its own PanResponder. Long-press 400ms + move > 6px = drag; long-press + release = open sheet; tap = select.
- **`ListPillRow`** — renders DraggablePill list in a ScrollView. Owns shared drag state. `onReorder` saves to `tri_list_order`.
- **`GroceryItemRow`** — single grocery item row. Right swipe = moves item to "Got it" section (checked=true). Left swipe = confirm dialog then delete. Uses same PanResponder pattern as `TaskRow`.
- **`GroceryScreen`** — full grocery list view. Active items grouped by category (or flat A–Z). "Got it" section pinned at bottom shows checked items strikethrough + dimmed. Action pills: AI Sort (first, hidden if no API key), A–Z toggle, Clear pill (tap = clear Got It items, long-press 600ms = confirm then clear all). Has its own `useConfirm` instance.
- **`InputBar`** — `blurOnSubmit={true}` + `Keyboard.dismiss()` on submit. `groceryMode` prop controls behavior: no AI = plain grocery add (no modal); AI on = routes via Claude. AI placeholder unified: *"Mix tasks, groceries, errands — AI routes everything to the right list."*
- **`ScrollableCardBox`** — horizontal scroll container. Custom accent-colored scrollbar + "Swipe" hint inline with scrollbar row (appears after 3s idle, resets on touch/scroll).
- **`MiniMockupPreview`** — faithful tiny render used inside theme/accent cards.
- **`scheduleReminder()`** — checks `AndroidNotificationSetting.ENABLED`; redirects to system settings if missing. `SCHEDULE_EXACT_ALARM` is intentional, fine for Play Store. Repeating reminders advance past-timestamps to the next future occurrence on startup.
- **`Settings`** — Section order: Appearance (Dark Mode, Theme, Accent), Data (Auto-Clear, Clear Archive), Help (Replay onboarding), AI Triage (API key, Personal Context), **Restore Purchase** (shown only when `!isPaid`). Theme picker shows 8 built-in cards + 3 custom slots. Custom slots: empty = dotted `+` card (tap to create), filled = dashed-border preview card (tap to edit, long-press 500ms = confirm then clear slot back to empty). Accent picker hidden when a `custom_*` theme is active. All theme/accent/custom features gated behind `isPaid`.
- **`ProUpsellSheet`** — fully wired. `buyPro()` triggers Google Play flow. `restorePurchases()` checks existing purchases. Copy lists all 3 benefits: unlimited lists, grocery mode, themes/accents/custom builder.
- **`Onboarding`** — rewritten 2026-05-02. 6 steps: Welcome, Multiple lists, Grocery list, AI routing, Reminders, Themes.
- **`TriorityApp`** — root state, holds `lists[]`, `activeListId`, `customThemeDrafts` (3-slot array), `groceryItems[]`, and all grocery mutators.

---

## Architecture rules (do not break these)

- **Edit App.tsx with the `Edit` tool only.** Never PowerShell `Get-Content`/`Set-Content` — corrupts encoding.
- **Never `git checkout App.tsx`, `git restore`, or `git reset --hard`** without explicit approval. Past incident overwrote 1418 lines.
- **Always build/install from the main repo**, not a worktree.
- **Commit after every logical chunk.**
- **Single-file architecture is intentional.** Do not split into multiple files.
- **Multi-list migration is additive.** `tri_tasks` legacy key left in place. Don't remove.
- **`useIsPaid()` is real** — reads Google Play purchase state via `IAPContext`. Do not revert to stub.
- **`SCHEDULE_EXACT_ALARM`** in manifest is intentional. Do NOT remove.
- **Do NOT attempt react-native-reanimated or react-native-draggable-flatlist.** Both incompatible with RN 0.85 + New Arch — dead ends. See dead ends section.

---

## Backlog

### ✅ RESOLVED THIS SESSION — Paywall works
Root cause of "Purchase cancelled": sideloaded release APK had a different signature than the Play-distributed (Play App Signing re-signed) version, so Play Billing rejected ProductDetails fetch with `BILLING_UNAVAILABLE` (statusCode=3) → RC surfaced as `CONFIGURATION_ERROR`. Fix: upload AAB to internal track, install via Play Store on the phone. Always.

### Backlog / post-v1.3
- **Seasonal / event themes** — 80s synthwave, 4th of July, Halloween, Christmas, summer, winter. Auto-activate by date or user-toggled.
- **EditSheet redesign** — Text area + priority buttons side by side to reduce height. Lower priority.
- **Drag-and-drop task reordering** — Hard to integrate with swipe system. Backlog only.

### Polish backlog
- **Swipe-to-dismiss handle UX** — Handle bar could be taller/more tappable.
- **Repeat reminder hint** — "Every hour until done" users may not know completing a task cancels the repeat.
- **Manifest comment** — `SCHEDULE_EXACT_ALARM` comment incorrectly implies it's restricted. Low priority.

---

## Completed this session (2026-05-03, session 6)

### Post-launch bug fixes
- **Phantom reminder fired for non-existent task** — root cause: `useEffect` on app load only called `syncAllReminders` when at least one active task had a reminder. If the last reminder-bearing task was completed/deleted, the orphan alarm in Android's `AlarmManager` never got cancelled and would fire on schedule. Fix: `syncAllReminders` now always runs on cold start. Orphan cancellation runs unconditionally (no perms needed); the re-schedule loop only runs when notif + alarm permissions are both granted, so cold start won't pop the alarm-permission settings page for users without permission. (See `syncAllReminders` and the load-effect at the bottom of `TriorityApp`.)
- **First keystroke dropped on edit modals** — Android IME race: `setTimeout(focus, 320)` fired before the slide animation actually completed on Ross's S24 Ultra (and Pixel emulators). Fix: focus now fires from `Animated.timing(...).start(callback)` so it lands after slide-complete; a 500ms (EditSheet) / 400ms (ListActionSheet) `setTimeout` remains as a fallback. Tester phones don't repro because their IME setup latency is shorter — this is a defense-in-depth fix.
- **Upsell price discrepancy report** — in-app upsell sheet was already hardcoded to `$1.99` (commit `4231a46`, 2026-05-02). If a tester saw `$2.99` it means they were on a pre-1.3.1 (vc <9) build. Play Console price is already $1.99. No code change needed.

### Lost AI-triaged tasks — investigation, no fix yet
- Ross reported a list cleared itself; remembered for sure that an AI-triaged task was on it.
- Traced the save path: `handleAddMany` → `setTasks` → `setListsState` updater → `persistLists(next)` inside the updater. AsyncStorage serializes per-key writes, so concurrent calls still end up with the final state on disk.
- No deterministic bug found in code. **Status: not reproduced, no fix.** Ross watching for it to happen again or for tester reports. If it recurs we'll add `persistLists` instrumentation (counter or toast) to confirm whether the write fired.

### Keystroke-drop fix — could not verify on Pixel emulator
- Pixel emulator (sdk_gphone16k_x86_64, Android 17) auto-keyboard never fires on edit modals at all — not the same bug, just a different emulator quirk. PC keyboard input bypasses the soft IME, and even after disabling hardware keyboard input the soft keyboard didn't auto-pop on these modals.
- Fix is shipped on `f6154cd` regardless. Verify on the S24 next time the edit modal is opened.

### Modal → in-tree portal refactor (IN PROGRESS — branch `modal-to-intree-sheet`)

**Why:** RN's `<Modal>` on Android creates a separate window with `SOFT_INPUT_STATE_UNCHANGED` softInputMode. That breaks IME auto-show (Pixel emulator never popped keyboard) and contributed to the first-keystroke-drop on the S24. HANDOFF dead-ends section had already flagged this and recommended in-tree absolute-positioned sheets as the right path.

**Revert checkpoint:** tag `pre-modal-refactor-2026-05-03` on `main`. To undo: `git checkout main && git reset --hard pre-modal-refactor-2026-05-03` (with approval).

**Architecture:** new `<PortalHost>` component mounted inside TriorityApp's root View. Exposes a `mount/update/unmount` API via `PortalCtx`. New `<RootPortal>` wrapper component that any sheet can use — its children render at the portal slot (root level, above TabBar, in the same window as the activity) instead of at the call site. Mount/update/unmount happen in effects so PortalHost's `setState` never fires during another component's render.

**Converted so far:**
- **EditSheet** — uses `<RootPortal>` + absolute-fill `<View style={portalRoot}>`. `bottom: kbHeight` on the panel lifts it above the IME (manual instead of relying on adjustResize). Focus fires immediately on mount (no slide-completion delay needed since there's no separate window IME race). `Keyboard.dismiss()` on cancel/save (Modal got this for free via window destruction; portal sheets must do it explicitly).
- **ListActionSheet** — same conversion. Tracks `kbHeight` via `keyboardDidShow/Hide` listeners (didn't before), uses `bottom: kbHeight` to lift above keyboard.

**Left as `<Modal>` intentionally:**
- PriorityPicker, ConfirmDialog, ProUpsellSheet, CalendarSheet, Onboarding — none have text inputs requiring auto-keyboard, so the Modal IME issue doesn't bite. Migrating them is unnecessary and would expand the surface area of this refactor for no benefit.

**Test status (Pixel 8 emulator, sdk_gphone16k_x86_64, Android 17):**
- ✅ EditSheet auto-keyboard works, panel lifts above IME, all dismissal paths work.
- ⏳ ListActionSheet just got the same fix — verify long-press list pill → rename input pops keyboard, sheet is visible above it.
- ⏳ S24 verification still pending. Build/install, smoke-test edit + list-rename flows on the real phone before merging to main.

**Bugs found and fixed during the refactor:**
- `IAPProvider`'s cleanup called `listener.remove()` unguarded. RC's `addCustomerInfoUpdateListener` returns undefined when `Purchases.configure` failed (e.g. emulator without Play services), causing a render error. Fixed with optional chaining `listener?.remove?.()`. **This was a latent bug, not caused by the refactor — would have crashed any user whose RC config failed silently.**

### Pixel emulator dev workflow (working, repeatable)
- Pixel 8 AVD running via Android Studio, exposed as `emulator-5554`.
- Install/launch:
  ```powershell
  adb -s emulator-5554 install -r android\app\build\outputs\apk\debug\app-debug.apk
  adb -s emulator-5554 reverse tcp:8081 tcp:8081
  adb -s emulator-5554 shell monkey -p com.triority -c android.intent.category.LAUNCHER 1
  ```
- **Force-paid via AsyncStorage** (RevenueCat fails on emulators because no Play account):
  ```powershell
  # Stop app, pull DB, set flag, push back
  adb -s emulator-5554 shell am force-stop com.triority
  adb -s emulator-5554 exec-out "run-as com.triority cat databases/RKStorage" > E:\Creative\Triority\RKStorage
  sqlite3 E:\Creative\Triority\RKStorage "INSERT OR REPLACE INTO catalystLocalStorage (key, value) VALUES ('tri_is_paid', '1');"
  adb -s emulator-5554 push E:\Creative\Triority\RKStorage /data/local/tmp/RKStorage
  adb -s emulator-5554 shell 'chmod 666 /data/local/tmp/RKStorage'
  adb -s emulator-5554 shell 'run-as com.triority cp /data/local/tmp/RKStorage databases/RKStorage'
  adb -s emulator-5554 shell 'run-as com.triority rm -f databases/RKStorage-journal'
  adb -s emulator-5554 shell 'rm /data/local/tmp/RKStorage'
  ```
  Note: must `adb exec-out` (not `adb shell cat`) to pull the SQLite — `shell` does newline conversion that corrupts binary. Push goes to `/data/local/tmp` first (no direct write into app sandbox), then `run-as cp` into place.
- **Emulator gotchas:**
  - Hardware keyboard input bypasses the soft IME — disable in AVD settings (`Edit → Show Advanced → Enable keyboard input` off, then cold boot) to actually exercise IME code paths.
  - Soft keyboard *still* may not auto-pop on the Pixel emulator even with the portal fix — appears to be an emulator-specific IME quirk. **Cannot fully validate keyboard auto-show on emulator alone — must verify on the S24.**
  - RevenueCat `configure()` will fail on emulator (no Play account). The optional-chain fix lets the app render anyway; paid flag must be set manually.
  - List pill long-press always opens the list-edit sheet on emulator because mouse cursor doesn't wobble enough to trigger drag mode (drag activates at >6px movement). **Working as designed — not a bug. Real fingers always wobble enough.**

## Completed previous session (2026-05-03, session 5)

### Paywall: end-to-end working
- Bumped versionCode 8→9, versionName 1.3.0→1.3.1
- Replaced "Purchase cancelled" silent-swallow in `ProUpsellSheet.onBuy` with diagnostic toast: `showToast('Buy failed', e?.userInfo?.readableErrorCode || e?.code || e?.message)`
- Refactored `buyPro()` to throw specific errors identifying which offering/package piece is missing (offerings null, current null, available pkgs empty, etc.)
- Diagnosed actual block via `Purchases.setLogLevel(LOG_LEVEL.VERBOSE)` + logcat: Play Billing returning `BILLING_UNAVAILABLE` (statusCode=3) for `triority_pro` ProductDetails fetch
- Root cause: sideloaded release-keystore APK has different signature than Play App Signing's distribution signature — billing only works for Play-distributed installs
- Fix: built AAB versionCode 9, uploaded to internal track, installed via Play Store on phone
- Verified buy flow: Google Play sheet → purchase complete → entitlement granted → all gates (grocery, themes, multi-list) unlock as expected
- Reverted log level back to ERROR before final build
- Set up Play Console License testing list (TEST PIGS, 20 emails) — but `LICENSED` response may not exempt billing; possibly want `RESPOND_NORMALLY`
- Generated 500 promo codes ("THANK YOU TESTER!", scheduled 2026-05-04 → 2027-05-02). CSV: `promotion_codes.csv`. Codes redeem via Play Store gift code flow → grants `triority_pro` permanently per account.

## Completed previous session (2026-05-03, session 4)

### RevenueCat integration — Play Billing 6+ blocker resolved
- Installed `react-native-purchases` (RevenueCat SDK)
- Replaced all react-native-iap stubs in `IAPProvider` with real RevenueCat calls
- Fixed JVM target mismatch via `patches/react-native-purchases+10.0.1.patch` (Java 8 → 17)
- Added RevenueCat ProGuard rules to `proguard-rules.pro`
- Set up RevenueCat project: service account, Play Console permissions, Pub/Sub Editor role, Google Play Android Developer API enabled
- Production key `goog_NTynbghUvzIZBcUkZQcQPBxcFCG` in App.tsx
- Product `triority_pro` configured in RevenueCat, linked to entitlement `Triority Pro` and default offering
- AAB and APK both built and signed with production key
- App launches clean on phone — buy button hits RevenueCat but gets "issue with config" because AAB not yet uploaded to Play Console (Google won't expose in-app products API until valid AAB submitted)
- **Next:** Upload AAB → internal testing track, then test buy flow end-to-end

## Completed previous session (2026-05-02, session 3)

### Play Billing blocker discovered — no new commits
- Attempted `react-native-iap` v15 → NitroModules Kotlin compile failure
- Downgraded to v12 → AIDL too old, Play Console rejects, also Kotlin errors
- Both versions are dead ends on RN 0.85 + New Arch (documented above)
- IAP stubs remain in App.tsx; BILLING permission stays in manifest
- AAB versionCode 6 built and signed; blocked from upload by Billing Library requirement
- Next session: implement Play Billing 6.0.1+ via RevenueCat or native patch

## Completed previous session (2026-05-02, session 2)

### IAP wiring + gate enforcement — `4f42da3` / `c32a4d9`
- `react-native-iap` installed; `com.android.vending.BILLING` permission added
- `IAPProvider` + `IAPContext` replace the `useIsPaid()` stub. Wraps app root.
- `useIsPaid()` and `useIAP()` hooks read from `IAPContext`
- `IAPProvider`: init on mount, flush pending, check existing purchases, `purchaseUpdatedListener` auto-calls `finishTransaction` + marks paid, purchase state cached to `tri_is_paid`
- `ProUpsellSheet` fully wired: `buyPro()` triggers Play flow, `restorePurchases()` checks existing, copy updated to list all 3 features
- Restore Purchase row added to Settings (`!isPaid` only)
- Grocery nav button gated: free users see lock icon, tap → upsell
- AI grocery routing gated: free users get tasks-only prompt, no grocery items ever created
- AI cross-list routing: paid users with 2+ lists get list names injected into prompt; AI returns `listId`; tasks routed to named list with toast "Added to [Name]"
- `handleAddManyToList` added to `ActiveList`; `setListTasks` threaded through `ActiveListProps`
- Also committed from previous orphaned session: archive week-grouping, onboarding rewrite, icon additions

### Previous session orphan committed — `74ca556`
- Archive: week-group headers (This Week / Last Week / date range), older weeks auto-collapse
- Onboarding: 6-step rewrite covering all current features
- ICON_MAP: `layers`, `shopping-cart`, `sun` added

## Completed previous session (2026-05-02, session 1)

### Grocery list mode — `ae35aaf`
- `GroceryItem` type + `tri_grocery` AsyncStorage key
- Tasks/Grocery nav buttons at top (centered, h36, fontSize 15), long-press Tasks → ListActionSheet, long-press Grocery → noop
- Date + item/task count on same line below nav buttons
- `GroceryItemRow` — right swipe → "Got it" section, left swipe → confirm then delete
- `GroceryScreen` — category-grouped active items, "Got it" pinned at bottom, action pills (AI Sort → A–Z → Clear)
- Clear pill: tap clears Got It items only, long-press 600ms → confirm dialog → clear all list
- AI Sort re-categorizes all items (snapshot-based, no stale closure), resets to category view after
- InputBar grocery mode: no AI = plain add, AI on = Claude routes tasks vs grocery items
- AI placeholder unified across both views

### Custom theme card fixes — `6056b2b` / `79e1be0`
- Filled custom slots render with dashed border (consistent with empty slots)
- Long-press filled custom card (500ms) → confirm dialog → clears slot back to empty, falls back to Slate if active

---

## Grocery List — Implementation Notes

### Key behaviors
- Grocery list is static (always exists, never in pill row, can't be deleted)
- `checked: true` = item is in "Got it" section — still in `groceryItems[]`, just rendered separately
- AI Sort reads a snapshot of `groceryItems` at call time (not inside `setState`) — fixes stale closure bug
- After AI Sort completes, `sortMode` resets to `'category'` via `onDone` callback
- `aiSortGrocery` in `TriorityApp` accepts optional `onDone?: () => void` — called after fetch resolves

### AI prompts
Three distinct AI paths in `InputBar.submit()`:
1. **Grocery view + AI** — grocery-only prompt → `GroceryItem[]` with category
2. **Task view + AI (paid, multi-list)** — prompt includes list names + IDs. AI returns `{ tasks[{text,tier,listId,reminder}], grocery[] }`. Tasks with a matching `listId` route to that list via `onAddManyToList` + toast "Added to [Name]". Tasks with `listId: null` go to active list via `onAddMany`. Grocery items go to grocery list. Free users or single-list: grocery array always empty, no `listId` in prompt.
3. **Either view + no AI** — plain add (grocery: no modal; tasks: PriorityPicker)

`onAddManyToList(listId, items)` — new callback on `ActiveList` → calls `setListTasks(listId, ...)`. Passed into `InputBar` as a prop alongside `lists` and `activeListId`.

### Category taxonomy (used in both AI prompts)
`Produce, Dairy, Meat & Seafood, Bakery, Frozen, Canned & Dry Goods, Beverages, Snacks, Household, Personal Care, Other, Uncategorized`

---

## v1.3 Play Store checklist (CLOSED — superseded by GitHub pivot 2026-05-05)

Kept for archaeology. Items marked ✅ shipped on Play (vc14 + vc16). Items marked ⬜ are now obsolete — we are no longer shipping to Play Store. Future releases ship as GitHub Release artifacts, see "Step 16" in the current focus section.

1. ✅ **Grocery list mode** — shipped
2. ✅ **Rewrite onboarding** — 6-step rewrite shipped
3. ✅ **BILLING permission** in AndroidManifest — present
4. ✅ **Set up SKU in Play Console:** `triority_pro` at $2.99 one-time — Active
5. ✅ **`IAPProvider` + gate enforcement wired** — all gates active, buy/restore API ready
6. ✅ **Add Restore Purchase** row to Settings — done
7. ✅ **Gate enforcement** — grocery nav, AI grocery routing, themes/accents, multi-list all gated
8. ✅ **AI cross-list routing** — shipped
9. ✅ **versionCode 6**, versionName "1.3.0" — set in build.gradle
10. ✅ **Signed AAB built** — versionCode 8
11. ✅ **Play Billing Library blocker resolved** — replaced react-native-iap with react-native-purchases (RevenueCat), wraps Play Billing 6+. JVM patch + ProGuard rules added.
12. ✅ **AAB uploaded to Play Console** — versionCode 9 (1.3.1), approved, live on internal testing track
13. ✅ **Test IAP end-to-end** — buy button works, entitlement grants, gates unlock
14. ⬜ **Update price in Play Console** — change `triority_pro` from $2.99 to $1.99 (upsell modal already shows $1.99)
15. ⬜ **Onboarding re-trigger on version bump** — clear `tri_onboarded` for existing users (next versionCode bump)
16. ✅ **Generate promo codes** for testers — 500 codes, "THANK YOU TESTER!" promo, live 2026-05-04
17. ⬜ **Refund self-purchase** — Ross's $1.99 from 2026-05-03 testing. Play Console → Monetize → Orders → Refund.
18. ⬜ **Verify license testing exempts billing** — flip License response from `LICENSED` to `RESPOND_NORMALLY` if charges keep going through for testers

---

## AsyncStorage keys

| Key | Content |
|---|---|
| `tri_lists` | `TaskList[]` — source of truth |
| `tri_tasks` | Legacy `Task[]` — safety net, no longer written |
| `tri_active_list_id` | Active list string ID |
| `tri_list_order` | `string[]` — ordered list IDs for pill row |
| `tri_archive` | `ArchivedTask[]` |
| `tri_grocery` | `GroceryItem[]` — grocery list items |
| `tri_theme` | Theme id string (`'slate'`, `'custom_0'`, etc.). Default `slate`. |
| `tri_accent_light` | Hex color or null (null = use theme default) |
| `tri_accent_dark` | Hex color or null (null = use theme default) |
| `tri_accent` | LEGACY — migrated to both `tri_accent_light` + `tri_accent_dark` on first load, then deleted |
| `tri_custom_themes` | `(CustomThemeDraft\|null)[]` — 3-slot array of custom theme drafts |
| `tri_custom_theme` | LEGACY — single draft, migrated to `tri_custom_themes[0]` on first load |
| `tri_darkMode` | Boolean |
| `tri_defaultTier` | `'high' \| 'medium' \| 'low'` — AI fallback only, not in Settings UI |
| `tri_autoClear` | `'Never' \| '7 days' \| '30 days' \| '90 days'` |
| `triority-context` | Personal context string for AI triage |
| `tri_onboarded` | `'1'` once seen |
| `tri_is_paid` | `'1'` if `triority_pro` purchase confirmed — IAP warm-start cache |
| `triority-api-key` | EncryptedStorage (not AsyncStorage) |

---

## Key files

| File | Purpose |
|---|---|
| `App.tsx` | Everything — single-file RN app |
| `HANDOFF.md` | This file |
| `android/app/build.gradle` | versionCode/versionName, keystore config |
| `android/app/triority-release.keystore` | Gitignored. In Ross's password manager. Valid through 2051. |
| `android/keystore.properties` | Gitignored. Loaded by build.gradle for release signing. |
| `patches/` | 3 patches via postinstall — don't delete |

---

## Patches in place (survive `npm install`)

- `react-native-speech-recognition-kit+1.0.7.patch` — fixes silent second mic press (cancel+destroy+150ms delay before new recognizer)
- `react-native-gesture-handler+2.31.1.patch` — VERSION_1_8 → VERSION_17
- `@react-native+gradle-plugin+0.85.2.patch` — foojay disabled, JDK 21, JBR home pinned
- `react-native-purchases+10.0.1.patch` — bumps compileOptions from Java 8 → 17 to match app JVM target

---

## Data persistence

**Survives:** Metro reload, `adb install -r`, native rebuilds with same keystore, Play Store updates.  
**Does NOT survive:** `adb uninstall`, manual uninstall, clearing app data, switching debug↔release signing.

---

## Security

- API key encrypted via `react-native-encrypted-storage` (Google Tink, hardware-backed). Never in plaintext.
- All API calls HTTPS-only to `api.anthropic.com`. No analytics, no telemetry, no third-party servers.
- Local-only data: tasks, archive, settings. AsyncStorage for non-sensitive, EncryptedStorage for API key.
- ProGuard/R8 enabled in release builds. Keep rules in `app/proguard-rules.pro`.

---

## Dead ends (do not retry)

- **react-native-reanimated:** reanimated 4 requires react-native-worklets → runtime fails on RN 0.85 + New Arch. Reanimated 3.x has Java compile errors against RN 0.85's removed Old Arch APIs.
- **react-native-draggable-flatlist:** requires reanimated — same dead end.
- **react-native-iap v15:** Uses NitroModules — Kotlin coroutine/suspend compile errors against RN 0.85 New Arch. Do not retry.
- **react-native-iap v12:** Uses AIDL billing — compiles but Play Console rejects (requires Billing Library 6.0.1+). Also has `currentActivity` unresolved reference errors in Kotlin. Do not retry.
- **Auto-keyboard-popup in Modal:** tried `autoFocus`, `Modal.onShow`, multi-retry timers, `onLayout`-driven focus — all unreliable on Android AND broke InputBar keyboard behavior. If revisited: replace `<Modal>` with custom in-tree absolutely-positioned sheet to avoid IME race.
- **Hosted AI as paid feature:** rejected. Maintenance liability (model deprecations, Worker upkeep) outweighs value for a passion project.
- **Subscription pricing:** rejected. One-time $2.99 is simpler, lower friction.

---

## Ross's preferences

- Single-file architecture is intentional. Don't split.
- No unnecessary comments in code.
- Don't ask before small obvious fixes — just do and report.
- Do ask before anything destructive, git-related, or keystore/signing.
- Present work section by section for big changes. Ask clarifying questions before implementing big features.
- When in doubt: ask. Ross prefers questions over mistakes.
