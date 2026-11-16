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
    for (const item of Object.values(cfg.accounts || {})) {
      if (item.email === acc.email) pushCandidateToken(item.storedToken);
    }
    if (candidateTokenObjs.length === 0) {
      const winCred = readWinCredToken(false);
      if (winCred && winCred.id_token_email === acc.email && !winCred.project_id) {
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
  const diag = { channelId: acc.id, at: Date.now(), attempts: [], ok: false };
  const applyRefreshedToken = (baseToken, refreshToken, refreshed) => {
    const accessToken = refreshed.access_token;
    const expiryIso = new Date(Date.now() + (refreshed.expires_in || 3599) * 1000).toISOString();
    baseToken.token.access_token = accessToken;
    baseToken.token.refreshedForRt = refreshToken;
    baseToken.token.expiry = expiryIso;
    for (const item of Object.values(cfg.accounts || {})) {
      if (item.storedToken?.token?.refresh_token === refreshToken) {
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
          persistRefreshedPersonalTokens(cfg, acc, baseToken, isGcp);
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
        persistRefreshedPersonalTokens(cfg, acc, baseToken, true);
      } else {
        continue;
      }
    }

    let probeRes = await tryProbeWithToken(accessToken);
    if ((probeRes.modelsResp.status === 401 || probeRes.modelsResp.status === 403 || !probeRes.modelsResp.data) && refreshToken) {
      attemptDiag.refreshAttempted = true;
      try {
        const refreshed = await refreshOAuthAccessToken(refreshToken);
        if (refreshed && refreshed.access_token) {
          sawValidToken = true;
          attemptDiag.refreshOk = true;
          accessToken = applyRefreshedToken(baseToken, refreshToken, refreshed);
          persistRefreshedPersonalTokens(cfg, acc, baseToken, isGcp);
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
      const confirmedInfo = detectPersonalAccountTier(dailyModels?.data?.models || {}, probeRes.userTier, probeRes.userTier, acc.cachedQuota?.hasArgonAccess, "");
      if (confirmedInfo.tierCode && confirmedInfo.tierCode !== "Unknown") {
        acc.tierCode = confirmedInfo.tierCode;
        acc.tierName = confirmedInfo.tierName;
        acc.tierConfirmed = true;
        acc.tierRaw = probeRes.userTier;
        for (const quotaTarget of [acc.cachedQuota, acc.cachedQuotaByPool?.daily]) {
          if (quotaTarget && typeof quotaTarget === "object") {
            quotaTarget.tierCode = confirmedInfo.tierCode;
            quotaTarget.tierName = confirmedInfo.tierName;
            quotaTarget.isPaidProOrUltra = confirmedInfo.isPaidProOrUltra;
            quotaTarget.hasArgonAccess = confirmedInfo.hasArgonAccess;
          }
        }
      }
    }

    if (!isGcp && probeRes.byPool?.daily?.modelsResp?.data) {
      learnModelsFromCloudCodeResponse(cfg, probeRes.byPool.daily.modelsResp.data);
      const nextByPool = {};
      const finalCompPid = resolvePersonalCompanionProjectId(cfg, acc.email, probeRes.companionPid || acc.companionProjectId);
      const poolData = probeRes.byPool.daily;
      const prevPoolQuota = acc.cachedQuotaByPool?.daily || acc.cachedQuota || null;
      const hasPrevConfirmed = Boolean(acc.tierConfirmed || prevPoolQuota?.probedVia || prevPoolQuota?.quotaGroups?.length);
      const parsedPool = parseCloudCodeModelsAndQuota(
        poolData.modelsResp.data,
        poolData.quotaSummaryResp?.data || null,
        false,
        probeRes.userTier,
        hasPrevConfirmed ? prevPoolQuota : null,
        liveTierTemplate
      );
      if (parsedPool && Array.isArray(parsedPool.quotaGroups) && parsedPool.quotaGroups.length > 0) {
        parsedPool.pool = "daily";
        parsedPool.quotaPool = "daily";
        parsedPool.upstreamHostname = DAILY_HOSTNAME;
        parsedPool.companionProjectId = finalCompPid;
        nextByPool.daily = parsedPool;
      }
      const chosenPrimary = nextByPool.daily || null;
      if (chosenPrimary && Array.isArray(chosenPrimary.quotaGroups) && chosenPrimary.quotaGroups.length > 0) {
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
        } else if (!acc.tierConfirmed) {
          acc.tierCode = "Unknown";
          acc.tierName = "Unknown";
        }
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
        probeRes.userTier,
        acc.cachedQuota || null,
        liveTierTemplate
      );
      if (parsed && isGcp && parsed.availableModels.length > 0) {
        acc.authExpired = false;
        acc.cachedQuota = parsed;
        delete acc.lastProbeError;
        delete acc.routeBlockedUntil;
        delete acc.routeBlockedReason;
        writeRelayConfig(cfg);
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
