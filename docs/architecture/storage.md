# Storage: settings, profiles, chats, keys

**Scope:** what is saved, where, in what shape, and how it survives damage and upgrades.
**Source:** `store.js`, `profiles.js`, `chats.js`, `disk.js`; the phone versions of `io`/`crypto` in `mobile/native.js`.

## Layers

```
store.js (settings logic)  ─┐
chats.js (history logic)   ─┴─> io  (flat files)  ─> desktop: disk.js makeDisk | phones: native plugin fs*
store.js                   ───> crypto (enc/dec)  ─> desktop: safeStorage      | phones: Keystore / Keychain
profiles.js                    pure state functions, no I/O
```

All file names are flat (`settings.json`, `<chat id>.json`). Every `io` rejects names with a slash, `.` or `..`.

## Where the data lives

| Platform | Settings | Chats |
| :-- | :-- | :-- |
| Desktop | `settings.json` in Electron's per-app data folder | `chats/` inside it |
| Android | `settings.json` in the app's private files folder (not in cloud backups) | `chats/` inside it |
| iOS | `Application Support/javc/settings.json` (excluded from backup) | `chats/` inside it |

The app used to be called "chatbot". `migrateLegacy` (`disk.js`, called at startup in `main.js`) moves `settings.json`, `settings.json.bad` and `chats` from the old folder, one item at a time, never overwriting, retried on every launch until done.

## `disk.js`

`makeDisk(root)` returns `{read, write, remove, list, rename}`. `read` gives `null` for a missing file. `write` is atomic and owner-only: it writes `name.tmp` (mode 0600), calls fsync, then renames over the target, so a crash can't leave a half-written or empty file (a power cut can still lose that one save). `list` of a missing folder is `[]`. Android and iOS do the same in their plugins (temp file, sync or atomic write, rename).

## `settings.json` (version 2)

```
{ version: 2, activeId, effort,
  profiles: [{ id, name, endpoint, model, format, meta, noTools, ctx, keyEnc | keyPlain }],
  personas: [{ id, name, user, bot, prompt, summarizer? }],   // 'default' always exists
  personaId, render: { markdown, html, css, js }, theme: { id, a1?, a2?, gradient },   // a1/a2 only for id 'custom'
  search: { enabled, keyEnc | keyPlain },
  mcp: { enabled, keyEnc | keyPlain /* the pasted config */, names, allow: { server: [tool] }, auth: { server: { keyEnc | keyPlain } } },
  summarizer: { profileId, model }, contextLimit: { on, tokens } }
```

- **Theme.** `Lib.cleanTheme` keeps a preset id (`indigo` is the default) or `custom` with two `#rrggbb` colors, plus `gradient` (true only when exactly `true`). With `gradient` off the page sets `--a2` to `--a1`, so every gradient paints one color. A saved `aurora` theme with no `gradient` key dates from before the switch, when Aurora was the default; `finishState` moves it to the default once, and picking Aurora again saves `gradient` so it sticks.
- **Templates** (NanoGPT, OpenRouter, Venice, OpenAI) are not profiles. They only prefill the New profile dialog.
- **`profiles.js`** is pure: `migrate` (old single-endpoint files and the old `rich` switch become v2), `known` (does this version understand a parsed file), `upsert`, `remove`, `publicView`, `cleanSummarizer`, `cleanContextLimit`. `upsert` makes a *new* profile active but never switches the active profile when editing another one.
- **`publicView`** is what the page gets: no keys, only `hasKey`; MCP shows `names` and `allow`.
- **`store.js`** is `makeStore({io, crypto})`. Every operation goes through one promise queue (`serial`), so two quick changes can't both read the same old file. Key methods: `get`, `load` (flat view of one profile for a request), `patch` (global settings, plus `model`/`meta`/`noTools`/`ctx` on the active profile; never creates a profile), `saveProfile` (endpoint must be http(s)), `savePersona`, `deletePersona` (not Default), `activate`, `saveSearch`, `saveMcp`, `mcpServers`, `mcpForReply`, `mcpTokens`/`saveMcpTokens`, `allowMcpTool`, `takeNotice`.
- **Key fields.** A save with no `key` field keeps the stored key; `key: ''` clears it. When `crypto.available()` is false, keys are kept as `keyPlain` in the private file and upgraded to `keyEnc` the next time a keyring is available. `keyOf` throws a clear message if a keyring can't decrypt.
- **Encrypted extras.** The search key, the pasted MCP config (it often holds tokens) and each server's OAuth tokens are stored with the same `keyEnc`/`keyPlain` scheme.
- **Damaged files.** If `settings.json` doesn't parse, or `profiles.known` rejects it (not an object, an array, a v2 file without a profile list, a newer version), `quarantine` renames it to `settings.json.bad`, then `.bad-2`, `.bad-3`... and sets a one-time notice. A read error propagates and leaves the file alone. A missing file is never written back, so a first run leaves nothing on disk until something is saved.
- **Changing a server** in the MCP config drops its "Always allow" tools and its sign-in.

## Chats (`chats.js`)

`makeChats(io)` returns `list`, `load`, `save`, `remove`, all serialized.

- One file per chat, `<id>.json`, plus `_index.json` (`[{id, title, updated, personaId}]`) so listing doesn't open every chat. Ids must match `^[a-z0-9-]+$` (`_` can't appear, so the index never collides with a chat).
- A chat holds only its own messages; that is what keeps chats isolated from each other.
- `list` reconciles the index with the files every time: entries whose file is gone are dropped, files missing from the index are added, a damaged index is rebuilt, and corrupt files or id/name mismatches are skipped instead of losing the whole list.
- `save` writes the chat file first, then the index; `remove` deletes the chat file first, then writes the index. An interruption between the two is repaired by the next `list`.

## Changing a stored format

Add the new field with a default in `finishState` (`profiles.js`) so old files load, keep `version: 2` unless the change can't be read by older code, and add a test in `test.js`. If a version bump is needed, extend `migrate` and `known` together; anything `known` rejects is quarantined, not overwritten.
