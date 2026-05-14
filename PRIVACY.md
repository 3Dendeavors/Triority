# Triority Privacy Policy

Effective date: May 14, 2026

Triority is a private-first Android task, grocery, reminder, and AI triage app. It is built to keep your planning data under your control and to avoid analytics, telemetry, and hosted AI services.

## Scope

This policy describes public-facing data handling. Technical implementation details live in the project documentation and source code.

## No Analytics Or Telemetry

Triority is intended to have no analytics, telemetry, tracking SDKs, or sale of user data.

## Data Triority Stores

Triority can store:

- Tasks, task lists, priorities, reminders, archived tasks, groceries, shared-list data, themes, settings, and onboarding state.
- Optional Personal Context that you write in Settings to help AI triage understand your priorities.
- Optional Google sign-in identifiers needed for sync and shared lists.
- Optional shared-list membership data, invite codes, item metadata, and collaborator display initials.
- Optional AI provider API key. This key is stored locally with encrypted storage and is not intentionally synced.

## Local-Only Use

If you do not sign in, your normal app data stays on your device. Deleting the app, clearing app data, or uninstalling it can remove local data.

## Optional Sync And Sharing

If you sign in with Google, Triority uses Firebase Authentication so you can back up/sync app data and join shared lists. Google handles the sign-in process; Triority does not receive your Google password.

Triority may use Firebase and Supabase to store synced data, shared task lists, shared grocery lists, invite codes, shared-item updates, and shared archive rows. Shared-list members can see the items and reminder details in lists they share.

## Optional Calendar Conflict Checks

If you enable calendar conflict checks, Triority asks Google for read-only calendar availability information so it can warn when a reminder overlaps busy time. Triority does not create, edit, or delete calendar events.

## Optional AI Triage

AI features are bring-your-own-key. If you add a Gemini or Claude API key and use AI triage, Triority sends the relevant prompt and limited app context directly to the provider you selected. This can include the text you typed, selected app context such as list names or visible rows, and your Personal Context when needed for routing.

Triority does not provide a hosted AI service and does not intentionally send AI requests unless you use an AI feature.

## Network Services

Depending on the features you use, Triority may connect to:

- Firebase for optional Google sign-in, sync, and legacy shared-list support.
- Supabase for current shared-list collaboration.
- Google Calendar APIs for optional read-only free/busy checks.
- Gemini or Claude only when you provide an API key and use AI features.
- GitHub to check for newer APK releases.
- Buy Me a Coffee only if you tap the optional support link.

## Data Deletion

Settings includes a Delete Account Data action for signed-in users. It deletes the synced Triority backup for the current Google account, signs out, clears Triority data on that phone, removes the saved AI key, and cancels local reminders.

Shared collaboration records are separate from the private sync backup. Shared lists that other people can access are not silently deleted by the account-data button; owners should delete or make those lists private from the shared-list controls when they want to remove shared data for everyone.

## Changes

This policy may be updated as Triority changes. Public APK releases should keep this file current with the app's actual behavior.
