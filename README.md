# Triority

Triority is a private-first Android task, grocery, reminder, and AI triage app. It is built around quick capture, three practical priority tiers, optional Google sync, shared household-style lists, and bring-your-own Claude API access.

## Download

The current public beta APK is published on GitHub Releases:

- Latest release: https://github.com/3Dendeavors/Triority/releases/latest
- Current beta: `v1.4.4`
- Android package id: `com.triority`

Install the APK on Android by downloading it from the latest release and accepting Android's sideload/install prompt. Future installed builds check this repo's `latest.json` and prompt when a newer APK is available.

Use the release APK asset for installs. Source-code archives attached to GitHub tags are not Android installers.

## What It Does

- Tasks organized into High, Medium, and Low tiers.
- Multiple task lists with drag reorder inside each tier, archive/restore support, and a short shine on newly added rows.
- Built-in grocery list with category sorting, a Got It section, recipe/project quantities, and material-shopping categories.
- Shared task lists and one shared grocery page through optional sign-in and invite codes.
- Local and shared task reminders, with each device alerting only when that user allows notifications.
- Optional read-only Google Calendar conflict checks for reminder tasks.
- Optional AI triage using your own Claude API key, Personal Context, and the current task/grocery workspace.
- Themes, accent colors, and personal context for AI prompting.
- Optional support through Buy Me a Coffee: https://buymeacoffee.com/3DEndeavors

## Privacy

Triority is intended to have no analytics and no telemetry.

Network calls are limited to:

- Firebase for optional Google sign-in, sync, and legacy shared lists.
- Supabase for current shared-list collaboration.
- Google Calendar free/busy checks only when you enable calendar conflict checks.
- Anthropic only when you provide a Claude API key and use AI features.

Google handles sign-in. Triority does not receive your Google password. Your Anthropic API key is stored locally with encrypted storage and is not intentionally synced.

## Building

This is a React Native Android app. Most app logic intentionally lives in `App.tsx`.

For release builds after JavaScript changes, force the bundle task to rerun:

```powershell
cd android
.\gradlew.bat :app:createBundleReleaseJsAndAssets --rerun-tasks :app:assembleRelease --no-daemon
```

Release signing files and Firebase config are intentionally not committed. See `scripts/prepare-github-release-secrets.ps1` for preparing GitHub Actions release secrets from local private files.

## Current Status

The current public beta is `v1.4.4` / `versionCode 20`. The source on `main` now includes additional post-release polish for shared reminders, read-only calendar conflict checks, safer account switching, contextual AI/grocery quantity handling, replayable onboarding, and Settings cleanup. The next public release should be packaged with a real APK asset before `latest.json` is updated.
