# Changelog

## Unreleased

- Added the Supabase shared-list backend scaffold and migration SQL for faster shared-list invite, membership, item, archive, rename, rotate-code, leave, delete, realtime, and sign-in recovery flows.
- Kept legacy Firestore shared-list support in place so existing shared lists are not stranded during the migration.
- Disabled the Supabase runtime path in the currently working APK after the first Supabase-enabled phone build crashed on launch. Supabase is now the top next-session priority before it is re-enabled.
- Preserved the working Firestore shared-list build path and installed rescue APK `9E45ED21DE470909FDA6C55863F7CCB194055648BCE6AC0B8FEE763F27567D25` on Ross's phone.
- Added Firestore rules support for join-by-code ACL mutation and shared task archive documents.
- Added the GitHub update manifest `latest.json` pointing at the existing v1.0.0 APK release.
