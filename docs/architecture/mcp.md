# MCP servers

**Scope:** giving the model tools from MCP servers: the config, connections, sign-in, per-call approval, the files a reply can attach.
**Source:** `mcp.js` (everything protocol-related), `store.js` (config, allow-list, tokens), `main.js` and `mobile/main.js` (the host pieces), `renderer.js` (Settings → Tools and the approval dialog).

## Config

The user pastes Claude-style JSON into Settings → Tools. `parseConfig(text)` accepts `{"mcpServers": {...}}`, a bare name→entry map, or one entry, and `cleanEntry` turns each into either:

- `{type: 'stdio', command, args, env}`: a local server (desktop only), or
- `{type: 'http', url, headers}`: a remote server (desktop and phones).

Legacy SSE entries are rejected with a hint. `store.saveMcp` validates the text with `parseConfig` first, so a bad paste saves nothing. The config is stored encrypted like a key (see [storage.md](storage.md)).

## Connections

- **JSON-RPC:** `rpc(send)` handles request ids, timeouts, cancellation notifications, and answers `ping`; other server requests get "method not found".
- **`stdioTransport`:** line-delimited JSON over the child's stdin/stdout; output is capped at 32 MB per message. Shutdown: close stdin, wait 2 s, SIGTERM, wait 2 s, SIGKILL. The child is spawned by `main.js` in its own process group (POSIX) so `child.kill` reaches what `npx` or `uvx` start. On Windows only `cmd.exe` is killed (a documented shortcut).
- **`httpTransport`:** Streamable HTTP. It sends `Mcp-Session-Id` and `MCP-Protocol-Version`, accepts JSON or event-stream answers, resumes a dropped or closed stream with `Last-Event-ID` (`readSse`), refreshes a token once on 401, ends the connection on 404 (session expired) so the hub starts a fresh session, and sends DELETE on close (gives up after 5 s).
- **`connect`:** `initialize` at protocol `2025-11-25` (older revisions are accepted), then `notifications/initialized`.
- **Local servers** find `npx`, `uvx` and friends through the login shell's PATH (`shellPath` in `main.js`, read once, 5 s timeout).

## The hub (`makeHub({spawn, fetchFn, auth})`)

`configure`, `status` (per server: ok, error, needs sign-in, desktop-only), `reload`, `tools(signal)`, `closeAll`, `signIn`, `signOut`. Servers connect lazily and are cached by their config. A server that stops after starting is forgotten, so the next use starts it again. Tool names are made unique as `mcp__<server>__<tool>` (at most 64 characters), `$schema` is removed from schemas, and a tool refuses to run if its server was changed or removed in Settings since the reply started. `resultText` caps tool output at 20,000 characters, and hands each file in a result to `keep` (below).

## OAuth sign-in (remote servers)

`signIn` and `discover` implement: protected-resource metadata (RFC 9728), authorization-server metadata (RFC 8414), dynamic client registration, PKCE (S256), the `resource` parameter, and `state` and issuer checks. Endpoints must be `https://` (or HTTP to this machine). Tokens are saved encrypted per server through `auth.save`; `refreshTokens` runs once at a time per server, refreshes halfway through a short-lived token, keeps the current token if the sign-in server can't be reached, and drops a refresh that finishes after sign-out.

The browser's return is host-specific and passed in as `{openUrl, listen}`:

- **Desktop:** `listen()` in `main.js` runs a one-shot HTTP server on `127.0.0.1` (random port, `/callback` only) and `shell.openExternal` opens the sign-in page (http(s) only).
- **Phones:** the redirect is `io.github.thedwz.javcchatbot:/oauth`, caught as `appUrlOpen` by `@capacitor/app` (Android intent filter in `AndroidManifest.xml`; iOS `CFBundleURLTypes` plus `SceneDelegate`). A newer sign-in replaces an older one, since every sign-in shares the address.

## Approval and the reply

`replyTools(hub, store, {approve, onDelta, signal, readFile})` reads `store.mcpForReply()` once, configures the hub, turns failures into notes in the reply, and returns the gated set. `gated(set, {allowed, approve, readFile})` returns `{defs, has, label, files, call}`; `call` parses and checks the model's arguments, then asks `approve({server, tool, args})`, which resolves to `once`, `always` or `deny`. `always` is remembered with `store.allowMcpTool`; anything else than once/always means deny (`DECLINED` is the text the model sees).

**Auto-approve** (Settings → Advanced, `mcp.autoApprove`, off by default): `replyTools`'s `approve` checks `store.mcpAutoApprove()` at each call (so switching it off counts for a reply already running) and, when it's on, answers `once` without asking, so every tool call and every attach_file path or URL runs without a dialog, and nothing is saved to the allow-list. The page only turns it on after the user types "I accept the risk." in `#riskdlg`; turning it off needs no confirmation. Saving a config with a new or changed server turns it off (`saveMcp`), since it was confirmed for the servers there were then.

The approval path to the page: `approver(sender)` in `main.js` (desktop) sends `mcp:approve` and waits for `mcp:answer`; a page that closes or crashes meanwhile denies. On phones, `approve` is the function registered with `onToolApproval`. Stop works while a dialog is open.

## Attaching files (`attach_file`)

When the reply offers MCP tools, it also offers `attach_file`. A tool result's files become ids `f1`, `f2`…; a `path` (absolute, on the user's computer) or `url` (http(s), or a `file:` URL on the desktop) attaches a file the tool saved. Attached files collect in `files` and come back with the reply (`api.js` `chatStream`), saved into the chat by `chats.js` (`keepFiles`).

- **From a result:** `resultText(res, keep)` hands every file in a tool result to `keep`: image and audio blocks, resource blobs, and text resources whose `mimeType` isn't `text/plain`. `keep` returns a hint line that stands in for the file: `[file "name" (mime, size): attach_file {"id": "fN"} attaches it to your reply]`. The hints are appended after the text, so the 20,000-character cut never drops them. A `resource_link` says `attach_file {"url": …}` attaches it. Without `keep` (no `attach_file`) media blocks are still `[image omitted]`-style notes, as before.
- **By path or URL:** the model is asked first, through the normal tool dialog with `server` shown as "The model" and `app: true` — every path and URL is asked, each time; the dialog hides "Always allow" for `app` calls, and `replyTools` never saves one for them (it skips `allowMcpTool` for `app`). Then `readFile(ref, signal)`, passed in by the host, reads it. A file over 50 MB is refused; files in a result over 50 MB get a note to save the file and attach it by path.
- **Limits:** 50 MB per file (`FILE_MAX`), 20 files per reply (`FILES_MAX`, checked before anything is asked or downloaded), the same file twice counts once (matched by its data), and a second file with the same name gets `-2`, `-3`… before the extension. The set still returns text to the model: `tools()`'s `run` and `gated`'s `call` resolve to a string.

`readFile` per host:

- **Desktop** (`main.js`): an absolute path or `file:` URL — a regular file, at most 50 MB — or an http(s) URL fetched by `Mcp.fetchFile` (streamed, cut off past 50 MB).
- **Phones** (`mobile/main.js`): URLs only; a path errors ("files on a computer can only be attached in the desktop app").

## Limits you will hit

- No local (command) servers on phones; they report "desktop-only".
- Tool calls and results are not saved with the chat (see [chat-turn.md](chat-turn.md)); files the model attaches to its reply are.
- Up to 20 tool rounds per reply.
- The stdio transport caps a message at 32 MB (`OUT_MAX`), so a stdio server can't return more than about 24 MB of base64 inline in one result. HTTP servers can stream, but `resultText` still cuts tool output at 20,000 characters (files are attached whole, outside that text).
