[English](README.en.md) | [简体中文](README.md)

<div align="center">
  <img src="assets/logo.svg" alt="Antigravity Relay Logo" width="72" height="72" />
  <h1>Antigravity Relay</h1>
  <p>
    <b>Native Multi-Account Quota Monitor, Channel Pool & Reload-Free Model Router for Google Antigravity 2.0</b><br>
    Full-tier detection (Free / Plus / Pro / Ultra / GCP), real-time quota telemetry, zero-interruption OAuth login, and seamless cross-account model routing.
  </p>
  <p>
    <a href="https://antigravity.google/"><img src="https://img.shields.io/badge/Google%20Antigravity%202.0-Plugin-4285F4?style=flat-square&logo=google&logoColor=white" alt="Google Antigravity 2.0 Plugin" /></a>
    <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%3E%3D%2018-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
    <a href="docs/ARCHITECTURE.en.md"><img src="https://img.shields.io/badge/Dependencies-Zero-brightgreen?style=flat-square" alt="Zero Dependencies" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-orange?style=flat-square" alt="MIT License" /></a>
    <a href="https://github.com/ToruOlenyeva/antigravity-relay/stargazers"><img src="https://img.shields.io/github/stars/ToruOlenyeva/antigravity-relay?style=flat-square&logo=github" alt="GitHub Stars" /></a>
  </p>
</div>

> <b>Eliminate single-account quota anxiety and cross-channel signature errors</b>: Purpose-built for <b>Google Antigravity 2.0</b>. Manage multiple personal accounts (<code>Free</code> / <code>Plus</code> / <code>Pro</code> / <code>Ultra</code>) alongside <code>GCP</code> cloud project channels, featuring real-time three-pool quota telemetry, isolated OAuth PKCE login, dual-layer <code>thoughtSignature</code> scrubbing, and zero-reload cross-account model routing.

<div align="center">
  <img src="assets/preview-en.png" width="840" alt="Antigravity Relay Preview" />
</div>

---

## ✨ Key Features

- <b>Full-Tier Detection & Quota Telemetry</b>: Powered by native Language Server and CloudCode probes to accurately classify <code>Free</code>, <code>Plus</code> (including promotional partner plans), <code>Pro</code>, <code>Ultra</code>, and <code>GCP</code> channels, displaying <code>Gemini Models</code>, <code>Claude and GPT Models</code>, and <code>Gemini 4 Argon</code> weekly/5-hour quota rings with live reset countdowns.
- <b>Reload-Free Personal Channel Routing</b>: Built-in local transparent reverse proxy (defaulting to port <code>8091</code> with automatic fallback across <code>8091..8095</code> and OS ephemeral ports) dynamically swaps the target personal account's <code>Bearer Token</code> per model family without reloading the UI or interrupting active chats.
- <b>Reset-First Smart Auto-Polling</b>: Configure each model to "Follow Current Channel", pin a specific personal account, or "Auto-Poll Available Channels" (prioritizing personal channels with remaining quota that reset soonest, while automatically unlocking models in the UI when the primary account hits <code>0%</code>).
- <b>Signature Badge Detection & Dual-Mode Scrubbing</b>: Detects and badges each conversation's thought signature origin (<code>GCP</code> / <code>Personal</code> / <code>No Sig</code>) in real time, providing a dual-mode "Clear Sig" menu (scrub current session only vs scan project for mismatched signatures) alongside in-flight proxy stripping to eliminate <code>Invalid thought signature (400)</code> errors.
- <b>One-Click Session Stats & Project Summary Toggle</b>: Reads official <code>transcript.jsonl</code> token telemetry directly, allowing instant toggle button switching between "Current Session Stats" (with per-conversation selector) and "Project Summary" (aggregating total tokens, prefix cache hits, and per-model breakdown across the entire project).
- <b>Isolated Multi-Instance, Quad-Store Auth Sync & Dual-Channel Interlock</b>: Launch isolated Personal or <code>GCP</code> instances via <code>+ Multi-Instance</code> (automatically interlocking cross-channel switches when both channels are active); channel switching performs Antigravity 2.29+ quad-store auth sync (<code>WinCred</code> + <code>state.vscdb</code> Protobuf Sentinel + <code>app_storage.json</code> + <code>auth_method</code> isolation) and per-instance auto-restart.
- <b>Zero-Interruption OAuth Login & Non-Intrusive GCP Discovery</b>: Launches official Google OAuth 2.0 + PKCE S256 on an isolated callback port, derives <code>GCP</code> channels from saved tokens with on-demand project discovery, and dual-hosts on the dynamic Sidecar port and fixed port <code>8089</code>.

---

## 🔄 Core Workflow

```mermaid
flowchart TD
    A["User Sends Prompt / Invokes Subagent"] --> B{"Active Primary Channel Type"}
    B -- "Personal Channel (Free / Plus / Pro / Ultra)" --> C["SetCloudCodeURL Mounts Local Transparent Proxy (8091..8095)"]
    C --> D["Match Per-Model Routing Rule (Follow Current / Auto-Poll / Pinned Account)"]
    D --> E["Swap Target Personal Bearer Token in Memory + Strip JSON thoughtSignature"]
    E --> F["Zero-Reload CloudCode Streaming & Async Target Quota Refresh"]
    B -- "Click Enable to Switch Primary Channel (Including GCP <-> Personal)" --> G["Update WinCred + Offline SQLite Protobuf Signature Scrub + Reload LS"]
```

---

## 🚀 Quick Installation

Built with native Node.js and <b>Zero Dependencies</b>. Clone and run immediately without executing <code>npm install</code>.

### 1. Clone into Antigravity Plugins Directory

<b>macOS / Linux</b>:
```bash
git clone https://github.com/ToruOlenyeva/antigravity-relay.git ~/.gemini/config/plugins/antigravity-relay
```

<b>Windows (PowerShell)</b>:
```powershell
git clone https://github.com/ToruOlenyeva/antigravity-relay.git "$env:USERPROFILE\.gemini\config\plugins\antigravity-relay"
```

<b>Windows (CMD)</b>:
```cmd
git clone https://github.com/ToruOlenyeva/antigravity-relay.git %USERPROFILE%\.gemini\config\plugins\antigravity-relay
```

### 2. Enable and Launch

Restart Google Antigravity or enable "Account & Quota Manager" in the Antigravity Plugins settings tab to open the panel in the right Auxiliary Pane.

---

## 📂 Modular Project Structure

```
antigravity-relay/
├── assets/                      # Brand vector logo and bilingual HD previews
├── docs/                        # Deep technical architecture documentation
├── lib/
│   └── proto-scrub.cjs          # Offline Protobuf thoughtSignature scrubbing engine
├── sidecars/
│   └── panel/                   # Native build-free decoupled Sidecar panel
│       ├── app.js               # Frontend interaction, custom dropdowns, and sync engine
│       ├── i18n.js              # Strictly isolated English and Chinese dictionary
│       ├── index.html           # Responsive frontend HTML skeleton
│       ├── ls-bridge.mjs        # Backend LS RPC, transparent proxy, WinCred & OAuth engine
│       ├── main.mjs             # Backend dual-port HTTP router and SSE broadcaster
│       ├── preload.js           # Host preload bridge script
│       ├── sidecar.json         # Sidecar container manifest
│       ├── store.mjs            # Atomic config persistence and legacy model sanitizer
│       └── styles.css           # Flat adaptive dark and light theme stylesheet
├── agy-relay-config.example.json # Sanitized example configuration file
├── hooks.json                   # Antigravity lifecycle Hook manifest
├── open-panel.bat               # Standalone window quick launcher script
├── plugin.json                  # Plugin public manifest
├── relay-hook.cjs               # Pre-invocation routing guard and Sidecar self-healer
├── README.en.md                 # English documentation
└── README.md                    # Chinese documentation
```

---

## 📖 Usage Guide

### 1. Real-Time Quota Monitoring, Session/Project Toggle & Dual-Mode Signature Scrub
Open the "Account & Quota" tab in the right Auxiliary Pane:
- The top "Session & Usage" selector tracks the current instance's active channel by default (marked with a green dot) and lets you inspect any saved channel's live quota rings and reset countdowns with <code>Free</code>, <code>Plus</code>, <code>Pro</code>, <code>Ultra</code>, and <code>GCP</code> badges.
- Click the toggle button inside the telemetry card to switch between "Session Stats" (with per-conversation selector and live <code>Sig: GCP</code> / <code>Sig: Personal</code> / <code>Sig: None</code> badge) and "Project Summary", or click "Clear Sig" to scrub either the current conversation or all mismatched project signatures.

### 2. Independent Channel Pool, Quad-Store Auth Sync & Isolated Multi-Instance
- <b>Save Current / + Add Account</b>: Capture the currently logged-in credential with one click, or launch the isolated Google OAuth flow in your browser without interrupting active chats.
- <b>+ Add Channel & Quad-Store Switch</b>: Derive personal or <code>GCP</code> channels from saved accounts (with "Auto Scan" project ID discovery); clicking "Enable" performs quad-store auth sync and automatically restarts the target instance on cross-channel switches.
- <b>+ Multi-Instance & Dual-Channel Interlock</b>: Click <code>+ Multi-Instance</code> to launch a second isolated instance (when Personal and <code>GCP</code> instances run simultaneously, cross-channel switches are automatically interlocked and unavailable action buttons are hidden).

### 3. Reload-Free Personal Model Routing & Auto-Polling
- The bottom "Model Compute Routing" section aggregates all available models across your personal channels (<code>Free</code> / <code>Plus</code> / <code>Pro</code> / <code>Ultra</code>), keeping <code>GCP</code> channels completely independent.
- Assign any model to "Auto-Poll Available Channels" or a specific personal account to transparently route foreground prompts and subagent calls through the local proxy without reloading the window.

### 4. Standalone Window Mode
When working with the Auxiliary Pane collapsed, double-click <code>open-panel.bat</code> or visit <code>http://127.0.0.1:8089</code> in any modern browser to monitor quotas and manage routing in a standalone app window.

---

## 📚 Documentation Matrix

| Module | Description & Technical Details | Link |
| :--- | :--- | :--- |
| <b>System Architecture</b> | Full-tier detection matrix, reload-free transparent proxy, port fallback, dual-layer signature scrubbing, and API specs | [View Architecture](docs/ARCHITECTURE.en.md) |
| <b>Example Configuration</b> | Sanitized JSON template demonstrating multi-tier personal channels, GCP channels, and model routing rules | [View Example Config](agy-relay-config.example.json) |

---

## 🤝 Contributors & Credits

- <b>[Toru Olenyeva](https://github.com/ToruOlenyeva)</b>
- <b>[Google Antigravity](https://antigravity.google/)</b>

---

## 📄 License

This project is licensed under the [<b>MIT License</b>](LICENSE).
