# One chat turn

**Scope:** what happens from pressing Send to a saved reply: request building, streaming, tools, Stop, Regenerate/Edit/versions, summaries, stats.
**Source:** `renderer.js` (`send`, `generate`, `summarize`, `regenerate`, `persist`), `lib.js`, `api.js`; the host side is in `main.js` / `mobile/main.js` (see [window-api.md](window-api.md)).

## Flow

1. **`send()`** (`renderer.js`) builds the user message `{role, content: Lib.buildContent(text, atts), text, files}`, pushes it on `chat.messages` and calls `generate()`. If the reply fails, the turn is popped and the draft and attachments are restored.
2. **`generate(base)`** adds the assistant row and calls `setBusy(true)`, which locks chat switching, the profile and persona pickers and New chat, and turns Send into Stop. It first awaits `summarize(reply)` (below), then calls `window.api.chat(Lib.requestMessages(chat, persona, {render}), onDelta, {search, mcp})`. `search` and `mcp` are on only when the model is known to support tools (`toolsOk()`) and the feature is switched on.
3. **Host:** loads the active profile with `store.load` (the key is decrypted here, never in the page), runs `api.requestArgs`, then `api.chatStream`. On desktop this is `chat:send` in `main.js`; on phones it is `window.api.chat` in `mobile/main.js` with `nativeFetch`. If MCP is on, `Mcp.replyTools(hub, store, ...)` supplies the tools (see [mcp.md](mcp.md)).
4. **Streaming:** `onDelta({reasoning, content})` pieces are buffered in `reply.delta` and flushed once per animation frame as plain text. Reasoning goes to the panel behind the assistant's avatar. When the stream ends, `reply.done` swaps in the fully rendered reply (see [rich-replies.md](rich-replies.md)).
5. **Stats:** `Lib.replyStats` computes time to first token and tokens per second; the result is stored on the message and added to `chat.used` (a running total that doesn't drop when later replies are cut).
6. **`persist()`** saves the chat through `window.api.saveChat` (see [storage.md](storage.md)); the first reply also titles the chat.

## Building the request (`lib.js`)

- `Lib.requestMessages(chat, persona, {render})` strips display-only fields and builds one system message from the persona (`systemPrompt`, with `{{user}}`/`{{char}}`), the render hint (`renderHint`, which tells the model only about the formats that are switched on) and the summary if there is one. Only this chat's messages are sent.
- `api.requestArgs(s, opts)` picks the model, the reasoning parameters and whether search or MCP applies. A summary request uses its own profile and model, no extra parameters, no tools.
- `reasoningParams` / `resolveFormat` (`api.js`) produce one of three shapes: OpenRouter `reasoning: {effort}`, a thinking switch for DeepSeek, Z.ai and Moonshot (`THINKING_SWITCH`, which turns thinking off with `thinking: {type: 'disabled'}`), or plain `reasoning_effort`.

## The client (`api.js`)

- `call` sends the request with a Bearer header and turns a non-OK answer into `HTTP <status>: <body>`; an abort becomes the error `Stopped`.
- `listModelsDetailed` reads `/models` (NanoGPT gets `?detailed=true` so context sizes are included) and extracts reasoning support (`reasoningInfo`), a `tools: false` flag (`noTools`) and the context window (`ctxOf`).
- `streamOnce` sends `stream_options.include_usage` for token counts. If the server answers 400 or 422, it retries once without it, and remembers the endpoint in `NO_USAGE` only if the retry works, so a real error never disables usage. It parses SSE `data:` lines, assembles tool calls that arrive in pieces, and handles servers that ignore `stream: true` and answer with plain JSON. `thinkSplitter` turns a leading `<think>...</think>` into reasoning even when the tags are split across chunks. If the stream breaks after some text arrived, the partial reply comes back with `error` or `stopped` set.
- `chatStream` is one `streamOnce` when there are no tools. With tools it loops: up to `TOOL_ROUNDS` (20) rounds when MCP tools are offered, otherwise `SEARCH_ROUNDS` (4); the last round sends `tool_choice: 'none'`. Linkup searches are capped at 4 per reply across rounds. A failing tool becomes tool-result text and the model carries on. Thinking-mode providers get the round's reasoning sent back with its tool calls (they reject the follow-up otherwise). Token usage is summed over rounds; `ctx` is the last round's total and `sent` is the first round's prompt tokens.
- The tool exchange is **not** saved with the chat: later turns see only the final answer.
- Web search is a `web_search` tool backed by `linkupSearch` (Linkup `fast` depth, 5 results, 2000 characters each).

## Stop

The page calls `stopChat`, which aborts the `AbortController` for the running reply. `api.js` returns the partial reply with `stopped: true` if there is any text, otherwise throws `Stopped`. A stopped Regenerate or Edit restores the previous messages and summary.

## Regenerate, Edit and versions

- `regenerate(m)` cuts `chat.messages` back to just before the target reply and calls `generate(base)`; the new reply is added as another version with `Lib.addVersion`. On failure, error or Stop, the previous messages and summary come back.
- Editing a message uses `Lib.editUser` + `Lib.addVersion` and keeps the messages after it. A user version stores only the typed text; attachments are stored once on the message.
- `versionNav` (`‹ 2/3 ›`) switches versions with `Lib.showVersion`; switching changes only that message.
- A summary that covers an edited message is dropped.

## Summaries and the context limit

- Before each reply, `summarize()` asks `Lib.summaryDue(chat, limit, persona, opts)`: is the next request over `SUMMARY_AT` (80%) of the model's context limit? If so, everything except the last `KEEP` (4) messages is folded into `chat.summary = {text, upto, at}`. The messages stay on screen behind a thin divider; only the model's view changes.
- The limit comes from the model list (`ctx`, stored per profile), else `DEFAULT_CTX` (300,000) or the user's own number (`contextLimit` in settings).
- `Lib.contextTokens` counts from the last reply's real prompt tokens when it has them, plus estimates (about 4 characters per token, 1000 per image); without a usable count it estimates the whole request.
- The summary model is the persona's own choice, else the global one (Settings → Summaries), else the chat model (`summarizer()` in `renderer.js`).
- A failed or cut-off summary is never kept. After a failure, `sumFail` suppresses retries until the chat has grown by 4 messages (two turns), and that reply is sent with the whole chat. Stop during summarizing gives the draft back.

## Attachments

`attach` takes up to 5 files per message. Images are scaled so the long side is at most 2048 px (`Lib.fitSize`). Text files are inlined up to 200,000 characters. PDFs go through `window.api.extractPdf` (25 MB limit); text is extracted on the device with `pdf-parse`.

## Stats for nerds

`Lib.replyStats` and `Lib.chatStats` feed `renderStats` and `lineChart` (an SVG chart) in the stats dialog. Speed leaves out hidden reasoning tokens and time spent waiting for searches or tools (`note` deltas are not timed as the model's). Without server token counts, speed is estimated from text length and marked with `~`.
