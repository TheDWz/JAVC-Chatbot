<div align="center">

<img src="build/icon.png" alt="JAVC Chatbot logo" width="128" height="128">

# JAVC Chatbot

**A fast, private desktop client for any OpenAI-compatible API.**

[![License: GPL v3](https://img.shields.io/badge/license-GPL--3.0-6d28d9?style=flat-square)](LICENSE)
[![Platforms](https://img.shields.io/badge/platform-Linux%20%7C%20Windows-4f46e5?style=flat-square)](#download)
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
- **Chat history.** Every conversation is saved locally and grouped by persona. You can duplicate a chat to another persona.
- **Attachments.** Drop in text files, PDFs (text is extracted on your machine) or images for vision models.
- **Rich replies.** Full Markdown: headings, tables, task lists and code blocks with a copy button. When a model writes HTML, CSS or JavaScript, it runs live inside the reply in a locked-down sandbox, with a full-window view.
- **Model picker.** Fetch your provider's model list and search it as you type.
- **Dark and light themes.** These follow your system setting.

## Download

Prebuilt packages are produced by [GitHub Actions](https://github.com/TheDWz/JAVC-Chatbot/actions/workflows/build.yml) for every tagged release.

| Platform | Package | Install |
| :-- | :-- | :-- |
| Linux, any distro | `JAVC-Chatbot-<version>.AppImage` | `chmod +x JAVC-Chatbot-*.AppImage && ./JAVC-Chatbot-*.AppImage` |
| Debian / Ubuntu | `javc-chatbot_<version>_amd64.deb` | `sudo apt install ./javc-chatbot_*_amd64.deb` |
| Fedora / RHEL | `javc-chatbot-<version>.x86_64.rpm` | `sudo dnf install ./javc-chatbot-*.x86_64.rpm` |
| Linux, portable | `javc-chatbot-<version>.tar.gz` | Extract and run `./javc-chatbot` |
| Windows 10 / 11 | `JAVC-Chatbot-Setup-<version>.exe` | Run the installer (per-user, no admin needed) |

> [!NOTE]
> The Windows installer isn't code-signed yet, so SmartScreen may show "Windows protected your PC". Choose **More info → Run anyway**.
> On distros that restrict unprivileged user namespaces (for example Ubuntu 24.04), the AppImage and tar.gz builds may need `--no-sandbox`. The `.deb` and `.rpm` packages don't.

## Getting started

1. **Add a profile.** On first launch, choose a provider template or **Custom**, then paste your API key. Local servers such as Ollama (`http://localhost:11434/v1`) or LM Studio (`http://localhost:1234/v1`) don't need a key.
2. **Pick a model.** Click the refresh button to fetch the model list, then search and select one.
3. **Chat.** Press <kbd>Enter</kbd> to send and <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line. Drag files onto the window to attach them.

Click the assistant's avatar on any reply to open its reasoning. The sliders button opens chat options, including the reasoning level and the **Rich replies** switch.

## Privacy & security

- **No telemetry.** The app only talks to the API endpoint you configure.
- **Encrypted keys.** API keys are encrypted with your OS keychain through Electron's `safeStorage` and are only ever sent to your provider. On a Linux desktop with no keyring, the key is stored in a file only your user can read.
- **Local data.** Settings and chats are stored in plain files on your machine:
  - Linux: `~/.config/javc-chatbot/`
  - Windows: `%APPDATA%\javc-chatbot\`
  - Settings and chats from an older `chatbot` folder are moved here automatically on first launch.
- **Sandboxed rich content.** Model-written HTML runs in an isolated frame. It can't see the app, your keys, your chats or your files, and it's denied camera, microphone, location and other permissions. It *can* load resources from the internet, for example chart libraries from a CDN. You can turn rich replies off in chat options.
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
npm run dist:linux   # AppImage, .deb, .rpm and .tar.gz in dist/
npm run dist:win     # Windows installer in dist/
npm run dist         # both
```

- Building the `.rpm` needs `rpmbuild` (`sudo dnf install rpm-build` or `sudo apt install rpm`).
- `dist:win` is meant to run on Linux. It needs Wine and a Bash shell.
- **Continuous integration:** pushing a `v*` tag, or running the **Build packages** workflow manually, builds every package on GitHub-hosted Linux and Windows runners and attaches them to the workflow run.

### Project layout

| Path | Purpose |
| :-- | :-- |
| `main.js` | Electron main process: window, IPC, settings and chat storage, rich-content sandbox |
| `preload.js` | The narrow bridge between the page and the main process |
| `index.html` / `renderer.js` | User interface |
| `lib.js` | Shared pure logic: prompts, attachments, model search, rich-reply splitting |
| `api.js` | OpenAI-compatible streaming client and reasoning support |
| `profiles.js` / `store.js` | Connection profiles, personas and encrypted settings |
| `chats.js` | Chat history on disk |
| `test.js` | Test suite (`node --test`) |
| `build/` | App icon and its generator script |

## License

JAVC Chatbot is free software, released under the [GNU General Public License v3.0 or later](LICENSE).

<div align="center">
<sub>© TheDWz</sub>
</div>
