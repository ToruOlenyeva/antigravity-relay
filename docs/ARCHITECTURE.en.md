[English](ARCHITECTURE.en.md) | [简体中文](ARCHITECTURE.md)

# Antigravity Relay Architecture Design

This document details the dual-layer channel architecture, full-tier (`Free` / `Plus` / `Pro` / `Ultra` / `GCP`) quota probe matrix, reload-free local transparent reverse proxy routing, automatic port fallback on conflict, dual-layer `thoughtSignature` scrubbing, and HTTP API specifications for Antigravity Relay.

## 1. System Architecture and Runtime Model

This extension operates within the <b>Google Antigravity 2.0</b> desktop client environment and consists of two collaborating components:
- <b>Pre-Invocation Routing & Self-Healing Hook (relay-hook.cjs)</b>: Attached to host `PreInvocation` and `Stop` lifecycle events, ensuring the Sidecar daemon is online before every agent turn and synchronizing the local transparent reverse proxy URL into `language_server.exe` when running in personal channel mode.
- <b>Sidecar Daemon & Visual Control Panel (sidecars/panel/)</b>: Built on a native build-free decoupled frontend/backend architecture, dual-hosting on the host-assigned dynamic port and fixed port `8089`, while bootstrapping the local CloudCode transparent reverse proxy (defaulting to port `8091` with automatic fallback across `8091..8095` and ephemeral ports).

### 1.1 Modular Project Structure

```
antigravity-relay/
├── assets/
│   ├── logo.svg                 # Vector brand logo
│   ├── preview-en.png           # English dark/light dual-window HD preview
│   └── preview-zh.png           # Chinese dark/light dual-window HD preview
├── docs/
│   ├── ARCHITECTURE.en.md       # English architecture design doc
│   └── ARCHITECTURE.md          # Chinese architecture design doc
├── lib/
│   └── proto-scrub.cjs          # Offline Protobuf thoughtSignature scrubbing engine
├── sidecars/
│   └── panel/                   # Native build-free decoupled Sidecar panel
│       ├── bridge/              # Cohesive backend domain sub-modules
│       │   ├── cloudcode-proxy.mjs # Local transparent proxy & dual-bucket routing
│       │   ├── oauth-launcher.mjs  # Isolated OAuth, multi-instance launcher & telemetry
│       │   ├── quota-probe.mjs     # Official dynamic model whitelist & quota probes
│       │   ├── signature-scrub.mjs # Offline SQLite Protobuf signature scrubber
│       │   └── wincred-ls.mjs      # WinCred P/Invoke, multi-client OAuth & LS RPC
│       ├── app.js               # Frontend interaction, custom dropdowns, and sync engine
│       ├── i18n.js              # Strictly isolated English and Chinese dictionary
│       ├── index.html           # Frontend HTML skeleton structure
│       ├── ls-bridge.mjs        # Backend orchestrator and barrel export facade
│       ├── main.mjs             # Backend dual-port HTTP router and SSE broadcaster
│       ├── preload.js           # Host preload script
│       ├── sidecar.json         # Antigravity Sidecar container manifest
│       ├── store.mjs            # Atomic config persistence and stale model sanitizer
│       └── styles.css           # Frontend flat adaptive theme stylesheet
├── agy-relay-config.example.json # Sanitized example configuration file
├── hooks.json                   # Antigravity Hook configuration
├── open-panel.bat               # Standalone window quick launcher script
├── plugin.json                  # Antigravity plugin public manifest
├── relay-hook.cjs               # Session lifecycle Hook interceptor
├── README.en.md                 # English documentation
└── README.md                    # Chinese documentation
```

```
+-----------------------------------------------------------------------+
|                       Google Antigravity 2.0 Host                     |
|  +---------------------------+       +-----------------------------+  |
|  |   language_server.exe     |       |   Auxiliary Pane / 8089     |  |
|  +-------------+-------------+       +--------------+--------------+  |
|                |                                    |                 |
+----------------|------------------------------------|-----------------+
                 | SetCloudCodeURL (Personal Mode)    | HTTP + SSE
                 v                                    v
+-----------------------------------------------------------------------+
|              Antigravity Relay Sidecar (Port 8089 & Proxy)            |
|  +-----------------------------------------------------------------+  |
|  |  Local Transparent Proxy (8091..8095 / Auto Port Fallback)      |  |
|  |  - Dynamically swaps target personal Authorization: Bearer      |  |
|  |  - Strips JSON thoughtSignature in flight to prevent 400 errors |  |
|  |  - Overrides fetchAvailableModels when primary account hits 0%  |  |
|  +-----------------------------------------------------------------+  |
|  |  Full-Tier Quota Probe Engine (Free / Plus / Pro / Ultra / GCP) |  |
|  +-----------------------------------------------------------------+  |
|  |  Isolated OAuth PKCE Flow + Offline SQLite Protobuf Scrubber    |  |
|  +-----------------------------------------------------------------+  |
+-----------------------------------------------------------------------+
```

## 2. Full-Tier Detection Matrix and Three-Pool Quota Probes

### 2.1 Native CloudCode Headers and Three-Pool Retrieval
When `ls-bridge.mjs` requests `/v1internal:fetchAvailableModels` and `/v1internal:retrieveUserQuotaSummary` from `https://daily-cloudcode-pa.googleapis.com`, it sends the exact native `User-Agent` string compiled into `language_server.exe`:
- Only with this native header does CloudCode return all three official quota groups for paid `Pro` and `Ultra` accounts: `Gemini Models` (5-hour + weekly limits), `Claude and GPT Models` (5-hour + weekly limits), and the dedicated third group `Gemini 4 Argon` (`bucketId: "gemini-argon-wtu-weekly"` weekly limit).
- Handling Go `proto3` zero-value omission: when a bucket or model reports `remainingFraction === undefined` alongside a non-empty `resetTime`, the engine accurately evaluates remaining quota as `0%` (exhausted) rather than defaulting to `100%`.

### 2.2 Five-Tier Channel Matrix (`Free` / `Plus` / `Pro` / `Ultra` / `GCP`) & Pure Dynamic Model Whitelist
`detectPersonalAccountTier` and `parseCloudCodeModelsAndQuota` evaluate upstream metadata dynamically without static model templates:
1. <b>`agentModelSorts` Whitelist & `Notice` Grace-Period Preservation</b>: Personal channel probes send `{}` to `/v1internal:fetchAvailableModels`, extracting `agentModelSorts[0].groups[].modelIds` and keeping models that carry `quotaInfo` and are not marked `disabled` or `Unavailable`. Models tagged `tagTitle: "Notice"` (such as `Claude Sonnet 4.6 (Thinking)`, `Claude Opus 4.6 (Thinking)`, and `GPT-OSS 120B (Medium)` on promotional partner Pro plans during their grace period) remain active until upstream flips their tag to `Unavailable`.
2. <b>Multi-Client OAuth Refresh Pool & `refresh_token`-Scoped Isolation</b>: `wincred-ls.mjs` rotates across official OAuth clients when refreshing tokens and propagates a refreshed `access_token` strictly to channels sharing the exact same `refresh_token`, eliminating cross-contamination between `#personal` and `#gcp` channels under the same email.
3. <b>Cross-Talk-Free Multi-Instance Launcher (`+ Multi-Instance`)</b>: `oauth-launcher.mjs` passes `--user-data-dir=<path>` (with `=`) so Chromium switches its `userData` lock directory prior to `app.requestSingleInstanceLock()`, copies `app_storage.json` to bypass the onboarding wizard, and preserves the primary window's `writer_id` while temporarily staging the target channel's credential (preventing `cred_store.go`'s 1-second polling loop from switching the primary window), automatically restoring the primary credential once the new instance logs `Auth succeeded`.

## 3. Dual-Layer Channel Architecture: Primary Reload Switch vs Reload-Free Personal Routing

### 3.1 Layer 1: Primary Channel "Enable" Switch and Offline SQLite Signature Scrubbing
When a user clicks "Enable" on any channel card in the Independent Channel Pool (switching across personal accounts or between `GCP` and personal channels):
1. <b>System Credential Update</b>: Overwrites `StoredToken` and `project_id` inside Windows Credential Manager (`gemini:antigravity`) via Win32 `Advapi32.dll` `CredWriteW`.
2. <b>Lossless Offline Protobuf Signature Scrubbing (`scrubRecentConversationsSignatures`)</b>:
   - Gemini `thought_signature` bytes are cryptographically tied to the originating channel/account; reusing them across channels triggers `INVALID_ARGUMENT (400): Invalid thought signature`.
   - Before restarting the language server, the engine scans the `steps` and `gen_metadata` tables in `~/.gemini/antigravity/conversations/<cascade_id>.db` and recursively strips Protobuf wire fields matching the signature magic prefix (`0x01 0x69 0x14 0x7d 0x13` or Base64 `AWkUfR` / `FpFH0T`), preserving 100% of message text and tool calls.
   - <b>Strict Ban on Pre-Exit `LoadTrajectory`</b>: Never calls `LoadTrajectory` on the outgoing `language_server.exe` process (which would flush stale in-memory signatures back to disk on exit), immediately respawning `language_server.exe` for a clean UI reload.

### 3.2 Layer 2: Local Transparent Reverse Proxy for Reload-Free Personal Routing
When the primary session is on any personal channel (`Free` / `Plus` / `Pro` / `Ultra`), the bottom "Model Compute Routing" panel enables zero-reload cross-account routing (`GCP` channels remain completely isolated from bottom routing):
1. <b>Dynamic `SetCloudCodeURL` Mounting</b>: Both Sidecar and `relay-hook.cjs` invoke the `SetCloudCodeURL` RPC on `language_server.exe` to point upstream requests to `http://127.0.0.1:<proxyPort>` (automatically restoring `https://daily-cloudcode-pa.googleapis.com` whenever a `GCP` channel is active).
2. <b>Per-Model `Bearer Token` Swap and In-Flight JSON Signature Stripping</b>:
   - When `language_server.exe` sends `/v1internal:streamGenerateContent` or `/v1internal:generateContent`, the transparent proxy resolves the requested `model` into its base family (`Gemini 4 Argon`, `Gemini 3.8 Flash`, `Claude Opus 5.5`, etc.).
   - Based on `routing.models[family]` (`follow_current`, `auto_poll`, or `account:<email>#personal`), the proxy selects a target personal channel that supports the model and has `> 0%` quota (`auto_poll` prioritizes the channel with the earliest quota reset time).
   - The proxy replaces the HTTP `Authorization: Bearer <AccessToken>` header in memory, calls `stripThoughtSignaturesFromJson()` to remove all `thoughtSignature` / `thought_signature` fields from the JSON request body, forwards the stream to `daily-cloudcode-pa.googleapis.com`, and asynchronously refreshes the target account's quota 2 seconds after stream completion.
3. <b>Intercepting `/v1internal:fetchAvailableModels` to Prevent `0%` UI Lockout</b>:
   - When the currently active personal account hits `0%` quota on a model (or lacks access on a `Plus` / `Free` tier) while that model is routed to another personal channel with remaining quota (or `auto_poll`), the proxy injects the routed personal channel's `remainingFraction` into `fetchAvailableModels` before returning to `language_server.exe`, preventing the client UI from disabling the model selector.

### 3.3 Transparent Proxy Port Conflict Fallback (`8091..8095` + Ephemeral Port)
To guarantee reload-free routing even if default port `8091` is occupied by third-party software, the proxy implements a four-step fallback mechanism:
1. <b>Health Fingerprint Endpoint (`GET /__agy_proxy_ping`)</b>: The proxy exposes a dedicated health check returning `{"ok":true,"service":"antigravity-relay-proxy","port":<actualPort>}`.
2. <b>Homologous Reuse and Sequential Fallback</b>: `ensureCloudCodeProxyServer()` iterates through candidate ports `[8091, 8092, 8093, 8094, 8095, 0]`. On `EADDRINUSE`, it queries `/__agy_proxy_ping` on that port—reusing the existing instance if it belongs to Antigravity Relay, or advancing to the next candidate port (down to `0` for an OS-assigned ephemeral port) if occupied by another application.
3. <b>Config Persistence and Dynamic Propagation</b>: The bound proxy URL `http://127.0.0.1:<actualPort>` is persisted to `__meta__.cloudCodeProxyUrl` in `agy-relay-config.json` and read dynamically via `getActiveCloudCodeProxyUrl(cfg)` across both `ls-bridge.mjs` and `relay-hook.cjs`.

## 4. HTTP API Specifications

All endpoints are served identically from both the host-assigned internal Sidecar port and `http://127.0.0.1:8089`.

### 4.1 Get Live System Snapshot and Quota State
- <b>Route</b>: `GET /api/status`
- <b>Query Parameters</b>: `force=1` (optional, bypasses cache to probe live upstream quotas across all channels)
- <b>Response</b>: Full JSON snapshot containing `lsOnline`, `activeAccount`, `availableModels`, `quotaGroups`, `accounts`, `routing`, and `oauthPending`.

### 4.2 Real-Time State Broadcast Stream (SSE)
- <b>Route</b>: `GET /api/events`
- <b>Content-Type</b>: `text/event-stream; charset=utf-8`
- <b>Description</b>: Broadcasts updated snapshots in `0ms` across all open panels whenever quotas refresh, OAuth completes, or channel states change.

### 4.3 Channel and Account Management Endpoints
- <b>Save Currently Logged-In Account</b>: `POST /api/save-current-account`
- <b>Start Isolated OAuth Login</b>: `POST /api/add-account-oauth`
- <b>Cancel Pending OAuth Login</b>: `POST /api/cancel-oauth`
- <b>Discover Accessible GCP Projects</b>: `POST /api/discover-gcp-projects` (Payload: `{ "email": "user@gmail.com" }`)
- <b>Add Independent Channel (Personal or GCP)</b>: `POST /api/add-gcp-channel` (Payload includes `email`, `channelType`, `gcpProjectId`, `gcpBillingMode`, `gcpLocation`)
- <b>Enable Target Channel (Reloads Primary Session)</b>: `POST /api/switch-account` (Payload: `{ "channelId": "user@gmail.com#personal" }`)
- <b>Remove Target Channel</b>: `POST /api/remove-account` (Payload: `{ "channelId": "user@gmail.com#personal" }`)
- <b>Probe Non-Active Channel Quota</b>: `POST /api/probe-channel-quota` (Payload: `{ "channelId": "user@gmail.com#personal", "force": false }`)

### 4.4 Model Routing and Localization Endpoints
- <b>Update Model Compute Route</b>: `POST /api/set-route` (Payload: `{ "targetType": "models", "key": "Gemini 3.8 Flash", "routeValue": "auto_poll" }`)
- <b>Switch UI Language and Persist Metadata</b>: `POST /api/set-language` (Payload: `{ "lang": "zh" }` or `{ "lang": "en" }`)
