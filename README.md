# Triority

Triority is a private-first Android task, grocery, reminder, and AI triage app. It is built around quick capture, three practical priority tiers, optional Google sync, shared household-style lists, and bring-your-own Claude API access.

The app is distributed as a signed Android APK through GitHub Releases. It is not currently distributed through the Play Store, so installation is a normal Android sideload.

## Install

The current public beta APK is published on GitHub Releases:

- Latest release: https://github.com/3Dendeavors/Triority/releases/latest
- Current beta: `v1.4.7`
- Android package id: `com.triority`
- Current APK: `Triority-v1.4.7.apk`
- SHA-256: `7F52C846ED90398DE6AA445AB7D4C92D63D10CE17D1A1834F5AD67D401A44110`

To install:

1. Open the latest release page on your Android device.
2. Under **Assets**, download `Triority-v1.4.7.apk`.
3. If Android asks, allow your browser or file manager to install unknown apps.
4. Open the downloaded APK and tap **Install**.
5. Launch Triority from your app drawer.

Use the APK asset for installs. The source-code `.zip` and `.tar.gz` files attached to GitHub tags are for developers and will not install the Android app.

Future installed builds check this repo's `latest.json` and prompt when a newer APK is available. Installing a newer signed APK over the old one should preserve local app data as long as the package id and signing key match.

## What It Does

Triority is meant for practical daily planning rather than project-management ceremony:

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

The current public beta is `v1.4.7` / `versionCode 23`, an AI and widget release with voice-first Android widgets, widget appearance controls, safer default AI list routing, and task-focus fixes. Public releases should include an APK asset before `latest.json` is updated.
