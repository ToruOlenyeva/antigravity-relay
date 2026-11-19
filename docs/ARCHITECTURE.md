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
│       │   ├── channel-catalog.mjs   # 通道等级判定、API 错误解析、动态模型目录与凭据归一化
│       │   ├── cloudcode-discovery.mjs # CloudCode API 传输、GCP 项目多源发现与模型/配额解析
│       │   ├── cloudcode-proxy.mjs   # 本地透明反向代理、请求改写与 429 故障转移
│       │   ├── oauth-launcher.mjs    # 旁路 OAuth 登录、多开隔离实例与会话遥测
│       │   ├── quota-probe.mjs       # 多通道配额探测编排、错误合并与 600s 路由退避控制
│       │   ├── route-selector.mjs    # 模型家族映射与双层重置时间个人通道选路器
│       │   ├── signature-scrub.mjs   # SQLite Protobuf 思维签名离线无损剥离器
│       │   └── wincred-ls.mjs        # WinCred 凭据读写、多客户端刷新与 LS RPC
│       ├── app.js               # 前端核心交互、自定义下拉与状态同步引擎
│       ├── i18n.js              # 前端中英双语严格隔离词典
│       ├── index.html           # 前端纯骨架页面
│       ├── ls-bridge.mjs        # 后端主协调器与统一导出门面 (Barrel Facade)
│       ├── main.mjs             # 后端双端口 HTTP 路由与 SSE 实时广播入口
│       ├── preload.js           # 宿主预加载脚本
│       ├── sidecar.json         # Antigravity Sidecar 容器元数据契约
│       ├── store.mjs            # 配置原子化落盘与脏模型自动清洗
│       ├── styles.css           # 前端纯扁平自适应主题样式表
│       ├── ui-channels-drawers.js # 通道列表、可展开报错抽屉、一键重登与操作视图模块
│       └── ui-session-quota.js  # 会话统计、项目汇总与配额环视图模块
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

## 2. 全等级识别矩阵、配额探针与结构化错误诊断

### 2.1 动态客户端版本握手、LoadCodeAssist 回落机制与 Daily 配额获取
`wincred-ls.mjs` 与 `cloudcode-discovery.mjs` / `quota-probe.mjs` 实时从宿主 `language_server.log` 动态提取当前客户端版本号（如 `Language server version: 2.29.0`，随客户端升级自动同步，零硬编码），并在调用 `/v1internal:loadCodeAssist` 时携带完整 `{ ideType: "JETSKI", ideVersion: "<clientVersion>", pluginType: "GEMINI", platform: "WINDOWS_AMD64" }` 载荷（个人账号优先请求 `https://cloudcode-pa.googleapis.com`，失败或返回空体时自动回落至 `https://daily-cloudcode-pa.googleapis.com`）以获取私有伴生项目 ID（彻底规避漏传版本导致的 `"aicode-consumers"` 免费降级池 429 陷阱）。完成握手后，个人通道统一通过 Daily 官方服务池（`https://daily-cloudcode-pa.googleapis.com`）发起 `/v1internal:fetchAvailableModels` 与 `/v1internal:retrieveUserQuotaSummary`（GCP 计费通道则固定请求 `cloudcode-pa.googleapis.com`）：
- 在携带动态原生请求头与有效伴生项目 ID 下，上游会对付费 `Pro` 与 `Ultra` 账户下发三大配额组：`Gemini Models`（5 小时 + 周限额）、`Claude and GPT Models`（5 小时 + 周限额）以及 `Gemini 4 Argon`（`bucketId: "gemini-argon-wtu-weekly"` 周限额）与可用模型列表，并缓存至 `acc.cachedQuota` 与 `acc.cachedQuotaByPool.daily`。
- 针对 Go `proto3` 零值序列化省略机制：当某个配额桶或模型的 `remainingFraction === undefined` 但存在 `resetTime` 时，系统精确判定为 `0%`（已耗尽），杜绝误判为 `100%`。

### 2.2 通道等级识别（含 Unknown 保底）、结构化错误抽屉与隔离多开
`channel-catalog.mjs`、`cloudcode-discovery.mjs` 与 `quota-probe.mjs` 严格依据 Google 官方元数据判定通道等级、构建动态模型白名单并抽提结构化错误（零静态模板）：
1. <b>原生列表严格对齐、`dynamicModelRegistry` 动态自学习与 `Unknown` 保底</b>：前台活跃账号直读宿主 `GetUserStatus`（`clientModelConfigs`）真实可用列表并过滤 `disabled` / `Unavailable`（保留 `tagTitle: "Notice"` 过渡期模型），仅从云端快照补充同家族变体与配额数据（不并入原生判定不可用的项）；后台多账号探测向 `/v1internal:fetchAvailableModels` 严格以 `agentModelSorts` 原生白名单为准（剔除内部 `\bsonar\b` 代码分析节点），并通过 `dynamicModelRegistry`（`placeholderToSlug`、`placeholderToFamily`、`labelToSlug`、`clientCatalog`）实时学习占位符与 `Orchestrator (Argon)`（`MODEL_PLACEHOLDER_M668` $\rightarrow$ `gemini-pro-orchestrator-g1-pro`）映射，同时在 `index.html` 与 `createChannelBadgeNode` 注入 `translate="no" class="notranslate"` 防止外部 DOM 汉化脚本篡改 `Free` / `Pro` / `Plus` / `Ultra` / `GCP` 徽章；未确认订阅源时保底标记为 `Unknown` 而非误标为 `Pro`。
2. <b>多 OAuth Client 刷新隔离、结构化 `lastProbeError` 合并与 600s 路由冷却</b>：`wincred-ls.mjs` 按严格匹配的 `refresh_token` 分发刷新后的 `access_token`；`parseCloudCodeApiError` 与 `quota-probe.mjs` 从失败端点、刷新异常及 `loadCodeAssist` 返回的 `ineligibleTiers[].reasonMessage` 中联合提取 `status`、`apiStatus`、`reason`、`category`（识别 `license_3501`、`validation_required`）、`detailMessage`、`validationUrl` 与 `helpLinks` 并写入 `acc.lastProbeError`，命中 `#3501` 或 `VALIDATION_REQUIRED` 时自动写入 `600000ms` 的 `routeBlockedUntil` 路由退避冷却；前端顶部配额区保持简洁错误提示，账号卡片通过可点击紧凑徽章按需展开详情抽屉并支持经 `/api/open-external-url` 在系统浏览器打开 Google 验证/帮助外链或一键重登。
3. <b>独立多开实例（`+ 多开实例`）免串扰架构</b>：`oauth-launcher.mjs` 通过等号拼接的 `--user-data-dir=<path>` 参数让 Chromium 在 `app.requestSingleInstanceLock()` 前切换独立用户目录锁，同步复制 `app_storage.json` 跳过首次向导直达 Hub，并在临时写入目标通道凭据时保留主窗口原本的 `writer_id`（防止主窗口 `cred_store.go` 1s 轮询被误触发切换），待新实例日志出现 `Auth succeeded` 后自动还原主实例凭据。

## 3. 双层通道架构：主通道重载切换 vs 个人通道免重载路由

### 3.1 第一层：独立通道池「启用」切换、Antigravity 2.29+ 四重登录态同步与双模式签名剥离
当用户在「通道与账号管理」点击某张卡片（无论是跨个人账号，还是在 `GCP` 与个人通道之间切换）的「启用」按钮时：
1. <b>Antigravity 2.29+ 四重登录态同步与单实例无感自重启（`switchActiveAccount` + `restartTargetAntigravityInstance`）</b>：
   - 显式设置凭据 `auth_method: "consumer"`（个人通道，彻底剔除 `project_id`）或 `auth_method: "gcp"`（GCP 通道，携带绑定 `project_id`）；
   - 同步写入目标实例四处核心状态源：① 主实例 Win32 `Advapi32.dll` `CredWriteW`（`gemini:antigravity`）或多开实例专属令牌文件；② 目标实例 `User/globalStorage/state.vscdb` 中的 `antigravityUnifiedStateSync.oauthToken`（Protobuf Base64 Sentinel `oauthTokenInfoSentinelKey`）与 `google.geminicodeassist`（防止 Electron 渲染层把旧账号状态刷回 `language_server`）；③ 目标实例 `app_storage.json` 的 `auth-session`；
   - 当跨通道切换（个人 $\leftrightarrow$ `GCP`）时，通过 WMI 拉起脱离进程树的重启器仅重启当前目标实例（绝不影响另一多开实例），并在旧进程退出后、新进程拉起前二次覆写上述四处存储以防退出回写覆盖。
2. <b>会话级签名归属检测、SQLite WAL 截断与双模式离线 Protobuf 签名无损剥离（`inspectConversationSignatureStatus` + `scrubConversationDbFile`）</b>：
   - Google Gemini 模型的思考签名（`thought_signature`）与生成该签名的通道类型（`personal` vs `gcp`）强绑定；系统在读取官方 `transcript.jsonl` 实时计算「会话统计 / 项目汇总」Token 账单时，同步检测各会话 `.db` 与 `.db-wal` 是否包含思考签名（内置 `readOk` 锁竞争守卫防止误缓存空状态）并标记 `GCP` / `个人` / `无签名` 徽章；
   - 面板「当前会话统计 / 项目汇总」卡片内置双模式「清除签名」下拉菜单：支持「仅清除当前会话签名」或「全项目扫描清除与当前通道不匹配的遗留签名」，递归剥离 `~/.gemini/antigravity/conversations/<cascade_id>.db` 中的签名魔数头（`0x01 0x69 0x14 0x7d 0x13` 或 Base64 `AWkUfR` / `FpFH0T`），提交事务后强制执行 `PRAGMA wal_checkpoint(TRUNCATE);` 截断 `.db-wal` 残留，100% 保留聊天正文与工具调用记录。

### 3.2 第二层：个人通道本地透明反向代理与双层重置算力接力
当主界面处于任意个人通道（`Free` / `Plus` / `Pro` / `Ultra`）时，底部「模型算力路由」在不重载界面的前提下实现跨个人账号的算力接力（`GCP` 通道完全独立，不参与底部个人池路由；个人配额统一接入 `daily-cloudcode-pa.googleapis.com`）：
1. <b>常驻挂载 `SetCloudCodeURL` 本地透明代理</b>：在个人通道模式下，Sidecar 与 `relay-hook.cjs` 自动向 `language_server.exe` 发送 `SetCloudCodeURL` RPC，将其上游地址指向本地透明代理 `http://127.0.0.1:<proxyPort>`（若切换到 `GCP` 主通道，则自动恢复为官方 `https://cloudcode-pa.googleapis.com`）。
2. <b>全账号候选池 2 层自动轮询排序、同窗口防跳变与动态 `Bearer Token` 替换</b>：
   - 当 `language_server.exe` 发起 `/v1internal:streamGenerateContent` 或 `/v1internal:generateContent` 请求时，透明代理提取请求体中的 `model` 标识并映射为基础模型家族（如 `Gemini 4 Argon`、`Gemini 3.8 Flash`、`Claude Opus 5.5`）。
   - 根据 `routing.models[family]` 配置（`follow_current`、`auto_poll` 或指定 `account:<email>#personal`），`auto_poll` 将所有非 `authExpired` 个人账号的配额账本纳入候选，先按 `5 小时限额 > 5%` 门控过滤，再严格执行<b>2 层排序（第 1 层按周限额重置时间升序，第 2 层按 5 小时限额重置时间升序；当两层重置时间处于同一窗口时优先锁定当前激活账号，防微小百分比差跨号跳变）</b>选出最优个人账号。
   - 在内存中将 HTTP 请求头替换为目标个人账号的 `Authorization: Bearer <AccessToken>`、将 `body.project` 替换为该账号真实的私有 `companionProjectId`，跨号路由时自动调用 `stripThoughtSignaturesFromJson` 剥离请求体 JSON 中的残留签名，统一转发至 `daily-cloudcode-pa.googleapis.com`，流式响应结束后 2 秒异步刷新目标账号配额。
3. <b>拦截 `/v1internal:fetchAvailableModels` 防止主账号 `0%` 锁死</b>：
   - 当当前登录的主个人账号某模型配额降至 `0%`（或如 `Plus` / `Free` 账号本身无 `Gemini 4 Argon` 额度），但用户在底部路由中已将该模型路由至其他有额度的个人账号（或开启 `auto_poll` 且池内其他个人账号有额度）时，透明代理在返回模型列表给 `language_server.exe` 前自动注入目标路由账号的剩余配额百分比，防止客户端前端将模型下拉项置灰锁死。
4. <b>个人通道与 `GCP` 通道不可通过本地反代跨通道路由的三大实测物理边界</b>：
   - <b>上游推理网关与协议硬分流</b>：`language_server.exe` 处于 `GCP` 模式（`auth_method: "gcp"` 且注入 `SetProjectID`）时，底层客户端直接向 `https://aiplatform.googleapis.com/v1/projects/<gcpProjectId>/locations/global/publishers/google/models/<model>:streamGenerateContent` 发起标准 Vertex AI 请求，完全绕过 `SetCloudCodeURL` 本地反代；而个人模式的 `/v1internal:streamGenerateContent` 私有接口仅接受个人伴生项目池 ID（如 `rising-fact-p41fc`），传入外部用户 `GCP` 项目 ID 会因无法开通 Google 内部私有服务 `cloudcode-pa.googleapis.com` 直接触发 `HTTP 403 PERMISSION_DENIED (SERVICE_DISABLED)`。
   - <b>进程级凭据缓存锁死</b>：`CLIAuthProvider`（`google/antigravity/TokenStorage`）仅在进程启动时读取一次系统凭据，运行期热改凭据并调用 `ValidateProject` 无法热切换底层认证客户端，唯有同步四重状态库并重启 `language_server.exe` 方可切换个人与 `GCP` 模式。
   - <b>Tink `thoughtSignature` 密钥域隔离与内存常驻会话锁</b>：所有个人通道共享同一套 CloudCode 消费级 Tink 密钥域（Base64 前缀 `AWkUfR` / `FpFH0T` / `AEFNM`），跨个人号路由无需剥离签名即可 100% 验签通过；而 `GCP` 通道使用独立的 Vertex AI Tink 密钥域（前缀 `AY89a18` / `IDxACGAIqQ` / `CA8QAhgCKk`）。跨通道混发签名立即报 `HTTP 400 Invalid thought signature`，在多步 `functionCall` 中途动态剥离签名则会报 `HTTP 400 Function call is missing a thought_signature`，且不重启 `language_server.exe` 时 `LoadTrajectory` 会跳过已常驻内存的会话（`trajectory already loaded, skipping duplicate load`），故跨通道切换必须走第一层主通道重启与离线洗库流程。

### 3.3 透明代理端口冲突备用方案（`8091..8095` + 随机端口自动递增回退）
为防止默认 `8091` 端口被本机其他软件占用导致免重载路由失效，系统内置四重保障：
1. <b>健康指纹自检端点（`GET /__agy_proxy_ping`）</b>：透明代理内置专属健康探针，固定返回 `{"ok":true,"service":"antigravity-relay-proxy","port":<actualPort>}`。
2. <b>同源复用与异源递增回退</b>：`ensureCloudCodeProxyServer()` 启动时按候选序列 `[8091, 8092, 8093, 8094, 8095, 0]` 依次尝试绑定；若某端口返回 `EADDRINUSE`，先请求 `/__agy_proxy_ping` 验证是否为本插件已运行的代理实例——若是则直接复用，若被第三方进程占用则立即递增绑定下一个空闲端口（直至 `0` 由操作系统分配空闲随机端口）。
3. <b>配置持久化与全链路动态读取</b>：实际绑定的代理地址 `http://127.0.0.1:<actualPort>` 实时写入 `agy-relay-config.json` 的 `__meta__.cloudCodeProxyUrl`，`ls-bridge.mjs` 与 `relay-hook.cjs` 统一通过 `getActiveCloudCodeProxyUrl(cfg)` 动态获取并注入 `SetCloudCodeURL`，实现零硬编码自愈。

## 4. HTTP API 接口规范

所有接口由宿主分配的动态 Sidecar 端口与固定 `http://127.0.0.1:8089` 双端口同源提供。

### 4.1 获取实时系统快照与配额状态
- <b>路径</b>：`GET /api/status`
- <b>查询参数</b>：`force=1`（可选，强制穿透缓存拉取全通道最新云端配额）、`light=1`（可选，版本探针触发轻量刷新时跳过冗余个人额度云端探测，并复用 `30s` 内宿主 RPC 内存快照）。
- <b>返回格式</b>：包含 `lsOnline`、`activeAccount`、`availableModels`、`quotaGroups`、`accounts`、`routing`、`stateRevision`、`configMtimeMs` 及 `oauthPending` 的完整快照 JSON。

### 4.2 实时状态广播流（SSE）、嵌套轻量版本校验与僵尸自清理
- <b>独立端事件流</b>：`GET /api/events`（`text/event-stream; charset=utf-8`）在 `http://127.0.0.1:8089` 独立窗口中维持长连接并 `0ms` 推送快照；若请求进入宿主注入的动态端口（`plugin://` 网关背后），后端自动限定并发 `<= 2` 路并在 `20s` 后平滑断流防泄漏。
- <b>嵌套面板版本探针</b>：`GET /api/state-version` 返回 `revision`、`frontendVersion`、`configMtimeMs`、`oauthPending` 与 `lastOAuthEventId`。`plugin://` 协议下的内置面板在 `isPanelActuallyVisible()` 为真时改用按需轻量版本轮询（常规 `2.5s` 静默校验、`30s` 周期兜底，交互进行态 `750ms`），收到快照后立即同步回填 `lastKnownConfigMtimeMs` 防自激循环，彻底避免 Electron `customScheme` `fetchWithoutFollowing` 持有长 SSE 耗尽 Chromium 同源 6 连接池导致新建项目转圈卡死；后台隐藏标签零请求零占用。
- <b>父级 LS 存活看门狗</b>：`main.mjs` 每 `5s` 通过 TCP 探测 `ANTIGRAVITY_LS_ADDRESS`（Windows 下宿主经 `cmd.exe` 包装启动时 `process.ppid` 无法反映 `language_server.exe` 退出）；宿主退出后连续 `2` 次探活失败即自动退出并配合 `/api/restart-sidecar?onlyStandalone=1` 主动让出 `8089` 与历史会话端口。
- <b>只读零空写盘、写盘冷却监听与增量日志解析</b>：`store.mjs`（及 `relay-hook.cjs`）写盘前执行字节内容相等短路（`existingDiskRaw === serialized` 直接跳过），`ls-bridge.mjs` 仅在字段实质变化时刷新 `updatedAt`；`main.mjs` 挂载带 `800ms` 内部写盘冷却锁（`isInternalRelayWriteSettled`）的 `fs.watch` 外部变更监听；`wincred-ls.mjs` 的 `parseLsLogInfo` 按 `size + mtimeMs` 缓存与字节游标增量读取 `language_server.log`（非强制进程列表缓存 `20s`），避免空写盘惊动宿主插件目录监听或反复全量重读大日志。

### 4.3 通道、多开与诊断管理接口
- <b>收录当前已登录账号</b>：`POST /api/save-current-account`
- <b>启动旁路零打断 OAuth 登录</b>：`POST /api/start-oauth-login`（支持可选透传目标通道与登录提示参数）
- <b>取消进行中的 OAuth 登录</b>：`POST /api/cancel-oauth-login`
- <b>切换当前 GCP 计费项目</b>：`POST /api/switch-project`（请求体：`{ "projectId": "my-proj" }`）
- <b>扫描账号可用 GCP 项目列表</b>：`POST /api/discover-gcp-projects`（请求体：`{ "email": "user@gmail.com" }`）
- <b>添加独立个人通道</b>：`POST /api/add-personal-channel`（请求体：`{ "email": "user@gmail.com" }`）
- <b>添加独立 GCP 通道卡片</b>：`POST /api/add-gcp-channel`（请求体包含 `email`、`projectId`、`gcpBillingMode`、`gcpLocation`）
- <b>更新账号绑定项目或备注信息</b>：`POST /api/update-account`（请求体包含 `accountId`、`gcpProjectId`、`gcpBillingMode`、`gcpLocation`、`alias`）
- <b>启用指定通道（四重同步 + 跨通道自动重启当前实例）</b>：`POST /api/switch-account`（请求体：`{ "accountId": "user@gmail.com#personal", "scrubSignatures": true, "conversationId": "<uuid>" }`）
- <b>静默模型算力借道检查</b>：`POST /api/route-channel`（请求体：`{ "accountId": "user@gmail.com#personal" }`）
- <b>拉起独立多开实例</b>：`POST /api/launch-instance`（请求体：`{ "accountId": "user@gmail.com#gcp:my-proj" }`）
- <b>双模式清除思考签名</b>：`POST /api/scrub-signatures`（请求体：`{ "mode": "current" | "mismatched", "conversationId": "<uuid>" }`）
- <b>主动探测指定通道配额与诊断状态</b>：`POST /api/probe-channel-quota`（请求体：`{ "channelId": "user@gmail.com#personal" }`）
- <b>在系统浏览器打开 Google 验证或帮助外链</b>：`POST /api/open-external-url`（请求体：`{ "url": "https://accounts.google.com/..." }`，仅放行 HTTPS 下的 `google.com` / `googleapis.com` / `googleusercontent.com`）
- <b>切换个人通道配额账本兼容入口</b>：`POST /api/switch-quota-pool`（请求体：`{ "pool": "daily" | "prod" }`）
- <b>删除指定通道快照</b>：`POST /api/delete-account`（请求体：`{ "accountId": "user@gmail.com#personal" }`）

### 4.4 模型路由与国际化设置接口
- <b>保存模型与子智能体算力路由规则</b>：`POST /api/save-routing`（请求体包含 `modelId`、`variantIds`、`targetSpec`、`routeScope`、`subagentDefaultTarget`、`autoRelayOnLowQuota`）
- <b>动态切换中英文界面并持久化</b>：`POST /api/set-language`（请求体：`{ "lang": "zh" }` 或 `{ "lang": "en" }`）
