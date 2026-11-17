# One chat turn

**Scope:** what happens from pressing Send to a saved reply: request building, streaming, tools, Stop, Regenerate/Edit/versions, summaries, stats.
**Source:** `renderer.js` (`send`, `generate`, `summarize`, `regenerate`, `persist`), `lib.js`, `api.js`, `anthropic.js`; the host side is in `main.js` / `mobile/main.js` (see [window-api.md](window-api.md)).

## Flow

1. **`send()`** (`renderer.js`) builds the user message `{role, content: Lib.buildContent(text, atts), text, files}`, pushes it on `chat.messages` and calls `generate()`. If the reply fails, the turn is popped and the draft and attachments are restored.
2. **`generate(base)`** adds the assistant row and calls `setBusy(true)`, which locks chat switching, the profile and persona pickers and New chat, and turns Send into Stop. It first awaits `summarize(reply)` (below), then calls `window.api.chat(Lib.requestMessages(chat, persona, {render}), onDelta, {search, mcp})`. `search` and `mcp` are on only when the model is known to support tools (`toolsOk()`) and the feature is switched on.
3. **Host:** loads the active profile with `store.load` (the key is decrypted here, never in the page), runs `api.requestArgs`, then `api.chatStream`. On desktop this is `chat:send` in `main.js`; on phones it is `window.api.chat` in `mobile/main.js` with `nativeFetch`. If MCP is on, `Mcp.replyTools(hub, store, ...)` supplies the tools (see [mcp.md](mcp.md)).
4. **Streaming:** `onDelta({reasoning, content})` pieces are buffered in `reply.delta` and flushed once per animation frame as plain text. Reasoning goes to the panel behind the assistant's avatar. When the stream ends, `reply.done` swaps in the fully rendered reply (see [rich-replies.md](rich-replies.md)).
5. **Stats:** `Lib.replyStats` computes time to first token and tokens per second; the result is stored on the message and added to `chat.used` (a running total that doesn't drop when later replies are cut). When the provider reports what the reply cost, it goes into the stats too and into `chat.cost`, the same kind of total in USD; summaries add to both.
6. **`persist()`** saves the chat through `window.api.saveChat` (see [storage.md](storage.md)); the first reply also titles the chat.

## Building the request (`lib.js`)

- `Lib.requestMessages(chat, persona, {render})` strips display-only fields and builds one system message from the persona (`systemPrompt`, with `{{user}}`/`{{char}}`), the render hint (`renderHint`, which tells the model only about the formats that are switched on) and the summary if there is one. Only this chat's messages are sent.
- `api.requestArgs(s, opts)` picks the model, the reasoning parameters and whether search or MCP applies. A summary request uses its own profile and model, no extra parameters, no tools.
- `reasoningParams` / `resolveFormat` (`api.js`) produce one of four shapes: OpenRouter `reasoning: {effort}`, a thinking switch for DeepSeek, Z.ai and Moonshot (`THINKING_SWITCH`, which turns thinking off with `thinking: {type: 'disabled'}`), plain `reasoning_effort`, or just `{effort}` for an Anthropic endpoint. `resolveFormat` answers `anthropic` from the endpoint host before any saved format, so the Reasoning format setting doesn't apply there; `anthropic.js` turns the effort into thinking and `output_config` (below).

## The client (`api.js`)

- `call` sends the request with a Bearer header and turns a non-OK answer into `HTTP <status>: <body>`; an abort becomes the error `Stopped`.
- `listModelsDetailed` reads `/models` (NanoGPT gets `?detailed=true` so context sizes are included) and extracts reasoning support (`reasoningInfo`), a `tools: false` flag (`noTools`: OpenRouter's `supported_parameters`, or Mistral's `capabilities.function_calling === false`) and the context window (`ctxOf`).
- `streamOnce` sends `stream_options.include_usage` for token counts. If the server answers 400 or 422, it retries once without it, and remembers the endpoint in `NO_USAGE` only if the retry works, so a real error never disables usage. It parses SSE `data:` lines, assembles tool calls that arrive in pieces, and handles servers that ignore `stream: true` and answer with plain JSON. `thinkSplitter` turns a leading `<think>...</think>` into reasoning even when the tags are split across chunks. If the stream breaks after some text arrived, the partial reply comes back with `error` or `stopped` set.
- `costOf` reads what a request cost, in USD, from whichever provider reports it: NanoGPT's `x_nanogpt_pricing` (`cost` or `amount`; skipped when its `currency` isn't USD, and then nothing else is read, so `usage.cost` is never mistaken for it), OpenRouter's `usage.cost` (credits, 1 = $1), or xAI's `usage.cost_in_usd_ticks` (1e-10 USD). `chatStream` adds up the cost of every tool round. Other providers (and Anthropic) don't report cost, and none is estimated.
- Mistral's reasoning models send content as a list of `text` and `thinking` chunks. `parts` splits it into reasoning and content, in both the SSE deltas and a plain-JSON answer.
- Gemini's tool calls carry `extra_content`, a thought signature. It is kept on the call and sent back with the tool calls on the next round, or Gemini rejects the follow-up.
- `chatStream` is one `streamOnce` when there are no tools. With tools it loops: up to `TOOL_ROUNDS` (20) rounds when MCP tools are offered, otherwise `SEARCH_ROUNDS` (4); the last round sends `tool_choice: 'none'`. Linkup searches are capped at 4 per reply across rounds. A failing tool becomes tool-result text and the model carries on. Thinking-mode providers get the round's reasoning sent back with its tool calls (they reject the follow-up otherwise). Token usage is summed over rounds; `ctx` is the last round's total and `sent` is the first round's prompt tokens.
- The tool exchange is **not** saved with the chat: later turns see only the final answer.
- Web search is a `web_search` tool backed by `linkupSearch` (Linkup `fast` depth, 5 results, 2000 characters each).

## Anthropic (`anthropic.js`)

An Anthropic endpoint goes through the official `@anthropic-ai/sdk`, not the OpenAI-compatible path. `api.js` requires the module and hands it model listing and streaming; `resolveFormat` stays in `api.js` and only asks `isAnthropic`. The tool loop, the usage totals and Stop stay in `api.js`.

- Detection is the endpoint host (`anthropic.com`) only, so Anthropic-compatible proxies are not detected. `resolveFormat` answers `anthropic` before any saved Reasoning format, so the format setting doesn't apply.
- `listModels` reads the Models API: the context size from `max_input_tokens`, effort levels from `capabilities`. Each model's output cap and thinking support are cached in `INFO` for the session. A model looked up on first use is cached only when the lookup works; after a failure the request assumes a current model and the next one asks again.
- `streamOnce` has the same contract as `api.js`'s `streamOnce`: OpenAI-style messages and tools in, `{content, reasoning, usage}` out, tool calls pushed in OpenAI shape.
- `convert` turns the messages into Anthropic's: system messages move into the top-level `system` field, images go as base64 or URL image blocks, OpenAI-style tools become `input_schema` tools, and one round's tool results go into a single user message.
- Every request sends `cache_control` ephemeral (prompt caching), `max_tokens` set to the model's cap (at most 64,000), and adaptive thinking with `display: 'summarized'` when the model supports it. Effort low to max goes to `output_config.effort`; `minimal` is sent as `low`; `none` sends thinking disabled; Disabled (no level) and summaries send neither. Models without adaptive thinking (Haiku 4.5) get no thinking or effort fields.
- `claude-fable-5-2`, `claude-fable-5-1`, `claude-opus-5-5`, `claude-opus-5` and `claude-sonnet-5-5` also send server-side refusal fallbacks (`fallbacks: 'default'`, beta `server-side-fallback-2026-07-01`).
- In a tool loop the reply's content blocks (thinking with signatures, `tool_use`) go back unchanged on the next round. After a fallback block, the declined partial's thinking and `tool_use` blocks are dropped. A refusal is an error. A reply cut off at `max_tokens` runs none of its tool calls and comes back with `error` set.
- A profile without a key fails before any request, since the SDK would otherwise use credentials from the environment or its config files. One client is reused across a reply's tool rounds. SDK HTTP errors become `HTTP <status>: ...`. On phones the SDK runs in the web view with `dangerouslyAllowBrowser`, using the native fetch; the key still only lives in the host code (`store.load`), never in the page.

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

`Lib.replyStats` and `Lib.chatStats` feed `renderStats` and `lineChart` (an SVG chart) in the stats dialog. When the chat has a provider-reported cost (from a reply or a summary), two more tiles show the last reply's cost (`—` if it had none) and the chat's total (`chat.cost`); otherwise they're hidden. Amounts from $1 up show cents; smaller ones keep 3 significant digits. Speed leaves out hidden reasoning tokens and time spent waiting for searches or tools (`note` deltas are not timed as the model's). Without server token counts, speed is estimated from text length and marked with `~`.
