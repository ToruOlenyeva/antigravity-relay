---
name: quota-and-ledger
description: >-
  [TRIGGER] 当开发或修改 Antigravity Relay (AGY Relay) 的三大配额池实时探针、可用模型列表过滤或 Sidecar 辅助侧边栏可视化面板（main.mjs / index.html / styles.css / i18n.js / app.js）时自动激活。
  [SCOPE] 统管本地 language_server.exe GetUserStatus 与 RetrieveUserQuotaSummary Connect-RPC 探针、CloudCode 原生 User-Agent 三大配额池探测及 Sidecar 面板 UI/UX 规范。
---

# 三大配额池实时探针与 Sidecar 可视化面板契约

## 一、 本地 `language_server.exe` 与 CloudCode 原生三配额池探针（`ls-bridge.mjs`）

1. <b>动态发现 `language_server.exe` 端点（`discoverLanguageServer`）</b>：
   - 优先结合 `%APPDATA%\Antigravity\logs\language_server.log` 最新 PID/端口与环境变量 `ANTIGRAVITY_CSRF_TOKEN` 免子进程定位端点；降级时通过 `Get-CimInstance Win32_Process -Filter "Name LIKE 'language_server%'"` 提取 `--csrf_token`。
   - 将 `{hostname: "127.0.0.1", port, protocol, altPort, altProtocol, csrf}` 缓存至 `agy-relay-config.json` 的 `__meta__.lsRpcTarget`，供 `relay-hook.cjs` 在 `< 5ms` 内直接复用。
2. <b>CloudCode 原生请求头契约与三大配额池精准识别（`callCloudCodeApi` + `parseCloudCodeModelsAndQuota`）</b>：
   - <b>三套官方 OAuth Client 自动轮询刷新（`AGY_OAUTH_CLIENTS`）</b>：收录账号可能来自 Antigravity 不同版本的 3 套官方 OAuth Client（`1071006060591-...`、`884354919052-...`、`1098991175725-...`），`refreshOAuthAccessToken` 按序遍历匹配刷新 Token。
   - <b>`language_server.exe` 原生 `User-Agent` 触发 `Gemini 4 Argon` 独立配额池</b>：向 `daily-cloudcode-pa.googleapis.com` 请求 `/v1internal:fetchAvailableModels` 与 `/v1internal:retrieveUserQuotaSummary` 时，必须使用 `language_server.exe` 真实请求头 `"User-Agent": "antigravity/hub/2.28.2 (aidev_client; os_type=windows; arch=amd64; cl=1009437749)"`（严禁使用旧版伪造 `antigravity/2.28.2 windows/amd64` 或 `X-Goog-Ext-525006001-bin`，否则云端会隐藏 `gemini-4-argon-medium/high/low` 模型项与第 3 个 `Gemini 4 Argon` 配额组）。
   - <b>全等级个人账号（`Free` / `Plus` / `Pro` / `Ultra`）精准鉴别（`detectPersonalAccountTier`）</b>：
     - <b>`Ultra`（`Google AI Ultra`）与 `Pro`（付费 `Google AI Pro`）</b>：`tierName`/`tierId` 含 `ultra` 判定为 `Ultra`；云端原生返回可用 `Gemini 4 Argon`、`Gemini 3.8 Flash`、`Claude Opus 5.5`、`Claude Sonnet 5.5` 四大模型家族及<b>完整的三大官方配额组</b>（`Gemini Models`、`Claude and GPT models`、以及含 `bucketId: "gemini-argon-wtu-weekly"` 的独立 `Gemini 4 Argon` 周限额组）判定为 `Pro`；在 `buildProModelsFromQuotaGroups` 中，`Gemini 4 Argon` 仅匹配 `argonGroup` 与自身 `quotaInfo`（严禁回退混用 `Gemini 3.8 Flash` 的 `geminiGroup` 配额桶）。
     - <b>`Plus`（如渠道合作赠送版或 `Google One AI Plus`）与 `Free`（无会员免费账号）</b>：云端返回 `gemini-4-argon-disabled`（`tagTitle: "Unavailable"`），自动剔除不可用的 `Gemini 4 Argon`、`Claude` 与即将下线的旧模型，仅保留真实可用的模型（如 `Gemini 3.8 Flash`），并根据是否携带会员层级标识精准标定为 `Plus` 或 `Free`，全部支持参与底部个人通道免重载算力路由。
   - <b>Go `proto3` 零值（`0%`）配额判定准则</b>：当模型或桶位配额耗尽（`remaining_fraction == 0`）时，Go `proto3` JSON 序列化会省略 `remainingFraction` 字段（`undefined`）但保留 `resetTime`；因此当 `remainingFraction === undefined` 且存在 `resetTime` 时，必须判定为 `0%`（而非默认回退为 `100%`）。

---

## 二、 Sidecar 面板 UI 与专有名词规范（`index.html` / `styles.css` / `i18n.js` / `app.js`）

1. <b>极简三段式卡片布局与专有名词保留（中英文统一保留 `[Pro]` / `[GCP]` 方形徽章）</b>：
   - <b>第一段（当前会话与使用量）</b>：顶部全宽自定义圆角下拉框展示前置方形徽章 `[Pro]` / `[GCP]` + 账号邮箱（及 `GCP` 项目编号）；付费 `Pro` 通道展示 1:1 对齐官方 UI 的三大配额组（`Gemini 模型`、`Claude 和 GPT 模型`、`Gemini 4 Argon` + SVG 环形进度圈 + 重置倒计时）；`GCP` 通道展示当前计费模式与可用模型芯片，绝对不显示剩余百分比。
   - <b>第二段（独立通道池：`Pro` 通道与 `GCP` 通道自由并存）</b>：顶栏提供 `收录当前`、`+ 添加通道` 与 `+ 添加账号` 按钮；点击 `+ 添加通道` 展开内联抽屉，支持切换 `[Pro 通道 / GCP 通道]`；`GCP` 模式下点击 `自动扫描` 仅拉取候选项目（单个项目直接填入输入框，多个项目渲染为下拉列表供点击填入，绝不直接批量建卡污染通道池）。
   - <b>第三段（个人通道模型算力路由）</b>：仅汇总个人通道（`Pro` / `Ultra`）真实可用模型并集（`GCP` 通道彻底独立不参与底部免重载路由），右侧采用自定义圆角悬浮下拉框（`.custom-dropdown`），仅列出真实支持该模型的个人分流通道及「自动轮询 (按额度/重置时间优选)」。
2. <b>视觉与双语排版红线</b>：
   - <b>专有名词不翻译、普通描述中英隔离</b>：`Pro` 与 `GCP` 作为行业与产品专有名词在中英文界面均保持原样（如 `Pro`、`GCP`、`Pro 通道`、`GCP 通道`），其余计费与区域描述保持中英严格隔离（中文使用 `按量计费 · 智能体平台`、`企业版共享配额`、`全局应用`、`美国区`、`欧洲区`）。
   - <b>零 Emoji 与零渐变色</b>：全界面严禁使用任何 Emoji 字符、原生 `<select>` 或 CSS 渐变，统一使用纯净扁平色板与圆角边框。
   - <b>短词按钮防挤出</b>：所有按钮文案严格控制在 2~4 个汉字（如 `刷新`、`收录当前`、`+ 添加通道`、`+ 添加账号`、`设置`、`启用`、`删除`），配合 `flex-shrink: 0` 与 `white-space: nowrap` 杜绝文字换行或挤出容器。

---

## 三、 分级自测与验证门禁

1. <b>Tier 0 语法与文档门禁</b>：验证 `relay-hook.cjs` 与 `sidecars/panel/` 下各 `.mjs` 模块零语法报错，所有 `.md` 文档通过零物理星号与相对路径零死链校验。
2. <b>Tier 1 核心探针与透明代理安全断言</b>：验证 `fetchLiveSystemSnapshot` 与 `probeAllChannelsQuotaSnapshot` 真实返回付费 `Pro` 三大配额池（含 `Gemini 4 Argon` 独立周限额）与渠道版 `Pro` 模型过滤，确认 `127.0.0.1:8091` 透明代理在跨个人账号路由时准确替换 `Bearer Token`、剥离 `thoughtSignature` 且精确扣减目标账号配额。
3. <b>Tier 2 Sidecar 面板闭环核验</b>：验证 `/api/status` 返回 HTTP 200 真实 JSON 数据，确认顶部/卡片/路由下拉框前置方形徽章 `[Pro]` / `[GCP]`、顶栏 `+ 添加通道` 抽屉及个人通道模型路由下拉框端到端正常工作。
