import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import {
  readRelayConfig,
  writeRelayConfig,
  resolveCurrentInstanceContext,
  getInstanceMeta
} from "../store.mjs";
import {
  readWinCredToken,
  buildCleanChannelToken,
  parseLsLogInfo,
  getDetectedClientVersion,
  getCloudCodeUserAgent,
  buildLoadCodeAssistMetadata,
  discoverLanguageServer,
  callLsRpc,
  refreshOAuthAccessToken
} from "./wincred-ls.mjs";
import {
  AGENT_PLATFORM_DEFAULT_MODELS,
  isLegacyDeprecatedModel,
  isGcpOnlyModel,
  isModelEntryRestrictedOrSunset,
  detectPersonalAccountTier,
  buildProModelsFromQuotaGroups,
  isValidOfficialQuotaGroup,
  sanitizeCachedQuotaModels,
  normalizeAccountChannels,
  findStoredTokenForEmail,
  findFirstGcpProjectForEmail,
  isInternalConsumerPoolProject,
  isDowngradedConsumerPoolProject,
  normalizePersonalQuotaPool
} from "./channel-catalog.mjs";

export {
  AGENT_PLATFORM_DEFAULT_MODELS,
  isLegacyDeprecatedModel,
  isGcpOnlyModel,
  isModelEntryRestrictedOrSunset,
  detectPersonalAccountTier,
  buildProModelsFromQuotaGroups,
  isValidOfficialQuotaGroup,
  sanitizeCachedQuotaModels,
  normalizeAccountChannels,
  findStoredTokenForEmail,
  findFirstGcpProjectForEmail,
  isInternalConsumerPoolProject,
  isDowngradedConsumerPoolProject,
  normalizePersonalQuotaPool,
  getDetectedClientVersion,
  getCloudCodeUserAgent,
  buildLoadCodeAssistMetadata
};

export function getActivePersonalQuotaPool(cfg = null) {
  const c = cfg || readRelayConfig();
  return normalizePersonalQuotaPool(c?.routing?.personalQuotaPool);
}

export function getCloudCodeHostnameForPool(pool = "prod", isGcp = false) {
  if (isGcp) return "cloudcode-pa.googleapis.com";
  return normalizePersonalQuotaPool(pool) === "daily"
    ? "daily-cloudcode-pa.googleapis.com"
    : "cloudcode-pa.googleapis.com";
}

function fetchCloudResourceProjects(accessToken, quotaProjectId = "") {
  return new Promise((resolve) => {
    if (!accessToken) return resolve({ projects: [], status: 0, reason: "" });
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json"
    };
    if (quotaProjectId) {
      headers["X-Goog-User-Project"] = quotaProjectId;
    }
    const req = https.request(
      {
        hostname: "cloudresourcemanager.googleapis.com",
        port: 443,
        path: "/v1/projects?pageSize=100",
        method: "GET",
        headers,
        timeout: 4500
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const rawText = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) {
            let reason = "";
            if (res.statusCode === 403) {
              reason = /ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(rawText) ? "scope_insufficient" : "api_disabled";
            }
            return resolve({ projects: [], status: res.statusCode || 0, reason });
          }
          try {
            const parsed = JSON.parse(rawText);
            const list = (parsed.projects || [])
              .filter((p) => p && p.projectId && (!p.lifecycleState || p.lifecycleState === "ACTIVE") && !isInternalConsumerPoolProject(p.projectId))
              .map((p) => ({
                projectId: String(p.projectId).trim(),
                name: String(p.name || p.projectId).trim()
              }));
            resolve({ projects: list, status: 200, reason: "" });
          } catch {
            resolve({ projects: [], status: 200, reason: "" });
          }
        });
      }
    );
    req.on("error", () => resolve({ projects: [], status: -1, reason: "" }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ projects: [], status: -2, reason: "" });
    });
    req.end();
  });
}

function fetchCloudResourceV3Projects(accessToken) {
  return new Promise((resolve) => {
    if (!accessToken) return resolve([]);
    const req = https.request(
      {
        hostname: "cloudresourcemanager.googleapis.com",
        port: 443,
        path: "/v3/projects:search?pageSize=100",
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json"
        },
        timeout: 4500
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode !== 200) return resolve([]);
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const list = (parsed.projects || [])
              .filter((p) => p && p.projectId && (!p.state || p.state === "ACTIVE") && !isInternalConsumerPoolProject(p.projectId))
              .map((p) => ({
                projectId: String(p.projectId).trim(),
                name: String(p.displayName || p.projectId).trim()
              }));
            resolve(list);
          } catch {
            resolve([]);
          }
        });
      }
    );
    req.on("error", () => resolve([]));
    req.on("timeout", () => {
      req.destroy();
      resolve([]);
    });
    req.end();
  });
}

function readLocalGcloudProjectsForEmail(email) {
  const found = [];
  if (!email) return found;
  const candidates = [
    path.join(process.env.APPDATA || "", "gcloud", "configurations"),
    path.join(process.env.USERPROFILE || "", ".config", "gcloud", "configurations")
  ];
  for (const dir of candidates) {
    try {
      if (!dir || !fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        const fp = path.join(dir, f);
        if (!fs.statSync(fp).isFile()) continue;
        const txt = fs.readFileSync(fp, "utf8");
        const accMatch = /^\s*account\s*=\s*([^\r\n]+)/im.exec(txt);
        const projMatch = /^\s*project\s*=\s*([^\r\n]+)/im.exec(txt);
        const cfgEmail = (accMatch?.[1] || "").trim().toLowerCase();
        const cfgProj = (projMatch?.[1] || "").trim();
        if (cfgEmail === email.toLowerCase() && cfgProj && !isInternalConsumerPoolProject(cfgProj)) {
          found.push({ projectId: cfgProj, name: cfgProj });
        }
      }
    } catch {}
  }
  return found;
}

export function callCloudCodeApi(endpointPath, accessToken, payloadObj = {}, extraHeaders = {}, targetHostname = "") {
  return new Promise((resolve) => {
    if (!accessToken) return resolve({ status: 0, data: null });
    const hostname = String(targetHostname || "").trim() || "cloudcode-pa.googleapis.com";
    const body = Buffer.from(JSON.stringify(payloadObj || {}), "utf8");
    const req = https.request(
      {
        hostname,
        port: 443,
        path: endpointPath,
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": getCloudCodeUserAgent(),
          "Content-Length": body.length,
          ...extraHeaders
        },
        timeout: 6000
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode || 0, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode || 0, data: null, raw: raw.slice(0, 300) });
          }
        });
      }
    );
    req.on("error", (err) => resolve({ status: -1, data: null, error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: -2, data: null, error: "timeout" });
    });
    req.write(body);
    req.end();
  });
}

function fetchCloudCodeCompanionProject(accessToken) {
  return callCloudCodeApi("/v1internal:loadCodeAssist", accessToken, {
    metadata: buildLoadCodeAssistMetadata()
  }).then((res) => {
    if (res.status !== 200 || !res.data) return [];
    const pid = String(
      res.data.cloudaicompanionProject?.id ||
      res.data.cloudaicompanionProject ||
      ""
    ).trim();
    if (!pid || isInternalConsumerPoolProject(pid)) return [];
    return [{ projectId: pid, name: pid }];
  });
}

export async function discoverGcpProjectsForAccount(targetEmail = "") {
  const cfg = readRelayConfig();
  normalizeAccountChannels(cfg);
  const cred = readWinCredToken(false);
  const email = (targetEmail || cred?.id_token_email || cfg.__meta__?.activeEmail || "").trim();
  if (!email) return { email: "", discovered: [], reason: "" };

  const storedToken = findStoredTokenForEmail(cfg, email, true) || findStoredTokenForEmail(cfg, email) || cred;
  if (!storedToken || !storedToken.token) return { email, discovered: [], reason: "" };

  let accessToken = storedToken.token.access_token || "";
  const refreshToken = storedToken.token.refresh_token || "";

  if (refreshToken) {
    try {
      const refreshed = await refreshOAuthAccessToken(refreshToken);
      if (refreshed && refreshed.access_token) {
        accessToken = refreshed.access_token;
        storedToken.token.access_token = accessToken;
        writeRelayConfig(cfg);
      }
    } catch {}
  }

  const mergeDiscovered = (...lists) => {
    const map = new Map();
    for (const list of lists) {
      for (const item of (list || [])) {
        if (item && item.projectId && !isInternalConsumerPoolProject(item.projectId) && !map.has(item.projectId)) {
          map.set(item.projectId, item);
        }
      }
    }
    return Array.from(map.values());
  };

  let [crmV1Res, crmV3List, ccProjects] = await Promise.all([
    fetchCloudResourceProjects(accessToken),
    fetchCloudResourceV3Projects(accessToken),
    fetchCloudCodeCompanionProject(accessToken)
  ]);

  if (crmV1Res.projects.length === 0 && crmV1Res.reason === "api_disabled") {
    const quotaProjCandidates = [
      findFirstGcpProjectForEmail(cfg, email),
      ...(Array.isArray(cfg.gcpProjects) ? cfg.gcpProjects : [])
    ].filter((pid) => pid && !isInternalConsumerPoolProject(pid));
    if (quotaProjCandidates.length > 0) {
      const retryRes = await fetchCloudResourceProjects(accessToken, quotaProjCandidates[0]);
      if (retryRes.projects.length > 0) {
        crmV1Res = retryRes;
      }
    }
  }
  const gcloudProjects = readLocalGcloudProjectsForEmail(email);
  const projects = mergeDiscovered(crmV1Res.projects, crmV3List, ccProjects, gcloudProjects);

  for (const existingAcc of Object.values(cfg.accounts || {})) {
    if (existingAcc.email === email && existingAcc.gcpProjectId && !isInternalConsumerPoolProject(existingAcc.gcpProjectId)) {
      if (!projects.some((p) => p.projectId === existingAcc.gcpProjectId)) {
        projects.push({
          projectId: existingAcc.gcpProjectId,
          name: existingAcc.projectName || existingAcc.gcpProjectId
        });
      }
    }
  }

  return {
    email,
    discovered: projects,
    reason: projects.length === 0 ? (crmV1Res.reason || "") : ""
  };
}

export function parseCloudCodeModelsAndQuota(
  rawModelsResp,
  rawQuotaSummaryResp = null,
  isGcpChannel = false,
  userTier = "",
  prevCachedQuota = null,
  liveTierTemplate = []
) {
  const modelsObj = rawModelsResp?.models;
  if (!modelsObj || typeof modelsObj !== "object") {
    return null;
  }

  const allowedModelIds = new Set();
  const sorts = Array.isArray(rawModelsResp?.agentModelSorts) ? rawModelsResp.agentModelSorts : [];
  for (const s of sorts) {
    for (const grp of (s?.groups || [])) {
      for (const mid of (grp?.modelIds || [])) {
        if (mid) allowedModelIds.add(String(mid));
      }
    }
  }

  const orderedEntries = [];
  if (allowedModelIds.size > 0) {
    for (const mid of allowedModelIds) {
      if (modelsObj[mid]) {
        orderedEntries.push([mid, modelsObj[mid]]);
      }
    }
  } else {
    for (const [mid, m] of Object.entries(modelsObj)) {
      const lbl = String(m?.displayName || m?.label || "").trim();
      if (/gemini\s*4\s*argon|gemini\s*3\.8\s*flash|claude\s*opus|claude\s*sonnet|gpt-oss/i.test(lbl)) {
        orderedEntries.push([mid, m]);
      }
    }
  }

  const tierInfo = isGcpChannel
    ? { tierCode: "GCP", tierName: "Agent Platform", hasArgonAccess: true, isPaidProOrUltra: false }
    : detectPersonalAccountTier(
        modelsObj,
        userTier,
        userTier,
        prevCachedQuota?.hasArgonAccess,
        prevCachedQuota?.tierCode || ""
      );
  const hasArgonAccess = tierInfo.hasArgonAccess;
  const isPaidProOrUltra = tierInfo.isPaidProOrUltra;
  const groupedModelMap = new Map();

  for (const [modelId, m] of orderedEntries) {
    if (!m || typeof m !== "object") continue;
    if (/disabled$/i.test(modelId)) continue;
    if (!isGcpChannel && (isModelEntryRestrictedOrSunset(m) || !m.quotaInfo)) continue;
    const rawLabel = String(m.displayName || m.label || "").trim();
    if (!rawLabel) continue;
    const baseLabel = rawLabel.replace(/\s*\((Low|Medium|High|Max)\)\s*$/i, "").trim();
    if (!isGcpChannel) {
      if (isLegacyDeprecatedModel(baseLabel) || isLegacyDeprecatedModel(rawLabel) || isLegacyDeprecatedModel(modelId)) {
        continue;
      }
      if (!hasArgonAccess && /argon/i.test(baseLabel)) {
        continue;
      }
    }
    const remainingPct = isGcpChannel
      ? 100
      : (m.quotaInfo?.remainingFraction !== undefined
          ? Math.round(Number(m.quotaInfo.remainingFraction) * 100)
          : (m.quotaInfo?.resetTime ? 0 : 100));
    const resetTime = isGcpChannel ? "" : (m.quotaInfo?.resetTime || "");

    if (!groupedModelMap.has(baseLabel)) {
      groupedModelMap.set(baseLabel, {
        label: baseLabel,
        modelId: baseLabel,
        variantIds: [baseLabel, rawLabel, modelId],
        remainingPct,
        resetTime,
        unlimited: isGcpChannel
      });
    } else {
      const entry = groupedModelMap.get(baseLabel);
      if (!entry.variantIds.includes(rawLabel)) entry.variantIds.push(rawLabel);
      if (!entry.variantIds.includes(modelId)) entry.variantIds.push(modelId);
    }
  }

  const quotaGroups = [];
  if (!isGcpChannel) {
    const rawGroups = rawQuotaSummaryResp?.groups || rawQuotaSummaryResp?.response?.groups || [];
    if (Array.isArray(rawGroups) && rawGroups.length > 0) {
      for (const g of rawGroups) {
        const gId = g.groupId || g.displayName || "";
        if (!hasArgonAccess && /argon/i.test(gId)) continue;
        const candidateGroup = {
          id: gId,
          displayName: g.displayName || "",
          description: g.description || "",
          buckets: (g.buckets || []).map((b) => ({
            bucketId: b.bucketId || "",
            window: b.window || "",
            remainingPct: b.remainingFraction !== undefined
              ? Math.round(Number(b.remainingFraction) * 100)
              : (b.resetTime ? 0 : 100),
            resetTime: b.resetTime || ""
          }))
        };
        if (isValidOfficialQuotaGroup(candidateGroup)) {
          quotaGroups.push(candidateGroup);
        }
      }
    }
  }

  if (!isGcpChannel && quotaGroups.length > 0 && tierInfo.tierCode !== "Free") {
    const dynamicApiModels = Array.from(groupedModelMap.values()).filter(
      (m) => !isLegacyDeprecatedModel(m.label) && !isLegacyDeprecatedModel(m.modelId)
    );
    const proModels = buildProModelsFromQuotaGroups(
      quotaGroups,
      prevCachedQuota?.availableModels || [],
      dynamicApiModels,
      liveTierTemplate,
      hasArgonAccess
    );
    return {
      tierCode: tierInfo.tierCode,
      tierName: tierInfo.tierName,
      hasArgonAccess,
      isPaidProOrUltra,
      isGcpUnlimited: false,
      quotaGroups,
      availableModels: proModels,
      probedVia: "cloudcode_http",
      updatedAt: Date.now()
    };
  }

  const availableModels = Array.from(groupedModelMap.values()).filter(
    (m) => !isLegacyDeprecatedModel(m.label) && !isLegacyDeprecatedModel(m.modelId)
  );

  return {
    tierCode: tierInfo.tierCode,
    tierName: tierInfo.tierName,
    hasArgonAccess,
    isPaidProOrUltra,
    isGcpUnlimited: isGcpChannel,
    quotaGroups,
    availableModels,
    probedVia: "cloudcode_http",
    updatedAt: Date.now()
  };
}

export async function probeChannelQuotaSnapshot(channelId) {
  const cfg = readRelayConfig();
  normalizeAccountChannels(cfg);
  const acc = cfg.accounts?.[channelId];
  if (!acc) return null;

  const isGcp = acc.channelType === "gcp" || Boolean(acc.gcpProjectId);
  const gcpPid = (acc.gcpProjectId || "").trim();
  const gcpBillingMode = isGcp ? (acc.gcpBillingMode || "agent_platform") : "";

  const ls = discoverLanguageServer(false);
  const ctx = resolveCurrentInstanceContext();
  const instMeta = getInstanceMeta(cfg, ctx);
  const activeEmail = (instMeta?.activeEmail || cfg.__meta__?.activeEmail || "").trim();
  const originalGcpPid = String(
    instMeta?.lastAppliedGcpProject ??
    (!ctx.isIsolatedInstance ? cfg.__meta__?.lastAppliedGcpProject : "") ??
    ""
  ).trim();

  // 仅当探测当前在线 GCP 通道时优先复用本地 language_server_rpc；
  // 个人通道一律使用该账号自身的独立 OAuth Token 直连 daily-cloudcode-pa.googleapis.com，彻底隔绝本地代理或切号瞬态缓存
  if (isGcp && ls && acc.email && acc.email === activeEmail && gcpPid === originalGcpPid) {
    try {
      const usResp = await callLsRpc(ls, "GetUserStatus", {}).catch(() => null);
      const clientModels = usResp?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
      const usEmail = (usResp?.userStatus?.email || "").trim();
      const usTierName = usResp?.userStatus?.userTier?.name || usResp?.userStatus?.planStatus?.planInfo?.planName || "";
      const logInfo = parseLsLogInfo(ctx.lsLogFile);
      const logPid = String(logInfo.lastProjectId || "").trim();
      const lsHasGcpModels = clientModels.some(
        (m) => !isModelEntryRestrictedOrSunset(m) && isGcpOnlyModel(m.label || m.modelOrAlias?.model || "")
      );
      const lsModeMatches = Boolean(
        usEmail === acc.email &&
        (logPid ? logPid === gcpPid : Boolean(/agent\s*platform|enterprise/i.test(usTierName) || lsHasGcpModels))
      );
      if (lsModeMatches && clientModels.length > 0) {
        const groupedMap = new Map();
        for (const m of clientModels) {
          const rawLabel = (m.label || "").trim();
          const modelId = m.modelOrAlias?.model || m.modelOrAlias?.alias || "";
          if (!rawLabel || !modelId) continue;
          const baseLabel = rawLabel.replace(/\s*\((Low|Medium|High|Max)\)\s*$/i, "").trim();
          if (!groupedMap.has(baseLabel)) {
            groupedMap.set(baseLabel, {
              label: baseLabel,
              modelId: baseLabel,
              variantIds: [baseLabel, rawLabel, modelId],
              remainingPct: 100,
              resetTime: "",
              unlimited: true
            });
          } else {
            const entry = groupedMap.get(baseLabel);
            if (!entry.variantIds.includes(rawLabel)) entry.variantIds.push(rawLabel);
            if (!entry.variantIds.includes(modelId)) entry.variantIds.push(modelId);
          }
        }
        const liveModels = Array.from(groupedMap.values());
        if (liveModels.length > 0) {
          if (!cfg.__meta__.liveTierModels || typeof cfg.__meta__.liveTierModels !== "object") {
            cfg.__meta__.liveTierModels = {};
          }
          cfg.__meta__.liveTierModels.gcp = liveModels.map((m) => ({
            label: m.label,
            modelId: m.modelId,
            variantIds: [...(m.variantIds || [m.label])]
          }));
          acc.cachedQuota = {
            tierCode: "GCP",
            tierName: acc.tierName || "Agent Platform",
            hasArgonAccess: true,
            isPaidProOrUltra: false,
            isGcpUnlimited: true,
            quotaGroups: [],
            availableModels: liveModels,
            probedVia: "language_server_rpc",
            updatedAt: Date.now()
          };
          writeRelayConfig(cfg);
          return acc.cachedQuota;
        }
      }
    } catch {}
  }

  const liveTierTemplate = cfg.__meta__?.liveTierModels?.[isGcp ? "gcp" : "personal"] || [];

  const candidateTokenObjs = [];
  const seenRtSet = new Set();
  const pushCandidateToken = (tokObj) => {
    if (!tokObj || !tokObj.token) return;
    const key = String(tokObj.token.refresh_token || tokObj.token.access_token || "").trim();
    if (!key || seenRtSet.has(key)) return;
    seenRtSet.add(key);
    candidateTokenObjs.push(tokObj);
  };

  if (!isGcp) {
    pushCandidateToken(cfg?.__meta__?.channelTokensById?.[acc.id]);
    pushCandidateToken(acc.storedToken);
    pushCandidateToken(cfg?.__meta__?.oauthTokensByEmail?.[acc.email]);
    for (const item of Object.values(cfg.accounts || {})) {
      if (item.email === acc.email && !item.gcpProjectId && item.channelType !== "gcp") {
        pushCandidateToken(item.storedToken);
      }
    }
    const winCred = readWinCredToken(false);
    if (winCred && winCred.id_token_email === acc.email && !winCred.project_id) {
      pushCandidateToken(winCred);
    }
    for (const item of Object.values(cfg.accounts || {})) {
      if (item.email === acc.email) pushCandidateToken(item.storedToken);
    }
  } else {
    pushCandidateToken(cfg?.__meta__?.channelTokensById?.[acc.id]);
    pushCandidateToken(acc.storedToken);
    pushCandidateToken(cfg?.__meta__?.gcpOAuthTokensByEmail?.[acc.email]);
    for (const item of Object.values(cfg.accounts || {})) {
      if (item.email === acc.email && (item.gcpProjectId || item.channelType === "gcp")) {
        pushCandidateToken(item.storedToken);
      }
    }
    pushCandidateToken(cfg?.__meta__?.oauthTokensByEmail?.[acc.email]);
  }

  if (candidateTokenObjs.length === 0) {
    if (isGcp && gcpBillingMode === "agent_platform") {
      const baseGcpModels = liveTierTemplate.length >= 6 ? liveTierTemplate : AGENT_PLATFORM_DEFAULT_MODELS;
      acc.cachedQuota = {
        tierCode: "GCP",
        tierName: acc.tierName || "Agent Platform",
        isGcpUnlimited: true,
        quotaGroups: [],
        availableModels: baseGcpModels.map((m) => ({
          label: m.label,
          modelId: m.modelId || m.label,
          variantIds: [...(m.variantIds || [m.label])],
          remainingPct: 100,
          resetTime: "",
          unlimited: true
        })),
        probedVia: "agent_platform_catalog",
        updatedAt: Date.now()
      };
      writeRelayConfig(cfg);
    }
    return acc.cachedQuota || null;
  }

  const activePool = getActivePersonalQuotaPool(cfg);
  const PROD_HOSTNAME = "cloudcode-pa.googleapis.com";
  const DAILY_HOSTNAME = "daily-cloudcode-pa.googleapis.com";

  const tryProbeSinglePersonalPool = async (tok, companionPid, hostName) => {
    const reqPayload = companionPid ? { project: companionPid } : {};
    let [modelsResp, quotaSummaryResp] = await Promise.all([
      callCloudCodeApi("/v1internal:fetchAvailableModels", tok, reqPayload, {}, hostName),
      callCloudCodeApi("/v1internal:retrieveUserQuotaSummary", tok, reqPayload, {}, hostName)
    ]);
    if (!quotaSummaryResp?.data?.groups?.length && companionPid) {
      const fallbackQs = await callCloudCodeApi("/v1internal:retrieveUserQuotaSummary", tok, {}, {}, hostName);
      if (fallbackQs?.data?.groups?.length) {
        quotaSummaryResp = fallbackQs;
      }
    }
    return { modelsResp, quotaSummaryResp };
  };

  const tryProbeWithToken = async (tok) => {
    let companionPid = isGcp
      ? gcpPid
      : (!isDowngradedConsumerPoolProject(acc.companionProjectId) ? String(acc.companionProjectId || "").trim() : "");
    const loadPayload = {
      metadata: buildLoadCodeAssistMetadata(isGcp ? gcpPid : "")
    };
    if (isGcp && gcpPid) {
      loadPayload.cloudaicompanionProject = gcpPid;
    }
    const loadResp = await callCloudCodeApi(
      "/v1internal:loadCodeAssist",
      tok,
      loadPayload,
      {},
      PROD_HOSTNAME
    );
    let userTier = "";
    if (loadResp.status === 200 && loadResp.data) {
      if (!isGcp) {
        const loadedPid = String(
          loadResp.data.cloudaicompanionProject?.id ||
          loadResp.data.cloudaicompanionProject ||
          ""
        ).trim();
        if (loadedPid && !isDowngradedConsumerPoolProject(loadedPid)) {
          companionPid = loadedPid;
        }
      }
      const pTier = loadResp.data.paidTier || loadResp.data.currentTier || {};
      userTier = String(
        isGcp
          ? (loadResp.data.currentTier?.id || "standard-tier")
          : `${pTier.id || ""} ${pTier.name || ""}`
      ).trim();
    }

    if (isGcp) {
      const reqPayload = companionPid ? { project: companionPid } : {};
      const modelsResp = await callCloudCodeApi(
        "/v1internal:fetchAvailableModels",
        tok,
        reqPayload,
        {},
        PROD_HOSTNAME
      );
      return {
        loadResp,
        modelsResp,
        quotaSummaryResp: { status: 0, data: null },
        companionPid,
        userTier,
        byPool: null
      };
    }

    const [prodProbe, dailyProbe] = await Promise.all([
      tryProbeSinglePersonalPool(tok, companionPid, PROD_HOSTNAME),
      tryProbeSinglePersonalPool(tok, companionPid, DAILY_HOSTNAME)
    ]);

    const preferredProbe = activePool === "daily" ? dailyProbe : prodProbe;
    return {
      loadResp,
      modelsResp: preferredProbe.modelsResp?.status === 200 ? preferredProbe.modelsResp : (prodProbe.modelsResp?.status === 200 ? prodProbe.modelsResp : dailyProbe.modelsResp),
      quotaSummaryResp: preferredProbe.quotaSummaryResp,
      companionPid,
      userTier,
      byPool: {
        prod: prodProbe,
        daily: dailyProbe
      }
    };
  };

  let sawAuthExpired = false;
  let sawValidToken = false;

  for (const baseToken of candidateTokenObjs) {
    let accessToken = baseToken.token.access_token || "";
    const refreshToken = baseToken.token.refresh_token || "";
    const expiryMs = baseToken.token.expiry ? new Date(baseToken.token.expiry).getTime() : 0;
    const needsImmediateRefresh = Boolean(
      refreshToken &&
      (!accessToken || baseToken.token.refreshedForRt !== refreshToken || (expiryMs > 0 && expiryMs - Date.now() < 300000))
    );
    if (needsImmediateRefresh) {
      try {
        const refreshed = await refreshOAuthAccessToken(refreshToken);
        if (refreshed && refreshed.access_token) {
          sawValidToken = true;
          accessToken = refreshed.access_token;
          baseToken.token.access_token = accessToken;
          baseToken.token.refreshedForRt = refreshToken;
          baseToken.token.expiry = new Date(Date.now() + (refreshed.expires_in || 3599) * 1000).toISOString();
          for (const item of Object.values(cfg.accounts || {})) {
            if (item.storedToken?.token?.refresh_token === refreshToken) {
              item.storedToken.token.access_token = accessToken;
              item.storedToken.token.refreshedForRt = refreshToken;
              item.storedToken.token.expiry = baseToken.token.expiry;
            }
          }
        }
      } catch (err) {
        if (err && err.isAuthExpired) sawAuthExpired = true;
      }
    }

    if (isGcp && gcpBillingMode === "agent_platform") {
      if (!accessToken && refreshToken) {
        try {
          const refreshed = await refreshOAuthAccessToken(refreshToken);
          if (refreshed && refreshed.access_token) {
            sawValidToken = true;
            accessToken = refreshed.access_token;
            baseToken.token.access_token = accessToken;
            baseToken.token.refreshedForRt = refreshToken;
            baseToken.token.expiry = new Date(Date.now() + (refreshed.expires_in || 3599) * 1000).toISOString();
          }
        } catch (err) {
          if (err && err.isAuthExpired) sawAuthExpired = true;
        }
      }
      if (accessToken) {
        sawValidToken = true;
        const cleanGcpTok = buildCleanChannelToken(
          baseToken,
          gcpPid,
          acc.gcpLocation || "global",
          false,
          "agent_platform"
        );
        acc.authExpired = false;
        acc.storedToken = cleanGcpTok;
        if (!cfg.__meta__.channelTokensById || typeof cfg.__meta__.channelTokensById !== "object") {
          cfg.__meta__.channelTokensById = {};
        }
        cfg.__meta__.channelTokensById[acc.id] = JSON.parse(JSON.stringify(cleanGcpTok));
        break;
      }
      continue;
    }

    let probeRes = await tryProbeWithToken(accessToken);
    if ((probeRes.modelsResp.status === 401 || probeRes.modelsResp.status === 403 || !probeRes.modelsResp.data) && refreshToken) {
      try {
        const refreshed = await refreshOAuthAccessToken(refreshToken);
        if (refreshed && refreshed.access_token) {
          sawValidToken = true;
          accessToken = refreshed.access_token;
          baseToken.token.access_token = accessToken;
          baseToken.token.refreshedForRt = refreshToken;
          baseToken.token.expiry = new Date(Date.now() + (refreshed.expires_in || 3599) * 1000).toISOString();
          for (const item of Object.values(cfg.accounts || {})) {
            if (item.storedToken?.token?.refresh_token === refreshToken) {
              item.storedToken.token.access_token = accessToken;
              item.storedToken.token.refreshedForRt = refreshToken;
              item.storedToken.token.expiry = baseToken.token.expiry;
            }
          }
          probeRes = await tryProbeWithToken(accessToken);
        }
      } catch (err) {
        if (err && err.isAuthExpired) sawAuthExpired = true;
      }
    }

    if (!isGcp && probeRes.byPool) {
      if (!acc.cachedQuotaByPool || typeof acc.cachedQuotaByPool !== "object") {
        acc.cachedQuotaByPool = {};
      }
      let anyPoolValid = false;
      for (const [poolKey, poolData] of Object.entries(probeRes.byPool)) {
        if (!poolData?.modelsResp?.data) continue;
        const prevPoolQuota = acc.cachedQuotaByPool[poolKey] || acc.cachedQuota || null;
        const parsedPool = parseCloudCodeModelsAndQuota(
          poolData.modelsResp.data,
          poolData.quotaSummaryResp?.data || null,
          false,
          probeRes.userTier,
          prevPoolQuota,
          []
        );
        if (parsedPool && Array.isArray(parsedPool.quotaGroups) && parsedPool.quotaGroups.length > 0) {
          parsedPool.pool = poolKey;
          parsedPool.upstreamHostname = poolKey === "daily" ? DAILY_HOSTNAME : PROD_HOSTNAME;
          if (probeRes.companionPid) {
            parsedPool.companionProjectId = probeRes.companionPid;
          }
          acc.cachedQuotaByPool[poolKey] = parsedPool;
          anyPoolValid = true;
        }
      }
      if (anyPoolValid) {
        if (probeRes.companionPid && !isDowngradedConsumerPoolProject(probeRes.companionPid)) {
          acc.companionProjectId = probeRes.companionPid;
        }
        const activeSnapshot =
          acc.cachedQuotaByPool[activePool] ||
          acc.cachedQuotaByPool.prod ||
          acc.cachedQuotaByPool.daily ||
          acc.cachedQuota;
        if (activeSnapshot) {
          acc.cachedQuota = activeSnapshot;
          if (activeSnapshot.tierCode) {
            acc.tierCode = activeSnapshot.tierCode;
            acc.tierName = activeSnapshot.tierName || acc.tierName;
          }
        }
        const cleanPersonalTok = buildCleanChannelToken(baseToken, "", "", false);
        acc.authExpired = false;
        acc.storedToken = cleanPersonalTok;
        if (!cfg.__meta__.channelTokensById || typeof cfg.__meta__.channelTokensById !== "object") {
          cfg.__meta__.channelTokensById = {};
        }
        cfg.__meta__.channelTokensById[acc.id] = JSON.parse(JSON.stringify(cleanPersonalTok));
        if (!cfg.__meta__.oauthTokensByEmail || typeof cfg.__meta__.oauthTokensByEmail !== "object") {
          cfg.__meta__.oauthTokensByEmail = {};
        }
        cfg.__meta__.oauthTokensByEmail[acc.email] = JSON.parse(JSON.stringify(cleanPersonalTok));
        writeRelayConfig(cfg);
        return acc.cachedQuota;
      }
    } else if (probeRes.modelsResp.status === 200 && probeRes.modelsResp.data) {
      const parsed = parseCloudCodeModelsAndQuota(
        probeRes.modelsResp.data,
        probeRes.quotaSummaryResp?.data || null,
        isGcp,
        probeRes.userTier,
        acc.cachedQuota || null,
        []
      );
      if (parsed && isGcp && parsed.availableModels.length > 0) {
        acc.authExpired = false;
        acc.cachedQuota = parsed;
        writeRelayConfig(cfg);
        return acc.cachedQuota;
      }
    }
  }

  if (sawAuthExpired && !sawValidToken) {
    acc.authExpired = true;
    writeRelayConfig(cfg);
  }

  if (isGcp && gcpBillingMode === "agent_platform") {
    const existingModels = acc.cachedQuota?.availableModels || [];
    const hasValidGcpModels =
      existingModels.length >= 6 &&
      existingModels.some((m) => isGcpOnlyModel(m?.label || m?.modelId || ""));
    const baseGcpModels =
      liveTierTemplate.length >= 6 && liveTierTemplate.some((m) => isGcpOnlyModel(m?.label || m?.modelId || ""))
        ? liveTierTemplate
        : AGENT_PLATFORM_DEFAULT_MODELS;
    acc.cachedQuota = {
      tierCode: "GCP",
      tierName: acc.tierName || "Agent Platform",
      hasArgonAccess: true,
      isPaidProOrUltra: false,
      isGcpUnlimited: true,
      quotaGroups: [],
      availableModels: hasValidGcpModels
        ? sanitizeCachedQuotaModels(acc.cachedQuota, true, liveTierTemplate).availableModels
        : baseGcpModels.map((m) => ({
            label: m.label,
            modelId: m.modelId || m.label,
            variantIds: [...(m.variantIds || [m.label])],
            remainingPct: 100,
            resetTime: "",
            unlimited: true
          })),
      probedVia: "agent_platform_catalog",
      updatedAt: Date.now()
    };
    writeRelayConfig(cfg);
    return acc.cachedQuota;
  }

  return acc.cachedQuota || null;
}

export async function probeAllChannelsQuotaSnapshot() {
  const cfg0 = readRelayConfig();
  normalizeAccountChannels(cfg0);
  if (cfg0.__meta__?.probeDebug) {
    delete cfg0.__meta__.probeDebug;
    writeRelayConfig(cfg0);
  }
  const channelIds = Object.keys(cfg0.accounts || {});
  const results = {};
  for (const cid of channelIds) {
    try {
      results[cid] = await probeChannelQuotaSnapshot(cid);
    } catch (err) {
      results[cid] = { error: err.message };
    }
  }
  return results;
}
