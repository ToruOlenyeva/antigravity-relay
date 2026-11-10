import https from "node:https";
import http from "node:http";
import zlib from "node:zlib";
import {
  readRelayConfig,
  writeRelayConfig,
  resolveCurrentInstanceContext,
  getInstanceMeta
} from "../store.mjs";
import {
  discoverLanguageServer,
  callLsRpc,
  refreshOAuthAccessToken,
  getCloudCodeUserAgent,
  buildLoadCodeAssistMetadata
} from "./wincred-ls.mjs";
import {
  normalizeAccountChannels,
  findStoredTokenForEmail,
  probeChannelQuotaSnapshot,
  callCloudCodeApi,
  isDowngradedConsumerPoolProject,
  resolvePersonalCompanionProjectId,
  normalizePersonalQuotaPool,
  getActivePersonalQuotaPool,
  getCloudCodeHostnameForPool,
  deriveCloudCodeSlugFromLabel,
  learnModelsFromCloudCodeResponse
} from "./quota-probe.mjs";

export function isGcpThoughtSignature(sigVal) {
  if (typeof sigVal !== "string") return false;
  const s = sigVal.trim();
  return s.startsWith("AY89a18") || s.startsWith("IDxACGAIqQ") || s.startsWith("CA8QAhgCKk");
}

export function stripThoughtSignaturesFromJson(node, opts = {}) {
  if (!node || typeof node !== "object") return 0;
  const onlyGcpSignatures = Boolean(opts?.onlyGcpSignatures);
  let count = 0;
  if (Array.isArray(node)) {
    for (const item of node) {
      count += stripThoughtSignaturesFromJson(item, opts);
    }
    return count;
  }
  for (const key of Object.keys(node)) {
    if (key === "thoughtSignature" || key === "thought_signature") {
      if (!onlyGcpSignatures || isGcpThoughtSignature(node[key])) {
        delete node[key];
        count++;
      }
    } else if (node[key] && typeof node[key] === "object") {
      count += stripThoughtSignaturesFromJson(node[key], opts);
    }
  }
  return count;
}

export function resolveBaseModelFamilyFromId(rawModelStr, cfg) {
  const s = String(rawModelStr || "").trim();
  if (!s) return "";
  const lower = s.toLowerCase();

  // 1. 优先从动态自学习注册表（随客户端版本自动更新）解析模型家族
  const dynFamily = cfg?.__meta__?.dynamicModelRegistry?.placeholderToFamily?.[lower];
  if (dynFamily) return dynFamily;

  // 2. 扫描当前所有已收录账号的 availableModels 变体表
  for (const acc of Object.values(cfg?.accounts || {})) {
    const pools = [
      acc?.cachedQuota?.availableModels,
      acc?.cachedQuotaByPool?.prod?.availableModels,
      acc?.cachedQuotaByPool?.daily?.availableModels
    ];
    for (const list of pools) {
      for (const m of (list || [])) {
        const mLabel = String(m.modelId || m.label || "").trim();
        if (mLabel.toLowerCase() === lower) return mLabel;
        if (Array.isArray(m.variantIds) && m.variantIds.some((v) => String(v).toLowerCase() === lower)) {
          return mLabel;
        }
      }
    }
  }

  // 3. 通用语义匹配与离线静态兜底
  if (/argon|m417|m418|m419/i.test(lower)) return "Gemini 4 Argon";
  if (/3[._-]8[._-]flash|m47\b|m318|m319|m320|m420|m421|m422/i.test(lower)) return "Gemini 3.8 Flash";
  if (/3[._-]7[._-]flash|m55|m62|m63|m298|m299|m300/i.test(lower)) return "Gemini 3.7 Flash";
  if (/3[._-]6[._-]flash|m51|m60|m61|m71|m72|m73/i.test(lower)) return "Gemini 3.6 Flash";
  if (/3[._-]1[._-]pro|m36|m37/i.test(lower)) return "Gemini 3.1 Pro";
  if (/opus[._-\s]*5[._-]5|m400|m401|m402|m406|m409|m410|m411|m412/i.test(lower)) return "Claude Opus 5.5";
  if (/sonnet[._-\s]*5[._-]5|m403|m404|m405|m407|m413|m414|m415|m416/i.test(lower)) return "Claude Sonnet 5.5";
  if (/sonnet[._-\s]*4[._-]6|m35\b/i.test(lower)) return "Claude Sonnet 4.6 (Thinking)";
  if (/opus[._-\s]*4[._-]6|m26\b/i.test(lower)) return "Claude Opus 4.6 (Thinking)";
  if (/gpt[._-\s]*oss|m12\b/i.test(lower)) return "GPT-OSS 120B";

  return s.replace(/\s*\((Low|Medium|High|Max)\)\s*$/i, "").trim();
}

const FALLBACK_CONSUMER_MODEL_ID_MAP = {
  "model_placeholder_m417": "gemini-4-argon-high",
  "model_placeholder_m418": "gemini-4-argon-medium",
  "model_placeholder_m419": "gemini-4-argon-low",
  "model_placeholder_m420": "gemini-3.8-flash-high",
  "model_placeholder_m421": "gemini-3.8-flash-medium",
  "model_placeholder_m422": "gemini-3.8-flash-low",
  "model_placeholder_m318": "gemini-3.8-flash-high",
  "model_placeholder_m319": "gemini-3.8-flash-medium",
  "model_placeholder_m320": "gemini-3.8-flash-low",
  "model_placeholder_m47": "gemini-3.8-flash-medium",
  "model_placeholder_m409": "claude-opus-5-5-low",
  "model_placeholder_m410": "claude-opus-5-5-medium",
  "model_placeholder_m411": "claude-opus-5-5-high",
  "model_placeholder_m412": "claude-opus-5-5-max",
  "model_placeholder_m400": "claude-opus-5-5-low",
  "model_placeholder_m401": "claude-opus-5-5-medium",
  "model_placeholder_m402": "claude-opus-5-5-high",
  "model_placeholder_m406": "claude-opus-5-5-max",
  "model_placeholder_m413": "claude-sonnet-5-5-low",
  "model_placeholder_m414": "claude-sonnet-5-5-medium",
  "model_placeholder_m415": "claude-sonnet-5-5-high",
  "model_placeholder_m416": "claude-sonnet-5-5-max",
  "model_placeholder_m403": "claude-sonnet-5-5-low",
  "model_placeholder_m404": "claude-sonnet-5-5-medium",
  "model_placeholder_m405": "claude-sonnet-5-5-high",
  "model_placeholder_m407": "claude-sonnet-5-5-max",
  "model_placeholder_m35": "claude-sonnet-4-6-thinking",
  "model_placeholder_m26": "claude-opus-4-6-thinking",
  "model_placeholder_m36": "gemini-3.1-pro-low",
  "model_placeholder_m37": "gemini-3.1-pro-high",
  "model_placeholder_m12": "gpt-oss-120b-medium",
  "model_openai_gpt_oss_120b_medium": "gpt-oss-120b-medium"
};

export function normalizeConsumerModelId(rawModelStr, cfg = null) {
  const s = String(rawModelStr || "").trim();
  if (!s) return s;
  const lower = s.toLowerCase();

  // 1. 优先查询动态自学习注册表（随客户端版本与 GetUserStatus / fetchAvailableModels 实时同步）
  const activeCfg = cfg || (() => { try { return readRelayConfig(); } catch { return null; } })();
  const dynReg = activeCfg?.__meta__?.dynamicModelRegistry;
  if (dynReg?.placeholderToSlug?.[lower]) {
    return dynReg.placeholderToSlug[lower];
  }
  if (dynReg?.labelToSlug?.[lower]) {
    return dynReg.labelToSlug[lower];
  }

  // 2. 若在已探测的 availableModels.variantIds 中同时存在 placeholder 与真实云端 slug，自动反查
  for (const acc of Object.values(activeCfg?.accounts || {})) {
    const pools = [
      acc?.cachedQuota?.availableModels,
      acc?.cachedQuotaByPool?.prod?.availableModels,
      acc?.cachedQuotaByPool?.daily?.availableModels
    ];
    for (const list of pools) {
      for (const m of (list || [])) {
        if (!Array.isArray(m.variantIds)) continue;
        if (m.variantIds.some((v) => String(v).toLowerCase() === lower)) {
          const realSlug = m.variantIds.find(
            (v) => /^[a-z0-9._-]+$/.test(String(v)) && !/^model_placeholder_/i.test(String(v))
          );
          if (realSlug) return realSlug;
        }
      }
    }
  }

  // 3. 若传入的是带空格或括号的展示名，动态按语义规则转成标准云端 slug
  if (/\s|\(/.test(s)) {
    return deriveCloudCodeSlugFromLabel(s);
  }

  // 4. 静态冷启动兜底
  return FALLBACK_CONSUMER_MODEL_ID_MAP[lower] || s;
}

export async function ensurePersonalCompanionProjectId(cfg, acc, accessToken, targetHostname = "cloudcode-pa.googleapis.com") {
  if (!acc) return "";
  const resolved = resolvePersonalCompanionProjectId(
    cfg,
    acc.email,
    acc.companionProjectId ||
      acc.cachedQuota?.companionProjectId ||
      acc.cachedQuotaByPool?.prod?.companionProjectId ||
      acc.cachedQuotaByPool?.daily?.companionProjectId ||
      ""
  );
  if (resolved && !isDowngradedConsumerPoolProject(resolved)) {
    if (acc.companionProjectId !== resolved) {
      acc.companionProjectId = resolved;
      writeRelayConfig(cfg);
    }
    return resolved;
  }
  if (!accessToken) return "";
  const hostCandidates = Array.from(
    new Set([targetHostname, "cloudcode-pa.googleapis.com", "daily-cloudcode-pa.googleapis.com"].filter(Boolean))
  );
  for (const host of hostCandidates) {
    try {
      const loadResp = await callCloudCodeApi(
        "/v1internal:loadCodeAssist",
        accessToken,
        {
          metadata: buildLoadCodeAssistMetadata()
        },
        {},
        host
      );
      if (loadResp.status === 200 && loadResp.data) {
        const pid = String(
          loadResp.data.cloudaicompanionProject?.id ||
          loadResp.data.cloudaicompanionProject ||
          ""
        ).trim();
        if (pid && !isDowngradedConsumerPoolProject(pid)) {
          const lockedPid = resolvePersonalCompanionProjectId(cfg, acc.email, pid);
          acc.companionProjectId = lockedPid;
          if (acc.cachedQuota && typeof acc.cachedQuota === "object") {
            acc.cachedQuota.companionProjectId = lockedPid;
          }
          if (acc.cachedQuotaByPool && typeof acc.cachedQuotaByPool === "object") {
            for (const pq of Object.values(acc.cachedQuotaByPool)) {
              if (pq && typeof pq === "object") pq.companionProjectId = lockedPid;
            }
          }
          writeRelayConfig(cfg);
          return lockedPid;
        }
      }
    } catch {}
  }
  return "";
}

const WEEK_PENALTY_MS = 7 * 24 * 3600 * 1000;

export function extractModelDualQuota(accOrQuota, matched, baseFamily) {
  const now = Date.now();
  const defaultWeeklyMs = now + WEEK_PENALTY_MS;
  const groups = Array.isArray(accOrQuota?.quotaGroups)
    ? accOrQuota.quotaGroups
    : (accOrQuota?.cachedQuota?.quotaGroups || []);
  const clean = String(baseFamily || matched?.label || matched?.modelId || "").toLowerCase();

  let grp = null;
  for (const g of groups) {
    const desc = String(g.description || "").toLowerCase();
    const gName = String(g.displayName || g.id || "").toLowerCase();
    if ((clean && desc.includes(clean)) || (clean && gName === clean)) {
      grp = g;
      break;
    }
  }
  if (!grp) {
    if (/argon/i.test(clean)) {
      grp = groups.find((g) => /argon/i.test(g.id || g.displayName || ""));
    } else if (/gemini/i.test(clean)) {
      grp = groups.find((g) => /gemini\s*models/i.test(g.id || g.displayName || ""));
    } else if (/claude|gpt/i.test(clean)) {
      grp = groups.find((g) => /claude|gpt/i.test(g.id || g.displayName || ""));
    }
  }

  const bks = grp?.buckets || [];
  const bWk = bks.find((b) => /weekly|7d/i.test(b.window || b.bucketId || ""));
  const b5h = bks.find((b) => /5h/i.test(b.window || b.bucketId || ""));

  const weeklyPct = Number(
    matched?.weeklyPct ?? bWk?.remainingPct ?? matched?.remainingPct ?? 100
  );
  const weeklyResetStr = matched?.weeklyResetTime || bWk?.resetTime || matched?.resetTime || "";
  const parsedWkMs = weeklyResetStr ? new Date(weeklyResetStr).getTime() : defaultWeeklyMs;
  const weeklyResetMs = Number.isFinite(parsedWkMs) && parsedWkMs > 0 ? parsedWkMs : defaultWeeklyMs;

  const fiveHourPct = Number(
    matched?.fiveHourPct ?? b5h?.remainingPct ?? weeklyPct
  );
  const fiveHourResetStr = matched?.fiveHourResetTime || b5h?.resetTime || weeklyResetStr;
  const parsed5hMs = fiveHourResetStr ? new Date(fiveHourResetStr).getTime() : weeklyResetMs;
  const fiveHourResetMs = Number.isFinite(parsed5hMs) && parsed5hMs > 0 ? parsed5hMs : weeklyResetMs;

  return {
    weeklyPct,
    weeklyResetMs,
    fiveHourPct,
    fiveHourResetMs
  };
}

export function hasActivePersonalRoutingConfig(cfg) {
  if (getActivePersonalQuotaPool(cfg) === "prod") return true;
  const models = cfg?.routing?.models || {};
  return Object.values(models).some((v) => v && v !== "follow_current");
}

export function selectBestPersonalRouteCandidate(baseFamily, cfg, excludedIds = null) {
  const accounts = Object.values(cfg?.accounts || {});
  const activeEmail = (cfg?.__meta__?.activeEmail || "").trim();
  const activeChannelId = activeEmail ? `${activeEmail}#personal` : "";
  const preferredPool = getActivePersonalQuotaPool(cfg);
  const poolsOrder = preferredPool === "daily" ? ["daily", "prod"] : ["prod", "daily"];
  const thresholdPct = Number(cfg?.routing?.lowQuotaThresholdPct ?? 5);
  const targetLower = (baseFamily || "").toLowerCase();
  const excludeSet = excludedIds instanceof Set ? excludedIds : new Set(Array.isArray(excludedIds) ? excludedIds : []);
  const candidates = [];

  for (const acc of accounts) {
    const isGcp = acc.channelType === "gcp" || Boolean(acc.gcpProjectId);
    if (isGcp || acc.authExpired || excludeSet.has(acc.id)) continue;

    for (const poolKey of poolsOrder) {
      if (excludeSet.has(`${acc.id}@${poolKey}`)) continue;
      const poolQuota =
        acc.cachedQuotaByPool?.[poolKey] ||
        (poolKey === (acc.cachedQuota?.pool || acc.cachedQuota?.quotaPool || preferredPool) ? acc.cachedQuota : null);
      if (!poolQuota || typeof poolQuota !== "object") continue;

      const models = poolQuota.availableModels || [];
      const matched = models.find((m) => {
        const id = (m.modelId || m.label || "").toLowerCase();
        if (id === targetLower) return true;
        return Array.isArray(m.variantIds) && m.variantIds.some((v) => String(v).toLowerCase() === targetLower);
      });
      if (!matched && targetLower) continue;

      const dual = extractModelDualQuota(poolQuota, matched, baseFamily);
      if (dual.weeklyPct <= 0 || dual.fiveHourPct <= 0) continue;

      const weeklyLow = dual.weeklyPct <= thresholdPct;
      const effectiveWeeklyResetMs = dual.weeklyResetMs + (weeklyLow ? WEEK_PENALTY_MS : 0);
      const fiveHourAboveThreshold = dual.fiveHourPct > thresholdPct;

      candidates.push({
        acc,
        pool: poolKey,
        upstreamHostname: getCloudCodeHostnameForPool(poolKey, false),
        matched,
        weeklyPct: dual.weeklyPct,
        fiveHourPct: dual.fiveHourPct,
        fiveHourAboveThreshold,
        effectiveWeeklyResetMs,
        fiveHourResetMs: dual.fiveHourResetMs,
        isCurrentAcc: acc.id === activeChannelId,
        isPreferredPool: poolKey === preferredPool
      });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    // 0. 5小时限额门控：优先排 fiveHourPct > 5% 的候选池
    if (a.fiveHourAboveThreshold !== b.fiveHourAboveThreshold) {
      return a.fiveHourAboveThreshold ? -1 : 1;
    }
    // 1. 第 1 层排序（先周额度）：按周限额重置时间升序（周限额 <=5% 加 +7天惩罚排后）
    if (Math.abs(a.effectiveWeeklyResetMs - b.effectiveWeeklyResetMs) > 120000) {
      return a.effectiveWeeklyResetMs - b.effectiveWeeklyResetMs;
    }
    // 2. 第 2 层排序（再 5 小时额度）：周重置时间相近时，按 5 小时限额重置时间升序
    if (Math.abs(a.fiveHourResetMs - b.fiveHourResetMs) > 60000) {
      return a.fiveHourResetMs - b.fiveHourResetMs;
    }
    // 3. 重置窗口相同时优先当前选中的配额池 (Prod / Daily) 与当前激活账号
    if (a.isPreferredPool !== b.isPreferredPool) return a.isPreferredPool ? -1 : 1;
    if (a.isCurrentAcc !== b.isCurrentAcc) return a.isCurrentAcc ? -1 : 1;
    if (b.weeklyPct !== a.weeklyPct) return b.weeklyPct - a.weeklyPct;
    if (b.fiveHourPct !== a.fiveHourPct) return b.fiveHourPct - a.fiveHourPct;
    return 0;
  });
  return candidates[0];
}

export function selectBestPersonalChannelForModel(baseFamily, cfg, excludedIds = null) {
  const best = selectBestPersonalRouteCandidate(baseFamily, cfg, excludedIds);
  return best ? best.acc : null;
}

export async function getValidPersonalAccessToken(cfg, targetAcc) {
  const preferredStored = (
    targetAcc?.storedToken &&
    !targetAcc.storedToken.project_id &&
    targetAcc.storedToken.auth_method !== "gcp" &&
    targetAcc.storedToken.auth_method !== "adc"
  )
    ? targetAcc.storedToken
    : null;
  const baseToken = preferredStored || findStoredTokenForEmail(cfg, targetAcc?.email, false) || targetAcc?.storedToken;
  if (!baseToken || !baseToken.token) return "";
  let accessToken = baseToken.token.access_token || "";
  const refreshToken = baseToken.token.refresh_token || "";
  const expiryStr = baseToken.token.expiry || "";
  const expiryMs = expiryStr ? new Date(expiryStr).getTime() : 0;
  const isExpiringSoon = !accessToken || baseToken.token.refreshedForRt !== refreshToken || (expiryMs > 0 && expiryMs - Date.now() < 300000);

  if (isExpiringSoon && refreshToken) {
    try {
      const refreshed = await refreshOAuthAccessToken(refreshToken);
      if (refreshed && refreshed.access_token) {
        accessToken = refreshed.access_token;
        const newExpiry = new Date(Date.now() + (refreshed.expires_in || 3599) * 1000).toISOString();
        baseToken.token.access_token = accessToken;
        baseToken.token.refreshedForRt = refreshToken;
        baseToken.token.expiry = newExpiry;
        if (targetAcc) targetAcc.authExpired = false;
        for (const item of Object.values(cfg.accounts || {})) {
          if (item.storedToken?.token?.refresh_token === refreshToken) {
            item.authExpired = false;
            item.storedToken.token.access_token = accessToken;
            item.storedToken.token.refreshedForRt = refreshToken;
            item.storedToken.token.expiry = newExpiry;
          }
        }
        writeRelayConfig(cfg);
      }
    } catch (err) {
      if (err && err.isAuthExpired) {
        if (targetAcc) targetAcc.authExpired = true;
        writeRelayConfig(cfg);
        return "";
      }
    }
  }
  return accessToken;
}

export async function proxyCloudCodeRequest(req, res, rawBodyBuf) {
  const reqUrl = req.url || "";
  if (reqUrl === "/__agy_proxy_ping" || reqUrl.startsWith("/__agy_proxy_ping?")) {
    const ctx = resolveCurrentInstanceContext();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "antigravity-relay-proxy",
        pid: process.pid,
        instanceId: ctx.instanceId,
        port: globalThis.__agyCloudCodeProxyPort || 8091
      })
    );
    return;
  }
  const cfg = readRelayConfig();
  normalizeAccountChannels(cfg);
  const ctx = resolveCurrentInstanceContext();
  const instMeta = getInstanceMeta(cfg, ctx);
  const isGenerateEndpoint = /^\/v1internal:(streamGenerateContent|generateContent|countTokens)\b/i.test(reqUrl);
  const isFetchModelsEndpoint = /^\/v1internal:fetchAvailableModels\b/i.test(reqUrl);
  const isLoadCodeAssistEndpoint = /^\/v1internal:loadCodeAssist\b/i.test(reqUrl);
  const defaultPool = getActivePersonalQuotaPool(cfg);
  const defaultUpstreamHostname = getCloudCodeHostnameForPool(defaultPool, false);

  const baseHeaders = {};
  for (const [k, v] of Object.entries(req.headers || {})) {
    const lk = k.toLowerCase();
    if (lk === "host" || lk === "connection" || lk === "content-length") continue;
    baseHeaders[k] = v;
  }
  baseHeaders["Host"] = defaultUpstreamHostname;
  const incomingUa = String(baseHeaders["user-agent"] || baseHeaders["User-Agent"] || "");
  if (!incomingUa || !/aidev_client|antigravity\/hub/i.test(incomingUa)) {
    delete baseHeaders["User-Agent"];
    baseHeaders["user-agent"] = getCloudCodeUserAgent();
  }

  const descId = ctx.isIsolatedInstance ? String(ctx.descriptor?.activeChannelId || "").trim() : "";
  const descTs = ctx.isIsolatedInstance ? Math.max(Number(ctx.descriptor?.switchedAt || 0), Number(ctx.descriptor?.launchedAt || 0)) : 0;
  const metaTs = Math.max(Number(instMeta?.switchedAt || 0), Number(instMeta?.seededLaunchAt || 0));
  const activeChannelId = String(
    (descId && descTs >= metaTs ? descId : (instMeta?.activeChannelId || descId || (!ctx.isIsolatedInstance ? cfg.__meta__?.activeChannelId : ""))) || ""
  ).trim();
  const activePersonalAcc = (activeChannelId && cfg.accounts?.[activeChannelId] && cfg.accounts[activeChannelId].channelType !== "gcp" && !cfg.accounts[activeChannelId].gcpProjectId)
    ? cfg.accounts[activeChannelId]
    : null;

  let parsedBodyJson = null;
  let rawModel = "";
  let baseFamily = "";
  let routeSpec = "follow_current";

  if (isGenerateEndpoint && rawBodyBuf && rawBodyBuf.length > 0) {
    try {
      parsedBodyJson = JSON.parse(rawBodyBuf.toString("utf8"));
      rawModel = String(parsedBodyJson.model || cfg.__meta__?.lastRoutedModel || "").trim();
      baseFamily = resolveBaseModelFamilyFromId(rawModel, cfg);
      const routeMap = cfg.routing?.models || {};
      routeSpec = routeMap[baseFamily] || routeMap[rawModel] || "follow_current";
      if (parsedBodyJson.model) {
        parsedBodyJson.model = normalizeConsumerModelId(parsedBodyJson.model, cfg);
      }
    } catch {}
  }

  const excludedIds = new Set();

  const prepareAttemptPayload = async () => {
    const outHeaders = { ...baseHeaders };
    let outBodyBuf = rawBodyBuf || Buffer.alloc(0);
    let routedTargetAcc = null;
    let targetPool = defaultPool;
    let targetHostname = defaultUpstreamHostname;
    let strippedSigCount = 0;

    if (isGenerateEndpoint && parsedBodyJson) {
      const bodyClone = JSON.parse(JSON.stringify(parsedBodyJson));
      if (routeSpec === "auto_poll") {
        const bestCand = selectBestPersonalRouteCandidate(baseFamily, cfg, excludedIds);
        if (bestCand) {
          routedTargetAcc = bestCand.acc;
          targetPool = bestCand.pool;
          targetHostname = getCloudCodeHostnameForPool(targetPool);
        } else if (activePersonalAcc && !excludedIds.has(`${activePersonalAcc.id}@${defaultPool}`)) {
          routedTargetAcc = activePersonalAcc;
          targetPool = defaultPool;
          targetHostname = getCloudCodeHostnameForPool(targetPool);
        }
      } else if (typeof routeSpec === "string" && routeSpec.startsWith("account:")) {
        const rawRef = routeSpec.slice(8).trim();
        const hashIdx = rawRef.indexOf("#");
        const poolAtIdx = hashIdx >= 0 ? rawRef.indexOf("@", hashIdx) : -1;
        const refId = poolAtIdx >= 0 ? rawRef.slice(0, poolAtIdx) : rawRef;
        const explicitPool = poolAtIdx >= 0 ? rawRef.slice(poolAtIdx + 1) : "";
        const candidateAcc = cfg.accounts?.[refId] || (!refId.includes("#") ? cfg.accounts?.[`${refId}#personal`] : null);
        if (candidateAcc && candidateAcc.channelType !== "gcp" && !candidateAcc.gcpProjectId) {
          let chosenPool = explicitPool ? normalizePersonalQuotaPool(explicitPool) : defaultPool;
          const chosenQuota = candidateAcc.cachedQuotaByPool?.[chosenPool] || (chosenPool === defaultPool ? candidateAcc.cachedQuota : null);
          const matchedChosen = (chosenQuota?.availableModels || []).find(
            (m) => (m.modelId || m.label || "").toLowerCase() === baseFamily.toLowerCase()
          );
          const chosenDual = extractModelDualQuota(chosenQuota, matchedChosen, baseFamily);
          if (!explicitPool && (chosenDual.weeklyPct <= 0 || chosenDual.fiveHourPct <= 0 || excludedIds.has(`${candidateAcc.id}@${chosenPool}`))) {
            const altPool = chosenPool === "prod" ? "daily" : "prod";
            const altQuota = candidateAcc.cachedQuotaByPool?.[altPool];
            const matchedAlt = (altQuota?.availableModels || []).find(
              (m) => (m.modelId || m.label || "").toLowerCase() === baseFamily.toLowerCase()
            );
            const altDual = extractModelDualQuota(altQuota, matchedAlt, baseFamily);
            if (altDual.weeklyPct > 0 && altDual.fiveHourPct > 0 && !excludedIds.has(`${candidateAcc.id}@${altPool}`)) {
              chosenPool = altPool;
            }
          }
          if (!excludedIds.has(candidateAcc.id) && !excludedIds.has(`${candidateAcc.id}@${chosenPool}`)) {
            routedTargetAcc = candidateAcc;
            targetPool = chosenPool;
            targetHostname = getCloudCodeHostnameForPool(targetPool);
          }
        }
      } else if (activePersonalAcc) {
        let chosenPool = defaultPool;
        if (excludedIds.has(`${activePersonalAcc.id}@${chosenPool}`)) {
          const altPool = chosenPool === "prod" ? "daily" : "prod";
          if (!excludedIds.has(`${activePersonalAcc.id}@${altPool}`)) {
            chosenPool = altPool;
          }
        }
        routedTargetAcc = activePersonalAcc;
        targetPool = chosenPool;
        targetHostname = getCloudCodeHostnameForPool(targetPool);
      }

      outHeaders["Host"] = targetHostname;

      if (routedTargetAcc) {
        // 个人号之间共享同一套消费级 Tink 签名密钥，仅剥离跨通道遗留的 GCP 签名，避免带 functionCall 的对话报 400
        strippedSigCount = stripThoughtSignaturesFromJson(bodyClone, { onlyGcpSignatures: true });
        const targetToken = await getValidPersonalAccessToken(cfg, routedTargetAcc);
        if (targetToken) {
          outHeaders["authorization"] = `Bearer ${targetToken}`;
          delete outHeaders["Authorization"];
          delete outHeaders["x-goog-user-project"];
          delete outHeaders["X-Goog-User-Project"];
          const targetCompanionPid = await ensurePersonalCompanionProjectId(cfg, routedTargetAcc, targetToken, targetHostname);
          bodyClone.project = targetCompanionPid || (targetPool === "daily" ? "aicode-consumers" : "");
          cfg.__meta__.lastRoutedChannelId = routedTargetAcc.id;
          cfg.__meta__.lastRoutedPool = targetPool;
          cfg.__meta__.lastProxyHit = {
            at: new Date().toISOString(),
            endpoint: reqUrl,
            rawModel,
            mappedModel: bodyClone.model || rawModel,
            baseFamily,
            routeSpec,
            targetChannelId: routedTargetAcc.id,
            targetEmail: routedTargetAcc.email,
            targetPool,
            targetHostname,
            targetCompanionProject: bodyClone.project || "",
            strippedSignatures: strippedSigCount
          };
          writeRelayConfig(cfg);
        }
      }
      outBodyBuf = Buffer.from(JSON.stringify(bodyClone), "utf8");
    } else {
      outHeaders["Host"] = targetHostname;
    }

    outHeaders["Content-Length"] = outBodyBuf.length;
    return { outHeaders, outBodyBuf, routedTargetAcc, targetPool, targetHostname };
  };

  const reqStartAt = Date.now();
  const isStreamOrGenerate = /^\/v1internal:(streamGenerateContent|generateContent)\b/i.test(reqUrl);

  const executeUpstreamAttempt = async (attemptIdx) => {
    const { outHeaders, outBodyBuf, routedTargetAcc, targetPool, targetHostname } = await prepareAttemptPayload();

    return new Promise((resolve) => {
      const upReq = https.request(
        {
          hostname: targetHostname,
          port: 443,
          path: reqUrl,
          method: req.method || "POST",
          family: 4,
          headers: outHeaders,
          timeout: 120000
        },
        (upRes) => {
          if (
            isGenerateEndpoint &&
            upRes.statusCode === 429 &&
            routedTargetAcc?.id &&
            attemptIdx < 5
          ) {
            excludedIds.add(`${routedTargetAcc.id}@${targetPool}`);
            const altPool = targetPool === "prod" ? "daily" : "prod";
            const hasExplicitPoolLock = typeof routeSpec === "string" &&
              routeSpec.startsWith("account:") &&
              routeSpec.indexOf("#") >= 0 &&
              routeSpec.indexOf("@", routeSpec.indexOf("#")) >= 0;
            const hasNextCandidate = routeSpec === "auto_poll"
              ? Boolean(selectBestPersonalRouteCandidate(baseFamily, cfg, excludedIds))
              : (!hasExplicitPoolLock && !excludedIds.has(`${routedTargetAcc.id}@${altPool}`));
            if (hasNextCandidate) {
              upRes.resume();
              setTimeout(() => {
                probeChannelQuotaSnapshot(routedTargetAcc.id).catch(() => {});
              }, 500);
              executeUpstreamAttempt(attemptIdx + 1).then(resolve);
              return;
            }
          }

          if (isLoadCodeAssistEndpoint && upRes.statusCode === 200) {
            const chunks = [];
            upRes.on("data", (c) => chunks.push(c));
            upRes.on("end", () => {
              const respBuf = Buffer.concat(chunks);
              try {
                const enc = String(upRes.headers["content-encoding"] || "").toLowerCase();
                const decodedBuf = enc === "gzip" ? zlib.gunzipSync(respBuf) : respBuf;
                const respJson = JSON.parse(decodedBuf.toString("utf8"));
                const cPid = String(
                  respJson?.cloudaicompanionProject?.id ||
                  respJson?.cloudaicompanionProject ||
                  ""
                ).trim();
                if (cPid && !isDowngradedConsumerPoolProject(cPid) && activePersonalAcc) {
                  activePersonalAcc.companionProjectId = cPid;
                  if (activePersonalAcc.cachedQuota && typeof activePersonalAcc.cachedQuota === "object") {
                    activePersonalAcc.cachedQuota.companionProjectId = cPid;
                  }
                  writeRelayConfig(cfg);
                }
              } catch {}
              const respHeaders = { ...upRes.headers, "content-length": String(respBuf.length) };
              delete respHeaders["transfer-encoding"];
              delete respHeaders["Transfer-Encoding"];
              res.writeHead(upRes.statusCode || 200, respHeaders);
              res.end(respBuf);
              resolve();
            });
            return;
          }

          if (isFetchModelsEndpoint && upRes.statusCode === 200 && !upRes.headers["content-encoding"]) {
            const chunks = [];
            upRes.on("data", (c) => chunks.push(c));
            upRes.on("end", () => {
              let respBuf = Buffer.concat(chunks);
              try {
                const respJson = JSON.parse(respBuf.toString("utf8"));
                if (respJson?.models && typeof respJson.models === "object") {
                  learnModelsFromCloudCodeResponse(cfg, respJson);
                  const routeMap = cfg.routing?.models || {};
                  const curPool = getActivePersonalQuotaPool(cfg);
                  let modified = false;
                  for (const [mKey, mObj] of Object.entries(respJson.models)) {
                    if (!mObj || typeof mObj !== "object" || /disabled$/i.test(mKey)) continue;
                    const mFamily = resolveBaseModelFamilyFromId(mKey, cfg);
                    const rSpec = routeMap[mFamily] || routeMap[mKey] || "follow_current";
                    let tAcc = null;
                    let tPool = curPool;
                    if (rSpec === "auto_poll") {
                      const bestCand = selectBestPersonalRouteCandidate(mFamily, cfg);
                      if (bestCand) {
                        tAcc = bestCand.acc;
                        tPool = bestCand.pool;
                      }
                    } else if (typeof rSpec === "string" && rSpec.startsWith("account:")) {
                      const rawRef = rSpec.slice(8).trim();
                      const hashIdx = rawRef.indexOf("#");
                      const poolAtIdx = hashIdx >= 0 ? rawRef.indexOf("@", hashIdx) : -1;
                      const refId = poolAtIdx >= 0 ? rawRef.slice(0, poolAtIdx) : rawRef;
                      const expPool = poolAtIdx >= 0 ? rawRef.slice(poolAtIdx + 1) : "";
                      tAcc = cfg.accounts?.[refId] || (!refId.includes("#") ? cfg.accounts?.[`${refId}#personal`] : null);
                      if (expPool) tPool = normalizePersonalQuotaPool(expPool);
                    }
                    if (tAcc && tAcc.channelType !== "gcp" && !tAcc.gcpProjectId) {
                      const curFraction = mObj.quotaInfo?.remainingFraction !== undefined
                        ? Number(mObj.quotaInfo.remainingFraction)
                        : (mObj.quotaInfo?.resetTime ? 0 : 1);
                      const snapModels = tAcc.cachedQuotaByPool?.[tPool]?.availableModels || tAcc.cachedQuota?.availableModels || [];
                      const matchedModel = snapModels.find(
                        (item) => (item.modelId || item.label || "").toLowerCase() === mFamily.toLowerCase()
                      );
                      if (curFraction <= 0 && matchedModel && matchedModel.remainingPct > 0) {
                        if (!mObj.quotaInfo) mObj.quotaInfo = {};
                        mObj.quotaInfo.remainingFraction = 0.01;
                        modified = true;
                      }
                    }
                  }
                  if (modified) {
                    respBuf = Buffer.from(JSON.stringify(respJson), "utf8");
                  }
                }
              } catch {}
              const respHeaders = { ...upRes.headers, "content-length": String(respBuf.length) };
              delete respHeaders["transfer-encoding"];
              delete respHeaders["Transfer-Encoding"];
              res.writeHead(upRes.statusCode || 200, respHeaders);
              res.end(respBuf);
              resolve();
            });
            return;
          }

          res.writeHead(upRes.statusCode || 200, {
            ...upRes.headers,
            "x-agy-routed-channel": routedTargetAcc?.id || "",
            "x-agy-routed-pool": targetPool || ""
          });
          let firstChunkAt = 0;
          const streamSampleChunks = [];
          let streamSampleLen = 0;
          upRes.on("data", (chunk) => {
            if (!firstChunkAt) firstChunkAt = Date.now();
            if (isStreamOrGenerate && !upRes.headers["content-encoding"] && streamSampleLen < 524288) {
              streamSampleChunks.push(chunk);
              streamSampleLen += chunk.length;
            }
            try { res.write(chunk); } catch {}
          });
          upRes.on("end", () => {
            if (isStreamOrGenerate && streamSampleChunks.length > 0) {
              try {
                const endAt = Date.now();
                const text = Buffer.concat(streamSampleChunks).toString("utf8");
                const promptMatches = [...text.matchAll(/"promptTokenCount"\s*:\s*(\d+)/g)];
                const candMatches = [...text.matchAll(/"candidatesTokenCount"\s*:\s*(\d+)/g)];
                const thoughtMatches = [...text.matchAll(/"thoughtsTokenCount"\s*:\s*(\d+)/g)];
                const totalMatches = [...text.matchAll(/"totalTokenCount"\s*:\s*(\d+)/g)];
                const inTok = promptMatches.length > 0 ? Number(promptMatches[promptMatches.length - 1][1]) : 0;
                const candTok = candMatches.length > 0 ? Number(candMatches[candMatches.length - 1][1]) : 0;
                const thTok = thoughtMatches.length > 0 ? Number(thoughtMatches[thoughtMatches.length - 1][1]) : 0;
                const totTok = totalMatches.length > 0 ? Number(totalMatches[totalMatches.length - 1][1]) : (inTok + candTok + thTok);
                const outTok = (candTok + thTok) > 0 ? (candTok + thTok) : Math.max(0, Math.round(text.length / 12));
                const elapsedSec = Math.max(0.25, (endAt - (firstChunkAt || reqStartAt)) / 1000);
                const speed = Math.round((outTok / elapsedSec) * 10) / 10;
                if (outTok > 0 && speed > 0) {
                  const freshCfg = readRelayConfig();
                  if (!freshCfg.__meta__) freshCfg.__meta__ = {};
                  const prevTel = freshCfg.__meta__.telemetry || {};
                  const prevSamples = Number(prevTel.proxySampleCount || 0);
                  const prevAvg = Number(prevTel.proxyAvgTokPerSec || speed);
                  const nextAvg = Math.round((((prevAvg * prevSamples) + speed) / (prevSamples + 1)) * 10) / 10;
                  freshCfg.__meta__.telemetry = {
                    ...prevTel,
                    lastTokPerSec: speed,
                    proxyAvgTokPerSec: nextAvg,
                    proxySampleCount: prevSamples + 1,
                    lastInputTokens: inTok,
                    lastOutputTokens: outTok,
                    lastTotalTokens: totTok || (inTok + outTok),
                    updatedAt: Date.now()
                  };
                  writeRelayConfig(freshCfg);
                }
              } catch {}
            }
            try { res.end(); } catch {}
            if (routedTargetAcc?.id && isStreamOrGenerate) {
              setTimeout(() => {
                probeChannelQuotaSnapshot(routedTargetAcc.id).catch(() => {});
              }, 2000);
            }
            resolve();
          });
        }
      );
      upReq.on("error", (err) => {
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        } else {
          try { res.end(); } catch {}
        }
        resolve();
      });
      upReq.on("timeout", () => {
        upReq.destroy();
        if (!res.headersSent) {
          res.writeHead(504, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Upstream CloudCode timeout" }));
        } else {
          try { res.end(); } catch {}
        }
        resolve();
      });
      if (outBodyBuf.length > 0) {
        upReq.write(outBodyBuf);
      }
      upReq.end();
    });
  };

  await executeUpstreamAttempt(0);
}

const CLOUDCODE_PROXY_CANDIDATE_PORTS = [8091, 8092, 8093, 8094, 8095, 8096, 8097, 8098, 8099, 0];
globalThis.__agyCloudCodeProxyHandler = proxyCloudCodeRequest;

export function getActiveCloudCodeProxyUrl(cfg = null) {
  if (
    globalThis.__agyCloudCodeProxyUrl &&
    /^http:\/\/127\.0\.0\.1:809\d$/i.test(globalThis.__agyCloudCodeProxyUrl)
  ) {
    return globalThis.__agyCloudCodeProxyUrl;
  }
  const ctx = resolveCurrentInstanceContext();
  const instSaved = cfg ? String(getInstanceMeta(cfg, ctx)?.cloudCodeProxyUrl || "").trim() : "";
  if (/^http:\/\/127\.0\.0\.1:809\d$/i.test(instSaved)) {
    return instSaved;
  }
  const saved = !ctx.isIsolatedInstance ? String(cfg?.__meta__?.cloudCodeProxyUrl || "").trim() : "";
  if (/^http:\/\/127\.0\.0\.1:809\d$/i.test(saved)) {
    return saved;
  }
  return ctx.isIsolatedInstance ? "http://127.0.0.1:8092" : "http://127.0.0.1:8091";
}

function checkExistingRelayProxyOnPort(port) {
  return new Promise((resolve) => {
    if (!port || port <= 0) return resolve(false);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/__agy_proxy_ping",
        method: "GET",
        timeout: 350
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode !== 200) return resolve(false);
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            resolve(Boolean(data && data.service === "antigravity-relay-proxy" && data.pid === process.pid));
          } catch {
            resolve(false);
          }
        });
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function persistAndSyncProxyUrl(proxyUrl) {
  if (!proxyUrl) return;
  const effectiveUrl = proxyUrl;
  globalThis.__agyCloudCodeProxyUrl = effectiveUrl;
  try {
    const cfg = readRelayConfig();
    const ctx = resolveCurrentInstanceContext();
    const instMeta = getInstanceMeta(cfg, ctx);
    const isLiveGcp = Boolean(instMeta.lastAppliedGcpProject || (!ctx.isIsolatedInstance && cfg.__meta__?.lastAppliedGcpProject));
    const hasPersonalRouting = hasActivePersonalRoutingConfig(cfg);
    const isLocalProxy = !isLiveGcp && hasPersonalRouting;
    const directUpstreamUrl = isLiveGcp
      ? "https://cloudcode-pa.googleapis.com"
      : "https://daily-cloudcode-pa.googleapis.com";
    const desiredUrl = isLocalProxy ? effectiveUrl : directUpstreamUrl;
    const desiredMode = isLocalProxy ? "local_proxy" : "direct";
    const prevMode = instMeta.cloudCodeProxyMode;
    let changed = false;
    if (instMeta.cloudCodeProxyUrl !== desiredUrl || instMeta.cloudCodeProxyMode !== desiredMode) {
      instMeta.cloudCodeProxyUrl = desiredUrl;
      instMeta.cloudCodeProxyMode = desiredMode;
      changed = true;
    }
    if (!ctx.isIsolatedInstance && (cfg.__meta__.cloudCodeProxyUrl !== desiredUrl || cfg.__meta__.cloudCodeProxyMode !== desiredMode)) {
      cfg.__meta__.cloudCodeProxyUrl = desiredUrl;
      cfg.__meta__.cloudCodeProxyMode = desiredMode;
      changed = true;
    }
    if (changed) {
      writeRelayConfig(cfg);
    }
    const ls = discoverLanguageServer(false);
    if (ls && (isLocalProxy || (prevMode === "local_proxy" && instMeta.cloudCodeProxyPid === ls.pid))) {
      callLsRpc(ls, "SetCloudCodeURL", { url: desiredUrl }).catch(() => {});
    }
  } catch {}
}

export function ensureCloudCodeProxyServer() {
  if (globalThis.__agyCloudCodeProxyServer) {
    if (globalThis.__agyCloudCodeProxyPort && !globalThis.__agyCloudCodeProxyUrl) {
      persistAndSyncProxyUrl(`http://127.0.0.1:${globalThis.__agyCloudCodeProxyPort}`);
    }
    return globalThis.__agyCloudCodeProxyServer;
  }

  const createProxyHttpServer = () =>
    http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        const rawBuf = Buffer.concat(chunks);
        const handler = globalThis.__agyCloudCodeProxyHandler || proxyCloudCodeRequest;
        try {
          await handler(req, res, rawBuf);
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
        }
      });
    });

  const tryBindCandidateIndex = (idx) => {
    if (idx >= CLOUDCODE_PROXY_CANDIDATE_PORTS.length) return;
    const candidatePort = CLOUDCODE_PROXY_CANDIDATE_PORTS[idx];
    const srv = createProxyHttpServer();

    srv.once("error", async (err) => {
      try { srv.close(); } catch {}
      if (err && err.code === "EADDRINUSE" && candidatePort > 0) {
        const isOurProxy = await checkExistingRelayProxyOnPort(candidatePort);
        if (isOurProxy) {
          globalThis.__agyCloudCodeProxyPort = candidatePort;
          persistAndSyncProxyUrl(`http://127.0.0.1:${candidatePort}`);
          return;
        }
      }
      tryBindCandidateIndex(idx + 1);
    });

    srv.once("listening", () => {
      const actualPort = srv.address()?.port || candidatePort || 8091;
      srv.unref();
      globalThis.__agyCloudCodeProxyServer = srv;
      globalThis.__agyCloudCodeProxyPort = actualPort;
      persistAndSyncProxyUrl(`http://127.0.0.1:${actualPort}`);
    });

    srv.listen(candidatePort, "127.0.0.1");
  };

  tryBindCandidateIndex(0);
  return globalThis.__agyCloudCodeProxyServer || null;
}

function tryLaunchCloudCodeProxyOnStartup() {
  const isSidecarDaemon =
    Boolean(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) ||
    Boolean(process.env.PORT) ||
    process.argv.some((a) => /main\.mjs$/i.test(String(a)));
  if (isSidecarDaemon) {
    ensureCloudCodeProxyServer();
  }
}

tryLaunchCloudCodeProxyOnStartup();

export async function routeChannelEphemeral(accountId) {
  const cfg = readRelayConfig();
  normalizeAccountChannels(cfg);
  const target = cfg.accounts?.[accountId];
  if (!target || target.channelType === "gcp" || target.gcpProjectId) {
    return { routed: false, error: `Personal channel not found: ${accountId}` };
  }

  const isLiveGcp = Boolean(cfg.__meta__?.lastAppliedGcpProject);
  if (!isLiveGcp) {
    const ls = discoverLanguageServer(false) || discoverLanguageServer(true);
    const proxyUrl = getActiveCloudCodeProxyUrl(cfg);
    if (ls) {
      await callLsRpc(ls, "SetCloudCodeURL", { url: proxyUrl }).catch(() => {});
      cfg.__meta__.cloudCodeProxyPid = ls.pid;
      cfg.__meta__.cloudCodeProxyMode = "local_proxy";
      cfg.__meta__.cloudCodeProxyUrl = proxyUrl;
    }
  }

  cfg.__meta__.lastRoutedChannelId = target.id;
  writeRelayConfig(cfg);

  return {
    routed: true,
    channelId: target.id,
    email: target.email,
    gcpProjectId: ""
  };
}
