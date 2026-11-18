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
│       │   ├── channel-catalog.mjs   # Tier detection, API error parsing, model catalog & normalization
│       │   ├── cloudcode-discovery.mjs # CloudCode API transport, GCP project discovery & response parsing
│       │   ├── cloudcode-proxy.mjs   # Local transparent proxy, rewrite & 429 failover
│       │   ├── oauth-launcher.mjs    # Isolated OAuth, multi-instance launcher & telemetry
│       │   ├── quota-probe.mjs       # Multi-channel probe orchestrator, error merge & 600s cooldown
│       │   ├── route-selector.mjs    # Model family resolver & two-layer personal router
│       │   ├── signature-scrub.mjs   # Offline SQLite Protobuf signature scrubber
│       │   └── wincred-ls.mjs        # WinCred P/Invoke, multi-client OAuth & LS RPC
│       ├── app.js               # Frontend interaction, custom dropdowns, and sync engine
│       ├── i18n.js              # Strictly isolated English and Chinese dictionary
│       ├── index.html           # Frontend HTML skeleton structure
│       ├── ls-bridge.mjs        # Backend orchestrator and barrel export facade
│       ├── main.mjs             # Backend dual-port HTTP router and SSE broadcaster
│       ├── preload.js           # Host preload script
│       ├── sidecar.json         # Antigravity Sidecar container manifest
│       ├── store.mjs            # Atomic config persistence and stale model sanitizer
│       ├── styles.css           # Frontend flat adaptive theme stylesheet
│       ├── ui-channels-drawers.js # Channel cards, expandable error drawer, re-login & action views
│       └── ui-session-quota.js  # Session telemetry, project total & quota ring view
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

## 2. Full-Tier Detection Matrix, Quota Probes & Structured Error Diagnosis

### 2.1 Dynamic Client Version Handshake, LoadCodeAssist Fallback & Daily Quota Retrieval
`wincred-ls.mjs` and `cloudcode-discovery.mjs` / `quota-probe.mjs` extract the live client version from `language_server.log` (e.g., `Language server version: 2.29.0`, adapting automatically to client upgrades with zero hardcoding) and pass `{ ideType: "JETSKI", ideVersion: "<clientVersion>", pluginType: "GEMINI", platform: "WINDOWS_AMD64" }` to `/v1internal:loadCodeAssist` (querying `https://cloudcode-pa.googleapis.com` first for personal accounts and automatically falling back to `https://daily-cloudcode-pa.googleapis.com` on non-200 or empty responses) to acquire a dedicated companion project ID (avoiding the `"aicode-consumers"` downgraded pool 429 trap). Personal quota retrieval then targets the Daily ledger (`https://daily-cloudcode-pa.googleapis.com`) via `/v1internal:fetchAvailableModels` and `/v1internal:retrieveUserQuotaSummary` (`GCP` channels query `cloudcode-pa.googleapis.com` directly):
- With native client headers and a valid companion project ID, upstream delivers all three official quota groups for paid `Pro` and `Ultra` accounts—`Gemini Models` (5-hour + weekly limits), `Claude and GPT Models` (5-hour + weekly limits), and `Gemini 4 Argon` (`bucketId: "gemini-argon-wtu-weekly"` weekly limit)—cached under `acc.cachedQuota` and `acc.cachedQuotaByPool.daily`.
- Handling Go `proto3` zero-value omission: when a bucket or model reports `remainingFraction === undefined` alongside a non-empty `resetTime`, the engine accurately evaluates remaining quota as `0%` (exhausted) rather than defaulting to `100%`.

### 2.2 Tier Classification (Unknown Fallback), Structured Error Drawers & Multi-Instance Isolation
`channel-catalog.mjs`, `cloudcode-discovery.mjs`, and `quota-probe.mjs` classify tiers, assemble live model whitelists, and normalize probe diagnostics from upstream metadata without static templates:
1. <b>Strict Native List Alignment, `dynamicModelRegistry` Self-Learning & `Unknown` Fallback</b>: Foreground active accounts read live available models directly from host `GetUserStatus` (`clientModelConfigs`), filtering out `disabled` / `Unavailable` while preserving `tagTitle: "Notice"` grace-period models, enriching only matching families from cached/probed snapshots without merging back natively unavailable items; background probes against `/v1internal:fetchAvailableModels` strictly adhere to the `agentModelSorts` whitelist (excluding internal `\bsonar\b` telemetry nodes) and auto-learn placeholders plus `Orchestrator (Argon)` (`MODEL_PLACEHOLDER_M668` $\rightarrow$ `gemini-pro-orchestrator-g1-pro`) into `dynamicModelRegistry`, while `index.html` and `createChannelBadgeNode` enforce `translate="no" class="notranslate"` to block external DOM translation overlays from hijacking `Free` / `Pro` / `Plus` / `Ultra` / `GCP` badges, with `Unknown` fallback on unconfirmed tiers.
2. <b>Isolated OAuth Refresh, Merged `lastProbeError` & 600s Routing Cooldown</b>: `wincred-ls.mjs` propagates refreshed `access_token` values strictly by matching `refresh_token`; `parseCloudCodeApiError` and `quota-probe.mjs` merge `status`, `apiStatus`, `reason`, `category` (`license_3501`, `validation_required`), `detailMessage`, `validationUrl`, and `helpLinks` across primary HTTP failures, refresh errors, and `loadCodeAssist`'s `ineligibleTiers[].reasonMessage` into `acc.lastProbeError`, stamping a `600000ms` `routeBlockedUntil` cooldown on `#3501` and `VALIDATION_REQUIRED` errors; the UI keeps the top quota section concise while showing clickable error badges on channel cards that expand an action drawer with browser verification link launching (`/api/open-external-url`), re-login, and re-probe controls.
3. <b>Cross-Talk-Free Multi-Instance Launcher (`+ Multi-Instance`)</b>: `oauth-launcher.mjs` passes `--user-data-dir=<path>` (with `=`) so Chromium switches its `userData` lock directory prior to `app.requestSingleInstanceLock()`, copies `app_storage.json` to bypass the onboarding wizard, and preserves the primary window's `writer_id` while temporarily staging the target channel's credential (preventing `cred_store.go`'s 1-second polling loop from switching the primary window), automatically restoring the primary credential once the new instance logs `Auth succeeded`.

## 3. Dual-Layer Channel Architecture: Primary Reload Switch vs Reload-Free Personal Routing

### 3.1 Layer 1: Primary Channel "Enable" Switch, Antigravity 2.29+ Quad-Store Auth Sync & Dual-Mode Signature Scrubbing
When a user clicks "Enable" on any channel card in Channel & Account Management (switching across personal accounts or between `GCP` and personal channels):
1. <b>Antigravity 2.29+ Quad-Store Auth Sync and Per-Instance Auto-Restart (`switchActiveAccount` + `restartTargetAntigravityInstance`)</b>:
   - Explicitly stamps `auth_method: "consumer"` (personal channel, omitting `project_id`) or `auth_method: "gcp"` (GCP channel, carrying bound `project_id`);
   - Atomically updates all four state stores for the target instance: ① Windows Credential Manager (`gemini:antigravity` via `Advapi32.dll` `CredWriteW`) for the main instance or the isolated token file for a multi-instance; ② `antigravityUnifiedStateSync.oauthToken` (Protobuf Base64 Sentinel `oauthTokenInfoSentinelKey`) and `google.geminicodeassist` inside the target instance's `User/globalStorage/state.vscdb` (preventing the Electron renderer from flushing stale auth state back to `language_server`); ③ `auth-session` inside the target instance's `app_storage.json`;
   - On cross-channel transitions (Personal $\leftrightarrow$ `GCP`), spawns a detached WMI restarter that restarts only the target instance (leaving other running instances untouched) and re-applies all four stores after the old process exits and before the new process launches.
2. <b>Session Signature Origin Detection, SQLite WAL Truncation & Dual-Mode Offline Protobuf Scrubbing (`inspectConversationSignatureStatus` + `scrubConversationDbFile`)</b>:
   - Gemini `thought_signature` bytes are cryptographically tied to the originating channel type (`personal` vs `gcp`); while reading official `transcript.jsonl` telemetry for the "Session Stats / Project Summary" toggle view, the engine inspects each conversation `.db` and `.db-wal` (guarded by `readOk` lock verification to prevent caching false empty states) to render live `GCP` / `Personal` / `No Sig` badges;
   - The "Session Stats / Project Summary" card provides a dual-mode "Clear Sig" dropdown menu: users can either scrub only the active conversation or scan the entire project to scrub legacy signatures mismatched with the active channel, recursively stripping signature wire fields (`0x01 0x69 0x14 0x7d 0x13` or Base64 `AWkUfR` / `FpFH0T`) from `~/.gemini/antigravity/conversations/<cascade_id>.db` and executing `PRAGMA wal_checkpoint(TRUNCATE);` right after `COMMIT` to prevent `.db-wal` bounce-back while preserving 100% of message text and tool calls.

### 3.2 Layer 2: Local Transparent Reverse Proxy & Two-Layer Reset Routing
When the primary session is on any personal channel (`Free` / `Plus` / `Pro` / `Ultra`), the bottom "Model Compute Routing" panel enables zero-reload routing across personal accounts (`GCP` channels remain completely isolated from bottom personal routing, while personal quota unifies onto `daily-cloudcode-pa.googleapis.com`):
1. <b>Always-On `SetCloudCodeURL` Local Transparent Proxy</b>: In personal channel mode, both Sidecar and `relay-hook.cjs` invoke the `SetCloudCodeURL` RPC on `language_server.exe` to point upstream requests to `http://127.0.0.1:<proxyPort>` (automatically restoring `https://cloudcode-pa.googleapis.com` whenever a `GCP` channel is active).
2. <b>Two-Layer Auto-Poll Sorting, Same-Window Sticky Priority & Dynamic `Bearer Token` Swap</b>:
   - When `language_server.exe` sends `/v1internal:streamGenerateContent` or `/v1internal:generateContent`, the transparent proxy resolves the requested `model` into its base family (`Gemini 4 Argon`, `Gemini 3.8 Flash`, `Claude Opus 5.5`, etc.).
   - Based on `routing.models[family]` (`follow_current`, `auto_poll`, or `account:<email>#personal`), `auto_poll` evaluates all non-`authExpired` personal account ledgers, applies the `5-hour quota > 5%` gate, and executes <b>two-layer sorting (Layer 1: ascending weekly reset time; Layer 2: ascending 5-hour reset time; when both reset times fall within the same window, it prioritizes the currently active account to prevent cross-account hopping on 1% differences)</b> to pick the optimal personal account.
   - The proxy replaces `Authorization: Bearer <AccessToken>` in memory, sets `body.project` to the account's dedicated private `companionProjectId`, invokes `stripThoughtSignaturesFromJson` on cross-account routes to strip residual signatures in the JSON payload, routes to `daily-cloudcode-pa.googleapis.com`, and refreshes the target account's quota 2 seconds after stream completion.
3. <b>Intercepting `/v1internal:fetchAvailableModels` to Prevent `0%` UI Lockout</b>:
   - When the currently active personal account hits `0%` quota on a model (or lacks access on a `Plus` / `Free` tier) while that model is routed to another personal channel with remaining quota (or `auto_poll`), the proxy injects the routed personal channel's `remainingFraction` into `fetchAvailableModels` before returning to `language_server.exe`, preventing the client UI from disabling the model selector.
4. <b>Three Empirical Boundaries Preventing Proxy Cross-Routing Between Personal and `GCP` Channels</b>:
   - <b>Upstream Gateway & Protocol Divergence</b>: When `language_server.exe` runs in `GCP` mode (`auth_method: "gcp"` with `SetProjectID`), its internal client sends standard Vertex AI requests directly to `https://aiplatform.googleapis.com/v1/projects/<gcpProjectId>/locations/global/publishers/google/models/<model>:streamGenerateContent`, completely bypassing the `SetCloudCodeURL` local proxy; conversely, the personal mode `/v1internal:streamGenerateContent` endpoint only accepts consumer companion project IDs (e.g., `rising-fact-p41fc`), and passing an external user `GCP` project ID fails immediately with `HTTP 403 PERMISSION_DENIED (SERVICE_DISABLED)` because Google's internal `cloudcode-pa.googleapis.com` service cannot be enabled on user GCP projects.
   - <b>Process-Level Credential Cache Lock</b>: `CLIAuthProvider` (`google/antigravity/TokenStorage`) loads system credentials only once at process startup; hot-swapping credentials and calling `ValidateProject` mid-session cannot switch the active authentication client without synchronizing all four state stores and restarting `language_server.exe`.
   - <b>Tink `thoughtSignature` Key Domain Isolation & In-Memory Trajectory Lock</b>: All personal channels share the same CloudCode consumer Tink key domain (Base64 prefixes `AWkUfR` / `FpFH0T` / `AEFNM`), allowing cross-account personal routing to pass verification without stripping signatures; `GCP` channels use an isolated Vertex AI Tink key domain (prefixes `AY89a18` / `IDxACGAIqQ` / `CA8QAhgCKk`). Sending mismatched signatures across channel types triggers `HTTP 400 Invalid thought signature`, stripping signatures mid-turn during multi-step `functionCall` loops triggers `HTTP 400 Function call is missing a thought_signature`, and `LoadTrajectory` skips already-resident trajectories in memory (`trajectory already loaded, skipping duplicate load`) unless `language_server.exe` is restarted via Layer 1 primary channel switching.

### 3.3 Transparent Proxy Port Conflict Fallback (`8091..8095` + Ephemeral Port)
To guarantee reload-free routing even if default port `8091` is occupied by third-party software, the proxy implements a four-step fallback mechanism:
1. <b>Health Fingerprint Endpoint (`GET /__agy_proxy_ping`)</b>: The proxy exposes a dedicated health check returning `{"ok":true,"service":"antigravity-relay-proxy","port":<actualPort>}`.
2. <b>Homologous Reuse and Sequential Fallback</b>: `ensureCloudCodeProxyServer()` iterates through candidate ports `[8091, 8092, 8093, 8094, 8095, 0]`. On `EADDRINUSE`, it queries `/__agy_proxy_ping` on that port—reusing the existing instance if it belongs to Antigravity Relay, or advancing to the next candidate port (down to `0` for an OS-assigned ephemeral port) if occupied by another application.
3. <b>Config Persistence and Dynamic Propagation</b>: The bound proxy URL `http://127.0.0.1:<actualPort>` is persisted to `__meta__.cloudCodeProxyUrl` in `agy-relay-config.json` and read dynamically via `getActiveCloudCodeProxyUrl(cfg)` across both `ls-bridge.mjs` and `relay-hook.cjs`.

## 4. HTTP API Specifications

All endpoints are served identically from both the host-assigned internal Sidecar port and `http://127.0.0.1:8089`.

### 4.1 Get Live System Snapshot and Quota State
- <b>Route</b>: `GET /api/status`
- <b>Query Parameters</b>: `force=1` (optional, bypasses cache to probe live upstream quotas across all channels), `light=1` (optional, skips redundant personal quota cloud probes during version-triggered syncs).
- <b>Response</b>: Full JSON snapshot containing `lsOnline`, `activeAccount`, `availableModels`, `quotaGroups`, `accounts`, `routing`, `stateRevision`, and `oauthPending`.

### 4.2 Real-Time State Broadcast (SSE), Embedded Version Check & Orphan Exit Watchdog
- <b>Standalone SSE Stream</b>: `GET /api/events` (`text/event-stream; charset=utf-8`) keeps a live push stream on `http://127.0.0.1:8089` for `0ms` updates; requests arriving on the host-assigned gateway port behind `plugin://` are defensively capped at `<= 2` streams and closed cleanly after `20s`.
- <b>Embedded Panel Version Probe</b>: `GET /api/state-version` returns `revision`, `frontendVersion`, `configMtimeMs`, `oauthPending`, and `lastOAuthEventId`. Inside `plugin://` iframes, `app.js` never opens `EventSource('/api/events')` and instead polls `/api/state-version` only while `isPanelActuallyVisible()` is `true`, eliminating socket leaks in Electron `customScheme` `fetchWithoutFollowing` that otherwise exhaust Chromium's 6-connection pool per origin when opening new projects.
- <b>Host LS Liveness Watchdog</b>: `main.mjs` probes `ANTIGRAVITY_LS_ADDRESS` over TCP every `5s` (compensating for Windows `cmd.exe` wrappers masking `language_server.exe` exit in `process.ppid`), exiting cleanly after `2` failed probes and honoring `/api/restart-sidecar?onlyStandalone=1` immediately when the originating host LS is dead.

### 4.3 Channel, Instance & Diagnostic Management Endpoints
- <b>Save Currently Logged-In Account</b>: `POST /api/save-current-account`
- <b>Start Isolated OAuth Login</b>: `POST /api/start-oauth-login` (accepts optional target channel and login hint payload)
- <b>Cancel Pending OAuth Login</b>: `POST /api/cancel-oauth-login`
- <b>Switch Active GCP Billing Project</b>: `POST /api/switch-project` (Payload: `{ "projectId": "my-proj" }`)
- <b>Discover Accessible GCP Projects</b>: `POST /api/discover-gcp-projects` (Payload: `{ "email": "user@gmail.com" }`)
- <b>Add Independent Personal Channel</b>: `POST /api/add-personal-channel` (Payload: `{ "email": "user@gmail.com" }`)
- <b>Add Independent GCP Channel Card</b>: `POST /api/add-gcp-channel` (Payload includes `email`, `projectId`, `gcpBillingMode`, `gcpLocation`)
- <b>Update Account Project Binding or Alias</b>: `POST /api/update-account` (Payload includes `accountId`, `gcpProjectId`, `gcpBillingMode`, `gcpLocation`, `alias`)
- <b>Enable Target Channel (Quad-Store Sync + Cross-Channel Instance Auto-Restart)</b>: `POST /api/switch-account` (Payload: `{ "accountId": "user@gmail.com#personal", "scrubSignatures": true, "conversationId": "<uuid>" }`)
- <b>Check Ephemeral Model Compute Route</b>: `POST /api/route-channel` (Payload: `{ "accountId": "user@gmail.com#personal" }`)
- <b>Launch Isolated Multi-Instance</b>: `POST /api/launch-instance` (Payload: `{ "accountId": "user@gmail.com#gcp:my-proj" }`)
- <b>Dual-Mode Thought Signature Scrub</b>: `POST /api/scrub-signatures` (Payload: `{ "mode": "current" | "mismatched", "conversationId": "<uuid>" }`)
- <b>Probe Channel Quota and Diagnostic State</b>: `POST /api/probe-channel-quota` (Payload: `{ "channelId": "user@gmail.com#personal" }`)
- <b>Open Google Verification or Help URL in System Browser</b>: `POST /api/open-external-url` (Payload: `{ "url": "https://accounts.google.com/..." }`; restricts to HTTPS under `google.com` / `googleapis.com` / `googleusercontent.com`)
- <b>Switch Personal Quota Ledger Compatibility Endpoint</b>: `POST /api/switch-quota-pool` (Payload: `{ "pool": "daily" | "prod" }`)
- <b>Delete Target Channel Snapshot</b>: `POST /api/delete-account` (Payload: `{ "accountId": "user@gmail.com#personal" }`)

### 4.4 Model Routing and Localization Endpoints
- <b>Save Model and Subagent Compute Routing Rules</b>: `POST /api/save-routing` (Payload includes `modelId`, `variantIds`, `targetSpec`, `routeScope`, `subagentDefaultTarget`, `autoRelayOnLowQuota`)
- <b>Switch UI Language and Persist Metadata</b>: `POST /api/set-language` (Payload: `{ "lang": "zh" }` or `{ "lang": "en" }`)
