# Mobile: Android and iOS

**Scope:** the Capacitor shell, how the page is bundled for phones, the adapters in `mobile/native.js`, and the two native plugins.
**Source:** `mobile/main.js`, `mobile/native.js`, `mobile/build.mjs`, `capacitor.config.json`, `android/` (`JavcPlugin.java`, `MainActivity.java`, `AndroidManifest.xml`), `ios/App/App/` (`JavcPlugin.swift`, `MainViewController.swift`, `SceneDelegate.swift`, `Info.plist`). Build and CI are in [build-ci.md](build-ci.md).

## Shape

Both phone apps are a Capacitor 8 shell (`appId` `io.github.thedwz.javcchatbot`, `webDir: www`, no `server` block) around the same page as the desktop. Only `window.api` differs: `mobile/main.js` builds it inside the page from the shared core plus a native plugin called `Javc`. There is no Node, so everything the core needs from the host arrives through the plugin (see [window-api.md](window-api.md)).

## The bundle (`mobile/build.mjs`)

Recreates `www/` (not committed): bundles `mobile/main.js` to `www/mobile.js` with esbuild (IIFE, target `chrome123` and `safari17.5`); copies `renderer.js` and `lib.js` unchanged; copies `marked.umd.js`, `pdf-parse.es.js` and `pdf.worker.mjs` into `www/vendor/`; and rewrites `index.html` with three exact-match `swap()` calls (the sandbox `frame-src`, the marked script path, and a `mobile.js` script tag before `renderer.js`). **`swap()` throws if its target text is missing**, so editing those lines of `index.html` breaks the build on purpose. `--selftest` also bundles `mobile/smoke/ios-selftest.mjs`; release builds never include it. `cap sync` then copies `www/` into the native projects.

## Adapters (`mobile/native.js`)

The plugin is passed in, so `test.js` runs all of this with a fake.

- **`makeNativeFetch(plugin)`** gives `api.js` and `mcp.js` a `fetch`: `httpStart` resolves with `{status, headers}`, then the body arrives as `http` events (`data` as base64, `end`, `error`) feeding a `ReadableStream` inside a real `Response`. Aborts call `httpAbort`. No CORS applies, and `http://` works for local servers. Statuses 204, 205 and 304 get no body.
- **`makeNativeDisk(plugin, dir)`** maps `io` to `fsRead`, `fsWrite`, `fsRemove`, `fsList`, `fsRename`, and rejects names with a slash, `.` or `..`.
- **`makeNativeCrypto(plugin)`** maps `crypto` to `cryptoAvailable`, `encrypt`, `decrypt`. `available()` does one real round trip and caches it; if it fails, `store.js` keeps keys as `keyPlain` in the private file.

## `mobile/main.js`

Builds `window.api` (same names as `preload.js`), plus: PDF extraction in the page with `pdf-parse`'s browser build, loaded on first use; `copyText` through the plugin; the OAuth redirect (`io.github.thedwz.javcchatbot:/oauth`, received as `appUrlOpen`); MCP with `fetchFn: nativeFetch` and no `spawn`; and the Back button (`closeTopLayer()` closes the top dialog, otherwise the app is minimized).

## The plugin contract

Both plugins implement the same 14 methods with the same arguments and results: `httpStart`, `httpAbort`, `fsRead`, `fsWrite`, `fsRemove`, `fsList`, `fsRename`, `cryptoAvailable`, `encrypt`, `decrypt`, `sandboxCreate`, `copyText`, `openUrl`, `saveFile`. `saveFile({name, mime, data})` shows the system's save screen for a chat export and resolves `{saved}` (false if cancelled): Android uses `ACTION_CREATE_DOCUMENT` and writes off the main thread; iOS writes a temporary file (complete file protection), presents `UIDocumentPickerViewController(forExporting:asCopy:)` and removes the file when the screen closes. Keep them in step when one changes. Ciphertext is `base64(nonce | ciphertext | tag)` with AES-256-GCM on both.

## Android (`android/app/src/main/java/io/github/thedwz/javcchatbot/`)

- **`JavcPlugin.java`:** HTTP through `HttpURLConnection` on a thread pool (http and https only; 30 s connect, 300 s read; events posted on the main thread to keep order). Files under `getFilesDir()` with path canonicalization; writes go temp file, fsync, rename. Keys: an AES-256-GCM key (alias `javc-api-keys`) in the Android Keystore, never exported; the layout is `base64(12-byte IV | ciphertext+tag)`. Sandbox pages: see [rich-replies.md](rich-replies.md). `copyText` uses `ClipboardManager`; `openUrl` allows http(s) only.
- **`MainActivity.java`:** refuses to start unless the web view supports `WEB_MESSAGE_LISTENER` and is version 123 or newer (the page needs CSS `light-dark()` and `field-sizing`), and shows an update dialog instead. Without that feature Capacitor's bridge would be reachable from every frame, including sandboxed model HTML. It also intercepts the sandbox host, and its Chrome client denies every permission request and geolocation.
- **Manifest and Gradle:** `allowBackup=false`, cleartext allowed (for local servers), `singleTask`, the OAuth intent filter; minSdk 26, compile and target SDK 36. `app/build.gradle` reads the version from `package.json` (see [build-ci.md](build-ci.md)); release signing comes from environment variables, falling back to the debug key when there is no keystore.

## iOS (`ios/App/App/`)

- **`JavcPlugin.swift`:** HTTP through one ephemeral `URLSession` (no cache or cookies; 300 s timeout; a serial delegate queue keeps events ordered). Files in `Application Support/javc`, excluded from backup. Keys: a random 256-bit key in the Keychain (service `io.github.thedwz.javcchatbot`, account `javc-api-keys`, `AfterFirstUnlockThisDeviceOnly`), AES-GCM with CryptoKit. The key belongs to the signer, so re-signing with a different Apple ID makes the app ask for API keys again. `SandboxDocs` holds the sandbox pages.
- **`MainViewController.swift`:** registers the sandbox scheme handler, then replaces Capacitor's `bridge` script message handler with **`MainFrameOnly`**, which drops messages from any frame but the main one (iOS's equivalent of the Android gate). **`PermissionGuard`** wraps the UI delegate and denies media capture and device motion.
- **Other:** `SceneDelegate` creates the window and forwards `openURLContexts` to Capacitor for OAuth. `Info.plist` allows arbitrary loads (local servers), has the local-network usage text and the OAuth URL scheme, and takes its versions from build settings. The deployment target is iOS 17.5 (`project.pbxproj`).

## Platform comparison

| Concern | Desktop | Android | iOS |
| :-- | :-- | :-- | :-- |
| `window.api` | `preload.js` + IPC | `mobile/main.js` | `mobile/main.js` |
| Network | Node `fetch` | `HttpURLConnection` | `URLSession` |
| Files | `disk.js` | `getFilesDir()` | Application Support |
| Key encryption | `safeStorage` | Keystore AES-GCM | Keychain-held AES-GCM key |
| Sandbox URL | `chatbot-sandbox:` | `javc-sandbox.invalid` | `javc-sandbox:` |
| Bridge protection | context isolation | `WEB_MESSAGE_LISTENER` gate | `MainFrameOnly` |
| Permissions | handlers deny | Chrome client denies | `PermissionGuard` denies |
| Local MCP servers | yes | no | no |
| OAuth return | loopback server | intent filter | URL scheme |

## Quirks

- `mobile/main.js` starts with a comment calling it the "Android entry point", but it serves iOS too.
- `ios/App/CapApp-SPM/Package.swift` declares `.iOS(.v15)`, while the Xcode target is 17.5.
- `MARKETING_VERSION 1.0` and build `1` in `project.pbxproj` are placeholders; only `mobile/ipa.mjs` sets real values.
