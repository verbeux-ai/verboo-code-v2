# Verboo Code desktop

English | [中文](README.zh.md)

## Development

Install Node.js, the pinned pnpm version, Rust 1.97 or newer and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). From the repository root, run:

```sh
pnpm run dev:desktop
```

The command builds the shared application, starts the client rebuild watchers and launches Tauri. Rust owns the native window and a private Node process running the product `verboo` profile. The packaged Windows application is a GUI program, so the Host console process is created with `CREATE_NO_WINDOW`; without it Windows opens a terminal beside the product window. The Host binds only `127.0.0.1` on an OS-assigned port, authenticates the WebView with its per-launch browser cookie, and retains the existing session, tool, model and plugin services. The WebView first commits the packaged startup animation on the Host origin without requesting the protected index, then exchanges the launch token from that origin so WebKit preserves the authenticated redirect with `SameSite=Strict` cookies. Native directory selection uses the Tauri dialog plugin. Native permissions are restricted to the owned window and the exact Host origin; links cannot navigate that window to another origin.

After building the repository, reuse its artifacts with:

```sh
pnpm run start:desktop
```

`pnpm run dev:desktop --skip-build` also reuses artifacts and starts the client watchers. Tauri rebuilds Rust source changes. Client changes rebuild through the same watched bundles used by Web. Closing the application requests profile disposal and waits for the Node process to exit; exceeding the shutdown deadline fails visibly instead of reporting a clean stop.

If startup fails, a local recovery window shows a safe error code and description, retry when the Host has stopped safely, and expandable checks only for recognized causes. Desktop restores sidebar layout and terminal identity from a bounded native store before mounting the client, so a new Host port does not discard them. Startup opens only the native chat window, including when a user profile enables automatic browser startup. Browser sign-in and explicitly requested external links use the system browser.

The native Close command (Command+W on macOS, Control+W on Windows) closes the focused conversation pane instead of the application window. Pressing Command+Q on macOS or Control+Q on Windows shows a localized hint; pressing the shortcut a second time within three seconds quits. Escape, losing focus, hiding the document or waiting three seconds cancels the confirmation. Holding the keys never counts as a second press. The native menu Quit action and window close button still ask for confirmation before interrupting work or disposing the Host. Cancel keeps the window and all work running; confirmation retains the bounded graceful shutdown. Repeated quit requests share one confirmation and cannot bypass Host disposal.

The development home is `apps/desktop/.desktop-build/tauri/home`; `DSH_HOME` overrides it. Generated configuration contains paths, never credentials. Build outputs and development state are gitignored.

## Native distribution

`pnpm run build:desktop` builds a Tauri application for the current host platform. It packs the workspace dependency and peer closure, preserves reviewed patches and build-script permissions, verifies the official standalone Node archive against its SHA-256, and runs real-profile smoke tests before invoking the Tauri bundler. Workspace package archives are discarded after the locked installation; only the installed dependency tree ships, so notarization never encounters unsigned copies inside build tarballs. The runtime contains no development home or model credentials. Outputs live under `apps/desktop/.desktop-build/tauri/target/release/bundle`.

Linux desktop uses the official glibc Node runtime. Staging keeps the glibc system and FFI addons and host PTY prebuild before AppImage scans ELF dependencies, preserving the static Landlock launcher. Unused musl and foreign PTY binaries are excluded only from staging; source packages remain intact.

The retained Electron installers and updater tests are legacy tools described in the [Electron reference](../README.md). Tauri runs its own updater instead of the Electron update service.

## Updates

The Tauri updater checks its feed once per launch after the Host starts, downloads an available update in the background and verifies its signature before staging it. The sidebar displays download progress, offers a retry after a failed check or download, and offers a restart after staging; restarting asks for confirmation only if work is active or its state is unknown. A staged update is verified again and installed before the Host starts on the next launch, including offline, when no other supported window is running. Supported versions coordinate through process locks; older versions that do not use these locks cannot be detected reliably. If another instance is installing, the startup window shows a waiting message and can be closed without interrupting the installation. Installation failures display an error and avoid an automatic restart loop. Development builds do not check for updates. Linux selects the AppImage, Debian package, or RPM matching the installed bundle; Windows uses the NSIS installer in `passive` mode, and macOS replaces the application bundle from the archived `.app`.

`bundle.createUpdaterArtifacts` makes the bundler emit the bundle and its signature, and the release workflow signs the RPM with the product version because its package metadata uses a normalized prerelease version. The public key in `plugins.updater.pubkey` is the only trust anchor, and the updater refuses any bundle another key signed; losing the private key means shipping installers that can never update.

The feed is `latest.json` on the `update-feed` branch rather than a release asset, because `releases/latest` never resolves to a prerelease. `verify-release.mjs` writes it from the verified manifests and `publish-feed.mjs` commits it after the release is public; a re-run of an older release cannot move the feed backwards.

## Release pipeline

The [release workflow](../../../.github/workflows/verboo-desktop-release.yml) runs when a GitHub release is published and also supports a manual first release. The tag must be `v` followed by the committed desktop version. It builds native macOS Apple Silicon and Intel DMGs and Linux x64 AppImage, Debian and RPM installers; the existing Windows x64 installer is retained. Linux builders need `musl-tools`; the workflow builds the complete host-native payload, including the Landlock launcher, before packing.

macOS uses `Verboo Code` for the executable and application display name; development embeds the same display name. Packaging verifies `CFBundleName`, `CFBundleDisplayName` and `CFBundleExecutable` before checking the signature, then uses native `hdiutil create` and `verify` to produce the DMG without mounting a writable image for Finder customization. Temporary files belong to that build and are removed after completion or failure. Release build dependencies use `strip = false` so proc-macro dylibs remain loadable on macOS 27 without changing the app's minimum system version. AppImage packaging disables the bundler's symbol stripping with `NO_STRIP`.

Every platform records the exact source SHA, installer size and SHA-256. Publication checks the complete set, resolves lightweight or annotated tags to that SHA, and confirms GitHub’s uploaded digests. An existing release is reused; matching files are skipped, missing files can be resumed, and differing published bytes are never overwritten. Manual builds publish a draft only after verification; release-triggered builds attach to the existing release. Downloads remain in GitHub Releases and checksums are included in `SHA256SUMS`.

Operator-approved publication without one or both macOS targets uses [Publish verified Verboo desktop artifacts](../../../.github/workflows/verboo-desktop-publish-existing.yml). Supply the completed desktop build run, its exact source SHA and explicit omission flags; both flags default to false. The workflow requires successful selected jobs from the trusted desktop release workflow, matching product versions, installer hashes and updater metadata before publishing. Omitted platforms have no entry in this version’s update feed.

### Apple distribution signing

Both macOS release jobs require a [Developer ID Application certificate](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/) and an [App Store Connect team API key](https://v2.tauri.app/distribute/sign/macos/#notarization) with Developer access. Configure these repository Actions secrets before releasing:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64-encoded `.p12` containing the certificate, private key and Apple intermediate certificate. |
| `APPLE_CERTIFICATE_PASSWORD` | Password protecting that `.p12`. |
| `APPLE_SIGNING_IDENTITY` | Full `Developer ID Application: Name (TEAMID)` certificate common name. |
| `APPLE_TEAM_ID` | The certificate's ten-character Apple Developer Team ID. |
| `APPLE_API_KEY` | App Store Connect team API Key ID. |
| `APPLE_API_ISSUER` | App Store Connect team API Issuer ID. |
| `APPLE_API_PRIVATE_KEY` | Complete downloaded `.p8` PEM contents. |

The credential preflight stops a macOS job before dependency installation if a secret is missing or malformed. `macos-release.mjs` materializes the certificate and API key in a private temporary directory and owns a temporary keychain until packaging and verification finish. Normal success and failure restore the previous keychain search list and remove these files; hosted runner disposal handles forced termination. Passwords and private keys never enter generated app configuration or build artifacts.

The release signs every embedded Mach-O file, including Node, native addons and helpers, with a secure timestamp and hardened runtime before Tauri signs and notarizes the enclosing application. Node's entitlements retain JIT, executable memory and third-party native library loading. Packaging requires the expected certificate and Team ID, validates the stapled app ticket and Gatekeeper acceptance, then signs, notarizes and staples the final DMG. The updater archive is extracted, verified with the same checks and exercised through its packaged Node Host. Missing tickets, rejected notarization, timeouts and signature or runtime failures stop artifact publication. Local development keeps ad-hoc signing.

The disposable hosted Intel runner routes Apple ticket requests over HTTPS using TCP because GitHub confirmed [intermittent HTTP/3 failures](https://github.com/actions/runner-images/issues/14924). Stapling, validation and Gatekeeper assessment retain their normal failure behavior and print the tool's diagnostics. A rejected app also prints `codesign --verify --verbose=4` and `syspolicy_check distribution` diagnostics when those tools are available; neither diagnostic can turn a rejected assessment into a passing one.

DMG notarization uploads once and records the submission ID before polling that exact request for up to 20 minutes. Ten-second status reads retry known transport failures up to three times within 35 seconds, honoring any exposed `Retry-After`; authentication failures and invalid responses stop immediately. A failed status read never triggers another upload.

Disk-image creation streams progress and allows 30 minutes to copy and compress the complete runtime filesystem on hosted Intel machines. The enclosing installer process has a 60-minute budget for image creation, notarization and assessment; timeouts still block publication.

For a complete CI rehearsal, dispatch the release workflow with `verify_only: true`. It retains the verified installer artifacts without publishing a release or moving the update feed.

## Validation

```sh
node --test apps/desktop/tauri/tests/bridge.test.mjs apps/desktop/tauri/tests/host.test.mjs
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

The bridge tests cover cached and asynchronous client mounting without Electron markers. The Node integration tests exercise the real profile's authenticated HTML and assets, repeated shutdown, startup failure and parent disconnection. Rust tests reject remote or malformed bootstrap URLs.

The product Client entry is required during boot, and native readiness requires the Verboo navigation to mount. A generic Harness root cannot report successful product startup. Run `node apps/desktop/tauri/product-qa.mjs` from the repository root after building for browser QA with a temporary profile and OS credential, external HTTP fixtures, OAuth PKCE, live token renewal without an onboarding flash or loss of draft, focus and running conversation, model selection, plans, connections, dialogs and both themes. `VERBOO_QA_OUTPUT` selects the screenshot directory; `VERBOO_QA_CHROME` selects a browser executable.

The browser QA exercises subscription tools through the composed conversation, including a rejected approval, a lost response, and cancellation. On Linux, set `VERBOO_QA_NATIVE_BILLING=1` to repeat the scenario in the debug Tauri build with the same loopback fixture. The native check uses Python GI and AT-SPI to enter prompts and answer the app's approval cards, then verifies that each accepted operation reached the fixture once. Wayland systems that do not deliver editor input through AT-SPI also need `ydotool` with access to the current user's input device. The runner types only while the isolated test window and composer have focus.
