# The `window.api` seam

**Scope:** how the shared page talks to each platform, and what a platform must provide.
**Source:** `preload.js`, `main.js` (desktop); `mobile/main.js`, `mobile/native.js` (Android and iOS); `globals.d.ts` (the page's view of it).

## The idea

The page (`renderer.js`) never touches Electron, Capacitor or the file system. It calls `window.api`. Each platform builds that object differently, with the same method names, arguments and results:

- **Desktop:** `preload.js` exposes `window.api` with `contextBridge`; every method is an `ipcRenderer.invoke` to a handler in `main.js`. The core modules run in the main process.
- **Android and iOS:** `mobile/main.js` builds `window.api` inside the page. The core modules run in the web view, on top of a native plugin named `Javc` (`mobile/native.js` wraps it). `mobile/main.js` serves both phones despite its header comment saying "Android".

## Methods

| Group | Methods | Desktop IPC channel |
| :-- | :-- | :-- |
| Settings | `getSettings`, `patchSettings` | `settings:get`, `settings:patch` |
| Profiles | `saveProfile`, `deleteProfile`, `activateProfile`, `getProfileKey`, `listModels` | `profiles:save`, `profiles:delete`, `profiles:activate`, `profiles:key`, `models:list` |
| Personas | `savePersona`, `deletePersona` | `personas:save`, `personas:delete` |
| Search | `saveSearch`, `getSearchKey` | `search:save`, `search:key` |
| Chat | `chat(messages, onDelta, opts)`, `stopChat` | `chat:send` (+ `chat:delta` events), `chat:abort` |
| History | `listChats`, `loadChat`, `saveChat`, `deleteChat`, `chatsStatus` | `chats:list`, `chats:load`, `chats:save`, `chats:delete`, `chats:status` |
| Files | `extractPdf` | `pdf:extract` |
| Clipboard | `copyText` | `clipboard:write` |
| Rich replies | `createSandbox(html, color, scheme, flags)` | `sandbox:create` |
| MCP | `getMcpConfig`, `saveMcp`, `mcpStatus`, `reloadMcp`, `mcpSignIn`, `mcpSignOut`, `onToolApproval(fn)` | `mcp:config`, `mcp:save`, `mcp:status`, `mcp:reload`, `mcp:signin`, `mcp:signout`, `mcp:answer` (+ `mcp:approve` events) |

`preload.js` and `mobile/main.js` must stay identical in method names. `globals.d.ts` types `window.api` as `any`, so the type check will not catch a missing method; compare the two files by hand when adding one.

Behavior to know about:

- **One reply at a time.** `chat` keeps the running request in a single variable (`currentId` in `preload.js`, `current` in `mobile/main.js`); `stopChat` aborts it. The page disables everything else while a reply runs.
- **Streaming.** `onDelta` gets `{reasoning, content}` pieces (and `note: true` for the app's own status text such as "Searching the web"). On desktop, deltas travel as `chat:delta` events tagged with the request id; on phones they are direct callbacks.
- **Tool approval.** `onToolApproval(fn)` registers the page's dialog. `fn({server, tool, args})` must resolve to `'once'`, `'always'` or `'deny'`; anything else, or an error, counts as `'deny'`. Until a page registers, the answer is deny.
- **Secrets.** `getSettings` returns `publicView` (no keys, only `hasKey`). Keys come back only through `getProfileKey`, `getSearchKey` and `getMcpConfig`, to fill edit forms.
- **Notices.** `getSettings` adds a one-time `notice` (for example "your settings file was damaged").

## What a host provides

The core is written against small interfaces, passed in by whoever builds it:

| Piece | Interface | Desktop | Android / iOS | Tests |
| :-- | :-- | :-- | :-- | :-- |
| Files | `io`: `read`, `write`, `remove`, `list`, `rename` (flat names, `null` for a missing file) | `makeDisk` in `disk.js` | `makeNativeDisk` in `mobile/native.js` | in-memory fakes |
| Key encryption | `crypto`: `available()`, `enc(text)`, `dec(data)`; may be async. Wraps API keys and the chat key (`seal.js`) | Electron `safeStorage` | `makeNativeCrypto` (Keystore / Keychain) | fakes |
| Network | `fetchFn(url, opts)` returning a `Response` | Node's global `fetch` | `makeNativeFetch` (no CORS, `http://` allowed) | fakes |
| Child processes | `spawn(command, args, env)` | `main.js` (login-shell PATH, process group) | none; local MCP servers report "desktop-only" | fakes |
| MCP tokens | `auth.get(name)`, `auth.save(name, tokens)` | `store.mcpTokens`, `store.saveMcpTokens` | same | fakes |

`store.js` and `chats.js` take `{io, crypto}` / `io`; `api.js` takes `fetchFn` as an argument; `mcp.js` takes `makeHub({spawn, fetchFn, auth})`.

## Adding a `window.api` method

1. Implement the logic in a shared module if it is not host-specific, with a test in `test.js`.
2. Desktop: add an `ipcMain.handle` in `main.js` and a line in `preload.js`.
3. Phones: add the method in `mobile/main.js`. If it needs native code, add it to `mobile/native.js`, `JavcPlugin.java` and `JavcPlugin.swift` with the same name, arguments and result.
4. Call it from `renderer.js`. Update this file and the table above.
