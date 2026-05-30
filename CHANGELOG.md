# Changelog

## Unreleased

## v1.4.20 - 2026-05-30

- Fixed AI grocery/material display capitalization so repeated AI parse/sort passes do not turn already-capitalized names like `Eggs` into `EGgs`/`EGGs`.
- Added regression coverage for grocery capitalization idempotence.

## v1.4.18 - 2026-05-23

- Added included Triority AI as the default tester path, while keeping Gemini and Claude bring-your-own-key options available.
- Added a one-time included-AI announcement, updated Settings copy, and kept the Gemini secret out of the APK by routing built-in AI through a Supabase Edge Function with rate-limit storage.
- Fixed AI task-list routing for generic list names such as "Test List" when the prompt explicitly says to put the captured tasks in that named list.
- Fixed mixed AI prompts like "test page on website eggs milk bread" so the Website task is separated from the grocery rows, and delayed mixed-grocery rows still shine when Grocery is opened later.
- Changed failed AI-mode submissions to fail visibly while preserving the typed input instead of silently adding a raw fallback row.
- Fixed mixed direct-task/grocery prompts so an early task like "rub Kailyns back" is preserved when bare grocery words appear before another task clause.

## v1.4.12 - 2026-05-14

- Protected recent local task/list edits from being overwritten by an older Firestore restore while the debounced sync write is still pending.
- Stopped the local app-version marker check from clearing task/list/archive storage during normal upgrades.

## v1.4.11 - 2026-05-14

- Added a public privacy policy and linked it from Settings.
- Added a signed-in Delete Account Data flow that deletes the synced backup, signs out, clears local Triority data on that phone, removes the saved AI key, and cancels local reminders.
- Added visible account-restore feedback after sign-in/account switching so synced lists and settings can reload without looking stuck.
- Limited that restore feedback to actual account restores/switches so normal same-account backup checks do not sit on screen.
- Synced widget theme settings and the calendar conflict toggle with the signed-in account, and kept AI provider keys local but remembered per Google account on the same phone.
- Hardened grocery adds against unchecked duplicates on personal and shared grocery lists, including case changes and manual-vs-AI grocery rows, while still allowing fresh adds after an item is checked.
- Updated the GitHub release secret helper so `scripts/prepare-github-release-secrets.ps1 -Upload` can upload release workflow secrets after GitHub CLI authentication is valid.
- Added more AI smoke-test oddball cases for date-only/no-time controls, casual household captures, recipe no-extra constraints, and seasoning-needed recipe prompts.

## v1.4.10 - 2026-05-13

- Fixed task drag/drop accuracy on long task lists. Dragged rows now stay anchored to the finger while the list edge-scrolls, including at the bottom of the list.
- Changed task drop targeting to use explicit insertion slots from the finger's ScrollView position instead of relying on the dragged row's original center.
- Improved cross-priority drops so local task moves can land in the intended slot inside High, Medium, or Low rather than only changing priority.
- Clamped drag edge-scroll to the real measured ScrollView content height so holding near the bottom cannot push the grabbed row beyond the actual list end.
- Preserved the post-v1.4.9 AI reminder hotfix: timed action phrases, scheduled-event wording, compact times such as `1230`, and broad intent-frame prompts are handled more reliably.

## v1.4.9 - 2026-05-12

- Simplified public AI choices to Gemini 2.5 Flash-Lite for the fast/low-cost lane and Claude Sonnet 4.6 for the premium lane. Legacy saved GPT selections now migrate to Gemini, and legacy Claude Haiku selections migrate to Sonnet.
- Kept bring-your-own-key behavior: keys stay local, no hosted AI fallback was added, and AI errors now distinguish temporary provider overload from key/model rejection.
- Reworked Gemini routing around the stable `gemini-2.5-flash-lite` model with JSON-only prompting, structured-output fallbacks, bounded 429/5xx retry/backoff, larger output headroom, cut-off JSON detection, and recovery for common wrapper/alternate-key response shapes.
- Tightened mixed AI routing so natural prompts can split into To-do rows, reminders, destination task lists, and grocery/material rows without relying on exact phrasing.
- Improved direct-task recovery and de-duping so model-cleaned rows do not stack beside literal filler versions like `call grandma at some point`, `email Alex later`, or `text Sam at some point`; direct action terms such as `test` are now preserved more reliably.
- Improved list routing so a row's own unique list-name signal can win inside a broader generated prompt, including Biomed/Biomedical-style matches, while unrelated rows fall back to the normal To-do list.
- Added stronger generated-plan handling for routines, checklists, workout plans, advice, and similar prompts: thin/meta rows retry into concrete app-sized rows, weak generated rows are replaced instead of duplicated, and chest/workout prompts can fall back to practical starter rows with sets/reps/time details.
- Restored AI mode to non-sticky behavior so leaving a screen or reopening the app does not leave the input bar unexpectedly armed.
- Added starter-sized output limits for broad assistant prompts unless the user asks for a full, weekly, detailed, or exact-count result.
- Tightened Personal Context handling so broad task suggestions respect accessibility, mobility, sensory, health, and lifestyle notes, and grocery/recipe generation treats vegan, no-meat, allergy, and product-ban notes as hard constraints.
- Improved grocery/material generation for recipes, smoothies, projects, repairs, packing, and casual phrases such as `smoothie stuff`, `crap to buy`, and `things for the repair`.
- Clarified generated grocery row semantics: needed recipe/project amounts render on the left as `quantity` + `unit`, while the smallest common purchase/container hint renders on the right as `packageSize`.
- Cleaned generated grocery quantities by stripping bare `1` guesses, moving one-container guesses into package hints, retrying rows that miss most amounts/package hints, and rendering common decimal recipe amounts such as `0.5 cup` as `1/2 cup`.
- Preserved direct grocery requests such as `get eggs` as grocery rows instead of To-do tasks.
- Made Grocery-tab AI mixed-input aware, so prompts that include obvious task language can create both task rows and grocery/material rows instead of being forced through grocery-only parsing.
- Improved new-row focus/shine behavior for AI, manual, shared, and widget-created rows: focused rows no longer double-shine, off-screen generated rows shine once when they become visible, and multi-list task results focus one destination instead of snapping through every affected list.
- Fixed delayed widget AI imports so opening the app while parsing is in flight no longer cancels the final focus/shine step.
- Ordered widget-created reminder tasks to the top of their own High/Medium/Low tier, with overdue reminders first and upcoming reminders by soonest due.
- Clarified widget AI progress with organizing/result messages and scoped pending task shine by list plus task id so rows added to multiple lists still get their visual confirmation.
- Added a Patch notes action to Android update prompts when `latest.json` includes a GitHub release-notes URL, with the manifest summary shown in the prompt and the full changelog one tap away on GitHub.
- Improved task drag/drop clarity and accuracy: rows stay visibly lifted, within-tier reorder uses a stronger slot line, priority tiers highlight under the finger, empty priority tiers appear as temporary drop targets, normal scrolling cancels the long-press drag arm, and edge-scroll can reverse direction mid-drag.
- Fixed first-swipe task completion misses by using the actual release distance instead of the animated value.
- Made shared-grocery swipe/check/delete paths update locally first and guard pending remote writes from stale listener refreshes.
- Added an internal local AI smoke-test harness for regression coverage across routing, grocery, reminders, Personal Context, and provider behavior. It is ignored from runtime app behavior and uses local-only keys.

## v1.4.7 - 2026-05-10

- Added native Android voice-first home-screen widgets. `Triority Voice` renders idle as a compact mic button in a 1x5 slot, while `Triority Next Up` uses the rail for a rotating task/reminder preview with list, color-coded priority, and reminder metadata. Google Speech handles capture, the widget only shows final transcript review with Cancel and Organize/Add, queued captures import through the existing AI/manual paths, preview taps open the app to the shown task, and Appearance now includes widget theme plus left/right mic placement. Widget custom-theme color export now maps app control/accent/text roles correctly instead of misreading React Native alpha hex colors.
- Updated AI triage to Anthropic `claude-sonnet-4-6`, replaced the custom rotating submit spinner with the native loading indicator, moved AI task/grocery/category calls to forced Anthropic tool responses instead of prompt-only JSON, and changed AI failures to show the actual key/billing/model/network cause when available.
- Polished widget preview timing and task focus feedback: next-up previews rotate about every 18 seconds, preview metadata sits at the bottom left, the title area can use two lines, same-task widget taps replay the shine, right-side mic placement anchors the bubble to the mic and expands leftward, and the row shine no longer carries a separate lingering border.
- Added a one-time widget onboarding card for this release. Existing users see the widget card once after updating; future updates stay quiet unless a new release-specific onboarding key is intentionally added.
- Fixed two late beta issues: switching between task lists no longer trips the focused-row shine hook order, and AI task routing no longer treats the currently open list as the default destination. Generic tasks fall back to the normal To-do list unless a list is named, strongly implied, or matched through Personal Context.

## v1.4.5 - 2026-05-09

- Documentation pass: recorded v1.4.4 as the current public APK release, clarified that GitHub releases must include an APK asset, and preserved Ross's keyboard-sheet and public-repo preferences for future sessions.
- Added the Buy Me a Coffee support link so Settings can show the Support Triority row.
- Verified the support row/link, keyboard/list-modal polish, and active shared-grocery AI routing in local testing.
- Updated planning docs to mark v1.4.4 field use, task-list pill centering, Make Private, and membership restore as verified, and moved collapse persistence, grocery/material flexibility, quantity handling, shared reminders, AI readouts, and late-cycle onboarding into the active next-feature list.
- Persisted collapsed/expanded group state for task tiers, grocery categories/Got It, and archive week groups.
- Expanded grocery categories with lightweight material-shopping groups for hardware, lumber, electrical, plumbing, automotive, office supplies, tools, paint, and fasteners.
- Updated AI grocery/material parsing to preserve specified quantities/units and infer practical starter quantities for generated project/material lists where reasonable.
- Added notification-permission nudges when users share or join lists, and when they enable a task reminder.
- Added shared task reminders. Shared rows store the reminder for everyone to see, while each member's phone only schedules/fires local alerts when that member grants notification and reminder permissions.
- Routed reminder notification taps back into the matching list/task and reused the new-row shine so the task that pinged the user is easier to spot.
- Ensured foreground reminders still alert while the app is open, so reminders are not missed during active list use or shopping.
- Added a direct shared-list join action in list/grocery management, then removed redundant join-code clutter from the edit screen.
- Restored shared archived tasks in Archive and fixed shared-list task completion undo behavior.
- Removed the compact AI action readout experiment after it proved less useful than the visible row changes and toasts.
- Tightened AI routing prompts so simple grocery item lists do not get guessed quantities, while recipe/project prompts can include practical measurements and package-size hints.
- Added optional read-only Google Calendar conflict checks for reminder tasks. Conflicts show a red calendar icon/toast; the app does not create or edit calendar events.
- Improved account-switching safety by keeping sync caches account-scoped and recovering Supabase shared memberships for the signed-in account.
- Slowed the task-list pill auto-center behavior so user scrolling is not immediately snapped back.
- Reworked onboarding as a replayable feature tour with concise copy, fake app previews, and coverage for quick capture, AI routing, sharing, groceries/materials/recipes, reminders, privacy, and optional sync.
- Cleaned up Settings by combining Sync and Calendar conflict checks, keeping Help above the bottom Support Triority row, and sizing the support row for its label.

## v1.4.4

- Recover existing Supabase grocery memberships when the server says the user is already in a shared grocery list, so stale/orphaned memberships can be surfaced in-app instead of blocking sharing.
- Replaced the recent-add soft glow with a short gold shine/glint animation for newly added task and grocery rows.
- Center the horizontal task-list pill row on the selected list when the active list changes.
- Moved shared-list join-code entry from Settings into task-list and grocery management flows, keeping the keyboard-aware code-entry sheet.
- Changed task-list management to use the tappable list title with a small pencil mark, avoiding the copy-looking clipboard button.
- Matched shared task-list and shared grocery header readouts with the same people-icon/member-count language instead of private/shared text.
- Adjusted keyboard-aware sheet sizing for task-edit and list-settings modals so normal-sized phones should not scroll by default without adding an artificial gap above Samsung/Gboard.
- Routed task-screen AI grocery/material output through the active grocery surface, so generated items land in a shared grocery list when that is the current grocery workspace.
- Removed the date from task and grocery headers and aligned the task archive button with the active list title row.

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
- Confirmed the six Claude round-two fixes worked as intended after force-stopping and reopening both test devices.
- Bumped the Android beta version to `versionCode 18`, `versionName "1.4.2"`.

## v1.4.1

- Beta update release for the current working rescue build.
- Keeps Supabase shared-list code and database migration in the repo, but leaves the Supabase runtime disabled after the first enabled APK crashed on launch.
- Keeps Firestore shared lists working while Supabase startup compatibility is fixed next.
- Adds GitHub update-manifest support so installed beta builds can prompt for newer APKs on launch.
- Added the Supabase shared-list backend scaffold and migration SQL for faster shared-list invite, membership, item, archive, rename, rotate-code, leave, delete, realtime, and sign-in recovery flows.
- Kept legacy Firestore shared-list support in place so existing shared lists are not stranded during the migration.
- Disabled the Supabase runtime path in the currently working APK after the first Supabase-enabled phone build crashed on launch. Supabase is now the top next-session priority before it is re-enabled.
- Preserved the working Firestore shared-list build path and installed rescue APK `9E45ED21DE470909FDA6C55863F7CCB194055648BCE6AC0B8FEE763F27567D25` on a test phone.
- Added Firestore rules support for join-by-code ACL mutation and shared task archive documents.
- Added the GitHub update manifest `latest.json` pointing at the existing v1.0.0 APK release.
