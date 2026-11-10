# Architecture

JAVC Chatbot is a chat client for any OpenAI-compatible API. It runs on Linux and Windows (Electron), and on Android and iOS (Capacitor). **One JavaScript core and one web page are shared by every platform.** Each platform only supplies the "host" pieces: file access, key encryption, networking, sandboxed pages and a few native calls.

This file is the index. Read it, then read only the topic files that match your task. Each topic file opens with its scope and the source files it covers.

## How the pieces fit

```
                      index.html + renderer.js + lib.js     (the page, identical everywhere)
                                      |
                                 window.api                  (the seam: one method list, three implementations)
        +-----------------------------+------------------------------+
        | Desktop                     | Android                      | iOS
        | preload.js -> IPC           | mobile/main.js               | mobile/main.js
        | -> main.js                  | + mobile/native.js           | + mobile/native.js
        |                             | + JavcPlugin.java            | + JavcPlugin.swift
        +-----------------------------+------------------------------+
                                      |
            shared core, host-agnostic, host pieces are passed in
            api.js   store.js + profiles.js   chats.js   mcp.js   lib.js   disk.js (desktop io)
                                      |
                 provider API (OpenAI-compatible)  ·  Linkup search  ·  MCP servers
```

The core never imports Electron or Capacitor. It takes what it needs as arguments: `io` (files), `crypto` (key encryption), `fetchFn` (network) and `spawn` (child processes). That is how the same code runs on three hosts and under `test.js` with fakes. See [window-api.md](architecture/window-api.md).

## Topics

| Read this | When you are changing... | Source files |
| :-- | :-- | :-- |
| [window-api.md](architecture/window-api.md) | any `window.api` method, IPC channel, or what a host must provide | `preload.js`, `main.js`, `mobile/main.js` |
| [storage.md](architecture/storage.md) | settings, profiles, personas, saved chats, key encryption, on-disk formats, migrations | `store.js`, `profiles.js`, `chats.js`, `disk.js` |
| [chat-turn.md](architecture/chat-turn.md) | sending a message, streaming, Stop, Regenerate/Edit/versions, summaries, stats, web search, reasoning | `renderer.js`, `api.js`, `lib.js` |
| [rich-replies.md](architecture/rich-replies.md) | Markdown/HTML/CSS/JS replies, the sandboxed iframes, their CSP | `lib.js`, `renderer.js`, `main.js`, native plugins |
| [mcp.md](architecture/mcp.md) | MCP servers, tool approval, OAuth sign-in | `mcp.js`, `store.js` |
| [desktop.md](architecture/desktop.md) | the Electron main process, windows, packaging for Linux and Windows | `main.js`, `preload.js`, `package.json` |
| [mobile.md](architecture/mobile.md) | the Android or iOS app, the Capacitor bundle, native plugins | `mobile/`, `android/`, `ios/` |
| [build-ci.md](architecture/build-ci.md) | npm scripts, versions, GitHub Actions, releases, tests, lint | `package.json`, `.github/workflows/`, `test.js`, `mobile/smoke/` |
| [page-look.md](architecture/page-look.md) | styling, the glass layers, the header and composer layout, accent colors and the Gradient switch | `index.html` (`<style>`), `renderer.js` (`applyTheme`) |
| [security.md](architecture/security.md) | anything that touches keys, untrusted content, permissions or the bridge | everything above |

## Repository map

| Path | What it is |
| :-- | :-- |
| `index.html`, `renderer.js` | The page: markup and all UI logic (one classic script, no framework). |
| `lib.js` | Pure helpers shared by the page and Node (UMD, global `Lib`): prompts, rich-reply pages, versions, summaries, stats, themes. |
| `api.js` | OpenAI-compatible client: model list, streaming, tool rounds, Linkup search. |
| `store.js`, `profiles.js` | Settings: profiles, personas, search, MCP, display options, key encryption. |
| `chats.js` | Saved chats: one file per chat plus an index. |
| `disk.js` | Desktop file access (`makeDisk`) and the one-time move from the old app folder. |
| `mcp.js` | MCP client: config parsing, stdio and HTTP transports, OAuth, tool approval. |
| `main.js`, `preload.js` | Electron main process and its bridge to the page. |
| `mobile/` | Capacitor entry point (`main.js`), adapters (`native.js`), bundle script (`build.mjs`), Android and iOS build helpers, smoke tests. |
| `android/`, `ios/` | The native projects and their `JavcPlugin`. |
| `capacitor.config.json` | Capacitor settings (app id, `webDir: www`). |
| `test.js` | Unit tests (`node --test`), run with fakes for every host piece. |
| `globals.d.ts`, `tsconfig.json`, `eslint.config.mjs` | Lint and type check (JSDoc types, `checkJs`, not strict). |
| `build/` | Icon sources and the scripts that make the icons. |
| `docs/` | This documentation, and the README screenshot. |
| `www/` | Generated by `mobile/build.mjs`; not committed. |

## Keeping these docs current

A change that adds or alters a feature, module, `window.api` method, IPC channel, platform behavior, storage format or build/CI step must update the matching topic file in the same change. If you add a topic, add a row to the table above.
