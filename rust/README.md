# JAVC Chatbot (Rust)

The Rust + Slint rewrite of JAVC Chatbot (Linux, Windows, Android). It lives next to
the Electron app in this repository until it replaces it. It uses the same data
folders as the Electron app — Linux `~/.config/javc-chatbot`, Windows
`%APPDATA%\javc-chatbot` — so settings and chats carry over. Saved API keys must be
typed again once; Electron's encryption can't be read. The Android app installs over
the Capacitor one (same package and signing key) and keeps its chats and saved keys.

## Build and run

Rust stable, edition 2024. On Debian/Ubuntu install:

    sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libdbus-1-dev libfontconfig1-dev

On Fedora: `webkit2gtk4.1-devel gtk3-devel dbus-devel fontconfig-devel`.

Run from this directory with `cargo run`. Tests: `cargo test`.

## Android

`android/` is the Gradle project: `MainActivity` (a NativeActivity that hosts the
Slint window and does what needs the Android framework: Keystore, clipboard, file
picker, links) and `RichActivity` (the preview WebView). Gradle builds the Rust
library with cargo-ndk for arm64-v8a and x86_64 before packaging.

Needs JDK 17+, the Android SDK with platform 36 and NDK 28 (`ANDROID_HOME`,
`ANDROID_NDK_HOME`), `cargo install cargo-ndk` and
`rustup target add aarch64-linux-android x86_64-linux-android`. Then:

    cd rust/android && ./gradlew assembleDebug    # or assembleRelease

Release signing uses the same `ANDROID_KEYSTORE_*` variables as the Capacitor build.

## Self-test

Debug builds have a self-test that drives the real UI against a mock API server.
It prints `SELFTEST PASS` or `SELFTEST FAIL: <reason>` and exits 0 or 1.

1. Start the mock server: `node rust/selftest/serve.mjs` (listens on
   127.0.0.1:18765, using the mock in `mobile/smoke/mock-api.mjs`).
2. Point `XDG_CONFIG_HOME` at a folder containing
   `javc-chatbot/settings.json` — copy it from `rust/selftest/settings.json`.
3. Run the app with `JAVC_SELFTEST=1`:

       XDG_CONFIG_HOME=/tmp/selftest JAVC_SELFTEST=1 cargo run

`JAVC_SELFTEST_FILES=a:b` attaches extra files to the test message. On a headless
machine, wrap the run in `xvfb-run -a` (what CI does).

Variants:

- `JAVC_SELFTEST=hold` — runs the test, then keeps the window open and tours the
  panels after passing.
- `JAVC_SELFTEST=tour` — only tours the panels; changes nothing, safe on real data.

On Android, with an emulator running and a debug APK built:

    rust/selftest/android.sh rust/android/app/build/outputs/apk/debug/app-debug.apk

It starts the mock, points the app's profile at it, runs the self-test (launch
extra `--es selftest 1`, result in `adb logcat -s javc`) and checks the back button.

Debug builds only. Warning: the self-test saves a test API key into the profile it
uses — don't point it at your real settings.

## Layout

- `src/core/` — settings, profiles, chats, API client. No UI.
- `src/markdown.rs` — reply rendering into blocks.
- `src/attach.rs` — attachments.
- `src/crypto.rs` — key encryption via the OS keyring.
- `src/app.rs` — the UI controller.
- `src/preview.rs` — the sandboxed HTML preview window, a separate process started
  with `--preview`.
- `src/platform.rs` — desktop vs Android; `src/android.rs` — the Android side, over JNI.
- `ui/*.slint` — the UI.

## Packaging

From `rust/`:

    cargo packager --release --formats appimage,deb    # Linux
    cargo packager --release --formats nsis            # Windows

RPM, also from `rust/`:

    cargo generate-rpm -o ../dist

CI does all of this in `.github/workflows/rust.yml`.

## Known limits

- Reply text can't be selected with the mouse; use the Copy buttons.
- Dragging files onto the window doesn't work on native Wayland. Use the attach
  button; it works under X11/XWayland and on Windows.
- On Linux the preview sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` to avoid a blank
  page on some GPUs.
