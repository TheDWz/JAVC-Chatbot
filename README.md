<div align="center">

<img src="build/icon.png" alt="JAVC Chatbot logo" width="128" height="128">

# JAVC Chatbot

**A fast, private client for any OpenAI-compatible API, on Linux, Windows, Android and iOS.**

[![License: GPL v3](https://img.shields.io/badge/license-GPL--3.0-6d28d9?style=flat-square)](LICENSE)
[![Platforms](https://img.shields.io/badge/platform-Linux%20%7C%20Windows%20%7C%20Android%20%7C%20iOS-4f46e5?style=flat-square)](#download)
[![Electron](https://img.shields.io/badge/Electron-45-2563eb?style=flat-square&logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Build](https://img.shields.io/github/actions/workflow/status/TheDWz/JAVC-Chatbot/build.yml?style=flat-square&label=build)](https://github.com/TheDWz/JAVC-Chatbot/actions/workflows/build.yml)

[Features](#features) · [Download](#download) · [Getting started](#getting-started) · [Privacy](#privacy--security) · [Build from source](#build-from-source)

<br>

<img src="docs/screenshot.png" alt="JAVC Chatbot showing a reply with Markdown and a live chart" width="900">

</div>

---

## Features

- **Any OpenAI-compatible provider.** OpenRouter, NanoGPT, Venice, OpenAI, or a local server like Ollama or LM Studio. Built-in templates fill in the endpoint for you.
- **Streaming replies.** Answers appear as they're written. Stop at any time and keep what's been generated so far.
- **Live reasoning.** Watch a reasoning model think in real time, and choose how hard it thinks.
- **Connection profiles.** Save several endpoint, key and model combinations and switch between them in one click. Keys are encrypted by your operating system.
- **Personas.** Give the assistant a name, a personality and a system prompt. Each persona keeps its own chat history.
- **Long chats.** When a chat nears the model's context limit, its older messages are summarized so it can keep going, and they stay on screen. Choose the summary model in Settings → Summaries, or per persona. The limit comes from your provider's model list (300K tokens when it doesn't say, or your own number).
- **Chat history.** Every conversation is saved locally and grouped by persona. You can duplicate a chat to another persona.
- **Attachments.** Drop in text files, PDFs (text is extracted on your machine) or images for vision models.
- **Rich replies.** Full Markdown: headings, tables, task lists and code blocks with a copy button. When a model writes HTML, CSS or JavaScript, it runs live inside the reply in a locked-down sandbox, with a full-window view. Markdown, HTML, CSS and JavaScript can each be switched off.
- **Web search.** Let the model look things up with [Linkup](https://www.linkup.so). It decides when to search and answers from the results. Needs a Linkup API key (Settings → Search) and a model that supports tools.
- **MCP tools.** Give the model tools from [MCP](https://modelcontextprotocol.io) servers, such as the ones for Blender, Godot or Unity. Paste the same `mcpServers` JSON you would give Claude (Settings → Tools), and allow each tool call before it runs.
- **Model picker.** Fetch your provider's model list and search it as you type.
- **Themes.** Six accent gradients (Aurora purple-to-blue is the default) or your own two colors, in dark or light mode following your system setting.
- **One settings panel.** Appearance, connection profiles and reply formats in one place, opened from the gear.
- **Phone-ready.** The Android and iOS apps are the same app, with a layout that fits a phone screen (and, on Android, the back button closing whatever is open).

## Download

Prebuilt packages are produced by [GitHub Actions](https://github.com/TheDWz/JAVC-Chatbot/actions/workflows/build.yml) for every tagged release.

| Platform | Package | Install |
| :-- | :-- | :-- |
| Linux, any distro | `JAVC-Chatbot-<version>.AppImage` | `chmod +x JAVC-Chatbot-*.AppImage && ./JAVC-Chatbot-*.AppImage` |
| Debian / Ubuntu | `javc-chatbot_<version>_amd64.deb` | `sudo apt install ./javc-chatbot_*_amd64.deb` |
| Fedora / RHEL | `javc-chatbot-<version>.x86_64.rpm` | `sudo dnf install ./javc-chatbot-*.x86_64.rpm` |
| Linux, portable | `javc-chatbot-<version>.tar.gz` | Extract and run `./javc-chatbot` |
| Windows 10 / 11 | `JAVC-Chatbot-Setup-<version>.exe` | Run the installer (per-user, no admin needed) |
| Android 8.0 or later | `JAVC-Chatbot-<version>.apk` | Open the file on your phone and allow your browser or file manager to install apps |
| iOS / iPadOS 17.5 or later | `JAVC-Chatbot-<version>.ipa` | Sign and install it with [Sideloadly](https://sideloadly.io/), [AltStore](https://altstore.io/) or another signing tool |

> [!NOTE]
> The Windows installer isn't code-signed yet, so SmartScreen may show "Windows protected your PC". Choose **More info → Run anyway**.
> On distros that restrict unprivileged user namespaces (for example Ubuntu 24.04), the AppImage and tar.gz builds may need `--no-sandbox`. The `.deb` and `.rpm` packages don't.
>
> The Android app isn't on the Play Store, so Android asks you to allow installs from the app you open the APK with. It needs an up-to-date **Android System WebView** (version 123 or later), which the Play Store keeps updated on most phones; if yours is too old, the app tells you and links to the update.
>
> The iOS app isn't on the App Store and the `.ipa` is **unsigned**: your signing tool signs it with your own Apple ID when it installs it. With a free Apple ID, iOS stops apps signed that way after 7 days unless the tool refreshes them (AltStore does this for you). Saved API keys are encrypted with a key in the iPhone's Keychain that belongs to the signer, so if you re-sign the app with a *different* Apple ID, the app asks you to type your keys again; your chats and other settings stay.

## Getting started

1. **Add a profile.** On first launch, choose a provider template or **Custom**, then paste your API key. Local servers such as Ollama (`http://localhost:11434/v1`) or LM Studio (`http://localhost:1234/v1`) don't need a key.
2. **Pick a model.** Click the refresh button to fetch the model list, then search and select one.
3. **Chat.** Press <kbd>Enter</kbd> to send and <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line. Drag files onto the window to attach them.
   On Android, <kbd>Enter</kbd> starts a new line and the send button sends; attach files with the paperclip. A local server on your computer is reached by its network address (for example `http://192.168.1.20:11434/v1` for Ollama started with `OLLAMA_HOST=0.0.0.0`), not `localhost`.

Click the assistant's avatar on any reply to open its reasoning. The brain button next to the paperclip sets the reasoning level, and **⋯ → Stats for nerds** shows time to first token, tokens per second and token counts for the chat. The gear opens **Settings**: pick a theme, manage connection profiles, set up web search, set up MCP servers, and choose which reply formats (Markdown, HTML, CSS, JavaScript) are shown.

## MCP servers

Settings → Tools takes the same `mcpServers` JSON you would give Claude, and offers the servers' tools to the model. The editor's own plugin or addon still has to be installed in the editor.

```json
{
  "mcpServers": {
    "godot": { "command": "npx", "args": ["-y", "@npgamedev/godot-mcp-server"] }
  }
}
```

```json
{ "mcpServers": { "blender": { "command": "uvx", "args": ["blender-mcp"] } } }
```

- **Approval.** Every tool call shows a dialog first: **Deny**, **Allow once** or **Always allow**. <kbd>Esc</kbd> or the back button denies. "Always allow" is remembered per server and tool, and forgotten if that server's entry changes.
- **Local servers run on the desktop.** Servers with a `command` run as child processes of the desktop app. `npx` and `uvx` are found through your login shell's `PATH`, so nvm and `~/.local/bin` installs work even when the app is started from the desktop menu.
- **Remote servers** use Streamable HTTP: `{"mcpServers": {"name": {"type": "http", "url": "https://…/mcp", "headers": {"Authorization": "Bearer …"}}}}`. They work on the desktop and on Android. `headers` is optional. A server that needs a browser sign-in (OAuth) shows a **Sign in** button in Settings → Tools; the app registers itself with that server and keeps the sign-in encrypted.
- **Other forms.** A bare `{"name": {...}}` object, or a single entry on its own, works too.
- **Limits.** The model must support tools. Tool results aren't saved with the chat, so later turns see only the model's answer.

## Privacy & security

- **No telemetry.** The app only talks to the API endpoint you configure. The one exception is web search, which is off until you turn it on: then the queries the model writes are sent to Linkup (linkup.so) with your Linkup key. MCP servers you add run on your computer with your user's permissions and talk to whatever they're built for; the model can only use their tools after you allow each call.
- **Encrypted keys.** API keys (including the Linkup key) are encrypted with your OS keychain through Electron's `safeStorage` and are only ever sent to the service they belong to: your provider, or Linkup for the search key. The MCP server config is encrypted the same way, since its `env` and `headers` often hold tokens. On a Linux desktop with no keyring, the key is stored in a file only your user can read. On Android, keys are encrypted with a key held by the Android Keystore, which never leaves the device. On iOS, they are encrypted with a key kept in the Keychain for this device only.
- **Local data.** Settings and chats are stored in plain files on your machine:
  - Linux: `~/.config/javc-chatbot/`
  - Windows: `%APPDATA%\javc-chatbot\`
  - Android: the app's private storage, which other apps can't read. It's left out of cloud backups, and uninstalling the app deletes it.
  - iOS: the app's private storage, likewise left out of iCloud and computer backups and deleted with the app.
  - Settings and chats from an older `chatbot` folder are moved here automatically on first launch.
- **Sandboxed rich content.** Model-written HTML runs in an isolated frame. It can't see the app, your keys, your chats or your files, and it's denied camera, microphone, location and other permissions. It *can* load resources from the internet, for example chart libraries from a CDN. You can turn HTML, or just its CSS and JavaScript, off in Settings → Replies.
- **No tracking pixels.** Remote images in Markdown are never loaded automatically. They show as links instead.

## Build from source

You'll need [Node.js](https://nodejs.org/) 24 and npm.

```bash
git clone https://github.com/TheDWz/JAVC-Chatbot.git
cd JAVC-Chatbot
npm ci          # install dependencies
npm start       # run the app
npm test        # run the test suite
```

### Packaging

```bash
npm run dist:linux     # AppImage, .deb, .rpm and .tar.gz in dist/
npm run dist:win       # Windows installer in dist/
npm run dist           # both
npm run dist:android   # Android APK in dist/
npm run dist:ios       # unsigned iOS .ipa in dist/ (macOS with Xcode only)
```

- Building the `.rpm` needs `rpmbuild` (`sudo dnf install rpm-build` or `sudo apt install rpm`).
- `dist:win` is meant to run on Linux. It needs Wine and a Bash shell.
- **Continuous integration:** pushing a `v*` tag, or running the **Build packages** workflow manually, builds every package on GitHub-hosted runners and attaches them to the workflow run. The Android APK is also installed on an emulator and tested there: a profile, a streamed reply, a rich reply, PDF text, the back button and the encrypted key on disk. The iOS app runs a built-in self-test on a simulator, which also checks that model-written HTML can't reach the app's native code.

### Android

The Android app is a [Capacitor](https://capacitorjs.com/) shell around the same page. `mobile/` provides `window.api` in place of `preload.js`, and a small native plugin in `android/` handles what a WebView can't do safely. That covers streaming HTTP without browser CORS limits, private files, Keystore encryption and the rich-reply sandbox.

You'll need [JDK 21](https://adoptium.net/) and the Android SDK (with [Android Studio](https://developer.android.com/studio), or set `ANDROID_HOME`).

```bash
npm run android:sync          # build www/ and copy it into android/
npx cap open android          # open the project in Android Studio to run it on a phone or emulator
npm run dist:android:debug    # or build a debug APK from the command line
```

After changing `index.html`, `renderer.js` or anything the app loads, run `npm run android:sync` again.

### iOS

The iOS app is the same Capacitor shell, with the native plugin in Swift (`ios/App/App/JavcPlugin.swift`). `MainViewController.swift` serves the rich-reply sandbox and makes sure only the app's own page, never a rich-reply frame, can call the plugin. Building needs a Mac with Xcode; GitHub Actions builds the `.ipa` on a macOS runner.

```bash
npm run ios:sync              # build www/ and copy it into ios/
npx cap open ios              # open the project in Xcode to run it on a simulator or a phone
npm run dist:ios              # or build the unsigned .ipa from the command line
```

The simulator self-test is `node mobile/build.mjs --selftest && npx cap sync ios && node mobile/ipa.mjs --simulator`, then `node mobile/smoke/ios.mjs ios/build/sim/Build/Products/Debug-iphonesimulator/App.app`. It drives the app against a mock API and prints each check.

### Release signing

Android only installs an update over an existing app if both are signed with the same key. Without one, CI signs the APK with a throwaway key: it installs, but the next build can't be installed over it without uninstalling first, which deletes the app's chats and settings. Create a key once and keep it safe, since losing it means users have to reinstall:

```bash
keytool -genkeypair -v -keystore javc-release.jks -alias javc -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 javc-release.jks   # on macOS: base64 -i javc-release.jks
```

Then add these repository secrets (**Settings → Secrets and variables → Actions**):

| Secret | Value |
| :-- | :-- |
| `ANDROID_KEYSTORE_BASE64` | the base64 output above |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
| `ANDROID_KEY_ALIAS` | `javc` (or the alias you chose) |
| `ANDROID_KEY_PASSWORD` | the key password (the same as the keystore password unless you set a different one) |

To sign a local build, set the same names as environment variables, with `ANDROID_KEYSTORE_FILE` pointing to the `.jks` file instead of the base64 secret.

### Project layout

| Path | Purpose |
| :-- | :-- |
| `main.js` | Electron main process: window, IPC, rich-content sandbox |
| `preload.js` | The narrow bridge between the page and the main process |
| `index.html` / `renderer.js` | User interface, shared by the desktop and phone apps |
| `lib.js` | Shared pure logic: prompts, attachments, model search, rich-reply splitting and sandbox pages |
| `api.js` | OpenAI-compatible streaming client and reasoning support |
| `mcp.js` | MCP client: reads the pasted config, runs local servers, connects to remote ones and offers their tools to the model |
| `profiles.js` / `store.js` | Connection profiles, personas and encrypted settings |
| `chats.js` | Chat history |
| `disk.js` | Desktop file access for settings and chats, and the move from the old `chatbot` folder |
| `mobile/` | Phones: `window.api` on top of the native plugin, the web, APK and IPA build scripts, and the emulator and simulator tests |
| `android/` | Android project (Capacitor), with the native plugin in `JavcPlugin.java` |
| `ios/` | iOS project (Capacitor), with the native plugin in `JavcPlugin.swift` and the sandbox and bridge guard in `MainViewController.swift` |
| `capacitor.config.json` | The phone apps' id and name |
| `test.js` | Test suite (`node --test`) |
| `build/` | App icon and the scripts that generate the desktop, Android and iOS icons |

## License

JAVC Chatbot is free software, released under the [GNU General Public License v3.0 or later](LICENSE).

<div align="center">
<sub>© TheDWz</sub>
</div>
