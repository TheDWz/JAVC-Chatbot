# Security model

**Scope:** what is trusted, what is not, and the controls that separate them. Read this before touching keys, permissions, the sandbox or the native bridge.
**Source:** every other topic; the controls live in `main.js`, `lib.js`, `store.js`, `mcp.js`, `mobile/*` and both native plugins.

## What is untrusted

- **Model output**, including its HTML, CSS and JavaScript (see [rich-replies.md](rich-replies.md)).
- **MCP servers and their results**, local or remote (see [mcp.md](mcp.md)).
- **Provider and sign-in servers' responses**, and anything fetched from them.

The user, the app's own page and the provider they configured are trusted.

## Controls

| Risk | Control |
| :-- | :-- |
| A reply's HTML reads or changes the app | Replies render as DOM, never `innerHTML`. Rich HTML runs in an iframe with `sandbox="allow-scripts"` and no `allow-same-origin`, served from a separate scheme or host with its own CSP header. |
| A rich frame calls the native bridge (phones) | Android refuses to start without `WEB_MESSAGE_LISTENER` (web view 123+); iOS replaces Capacitor's message handler with `MainFrameOnly`, which drops non-main-frame messages. The iOS self-test checks this (run by hand on a Mac; CI no longer runs it). |
| Rich content uses camera, microphone, location, notifications | Desktop permission handlers always deny; Android's Chrome client and iOS's `PermissionGuard` deny. |
| The page makes network calls or loads remote script | The page CSP is `default-src 'self'; script-src 'self'; img-src data:; frame-src` for the sandbox scheme only. All network goes through the host. |
| Links navigate the app away | Desktop: new windows denied, `will-navigate` blocked, only `http(s)` and `mailto` open externally. Plugins' `openUrl` allow http(s) only. |
| API keys leak | The page gets `publicView` (no keys). Keys are encrypted at rest (`safeStorage`, Android Keystore, iOS Keychain key); decrypted only in the host to make a request. Without a keyring they are stored plaintext in an owner-only file. Android sets `allowBackup=false`; iOS excludes the data from backup. |
| Others read saved chats | Every chat file and the index are AES-256-GCM encrypted (`seal.js`) with a key wrapped by the platform keyring. Android and iOS: the files are also private to the app, and the key never leaves the device. Desktop: stops other OS users, copies of the disk, backups and indexers, but not programs running as the same user, which the OS keyring (DPAPI, Secret Service, KWallet) will also serve. With no keyring (Linux `basic_text`), the key is stored unprotected and Settings → Chats says so. An export is outside this encryption unless it's protected with a passphrase (PBKDF2-SHA256, 600,000 rounds, AES-256-GCM); Settings says so. Imports validate every chat id before anything is saved. |
| A tool runs without consent | Every MCP tool call asks first (deny, once, always). Changing a server's entry drops its "always" list and tokens. A reply refuses a call to a server changed since it started. |
| MCP sign-in is hijacked | PKCE (S256), `state`, issuer check, the `resource` parameter, https-only endpoints, tokens stored encrypted per server. |
| A local MCP server outlives the app | Servers are stopped on quit, in their own process group on POSIX. |
| A damaged file loses data | Atomic fsync'd writes; a damaged settings file is quarantined, not overwritten; chat list repair. |
| Path tricks in storage | Flat names only; chat ids match `^[a-z0-9-]+$`; native file paths are canonicalized under the app folder. |
| Huge input | Rich pages capped at 2,000,000 characters; MCP output capped (32 MB per message from a server, 20,000 characters to the model); attachments limited in count and size. |

## Deliberately not covered (know the limits)

- **IPC handlers don't check which frame sent the call.** That is acceptable because the window only ever loads the app's own page; keep it that way.
- **The page can read secrets it needs for forms:** `getProfileKey`, `getSearchKey` and `getMcpConfig` return stored values to the page.
- **Rich frames can reach the internet** (so CDN libraries work). With CSS off but JS on, scripts can still style elements through the DOM.
- **A model or MCP server can still ask for tools** the user then approves; approval is the boundary, not a sandbox around the tool.
- **No-keyring fallback is plaintext** in the user's private files.
- The Windows installer and the iOS `.ipa` are unsigned; the Android APK is signed with a key kept outside the repo.

## When you change something here

New native method, new permission, new scheme, new place secrets travel: update the controls table, and add a smoke or unit test if one is possible (`mobile/smoke/*`, `test.js`).
