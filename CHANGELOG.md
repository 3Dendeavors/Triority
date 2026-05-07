# Changelog

## Unreleased

- Recover existing Supabase grocery memberships when the server says the user is already in a shared grocery list, so stale/orphaned memberships can be surfaced in-app instead of blocking sharing.

## v1.4.3

- Hotfix for Supabase shared grocery membership recovery after v1.4.2 exposed accounts with server-side grocery memberships that were missing from local app state.

## v1.4.2

- Re-enabled Supabase shared lists after adding the React Native URL polyfill at startup.
- Removed broad Supabase membership auto-recovery by UID so stale/test shared lists do not silently reappear on another tester's phone.
- Added an exact shared-grocery intent guard so Supabase grocery lists only restore after explicit create/join in the fixed build.
- Added foreground Supabase realtime auth refresh plus a 5-second active shared-list refresh fallback so collaborator item changes appear without restarting the app.
- Race-proofed the active Supabase grocery marker so newly shared groceries do not disappear before the share-code sheet opens.
- Made Supabase shared task complete/delete, shared-list leave, and shared grocery check/delete/clear feel local-first with rollback on failure.
- Preserved pending optimistic shared grocery/task rows during realtime refreshes so newly added items no longer flicker out and back in.
- Cleared locally removed shared-list quarantine when joined IDs restore so shared items do not stay empty until restart.
- Ross confirmed the six Claude round-two fixes worked as intended after force-stopping and reopening both test devices.
- Bumped the Android beta version to `versionCode 18`, `versionName "1.4.2"`.

## v1.4.1

- Beta update release for the current working rescue build.
- Keeps Supabase shared-list code and database migration in the repo, but leaves the Supabase runtime disabled after the first enabled APK crashed on launch.
- Keeps Firestore shared lists working while Supabase startup compatibility is fixed next.
- Adds GitHub update-manifest support so installed beta builds can prompt for newer APKs on launch.
- Added the Supabase shared-list backend scaffold and migration SQL for faster shared-list invite, membership, item, archive, rename, rotate-code, leave, delete, realtime, and sign-in recovery flows.
- Kept legacy Firestore shared-list support in place so existing shared lists are not stranded during the migration.
- Disabled the Supabase runtime path in the currently working APK after the first Supabase-enabled phone build crashed on launch. Supabase is now the top next-session priority before it is re-enabled.
- Preserved the working Firestore shared-list build path and installed rescue APK `9E45ED21DE470909FDA6C55863F7CCB194055648BCE6AC0B8FEE763F27567D25` on Ross's phone.
- Added Firestore rules support for join-by-code ACL mutation and shared task archive documents.
- Added the GitHub update manifest `latest.json` pointing at the existing v1.0.0 APK release.
