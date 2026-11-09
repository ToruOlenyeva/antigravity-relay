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
  writeInstanceTokenFile,
  readInstanceToken,
  writeInstanceCredentialAndAwaitSync,
  syncInstanceAppStorage,
  syncInstanceStateVscdb,
  buildCleanChannelToken,
  parseLsLogInfo,
  listRunningLanguageServerProcesses,
  inspectActiveFieldInstances,
  discoverLanguageServer,
  callLsRpc,
  refreshOAuthAccessToken
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
  probeAllChannelsQuotaSnapshot,
  normalizePersonalQuotaPool,
  getActivePersonalQuotaPool,
  getDetectedClientVersion
} from "./bridge/quota-probe.mjs";
import {
  hasActivePersonalRoutingConfig,
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
  reloadInstanceWorkbenchViaCdp,
  restartCurrentAntigravityInstance,
  cancelIsolatedOAuthFlow,
  startIsolatedOAuthFlow,
  hasActiveOAuthSession
} from "./bridge/oauth-launcher.mjs";

import {
  addOrUpdatePersonalChannelCard
} from "./bridge/channel-catalog.mjs";

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
  startIsolatedOAuthFlow,
  addOrUpdatePersonalChannelCard
};

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
      ? buildCleanChannelToken(
          baseToken,
          cleanPid,
          gcpBillingMode === "agent_platform" ? gcpLocation : "",
          false,
          gcpBillingMode
        )
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
  const cred = readInstanceToken(ctx, forceWinCred);
  const us = userStatusResp?.userStatus || {};
  const planStatus = us?.planStatus || {};
  const cascadeConfig = us?.cascadeModelConfigData || {};
  let clientModelConfigs = cascadeConfig?.clientModelConfigs || [];

  const lsEmail = (us.email || "").trim();
  const credEmail = (cred?.id_token_email || "").trim();
  const activeName = us.name || "";
  const rawTierName = us.userTier?.name || planStatus?.planInfo?.planName || "";
  const activeTierId = us.userTier?.id || "";

  const tierIndicatesGcp = /agent\s*platform|enterprise/i.test(rawTierName);
  const credPid = String(cred?.project_id || "").trim();
  let logPid = String(logInfo.lastProjectId || "").trim();
  const instPinnedId = String(instMeta.activeChannelId || "").trim();
  const instPinnedAcc = instPinnedId ? cfg.accounts?.[instPinnedId] : null;
  const recentlySwitched = Boolean(instMeta.switchedAt && Date.now() - Number(instMeta.switchedAt) < 15000);

  let activeEmail = "";
  let isLiveGcp = false;
  let activeGcpProject = "";

  if (ctx.isIsolatedInstance) {
    // 多开独立窗口：绝不使用已被还原回主窗口的全局 WinCred，严格以当前窗口专属描述符与 instMeta 中最新切换者为准
    const descId = String(ctx.descriptor?.activeChannelId || "").trim();
    const descAcc = descId ? cfg.accounts?.[descId] : null;
    const descTs = Math.max(Number(ctx.descriptor?.switchedAt || 0), Number(ctx.descriptor?.launchedAt || 0));
    const metaTs = Math.max(Number(instMeta.switchedAt || 0), Number(instMeta.seededLaunchAt || 0));
    const effectiveIsoAcc = (descAcc && descTs >= metaTs) ? descAcc : (instPinnedAcc || descAcc);
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
    // 主窗口：兼容面板切号重启后 LS 尚未收到 ValidateProject 时的项目状态恢复，以及用户原生重登与修改项目 ID
    const credIsGcpMethod = Boolean(cred && (cred.auth_method === "adc" || cred.auth_method === "gcp" || credPid));
    const lsActuallyGcp = Boolean(logPid || tierIndicatesGcp || credIsGcpMethod);
    const pinnedMatchesLs = Boolean(
      instPinnedAcc &&
      lsEmail &&
      lsEmail === instPinnedAcc.email &&
      (instMeta.switchedViaPanel ||
        (lsActuallyGcp === Boolean(instPinnedAcc.gcpProjectId) &&
          (!lsActuallyGcp || !logPid || logPid === instPinnedAcc.gcpProjectId)))
    );
    if (instPinnedAcc && (recentlySwitched || !lsEmail || pinnedMatchesLs)) {
      activeEmail = instPinnedAcc.email;
      isLiveGcp = instPinnedAcc.channelType === "gcp" || Boolean(instPinnedAcc.gcpProjectId);
      activeGcpProject = isLiveGcp ? (instPinnedAcc.gcpProjectId || logPid || credPid) : "";
    } else if (lsEmail) {
      instMeta.switchedViaPanel = false;
      activeEmail = lsEmail;
      isLiveGcp = lsActuallyGcp;
      activeGcpProject = isLiveGcp
        ? (logPid || credPid || instMeta.lastAppliedGcpProject || findFirstGcpProjectForEmail(cfg, activeEmail))
        : "";
    } else {
      activeEmail = credEmail || instMeta.activeEmail || cfg.__meta__?.activeEmail || "";
      if (cred) {
        isLiveGcp = Boolean(cred.auth_method === "adc" || cred.auth_method === "gcp" || credPid);
      } else if (instMeta.lastAppliedGcpProject || cfg.__meta__?.lastAppliedGcpProject) {
        isLiveGcp = true;
      }
      activeGcpProject = isLiveGcp
        ? (credPid || instMeta.lastAppliedGcpProject || cfg.__meta__?.lastAppliedGcpProject || findFirstGcpProjectForEmail(cfg, activeEmail))
        : "";
    }
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

  if (cred && credEmail && !isLiveGcp && cred.auth_method !== "gcp" && cred.auth_method !== "adc" && !credPid) {
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
    const credIsGcp = Boolean(cred && (cred.auth_method === "gcp" || cred.auth_method === "adc" || credPid));
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
        const rawGcpBase = existingGcp?.storedToken?.token?.refresh_token
          ? existingGcp.storedToken
          : matchingCred;
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
          storedToken: rawGcpBase
            ? buildCleanChannelToken(
                rawGcpBase,
                activeGcpProject,
                resolvedMode === "agent_platform" ? resolvedLoc : "",
                false,
                resolvedMode
              )
            : null
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

    const hasPersonalRouting = hasActivePersonalRoutingConfig(cfg);
    const desiredProxyMode = (!isLiveGcp && hasPersonalRouting) ? "local_proxy" : "direct";
    const localProxyUrl = getActiveCloudCodeProxyUrl(cfg);
    const directUpstreamUrl = isLiveGcp
      ? "https://cloudcode-pa.googleapis.com"
      : "https://daily-cloudcode-pa.googleapis.com";
    const targetUrl = desiredProxyMode === "local_proxy" ? localProxyUrl : directUpstreamUrl;
    if (desiredProxyMode === "local_proxy") {
      if (
        instMeta.cloudCodeProxyPid !== ls.pid ||
        instMeta.cloudCodeProxyMode !== "local_proxy" ||
        instMeta.cloudCodeProxyUrl !== targetUrl
      ) {
        await callLsRpc(ls, "SetCloudCodeURL", { url: targetUrl })
          .then(() => {
            instMeta.cloudCodeProxyPid = ls.pid;
            instMeta.cloudCodeProxyMode = "local_proxy";
            instMeta.cloudCodeProxyUrl = targetUrl;
            if (!ctx.isIsolatedInstance) {
              cfg.__meta__.cloudCodeProxyPid = ls.pid;
              cfg.__meta__.cloudCodeProxyMode = "local_proxy";
              cfg.__meta__.cloudCodeProxyUrl = targetUrl;
            }
          })
          .catch(() => {});
      }
    } else if (
      instMeta.cloudCodeProxyMode === "local_proxy" ||
      instMeta.cloudCodeProxyPid !== ls.pid ||
      instMeta.cloudCodeProxyUrl !== targetUrl
    ) {
      await callLsRpc(ls, "SetCloudCodeURL", { url: targetUrl })
        .then(() => {
          instMeta.cloudCodeProxyPid = ls.pid;
          instMeta.cloudCodeProxyMode = "direct";
          instMeta.cloudCodeProxyUrl = targetUrl;
          if (!ctx.isIsolatedInstance) {
            cfg.__meta__.cloudCodeProxyPid = ls.pid;
            cfg.__meta__.cloudCodeProxyMode = "direct";
            cfg.__meta__.cloudCodeProxyUrl = targetUrl;
          }
        })
        .catch(() => {});
    } else {
      instMeta.cloudCodeProxyPid = ls.pid;
      instMeta.cloudCodeProxyMode = "direct";
      instMeta.cloudCodeProxyUrl = targetUrl;
      if (!ctx.isIsolatedInstance) {
        cfg.__meta__.cloudCodeProxyPid = ls.pid;
        cfg.__meta__.cloudCodeProxyMode = "direct";
        cfg.__meta__.cloudCodeProxyUrl = targetUrl;
      }
    }
  }

  let lsHasGcpModels = clientModelConfigs.some(
    (m) => !isModelEntryRestrictedOrSunset(m) && isGcpOnlyModel(m.label || m.modelOrAlias?.model || "")
  );
  if (
    ls &&
    isLiveGcp &&
    activeGcpProject &&
    activeGcpBillingMode === "agent_platform" &&
    (!lsHasGcpModels || logPid !== activeGcpProject || Boolean(logInfo.lastUserTier) || Boolean(cred?.user_tier) || cred?.auth_method !== "adc") &&
    instMeta.lastValidateProjectPid !== ls.pid
  ) {
    instMeta.lastValidateProjectPid = ls.pid;
    try {
      if (cred && (cred.user_tier || cred.tier_display_name || cred.auth_method !== "adc" || cred.project_id !== activeGcpProject)) {
        const healedTok = buildCleanChannelToken(
          cred,
          activeGcpProject,
          activeGcpLocation || "global",
          false,
          "agent_platform"
        );
        if (ctx.isIsolatedInstance && ctx.userDataDir) {
          writeInstanceTokenFile(ctx.userDataDir, healedTok);
        } else {
          writeWinCredToken(healedTok);
        }
      }
      await callLsRpc(ls, "ValidateProject", {
        projectId: activeGcpProject,
        location: activeGcpLocation || "global"
      }).catch(() =>
        callLsRpc(ls, "ValidateProject", { projectId: activeGcpProject }).catch(() => {})
      );
      logPid = activeGcpProject;
      const refreshedStatus = await callLsRpc(ls, "GetUserStatus", {}).catch(() => null);
      const refreshedModels = refreshedStatus?.userStatus?.cascadeModelConfigData?.clientModelConfigs;
      if (Array.isArray(refreshedModels) && refreshedModels.length > 0) {
        userStatusResp = refreshedStatus;
        clientModelConfigs = refreshedModels;
        lsHasGcpModels = clientModelConfigs.some(
          (m) => !isModelEntryRestrictedOrSunset(m) && isGcpOnlyModel(m.label || m.modelOrAlias?.model || "")
        );
      }
    } catch {}
  }
  const lsModeMatches = Boolean(
    lsEmail &&
    lsEmail === activeEmail &&
    (activeGcpProject
      ? (logPid ? logPid === activeGcpProject : Boolean(tierIndicatesGcp || lsHasGcpModels))
      : (!logPid && !tierIndicatesGcp))
  );
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
  if (
    activeGcpProject &&
    activeGcpBillingMode === "agent_platform" &&
    (availableModels.length === 0 || !availableModels.some((m) => isGcpOnlyModel(m.label || m.modelId || "")))
  ) {
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

  if (availableModels.length > 0 && effectiveClientModels.length > 0 && activeGcpProject && lsHasGcpModels) {
    if (!cfg.__meta__.liveTierModels || typeof cfg.__meta__.liveTierModels !== "object") {
      cfg.__meta__.liveTierModels = {};
    }
    cfg.__meta__.liveTierModels.gcp = availableModels.map((m) => ({
      label: m.label,
      modelId: m.modelId,
      variantIds: [...(m.variantIds || [m.label])]
    }));
  }

  if (activeGcpProject && detectedChannelId && cfg.accounts[detectedChannelId]) {
    cfg.accounts[detectedChannelId].cachedQuota = {
      tierCode: liveTierInfo.tierCode,
      tierName: liveTierInfo.tierName,
      hasArgonAccess: hasLiveArgonAccess,
      isPaidProOrUltra: isLivePaidProOrUltra,
      isGcpUnlimited: true,
      quotaGroups: [],
      availableModels: availableModels.length > 0
        ? availableModels
        : (cfg.accounts[detectedChannelId].cachedQuota?.availableModels || []),
      probedVia: "language_server_rpc",
      updatedAt: Date.now()
    };
  }
  const activePool = getActivePersonalQuotaPool(cfg);
  if (!activeGcpProject && detectedChannelId && cfg.accounts[detectedChannelId]) {
    let detCached = cfg.accounts[detectedChannelId].cachedQuota;
    const poolMatchedSnapshot = cfg.accounts[detectedChannelId].cachedQuotaByPool?.[activePool];
    if (poolMatchedSnapshot?.quotaGroups?.length) {
      detCached = poolMatchedSnapshot;
      cfg.accounts[detectedChannelId].cachedQuota = poolMatchedSnapshot;
    }
    const detCachedPool = detCached?.pool || detCached?.quotaPool || "";
    const detCachedAt = Number(detCached?.updatedAt || 0);
    if (
      forceWinCred ||
      detCached?.probedVia !== "cloudcode_http" ||
      !detCached?.quotaGroups?.length ||
      (detCachedPool && detCachedPool !== activePool) ||
      !cfg.accounts[detectedChannelId].companionProjectId ||
      (Date.now() - detCachedAt > 45000)
    ) {
      await probeChannelQuotaSnapshot(detectedChannelId).catch(() => {});
      const freshCfg = readRelayConfig();
      const freshAcc = freshCfg?.accounts?.[detectedChannelId];
      const probed = freshAcc?.cachedQuotaByPool?.[activePool] || freshAcc?.cachedQuota;
      if (freshAcc) {
        if (freshAcc.companionProjectId) {
          cfg.accounts[detectedChannelId].companionProjectId = freshAcc.companionProjectId;
        }
        if (freshAcc.cachedQuotaByPool) {
          cfg.accounts[detectedChannelId].cachedQuotaByPool = freshAcc.cachedQuotaByPool;
        }
      }
      if (probed) {
        cfg.accounts[detectedChannelId].cachedQuota = probed;
        if (Array.isArray(probed.quotaGroups) && probed.quotaGroups.length > 0) {
          quotaGroups = probed.quotaGroups;
        }
        if (Array.isArray(probed.availableModels) && probed.availableModels.length > 0) {
          availableModels = probed.availableModels;
        }
      }
    } else {
      quotaGroups = detCached.quotaGroups;
      if (Array.isArray(detCached.availableModels) && detCached.availableModels.length > 0) {
        availableModels = detCached.availableModels;
      }
    }
  }
  if (activeChannelId && activeChannelId !== detectedChannelId && cfg.accounts[activeChannelId]) {
    const activeIsGcp = Boolean(cfg.accounts[activeChannelId].gcpProjectId || cfg.accounts[activeChannelId].channelType === "gcp");
    if (!activeIsGcp && cfg.accounts[activeChannelId].cachedQuotaByPool?.[activePool]?.quotaGroups?.length) {
      cfg.accounts[activeChannelId].cachedQuota = cfg.accounts[activeChannelId].cachedQuotaByPool[activePool];
    }
    const cachedAt = Number(cfg.accounts[activeChannelId].cachedQuota?.updatedAt || 0);
    const cachedPool = cfg.accounts[activeChannelId].cachedQuota?.pool || cfg.accounts[activeChannelId].cachedQuota?.quotaPool || "";
    if (
      forceWinCred ||
      !cfg.accounts[activeChannelId].cachedQuota?.quotaGroups?.length ||
      (!activeIsGcp && ((cachedPool && cachedPool !== activePool) || !cfg.accounts[activeChannelId].companionProjectId)) ||
      (Date.now() - cachedAt > 45000)
    ) {
      await probeChannelQuotaSnapshot(activeChannelId).catch(() => {});
      const freshCfg = readRelayConfig();
      const freshActive = freshCfg?.accounts?.[activeChannelId];
      if (freshActive) {
        if (freshActive.companionProjectId) {
          cfg.accounts[activeChannelId].companionProjectId = freshActive.companionProjectId;
        }
        if (freshActive.cachedQuotaByPool) {
          cfg.accounts[activeChannelId].cachedQuotaByPool = freshActive.cachedQuotaByPool;
        }
        const activeProbed = (!activeIsGcp && freshActive.cachedQuotaByPool?.[activePool]) || freshActive.cachedQuota;
        if (activeProbed) {
          cfg.accounts[activeChannelId].cachedQuota = activeProbed;
        }
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

  const telemetry = await computeSessionTelemetrySnapshot(cfg, ctx, Boolean(displayAccount?.gcpProjectId));
  const instanceStatus = inspectActiveFieldInstances(cfg, ctx);

  return {
    lsOnline: Boolean(ls && userStatusResp),
    lsPid: ls?.pid || 0,
    lsPort: ls?.port || 0,
    clientVersion: getDetectedClientVersion(ctx.lsLogFile),
    personalQuotaPool: getActivePersonalQuotaPool(cfg),
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

export async function switchPersonalQuotaPool(targetPool) {
  const pool = normalizePersonalQuotaPool(targetPool);
  const cfg = readRelayConfig();
  if (!cfg.routing || typeof cfg.routing !== "object") {
    cfg.routing = {};
  }
  cfg.routing.personalQuotaPool = pool;
  normalizeAccountChannels(cfg);
  writeRelayConfig(cfg);

  const missingPoolIds = Object.values(cfg.accounts || {})
    .filter((acc) => acc && acc.channelType !== "gcp" && !acc.gcpProjectId && !acc.cachedQuotaByPool?.[pool]?.quotaGroups?.length)
    .map((acc) => acc.id);
  for (const cid of missingPoolIds) {
    await probeChannelQuotaSnapshot(cid).catch(() => {});
  }
  return { personalQuotaPool: pool };
}

export async function switchBillingProjectInstant(projectId, opts = {}) {
  const ls = discoverLanguageServer(false) || discoverLanguageServer(true);
  const cleanId = (projectId || "").trim();
  const cfg = readRelayConfig();
  normalizeAccountChannels(cfg);
  const ctx = resolveCurrentInstanceContext();
  const fieldStatus = inspectActiveFieldInstances(cfg, ctx);
  if (cleanId && fieldStatus.otherGcpInstance) {
    throw new Error(`GCP 通道已在另一实例 (${fieldStatus.otherGcpInstance.email}) 运行中，当前实例固定为个人通道（可启用其他个人账号或使用算力路由）`);
  }
  if (!cleanId && fieldStatus.otherPersonalInstance) {
    throw new Error(`个人通道已在另一实例 (${fieldStatus.otherPersonalInstance.email}) 运行中，当前实例固定为 GCP 通道（可启用其他 GCP 通道或使用算力路由）`);
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
    const cleanedCred = buildCleanChannelToken(cred, cleanId, location, false, gcpBillingMode);
    if (ctx.isIsolatedInstance && ctx.userDataDir) {
      writeInstanceTokenFile(ctx.userDataDir, cleanedCred);
    } else {
      writeWinCredToken(cleanedCred);
    }
    syncInstanceAppStorage(
      ctx.userDataDir,
      activeEmail,
      Boolean(cleanId),
      Boolean(ctx.isIsolatedInstance),
      cleanId,
      gcpBillingMode,
      gcpLocation
    );
    syncInstanceStateVscdb(ctx.userDataDir, cleanedCred, activeEmail, cleanId);
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
        ? buildCleanChannelToken(baseToken, cleanId, location, false, gcpBillingMode)
        : existing?.storedToken || null
    };
  }
  writeRelayConfig(cfg);

  if (ls && cleanId) {
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
      throw new Error(`GCP 通道已在另一实例 (${fieldStatus.otherGcpInstance.email}) 运行中，当前实例固定为个人通道（可启用其他个人账号或配置算力路由）`);
    }
    if (!nextIsGcp && fieldStatus.otherPersonalInstance) {
      throw new Error(`个人通道已在另一实例 (${fieldStatus.otherPersonalInstance.email}) 运行中，当前实例固定为 GCP 通道（可启用其他 GCP 通道或配置算力路由）`);
    }
  }

  const targetBillingMode = targetProject ? (target.gcpBillingMode || "agent_platform") : "";
  const targetLocation = targetProject
    ? (targetBillingMode === "agent_platform" ? (target.gcpLocation || "global") : "")
    : "";

  const rawBaseToken =
    cfg.__meta__?.channelTokensById?.[target.id] ||
    target.storedToken ||
    findStoredTokenForEmail(cfg, target.email, Boolean(targetProject));
  if (!rawBaseToken) {
    throw new Error(`未找到账号 ${target.email} 的凭据快照`);
  }
  const baseToken = JSON.parse(JSON.stringify(rawBaseToken));

  if (baseToken.token?.refresh_token) {
    try {
      const rt = baseToken.token.refresh_token;
      const refreshed = await refreshOAuthAccessToken(rt);
      if (refreshed && refreshed.access_token) {
        const newExpiry = new Date(Date.now() + (refreshed.expires_in || 3599) * 1000).toISOString();
        baseToken.token.access_token = refreshed.access_token;
        baseToken.token.refreshedForRt = rt;
        baseToken.token.expiry = newExpiry;
        target.authExpired = false;
      }
    } catch (err) {
      if (err && err.isAuthExpired) {
        target.authExpired = true;
        writeRelayConfig(cfg);
        startIsolatedOAuthFlow({
          channelType: targetProject ? "gcp" : "personal",
          gcpProjectId: targetProject,
          gcpBillingMode: targetBillingMode || "agent_platform",
          gcpLocation: targetLocation || "global",
          loginHint: target.email
        }).catch(() => {});
        throw new Error(`账号 ${target.email} 授权凭据已过期，已自动在浏览器拉起该账号重新登录，请完成授权后再点击启用`);
      }
    }
  }

  const currentLs = discoverLanguageServer(false);
  const hasPersonalRouting = hasActivePersonalRoutingConfig(cfg);
  const desiredProxyMode = (!targetProject && hasPersonalRouting) ? "local_proxy" : "direct";
  const localProxyUrl = getActiveCloudCodeProxyUrl(cfg);
  const directUpstreamUrl = targetProject
    ? "https://cloudcode-pa.googleapis.com"
    : "https://daily-cloudcode-pa.googleapis.com";
  const targetUrl = desiredProxyMode === "local_proxy" ? localProxyUrl : directUpstreamUrl;

  const tokenToWrite = buildCleanChannelToken(baseToken, targetProject, targetLocation, true, targetBillingMode);
  target.storedToken = tokenToWrite;
  if (!cfg.__meta__.channelTokensById || typeof cfg.__meta__.channelTokensById !== "object") {
    cfg.__meta__.channelTokensById = {};
  }
  cfg.__meta__.channelTokensById[target.id] = JSON.parse(JSON.stringify(tokenToWrite));

  const nowTs = Date.now();
  instMeta.activeChannelId = target.id;
  instMeta.activeEmail = target.email;
  instMeta.lastAppliedGcpProject = targetProject;
  instMeta.switchedAt = nowTs;
  instMeta.switchedViaPanel = true;
  if (ctx.isIsolatedInstance && ctx.userDataDir) {
    const updatedDesc = {
      ...(ctx.descriptor || {}),
      instanceId: ctx.instanceId,
      activeChannelId: target.id,
      email: target.email,
      gcpProjectId: targetProject,
      userDataDir: ctx.userDataDir,
      launchedAt: instMeta.seededLaunchAt || nowTs,
      switchedAt: nowTs
    };
    writeInstanceDescriptor(ctx.userDataDir, updatedDesc);
    ctx.descriptor = updatedDesc;
  } else {
    cfg.__meta__.activeChannelId = target.id;
    cfg.__meta__.activeEmail = target.email;
    cfg.__meta__.lastAppliedGcpProject = targetProject;
  }
  syncInstanceAppStorage(
    ctx.userDataDir,
    target.email,
    Boolean(targetProject),
    Boolean(ctx.isIsolatedInstance),
    targetProject,
    targetBillingMode,
    targetLocation
  );
  syncInstanceStateVscdb(
    ctx.userDataDir,
    tokenToWrite,
    target.email,
    targetProject
  );
  instMeta.cloudCodeProxyMode = desiredProxyMode;
  instMeta.cloudCodeProxyUrl = targetUrl;
  if (!ctx.isIsolatedInstance) {
    cfg.__meta__.cloudCodeProxyMode = instMeta.cloudCodeProxyMode;
    cfg.__meta__.cloudCodeProxyUrl = instMeta.cloudCodeProxyUrl;
  }
  cfg.__meta__.lastRoutedChannelId = target.id;
  cfg.__meta__.convLastChannelMap = {};
  writeRelayConfig(cfg);

  if (ctx.isIsolatedInstance && ctx.userDataDir) {
    writeInstanceTokenFile(ctx.userDataDir, tokenToWrite);
  } else {
    writeWinCredToken(tokenToWrite);
  }

  if (!targetProject) {
    const cachedAt = Number(target.cachedQuota?.updatedAt || 0);
    if (!target.cachedQuota?.quotaGroups?.length || Date.now() - cachedAt > 20000) {
      await probeChannelQuotaSnapshot(target.id).catch(() => {});
    }
  }

  const shouldScrub = opts.scrubSignatures === true || (isCrossChannel && opts.scrubSignatures !== false);
  let scrubbedCount = 0;
  if (shouldScrub) {
    const scrubbedIds = await scrubRecentConversationsSignatures(currentLs).catch(() => []);
    scrubbedCount = Array.isArray(scrubbedIds) ? scrubbedIds.length : 0;
  }

  const restartCtx = { ...ctx };
  await restartCurrentAntigravityInstance(restartCtx, {
    tokenObj: tokenToWrite,
    email: target.email,
    gcpProjectId: targetProject,
    lsPid: Number(currentLs?.pid || 0)
  }).catch(() => {});

  return {
    switchedTo: target.email,
    gcpProjectId: targetProject,
    channelId: target.id,
    isCrossChannel,
    scrubbedSignatures: shouldScrub,
    scrubbedCount,
    restarting: true,
    instant: false
  };
}
