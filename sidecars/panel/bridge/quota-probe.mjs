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
  normalizeIsoExpiry,
  buildCleanChannelToken,
  discoverLanguageServer,
  callLsRpc,
  refreshOAuthAccessToken
} from "./wincred-ls.mjs";

export const AGENT_PLATFORM_DEFAULT_MODELS = [
  {
    label: "Gemini 4 Argon",
    modelId: "Gemini 4 Argon",
    variantIds: [
      "Gemini 4 Argon",
      "Gemini 4 Argon (Medium)",
      "MODEL_PLACEHOLDER_M418",
      "Gemini 4 Argon (High)",
      "MODEL_PLACEHOLDER_M417",
      "Gemini 4 Argon (Low)",
      "MODEL_PLACEHOLDER_M419"
    ],
    remainingPct: 100,
    resetTime: "",
    unlimited: true
  },
  {
    label: "Gemini 3.8 Flash",
    modelId: "Gemini 3.8 Flash",
    variantIds: [
      "Gemini 3.8 Flash",
      "Gemini 3.8 Flash (Medium)",
      "MODEL_PLACEHOLDER_M421",
      "Gemini 3.8 Flash (High)",
      "MODEL_PLACEHOLDER_M420",
      "Gemini 3.8 Flash (Low)",
      "MODEL_PLACEHOLDER_M422"
    ],
    remainingPct: 100,
    resetTime: "",
    unlimited: true
  },
  {
    label: "Gemini 3.7 Flash",
    modelId: "Gemini 3.7 Flash",
    variantIds: [
      "Gemini 3.7 Flash",
      "Gemini 3.7 Flash (Medium)",
      "MODEL_PLACEHOLDER_M62",
      "Gemini 3.7 Flash (High)",
      "MODEL_PLACEHOLDER_M55",
      "Gemini 3.7 Flash (Low)",
      "MODEL_PLACEHOLDER_M63"
    ],
    remainingPct: 100,
    resetTime: "",
    unlimited: true
  },
  {
    label: "Gemini 3.6 Flash",
    modelId: "Gemini 3.6 Flash",
    variantIds: [
      "Gemini 3.6 Flash",
      "Gemini 3.6 Flash (Medium)",
      "MODEL_PLACEHOLDER_M60",
      "Gemini 3.6 Flash (High)",
      "MODEL_PLACEHOLDER_M51",
      "Gemini 3.6 Flash (Low)",
      "MODEL_PLACEHOLDER_M61"
    ],
    remainingPct: 100,
    resetTime: "",
    unlimited: true
  },
  {
    label: "Gemini 3.1 Pro",
    modelId: "Gemini 3.1 Pro",
    variantIds: [
      "Gemini 3.1 Pro",
      "Gemini 3.1 Pro (High)",
      "MODEL_PLACEHOLDER_M37",
      "Gemini 3.1 Pro (Low)",
      "MODEL_PLACEHOLDER_M36"
    ],
    remainingPct: 100,
    resetTime: "",
    unlimited: true
  },
  {
    label: "Claude Opus 5.5",
    modelId: "Claude Opus 5.5",
    variantIds: [
      "Claude Opus 5.5",
      "Claude Opus 5.5 (Low)",
      "MODEL_PLACEHOLDER_M409",
      "Claude Opus 5.5 (Medium)",
      "MODEL_PLACEHOLDER_M410",
      "Claude Opus 5.5 (High)",
      "MODEL_PLACEHOLDER_M411",
      "Claude Opus 5.5 (Max)",
      "MODEL_PLACEHOLDER_M412"
    ],
    remainingPct: 100,
    resetTime: "",
    unlimited: true
  },
  {
    label: "Claude Sonnet 5.5",
    modelId: "Claude Sonnet 5.5",
    variantIds: [
      "Claude Sonnet 5.5",
      "Claude Sonnet 5.5 (Low)",
      "MODEL_PLACEHOLDER_M413",
      "Claude Sonnet 5.5 (Medium)",
      "MODEL_PLACEHOLDER_M414",
      "Claude Sonnet 5.5 (High)",
      "MODEL_PLACEHOLDER_M415",
      "Claude Sonnet 5.5 (Max)",
      "MODEL_PLACEHOLDER_M416"
    ],
    remainingPct: 100,
    resetTime: "",
    unlimited: true
  }
];

export function isLegacyDeprecatedModel(labelOrId) {
  const s = String(labelOrId || "").trim();
  return (
    /2[-_.\s]*5|gemini[\s-]*3(?:\.0)?[\s-]*flash\b|gemini[\s-]*3\.5[\s-]*flash[\s-]*lite|gemini[\s-]*3\.1[\s-]*flash|3\.8-flash-tiered|chat_|tab_/i.test(s) ||
    /^(gemini\s*(flash|pro)|claude\s*(opus|sonnet)|gpt-oss)$/i.test(s)
  );
}

export function isGcpOnlyModel(labelOrId) {
  const s = String(labelOrId || "").trim();
  return /3[._-\s]*[67][._-\s]*flash|3[._-\s]*1[._-\s]*pro|\b(m36|m37|m51|m55|m60)\b/i.test(s);
}

export function isModelEntryRestrictedOrSunset(m) {
  if (!m || typeof m !== "object") return true;
  if (m.disabled === true || m.isUnavailable === true || m.unavailable === true) return true;
  const tagTitle = String(m.tagTitle || m.tag || "").trim();
  if (/^(unavailable|deprecated|disabled)$/i.test(tagTitle)) return true;
  return false;
}

function detectArgonAccessFromModels(rawModelsListOrMap, tierCode = "Pro", prevHasArgon = undefined) {
  if (tierCode === "Free" || tierCode === "Plus") return false;
  if (!Array.isArray(rawModelsListOrMap) && rawModelsListOrMap && typeof rawModelsListOrMap === "object") {
    if (Object.prototype.hasOwnProperty.call(rawModelsListOrMap, "gemini-4-argon-disabled")) {
      return false;
    }
  }
  const entries = Array.isArray(rawModelsListOrMap)
    ? rawModelsListOrMap
    : Object.values(rawModelsListOrMap || {});
  if (entries.length === 0) {
    return prevHasArgon !== undefined ? Boolean(prevHasArgon) : (tierCode === "Ultra" || tierCode === "Pro");
  }
  let sawArgonEnabled = false;
  let sawArgonRestricted = false;
  for (const m of entries) {
    if (!m || typeof m !== "object") continue;
    const lbl = String(m.displayName || m.label || m.modelId || "").trim();
    const id = String(m.modelOrAlias?.model || m.modelOrAlias?.alias || m.model || "").trim();
    if (/argon|m417|m418|m419/i.test(lbl) || /argon|m417|m418|m419/i.test(id)) {
      if (isModelEntryRestrictedOrSunset(m) || /disabled$/i.test(id)) {
        sawArgonRestricted = true;
      } else {
        sawArgonEnabled = true;
      }
    }
  }
  if (sawArgonRestricted) return false;
  if (sawArgonEnabled) return true;
  if (prevHasArgon !== undefined) return Boolean(prevHasArgon);
  return false;
}

export function detectPersonalAccountTier(
  rawModelsListOrMap,
  rawTierName = "",
  rawTierId = "",
  prevHasArgon = undefined,
  prevTierCode = ""
) {
  const combinedTier = `${rawTierName || ""} ${rawTierId || ""}`.trim();
  let tierCode = "";
  let tierName = "";

  // 严格按照 Google 官方返回的 userTier (paidTier / currentTier) 判定会员等级徽章 (Ultra / Pro / Plus / Free)
  if (/ultra|g1-ultra/i.test(combinedTier)) {
    tierCode = "Ultra";
    tierName = "Google AI Ultra";
  } else if (/\bpro\b|g1-pro/i.test(combinedTier)) {
    tierCode = "Pro";
    tierName = "Google AI Pro";
  } else if (/\bplus\b|g1-plus/i.test(combinedTier)) {
    tierCode = "Plus";
    tierName = "Google AI Plus";
  } else if (/\bfree\b|standard-tier|free-tier/i.test(combinedTier)) {
    tierCode = "Free";
    tierName = "Google AI Free";
  } else if (prevTierCode && /^(Ultra|Pro|Plus|Free)$/i.test(prevTierCode)) {
    const norm = prevTierCode.charAt(0).toUpperCase() + prevTierCode.slice(1).toLowerCase();
    tierCode = norm;
    tierName = `Google AI ${norm}`;
  } else {
    tierCode = "Pro";
    tierName = "Google AI Pro";
  }

  const hasArgonAccess = detectArgonAccessFromModels(rawModelsListOrMap, tierCode, prevHasArgon);
  return {
    tierCode,
    tierName,
    hasArgonAccess,
    isPaidProOrUltra: tierCode === "Ultra" || tierCode === "Pro"
  };
}

export function buildProModelsFromQuotaGroups(
  quotaGroups,
  prevModels = [],
  dynamicApiModels = [],
  _liveTierTemplate = [],
  hasArgonAccess = true
) {
  const groups = Array.isArray(quotaGroups) ? quotaGroups : [];
  const geminiGroup = groups.find((g) => /gemini\s*models/i.test(g.id || g.displayName || ""));
  const claudeGroup = groups.find((g) => /claude|gpt/i.test(g.id || g.displayName || ""));
  const argonGroup = groups.find((g) => /argon/i.test(g.id || g.displayName || ""));

  const extractGroupDualBuckets = (grp) => {
    const bks = grp?.buckets || [];
    const b5h = bks.find((b) => /5h/i.test(b.window || b.bucketId || ""));
    const bWk = bks.find((b) => /weekly|7d/i.test(b.window || b.bucketId || ""));
    const primary = (b5h && bWk)
      ? ((bWk.remainingPct ?? 100) <= 5 ? bWk : b5h)
      : (b5h || bWk || bks[0] || null);
    return {
      primary,
      weeklyBucket: bWk || primary,
      fiveHourBucket: b5h || bWk || primary
    };
  };

  const matchGroupInfoForModel = (label) => {
    const clean = String(label || "").trim().toLowerCase();
    if (!clean) return null;
    for (const g of groups) {
      const desc = String(g.description || "").toLowerCase();
      const gName = String(g.displayName || g.id || "").toLowerCase();
      if (desc.includes(clean) || gName === clean) {
        return extractGroupDualBuckets(g);
      }
    }
    if (/argon/i.test(clean)) return extractGroupDualBuckets(argonGroup);
    if (/gemini/i.test(clean)) return extractGroupDualBuckets(geminiGroup);
    if (/claude|gpt/i.test(clean)) return extractGroupDualBuckets(claudeGroup);
    return null;
  };

  const mergedTemplateMap = new Map();
  const upsertCandidate = (item) => {
    if (!item) return;
    const rawLabel = String(item.label || item.modelId || "").trim();
    if (!rawLabel) return;
    const baseLabel = rawLabel.replace(/\s*\((Low|Medium|High|Max)\)\s*$/i, "").trim();
    if (
      !baseLabel ||
      isLegacyDeprecatedModel(baseLabel) ||
      isLegacyDeprecatedModel(rawLabel) ||
      isGcpOnlyModel(baseLabel) ||
      isGcpOnlyModel(rawLabel)
    ) {
      return;
    }
    if (!hasArgonAccess && /argon/i.test(baseLabel)) return;
    const vars = (Array.isArray(item.variantIds) ? item.variantIds : [baseLabel, rawLabel]).filter(
      (v) => v && !isLegacyDeprecatedModel(v) && !isGcpOnlyModel(v)
    );
    if (!mergedTemplateMap.has(baseLabel)) {
      mergedTemplateMap.set(baseLabel, {
        label: baseLabel,
        modelId: baseLabel,
        variantIds: Array.from(new Set([baseLabel, ...vars])),
        remainingPct: item.remainingPct,
        resetTime: item.resetTime || "",
        weeklyPct: item.weeklyPct,
        weeklyResetTime: item.weeklyResetTime || "",
        fiveHourPct: item.fiveHourPct,
        fiveHourResetTime: item.fiveHourResetTime || ""
      });
    } else {
      const existing = mergedTemplateMap.get(baseLabel);
      for (const v of vars) {
        if (!existing.variantIds.includes(v)) existing.variantIds.push(v);
      }
      if (existing.remainingPct === undefined && item.remainingPct !== undefined) {
        existing.remainingPct = item.remainingPct;
      }
      if (!existing.resetTime && item.resetTime) {
        existing.resetTime = item.resetTime;
      }
    }
  };

  // 100% 严格采用当前账号官方 API 实时返回的可用模型列表（dynamicApiModels），不混入任何静态兜底模板或其他账号缓存
  const sourceModels = (Array.isArray(dynamicApiModels) && dynamicApiModels.length > 0)
    ? dynamicApiModels
    : (Array.isArray(prevModels) ? prevModels : []);
  for (const m of sourceModels) upsertCandidate(m);

  return Array.from(mergedTemplateMap.values()).map((tpl) => {
    const grpInfo = matchGroupInfoForModel(tpl.label);
    const matchedBk = grpInfo?.primary || null;
    const wkBk = grpInfo?.weeklyBucket || null;
    const fhBk = grpInfo?.fiveHourBucket || null;
    const prevMatch = (prevModels || []).find(
      (p) => String(p.label || p.modelId || "").toLowerCase() === tpl.label.toLowerCase()
    );
    const pct = matchedBk?.remainingPct ?? tpl.remainingPct ?? prevMatch?.remainingPct ?? 100;
    const rst = matchedBk?.resetTime || tpl.resetTime || prevMatch?.resetTime || "";
    const weeklyPct = wkBk?.remainingPct ?? tpl.weeklyPct ?? prevMatch?.weeklyPct ?? pct;
    const weeklyResetTime = wkBk?.resetTime || tpl.weeklyResetTime || prevMatch?.weeklyResetTime || rst;
    const fiveHourPct = fhBk?.remainingPct ?? tpl.fiveHourPct ?? prevMatch?.fiveHourPct ?? pct;
    const fiveHourResetTime = fhBk?.resetTime || tpl.fiveHourResetTime || prevMatch?.fiveHourResetTime || rst;

    return {
      label: tpl.label,
      modelId: tpl.modelId,
      variantIds: [...tpl.variantIds],
      remainingPct: pct,
      resetTime: rst,
      weeklyPct,
      weeklyResetTime,
      fiveHourPct,
      fiveHourResetTime,
      unlimited: false
    };
  });
}

export function isValidOfficialQuotaGroup(g) {
  if (!g || typeof g !== "object") return false;
  const gName = String(g.displayName || g.id || g.groupId || "").trim();
  if (/^all\s*models$/i.test(gName)) return false;
  const bks = Array.isArray(g.buckets) ? g.buckets : [];
  if (bks.length === 0 || bks.length > 3) return false;
  if (bks.some((b) => b.bucketId === "argon-weekly")) return false;
  return true;
}

export function sanitizeCachedQuotaModels(cachedQuota, isGcp, _liveTierTemplate = [], hintTierName = "", hintTierId = "") {
  if (!cachedQuota || typeof cachedQuota !== "object") return cachedQuota;
  const rawList = Array.isArray(cachedQuota.availableModels) ? cachedQuota.availableModels : [];
  const tierInfo = isGcp
    ? { tierCode: "GCP", tierName: hintTierName || "Agent Platform", hasArgonAccess: true, isPaidProOrUltra: false }
    : detectPersonalAccountTier(
        rawList,
        cachedQuota.tierName || hintTierName || "",
        hintTierId || cachedQuota.tierCode || "",
        cachedQuota.hasArgonAccess,
        cachedQuota.tierCode || hintTierId || ""
      );
  const hasArgonAccess = tierInfo.hasArgonAccess;
  const isPaidProOrUltra = tierInfo.isPaidProOrUltra;
  const merged = new Map();
  for (const m of rawList) {
    const rawLabel = String(m.label || m.modelId || "").trim();
    if (!rawLabel) continue;
    const baseLabel = rawLabel.replace(/\s*\((Low|Medium|High|Max)\)\s*$/i, "").trim();
    if (isLegacyDeprecatedModel(baseLabel) || isLegacyDeprecatedModel(rawLabel)) {
      continue;
    }
    if (!isGcp && (isGcpOnlyModel(baseLabel) || isGcpOnlyModel(rawLabel))) {
      continue;
    }
    if (!isGcp && !hasArgonAccess && /argon/i.test(baseLabel)) {
      continue;
    }
    const vars = (Array.isArray(m.variantIds) ? m.variantIds : [baseLabel, rawLabel]).filter(
      (v) => !isLegacyDeprecatedModel(v) && (isGcp || !isGcpOnlyModel(v))
    );
    if (!merged.has(baseLabel)) {
      merged.set(baseLabel, {
        ...m,
        label: baseLabel,
        modelId: baseLabel,
        variantIds: Array.from(new Set([baseLabel, rawLabel, ...vars])),
        remainingPct: isGcp ? 100 : (m.remainingPct ?? 100),
        resetTime: isGcp ? "" : (m.resetTime || ""),
        unlimited: isGcp ? true : Boolean(m.unlimited)
      });
    } else {
      const entry = merged.get(baseLabel);
      for (const v of [rawLabel, ...vars]) {
        if (v && !entry.variantIds.includes(v)) entry.variantIds.push(v);
      }
    }
  }

  let quotaGroups = isGcp ? [] : (Array.isArray(cachedQuota.quotaGroups) ? [...cachedQuota.quotaGroups] : []);
  let availableModels = Array.from(merged.values());

  if (!isGcp) {
    quotaGroups = quotaGroups.filter(
      (g) =>
        isValidOfficialQuotaGroup(g) &&
        (hasArgonAccess || !/argon/i.test(g.id || g.displayName || ""))
    );
    if (quotaGroups.length > 0 && tierInfo.tierCode !== "Free") {
      availableModels = buildProModelsFromQuotaGroups(
        quotaGroups,
        availableModels,
        availableModels,
        [],
        hasArgonAccess
      );
    }
  }

  return {
    ...cachedQuota,
    tierCode: tierInfo.tierCode,
    tierName: tierInfo.tierName,
    hasArgonAccess,
    isPaidProOrUltra,
    isGcpUnlimited: isGcp ? true : Boolean(cachedQuota.isGcpUnlimited),
    quotaGroups,
    availableModels
  };
}

export function normalizeAccountChannels(cfg) {
  if (!cfg.accounts || typeof cfg.accounts !== "object") cfg.accounts = {};
  if (!Array.isArray(cfg.gcpProjects)) cfg.gcpProjects = [];
  const deletedSet = new Set(Array.isArray(cfg.__meta__?.deletedChannelIds) ? cfg.__meta__.deletedChannelIds : []);
  const nextAccounts = {};

  for (const [key, item] of Object.entries(cfg.accounts)) {
    if (!item || typeof item !== "object") continue;
    if (deletedSet.has(key)) continue;
    const email = (item.email || item.storedToken?.id_token_email || key.split("#")[0] || "").trim();
    if (!email) continue;

    if (key.includes("#personal") || key.includes("#gcp:")) {
      const isGcp = key.includes("#gcp:") || item.channelType === "gcp" || Boolean(item.gcpProjectId);
      const pid = isGcp ? (item.gcpProjectId || key.split("#gcp:")[1] || "").trim() : "";

      const normKey = isGcp && pid ? `${email}#gcp:${pid}` : `${email}#personal`;
      const gcpBillingMode = isGcp && pid
        ? (item.gcpBillingMode === "gemini_enterprise" ? "gemini_enterprise" : "agent_platform")
        : "";
      const gcpLocation = isGcp && pid
        ? (["global", "us", "eu"].includes(item.gcpLocation) ? item.gcpLocation : "global")
        : "";
      const cleanPersonalTier = /agent\s*platform|enterprise|gcp/i.test(item.tierName || "")
        ? "Google AI Pro"
        : (item.tierName || "Google AI Pro");
      const cleanGcpTier = gcpBillingMode === "gemini_enterprise" ? "Gemini Enterprise" : "Agent Platform";

      const liveTierKey = isGcp && pid ? "gcp" : "personal";
      const liveTierTemplate = cfg.__meta__?.liveTierModels?.[liveTierKey] || [];
      let cachedQuota = sanitizeCachedQuotaModels(
        item.cachedQuota || null,
        Boolean(isGcp && pid),
        liveTierTemplate,
        cleanPersonalTier,
        item.tierCode || ""
      );
      const resolvedTierCode = isGcp && pid
        ? "GCP"
        : (cachedQuota?.tierCode || item.tierCode || (/ultra/i.test(cleanPersonalTier) ? "Ultra" : (/plus/i.test(cleanPersonalTier) ? "Plus" : (/free/i.test(cleanPersonalTier) ? "Free" : "Pro"))));
      const resolvedPersonalTierName = cachedQuota?.tierName || cleanPersonalTier;
      if (isGcp && pid && gcpBillingMode === "agent_platform") {
        const curModels = cachedQuota?.availableModels || [];
        if (curModels.length < 6) {
          const baseGcpModels = liveTierTemplate.length >= 6 ? liveTierTemplate : AGENT_PLATFORM_DEFAULT_MODELS;
          cachedQuota = {
            tierCode: "GCP",
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
            updatedAt: cachedQuota?.updatedAt || Date.now()
          };
        }
      }

      if (item.storedToken && typeof item.storedToken === "object" && item.storedToken.token && item.storedToken.token.expiry) {
        item.storedToken.token.expiry = normalizeIsoExpiry(item.storedToken.token.expiry);
      }

      nextAccounts[normKey] = {
        ...item,
        id: normKey,
        email,
        channelType: isGcp && pid ? "gcp" : "personal",
        tierCode: resolvedTierCode,
        gcpProjectId: isGcp && pid ? pid : "",
        gcpBillingMode,
        gcpLocation,
        tierName: isGcp && pid ? cleanGcpTier : resolvedPersonalTierName,
        cachedQuota
      };
      if (pid && !cfg.gcpProjects.includes(pid)) cfg.gcpProjects.push(pid);
    } else {
      const oldPid = (item.gcpProjectId || item.storedToken?.project_id || "").trim();
      if (oldPid) {
        const gcpKey = `${email}#gcp:${oldPid}`;
        nextAccounts[gcpKey] = {
          id: gcpKey,
          alias: `${email} (${oldPid})`,
          email,
          channelType: "gcp",
          tierName: "Agent Platform",
          gcpProjectId: oldPid,
          gcpBillingMode: "agent_platform",
          gcpLocation: "global",
          projectName: item.projectName || oldPid,
          savedAt: item.savedAt || new Date().toISOString(),
          storedToken: item.storedToken ? { ...item.storedToken, auth_method: "gcp", project_id: oldPid, region: "global" } : null,
          cachedQuota: {
            isGcpUnlimited: true,
            quotaGroups: [],
            availableModels: AGENT_PLATFORM_DEFAULT_MODELS.map((m) => ({ ...m, variantIds: [...m.variantIds] })),
            updatedAt: Date.now()
          }
        };
        if (!cfg.gcpProjects.includes(oldPid)) cfg.gcpProjects.push(oldPid);
      } else {
        const personalKey = `${email}#personal`;
        const baseToken = item.storedToken ? buildCleanChannelToken(item.storedToken, "", "") : null;
        nextAccounts[personalKey] = {
          id: personalKey,
          alias: item.alias || email,
          email,
          channelType: "personal",
          tierName: "Google AI Pro",
          gcpProjectId: "",
          gcpBillingMode: "",
          gcpLocation: "",
          savedAt: item.savedAt || new Date().toISOString(),
          storedToken: baseToken
        };
      }
    }
  }

  if (cfg.routing && typeof cfg.routing === "object") {
    delete cfg.routing.subagentDefaultTarget;
  }
  if (cfg.routing?.models && typeof cfg.routing.models === "object") {
    for (const [mKey, targetVal] of Object.entries(cfg.routing.models)) {
      if (isLegacyDeprecatedModel(mKey)) {
        delete cfg.routing.models[mKey];
        continue;
      }
      if (typeof targetVal === "string" && targetVal.startsWith("account:")) {
        const refId = targetVal.slice(8);
        const refAcc = nextAccounts[refId];
        if (!refAcc || refAcc.channelType === "gcp" || refAcc.gcpProjectId) {
          delete cfg.routing.models[mKey];
        }
      }
    }
  }

  cfg.accounts = nextAccounts;
}

export function findStoredTokenForEmail(cfg, email, preferGcp = null) {
  if (!email) return null;
  if (preferGcp === false) {
    if (cfg?.__meta__?.oauthTokensByEmail?.[email]?.token?.refresh_token) {
      return cfg.__meta__.oauthTokensByEmail[email];
    }
    for (const acc of Object.values(cfg.accounts || {})) {
      const accIsGcp = Boolean(acc.gcpProjectId || acc.channelType === "gcp");
      if (acc.email === email && !accIsGcp && acc.storedToken?.token?.refresh_token) {
        return acc.storedToken;
      }
    }
    const winCred = readWinCredToken(false);
    if (winCred && winCred.id_token_email === email && !winCred.project_id && winCred.auth_method !== "gcp") {
      return winCred;
    }
  }
  if (preferGcp === true && cfg?.__meta__?.gcpOAuthTokensByEmail?.[email]?.token) {
    return cfg.__meta__.gcpOAuthTokensByEmail[email];
  }
  if (preferGcp !== null) {
    for (const acc of Object.values(cfg.accounts || {})) {
      const accIsGcp = Boolean(acc.gcpProjectId || acc.channelType === "gcp");
      if (acc.email === email && accIsGcp === Boolean(preferGcp) && acc.storedToken?.token) {
        return acc.storedToken;
      }
    }
  }
  if (cfg?.__meta__?.oauthTokensByEmail?.[email]?.token) {
    return cfg.__meta__.oauthTokensByEmail[email];
  }
  if (cfg?.__meta__?.gcpOAuthTokensByEmail?.[email]?.token) {
    return cfg.__meta__.gcpOAuthTokensByEmail[email];
  }
  for (const acc of Object.values(cfg.accounts || {})) {
    if (acc.email === email && acc.storedToken?.token) {
      return acc.storedToken;
    }
  }
  const winCred = readWinCredToken(false);
  if (winCred && winCred.id_token_email === email) return winCred;
  return null;
}

export function findFirstGcpProjectForEmail(cfg, email) {
  if (!email) return "";
  for (const acc of Object.values(cfg.accounts || {})) {
    if (acc.email === email && acc.gcpProjectId) {
      return acc.gcpProjectId;
    }
  }
  return "";
}

function isInternalConsumerPoolProject(projectId) {
  const pid = String(projectId || "").trim();
  if (!pid) return true;
  return /^(aicode-consumers|rising-fact-[a-z0-9-]+|gen-lang-client-[a-z0-9-]+|cloud-ai-companion-[a-z0-9-]+)$/i.test(pid);
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

export function callCloudCodeApi(endpointPath, accessToken, payloadObj = {}, extraHeaders = {}) {
  return new Promise((resolve) => {
    if (!accessToken) return resolve({ status: 0, data: null });
    const body = Buffer.from(JSON.stringify(payloadObj || {}), "utf8");
    const req = https.request(
      {
        hostname: "daily-cloudcode-pa.googleapis.com",
        port: 443,
        path: endpointPath,
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": "antigravity/hub/2.28.2 (aidev_client; os_type=windows; arch=amd64; cl=1009437749)",
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
    metadata: { ideType: "JETSKI", pluginType: "GEMINI" }
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

  // 优先使用 refresh_token 刷新获取最新有效 access_token，避免缓存 token 过期
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
  let projects = mergeDiscovered(crmV1Res.projects, crmV3List, ccProjects, gcloudProjects);

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

  // 严格提取官方 agentModelSorts 推荐分组中的模型 ID 白名单，彻底排除底层字典中的旧版内部模型
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

  if (ls && acc.email && acc.email === activeEmail && gcpPid === originalGcpPid) {
    try {
      const [usResp, qsResp] = await Promise.all([
        callLsRpc(ls, "GetUserStatus", {}).catch(() => null),
        callLsRpc(ls, "RetrieveUserQuotaSummary", {}).catch(() => null)
      ]);

      const clientModels = usResp?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
      const rawGroups = qsResp?.response?.groups || [];
      const usEmail = (usResp?.userStatus?.email || "").trim();
      const usTierName = usResp?.userStatus?.userTier?.name || usResp?.userStatus?.planStatus?.planInfo?.planName || "";
      const usTierId = usResp?.userStatus?.userTier?.id || "";
      const lsHasGcpModels = clientModels.some((m) => isGcpOnlyModel(m.label || m.modelOrAlias?.model || ""));
      const lsModeMatches = Boolean(
        usEmail === acc.email &&
        isGcp === Boolean(/agent\s*platform|enterprise/i.test(usTierName) || lsHasGcpModels)
      );
      if (lsModeMatches && (clientModels.length > 0 || rawGroups.length > 0)) {
        const tierInfo = isGcp
          ? { tierCode: "GCP", tierName: acc.tierName || "Agent Platform", hasArgonAccess: true, isPaidProOrUltra: false }
          : detectPersonalAccountTier(
              clientModels,
              usTierName,
              usTierId,
              acc.cachedQuota?.hasArgonAccess,
              acc.tierCode || acc.cachedQuota?.tierCode || ""
            );
        const hasArgonAccess = tierInfo.hasArgonAccess;
        const isPaidProOrUltra = tierInfo.isPaidProOrUltra;
        const groupedMap = new Map();
        for (const m of clientModels) {
          const rawLabel = (m.label || "").trim();
          const modelId = m.modelOrAlias?.model || m.modelOrAlias?.alias || "";
          if (!rawLabel || !modelId) continue;
          const baseLabel = rawLabel.replace(/\s*\((Low|Medium|High|Max)\)\s*$/i, "").trim();
          if (!isGcp) {
            if (
              isLegacyDeprecatedModel(baseLabel) ||
              isLegacyDeprecatedModel(rawLabel) ||
              isGcpOnlyModel(baseLabel) ||
              isGcpOnlyModel(rawLabel) ||
              isModelEntryRestrictedOrSunset(m)
            ) {
              continue;
            }
            if (!hasArgonAccess && /argon/i.test(baseLabel)) {
              continue;
            }
          }
          const hasFraction = m.quotaInfo?.remainingFraction !== undefined;
          const remainingPct = isGcp
            ? 100
            : (hasFraction ? Math.round(m.quotaInfo.remainingFraction * 100) : (m.quotaInfo?.resetTime ? 0 : 100));
          const resetTime = isGcp ? "" : (m.quotaInfo?.resetTime || "");
          if (!groupedMap.has(baseLabel)) {
            groupedMap.set(baseLabel, {
              label: baseLabel,
              modelId: baseLabel,
              variantIds: [baseLabel, rawLabel, modelId],
              remainingPct,
              resetTime,
              unlimited: isGcp
            });
          } else {
            const entry = groupedMap.get(baseLabel);
            if (!entry.variantIds.includes(rawLabel)) entry.variantIds.push(rawLabel);
            if (!entry.variantIds.includes(modelId)) entry.variantIds.push(modelId);
          }
        }
        const quotaGroups = isGcp
          ? []
          : rawGroups
              .filter((g) => hasArgonAccess || !/argon/i.test(g.groupId || g.displayName || ""))
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

        let liveModels = Array.from(groupedMap.values());
        if (!isGcp && quotaGroups.length > 0 && tierInfo.tierCode !== "Free") {
          liveModels = buildProModelsFromQuotaGroups(
            quotaGroups,
            acc.cachedQuota?.availableModels || [],
            liveModels,
            [],
            hasArgonAccess
          );
        }
        if (liveModels.length > 0 && clientModels.length > 0 && isGcp) {
          if (!cfg.__meta__.liveTierModels || typeof cfg.__meta__.liveTierModels !== "object") {
            cfg.__meta__.liveTierModels = {};
          }
          cfg.__meta__.liveTierModels.gcp = liveModels.map((m) => ({
            label: m.label,
            modelId: m.modelId,
            variantIds: [...(m.variantIds || [m.label])]
          }));
        }

        if ((isGcp && liveModels.length > 0) || (!isGcp && quotaGroups.length > 0 && liveModels.length > 0)) {
          if (!isGcp) {
            acc.tierCode = tierInfo.tierCode;
            acc.tierName = tierInfo.tierName;
          }
          acc.cachedQuota = {
            tierCode: tierInfo.tierCode,
            tierName: tierInfo.tierName,
            hasArgonAccess,
            isPaidProOrUltra,
            isGcpUnlimited: isGcp,
            quotaGroups,
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

  // 收集当前邮箱下的所有候选凭据（个人通道优先使用 oauthTokensByEmail 独立个人凭据，GCP 优先使用通道专属/GCP 凭据，且互为回退）
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
    pushCandidateToken(cfg?.__meta__?.oauthTokensByEmail?.[acc.email]);
    pushCandidateToken(acc.storedToken);
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
    pushCandidateToken(acc.storedToken);
    pushCandidateToken(cfg?.__meta__?.gcpOAuthTokensByEmail?.[acc.email]);
    pushCandidateToken(cfg?.__meta__?.oauthTokensByEmail?.[acc.email]);
    for (const item of Object.values(cfg.accounts || {})) {
      if (item.email === acc.email) pushCandidateToken(item.storedToken);
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

  const tryProbeWithToken = async (tok) => {
    let companionPid = gcpPid;
    const loadPayload = {
      metadata: {
        ideType: "JETSKI",
        pluginType: "GEMINI"
      }
    };
    if (gcpPid) {
      loadPayload.cloudaicompanionProject = gcpPid;
      loadPayload.metadata.duetProject = gcpPid;
    }
    const loadResp = await callCloudCodeApi("/v1internal:loadCodeAssist", tok, loadPayload);
    let userTier = "";
    if (loadResp.status === 200 && loadResp.data) {
      if (!companionPid) {
        companionPid = String(
          loadResp.data.cloudaicompanionProject?.id ||
          loadResp.data.cloudaicompanionProject ||
          ""
        ).trim();
      }
      const pTier = loadResp.data.paidTier || loadResp.data.currentTier || {};
      userTier = String(
        isGcp
          ? (loadResp.data.currentTier?.id || "standard-tier")
          : `${pTier.id || ""} ${pTier.name || ""}`
      ).trim();
    }

    const reqPayload = companionPid ? { project: companionPid } : {};

    let [modelsResp, quotaSummaryResp] = await Promise.all([
      callCloudCodeApi("/v1internal:fetchAvailableModels", tok, reqPayload),
      !isGcp
        ? callCloudCodeApi("/v1internal:retrieveUserQuotaSummary", tok, reqPayload)
        : Promise.resolve({ status: 0, data: null })
    ]);
    if (!isGcp && (!quotaSummaryResp?.data?.groups?.length) && companionPid) {
      const fallbackQs = await callCloudCodeApi("/v1internal:retrieveUserQuotaSummary", tok, {});
      if (fallbackQs?.data?.groups?.length) {
        quotaSummaryResp = fallbackQs;
      }
    }
    return { loadResp, modelsResp, quotaSummaryResp, companionPid, userTier };
  };

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
      } catch {}
    }

    let probeRes = await tryProbeWithToken(accessToken);
    if ((probeRes.modelsResp.status === 401 || probeRes.modelsResp.status === 403 || !probeRes.modelsResp.data) && refreshToken) {
      try {
        const refreshed = await refreshOAuthAccessToken(refreshToken);
        if (refreshed && refreshed.access_token) {
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
      } catch {}
    }

    if (probeRes.modelsResp.status === 200 && probeRes.modelsResp.data) {
      const parsed = parseCloudCodeModelsAndQuota(
        probeRes.modelsResp.data,
        probeRes.quotaSummaryResp?.data || null,
        isGcp,
        probeRes.userTier,
        acc.cachedQuota || null,
        []
      );
      const personalHasValidGroups = !isGcp && Array.isArray(parsed?.quotaGroups) && parsed.quotaGroups.length > 0;
      if (parsed && (personalHasValidGroups || (isGcp && parsed.availableModels.length > 0))) {
        if (!isGcp) {
          if (parsed.tierCode) {
            acc.tierCode = parsed.tierCode;
            acc.tierName = parsed.tierName || acc.tierName;
          }
          // 将经过验证具备消费级配额查询权限的个人凭据独立固化到个人通道与 oauthTokensByEmail，彻底与 GCP 凭据解耦
          const cleanPersonalTok = buildCleanChannelToken(baseToken, "", "", false);
          acc.storedToken = cleanPersonalTok;
          if (!cfg.__meta__.oauthTokensByEmail || typeof cfg.__meta__.oauthTokensByEmail !== "object") {
            cfg.__meta__.oauthTokensByEmail = {};
          }
          cfg.__meta__.oauthTokensByEmail[acc.email] = cleanPersonalTok;
        }
        acc.cachedQuota = parsed;
        writeRelayConfig(cfg);
        return acc.cachedQuota;
      }
    }
  }

  if (isGcp && gcpBillingMode === "agent_platform") {
    const existingModels = acc.cachedQuota?.availableModels || [];
    const baseGcpModels = liveTierTemplate.length >= 6 ? liveTierTemplate : AGENT_PLATFORM_DEFAULT_MODELS;
    acc.cachedQuota = {
      tierCode: "GCP",
      tierName: acc.tierName || "Agent Platform",
      isGcpUnlimited: true,
      quotaGroups: [],
      availableModels: existingModels.length >= 6
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
