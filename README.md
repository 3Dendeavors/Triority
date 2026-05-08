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
- Multiple task lists with drag reorder inside each tier.
- Built-in grocery list with category sorting and a Got It section.
- Shared task lists and one shared grocery list through optional sign-in.
- Task archive with restore support.
- Local reminders for tasks.
- Optional AI triage using your own Claude API key.
- Themes, accent colors, and personal context for AI prompting.
- Optional support through Buy Me a Coffee: https://buymeacoffee.com/3DEndeavors

## Privacy

Triority is intended to have no analytics and no telemetry.

Network calls are limited to:

- Firebase for optional Google sign-in, sync, and legacy shared lists.
- Supabase for current shared-list collaboration.
- Anthropic only when you provide a Claude API key and use AI features.

Your Anthropic API key is stored locally with encrypted storage and is not intentionally synced.

## Building

This is a React Native Android app. Most app logic intentionally lives in `App.tsx`.

For release builds after JavaScript changes, force the bundle task to rerun:

```powershell
cd android
.\gradlew.bat :app:createBundleReleaseJsAndAssets --rerun-tasks :app:assembleRelease --no-daemon
```

Release signing files and Firebase config are intentionally not committed. See `scripts/prepare-github-release-secrets.ps1` for preparing GitHub Actions release secrets from local private files.

## Current Status

The current public beta is `v1.4.4` / `versionCode 20`, a polish release with recent-add shine feedback, cleaner list headers, contextual shared-list joining, and active shared-grocery AI routing. The `main` branch is intended to match the latest public APK source.
