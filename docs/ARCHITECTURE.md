[English](ARCHITECTURE.en.md) | [简体中文](ARCHITECTURE.md)

# Antigravity Relay 架构设计文档

本文档深入阐述 Antigravity Relay 的双层通道架构、全等级（`Free` / `Plus` / `Pro` / `Ultra` / `GCP`）配额探针矩阵、个人通道本地透明反向代理免重载路由、端口冲突自动递增回退、双层思维签名（`thoughtSignature`）无损剥离机制以及 HTTP API 接口规范。

## 1. 核心架构与运行模型

本扩展运行于 <b>Google Antigravity 2.0</b> 桌面客户端环境，由两大协同组件构成：
- <b>前置路由与自愈钩子（relay-hook.cjs）</b>：挂载于宿主 `PreInvocation` 与 `Stop` 生命周期事件，负责在每次对话推理前确保 Sidecar 服务在线，并在个人通道模式下将本地透明反向代理地址实时同步至 `language_server.exe`。
- <b>Sidecar 常驻微服务与可视化面板（sidecars/panel/）</b>：采用原生免构建前后端物理解耦架构，同时监听宿主动态分配端口与固定 `8089` 端口，并在内部自举启动 CloudCode 本地透明反向代理（默认 `8091` 端口，支持 `8091..8095` 及随机端口自动回退）。

### 1.1 模块化工程目录树

```
antigravity-relay/
├── assets/
│   ├── logo.svg                 # 矢量品牌图标
│   ├── preview-en.png           # 英文深浅色双窗高清预览图
│   └── preview-zh.png           # 中文深浅色双窗高清预览图
├── docs/
│   ├── ARCHITECTURE.en.md       # 英文架构设计文档
│   └── ARCHITECTURE.md          # 中文架构设计文档
├── lib/
│   └── proto-scrub.cjs          # Protobuf 跨通道思考签名离线剥离引擎
├── sidecars/
│   └── panel/                   # 原生免构建前后端物理分离 Sidecar 面板
│       ├── bridge/              # 后端高内聚业务子模块目录
│       │   ├── channel-catalog.mjs # 五大通道等级判定、动态模型目录与凭据归一化
│       │   ├── cloudcode-proxy.mjs # 本地透明反向代理与双层重置算力路由
│       │   ├── oauth-launcher.mjs  # 旁路 OAuth 登录、多开隔离实例与会话遥测
│       │   ├── quota-probe.mjs     # 官方动态模型白名单与三配额池探针引擎
│       │   ├── signature-scrub.mjs # SQLite Protobuf 思维签名离线无损剥离器
│       │   └── wincred-ls.mjs      # WinCred 凭据读写、多客户端刷新与 LS RPC
│       ├── app.js               # 前端核心交互、自定义下拉与状态同步引擎
│       ├── i18n.js              # 前端中英双语严格隔离词典
│       ├── index.html           # 前端纯骨架页面
│       ├── ls-bridge.mjs        # 后端主协调器与统一导出门面 (Barrel Facade)
│       ├── main.mjs             # 后端双端口 HTTP 路由与 SSE 实时广播入口
│       ├── preload.js           # 宿主预加载脚本
│       ├── sidecar.json         # Antigravity Sidecar 容器元数据契约
│       ├── store.mjs            # 配置原子化落盘与脏模型自动清洗
│       └── styles.css           # 前端纯扁平自适应主题样式表
├── agy-relay-config.example.json # 脱敏示例配置档案
├── hooks.json                   # Antigravity Hook 配置文件
├── open-panel.bat               # 独立小窗快速启动脚本
├── plugin.json                  # Antigravity 插件公开元数据契约
├── relay-hook.cjs               # 会话生命周期 Hook 拦截器
├── README.en.md                 # 英文说明文档
└── README.md                    # 中文说明文档
```

```
+-----------------------------------------------------------------------+
|                       Google Antigravity 2.0 宿主                      |
|  +---------------------------+       +-----------------------------+  |
|  |   language_server.exe     |       |   Auxiliary Pane / 8089     |  |
|  +-------------+-------------+       +--------------+--------------+  |
|                |                                    |                 |
+----------------|------------------------------------|-----------------+
                 | SetCloudCodeURL (个人模式)          | HTTP + SSE
                 v                                    v
+-----------------------------------------------------------------------+
|              Antigravity Relay Sidecar (Port 8089 & Proxy)            |
|  +-----------------------------------------------------------------+  |
|  |  本地透明反向代理 (8091..8095 / 动态端口自动回退 + 健康指纹)      |  |
|  |  - 动态替换目标个人账号 Authorization: Bearer <Token>            |  |
|  |  - 流式剥离请求体 JSON thoughtSignature 防止 400 签名校验失败    |  |
|  |  - 拦截 fetchAvailableModels 防主账号 0% 额度锁死模型选择器      |  |
|  +-----------------------------------------------------------------+  |
|  |  全等级配额探针引擎 (Free / Plus / Pro / Ultra / GCP)            |  |
|  +-----------------------------------------------------------------+  |
|  |  双轨零打断 OAuth PKCE 登录 + SQLite 离线 Protobuf 签名剥离器    |  |
|  +-----------------------------------------------------------------+  |
+-----------------------------------------------------------------------+
```

## 2. 全等级识别矩阵与三大配额池探针机制

### 2.1 原生 CloudCode 请求头与三大配额池获取
`ls-bridge.mjs` 向 `https://daily-cloudcode-pa.googleapis.com` 发起 `/v1internal:fetchAvailableModels` 与 `/v1internal:retrieveUserQuotaSummary` 请求时，严格携带与 `language_server.exe` 二进制完全一致的原生 `User-Agent`：
- 仅在该原生请求头下，云端才会对付费 `Pro` 与 `Ultra` 账户完整下发 `Gemini Models`（5 小时 + 周限额）、`Claude and GPT Models`（5 小时 + 周限额）以及独立的第 3 配额组 `Gemini 4 Argon`（`bucketId: "gemini-argon-wtu-weekly"` 周限额）。
- 针对 Go `proto3` 零值序列化省略机制：当某个配额桶或模型的 `remainingFraction === undefined` 但存在 `resetTime` 时，系统精确判定为 `0%`（已耗尽），杜绝误判为 `100%`。

### 2.2 五大通道等级（`Free` / `Plus` / `Pro` / `Ultra` / `GCP`）与官方纯动态模型白名单
系统通过 `detectPersonalAccountTier` 与 `parseCloudCodeModelsAndQuota` 严格按照 Google 官方下发的元数据实时判定通道等级与可用模型（零静态硬编码模板）：
1. <b>`agentModelSorts` 推荐白名单与 `Notice` 过渡期模型保留</b>：个人通道向 `/v1internal:fetchAvailableModels` 传入 `{}` 空载荷，提取官方 `agentModelSorts[0].groups[].modelIds` 白名单并过滤存在 `quotaInfo` 且非 `disabled` / `Unavailable` 的模型；对带有 `tagTitle: "Notice"`（如 Jio 渠道合作版 Pro 在过渡期内仍开放的 `Claude Sonnet 4.6 (Thinking)`、`Claude Opus 4.6 (Thinking)`、`GPT-OSS 120B (Medium)`）的模型完整保留，直至官方切换为 `Unavailable` 时自动下线。
2. <b>多 OAuth Client 轮询池与按 `refresh_token` 严格隔离同步</b>：`wincred-ls.mjs` 内置多组官方 OAuth Client 轮询刷新池，且每次刷新获得的 `access_token` 仅同步至持有相同 `refresh_token` 的通道卡片，彻底杜绝同邮箱 `#personal` 与 `#gcp` 令牌交叉覆盖。
3. <b>独立多开实例（`+ 多开实例`）免串扰架构</b>：`oauth-launcher.mjs` 通过等号拼接的 `--user-data-dir=<path>` 参数让 Chromium 在 `app.requestSingleInstanceLock()` 前切换独立用户目录锁，同步复制 `app_storage.json` 跳过首次向导直达 Hub，并在临时写入目标通道凭据时保留主窗口原本的 `writer_id`（防止主窗口 `cred_store.go` 1s 轮询被误触发切换），待新实例日志出现 `Auth succeeded` 后自动还原主实例凭据。

## 3. 双层通道架构：主通道重载切换 vs 个人通道免重载路由

### 3.1 第一层：独立通道池「启用」切换、Antigravity 2.29+ 四重登录态同步与双模式签名剥离
当用户在「通道与账号管理」点击某张卡片（无论是跨个人账号，还是在 `GCP` 与个人通道之间切换）的「启用」按钮时：
1. <b>Antigravity 2.29+ 四重登录态同步与单实例无感自重启（`switchActiveAccount` + `restartTargetAntigravityInstance`）</b>：
   - 显式设置凭据 `auth_method: "consumer"`（个人通道，彻底剔除 `project_id`）或 `auth_method: "gcp"`（GCP 通道，携带绑定 `project_id`）；
   - 同步写入目标实例四处核心状态源：① 主实例 Win32 `Advapi32.dll` `CredWriteW`（`gemini:antigravity`）或多开实例专属令牌文件；② 目标实例 `User/globalStorage/state.vscdb` 中的 `antigravityUnifiedStateSync.oauthToken`（Protobuf Base64 Sentinel `oauthTokenInfoSentinelKey`）与 `google.geminicodeassist`（防止 Electron 渲染层把旧账号状态刷回 `language_server`）；③ 目标实例 `app_storage.json` 的 `auth-session`；
   - 当跨通道切换（个人 $\leftrightarrow$ `GCP`）时，通过 WMI 拉起脱离进程树的重启器仅重启当前目标实例（绝不影响另一多开实例），并在旧进程退出后、新进程拉起前二次覆写上述四处存储以防退出回写覆盖。
2. <b>会话级签名归属检测与双模式离线 Protobuf 签名无损剥离（`detectConversationSignatureChannel` + `scrubConversationsByScope`）</b>：
   - Google Gemini 模型的思考签名（`thought_signature`）与生成该签名的通道类型（`personal` vs `gcp`）强绑定；系统在读取官方 `transcript.jsonl` 实时计算「会话统计 / 项目汇总」Token 账单时，同步检测各会话 `.db` 是否包含思考签名并结合 `signatureChannelMap` 标记 `GCP` / `个人` / `无签名` 徽章；
   - 面板「当前会话统计 / 项目汇总」卡片内置双模式「清除签名」下拉菜单：支持「仅清除当前会话签名」（`scope: "conversation"`）或「全项目扫描，清除与当前通道不匹配的遗留签名」（`scope: "project_mismatch"`），递归剥离 `~/.gemini/antigravity/conversations/<cascade_id>.db` 中的签名魔数头（`0x01 0x69 0x14 0x7d 0x13` 或 Base64 `AWkUfR` / `FpFH0T`），100% 保留聊天正文与工具调用记录。

### 3.2 第二层：个人通道本地透明反向代理与免重载算力接力
当主界面处于任意个人通道（`Free` / `Plus` / `Pro` / `Ultra`）时，底部「模型算力路由」在不重载界面的前提下实现跨个人账号算力接力（`GCP` 通道完全独立，不参与底部路由）：
1. <b>动态挂载 `SetCloudCodeURL`</b>：Sidecar 与 `relay-hook.cjs` 自动向 `language_server.exe` 发送 `SetCloudCodeURL` RPC，将其上游地址指向本地透明代理 `http://127.0.0.1:<proxyPort>`（若切换到 `GCP` 主通道，则自动恢复为官方 `https://daily-cloudcode-pa.googleapis.com`）。
2. <b>按模型动态替换 `Bearer Token` 与实时剥离 JSON 签名</b>：
   - 当 `language_server.exe` 发起 `/v1internal:streamGenerateContent` 或 `/v1internal:generateContent` 请求时，透明代理提取请求体中的 `model` 标识并映射为基础模型家族（如 `Gemini 4 Argon`、`Gemini 3.8 Flash`、`Claude Opus 5.5`）。
   - 根据 `routing.models[family]` 配置（`follow_current`、`auto_poll` 或指定 `account:<email>#personal`），自动选出拥有该模型且配额大于 `0%` 的目标个人账号（`auto_poll` 优先选择重置时间最早的账号）。
   - 在内存中将 HTTP 请求头替换为目标个人账号的 `Authorization: Bearer <AccessToken>`，同时调用 `stripThoughtSignaturesFromJson()` 递归剔除请求体 JSON 中的 `thoughtSignature` / `thought_signature` 字段后直连 `daily-cloudcode-pa.googleapis.com`，并在流式响应结束后 2 秒异步刷新目标账号配额。
3. <b>拦截 `/v1internal:fetchAvailableModels` 防止主账号 `0%` 锁死</b>：
   - 当当前登录的主个人账号某模型配额降至 `0%`（或如 `Plus` / `Free` 账号本身无 `Gemini 4 Argon` 额度），但用户在底部路由中已将该模型路由至其他有额度的个人账号（或开启 `auto_poll` 且池内其他个人账号有额度）时，透明代理在返回模型列表给 `language_server.exe` 前自动注入目标路由账号的剩余配额百分比，防止客户端前端将模型下拉项置灰锁死。

### 3.3 透明代理端口冲突备用方案（`8091..8095` + 随机端口自动递增回退）
为防止默认 `8091` 端口被本机其他软件占用导致免重载路由失效，系统内置四重保障：
1. <b>健康指纹自检端点（`GET /__agy_proxy_ping`）</b>：透明代理内置专属健康探针，固定返回 `{"ok":true,"service":"antigravity-relay-proxy","port":<actualPort>}`。
2. <b>同源复用与异源递增回退</b>：`ensureCloudCodeProxyServer()` 启动时按候选序列 `[8091, 8092, 8093, 8094, 8095, 0]` 依次尝试绑定；若某端口返回 `EADDRINUSE`，先请求 `/__agy_proxy_ping` 验证是否为本插件已运行的代理实例——若是则直接复用，若被第三方进程占用则立即递增绑定下一个空闲端口（直至 `0` 由操作系统分配空闲随机端口）。
3. <b>配置持久化与全链路动态读取</b>：实际绑定的代理地址 `http://127.0.0.1:<actualPort>` 实时写入 `agy-relay-config.json` 的 `__meta__.cloudCodeProxyUrl`，`ls-bridge.mjs` 与 `relay-hook.cjs` 统一通过 `getActiveCloudCodeProxyUrl(cfg)` 动态获取并注入 `SetCloudCodeURL`，实现零硬编码自愈。

## 4. HTTP API 接口规范

所有接口由宿主分配的动态 Sidecar 端口与固定 `http://127.0.0.1:8089` 双端口同源提供。

### 4.1 获取实时系统快照与配额状态
- <b>路径</b>：`GET /api/status`
- <b>查询参数</b>：`force=1`（可选，强制穿透缓存拉取全通道最新云端配额）
- <b>返回格式</b>：包含 `lsOnline`、`activeAccount`、`availableModels`、`quotaGroups`、`accounts`、`routing` 及 `oauthPending` 的完整快照 JSON。

### 4.2 实时状态广播事件流（SSE）
- <b>路径</b>：`GET /api/events`
- <b>响应类型</b>：`text/event-stream; charset=utf-8`
- <b>说明</b>：当配额刷新、OAuth 授权完成或通道状态变更时，`0ms` 向所有打开的面板推送最新快照。

### 4.3 通道与账号管理接口
- <b>收录当前已登录账号</b>：`POST /api/save-current-account`
- <b>启动旁路零打断 OAuth 登录</b>：`POST /api/add-account-oauth`
- <b>取消进行中的 OAuth 登录</b>：`POST /api/cancel-oauth`
- <b>扫描账号可用 GCP 项目列表</b>：`POST /api/discover-gcp-projects`（请求体：`{ "email": "user@gmail.com" }`）
- <b>添加独立通道（个人或 GCP）</b>：`POST /api/add-gcp-channel`（请求体包含 `email`、`channelType`、`gcpProjectId`、`gcpBillingMode`、`gcpLocation`）
- <b>启用指定通道（四重同步 + 跨通道自动重启当前实例）</b>：`POST /api/switch-account`（请求体：`{ "channelId": "user@gmail.com#personal" }`）
- <b>拉起独立多开实例</b>：`POST /api/launch-instance`（请求体：`{ "channelId": "user@gmail.com#gcp:my-proj" }`）
- <b>双模式清除思考签名</b>：`POST /api/scrub-signatures`（请求体：`{ "scope": "conversation" | "project_mismatch", "conversationId": "<uuid>" }`）
- <b>删除指定通道</b>：`POST /api/remove-account`（请求体：`{ "channelId": "user@gmail.com#personal" }`）
- <b>查询非当前通道缓存配额</b>：`POST /api/probe-channel-quota`（请求体：`{ "channelId": "user@gmail.com#personal", "force": false }`）

### 4.4 模型路由与国际化设置接口
- <b>设置模型算力路由规则</b>：`POST /api/set-route`（请求体：`{ "targetType": "models", "key": "Gemini 3.8 Flash", "routeValue": "auto_poll" }`）
- <b>动态切换中英文界面并持久化</b>：`POST /api/set-language`（请求体：`{ "lang": "zh" }` 或 `{ "lang": "en" }`）
