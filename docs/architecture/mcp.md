# MCP servers

**Scope:** giving the model tools from MCP servers: the config, connections, sign-in, per-call approval.
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

`configure`, `status` (per server: ok, error, needs sign-in, desktop-only), `reload`, `tools(signal)`, `closeAll`, `signIn`, `signOut`. Servers connect lazily and are cached by their config. A server that stops after starting is forgotten, so the next use starts it again. Tool names are made unique as `mcp__<server>__<tool>` (at most 64 characters), `$schema` is removed from schemas, and a tool refuses to run if its server was changed or removed in Settings since the reply started. `resultText` caps tool output at 20,000 characters.

## OAuth sign-in (remote servers)

`signIn` and `discover` implement: protected-resource metadata (RFC 9728), authorization-server metadata (RFC 8414), dynamic client registration, PKCE (S256), the `resource` parameter, and `state` and issuer checks. Endpoints must be `https://` (or HTTP to this machine). Tokens are saved encrypted per server through `auth.save`; `refreshTokens` runs once at a time per server, refreshes halfway through a short-lived token, keeps the current token if the sign-in server can't be reached, and drops a refresh that finishes after sign-out.

The browser's return is host-specific and passed in as `{openUrl, listen}`:

- **Desktop:** `listen()` in `main.js` runs a one-shot HTTP server on `127.0.0.1` (random port, `/callback` only) and `shell.openExternal` opens the sign-in page (http(s) only).
- **Phones:** the redirect is `io.github.thedwz.javcchatbot:/oauth`, caught as `appUrlOpen` by `@capacitor/app` (Android intent filter in `AndroidManifest.xml`; iOS `CFBundleURLTypes` plus `SceneDelegate`). A newer sign-in replaces an older one, since every sign-in shares the address.

## Approval and the reply

`replyTools(hub, store, {approve, onDelta, signal})` reads `store.mcpForReply()` once, configures the hub, turns failures into notes in the reply, and returns the gated set. `gated(set, {allowed, approve})` returns `{defs, has, label, call}`; `call` parses and checks the model's arguments, then asks `approve({server, tool, args})`, which resolves to `once`, `always` or `deny`. `always` is remembered with `store.allowMcpTool`; anything else than once/always means deny (`DECLINED` is the text the model sees).

The approval path to the page: `approver(sender)` in `main.js` (desktop) sends `mcp:approve` and waits for `mcp:answer`; a page that closes or crashes meanwhile denies. On phones, `approve` is the function registered with `onToolApproval`. Stop works while a dialog is open.

## Limits you will hit

- No local (command) servers on phones; they report "desktop-only".
- Tool calls and results are not saved with the chat (see [chat-turn.md](chat-turn.md)).
- Up to 20 tool rounds per reply.
