# Agent Note: Desktop updates from a branch-hosted feed

Status: implemented

English | [中文](2026-11-07-tauri-desktop-updates.zh.md)

## Problem

The [Tauri carrier](2026-11-04-tauri-desktop-carrier.md) installs from GitHub Releases, and every release is published without an updater: the application reads no feed and cannot replace itself. A new version therefore reaches only users who find the release page and reinstall, and the previous release notes have to explain that restarting the application changes nothing.

The [Electron packaging decision](2026-08-25-electron-desktop-packaging-and-updates.md) documented an updater, but it belongs to the legacy carrier and its service; the Tauri application contacts neither.

## Decision

The application updates itself with the Tauri updater plugin, from a feed committed to an `update-feed` branch.

### Three platform mechanisms, one flow

The plugin requires a signature that cannot be disabled, so the bundler emits update bundles with `createUpdaterArtifacts` and signs them with `TAURI_SIGNING_PRIVATE_KEY`. The public key in `plugins.updater.pubkey` is embedded in the application and is the only trust anchor: an update signed by another key is refused. Losing the private key retires every installed application from future updates, so it is a release credential, not a build convenience.

What the updater replaces differs per platform, and so does what the feed points at. Linux and Windows reuse the installer's own bytes, because the AppImage and the NSIS setup replace the installed files directly; Windows installs in `passive` mode, which shows progress without asking again. macOS cannot swap a disk image for a running application, so the bundler archives the `.app` and the feed points at that archive. Debian and RPM installations are excluded: their files belong to the package manager, which owns updates.

### Native offer, not client UI

Rust checks the feed once per launch, after the Host serves the product, and asks with the dialog plugin the application already composes. Checking from Client code would add a permission and an interface surface for a decision the native layer owns, and the window must not report readiness differently in the meantime. Development builds never check, so a checkout cannot install a release over its own source.

A declined version is recorded beside the application's configuration, so the same update asks once rather than on every launch; a newer version asks again. Every other outcome stays silent: an unreachable feed, a malformed manifest or a refused install must not block startup or fail visibly, because the application is otherwise usable.

### The feed lives on a branch

The obvious endpoint, `releases/latest/download/latest.json`, never resolves here: `latest` selects the most recent non-prerelease, and every Verboo release is a prerelease. Publishing the feed as a release asset would therefore make it unreachable exactly when it is needed.

The feed is committed to `update-feed` instead, which resolves for any version and leaves published installer bytes untouched. `verify-release.mjs` derives it from the verified per-platform manifests, so the feed's URLs, sizes and signatures describe the same bytes the release published; `publish-feed.mjs` commits it once the release is public. A re-run of an older release cannot move the feed backwards, and an identical version is refused instead of rewritten.

## Alternatives considered

**Publish the feed as a release asset.** Unreachable for prereleases, and the installed application has no authenticated fallback.

**Host the feed on the download service.** Correct for a production channel, but the [publishing reference](../../../../apps/desktop/publishing/README.md) reserves it for operator-authorized releases with COS credentials, none of which a GitHub-only alpha has.

**Check for updates from the Client.** Adds a Client permission and a native command, and duplicates a check whose result drives a native dialog and an application restart.

**Ship a notarized macOS build first.** Notarization needs an Apple Developer identity, and the updater verifies its own signature independently of Gatekeeper. Ad-hoc signing keeps the alpha channel working; a notarized build is an addition to this decision, not a precondition.

## Consequences

An alpha installation updates itself from the next published version onward; the first release that carries the plugin cannot be installed by one that lacks it, so the transition is one manual install. Ad-hoc signed macOS builds may still be quarantined by Gatekeeper after an update, which a Developer ID and notarization would remove. Windows installers remain unsigned and may warn. The feed branch is a publication record: editing it by hand publishes a version to every installation, so it stays workflow-owned.
