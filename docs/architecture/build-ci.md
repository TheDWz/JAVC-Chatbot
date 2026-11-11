# Build, versions, CI, releases and tests

**Scope:** how the apps are built, how the version flows, what GitHub Actions does, how a release is made, and how things are tested.
**Source:** `package.json`, `mobile/build.mjs`, `mobile/gradle.mjs`, `mobile/ipa.mjs`, `android/app/build.gradle`, `.github/workflows/build.yml` and `check.yml`, `test.js`, `mobile/smoke/*`, `eslint.config.mjs`, `tsconfig.json`.

## npm scripts

| Script | Does |
| :-- | :-- |
| `start` | `electron .` |
| `test` | `node --test test.js` |
| `lint` / `typecheck` | `eslint .` / `tsc -p .` |
| `dist:linux`, `dist:win`, `dist` | `electron-builder` for desktop (see [desktop.md](desktop.md)); `dist` is desktop only |
| `build:mobile` | `mobile/build.mjs` (makes `www/`, see [mobile.md](mobile.md)) |
| `android:sync` / `ios:sync` | `build:mobile`, then `cap sync android` / `cap sync ios` |
| `dist:android`, `dist:android:debug` | `android:sync`, then `mobile/gradle.mjs assembleRelease` / `assembleDebug` |
| `dist:ios` | `ios:sync`, then `mobile/ipa.mjs` |

Output goes to `dist/`: `JAVC-Chatbot-<version>[-debug].apk` (copied by `gradle.mjs`) and `JAVC-Chatbot-<version>.ipa` (`ipa.mjs`).

## Version flow

`package.json` `version` is the single source.

- **Desktop:** `electron-builder` uses it for artifact names.
- **Android:** `app/build.gradle` reads `../package.json`: `versionName` is the string, `versionCode = major*10000 + minor*100 + patch` (1.2.3 gives 10203). Android only installs an update with a higher code.
- **iOS:** `mobile/ipa.mjs` passes `MARKETING_VERSION=major.minor.patch` and `CURRENT_PROJECT_VERSION` equal to Android's `versionCode` to `xcodebuild`. Builds run straight from Xcode keep the placeholders in `project.pbxproj`.
- Pre-release suffixes are dropped for the numeric values.

## `mobile/ipa.mjs`

macOS only. The default build is Release for `iphoneos` with signing off, staged as `Payload/App.app` and zipped into an **unsigned** `.ipa` for Sideloadly, AltStore and similar tools. `--simulator` builds Debug for the simulator, ad-hoc signed (the simulator's Keychain needs it), prints `APP: <path>` and writes no `.ipa`.

## GitHub Actions

**`check.yml`** (push to `main`, and pull requests): one Ubuntu job, Node 24, `npm ci`, `npm test`, `npm run lint`, `npm run typecheck`. Electron's binary download is skipped.

**`build.yml`** (tags `v*`, and manual `workflow_dispatch`): five jobs. It does **not** create a GitHub Release.

| Job | Runs on | Does | Artifacts |
| :-- | :-- | :-- | :-- |
| `build` (matrix) | Ubuntu, Windows | `npm test`, `electron-builder --publish never` (installs `rpm` on Linux) | `javc-chatbot-Linux`, `javc-chatbot-Windows` |
| `android` | Ubuntu, JDK 21 | `npm test`, decodes the signing keystore from a secret, builds the release APK and a debug APK | release APK (uploaded unzipped), `javc-chatbot-Android-debug` |
| `android-smoke` | Ubuntu with KVM | emulator (API 36, x86_64) runs `mobile/smoke/android.mjs` on the debug APK | `android-smoke` |
| `ios` | macOS | `npm test`, `npm run dist:ios` (the simulator self-test isn't run: it took about 8 minutes on top of a 3-minute build) | unsigned `.ipa` (unzipped) |

Signing secrets (names only): `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. If the keystore secret is missing, the job warns and signs with the debug key, which would not install over a real release. iOS needs no secrets.

Gaps in the config: `build.yml` doesn't run lint or typecheck (only `check.yml` does), and releases are published by hand.

## Making a release

1. Bump `package.json` and `package-lock.json` (`npm version X.Y.Z --no-git-tag-version`) and merge it to `main` through a PR.
2. Tag the merge commit `vX.Y.Z` and push the tag; wait for `build.yml`.
3. Download the artifacts. `gh run download` unpacks the APK and `.ipa` into folders, so fetch those two raw from the API instead (`gh api repos/<owner>/<repo>/actions/artifacts/<id>/zip`).
4. **Check the APK is signed with the existing release key** (`apksigner verify --print-certs`) before publishing; a different key forces users to uninstall, which deletes their chats.
5. Write `SHA256SUMS.txt` and `gh release create vX.Y.Z` with the notes and all files: `.apk`, `.ipa`, `.AppImage`, `.deb`, `.rpm`, `.tar.gz`, Windows setup `.exe`, `SHA256SUMS.txt`.

## Tests

- **`test.js`** (`node --test`) covers the shared modules with fakes for `io`, `crypto`, `fetchFn` and `spawn`: `api.js` (formats, streaming, `<think>`, the usage retry, search, MCP rounds), `disk.js`, `chats.js`, `store.js` and `profiles.js` (quarantine, keys, personas, MCP settings), `lib.js` (rich-reply splitting, `richDoc` CSP, versions, summaries, stats), `mcp.js` (parsing, a real local child server, HTTP transport, OAuth), and the `mobile/native.js` adapters. Electron, the page's DOM and the native plugins are **not** covered here.
- **`mobile/smoke/`** drives the real apps. `mock-api.mjs` is a small OpenAI-compatible server (a streamed reply with reasoning, Markdown, a rich HTML block and usage). `flow.mjs` is the shared UI flow (first run, streamed reply, rich frame isolation, chat save/load, Regenerate and Edit, stats, PDF). `android.mjs` runs it on the emulator with Playwright and also checks the stored key is encrypted and that Back backgrounds the app. Playwright can't drive an iOS web view, so `ios.mjs` boots a simulator and the app runs its own `ios-selftest.mjs` (Keychain, native fetch, sandbox, the main-frame-only bridge check, camera denial, PDF), writing a result file the script polls. CI no longer runs it; on a Mac: `node mobile/build.mjs --selftest && npx cap sync ios && node mobile/ipa.mjs --simulator`, then `node mobile/smoke/ios.mjs <the printed .app path>`.
- **Lint and types:** ESLint recommended rules (`eslint.config.mjs`; ignores `www`, `android`, `ios`, `dist`); `tsc` with `allowJs`, `checkJs`, `noEmit`, not strict (`tsconfig.json` includes `*.js`, `*.d.ts` and `mobile/**`, excludes `mobile/smoke`). Types are JSDoc.

## Adding a source file

A new top-level `.js` file loaded by `main.js` must be added to the `files` lists for Linux and Windows in `package.json` (see [desktop.md](desktop.md)). A file the page loads on phones must be bundled or copied by `mobile/build.mjs`.
