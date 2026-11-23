# Storage: settings, profiles, chats, keys

**Scope:** what is saved, where, in what shape, and how it survives damage and upgrades.
**Source:** `store.js`, `profiles.js`, `chats.js`, `seal.js`, `backup.js`, `disk.js`; the phone versions of `io`/`crypto` in `mobile/native.js`.

## Layers

```
store.js (settings logic)  ─┐
chats.js (history logic)  ──> seal.js io (AES-GCM) ─┤
                                                     └─> io  (flat files)  ─> desktop: disk.js makeDisk | phones: native plugin fs*
store.js, seal.js (chat key) ─> crypto (enc/dec)  ─> desktop: safeStorage      | phones: Keystore / Keychain
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
  profiles: [{ id, name, endpoint, model, format, meta, noTools, ctx, noFilesFor /* models that turned create_file down */, keyEnc | keyPlain }],
  personas: [{ id, name, user, bot, prompt, summarizer? }],   // 'default' always exists
  personaId, render: { markdown, html, css, js }, theme: { id, a1?, a2?, gradient },   // a1/a2 only for id 'custom'
  search: { enabled, keyEnc | keyPlain },
  mcp: { enabled, autoApprove /* skip every tool approval */, keyEnc | keyPlain /* the pasted config */, names, allow: { server: [tool] }, auth: { server: { keyEnc | keyPlain } } },
  files: { create, ask, feedBack, keepDays /* 0 (forever), 1, 7, 30 or 90 */ },   // create_file; cleanFiles fills defaults (all on, 0)
  summarizer: { profileId, model }, contextLimit: { on, tokens } }
```

- **Theme.** `Lib.cleanTheme` keeps a preset id (`indigo` is the default) or `custom` with two `#rrggbb` colors, plus `gradient` (true only when exactly `true`). With `gradient` off the page sets `--a2` to `--a1`, so every gradient paints one color. A saved `aurora` theme with no `gradient` key dates from before the switch, when Aurora was the default; `finishState` moves it to the default once, and picking Aurora again saves `gradient` so it sticks.
- **Templates** (NanoGPT, OpenRouter, Venice, OpenAI, Anthropic, Gemini, Grok (xAI), Mistral, NVIDIA NIM) are not profiles. They only prefill the New profile dialog. `migrate` drops only the original four (NanoGPT, OpenRouter, Venice, OpenAI) that an earlier version pre-created as keyless profiles.
- **`profiles.js`** is pure: `migrate` (old single-endpoint files and the old `rich` switch become v2), `known` (does this version understand a parsed file), `upsert`, `remove`, `publicView`, `cleanSummarizer`, `cleanContextLimit`, `cleanFiles`. `upsert` makes a *new* profile active but never switches the active profile when editing another one.
- **`publicView`** is what the page gets: no keys, only `hasKey`; MCP shows `names`, `allow` and `autoApprove`; `files` as stored; each profile's `noFilesFor`.
- **`store.js`** is `makeStore({io, crypto})`. Every operation goes through one promise queue (`serial`), so two quick changes can't both read the same old file. Key methods: `get`, `load` (flat view of one profile for a request), `patch` (global settings including `files`, plus `model`/`meta`/`noTools`/`ctx`/`noFilesFor` on the active profile; never creates a profile), `saveProfile` (endpoint must be http(s)), `savePersona`, `deletePersona` (not Default), `activate`, `saveSearch`, `saveMcp`, `mcpServers`, `mcpForReply`, `mcpAutoApprove`, `filesForReply` (`{ask, keepDays}`), `allowCreate`, `mcpTokens`/`saveMcpTokens`, `allowMcpTool`, `takeNotice`.
- **Key fields.** A save with no `key` field keeps the stored key; `key: ''` clears it. When `crypto.available()` is false, keys are kept as `keyPlain` in the private file and upgraded to `keyEnc` the next time a keyring is available. `keyOf` throws a clear message if a keyring can't decrypt.
- **Encrypted extras.** The search key, the pasted MCP config (it often holds tokens) and each server's OAuth tokens are stored with the same `keyEnc`/`keyPlain` scheme.
- **Damaged files.** If `settings.json` doesn't parse, or `profiles.known` rejects it (not an object, an array, a v2 file without a profile list, a newer version), `quarantine` renames it to `settings.json.bad`, then `.bad-2`, `.bad-3`... and sets a one-time notice. A read error propagates and leaves the file alone. A missing file is never written back, so a first run leaves nothing on disk until something is saved.
- **Changing a server** in the MCP config drops its "Always allow" tools and its sign-in.

## Chat encryption (`seal.js`)

Every file in `chats/` (each chat and `_index.json`) is encrypted. `makeChatSeal({io, crypto, chats})` takes the settings folder, the host keyring and the plain chats folder, and returns `{io, status, takeNotice}`. The hosts pass `seal.io` to `makeChats`.

- **One chat key** per install: 256 random bits, kept in `chatkey.json` beside `settings.json` (never inside it, so quarantining a damaged settings file can't lose it), as `{version: 1, keyEnc}`. With no working keyring it's `keyPlain`, and moved to `keyEnc` on a later launch once one works. A wrapping is only used if it decrypts back to the key, so a broken keyring can't lock chats away. In WebCrypto the key is not extractable.
- **Sealed file:** `JAVC-SEALED-1\n` + `base64(iv[12] | ciphertext | tag)`, AES-256-GCM, with the file name as additional data, so a file can't be passed off as another chat or as the index. `rename` re-seals under the new name.
- **WebCrypto** (`globalThis.crypto.subtle`) does the work, so the same code runs in Electron's main process, in the phone web views and in tests; big chats never cross the native bridge.
- **Loaded lazily:** the key loads on the first sealed read or write (or `status()`), not when the module is built. Linux's keyring only works once Electron is ready. `getSettings` calls `list()`, which loads the key when there are chats, so notices about the key and unreadable chats are ready with the settings. With no chats, `list` doesn't load it, so a first launch never waits on the keystore making a key; the first save does.
- **Upgrade:** `chats.upgrade()` seals any file still saved as plain text, through the chat store's queue, so it can't race a save. Desktop runs it in `app.whenReady`, phones at start-up. Until then, plain files are read as they are. The index is sealed last, so a later launch that finds it sealed stops there instead of reading every chat (an older build that saves a chat rewrites the index plain, so the next upgrade runs in full).
- **Failures never lose chats.** A key the keyring can't decrypt, or a damaged `chatkey.json`, is an error and is never replaced: `list` rejects (through `io.ready()`, since `list` skips files it can't read), saves reject, and nothing is written. Only a *missing* `chatkey.json` makes a new key. If sealed chats are already there, they're kept on disk and a one-time notice says how many can't be opened. A chat file that `list` or `load` can't decrypt once the key has loaded (another device's key, or a changed file) is set aside: `setAside` renames it to `<id>.json.<time>.unreadable` unchanged, so it isn't retried on every list and can still be opened by renaming it back under the right key. `getSettings` lists the chats before taking notices, so one notice gives the count (a chat that fails when opened gets the error, and drops out of the next list); after a lost key only the lost-key notice shows, since both are about the same files. The index is never set aside (it rebuilds).
- **Starting over:** when the key can't be loaded, Settings → Chats shows the error and a "Start over with a new key" button (two clicks, like deleting a chat). `resetChatKey()` → `seal.reset()` refuses while the key still loads; otherwise it renames `chatkey.json` to `chatkey.json.<time>.old` (never deleted), makes a new key and returns the lost-key notice. The next list sets the old chats aside, so renaming the key file and the `.unreadable` files back opens them again if the old keyring returns.
- **Status:** `chatsStatus()` gives `{keyring}` or `{error}` (phones add `device: true`); Settings → Chats shows it. On Linux, `safeStorage`'s `basic_text` store uses a fixed built-in key, so the desktop host gives the seal a keyring (`chatKeyring`) that reports itself unavailable there: the key is kept as `keyPlain` and moved into a real keyring once one works. A keyring that throws while wrapping counts as unavailable too.

## Chats (`chats.js`)

`makeChats(io)` returns `list`, `load`, `save`, `remove`, `saveFile`, `readFile`, `keepFiles`, `noteMade`, `expire`, `upgrade`; all but `readFile` and `keepFiles` are serialized (`keepFiles` goes through `saveFile`, which is).

- One file per chat, `<id>.json`, plus `_index.json` (`[{id, title, updated, personaId, files}]`) so listing doesn't open every chat. Ids must match `^[a-z0-9-]+$` (`_` can't appear, so no `_` file is ever a chat: listing and the sweep skip them).
- A chat holds only its own messages; that is what keeps chats isolated from each other.
- **Files the model attached** are kept beside the chats as `a-<sha256 of the base64>.bin`, sealed like them, saved once (the same bytes get the same name; a created file hashes `made\n` before its data, so it never shares a ref with an ordinary attachment that expiry would then delete). When chats were set aside as unreadable (a key lost to Start over), a file already on disk from an earlier run is written again if it no longer reads, so an import repairs it; otherwise nothing is decrypted to check. `saveFile(data, made)` returns the ref messages hold (`a-…`); `readFile(ref)` gives the base64 back and rejects anything but `^a-[0-9a-f]{64}\.bin$`, and a missing file with an error (code `EXPIRED` when expiry deleted it); `keepFiles(reply)` saves a reply from `api.chatStream` and returns its `files` as `{name, mime, size, ref}` (created files also keep `made: true` and `source`) — a save that fails keeps the reply, with the error.
- **Created files expire.** `keepFiles` notes created files in `_made.json` (`{ref: time made}`, sealed; `noteMade`, which restarts a file made again). `expire(days)` deletes the ones made more than `days` ago (0: never) and sets their entry to 0, kept while a chat's index entry lists the ref, so `readFile` and exports can tell an expired file from a lost one; entries whose file is gone otherwise are forgotten. Their messages still list them, opening one says it was deleted, and `source` stays for the model. The hosts run it when the page first loads settings, every hour, and when `files` changes (`expireMade` in `main.js` and `mobile/main.js`). Files an import restores aren't noted, so they're kept.
- **The index lists each chat's files** (`filesOf`: every message and every version). `list` fills in entries written before attachments (no `files` array) by reading their chats once.
- `list` reconciles the index with the files every time: entries whose file is gone are dropped, files missing from the index are added, a damaged index is rebuilt, and corrupt files or id/name mismatches are skipped instead of losing the whole list.
- `save` writes new refs to the index **first** (so a crash before the chat file is written can't leave them to be swept as unused), then the chat file, then the full index entry. `remove` deletes the chat file, writes the index, then sweeps. An interruption between those writes is repaired by the next `list`.
- **The sweep** deletes `a-*.bin` no index entry lists, on the first `list` of each run and after each `remove`. It never deletes a file saved this run (`fresh`), and does nothing when it can't be sure: an index entry from an older version without `files`, a chat file the index doesn't list (it failed to read just now), or any `*.unreadable` file in the folder (the right key may still open it).

## Export and import (`backup.js`)

Settings → Chats exports every chat to a file the user picks, and imports one back. `backup.js` is pure (WebCrypto); the hosts only collect, save and pick files.

- **`collect(chats, withFiles = true)`** loads every listed chat; one it can't read is counted (`missed`), not fatal. With `withFiles` it also reads each chat's files into `files` (ref → base64), up to 200 MB of base64 in all (an export is one string); one it can't read, or that doesn't fit, is left out and counted in `filesMissed`, which the page reports; one expiry deleted (`readFile`'s error code `EXPIRED`) is skipped and not counted; any other missing file still is. The hosts pass `false` for a plain text export.
- **`buildExport(chats, {format, passphrase, names, files})`** gives `{name, mime, text}`:
  - JSON, `javc-chats-YYYY-MM-DD.json`: `{app: 'javc-chatbot', kind: 'chats', version: 1, exported, chats: [full chat objects], files: {ref: base64}}`. Importable.
  - Text, `….txt`: a transcript per chat (title, date, the persona's user and bot names from `names`, the user's attachments as `[image: …]` / `[file: …]` and a reply's as `[file: name]`, no reasoning). For reading only.
  - With a passphrase, always the JSON, locked: `….-protected.json`, `{app, kind: 'chats-encrypted', version: 1, kdf: {name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt}, iv, data}`, AES-256-GCM. Still `.json` and `application/json`, so phone file pickers offer it. The page asks for 8+ characters, typed twice. Locked or plain, the JSON carries `files`.
- **`readExport(text, passphrase)`** checks `app`, `kind` and `version`, unlocks a locked file (a wrong passphrase says so; `iterations` must be 100,000 to 10,000,000, so a crafted file can't hash for minutes), keeps only string values from `files` (ref → base64), and drops chats without a valid id, `messages` array of objects with a string `role` (and `files` an array, if there; `attachments`, on the message and on each of its `versions`, an array of objects with a string `name` and `ref`), a numeric `updated` and a string `title` if there (counted as `skipped`); a locked file of another version says it's newer.
- **`mergeInto(store, got)`** merges, saving the exported files of each chat it saves just before that chat (`store.saveFile`, with `made` for a created file, so the chats' refs match, since the store names a file by its contents); each file once, found by `chats.filesOf`; files of chats it keeps as they are, or that no chat uses, aren't written. The merge: a new id is added; an existing one is replaced only by a newer `updated`; the same id twice in one file keeps the newer. It returns `{added, updated, kept, skipped, ids}`, and the page reloads the open chat if its id is in `ids`, so its in-memory copy can't overwrite the import. Personas aren't exported; an unknown `personaId` shows under Default (`personaIdOf`).
- **Saving:** desktop shows `dialog.showSaveDialog` first (named by `exportName`, so a cancel skips the reading and hashing), then writes the file owner-only, tightening an overwritten file too; phones call the plugin's `saveFile` (Android `ACTION_CREATE_DOCUMENT`, iOS `UIDocumentPickerViewController` for exporting). **Importing** is a plain `<input type=file>` on every platform; the page reads the text and sniffs `kind` to ask for the passphrase.

## Changing a stored format

Add the new field with a default in `finishState` (`profiles.js`) so old files load, keep `version: 2` unless the change can't be read by older code, and add a test in `test.js`. If a version bump is needed, extend `migrate` and `known` together; anything `known` rejects is quarantined, not overwritten.
