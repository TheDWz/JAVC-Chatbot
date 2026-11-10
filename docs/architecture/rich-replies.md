# Rich replies and the sandbox

**Scope:** how a model's Markdown, HTML, CSS and JavaScript become something on screen, and how untrusted HTML is kept away from the app.
**Source:** `renderer.js` (`render`, `richFrame`, `loadFrame`, `expandRich`), `lib.js` (`splitRich`, `richDoc`, `RICH_MAX`), `main.js` (`sandbox:create`, `chatbot-sandbox`), `mobile/main.js` (`createSandbox`), `JavcPlugin.java`, `JavcPlugin.swift`, `MainViewController.swift`, `mobile/build.mjs`.

## Rendering

- `render(bubble, text)` calls `Lib.splitRich` to separate Markdown from HTML blocks (an HTML block starts at the beginning of a line and isn't inside a code fence). Markdown becomes DOM from `marked.lexer` tokens (`mdBlocks`, `mdInline`). **It never uses `innerHTML`.** Only `http(s)` and `mailto` links are allowed, remote images become links, and a small whitelist of inline tags is kept.
- The Replies switches (`state.render`: `markdown`, `html`, `css`, `js`) decide what is rendered. With HTML off, blocks show as code (fenced html/svg code gets a Preview button). `Lib.renderHint` tells the model only about the formats that are on.
- An HTML block becomes `richFrame(html)`: an `<iframe sandbox="allow-scripts">` with **no** `allow-same-origin`, so the frame has an opaque origin and can't reach the app. `expandRich` shows the same content in a full-window overlay.

## The sandbox page

1. `loadFrame` calls `window.api.createSandbox(html, color, scheme, {css, js})`, passing the reply's text color and the app's light or dark scheme.
2. The host calls `Lib.richDoc` (the same code everywhere), which returns `{doc, csp}`: the model's HTML wrapped in a page with a small script that reports its height, plus a Content-Security-Policy string.
3. The host stores the page and returns a URL; the frame loads it. The page is served with `csp` as its CSP header, so the policy comes from the server side of the frame, not from the model's HTML.
4. The frame posts `{richHeight}` to the page; `renderer.js` matches `e.source` to a `.rich iframe` and sets its height, capped at 4000 px.

`richDoc` CSP rules: always `sandbox allow-scripts`. With CSS off, `style-src` allows only the app's own `<style>` by hash. With JavaScript off, `script-src` allows only the app's resize script by hash, and `frame-src` and `object-src` are `'none'` (a remote child document wouldn't be covered by `script-src` and could run its own scripts). Hashes, not nonces, so a script can't read the value back. Known limit: with CSS off but JS on, scripts can still set `element.style` (CSSOM isn't covered by CSP). `safeColor` validates the color so it can't break out of the style tag.

Size limit: `Lib.RICH_MAX` (2,000,000 characters); hosts reject larger input.

## Per platform

| | Desktop | Android | iOS |
| :-- | :-- | :-- | :-- |
| URL | `chatbot-sandbox://doc/<id>` | `https://javc-sandbox.invalid/doc/<id>` | `javc-sandbox://doc/<id>` |
| Who serves it | `protocol.handle` in `main.js` | `MainActivity`'s web view client intercepts the host; `JavcPlugin.serveSandbox` returns the doc | `SandboxSchemeHandler` in `MainViewController.swift` |
| Store | `richDocs` Map | `LinkedHashMap` in `JavcPlugin.java` | `SandboxDocs` in `JavcPlugin.swift` |
| Eviction | least recently used, 300 pages | same | same |

- **Ids** are the SHA-256 of `csp + "\n" + doc`, so re-rendering the same page reuses it instead of filling the store with copies; showing a page counts as using it.
- The desktop scheme is registered privileged (`standard`, `secure`, `supportFetchAPI`). Being a non-local scheme, its documents don't inherit the app's CSP.
- The Android and iOS plugins validate that the CSP starts with `sandbox allow-scripts` and cap the page size.
- `mobile/build.mjs` rewrites the page's CSP `frame-src` from `chatbot-sandbox:` to `https://javc-sandbox.invalid javc-sandbox:` for the phone bundle. The host name in `build.mjs` must match `SANDBOX_HOST` in `JavcPlugin.java`.
- The page's own CSP (`index.html`) is `default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; frame-src chatbot-sandbox:`. There is no `connect-src`, so the page can only talk to itself; all network traffic goes through the host.

Frames have internet access on purpose, so CDN libraries work in charts and demos.

## Changing it

If you change what `richDoc` returns or how the CSP is built, change nothing else per platform: all three hosts serve whatever `{doc, csp}` they are given. If you add a field to `createSandbox`, update `preload.js`, `main.js`, `mobile/main.js` and both plugins (see [window-api.md](window-api.md)).
