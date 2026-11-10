# Desktop (Electron)

**Scope:** the Electron main process, the window, and how the Linux and Windows packages are built.
**Source:** `main.js`, `preload.js`, the `build` section of `package.json`. For the IPC list see [window-api.md](window-api.md).

## Process model

- **Main process (`main.js`)** runs the shared core: `store`, `chats`, `api`, the MCP hub. It owns the keys (decrypted only here, for a request), the files and the network. It registers one `ipcMain.handle` per `window.api` method.
- **Page** is `index.html` loaded with `win.loadFile`, with `contextIsolation: true` and `nodeIntegration: false`. `preload.js` is the only bridge (`contextBridge.exposeInMainWorld('api', ...)`).
- **Window:** 900x700, no menu (`win.setMenu(null)`), icon `build/icon.png`. The app quits when the last window closes.

## What `main.js` wires up

- **Data:** `makeDisk(app.getPath('userData'))` for settings and `makeDisk(<userData>/chats)` for chats; `safeStorage` as the `crypto`; `migrateLegacy` from the old "chatbot" app folder at startup (see [storage.md](storage.md)).
- **Chat:** `chat:send` registers an `AbortController` in `running` before any `await` (so Stop works from the first moment), loads the profile, and streams deltas back as `chat:delta` events unless the sender is gone. `chat:abort` aborts it.
- **PDF:** `pdf:extract` runs `pdf-parse` in the main process.
- **Clipboard:** `clipboard:write` exists because the deny-all permission handlers also refuse the page's clipboard write.
- **MCP:** `makeHub` with a desktop `spawn` (login-shell PATH, own process group on POSIX, `cmd` with quoting on Windows) and token storage through the store; the loopback OAuth catcher `listen`; `approver` for tool approval; `before-quit` stops the servers first, waiting at most 5 s (see [mcp.md](mcp.md)).
- **Rich replies:** the privileged `chatbot-sandbox` scheme and the `sandbox:create` handler (see [rich-replies.md](rich-replies.md)).

## Window hardening

- `setPermissionRequestHandler` and `setPermissionCheckHandler` always deny: no camera, microphone, location or notifications, for the app or for rich content.
- `setWindowOpenHandler` denies new windows and opens only `http(s)` and `mailto` links in the system browser; `will-navigate` is blocked the same way, so the window never leaves the app page.

## Packaging

`electron-builder` reads the `build` section of `package.json`:

- **Linux:** `AppImage`, `deb`, `rpm`, `tar.gz`; executable name `javc-chatbot`; app id `io.github.thedwz.javc-chatbot`.
- **Windows:** `nsis` installer, named `JAVC-Chatbot-Setup-<version>.exe`. The `dist:win` script installs the Windows build of `@napi-rs/canvas` (a `pdf-parse` dependency) before building.
- Each target has an explicit `files` list of the runtime files: `main.js`, `preload.js`, `api.js`, `chats.js`, `profiles.js`, `store.js`, `disk.js`, `lib.js`, `mcp.js`, `renderer.js`, `index.html`, `build/icon.png`. **A new top-level source file that `main.js` or the page loads must be added to both lists**, or it will be missing from the packaged app (tests and `npm start` won't show the problem).

## Platform notes

- Settings and chats live in Electron's per-app data folder (see [storage.md](storage.md)).
- Keys use `safeStorage`; on Linux without a keyring they fall back to a plaintext field in the owner-only settings file.
- The Windows installer isn't code-signed; the AppImage and tar.gz may need `--no-sandbox` where unprivileged user namespaces are restricted (see the README).
