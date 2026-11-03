---
name: account-and-hotswap
description: >-
  [TRIGGER] 当开发或修改 Antigravity Relay (AGY Relay) 的旁路 OAuth 浏览器登录、当前已登录账号识别收录、Windows 凭据管理器 gemini:antigravity 切换、GCP 通道切换或个人通道免重载透明代理路由（relay-hook.cjs / ls-bridge.mjs / store.mjs）时自动激活。
  [SCOPE] 统管 Antigravity 2.0 官方 OAuth 2.0 + PKCE S256 旁路零打断登录、gemini:antigravity 凭据写入、SetCloudCodeURL(http://127.0.0.1:8091..8095) 个人通道免重载 Bearer Token 动态替换、端口冲突自动递增回退及双层 thoughtSignature 无损剥离契约。
---

# 账号池管理、旁路无打断登录与双层算力路由契约

## 一、 核心定位与三大架构铁律

1. <b>双层隔离架构（上方独立通道池重载切换 vs 底部个人通道免重载路由）</b>：
   - <b>上方独立通道池（`Free` / `Plus` / `Pro` / `Ultra` / `GCP` 显式点击「启用」）</b>：无论是跨账号还是同账号在个人通道与 `GCP` 之间点击「启用」，统一覆写 `gemini:antigravity` 系统凭据、离线剥离最近会话 `.db` 中的跨通道思维签名（不向旧进程调 `LoadTrajectory` 防止回写污染），并重启 `language_server.exe` 触发主界面重载。
   - <b>底部模型路由池（100% 仅限个人 `Free` / `Plus` / `Pro` / `Ultra` 通道免重载接力）</b>：`GCP` 通道完全独立不参与底部路由；当处于个人模式时，自动通过 `SetCloudCodeURL({ url: getActiveCloudCodeProxyUrl(cfg) })` 将 `language_server.exe` 的 `/v1internal` 请求挂载至本地透明反向代理（默认 `8091`，冲突时按 `[8091..8095, 0]` 自动递增回退并校验 `/__agy_proxy_ping` 健康指纹），在内存中按路由表动态替换为目标个人账号的 `Authorization: Bearer <Token>` 并实时剥离 JSON `thoughtSignature`，实现<b>0 重载、0 签名报错、跨个人账号无感扣费接力</b>。
   - <b>旁路添加新账号 100% 零打断当前会话</b>：呼出 Antigravity 官方 Google OAuth 登录页（`ClientID: 1071006060591-...`）必须在 Sidecar 独立随机端口回调中完成，无论用户中途取消还是成功授权，均严禁改写当前在线 `gemini:antigravity` 或重启 `language_server.exe`，同时支持免重登直接复用已授权账号凭据派生独立 `GCP` 通道。

## 二、 插件物理目录与模块职责映射

```text
~/.gemini/config/plugins/antigravity-relay/
├── plugin.json                        # 插件元数据清单
├── hooks.json                         # PreInvocation 与 Stop 钩子配置
├── relay-hook.cjs                     # 零依赖极速算力池无感路由与 Sidecar 自启动守护钩子
├── assets/logo.svg                    # 64x64 纯内联矢量图标
├── skills/                            # 专属领域技能书（零 rules/ 常驻开销）
│   ├── account-and-hotswap/SKILL.md   # 账号登录、热切与路由契约（本文件）
│   └── quota-and-ledger/SKILL.md      # 配额池探针与 Sidecar 面板契约
└── sidecars/panel/                    # 原生免构建前后端分离 Sidecar 面板
    ├── sidecar.json                   # AUX_PANE 侧边栏入口声明
    ├── main.mjs                       # HTTP + SSE 双端口（宿主动态端口 + 8089）服务入口
    ├── ls-bridge.mjs                  # LS Connect-RPC、8091 透明代理、WinCred 读写与旁路 OAuth 引擎
    ├── store.mjs                      # agy-relay-config.json 原子落盘与脏模型自动清洗
    ├── index.html                     # 零 Emoji 响应式面板骨架
    ├── styles.css                     # 纯扁平无渐变深浅色自适应样式表
    ├── i18n.js                        # 中英严格隔离双语词典
    └── app.js                         # 面板前端状态与事件交互逻辑
```

---

## 三、 双轨添号契约：识别当前已登录账号 + 旁路零打断浏览器登录（`ls-bridge.mjs`）

1. <b>轨道一：识别并收录当前已登录账号（`fetchLiveSystemSnapshot` / `save-current-account`）</b>：
   - 通过 C# P/Invoke 调用 `Advapi32.dll` 的 `CredReadW("gemini:antigravity", CRED_TYPE_GENERIC)`，读取当前会话的 `StoredToken` JSON（含 `access_token`、`refresh_token`、`expiry`、`id_token`、`id_token_email`、`project_id`）。
   - 同时调用 `language_server.exe` 的 `GetUserStatus` 获取真实订阅等级名称，即使当前处于 `GCP` 通道，点击「收录当前」也会自动补建并探测该邮箱的 `${email}#personal` 个人通道卡片。
2. <b>轨道二：呼出 Antigravity 官方浏览器登录界面（`startIsolatedOAuthFlow`，100% 零打断当前账号）</b>：
   - <b>官方 OAuth 参数（运行时动态读取）</b>：
     - `client_id` / `client_secret`：由 `ls-bridge.mjs` 从本地运行环境动态加载，不在公开仓库硬编码凭据常量
     - `scope`：`openid email profile https://www.googleapis.com/auth/aicode https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/experimentsandconfigs https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile`
     - PKCE：`code_challenge_method=S256`、`access_type=offline`、`prompt=consent`
   - <b>旁路零打断隔离机制与防 `&` 截断浏览器拉起</b>：
     - Sidecar 在本地 `127.0.0.1:0` 随机端口启动独立 HTTP 监听 `/auth/callback`，并通过 `spawn("rundll32.exe", ["url.dll,FileProtocolHandler", authUrl.toString()])` 直接调用 Win32 URL 协议处理器拉起浏览器（严禁使用 `cmd.exe /c start` 导致 URL 中的 `&response_type=code` 被当作命令分隔符截断）。
     - 若用户在浏览器点击取消、关闭网页或在面板点击「取消」按钮：`cancelIsolatedOAuthFlow()` 立即关闭临时监听，<b>全程不触碰 `gemini:antigravity` 与 `language_server.exe`</b>，当前在线会话不受任何影响。
     - 若用户完成 Google 授权：回调将浏览器 `302` 重定向至官方成功页 `https://antigravity.google/auth-success?app=antigravity`，后台静默向 `oauth2.googleapis.com/token` 换取 `StoredToken`，自动建立 `${email}#personal` 个人通道卡片（严禁未经用户确认自动把所有云项目直接塞入通道列表）。

---

## 四、 独立通道池（`#personal` vs `#gcp:<id>`）与「双层无损签名剥离」契约

1. <b>同邮箱多通道独立建卡与非侵入式项目扫描（`normalizeAccountChannels` / `discoverGcpProjectsForAccount`）</b>：
   - 同一 Google 账号下的「个人通道（`#personal`）」与「云项目通道（`#gcp:<id>`）」配额池与可用模型完全独立，在 `agy-relay-config.json` 中并存互不覆盖。
   - `+ 添加通道` 抽屉支持选择「`Pro 通道`」或「`GCP 通道`」；点击「自动扫描」时，`discoverGcpProjectsForAccount` 仅返回候选 `[{ projectId, name }]` 供前端自动填入（单个项目）或下拉选择（多个项目），仅当用户点击「确认添加」时才正式落盘通道卡片。
2. <b>第一层签名剥离（点击「启用」切换 `Pro <-> GCP` 或跨账号时：`scrubRecentConversationsSignatures` + 重启 `language_server.exe`）</b>：
   - Google Gemini 模型的思考签名（`thought_signature`）与原通道/原账号密钥强绑定，跨通道直接复用会触发 `INVALID_ARGUMENT (code 400): Invalid thought signature`。
   - `switchActiveGoogleAccount` 点击「启用」时，先离线扫描 `~/.gemini/antigravity/conversations/<cascade_id>.db` 的 `steps` 与 `gen_metadata` 表，递归剥离 Protobuf Wire Format 中包含签名魔数头（`0x01 0x69 0x14 0x7d 0x13` 或 Base64 `AWkUfR` / `FpFH0T`）的叶子节点（100% 保留正文与 `toolCall`），<b>严禁在重启前对旧 `language_server.exe` 调用 `LoadTrajectory`（防止旧进程退出时将内存旧签名回写覆盖 `.db`）</b>，随后立即终止旧进程并拉起新 `language_server.exe`，实现 `GCP <-> Pro` 切换后继续同一会话 0 报错。
3. <b>第二层签名剥离与免重载跨账号路由（个人模式下 `127.0.0.1:8091` 透明反向代理：`proxyCloudCodeRequest`）</b>：
   - `ls-bridge.mjs` 模块加载时自举监听 `http://127.0.0.1:8091`（通过 `globalThis.__agyCloudCodeProxyHandler` 支持热更新），个人模式（`!isLiveGcp`）下自动向 `language_server.exe` 发送 `SetCloudCodeURL({ url: "http://127.0.0.1:8091" })`（`GCP` 模式下固定恢复为 `https://daily-cloudcode-pa.googleapis.com`）。
   - <b>拦截 `/v1internal:(streamGenerateContent|generateContent)`</b>：按 `routing.models[baseFamily]` 规则（`follow_current`、`auto_poll` 或指定 `account:<email>#personal`），在内存中将请求头替换为目标个人账号的 `Authorization: Bearer <Token>`（`project: "aicode-consumers"`），并调用 `stripThoughtSignaturesFromJson(bodyJson)` 递归剔除 JSON 请求体中所有 `thoughtSignature` / `thought_signature` 字段；流式响应结束后 2 秒异步触发 `probeChannelQuotaSnapshot` 刷新目标个人通道配额。
   - <b>拦截 `/v1internal:fetchAvailableModels` 防 0% 锁死</b>：当主个人账号某模型（如 `Gemini 4 Argon`）额度降至低位或 `0%` 时，若该模型在 `routing.models` 中已配置指向有余额的其他个人通道或 `auto_poll`，代理在返回给 `language_server.exe` 前自动用目标个人通道的 `remainingFraction` 覆盖该模型的 `quotaInfo`，防止前端 UI 锁死禁用该模型。
