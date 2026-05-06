# Codex Changes Since Fork

This file tracks Codex-only work in:

`E:\Creative\Triority\Triority\CODEX WORK\Triority-codex-source`

The main Claude/source tree at `E:\Creative\Triority\Triority` has not been edited or merged by Codex.

## Baseline

- `fa57ba8` - `Import Triority source snapshot for Codex workspace`
- Snapshot was copied from the on-disk Triority project and treated as the fork baseline.

## Codex Commits

### `492ae06` - `Fix shared-list handoff regressions`

- Added `ensurePersonalListPresent()` and wired it into local load/order and cloud restore so the hard-coded Personal/default list exists and stays first after old Firestore data restores.
- Updated `ActiveList`'s `onShareList` parent handler to accept the `pendingName` passed by `ListActionSheet`, so rename-then-share can use the typed name.
- Replaced user-facing "pill row" copy in Settings with "lists".

### `09f3830` - `Stabilize list deletion and shared pill ordering`

- Made `deleteList(DEFAULT_LIST_ID)` a no-op.
- Simplified private-list delete active-list fallback to prefer Personal/default.
- Added local `tri_shared_task_order` state for shared task-list pill order, attempting to stop shared pill reorder from snapping back.

### `ad0ecc8` - `Keep edit sheet footer above keyboard`

- Changed `EditSheet` keyboard-open scroll max height from fixed `248` to a visible-window calculation.

## Build/Test Path Used

- Direct release build from `CODEX WORK` failed because the path is too deep for Windows native/CMake output: `Filename longer than 260 characters`.
- Created temporary build copy at `C:\tmp\tri-codex-build`.
- Copied real `node_modules` into `C:\tmp\tri-codex-build\node_modules`. The junction approach made Metro fail resolving `@babel/runtime`.
- Built with:

```powershell
cd C:\tmp\tri-codex-build\android
.\gradlew.bat app:assembleRelease
```

- Installed with:

```powershell
adb install -r C:\tmp\tri-codex-build\android\app\build\outputs\apk\release\app-release.apk
```

- Launched `com.triority` on phone.

## Phone Test Results On Codex APK

- Personal/home list behavior looks correct so far: not deletable, not shareable.
- Edit task Save/Cancel buttons are still somewhat overlapped by the keyboard.
- List Settings on the home list has similar insufficient upward movement.
- General issue: some bottom-sheet/modal areas are not being pushed up enough above the keyboard.
- Shared list pill drag still does not work, despite the `tri_shared_task_order` attempt.

## Current High-Risk Bug: Shared Delete

Ross reproduced this on the Codex APK:

1. Create a new private list and share it.
2. Delete it: deletion worked.
3. Create that same list again and share it.
4. Create another list and share that second list too.
5. Try to delete the first shared list: unable to delete it.
6. Delete the second shared list: both shared lists disappear.

This suggests the delete action/sheet may be acting on stale active/action list state or a shared-list ID closure problem, not just Firestore latency. Re-check `ListActionSheet` shared owner `onDelete`, `liveList`, `actionList`, `sharedDoc`, and any list identity captured around `setActionList(null)` and confirm dialog timing.

## Next Codex Pickup

1. Do not touch main Claude tree unless Ross explicitly asks to merge/copy changes.
2. Fix keyboard lift generically for in-tree sheets (`EditSheet`, `ListActionSheet`) rather than only changing `EditSheet` scroll height. Likely need to account for footer height, safe area, and panel bottom/transform together.
3. Investigate shared delete stale-ID behavior with logging/toasts or code audit before another phone build. The reproduction above is the highest-risk current bug.
4. Re-investigate shared pill drag after delete bug. Current local-order patch did not solve the user-visible drag issue.
5. When rebuilding Codex test APK, use the short temp path `C:\tmp\tri-codex-build` or another short path to avoid CMake path length issues.
