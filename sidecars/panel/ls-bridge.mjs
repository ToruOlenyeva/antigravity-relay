if (Number(process.ppid || 0) > 0) {
  try {
    process.kill(Number(process.ppid), 0);
  } catch (err) {
    if (err && err.code === "ESRCH") {
      process.exit(0);
    }
  }
}
if (!globalThis.__AGY_RELAY_MAIN_V2__) {
  setTimeout(() => process.exit(0), 100);
}

const _storeMod = await import("./store.mjs");
const {
  readRelayConfig,
  writeRelayConfig,
  resolveCurrentInstanceContext,
  writeInstanceDescriptor,
  getInstanceMeta
} = _storeMod;

const _wincredMod = await import("./bridge/wincred-ls.mjs");
const {
  readWinCredToken,
  writeWinCredToken,
  buildCleanChannelToken,
  parseLsLogInfo,
  listRunningLanguageServerProcesses,
  inspectActiveFieldInstances,
  discoverLanguageServer,
  callLsRpc,
  refreshOAuthAccessToken,
  scheduleDetachedLanguageServerRestart
} = _wincredMod;
import {
  AGENT_PLATFORM_DEFAULT_MODELS,
  isLegacyDeprecatedModel,
  isGcpOnlyModel,
  isModelEntryRestrictedOrSunset,
  detectPersonalAccountTier,
  buildProModelsFromQuotaGroups,
  isValidOfficialQuotaGroup,
  normalizeAccountChannels,
  findStoredTokenForEmail,
  findFirstGcpProjectForEmail,
  discoverGcpProjectsForAccount,
  probeChannelQuotaSnapshot,
  probeAllChannelsQuotaSnapshot
} from "./bridge/quota-probe.mjs";
import {
  selectBestPersonalChannelForModel,
  proxyCloudCodeRequest,
  getActiveCloudCodeProxyUrl,
  ensureCloudCodeProxyServer,
  routeChannelEphemeral
} from "./bridge/cloudcode-proxy.mjs";
import {
  scrubRecentConversationsSignatures,
  manualScrubAllSignatures
} from "./bridge/signature-scrub.mjs";
import {
  computeSessionTelemetrySnapshot,
  launchIsolatedAntigravityInstance,
  cancelIsolatedOAuthFlow,
  startIsolatedOAuthFlow,
  hasActiveOAuthSession
} from "./bridge/oauth-launcher.mjs";

export {
  readWinCredToken,
  writeWinCredToken,
  discoverLanguageServer,
  callLsRpc,
  detectPersonalAccountTier,
  discoverGcpProjectsForAccount,
  probeChannelQuotaSnapshot,
  probeAllChannelsQuotaSnapshot,
  selectBestPersonalChannelForModel,
  proxyCloudCodeRequest,
  getActiveCloudCodeProxyUrl,
  ensureCloudCodeProxyServer,
  routeChannelEphemeral,
  scrubRecentConversationsSignatures,
  manualScrubAllSignatures,
  computeSessionTelemetrySnapshot,
  launchIsolatedAntigravityInstance,
  cancelIsolatedOAuthFlow,
  startIsolatedOAuthFlow
};

export function addOrUpdatePersonalChannelCard(email) {
  const cleanEmail = (email || "").trim();
  if (!cleanEmail) return null;
  const cfg = readRelayConfig();
  normalizeAccountChannels(cfg);
  const baseToken = findStoredTokenForEmail(cfg, cleanEmail, false) || readWinCredToken(false);
  const personalKey = `${cleanEmail}#personal`;
  if (Array.isArray(cfg.__meta__?.deletedChannelIds)) {
    cfg.__meta__.deletedChannelIds = cfg.__meta__.deletedChannelIds.filter((id) => id !== personalKey);
  }
  const existing = cfg.accounts[personalKey];
  cfg.accounts[personalKey] = {
    ...existing,
    id: personalKey,
    alias: existing?.alias || cleanEmail,
    email: cleanEmail,
    channelType: "personal",
    tierName: existing?.tierName && !/agent\s*platform|enterprise|gcp/i.test(existing.tierName)
      ? existing.tierName
      : "Google AI Pro",
    gcpProjectId: "",
    gcpBillingMode: "",
    gcpLocation: "",
    savedAt: existing?.savedAt || new Date().toISOString(),
    storedToken: baseToken
      ? buildCleanChannelToken(baseToken, "", "")
      : (existing?.storedToken || null)
  };
  writeRelayConfig(cfg);
  return cfg.accounts[personalKey];
}

export function addOrUpdateGcpChannelCard(email, projectId, opts = {}) {
  const cleanEmail = (email || "").trim();
  const rawPidStr = (projectId || "").trim();
  const options = typeof opts === "string" ? { projectName: opts } : (opts || {});
  if (cleanEmail && (rawPidStr === "__PERSONAL__" || options.channelType === "personal")) {
    const card = addOrUpdatePersonalChannelCard(cleanEmail);
    if (card?.id) {
      probeChannelQuotaSnapshot(card.id).catch(() => {});
    }
    return card;
  }
  if (!cleanEmail || !rawPidStr) return null;

  const parts = rawPidStr.split("|").map((s) => s.trim());
  const cleanPid = parts[0] || "";
  if (!cleanPid) return null;
  const modeFromStr = parts[1] || "";
  const locFromStr = parts[2] || "";
  const oldPidFromStr = parts[3] || "";
  const projectName = (options.projectName || "").trim();

  const cfg = readRelayConfig();
  normalizeAccountChannels(cfg);
  const baseToken = findStoredTokenForEmail(cfg, cleanEmail, true) || readWinCredToken(false);
  if (!cfg.gcpProjects.includes(cleanPid)) {
    cfg.gcpProjects.push(cleanPid);
  }
  const gcpKey = `${cleanEmail}#gcp:${cleanPid}`;
  if (Array.isArray(cfg.__meta__?.deletedChannelIds)) {
    cfg.__meta__.deletedChannelIds = cfg.__meta__.deletedChannelIds.filter((id) => id !== gcpKey);
  }
  const oldKey = oldPidFromStr && oldPidFromStr !== cleanPid ? `${cleanEmail}#gcp:${oldPidFromStr}` : "";
  const existing = cfg.accounts[gcpKey] || (oldKey ? cfg.accounts[oldKey] : null);
  const gcpBillingMode = options.gcpBillingMode || modeFromStr || existing?.gcpBillingMode || "agent_platform";
  const rawLoc = options.gcpLocation || locFromStr || existing?.gcpLocation || "global";
  const gcpLocation = ["global", "us", "eu"].includes(rawLoc) ? rawLoc : "global";
  const tierName = gcpBillingMode === "gemini_enterprise" ? "Gemini Enterprise" : "Agent Platform";

  cfg.accounts[gcpKey] = {
    ...existing,
    id: gcpKey,
    alias: existing?.alias && !oldKey ? existing.alias : `${cleanEmail} (${cleanPid})`,
    email: cleanEmail,
    channelType: "gcp",
    tierName,
    gcpProjectId: cleanPid,
    gcpBillingMode,
    gcpLocation,
    projectName: projectName || existing?.projectName || cleanPid,
    savedAt: existing?.savedAt || new Date().toISOString(),
    storedToken: baseToken
      ? {
          ...baseToken,
          auth_method: "gcp",
          project_id: cleanPid,
          region: gcpBillingMode === "agent_platform" ? gcpLocation : ""
        }
      : (existing?.storedToken || null),
    cachedQuota: gcpBillingMode === "agent_platform"
      ? {
          isGcpUnlimited: true,
          quotaGroups: [],
          availableModels: AGENT_PLATFORM_DEFAULT_MODELS.map((m) => ({ ...m, variantIds: [...m.variantIds] })),
          updatedAt: Date.now()
        }
      : (existing?.cachedQuota || {
          isGcpUnlimited: true,
          quotaGroups: [],
          availableModels: [],
          updatedAt: Date.now()
        })
  };

  if (oldKey && cfg.accounts[oldKey]) {
    delete cfg.accounts[oldKey];
    if (cfg.routing?.models) {
      for (const [mKey, rVal] of Object.entries(cfg.routing.models)) {
        if (rVal === `account:${oldKey}`) {
          cfg.routing.models[mKey] = `account:${gcpKey}`;
        }
      }
    }
  }

  writeRelayConfig(cfg);

  const activeEmail = (cfg.__meta__?.activeEmail || "").trim();
  const activePid = (cfg.__meta__?.lastAppliedGcpProject || "").trim();
  if (activeEmail === cleanEmail && (activePid === cleanPid || (oldPidFromStr && activePid === oldPidFromStr))) {
    switchBillingProjectInstant(cleanPid, { gcpBillingMode, gcpLocation }).catch(() => {});
  }

  return cfg.accounts[gcpKey];
}

export async function fetchLiveSystemSnapshot(forceWinCred = false) {
  const cfg = readRelayConfig();
  normalizeAccountChannels(cfg);
  const ctx = resolveCurrentInstanceContext();
  const instMeta = getInstanceMeta(cfg, ctx);

  let ls = discoverLanguageServer(false);
  let userStatusResp = null;
  let quotaSummaryResp = null;

  if (ls) {
    try {
      [userStatusResp, quotaSummaryResp] = await Promise.all([
        callLsRpc(ls, "GetUserStatus", {}),
        callLsRpc(ls, "RetrieveUserQuotaSummary", {}).catch(() => null)
      ]);
    } catch {
      ls = discoverLanguageServer(true);
      if (ls) {
        try {
          [userStatusResp, quotaSummaryResp] = await Promise.all([
            callLsRpc(ls, "GetUserStatus", {}),
            callLsRpc(ls, "RetrieveUserQuotaSummary", {}).catch(() => null)
          ]);
        } catch {}
      }
    }
  }

  const logInfo = parseLsLogInfo(ctx.lsLogFile);
  const cred = readWinCredToken(forceWinCred);
  const us = userStatusResp?.userStatus || {};
  const planStatus = us?.planStatus || {};
  const cascadeConfig = us?.cascadeModelConfigData || {};
  const clientModelConfigs = cascadeConfig?.clientModelConfigs || [];

  const lsEmail = (us.email || "").trim();
  const credEmail = (cred?.id_token_email || "").trim();
  const activeName = us.name || "";
  const rawTierName = us.userTier?.name || planStatus?.planInfo?.planName || "";
  const activeTierId = us.userTier?.id || "";

  const tierIndicatesGcp = /agent\s*platform|enterprise/i.test(rawTierName);
  const credPid = String(cred?.project_id || "").trim();
  const logPid = String(logInfo.lastProjectId || "").trim();
  const instPinnedId = String(instMeta.activeChannelId || "").trim();
  const instPinnedAcc = instPinnedId ? cfg.accounts?.[instPinnedId] : null;
  const recentlySwitched = Boolean(instMeta.switchedAt && Date.now() - Number(instMeta.switchedAt) < 15000);

  let activeEmail = "";
  let isLiveGcp = false;
  let activeGcpProject = "";

  if (ctx.isIsolatedInstance) {
    // 多开独立窗口：绝不使用已被还原回主窗口的全局 WinCred，严格以当前窗口的 instMeta 与当前窗口专属描述符为准
    const descId = String(ctx.descriptor?.activeChannelId || "").trim();
    const descAcc = descId ? cfg.accounts?.[descId] : null;
    const effectiveIsoAcc = instPinnedAcc || descAcc;
    if (effectiveIsoAcc) {
      activeEmail = effectiveIsoAcc.email;
      isLiveGcp = effectiveIsoAcc.channelType === "gcp" || Boolean(effectiveIsoAcc.gcpProjectId);
      activeGcpProject = isLiveGcp ? (effectiveIsoAcc.gcpProjectId || logPid) : "";
    } else {
      activeEmail = ctx.descriptor?.email || lsEmail || instMeta.activeEmail || "";
      isLiveGcp = Boolean(ctx.descriptor?.gcpProjectId || instMeta.lastAppliedGcpProject);
      activeGcpProject = isLiveGcp
        ? (ctx.descriptor?.gcpProjectId || instMeta.lastAppliedGcpProject || logPid || findFirstGcpProjectForEmail(cfg, activeEmail))
        : "";
    }
  } else {
    // 主窗口：只要用户在插件面板内明确启用固定了通道（instPinnedAcc + switchedViaPanel），严格以面板所选通道为唯一权威事实源，彻底杜绝多开实例或滞后 lsEmail 反向篡改主窗口通道
    const lsActuallyGcp = Boolean(logPid || tierIndicatesGcp);
    if (instPinnedAcc && (instMeta.switchedViaPanel || recentlySwitched || !lsEmail || (lsEmail === instPinnedAcc.email && lsActuallyGcp === Boolean(instPinnedAcc.gcpProjectId)))) {
      activeEmail = instPinnedAcc.email;
      isLiveGcp = instPinnedAcc.channelType === "gcp" || Boolean(instPinnedAcc.gcpProjectId);
      activeGcpProject = isLiveGcp ? (instPinnedAcc.gcpProjectId || logPid || credPid) : "";
    } else if (lsEmail) {
      activeEmail = lsEmail;
      isLiveGcp = lsActuallyGcp;
      activeGcpProject = isLiveGcp
        ? (logPid || instMeta.lastAppliedGcpProject || credPid || findFirstGcpProjectForEmail(cfg, activeEmail))
        : "";
    } else {
      activeEmail = credEmail || instMeta.activeEmail || cfg.__meta__?.activeEmail || "";
      if (cred) {
        isLiveGcp = Boolean(cred.auth_method === "gcp" || credPid);
      } else if (instMeta.lastAppliedGcpProject || cfg.__meta__?.lastAppliedGcpProject) {
        isLiveGcp = true;
      }
      activeGcpProject = isLiveGcp
        ? (credPid || instMeta.lastAppliedGcpProject || cfg.__meta__?.lastAppliedGcpProject || findFirstGcpProjectForEmail(cfg, activeEmail))
        : "";
    }
  }

  // 若当前窗口属于个人通道但底层 LS 曾误读全局 WinCred 的 GCP ProjectID，主动清空其 ProjectID 退出 Vertex 模式
  if (!isLiveGcp && ls && (logPid || tierIndicatesGcp)) {
    callLsRpc(ls, "ValidateProject", { projectId: "", location: "" }).catch(() => {});
  } else if (isLiveGcp && activeGcpProject && ls && logPid !== activeGcpProject) {
    // 若当前窗口固定为 GCP 通道但底层 LS 的 ProjectID 曾被外部冲掉，自动调用 ValidateProject 自愈恢复
    const healLoc = (instPinnedAcc?.gcpBillingMode || "agent_platform") === "agent_platform"
      ? (instPinnedAcc?.gcpLocation || "global")
      : "";
    callLsRpc(ls, "ValidateProject", { projectId: activeGcpProject, location: healLoc }).catch(() => {});
  }

  const activeGcpBillingMode = isLiveGcp
    ? (/enterprise/i.test(rawTierName) || logInfo.lastUserTier === "enterprise" ? "gemini_enterprise" : "agent_platform")
    : "";
  const activeGcpLocation = isLiveGcp
    ? (logInfo.lastLocation || cred?.region || "global")
    : "";
  const activeTierName = isLiveGcp
    ? (activeGcpBillingMode === "gemini_enterprise" ? "Gemini Enterprise" : "Agent Platform")
    : (rawTierName || "Google AI Pro");

  const resolvedChannelId = activeEmail
    ? (activeGcpProject ? `${activeEmail}#gcp:${activeGcpProject}` : `${activeEmail}#personal`)
    : "";

  if (activeEmail) {
    instMeta.activeEmail = activeEmail;
    if (!ctx.isIsolatedInstance) {
      cfg.__meta__.activeEmail = activeEmail;
    }
  }
  instMeta.lastAppliedGcpProject = activeGcpProject;
  if (resolvedChannelId) {
    instMeta.activeChannelId = resolvedChannelId;
  }
  if (!ctx.isIsolatedInstance) {
    cfg.__meta__.lastAppliedGcpProject = activeGcpProject;
    if (resolvedChannelId) {
      cfg.__meta__.activeChannelId = resolvedChannelId;
    }
  }

  const deletedSet = new Set(Array.isArray(cfg.__meta__?.deletedChannelIds) ? cfg.__meta__.deletedChannelIds : []);

  if (cred && credEmail && !isLiveGcp && cred.auth_method !== "gcp" && !credPid) {
    if (!cfg.__meta__.oauthTokensByEmail || typeof cfg.__meta__.oauthTokensByEmail !== "object") {
      cfg.__meta__.oauthTokensByEmail = {};
    }
    if (!cfg.__meta__.oauthTokensByEmail[credEmail]) {
      cfg.__meta__.oauthTokensByEmail[credEmail] = buildCleanChannelToken(cred, "", "");
    }
    const credPersonalKey = `${credEmail}#personal`;
    const existingCredPersonal = cfg.accounts[credPersonalKey];
    if (!deletedSet.has(credPersonalKey) && (existingCredPersonal || credEmail === activeEmail)) {
      cfg.accounts[credPersonalKey] = {
        ...existingCredPersonal,
        id: credPersonalKey,
        alias: existingCredPersonal?.alias || credEmail,
        email: credEmail,
        channelType: "personal",
        tierName: existingCredPersonal?.tierName || "Google AI Pro",
        gcpProjectId: "",
        gcpBillingMode: "",
        gcpLocation: "",
        savedAt: existingCredPersonal?.savedAt || new Date().toISOString(),
        storedToken: buildCleanChannelToken(cred, "", "")
      };
    }
  }

  if (activeEmail) {
    const credIsGcp = Boolean(cred && (cred.auth_method === "gcp" || credPid));
    const matchingCred = (cred && credEmail === activeEmail && credIsGcp === isLiveGcp)
      ? cred
      : findStoredTokenForEmail(cfg, activeEmail, isLiveGcp);

    if (!isLiveGcp) {
      const personalKey = `${activeEmail}#personal`;
      if (!deletedSet.has(personalKey)) {
        const existingPersonal = cfg.accounts[personalKey];
        cfg.accounts[personalKey] = {
          ...existingPersonal,
          id: personalKey,
          alias: existingPersonal?.alias || activeEmail,
          email: activeEmail,
          channelType: "personal",
          tierName: existingPersonal?.tierName || "Google AI Pro",
          gcpProjectId: "",
          gcpBillingMode: "",
          gcpLocation: "",
          savedAt: existingPersonal?.savedAt || new Date().toISOString(),
          storedToken: existingPersonal?.storedToken?.token?.refresh_token
            ? existingPersonal.storedToken
            : (matchingCred ? buildCleanChannelToken(matchingCred, "", "") : null)
        };
      }
    } else if (activeGcpProject) {
      const gcpKey = `${activeEmail}#gcp:${activeGcpProject}`;
      if (!deletedSet.has(gcpKey)) {
        const existingGcp = cfg.accounts[gcpKey];
        const resolvedMode = activeGcpBillingMode || existingGcp?.gcpBillingMode || "agent_platform";
        const resolvedLoc = activeGcpLocation || existingGcp?.gcpLocation || "global";
        cfg.accounts[gcpKey] = {
          ...existingGcp,
          id: gcpKey,
          alias: existingGcp?.alias || `${activeEmail} (${activeGcpProject})`,
          email: activeEmail,
          channelType: "gcp",
          tierName: resolvedMode === "gemini_enterprise" ? "Gemini Enterprise" : "Agent Platform",
          gcpProjectId: activeGcpProject,
          gcpBillingMode: resolvedMode,
          gcpLocation: resolvedLoc,
          projectName: existingGcp?.projectName || activeGcpProject,
          savedAt: existingGcp?.savedAt || new Date().toISOString(),
          storedToken: existingGcp?.storedToken?.token?.refresh_token
            ? existingGcp.storedToken
            : (matchingCred
                ? {
                    ...matchingCred,
                    auth_method: "gcp",
                    project_id: activeGcpProject,
                    region: resolvedMode === "agent_platform" ? resolvedLoc : ""
                  }
                : null)
        };
      }
      if (!cfg.gcpProjects.includes(activeGcpProject)) {
        cfg.gcpProjects.push(activeGcpProject);
      }
    }
  }

  if (ls) {
    const rpcTargetObj = {
      pid: ls.pid || 0,
      hostname: ls.hostname,
      port: ls.port,
      protocol: ls.protocol || "http",
      altPort: ls.altPort || 0,
      altProtocol: ls.altProtocol || "https",
      csrf: ls.csrf,
      updatedAt: Date.now()
    };
    instMeta.lsRpcTarget = rpcTargetObj;
    if (!ctx.isIsolatedInstance) {
      cfg.__meta__.lsRpcTarget = rpcTargetObj;
    }

    const desiredProxyMode = isLiveGcp ? "direct" : "local_proxy";
    const localProxyUrl = getActiveCloudCodeProxyUrl(cfg);
    const targetUrl = isLiveGcp ? "https://daily-cloudcode-pa.googleapis.com" : localProxyUrl;
    if (
      instMeta.cloudCodeProxyPid !== ls.pid ||
      instMeta.cloudCodeProxyMode !== desiredProxyMode ||
      instMeta.cloudCodeProxyUrl !== targetUrl
    ) {
      await callLsRpc(ls, "SetCloudCodeURL", { url: targetUrl })
        .then(() => {
          instMeta.cloudCodeProxyPid = ls.pid;
          instMeta.cloudCodeProxyMode = desiredProxyMode;
          instMeta.cloudCodeProxyUrl = targetUrl;
          if (!ctx.isIsolatedInstance) {
            cfg.__meta__.cloudCodeProxyPid = ls.pid;
            cfg.__meta__.cloudCodeProxyMode = desiredProxyMode;
            cfg.__meta__.cloudCodeProxyUrl = targetUrl;
          }
        })
        .catch(() => {});
    }
  }

  const lsHasGcpModels = clientModelConfigs.some((m) => isGcpOnlyModel(m.label || m.modelOrAlias?.model || ""));
  const lsModeMatches = Boolean(lsEmail && lsEmail === activeEmail && Boolean(activeGcpProject) === Boolean(tierIndicatesGcp || lsHasGcpModels));
  const effectiveClientModels = lsModeMatches ? clientModelConfigs : [];

  const liveChannelKey = activeEmail
    ? (activeGcpProject ? `${activeEmail}#gcp:${activeGcpProject}` : `${activeEmail}#personal`)
    : "";
  const cachedHasArgon = liveChannelKey ? cfg.accounts?.[liveChannelKey]?.cachedQuota?.hasArgonAccess : undefined;
  const cachedTierCode = liveChannelKey ? (cfg.accounts?.[liveChannelKey]?.tierCode || cfg.accounts?.[liveChannelKey]?.cachedQuota?.tierCode || "") : "";
  const liveTierInfo = activeGcpProject
    ? { tierCode: "GCP", tierName: activeTierName, hasArgonAccess: true, isPaidProOrUltra: false }
    : detectPersonalAccountTier(
        effectiveClientModels,
        lsModeMatches ? rawTierName : (cfg.accounts?.[liveChannelKey]?.tierName || ""),
        lsModeMatches ? activeTierId : "",
        cachedHasArgon,
        cachedTierCode
      );
  const hasLiveArgonAccess = liveTierInfo.hasArgonAccess;
  const isLivePaidProOrUltra = liveTierInfo.isPaidProOrUltra;
  if (!activeGcpProject && liveChannelKey && cfg.accounts[liveChannelKey]) {
    cfg.accounts[liveChannelKey].tierCode = liveTierInfo.tierCode;
    cfg.accounts[liveChannelKey].tierName = liveTierInfo.tierName;
  }

  const groupedModelMap = new Map();
  for (const m of effectiveClientModels) {
    const rawLabel = (m.label || "").trim();
    const modelId = m.modelOrAlias?.model || m.modelOrAlias?.alias || "";
    if (!rawLabel || !modelId) continue;
    const baseLabel = rawLabel.replace(/\s*\((Low|Medium|High|Max)\)\s*$/i, "").trim();
    if (!activeGcpProject) {
      if (
        isLegacyDeprecatedModel(baseLabel) ||
        isLegacyDeprecatedModel(rawLabel) ||
        isGcpOnlyModel(baseLabel) ||
        isGcpOnlyModel(rawLabel) ||
        isModelEntryRestrictedOrSunset(m)
      ) {
        continue;
      }
      if (!hasLiveArgonAccess && /argon/i.test(baseLabel)) {
        continue;
      }
    }
    const remainingPct = activeGcpProject
      ? 100
      : (m.quotaInfo?.remainingFraction !== undefined
          ? Math.round(m.quotaInfo.remainingFraction * 100)
          : (m.quotaInfo?.resetTime ? 0 : 100));
    const resetTime = activeGcpProject ? "" : (m.quotaInfo?.resetTime || "");

    if (!groupedModelMap.has(baseLabel)) {
      groupedModelMap.set(baseLabel, {
        label: baseLabel,
        modelId: baseLabel,
        variantIds: [baseLabel, rawLabel, modelId],
        remainingPct,
        resetTime,
        unlimited: Boolean(activeGcpProject)
      });
    } else {
      const entry = groupedModelMap.get(baseLabel);
      if (!entry.variantIds.includes(rawLabel)) entry.variantIds.push(rawLabel);
      if (!entry.variantIds.includes(modelId)) entry.variantIds.push(modelId);
    }
  }
  let availableModels = Array.from(groupedModelMap.values());
  if (availableModels.length === 0 && activeGcpProject && activeGcpBillingMode === "agent_platform") {
    availableModels = AGENT_PLATFORM_DEFAULT_MODELS.map((m) => ({ ...m, variantIds: [...m.variantIds] }));
  }

  const rawQuotaGroups = (activeGcpProject || !lsModeMatches)
    ? []
    : (quotaSummaryResp?.response?.groups || [])
        .map((g) => ({
          id: g.groupId || g.displayName || "",
          displayName: g.displayName || "",
          description: g.description || "",
          buckets: (g.buckets || []).map((b) => ({
            bucketId: b.bucketId || "",
            window: b.window || "",
            remainingPct: b.remainingFraction !== undefined
              ? Math.round(b.remainingFraction * 100)
              : (b.resetTime ? 0 : 100),
            resetTime: b.resetTime || ""
          }))
        }))
        .filter((g) => isValidOfficialQuotaGroup(g));
  let quotaGroups = (!activeGcpProject && !hasLiveArgonAccess)
    ? rawQuotaGroups.filter((g) => !/argon/i.test(g.id || g.displayName || ""))
    : rawQuotaGroups;

  if (!activeGcpProject && quotaGroups.length > 0 && liveTierInfo.tierCode !== "Free") {
    availableModels = buildProModelsFromQuotaGroups(
      quotaGroups,
      cfg.accounts?.[liveChannelKey]?.cachedQuota?.availableModels || [],
      availableModels,
      [],
      hasLiveArgonAccess
    );
  }

  const detectedChannelId = activeEmail
    ? (activeGcpProject ? `${activeEmail}#gcp:${activeGcpProject}` : `${activeEmail}#personal`)
    : "";
  const pinnedChannelId = String(instMeta.activeChannelId || (!ctx.isIsolatedInstance ? cfg.__meta__?.activeChannelId : "") || "").trim();
  const activeChannelId = (pinnedChannelId && cfg.accounts?.[pinnedChannelId])
    ? pinnedChannelId
    : detectedChannelId;

  if (!activeGcpProject && (quotaGroups.length === 0 || availableModels.length === 0) && detectedChannelId && cfg.accounts[detectedChannelId]) {
    const cachedGroups = (cfg.accounts[detectedChannelId].cachedQuota?.quotaGroups || []).filter((g) => isValidOfficialQuotaGroup(g));
    const cachedModels = (cfg.accounts[detectedChannelId].cachedQuota?.availableModels || []).filter((m) => !isGcpOnlyModel(m.label || ""));
    if (cachedGroups.length > 0 && cachedModels.length > 0 && !forceWinCred) {
      quotaGroups = cachedGroups;
      if (availableModels.length === 0) availableModels = cachedModels;
    } else {
      await probeChannelQuotaSnapshot(detectedChannelId).catch(() => {});
      const freshCfg = readRelayConfig();
      const probed = freshCfg?.accounts?.[detectedChannelId]?.cachedQuota;
      if (probed) {
        cfg.accounts[detectedChannelId].cachedQuota = probed;
        if (Array.isArray(probed.quotaGroups) && probed.quotaGroups.length > 0) {
          quotaGroups = probed.quotaGroups.filter((g) => isValidOfficialQuotaGroup(g));
        }
        if (availableModels.length === 0 && Array.isArray(probed.availableModels) && probed.availableModels.length > 0) {
          availableModels = probed.availableModels;
        }
      }
    }
  }

  if (availableModels.length > 0 && effectiveClientModels.length > 0 && activeGcpProject) {
    if (!cfg.__meta__.liveTierModels || typeof cfg.__meta__.liveTierModels !== "object") {
      cfg.__meta__.liveTierModels = {};
    }
    cfg.__meta__.liveTierModels.gcp = availableModels.map((m) => ({
      label: m.label,
      modelId: m.modelId,
      variantIds: [...(m.variantIds || [m.label])]
    }));
  }

  if (detectedChannelId && cfg.accounts[detectedChannelId] && (quotaGroups.length > 0 || availableModels.length > 0 || activeGcpProject)) {
    cfg.accounts[detectedChannelId].cachedQuota = {
      tierCode: liveTierInfo.tierCode,
      tierName: liveTierInfo.tierName,
      hasArgonAccess: hasLiveArgonAccess,
      isPaidProOrUltra: isLivePaidProOrUltra,
      isGcpUnlimited: Boolean(activeGcpProject),
      quotaGroups,
      availableModels: availableModels.length > 0
        ? availableModels
        : (cfg.accounts[detectedChannelId].cachedQuota?.availableModels || []),
      updatedAt: Date.now()
    };
  }
  if (activeChannelId && activeChannelId !== detectedChannelId && cfg.accounts[activeChannelId]) {
    const cachedAt = Number(cfg.accounts[activeChannelId].cachedQuota?.updatedAt || 0);
    if (forceWinCred || !cfg.accounts[activeChannelId].cachedQuota?.quotaGroups?.length || (Date.now() - cachedAt > 45000)) {
      await probeChannelQuotaSnapshot(activeChannelId).catch(() => {});
      const freshCfg = readRelayConfig();
      if (freshCfg?.accounts?.[activeChannelId]?.cachedQuota) {
        cfg.accounts[activeChannelId].cachedQuota = freshCfg.accounts[activeChannelId].cachedQuota;
      }
    }
  }
  const activeAccObj = activeChannelId ? cfg.accounts[activeChannelId] : null;
  const displayAccount = activeAccObj
    ? {
        email: activeAccObj.email,
        name: activeName,
        tierCode: activeAccObj.tierCode || activeAccObj.cachedQuota?.tierCode || liveTierInfo.tierCode,
        tierName: activeAccObj.tierName || activeTierName,
        tierId: activeTierId,
        gcpProjectId: activeAccObj.gcpProjectId || "",
        gcpBillingMode: activeAccObj.gcpBillingMode || "",
        gcpLocation: activeAccObj.gcpLocation || "",
        channelId: activeChannelId
      }
    : {
        email: activeEmail,
        name: activeName,
        tierCode: liveTierInfo.tierCode,
        tierName: activeTierName,
        tierId: activeTierId,
        gcpProjectId: activeGcpProject,
        gcpBillingMode: activeGcpBillingMode,
        gcpLocation: activeGcpLocation,
        channelId: activeChannelId
      };
  const displayModels = (activeAccObj && activeChannelId !== detectedChannelId && activeAccObj.cachedQuota?.availableModels?.length > 0)
    ? activeAccObj.cachedQuota.availableModels
    : (availableModels.length > 0 ? availableModels : (activeAccObj?.cachedQuota?.availableModels || []));
  const displayQuotaGroups = (activeAccObj && activeChannelId !== detectedChannelId && activeAccObj.cachedQuota?.quotaGroups)
    ? activeAccObj.cachedQuota.quotaGroups
    : quotaGroups;
  writeRelayConfig(cfg);

  const channelList = Object.values(cfg.accounts || {})
    .map(({ storedToken, ...rest }) => rest)
    .sort((a, b) => {
      if (a.email !== b.email) return a.email.localeCompare(b.email);
      if (a.channelType !== b.channelType) return a.channelType === "personal" ? -1 : 1;
      return (a.gcpProjectId || "").localeCompare(b.gcpProjectId || "");
    });

  const telemetry = await computeSessionTelemetrySnapshot(cfg, ctx);
  const instanceStatus = inspectActiveFieldInstances(cfg, ctx);

  return {
    lsOnline: Boolean(ls && userStatusResp),
    lsPid: ls?.pid || 0,
    lsPort: ls?.port || 0,
    instance: instanceStatus,
    activeAccount: displayAccount,
    availableModels: displayModels,
    quotaGroups: displayQuotaGroups,
    accounts: channelList,
    oauthEmails: Object.keys(cfg.__meta__?.oauthTokensByEmail || {}),
    gcpProjects: cfg.gcpProjects || [],
    routing: cfg.routing || {},
    oauthPending: hasActiveOAuthSession(),
    telemetry
  };
}

export async function switchBillingProjectInstant(projectId, opts = {}) {
  const ls = discoverLanguageServer(false) || discoverLanguageServer(true);
  const cleanId = (projectId || "").trim();
  const cfg = readRelayConfig();
  normalizeAccountChannels(cfg);
  const ctx = resolveCurrentInstanceContext();
  const fieldStatus = inspectActiveFieldInstances(cfg, ctx);
  if (cleanId && fieldStatus.otherGcpInstance) {
    throw new Error(`GCP 通道已在另一窗口 (${fieldStatus.otherGcpInstance.email}) 运行中，当前窗口固定为个人通道（可启用其他个人账号或使用算力路由）`);
  }
  if (!cleanId && fieldStatus.otherPersonalInstance) {
    throw new Error(`个人通道已在另一窗口 (${fieldStatus.otherPersonalInstance.email}) 运行中，当前窗口固定为 GCP 通道（可启用其他 GCP 通道或使用算力路由）`);
  }

  const cred = readWinCredToken(true) || readWinCredToken(false);
  const activeEmail = (cred?.id_token_email || cfg.__meta__?.activeEmail || "").trim();
  const existingGcp = cleanId && activeEmail ? cfg.accounts[`${activeEmail}#gcp:${cleanId}`] : null;
  const gcpBillingMode = cleanId
    ? (opts.gcpBillingMode || existingGcp?.gcpBillingMode || "agent_platform")
    : "";
  const gcpLocation = cleanId
    ? (["global", "us", "eu"].includes(opts.gcpLocation) ? opts.gcpLocation : (existingGcp?.gcpLocation || "global"))
    : "";
  const location = cleanId ? (gcpBillingMode === "agent_platform" ? gcpLocation : "") : "";

  if (cred) {
    const cleanedCred = buildCleanChannelToken(cred, cleanId, location);
    writeWinCredToken(cleanedCred);
  }

  cfg.__meta__.lastAppliedGcpProject = cleanId;

  if (cleanId && activeEmail) {
    if (!cfg.gcpProjects.includes(cleanId)) {
      cfg.gcpProjects.push(cleanId);
    }
    const gcpKey = `${activeEmail}#gcp:${cleanId}`;
    const existing = cfg.accounts[gcpKey];
    const baseToken = findStoredTokenForEmail(cfg, activeEmail, true) || cred;
    cfg.accounts[gcpKey] = {
      ...existing,
      id: gcpKey,
      alias: existing?.alias || `${activeEmail} (${cleanId})`,
      email: activeEmail,
      channelType: "gcp",
      tierName: gcpBillingMode === "gemini_enterprise" ? "Gemini Enterprise" : "Agent Platform",
      gcpProjectId: cleanId,
      gcpBillingMode,
      gcpLocation,
      projectName: existing?.projectName || cleanId,
      savedAt: existing?.savedAt || new Date().toISOString(),
      storedToken: baseToken
        ? buildCleanChannelToken(baseToken, cleanId, location)
        : existing?.storedToken || null
    };
  }
  writeRelayConfig(cfg);

  if (ls) {
    try {
      await callLsRpc(ls, "ValidateProject", { projectId: cleanId, location });
    } catch {
      try {
        await callLsRpc(ls, "ValidateProject", { projectId: cleanId });
      } catch {}
    }
  }

  return { projectId: cleanId, gcpBillingMode, gcpLocation };
}

export async function switchActiveGoogleAccount(accountId, opts = {}) {
  const rawId = String(accountId || "").trim();
  if (rawId.startsWith("ephemeral:")) {
    return routeChannelEphemeral(rawId.slice(10).trim());
  }
  if (rawId.startsWith("launch_instance:")) {
    return launchIsolatedAntigravityInstance(rawId.slice(16).trim());
  }
  const cfg = readRelayConfig();
  normalizeAccountChannels(cfg);
  const ctx = resolveCurrentInstanceContext();
  const instMeta = getInstanceMeta(cfg, ctx);
  const target = cfg.accounts?.[rawId];
  if (!target) {
    throw new Error(`未找到通道快照: ${rawId}`);
  }

  const prevIsGcp = Boolean(instMeta.lastAppliedGcpProject || (!ctx.isIsolatedInstance && cfg.__meta__?.lastAppliedGcpProject));
  const targetProject = (target.gcpProjectId || "").trim();
  const nextIsGcp = Boolean(targetProject);
  const isCrossChannel = prevIsGcp !== nextIsGcp;

  const fieldStatus = inspectActiveFieldInstances(cfg, ctx);
  if (isCrossChannel) {
    if (nextIsGcp && fieldStatus.otherGcpInstance) {
      throw new Error(`GCP 通道已在另一窗口 (${fieldStatus.otherGcpInstance.email}) 运行中，当前窗口固定为个人通道（可启用其他个人账号或配置算力路由）`);
    }
    if (!nextIsGcp && fieldStatus.otherPersonalInstance) {
      throw new Error(`个人通道已在另一窗口 (${fieldStatus.otherPersonalInstance.email}) 运行中，当前窗口固定为 GCP 通道（可启用其他 GCP 通道或配置算力路由）`);
    }
  }

  const targetBillingMode = targetProject ? (target.gcpBillingMode || "agent_platform") : "";
  const targetLocation = targetProject
    ? (targetBillingMode === "agent_platform" ? (target.gcpLocation || "global") : "")
    : "";

  const baseToken = target.storedToken || findStoredTokenForEmail(cfg, target.email, Boolean(targetProject));
  if (!baseToken) {
    throw new Error(`未找到账号 ${target.email} 的凭据快照`);
  }

  if (baseToken.token?.refresh_token) {
    try {
      const rt = baseToken.token.refresh_token;
      const refreshed = await refreshOAuthAccessToken(rt);
      if (refreshed && refreshed.access_token) {
        const newExpiry = new Date(Date.now() + (refreshed.expires_in || 3599) * 1000).toISOString();
        baseToken.token.access_token = refreshed.access_token;
        baseToken.token.refreshedForRt = rt;
        baseToken.token.expiry = newExpiry;
        for (const item of Object.values(cfg.accounts || {})) {
          if (item.storedToken?.token?.refresh_token === rt) {
            item.storedToken.token.access_token = refreshed.access_token;
            item.storedToken.token.refreshedForRt = rt;
            item.storedToken.token.expiry = newExpiry;
          }
        }
      }
    } catch {}
  }

  const anyOtherInstanceHasGcp = Boolean(
    fieldStatus.otherGcpInstance ||
    Object.entries(cfg.__meta__?.instances || {}).some(
      ([instKey, m]) => instKey !== ctx.instanceId && Boolean(m?.lastAppliedGcpProject)
    )
  );

  // 当处于多开独立窗口或另一窗口正在运行 GCP 通道时，切换到个人通道绝不修改全局 WinCred（避免踢掉 GCP 主窗口的 LS），全权由本窗口专属 CloudCode 代理热切换
  const shouldKeepWinCredForOtherInstance = Boolean(!nextIsGcp && (ctx.isIsolatedInstance || anyOtherInstanceHasGcp));
  const tokenToWrite = buildCleanChannelToken(baseToken, targetProject, targetLocation, !shouldKeepWinCredForOtherInstance);
  target.storedToken = tokenToWrite;
  if (!shouldKeepWinCredForOtherInstance) {
    writeWinCredToken(tokenToWrite);
  }

  const nowTs = Date.now();
  instMeta.activeChannelId = target.id;
  instMeta.activeEmail = target.email;
  instMeta.lastAppliedGcpProject = targetProject;
  instMeta.switchedAt = nowTs;
  instMeta.switchedViaPanel = true;
  if (ctx.isIsolatedInstance && ctx.userDataDir) {
    writeInstanceDescriptor(ctx.userDataDir, {
      instanceId: ctx.instanceId,
      activeChannelId: target.id,
      email: target.email,
      gcpProjectId: targetProject,
      userDataDir: ctx.userDataDir,
      launchedAt: instMeta.seededLaunchAt || nowTs
    });
  } else {
    cfg.__meta__.activeChannelId = target.id;
    cfg.__meta__.activeEmail = target.email;
    cfg.__meta__.lastAppliedGcpProject = targetProject;
  }
  cfg.__meta__.lastRoutedChannelId = target.id;
  cfg.__meta__.convLastChannelMap = {};
  writeRelayConfig(cfg);

  // 若切换到个人号，确保其配额与模型快照立刻就绪，使前端 0ms 无需手动刷新即可呈现完整配额条
  if (!targetProject) {
    const cachedAt = Number(target.cachedQuota?.updatedAt || 0);
    if (!target.cachedQuota?.quotaGroups?.length || Date.now() - cachedAt > 20000) {
      await probeChannelQuotaSnapshot(target.id).catch(() => {});
    }
  }

  const currentLs = discoverLanguageServer(false);
  const shouldScrub = opts.scrubSignatures === true || (isCrossChannel && opts.scrubSignatures !== false);
  let scrubbedCount = 0;
  if (shouldScrub) {
    const scrubbedIds = await scrubRecentConversationsSignatures(currentLs).catch(() => []);
    scrubbedCount = Array.isArray(scrubbedIds) ? scrubbedIds.length : 0;
  }
  scheduleDetachedLanguageServerRestart(
    shouldKeepWinCredForOtherInstance ? null : tokenToWrite,
    currentLs,
    Boolean(targetProject),
    getActiveCloudCodeProxyUrl(cfg)
  );

  return {
    switchedTo: target.email,
    gcpProjectId: targetProject,
    channelId: target.id,
    isCrossChannel,
    scrubbedSignatures: shouldScrub,
    scrubbedCount,
    instant: false
  };
}
