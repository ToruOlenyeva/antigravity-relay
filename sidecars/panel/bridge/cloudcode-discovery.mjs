// CloudCode API 传输、GCP 项目多源自动发现与模型/配额响应解析模块

import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { readRelayConfig, writeRelayConfig } from "../store.mjs";
import {
  readWinCredToken,
  getCloudCodeUserAgent,
  buildLoadCodeAssistMetadata,
  refreshOAuthAccessToken
} from "./wincred-ls.mjs";
import {
  isLegacyDeprecatedModel,
  isGcpOnlyModel,
  stripModelVariantSuffix,
  isModelEntryRestrictedOrSunset,
  resolveFamilyForCloudSlug,
  detectPersonalAccountTier,
  buildProModelsFromQuotaGroups,
  isValidOfficialQuotaGroup,
  normalizeAccountChannels,
  findStoredTokenForEmail,
  findFirstGcpProjectForEmail,
  isInternalConsumerPoolProject,
  parseCloudCodeApiError
} from "./channel-catalog.mjs";

/**
 * 获取当前个人账号配额池（统一使用 Daily 服务池）。
 * @param {object|null} cfg 可选的配置对象
 * @returns {string}
 */
export function getActivePersonalQuotaPool(cfg = null) {
  const c = cfg || readRelayConfig();
  if (c?.routing && c.routing.personalQuotaPool !== "daily") {
    c.routing.personalQuotaPool = "daily";
  }
  return "daily";
}

/**
 * 返回目标通道类型对应的 CloudCode PA 上游主机名。
 * @param {string} _pool 配额池标识
 * @param {boolean} isGcp 是否为 GCP 计费通道
 * @returns {string}
 */
export function getCloudCodeHostnameForPool(_pool = "daily", isGcp = false) {
  if (isGcp) return "cloudcode-pa.googleapis.com";
  return "daily-cloudcode-pa.googleapis.com";
}

/**
 * 向 Cloud Resource Manager 发起 JSON GET 请求的共享传输辅助函数。
 * @param {string} requestPath API 路径（含查询参数）
 * @param {string} accessToken OAuth Bearer Token
 * @param {object} extraHeaders 额外请求头
 * @returns {Promise<{status: number, rawText: string, data: object|null}>}
 */
function fetchCloudResourceJson(requestPath, accessToken, extraHeaders = {}) {
  return new Promise((resolve) => {
    if (!accessToken) return resolve({ status: 0, rawText: "", data: null });
    const req = https.request(
      {
        hostname: "cloudresourcemanager.googleapis.com",
        port: 443,
        path: requestPath,
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          ...extraHeaders
        },
        timeout: 4500
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const rawText = Buffer.concat(chunks).toString("utf8");
          let data = null;
          try {
            data = JSON.parse(rawText);
          } catch {}
          resolve({ status: res.statusCode || 0, rawText, data });
        });
      }
    );
    req.on("error", () => resolve({ status: -1, rawText: "", data: null }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: -2, rawText: "", data: null });
    });
    req.end();
  });
}

async function fetchCloudResourceProjects(accessToken, quotaProjectId = "") {
  const extraHeaders = quotaProjectId ? { "X-Goog-User-Project": quotaProjectId } : {};
  const resp = await fetchCloudResourceJson("/v1/projects?pageSize=100", accessToken, extraHeaders);
  if (resp.status !== 200) {
    let reason = "";
    if (resp.status === 403) {
      reason = /ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(resp.rawText) ? "scope_insufficient" : "api_disabled";
    }
    return { projects: [], status: resp.status, reason };
  }
  const list = (resp.data?.projects || [])
    .filter((p) => p && p.projectId && (!p.lifecycleState || p.lifecycleState === "ACTIVE") && !isInternalConsumerPoolProject(p.projectId))
    .map((p) => ({
      projectId: String(p.projectId).trim(),
      name: String(p.name || p.projectId).trim()
    }));
  return { projects: list, status: 200, reason: "" };
}

async function fetchCloudResourceV3Projects(accessToken) {
  const resp = await fetchCloudResourceJson("/v3/projects:search?pageSize=100", accessToken);
  if (resp.status !== 200 || !resp.data) return [];
  return (resp.data.projects || [])
    .filter((p) => p && p.projectId && (!p.state || p.state === "ACTIVE") && !isInternalConsumerPoolProject(p.projectId))
    .map((p) => ({
      projectId: String(p.projectId).trim(),
      name: String(p.displayName || p.projectId).trim()
    }));
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

/**
 * 调用 CloudCode PA HTTPS POST 接口的通用客户端封装（含 6 秒硬超时）。
 * @param {string} endpointPath 接口路径
 * @param {string} accessToken OAuth Bearer Token
 * @param {object} payloadObj 请求 JSON 载荷
 * @param {object} extraHeaders 额外请求头
 * @param {string} targetHostname 目标上游域名
 * @returns {Promise<{status: number, data: object|null, raw?: string, error?: string}>}
 */
export function callCloudCodeApi(endpointPath, accessToken, payloadObj = {}, extraHeaders = {}, targetHostname = "") {
  return new Promise((resolve) => {
    if (!accessToken) return resolve({ status: 0, data: null });
    const hostname = String(targetHostname || "").trim() || "cloudcode-pa.googleapis.com";
    const body = Buffer.from(JSON.stringify(payloadObj || {}), "utf8");
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      resolve(val);
    };
    const req = https.request(
      {
        hostname,
        port: 443,
        path: endpointPath,
        method: "POST",
        family: 4,
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
            finish({ status: res.statusCode || 0, data: JSON.parse(raw) });
          } catch {
            finish({ status: res.statusCode || 0, data: null, raw: raw.slice(0, 300) });
          }
        });
      }
    );
    const hardTimer = setTimeout(() => {
      req.destroy();
      finish({ status: -2, data: null, error: "timeout" });
    }, 6000);
    req.on("error", (err) => finish({ status: -1, data: null, error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      finish({ status: -2, data: null, error: "timeout" });
    });
    req.write(body);
    req.end();
  });
}

/**
 * 从 CloudCode API 错误响应中提取单行精简错误摘要。
 * @param {object} resp 响应对象
 * @param {string} endpoint 接口名称
 * @returns {string}
 */
export function extractApiErrorSummary(resp, endpoint = "") {
  return parseCloudCodeApiError(resp, endpoint)?.message || "";
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

/**
 * 为指定邮箱自动发现关联的 GCP 云项目列表（整合 CRM v1 / v3、loadCodeAssist、本地 gcloud 与已有快照）。
 * @param {string} targetEmail 目标邮箱
 * @returns {Promise<{email: string, discovered: Array, reason: string}>}
 */
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

/**
 * 将 CloudCode fetchAvailableModels 与 retrieveUserQuotaSummary 返回结构解析为标准配额快照对象。
 * @param {object} rawModelsResp fetchAvailableModels 返回的 JSON 数据
 * @param {object|null} rawQuotaSummaryResp retrieveUserQuotaSummary 返回的 JSON 数据
 * @param {boolean} isGcpChannel 是否为 GCP 通道
 * @param {string} userTier 探测到的原始等级字串
 * @param {object|null} prevCachedQuota 历史配额缓存
 * @param {Array} liveTierTemplate 动态模型白名单模板
 * @returns {object|null}
 */
export function parseCloudCodeModelsAndQuota(
  rawModelsResp,
  rawQuotaSummaryResp = null,
  isGcpChannel = false,
  userTier = ""
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
  const seenModelIds = new Set();
  if (allowedModelIds.size > 0) {
    for (const mid of allowedModelIds) {
      if (modelsObj[mid] && !seenModelIds.has(mid)) {
        orderedEntries.push([mid, modelsObj[mid]]);
        seenModelIds.add(mid);
      }
    }
  }
  for (const [mid, m] of Object.entries(modelsObj)) {
    if (!seenModelIds.has(mid)) {
      orderedEntries.push([mid, m]);
      seenModelIds.add(mid);
    }
  }

  const tierInfo = isGcpChannel
    ? { tierCode: "GCP", tierName: "Agent Platform", hasArgonAccess: true, isPaidProOrUltra: false }
    : detectPersonalAccountTier(
        modelsObj,
        userTier,
        userTier,
        undefined,
        ""
      );
  const hasArgonAccess = tierInfo.hasArgonAccess;
  const isPaidProOrUltra = tierInfo.isPaidProOrUltra;
  const groupedModelMap = new Map();

  for (const [modelId, m] of orderedEntries) {
    if (!m || typeof m !== "object") continue;
    if (/disabled$/i.test(modelId)) continue;
    if (isModelEntryRestrictedOrSunset(m)) continue;
    if (!isGcpChannel && isGcpOnlyModel(modelId)) continue;
    const rawDisplay = String(m.displayName || m.label || "").trim();
    const resolvedFamily = resolveFamilyForCloudSlug(modelId, m);
    const rawLabel = rawDisplay && !/^([a-z0-9._-]+)$/.test(rawDisplay)
      ? rawDisplay
      : (resolvedFamily || rawDisplay);
    if (!rawLabel) continue;
    const baseLabel = stripModelVariantSuffix(rawLabel);
    if (isLegacyDeprecatedModel(baseLabel) || isLegacyDeprecatedModel(rawLabel) || isLegacyDeprecatedModel(modelId)) {
      continue;
    }
    if (!isGcpChannel && isGcpOnlyModel(baseLabel)) continue;
    if (!isGcpChannel && !m.quotaInfo && !allowedModelIds.has(modelId) && !(hasArgonAccess && /orchestrator|\bargon\b/i.test(baseLabel))) {
      continue;
    }
    if (!isGcpChannel) {
      if (!hasArgonAccess && /\bargon\b|orchestrator/i.test(baseLabel)) {
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
        variantIds: Array.from(new Set([baseLabel, rawLabel, modelId])),
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
      [],
      dynamicApiModels,
      [],
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

  let availableModels = Array.from(groupedModelMap.values()).filter(
    (m) => !isLegacyDeprecatedModel(m.label) && !isLegacyDeprecatedModel(m.modelId)
  );
  if (!isGcpChannel) {
    availableModels = mergeNativeCatalogIntoPersonalModels(availableModels, hasArgonAccess, isPaidProOrUltra);
  }

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
