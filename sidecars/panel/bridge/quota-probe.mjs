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
  stripModelVariantSuffix,
  deriveCloudCodeSlugFromLabel,
  ensureDynamicModelRegistry,
  learnModelsFromCloudCodeResponse,
  learnModelsFromLsClientConfigs,
  mergeNativeCatalogIntoPersonalModels,
  resolveFamilyForCloudSlug,
  isGcpOnlyModel,
  isArgonGatedLabelOrId,
  isGuessedOrchestratorSlug,
  extractOrchestratorTarget,
  isOrchestratorModelLabelOrId,
  resolveUnderlyingModelFamilyForOrchestrator,
  findQuotaGroupForModel,
  learnObservedWireSlugForFamily,
  isModelEntryRestrictedOrSunset,
  detectPersonalAccountTier,
  PERSONAL_TIER_KEYS,
  parseTierRouteSpec,
  getPersonalAccountTierKey,
  detectPaidProRestrictionFromModels,
  syncPersonalSubTiers,
  buildProModelsFromQuotaGroups,
  isValidOfficialQuotaGroup,
  sanitizeCachedQuotaModels,
  normalizeAccountChannels,
  findStoredTokenForEmail,
  findFirstGcpProjectForEmail,
  isInternalConsumerPoolProject,
  isDowngradedConsumerPoolProject,
  resolvePersonalCompanionProjectId,
  normalizePersonalQuotaPool,
  parseCloudCodeApiError
} from "./channel-catalog.mjs";
import {
  getActivePersonalQuotaPool,
  getCloudCodeHostnameForPool,
  callCloudCodeApi,
  discoverGcpProjectsForAccount,
  parseCloudCodeModelsAndQuota
} from "./cloudcode-discovery.mjs";

export {
  AGENT_PLATFORM_DEFAULT_MODELS,
  isLegacyDeprecatedModel,
  stripModelVariantSuffix,
  deriveCloudCodeSlugFromLabel,
  ensureDynamicModelRegistry,
  learnModelsFromCloudCodeResponse,
  learnModelsFromLsClientConfigs,
  mergeNativeCatalogIntoPersonalModels,
  resolveFamilyForCloudSlug,
  isGcpOnlyModel,
  isArgonGatedLabelOrId,
  isGuessedOrchestratorSlug,
  extractOrchestratorTarget,
  isOrchestratorModelLabelOrId,
  resolveUnderlyingModelFamilyForOrchestrator,
  findQuotaGroupForModel,
  learnObservedWireSlugForFamily,
  isModelEntryRestrictedOrSunset,
  detectPersonalAccountTier,
  PERSONAL_TIER_KEYS,
  parseTierRouteSpec,
  getPersonalAccountTierKey,
  detectPaidProRestrictionFromModels,
  syncPersonalSubTiers,
  buildProModelsFromQuotaGroups,
  isValidOfficialQuotaGroup,
  sanitizeCachedQuotaModels,
  normalizeAccountChannels,
  findStoredTokenForEmail,
  findFirstGcpProjectForEmail,
  isInternalConsumerPoolProject,
  isDowngradedConsumerPoolProject,
  resolvePersonalCompanionProjectId,
  normalizePersonalQuotaPool,
  parseCloudCodeApiError,
  getDetectedClientVersion,
  getCloudCodeUserAgent,
  buildLoadCodeAssistMetadata,
  getActivePersonalQuotaPool,
  getCloudCodeHostnameForPool,
  callCloudCodeApi,
  discoverGcpProjectsForAccount,
  parseCloudCodeModelsAndQuota
};

const probeDiagnosticByChannel = new Map();

export function getLastProbeDiagnostic(channelId) {
  return probeDiagnosticByChannel.get(String(channelId || "").trim()) || null;
}

function persistRefreshedPersonalTokens(cfg, acc, baseToken, isGcp) {
  if (!cfg || !acc || !baseToken?.token?.access_token) return;
  const cleanTok = isGcp
    ? buildCleanChannelToken(baseToken, (acc.gcpProjectId || "").trim(), acc.gcpLocation || "global", false, acc.gcpBillingMode || "agent_platform")
    : buildCleanChannelToken(baseToken, "", "", false);
  acc.authExpired = false;
  acc.storedToken = cleanTok;
  if (!cfg.__meta__.channelTokensById || typeof cfg.__meta__.channelTokensById !== "object") {
    cfg.__meta__.channelTokensById = {};
  }
  cfg.__meta__.channelTokensById[acc.id] = JSON.parse(JSON.stringify(cleanTok));
  if (!isGcp && acc.email) {
    if (!cfg.__meta__.oauthTokensByEmail || typeof cfg.__meta__.oauthTokensByEmail !== "object") {
      cfg.__meta__.oauthTokensByEmail = {};
    }
    cfg.__meta__.oauthTokensByEmail[acc.email] = JSON.parse(JSON.stringify(cleanTok));
  } else if (isGcp && acc.email) {
    if (!cfg.__meta__.gcpOAuthTokensByEmail || typeof cfg.__meta__.gcpOAuthTokensByEmail !== "object") {
      cfg.__meta__.gcpOAuthTokensByEmail = {};
    }
    cfg.__meta__.gcpOAuthTokensByEmail[acc.email] = JSON.parse(JSON.stringify(cleanTok));
  }
  writeRelayConfig(cfg);
}

export async function probeChannelQuotaSnapshot(channelId) {
  const cfg = readRelayConfig();
  normalizeAccountChannels(cfg);
  const acc = cfg.accounts?.[channelId];
  if (!acc) return null;

  const isGcp = acc.channelType === "gcp" || Boolean(acc.gcpProjectId);
  const gcpPid = (acc.gcpProjectId || "").trim();
  const gcpBillingMode = isGcp ? (acc.gcpBillingMode || "agent_platform") : "";

  const ctx = resolveCurrentInstanceContext();
  const instMeta = getInstanceMeta(cfg, ctx);
  const activeEmail = (instMeta?.activeEmail || cfg.__meta__?.activeEmail || "").trim();
  const originalGcpPid = String(
    instMeta?.lastAppliedGcpProject ??
    (!ctx.isIsolatedInstance ? cfg.__meta__?.lastAppliedGcpProject : "") ??
    ""
  ).trim();

  // 仅当探测当前在线 GCP 通道时优先复用本地 language_server_rpc；
  // 个人通道一律使用该账号自身的独立 OAuth Token 直连上游，彻底隔绝本地代理或切号瞬态缓存
  if (isGcp && acc.email && acc.email === activeEmail && gcpPid === originalGcpPid) {
    const ls = discoverLanguageServer(false);
    if (ls) {
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
          learnModelsFromLsClientConfigs(cfg, clientModels);
          const groupedMap = new Map();
          for (const m of clientModels) {
            if (isModelEntryRestrictedOrSunset(m)) continue;
            const rawLabel = (m.label || "").trim();
            const modelId = m.modelOrAlias?.model || m.modelOrAlias?.alias || "";
            if (!rawLabel || !modelId) continue;
            const baseLabel = stripModelVariantSuffix(rawLabel);
            if (isLegacyDeprecatedModel(baseLabel) || isLegacyDeprecatedModel(rawLabel)) continue;
            const rawWireSlug = String(m.modelId || "").trim();
            const wireSlug = (rawWireSlug && !/disabled$/i.test(rawWireSlug) && !/^model_(placeholder|openai)_/i.test(rawWireSlug))
              ? rawWireSlug
              : "";
            if (!groupedMap.has(baseLabel)) {
              const initVars = [baseLabel, rawLabel, modelId];
              if (wireSlug && !initVars.includes(wireSlug)) initVars.push(wireSlug);
              groupedMap.set(baseLabel, {
                label: baseLabel,
                modelId: baseLabel,
                variantIds: initVars,
                remainingPct: 100,
                resetTime: "",
                unlimited: true
              });
            } else {
              const entry = groupedMap.get(baseLabel);
              if (!entry.variantIds.includes(rawLabel)) entry.variantIds.push(rawLabel);
              if (!entry.variantIds.includes(modelId)) entry.variantIds.push(modelId);
              if (wireSlug && !entry.variantIds.includes(wireSlug)) entry.variantIds.push(wireSlug);
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
  }

  const liveTierTemplate = cfg.__meta__?.liveTierModels?.[isGcp ? "gcp" : "personal"] || [];

  const isGcpTokenObj = (tok) => Boolean(tok && (tok.project_id || tok.auth_method === "gcp" || tok.auth_method === "adc"));
  const candidateTokenObjs = [];
  const seenRtSet = new Set();
  const pushCandidateToken = (tokObj) => {
    if (!tokObj || !tokObj.token) return;
    if (!isGcp && isGcpTokenObj(tokObj)) return;
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
    if (candidateTokenObjs.length === 0) {
      const winCred = readWinCredToken(false);
      if (winCred && winCred.id_token_email === acc.email && !isGcpTokenObj(winCred)) {
        pushCandidateToken(winCred);
      }
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

  const PROD_HOSTNAME = "cloudcode-pa.googleapis.com";
  const DAILY_HOSTNAME = "daily-cloudcode-pa.googleapis.com";

  const tryProbeSinglePersonalPool = async (tok, companionPid, hostName) => {
    const reqPayload = companionPid ? { project: companionPid } : {};
    let [modelsResp, quotaSummaryResp] = await Promise.all([
      callCloudCodeApi("/v1internal:fetchAvailableModels", tok, reqPayload, {}, hostName),
      callCloudCodeApi("/v1internal:retrieveUserQuotaSummary", tok, reqPayload, {}, hostName)
    ]);
    if ((!modelsResp?.data?.models || modelsResp.status !== 200) && companionPid) {
      const fallbackModels = await callCloudCodeApi("/v1internal:fetchAvailableModels", tok, {}, {}, hostName);
      if (fallbackModels?.status === 200 && fallbackModels?.data?.models) {
        modelsResp = fallbackModels;
      }
    }
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
      : resolvePersonalCompanionProjectId(cfg, acc.email, acc.companionProjectId);
    const loadPayload = {
      metadata: buildLoadCodeAssistMetadata(isGcp ? gcpPid : "")
    };
    if (isGcp && gcpPid) {
      loadPayload.cloudaicompanionProject = gcpPid;
    }
    let loadResp = await callCloudCodeApi("/v1internal:loadCodeAssist", tok, loadPayload, {}, PROD_HOSTNAME);
    let loadAltResp = null;
    if (!isGcp && (!loadResp || loadResp.status !== 200 || !loadResp.data)) {
      loadAltResp = await callCloudCodeApi("/v1internal:loadCodeAssist", tok, loadPayload, {}, DAILY_HOSTNAME);
      if (loadAltResp && loadAltResp.status === 200 && loadAltResp.data) {
        loadResp = loadAltResp;
      }
    }
    let userTier = "";
    let tierSourceConfirmed = false;
    let loadIneligibleInfo = null;
    if (loadResp && loadResp.status === 200 && loadResp.data) {
      if (!isGcp) {
        const loadedPid = String(
          loadResp.data.cloudaicompanionProject?.id ||
          loadResp.data.cloudaicompanionProject ||
          ""
        ).trim();
        if (loadedPid && !isDowngradedConsumerPoolProject(loadedPid)) {
          companionPid = resolvePersonalCompanionProjectId(cfg, acc.email, loadedPid);
        }
      }
      const hasPaidTier = Boolean(
        loadResp.data.paidTier &&
        (loadResp.data.paidTier.id || loadResp.data.paidTier.name)
      );
      const curTier = loadResp.data.currentTier || {};
      const pTier = hasPaidTier ? loadResp.data.paidTier : curTier;
      if (isGcp) {
        userTier = String(curTier.id || "standard-tier").trim();
      } else {
        const rawCombined = `${pTier.id || ""} ${pTier.name || ""}`.trim();
        if (rawCombined) {
          userTier = /\b(ultra|pro|plus|free)\b|g1-|standard-tier|free-tier/i.test(rawCombined)
            ? rawCombined
            : (!hasPaidTier ? `free-tier ${rawCombined}`.trim() : rawCombined);
        } else {
          userTier = "free-tier";
        }
        if (Array.isArray(loadResp.data.ineligibleTiers) && loadResp.data.ineligibleTiers.length > 0) {
          loadIneligibleInfo = parseCloudCodeApiError({ status: 403, data: loadResp.data }, "loadCodeAssist");
        }
      }
      tierSourceConfirmed = true;
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
        loadAltResp,
        loadIneligibleInfo,
        modelsResp,
        quotaSummaryResp: { status: 0, data: null },
        companionPid,
        userTier,
        tierSourceConfirmed,
        byPool: null
      };
    }

    const dailyProbe = await tryProbeSinglePersonalPool(tok, companionPid, DAILY_HOSTNAME);
    return {
      loadResp,
      loadAltResp,
      loadIneligibleInfo,
      modelsResp: dailyProbe.modelsResp,
      quotaSummaryResp: dailyProbe.quotaSummaryResp,
      companionPid,
      userTier,
      tierSourceConfirmed,
      byPool: {
        daily: dailyProbe
      }
    };
  };

  let sawAuthExpired = false;
  let sawValidToken = false;
  let lastValidGcpBaseToken = null;
  const diag = { channelId: acc.id, at: Date.now(), attempts: [], ok: false };
  const applyRefreshedToken = (baseToken, refreshToken, refreshed) => {
    const accessToken = refreshed.access_token;
    const expiryIso = new Date(Date.now() + (refreshed.expires_in || 3599) * 1000).toISOString();
    baseToken.token.access_token = accessToken;
    baseToken.token.refreshedForRt = refreshToken;
    baseToken.token.expiry = expiryIso;
    for (const item of Object.values(cfg.accounts || {})) {
      const itemIsGcp = Boolean(item.gcpProjectId || item.channelType === "gcp");
      if (itemIsGcp === isGcp && item.storedToken?.token?.refresh_token === refreshToken) {
        item.storedToken.token.access_token = accessToken;
        item.storedToken.token.refreshedForRt = refreshToken;
        item.storedToken.token.expiry = expiryIso;
      }
    }
    return accessToken;
  };

  for (const baseToken of candidateTokenObjs) {
    let accessToken = baseToken.token.access_token || "";
    const refreshToken = baseToken.token.refresh_token || "";
    const expiryMs = baseToken.token.expiry ? new Date(baseToken.token.expiry).getTime() : 0;
    const attemptDiag = { refreshAttempted: false, refreshOk: false, refreshError: "" };
    diag.attempts.push(attemptDiag);
    const needsImmediateRefresh = Boolean(
      refreshToken &&
      (!accessToken || baseToken.token.refreshedForRt !== refreshToken || (expiryMs > 0 && expiryMs - Date.now() < 300000))
    );
    if (needsImmediateRefresh) {
      attemptDiag.refreshAttempted = true;
      try {
        const refreshed = await refreshOAuthAccessToken(refreshToken);
        if (refreshed && refreshed.access_token) {
          sawValidToken = true;
          attemptDiag.refreshOk = true;
          accessToken = applyRefreshedToken(baseToken, refreshToken, refreshed);
        }
      } catch (err) {
        attemptDiag.refreshError = String(err?.message || err || "refresh_failed").slice(0, 260);
        if (err && err.isAuthExpired) sawAuthExpired = true;
      }
    }

    if (isGcp && gcpBillingMode === "agent_platform") {
      if (!accessToken && refreshToken) {
        attemptDiag.refreshAttempted = true;
        try {
          const refreshed = await refreshOAuthAccessToken(refreshToken);
          if (refreshed && refreshed.access_token) {
            sawValidToken = true;
            attemptDiag.refreshOk = true;
            accessToken = applyRefreshedToken(baseToken, refreshToken, refreshed);
          }
        } catch (err) {
          attemptDiag.refreshError = String(err?.message || err || "refresh_failed").slice(0, 260);
          if (err && err.isAuthExpired) sawAuthExpired = true;
        }
      }
      if (accessToken) {
        sawValidToken = true;
        lastValidGcpBaseToken = baseToken;
      } else {
        continue;
      }
    }

    let probeRes = await tryProbeWithToken(accessToken);
    const shouldReactiveRefresh = Boolean(
      refreshToken &&
      !attemptDiag.refreshAttempted &&
      (
        probeRes.modelsResp.status === 401 ||
        probeRes.modelsResp.status === 403 ||
        probeRes.loadResp?.status === 401 ||
        probeRes.loadResp?.status === 403 ||
        (!probeRes.modelsResp.data && probeRes.modelsResp.status <= 0)
      )
    );
    if (shouldReactiveRefresh) {
      attemptDiag.refreshAttempted = true;
      try {
        const refreshed = await refreshOAuthAccessToken(refreshToken);
        if (refreshed && refreshed.access_token) {
          sawValidToken = true;
          attemptDiag.refreshOk = true;
          accessToken = applyRefreshedToken(baseToken, refreshToken, refreshed);
          probeRes = await tryProbeWithToken(accessToken);
        }
      } catch (err) {
        attemptDiag.refreshError = String(err?.message || err || "refresh_failed").slice(0, 260);
        if (err && err.isAuthExpired) sawAuthExpired = true;
      }
    }

    const dailyModels = probeRes.byPool?.daily?.modelsResp || probeRes.modelsResp;
    const dailyQuota = probeRes.byPool?.daily?.quotaSummaryResp || probeRes.quotaSummaryResp;
    const loadErrObj = probeRes.loadResp?.status !== 200 ? parseCloudCodeApiError(probeRes.loadResp, "loadCodeAssist") : null;
    const loadAltErrObj = probeRes.loadAltResp && probeRes.loadAltResp.status !== 200
      ? parseCloudCodeApiError(probeRes.loadAltResp, "loadCodeAssist")
      : null;
    const modelsErrObj = dailyModels?.status !== 200 ? parseCloudCodeApiError(dailyModels, "fetchAvailableModels") : null;
    const quotaErrObj = dailyQuota?.status !== 200 ? parseCloudCodeApiError(dailyQuota, "retrieveUserQuotaSummary") : null;

    attemptDiag.loadTier = probeRes.userTier || "";
    attemptDiag.tierSourceConfirmed = Boolean(probeRes.tierSourceConfirmed);
    attemptDiag.companionPid = probeRes.companionPid || "";
    attemptDiag.loadStatus = probeRes.loadResp?.status || 0;
    attemptDiag.loadError = loadErrObj?.message || "";
    attemptDiag.loadErrorObj = loadErrObj;
    attemptDiag.loadAltErrorObj = loadAltErrObj;
    attemptDiag.loadIneligibleInfo = probeRes.loadIneligibleInfo || null;
    attemptDiag.modelsStatus = dailyModels?.status || 0;
    attemptDiag.modelsError = modelsErrObj?.message || "";
    attemptDiag.modelsErrorObj = modelsErrObj;
    attemptDiag.quotaStatus = dailyQuota?.status || 0;
    attemptDiag.quotaError = quotaErrObj?.message || "";
    attemptDiag.quotaErrorObj = quotaErrObj;

    if (!isGcp && probeRes.tierSourceConfirmed && probeRes.userTier) {
      const confirmedInfo = detectPersonalAccountTier(dailyModels?.data?.models || {}, probeRes.userTier, probeRes.userTier, undefined, "");
      if (confirmedInfo.tierCode && confirmedInfo.tierCode !== "Unknown") {
        const prevTierCode = String(acc.tierCode || acc.cachedQuota?.tierCode || "").trim();
        const tierChanged = Boolean(prevTierCode && prevTierCode !== "Unknown" && prevTierCode !== confirmedInfo.tierCode);
        acc.tierCode = confirmedInfo.tierCode;
        acc.tierName = confirmedInfo.tierName;
        acc.tierConfirmed = true;
        acc.tierRaw = probeRes.userTier;
        if (confirmedInfo.tierCode === "Pro") {
          if (typeof confirmedInfo.paidProRestricted === "boolean") {
            acc.paidProRestricted = confirmedInfo.paidProRestricted;
          }
          acc.tierSubCode = confirmedInfo.tierSubCode || "pro";
        } else {
          delete acc.tierSubCode;
          delete acc.paidProRestricted;
        }
        if (tierChanged) {
          // 账户真实等级发生变化（例如 Pro 过期降级为 Free）时，立即淘汰旧等级残留快照，绝不保留过期模型
          acc.cachedQuota = null;
          acc.cachedQuotaByPool = {};
        } else {
          for (const quotaTarget of [acc.cachedQuota, acc.cachedQuotaByPool?.daily]) {
            if (quotaTarget && typeof quotaTarget === "object") {
              quotaTarget.tierCode = confirmedInfo.tierCode;
              quotaTarget.tierName = confirmedInfo.tierName;
              quotaTarget.isPaidProOrUltra = confirmedInfo.isPaidProOrUltra;
              quotaTarget.hasArgonAccess = confirmedInfo.hasArgonAccess;
              if (confirmedInfo.tierCode === "Pro") {
                if (typeof confirmedInfo.paidProRestricted === "boolean") {
                  quotaTarget.paidProRestricted = confirmedInfo.paidProRestricted;
                }
                quotaTarget.tierSubCode = confirmedInfo.tierSubCode || "pro";
              } else {
                delete quotaTarget.tierSubCode;
                delete quotaTarget.paidProRestricted;
              }
            }
          }
        }
      }
    }

    if (!isGcp && probeRes.byPool?.daily?.modelsResp?.data) {
      learnModelsFromCloudCodeResponse(cfg, probeRes.byPool.daily.modelsResp.data);
      const nextByPool = {};
      const finalCompPid = resolvePersonalCompanionProjectId(cfg, acc.email, probeRes.companionPid || acc.companionProjectId);
      const poolData = probeRes.byPool.daily;
      const parsedPool = parseCloudCodeModelsAndQuota(
        poolData.modelsResp.data,
        poolData.quotaSummaryResp?.data || null,
        false,
        probeRes.userTier
      );
      const hasValidQuotaGroups = Boolean(
        parsedPool &&
        Array.isArray(parsedPool.quotaGroups) &&
        parsedPool.quotaGroups.length > 0
      );
      const hasValidModelsOnly = Boolean(
        !loadErrObj &&
        poolData.modelsResp?.status === 200 &&
        parsedPool &&
        Array.isArray(parsedPool.availableModels) &&
        parsedPool.availableModels.length > 0
      );
      if (parsedPool && (hasValidQuotaGroups || hasValidModelsOnly)) {
        parsedPool.pool = "daily";
        parsedPool.quotaPool = "daily";
        parsedPool.upstreamHostname = DAILY_HOSTNAME;
        parsedPool.companionProjectId = finalCompPid;
        nextByPool.daily = parsedPool;
      }
      const chosenPrimary = nextByPool.daily || null;
      if (chosenPrimary) {
        acc.companionProjectId = finalCompPid;
        acc.cachedQuotaByPool = nextByPool;
        acc.cachedQuota = chosenPrimary;
        delete acc.lastProbeError;
        delete acc.routeBlockedUntil;
        delete acc.routeBlockedReason;
        if (chosenPrimary.tierCode && chosenPrimary.tierCode !== "Unknown") {
          acc.tierCode = chosenPrimary.tierCode;
          acc.tierName = chosenPrimary.tierName || acc.tierName;
          acc.tierConfirmed = Boolean(probeRes.tierSourceConfirmed || acc.tierConfirmed || chosenPrimary.probedVia);
          if (probeRes.userTier) acc.tierRaw = probeRes.userTier;
          if (chosenPrimary.tierCode === "Pro") {
            if (typeof chosenPrimary.paidProRestricted === "boolean") {
              acc.paidProRestricted = chosenPrimary.paidProRestricted;
            }
            acc.tierSubCode = chosenPrimary.tierSubCode || "pro";
          } else {
            delete acc.tierSubCode;
            delete acc.paidProRestricted;
          }
        } else if (!acc.tierConfirmed) {
          acc.tierCode = "Unknown";
          acc.tierName = "Unknown";
        }
        syncPersonalSubTiers(cfg);
        persistRefreshedPersonalTokens(cfg, acc, baseToken, false);
        diag.ok = true;
        probeDiagnosticByChannel.set(acc.id, diag);
        return acc.cachedQuota;
      }
    } else if (probeRes.modelsResp.status === 200 && probeRes.modelsResp.data) {
      learnModelsFromCloudCodeResponse(cfg, probeRes.modelsResp.data);
      const parsed = parseCloudCodeModelsAndQuota(
        probeRes.modelsResp.data,
        probeRes.quotaSummaryResp?.data || null,
        isGcp,
        probeRes.userTier
      );
      if (parsed && isGcp && parsed.availableModels.length > 0) {
        acc.authExpired = false;
        acc.cachedQuota = parsed;
        delete acc.lastProbeError;
        delete acc.routeBlockedUntil;
        delete acc.routeBlockedReason;
        persistRefreshedPersonalTokens(cfg, acc, baseToken, true);
        diag.ok = true;
        probeDiagnosticByChannel.set(acc.id, diag);
        return acc.cachedQuota;
      }
    }
  }

  const lastAttempt = diag.attempts[diag.attempts.length - 1] || {};
  const refreshErrObj = lastAttempt.refreshError
    ? parseCloudCodeApiError({ status: sawAuthExpired ? 401 : 0, error: lastAttempt.refreshError }, "oauth_refresh")
    : null;
  const errCandidates = [
    lastAttempt.modelsErrorObj,
    lastAttempt.quotaErrorObj,
    refreshErrObj,
    lastAttempt.loadErrorObj,
    lastAttempt.loadAltErrorObj,
    lastAttempt.loadIneligibleInfo
  ].filter(Boolean);
  const primaryErr = errCandidates[0] || null;
  if (primaryErr?.message) {
    let mergedReason = primaryErr.reason || "";
    let mergedValidationUrl = primaryErr.validationUrl || "";
    let mergedDetail = primaryErr.detailMessage || "";
    const mergedLinks = [...(primaryErr.helpLinks || [])];
    for (const cand of errCandidates.slice(1)) {
      if (!mergedReason && cand.reason) mergedReason = cand.reason;
      if (!mergedValidationUrl && cand.validationUrl) mergedValidationUrl = cand.validationUrl;
      if (!mergedDetail && cand.detailMessage) mergedDetail = cand.detailMessage;
      for (const lnk of (cand.helpLinks || [])) {
        if (lnk?.url && !mergedLinks.some((x) => x.url === lnk.url)) mergedLinks.push(lnk);
      }
    }
    const mergedCategory = mergedValidationUrl && primaryErr.category === "upstream_error"
      ? "validation_required"
      : (primaryErr.category || "upstream_error");
    acc.lastProbeError = {
      at: Date.now(),
      status: Number(primaryErr.status || 0),
      apiStatus: primaryErr.apiStatus || "",
      reason: mergedReason,
      category: mergedCategory,
      endpoint: primaryErr.endpoint || "",
      message: primaryErr.message,
      detailMessage: mergedDetail,
      validationUrl: mergedValidationUrl,
      helpLinks: mergedLinks.slice(0, 4)
    };
    if (mergedCategory === "license_3501") {
      acc.routeBlockedUntil = Date.now() + 600000;
      acc.routeBlockedReason = "HTTP 403 (#3501)";
    } else if (mergedCategory === "validation_required") {
      acc.routeBlockedUntil = Date.now() + 600000;
      acc.routeBlockedReason = "HTTP 403 (VALIDATION_REQUIRED)";
    }
    if (sawAuthExpired && !sawValidToken) {
      acc.authExpired = true;
    }
    if (!isGcp && !acc.tierConfirmed && !acc.cachedQuota?.probedVia && !lastAttempt.tierSourceConfirmed) {
      acc.tierCode = "Unknown";
      acc.tierName = "Unknown";
    }
    writeRelayConfig(cfg);
  } else if (sawAuthExpired && !sawValidToken) {
    acc.authExpired = true;
    if (!isGcp && !acc.tierConfirmed && !acc.cachedQuota?.probedVia) {
      acc.tierCode = "Unknown";
      acc.tierName = "Unknown";
    }
    writeRelayConfig(cfg);
  }
  probeDiagnosticByChannel.set(acc.id, diag);

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
    if (lastValidGcpBaseToken) {
      persistRefreshedPersonalTokens(cfg, acc, lastValidGcpBaseToken, true);
    } else {
      writeRelayConfig(cfg);
    }
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
  const settled = await Promise.allSettled(
    channelIds.map(async (cid) => [cid, await probeChannelQuotaSnapshot(cid)])
  );
  for (let i = 0; i < settled.length; i++) {
    const cid = channelIds[i];
    const item = settled[i];
    if (item.status === "fulfilled") {
      results[cid] = item.value[1];
    } else {
      results[cid] = { error: item.reason?.message || "probe_failed" };
    }
  }
  return results;
}
