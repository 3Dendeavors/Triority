<!-- ============================================================
  🎬 VIDEO — FEATURE DEMO (30 seconds)
  ROSS: open this README in the GitHub WEB editor, delete the
  single blockquote line between these markers, and drag-drop:
  E:\Creative\Triority\marketing\triority-demos\out\triority-hero-30s.mp4
  GitHub uploads it to user-attachments and the bare URL renders
  as a native video player. Do NOT wrap the URL in a link.
============================================================ -->
> 🎬 **Video coming shortly — 30-second feature demo.**
<!-- ====================== END VIDEO ====================== -->

<p align="center">
  <img src="assets/logo.png" alt="Triority logo" width="96">
</p>

# Triority

**Intuitive to-do list with a three-tier priority queue and cloud sync.**

<p align="center">
  <a href="https://github.com/3Dendeavors/Triority/releases/latest">
    <img src="https://img.shields.io/github/v/release/3Dendeavors/Triority?style=for-the-badge&label=DOWNLOAD%20APK&logo=android&logoColor=white&color=5b9eff" alt="Download the latest Triority APK">
  </a>
  &nbsp;
  <a href="https://buymeacoffee.com/3DEndeavors">
    <img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-support-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black" alt="Support Triority on Buy Me a Coffee">
  </a>
</p>

Long flat to-do lists hide what actually matters. Triority ranks everything you capture into **High, Medium, and Low** — across as many lists as you need — so the next action is always obvious. AI sorting, shared household lists, and optional Google sync are built in.

Triority is free and distributed as a signed Android APK through GitHub Releases. It is not currently on the Play Store, so installation is a normal Android sideload.

## Features

- **AI Sort** — dump everything in one line; the included tester AI (or your own Gemini or Claude Sonnet key) splits it into ranked tasks and grocery items, aware of your current lists, Personal Context, and workspace.
- **Shared Lists** — household-style task lists and one shared grocery page through optional sign-in and invite codes.
- **Grocery List Separation** — groceries and materials live in their own lane with category sorting, Got It, recipe/project quantities, and duplicate protection.
- **Three-Tier Priority Queue** — High / Medium / Low across multiple task lists, with drag reorder, archive/restore, reminders, and new-row focus shine.

Also includes: Android launcher widgets for voice capture and Next Up previews, local and shared reminders that alert only where each user allows notifications, optional read-only Google Calendar conflict checks, themes and accent colors, and AI capitalization that keeps sensible display casing without drifting into all-caps.

<p align="center">
  <img src="assets/landing%20page.jpg" alt="Triority landing page with High, Medium, and Low tiers" width="220">
  &nbsp;
  <img src="assets/setting%20page.jpg" alt="Triority settings page" width="220">
  &nbsp;
  <img src="assets/archive%20page.jpg" alt="Triority archive page" width="220">
</p>

## Install

Sideloading is normal for Triority: enable installs from unknown sources in **Settings → Apps** when Android asks.

The current public beta APK is published on GitHub Releases:

- Latest release: https://github.com/3Dendeavors/Triority/releases/latest
- Current beta: `v1.4.21`
- Android package id: `com.triority`
- Current APK: `Triority-v1.4.21.apk`
- SHA-256: `82AB8C080703493E05C0D9C8230A3D58B14DDFEF66259D94CE1F2B68B74D33B2`

To install:

1. Open the latest release page on your Android device.
2. Under **Assets**, download `Triority-v1.4.21.apk`.
3. If Android asks, allow your browser or file manager to install unknown apps.
4. Open the downloaded APK and tap **Install**.
5. Launch Triority from your app drawer.

Use the APK asset for installs. The source-code `.zip` and `.tar.gz` files attached to GitHub tags are for developers and will not install the Android app.

Installed builds check this repo's `latest.json` and prompt when a newer APK is available. Installing a newer signed APK over the old one should preserve local app data as long as the package id and signing key match.

## Privacy

Triority is intended to have no analytics and no telemetry.

Network calls are limited to:

- Firebase for optional Google sign-in, sync, and legacy shared lists.
- Supabase for current shared-list collaboration.
- Google Calendar free/busy checks only when you enable calendar conflict checks.
- Triority's included AI endpoint or the selected AI provider only when you use AI features.
- GitHub for update checks.
- Buy Me a Coffee only when you tap the support link.

Google handles sign-in. Triority does not receive your Google password. If you use your own AI provider key, it is stored locally with encrypted storage, is remembered per Google account on the same phone, and is not intentionally synced to the cloud.

Full policy: [PRIVACY.md](PRIVACY.md)

## Building

This is a React Native Android app. Most app logic intentionally lives in `App.tsx`.

For local release builds after JavaScript changes, then installing over an attached Android device without wiping app data:

```powershell
npm run android:release
npm run android:install-release
```

Release signing files and Firebase config are intentionally not committed. See `scripts/prepare-github-release-secrets.ps1` for preparing GitHub Actions release secrets from local private files.

## Support

Triority is free. If it earns a spot on your home screen, you can [buy me a coffee](https://buymeacoffee.com/3DEndeavors).

Check my other works on my website! https://3dendeavors.com/

## Documentation Map

Public/user-facing docs:

- [README.md](README.md): public overview, install path, setup notes, and doc map.
- [PRIVACY.md](PRIVACY.md): public privacy policy.
- [CHANGELOG.md](CHANGELOG.md): release notes.

Maintainer notes and operational docs are kept in the local workspace and are not part of the public install surface.
