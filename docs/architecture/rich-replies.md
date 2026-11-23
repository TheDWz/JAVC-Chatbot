# Rich replies and the sandbox

**Scope:** how a model's Markdown, HTML, CSS and JavaScript become something on screen, and how untrusted HTML is kept away from the app; how a reply's attached files reach its pages.
**Source:** `renderer.js` (`render`, `richFrame`, `loadFrame`, `expandRich`), `lib.js` (`splitRich`, `richDoc`, `richFiles`, `RICH_MAX`), `main.js` (`sandbox:create`, `chatbot-sandbox`), `mobile/main.js` (`createSandbox`), `JavcPlugin.java`, `JavcPlugin.swift`, `MainViewController.swift`, `mobile/build.mjs`.

## Rendering

- `render(bubble, text, files)` calls `Lib.splitRich` to separate Markdown from HTML blocks (an HTML block starts at the beginning of a line and isn't inside a code fence). Markdown becomes DOM from `marked.lexer` tokens (`mdBlocks`, `mdInline`). **It never uses `innerHTML`.** Only `http(s)` and `mailto` links are allowed, remote images become links, and a small whitelist of inline tags is kept.
- The Replies switches (`state.render`: `markdown`, `html`, `css`, `js`) decide what is rendered. With HTML off, blocks show as code (fenced html/svg code gets a Preview button). `Lib.renderHint` tells the model only about the formats that are on.
- An HTML block becomes `richFrame(html, files)`: an `<iframe sandbox="allow-scripts">` with **no** `allow-same-origin`, so the frame has an opaque origin and can't reach the app. `expandRich` shows the same content in a full-window overlay. `files` are the reply's attachments (`m.attachments`), so the HTML can name them.
- A reply's attachments also show as a row of chips under it (`fileChip` in `renderer.js`): png/jpeg/gif/webp as thumbnails drawn from `data:` URLs (`window.api.readAttachment`; the most recently drawn 64 MB of `data:` URLs stay cached; SVG and anything else only get the Save button, since SVG can carry script). A click opens the `#filedlg` dialog with the image (if shown), the type and size, a preview of documents, and Save / Close (`window.api.saveAttachment`).
- **Previews** (`showPreview` in `renderer.js`; `Lib.previewKind` picks by type, then extension), drawn from the real file into `#filepreview`, for any attached file, created or not:
  - **PDF:** the first 10 pages as PNG `data:` URLs, drawn in the page by pdf-parse's browser build and its pdf.js worker (`Lib.pdfPages` with `getScreenshot`), with "Showing 10 of N pages"; the last 3 PDFs drawn are kept (`pdfDrawn`), so reopening one is instant.
  - **xlsx:** unzipped with JSZip and read with `DOMParser`: `workbook.xml` and its rels for the sheets, `sharedStrings.xml` when there is one (phonetic `rPh` readings left out), each cell's saved value, or `=formula` when it has none (create_file's never do). Rows and columns keep their places (`r`; a cell without one takes the next column). One table per sheet; at most 20 sheets, 500 rows and 50 columns.
  - **pptx:** the slides in `presentation.xml`'s order (its rels), each a 16:9 card with the title (title placeholder, else the first line), its lines (as a list when bulleted: `buChar`/`buAutoNum`, or a body placeholder, whose bullets come from the layout, without `buNone`) and the notes from its `notesSlide`; at most 100.
  - **csv** (`Lib.csvRows`, 500 rows) as a table; **md** through `mdBlocks`, like a reply; **other text** (`text/*`, JSON) as plain text; both cut at 200,000 characters, and only the start of a big file is decoded.
  - **Libraries** load on first use (`lazy`): JSZip as a script tag, pdf-parse with `import()`, from the paths in `LIBS`: `node_modules` on the desktop, `window.api.libs` (`www/vendor`) on phones.
  - A zip's entries are counted as they unpack (its stated sizes can lie), and reading stops past 32 MB for the whole file; any failure (a damaged file, an expired one) says why, and Save still works. `previewRun` drops a preview that finishes after another file was opened.

## The sandbox page

1. `loadFrame` calls `window.api.createSandbox(html, color, scheme, {css, js}, files)`, passing the reply's text color, the app's light or dark scheme and the reply's attachments.
2. `Lib.richFiles(html, files, tokens)` picks the attachments the HTML names as `attachment:<name>` and gives them a random token (`crypto.randomUUID`, kept in `tokens` for the run: the same files get the same token, so the same page is reused).
3. The host calls `Lib.richDoc(html, color, scheme, flags, links)` — the same code everywhere — which returns `{doc, csp}`: the model's HTML with each `attachment:<name>` rewritten to its URL, wrapped in a page with a small script that reports its height, plus a Content-Security-Policy string. A name the HTML doesn't name is left alone; only the files of this reply are offered (see [security.md](security.md)).
4. The host stores the page and returns a URL; the frame loads it. The page is served with `csp` as its CSP header, so the policy comes from the server side of the frame, not from the model's HTML. A file the frame loads is served from the same scheme or host, under `file/<token>/<name>`.
5. The frame posts `{richHeight}` to the page; `renderer.js` matches `e.source` to a `.rich iframe` and sets its height, capped at 4000 px. If the chat was at the bottom, it scrolls down again (not for a code block's Preview, which grows in place so its top stays in view), so a preview that grows after the reply finishes doesn't leave the end of the reply under the composer.

Fenced-code Preview frames (`codeBox`) call `richFrame(code)` with no files, so a code sample can't load a reply's files.

`richDoc` CSP rules: always `sandbox allow-scripts`. With CSS off, `style-src` allows only the app's own `<style>` by hash. With JavaScript off, `script-src` allows only the app's resize script by hash, and `frame-src` and `object-src` are `'none'` (a remote child document wouldn't be covered by `script-src` and could run its own scripts). Hashes, not nonces, so a script can't read the value back. Known limit: with CSS off but JS on, scripts can still set `element.style` (CSSOM isn't covered by CSP). `safeColor` validates the color so it can't break out of the style tag.

Size limit: `Lib.RICH_MAX` (2,000,000 characters); hosts reject larger input.

## Per platform

| | Desktop | Android | iOS |
| :-- | :-- | :-- | :-- |
| Doc URL | `chatbot-sandbox://doc/<id>` | `https://javc-sandbox.invalid/doc/<id>` | `javc-sandbox://doc/<id>` |
| File URL | `chatbot-sandbox://file/<token>/<name>` | `https://javc-sandbox.invalid/file/<token>/<name>` | `javc-sandbox://file/<token>/<name>` |
| Who serves it | `protocol.handle` in `main.js` | `MainActivity`'s web view client intercepts the host; `JavcPlugin.serveSandbox` returns the doc | `SandboxSchemeHandler` in `MainViewController.swift` |
| Doc store | `richDocs` Map | `LinkedHashMap` in `JavcPlugin.java` | `SandboxDocs` in `JavcPlugin.swift` |
| File store | `frameFiles` Map in `main.js` (read from the chat store on request) | `files` `LinkedHashMap` in `JavcPlugin.java` | `SandboxFiles` in `JavcPlugin.swift` |
| Eviction | docs: least recently used, 300 | docs: same; files: most recent 150 MB | docs: same; files: most recent 150 MB |

- **Ids** are the SHA-256 of `csp + "\n" + doc`, so re-rendering the same page reuses it instead of filling the store with copies; showing a page counts as using it.
- The desktop scheme is registered privileged (`standard`, `secure`, `supportFetchAPI`, `corsEnabled`, `stream`). Being a non-local scheme, its documents don't inherit the app's CSP. `corsEnabled` is what lets a frame (opaque origin) fetch `chatbot-sandbox://file/…`; a file answer carries `Access-Control-Allow-Origin: *`, `Content-Security-Policy: sandbox` (so an HTML file can't run as a page), `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`, and anything not under this reply's token is a 404.
- **How the files get to the host:** on the desktop, `sandbox:create` only registers the token, and the `chatbot-sandbox` handler reads a file from the chat store when a frame asks (`chats.readFile`). Phones push each used file into the plugin (`Javc.sandboxFile({key: '<token>/<name>'})` first — it answers `{held, url}` so a file the plugin still holds isn't read and sent again — then `{key, mime, data}`); the plugin keeps the most recent 150 MB.
- The Android and iOS plugins validate that the CSP starts with `sandbox allow-scripts` and cap the page size; both validate the key (`<uuid>/<name>`).
- `mobile/build.mjs` rewrites the page's CSP `frame-src` from `chatbot-sandbox:` to `https://javc-sandbox.invalid javc-sandbox:` for the phone bundle. The host name in `build.mjs` must match `SANDBOX_HOST` in `JavcPlugin.java`.
- The page's own CSP (`index.html`) is `default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; frame-src chatbot-sandbox:`. There is no `connect-src`, so the page can only talk to itself; all network traffic goes through the host.

Frames have internet access on purpose, so CDN libraries work in charts and demos.

## Changing it

If you change what `richDoc` returns or how the CSP is built, change nothing else per platform: all three hosts serve whatever `{doc, csp}` they are given. If you add a field to `createSandbox`, update `preload.js`, `main.js`, `mobile/main.js` and both plugins (see [window-api.md](window-api.md)).
