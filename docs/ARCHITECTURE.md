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
├── skills/
│   ├── account-and-hotswap/     # 账号池、旁路 OAuth 与透明代理路由规范
│   └── quota-and-ledger/        # 三大配额池探针与全等级模型过滤规范
├── sidecars/
│   └── panel/                   # 原生免构建前后端物理分离 Sidecar 面板
│       ├── app.js               # 前端核心交互、自定义下拉与状态同步引擎
│       ├── i18n.js              # 前端中英双语严格隔离词典
│       ├── index.html           # 前端纯骨架页面
│       ├── ls-bridge.mjs        # 后端 LS RPC、透明代理、WinCred 与 OAuth 引擎
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

### 2.2 五大通道等级（`Free` / `Plus` / `Pro` / `Ultra` / `GCP`）裁决矩阵
系统通过 `detectPersonalAccountTier(rawModelsListOrMap, rawTierName, rawTierId, prevIsPaid)` 综合云端返回的 `userTier` 信息与真实可用模型集完成全等级标定：
1. <b>`GCP`（云项目通道）</b>：绑定独立 `gcpProjectId`，采用 `Agent Platform` 按量计费或 `Gemini Code Assist` 企业共享配额，卡片与顶部面板展示计费模式与可用模型芯片，不展示个人百分比圆环。
2. <b>`Ultra`（`Google AI Ultra`）</b>：`tierName` 或 `tierId` 匹配 `ultra` 标识，支持全系 `Gemini 4 Argon`、`Gemini 3.8 Flash`、`Claude Opus 5.5` 与 `Claude Sonnet 5.5` 并享有最高配额池。
3. <b>`Pro`（付费 `Google AI Pro`）</b>：云端返回可用（非 `disabled` 且无 `Unavailable` 标签）的 `gemini-4-argon` 或 `claude-opus` / `claude-sonnet` 模型家族。
4. <b>`Plus`（`Google One AI Plus` 或 Jio 等渠道合作赠送版）</b>：账号虽带有会员标识，但云端下发 `gemini-4-argon-disabled`（`tagTitle: "Unavailable"`），仅开放 `Gemini 3.8 Flash` 等基础主力模型。
5. <b>`Free`（无会员免费个人账号）</b>：未订阅任何付费层级的普通 Google 个人账号，自动提取其真实开放的免费可用模型并参与个人通道算力路由。

## 3. 双层通道架构：主通道重载切换 vs 个人通道免重载路由

### 3.1 第一层：独立通道池「启用」切换与 SQLite 离线签名剥离
当用户在「独立通道池」点击某张卡片（无论是跨个人账号，还是在 `GCP` 与个人通道之间切换）的「启用」按钮时：
1. <b>系统凭据覆写</b>：通过 Win32 `Advapi32.dll` `CredWriteW` 更新 `gemini:antigravity` 系统凭据中的 `StoredToken` 与 `project_id`。
2. <b>离线 Protobuf 思维签名无损剥离（`scrubRecentConversationsSignatures`）</b>：
   - Google Gemini 模型的思考签名（`thought_signature`）与生成该签名的通道密钥强绑定，跨通道继续同一会话会触发 `INVALID_ARGUMENT (400): Invalid thought signature`。
   - 切换进程前，系统直接扫描 `~/.gemini/antigravity/conversations/<cascade_id>.db` 的 `steps` 与 `gen_metadata` 表，递归移除包含签名魔数头（`0x01 0x69 0x14 0x7d 0x13` 或 Base64 `AWkUfR` / `FpFH0T`）的 Protobuf Wire 字段，100% 保留聊天正文与工具调用记录。
   - <b>严禁向旧进程发送 `LoadTrajectory`</b>：避免旧 `language_server.exe` 退出时把内存中的带签名旧轨迹回写覆盖 `.db`，随后直接重启 `language_server.exe` 触发主界面干净重载。

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
- <b>启用指定通道（重载主界面）</b>：`POST /api/switch-account`（请求体：`{ "channelId": "user@gmail.com#personal" }`）
- <b>删除指定通道</b>：`POST /api/remove-account`（请求体：`{ "channelId": "user@gmail.com#personal" }`）
- <b>查询非当前通道缓存配额</b>：`POST /api/probe-channel-quota`（请求体：`{ "channelId": "user@gmail.com#personal", "force": false }`）

### 4.4 模型路由与国际化设置接口
- <b>设置模型算力路由规则</b>：`POST /api/set-route`（请求体：`{ "targetType": "models", "key": "Gemini 3.8 Flash", "routeValue": "auto_poll" }`）
- <b>动态切换中英文界面并持久化</b>：`POST /api/set-language`（请求体：`{ "lang": "zh" }` 或 `{ "lang": "en" }`）
