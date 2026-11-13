import {
  readRelayConfig,
  writeRelayConfig
} from "../store.mjs";
import {
  readWinCredToken,
  buildCleanChannelToken
} from "./wincred-ls.mjs";

export const AGENT_PLATFORM_DEFAULT_MODELS = [];

export function isLegacyDeprecatedModel(labelOrId) {
  const s = String(labelOrId || "").trim();
  return (
    /2[-_.\s]*5|gemini[\s-]*3(?:\.0)?[\s-]*flash\b|gemini[\s-]*3\.5[\s-]*flash[\s-]*lite|gemini[\s-]*3\.1[\s-]*flash|3\.8-flash-tiered|chat_|tab_/i.test(s) ||
    /^(gemini\s*(flash|pro)|claude\s*(opus|sonnet)|gpt-oss)$/i.test(s)
  );
}

export function stripModelVariantSuffix(rawLabel) {
  return String(rawLabel || "")
    .replace(/\s*\((Low|Medium|High|XHigh|Extra|Max)\)\s*$/i, "")
    .trim();
}

export function deriveCloudCodeSlugFromLabel(rawLabel) {
  const clean = String(rawLabel || "").trim();
  if (!clean) return "";
  let slug = clean
    .toLowerCase()
    .replace(/[()]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  if (slug.startsWith("claude-")) {
    slug = slug.replace(/(\d)\.(\d)/g, "$1-$2");
  }
  return slug;
}

export function ensureDynamicModelRegistry(cfg) {
  if (!cfg || typeof cfg !== "object") return { placeholderToSlug: {}, placeholderToFamily: {}, labelToSlug: {} };
  if (!cfg.__meta__ || typeof cfg.__meta__ !== "object") cfg.__meta__ = {};
  if (!cfg.__meta__.dynamicModelRegistry || typeof cfg.__meta__.dynamicModelRegistry !== "object") {
    cfg.__meta__.dynamicModelRegistry = {
      placeholderToSlug: {},
      placeholderToFamily: {},
      labelToSlug: {}
    };
  }
  const reg = cfg.__meta__.dynamicModelRegistry;
  if (!reg.placeholderToSlug) reg.placeholderToSlug = {};
  if (!reg.placeholderToFamily) reg.placeholderToFamily = {};
  if (!reg.labelToSlug) reg.labelToSlug = {};
  for (const [k, fam] of Object.entries(reg.placeholderToFamily)) {
    const cleanFam = stripModelVariantSuffix(fam);
    if (cleanFam && cleanFam !== fam) {
      reg.placeholderToFamily[k] = cleanFam;
    }
  }
  return reg;
}

export function learnModelsFromCloudCodeResponse(cfg, rawModelsResp) {
  const modelsObj = rawModelsResp?.models;
  if (!modelsObj || typeof modelsObj !== "object") return false;
  const reg = ensureDynamicModelRegistry(cfg);
  let changed = false;
  for (const [modelKey, m] of Object.entries(modelsObj)) {
    if (!m || typeof m !== "object" || /disabled$/i.test(modelKey)) continue;
    const rawLabel = String(m.displayName || m.label || "").trim();
    if (!rawLabel || isLegacyDeprecatedModel(rawLabel) || isLegacyDeprecatedModel(modelKey)) continue;
    const lowerLabel = rawLabel.toLowerCase();
    const baseFamily = stripModelVariantSuffix(rawLabel);
    if (reg.labelToSlug[lowerLabel] !== modelKey) {
      reg.labelToSlug[lowerLabel] = modelKey;
      changed = true;
    }
    const lowerKey = modelKey.toLowerCase();
    if (baseFamily && reg.placeholderToFamily[lowerKey] !== baseFamily) {
      reg.placeholderToFamily[lowerKey] = baseFamily;
      changed = true;
    }
    if (baseFamily) {
      const famSlug = deriveCloudCodeSlugFromLabel(baseFamily);
      if (famSlug && reg.placeholderToFamily[famSlug] !== baseFamily) {
        reg.placeholderToFamily[famSlug] = baseFamily;
        changed = true;
      }
    }
  }
  return changed;
}

export function learnModelsFromLsClientConfigs(cfg, clientModelConfigs) {
  if (!Array.isArray(clientModelConfigs) || clientModelConfigs.length === 0) return false;
  const reg = ensureDynamicModelRegistry(cfg);
  let changed = false;
  for (const m of clientModelConfigs) {
    if (!m || typeof m !== "object") continue;
    const rawLabel = String(m.label || m.displayName || "").trim();
    const modelId = String(m.modelOrAlias?.model || m.modelOrAlias?.alias || m.model || "").trim();
    if (!rawLabel || !modelId || isLegacyDeprecatedModel(rawLabel)) continue;
    const baseFamily = stripModelVariantSuffix(rawLabel);
    const lowerId = modelId.toLowerCase();
    const lowerLabel = rawLabel.toLowerCase();
    const cloudSlug = reg.labelToSlug[lowerLabel] || deriveCloudCodeSlugFromLabel(rawLabel);
    if (baseFamily && reg.placeholderToFamily[lowerId] !== baseFamily) {
      reg.placeholderToFamily[lowerId] = baseFamily;
      changed = true;
    }
    if (cloudSlug && reg.placeholderToSlug[lowerId] !== cloudSlug) {
      reg.placeholderToSlug[lowerId] = cloudSlug;
      changed = true;
    }
    if (cloudSlug && !reg.labelToSlug[lowerLabel]) {
      reg.labelToSlug[lowerLabel] = cloudSlug;
      changed = true;
    }
    if (baseFamily && cloudSlug && reg.placeholderToFamily[cloudSlug.toLowerCase()] !== baseFamily) {
      reg.placeholderToFamily[cloudSlug.toLowerCase()] = baseFamily;
      changed = true;
    }
    if (baseFamily) {
      const famSlug = deriveCloudCodeSlugFromLabel(baseFamily);
      if (famSlug && reg.placeholderToFamily[famSlug] !== baseFamily) {
        reg.placeholderToFamily[famSlug] = baseFamily;
        changed = true;
      }
    }
  }
  return changed;
}

export function isGcpOnlyModel(labelOrId) {
  const s = String(labelOrId || "").trim();
  return /3[._-\s]*[67][._-\s]*flash|3[._-\s]*1[._-\s]*pro|\b(m36|m37|m51|m55|m60|m61|m62|m63|m71|m72|m73|m298|m299|m300)\b/i.test(s);
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
  liveTierTemplate = [],
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
    const baseLabel = stripModelVariantSuffix(rawLabel);
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

  if (Array.isArray(liveTierTemplate) && liveTierTemplate.length > 0) {
    for (const m of liveTierTemplate) upsertCandidate(m);
  }
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

export function sanitizeCachedQuotaModels(cachedQuota, isGcp, liveTierTemplate = [], hintTierName = "", hintTierId = "") {
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
    const baseLabel = stripModelVariantSuffix(rawLabel);
    if (isLegacyDeprecatedModel(baseLabel) || isLegacyDeprecatedModel(rawLabel)) {
      continue;
    }
    if (!isGcp && (isGcpOnlyModel(baseLabel) || isGcpOnlyModel(rawLabel))) {
      continue;
    }
    if (isGcp && /4[._-\s]*6|gpt-oss/i.test(`${baseLabel} ${rawLabel}`)) {
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
        liveTierTemplate,
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
    if (winCred && winCred.id_token_email === email && !winCred.project_id && winCred.auth_method !== "gcp" && winCred.auth_method !== "adc") {
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

export const KNOWN_COMPANION_PROJECTS_BY_EMAIL = {
  "toruolenyeva@gmail.com": "rising-fact-p41fc",
  "linolenyeva@gmail.com": "prime-signifier-07sc6",
  "2358541069qq@gmail.com": "valuable-broker-952s0"
};

export function isInternalConsumerPoolProject(projectId) {
  const pid = String(projectId || "").trim();
  if (!pid) return true;
  return /^(aicode-consumers|rising-fact-[a-z0-9-]+|prime-signifier-[a-z0-9-]+|valuable-broker-[a-z0-9-]+|gen-lang-client-[a-z0-9-]+|cloud-ai-companion-[a-z0-9-]+)$/i.test(pid);
}

export function isDowngradedConsumerPoolProject(projectId) {
  const pid = String(projectId || "").trim();
  if (!pid) return true;
  return /^aicode-consumers$/i.test(pid);
}

export function resolvePersonalCompanionProjectId(cfg, email, candidatePid = "") {
  const cleanEmail = String(email || "").trim().toLowerCase();
  const cleanCand = String(candidatePid || "").trim();
  if (cleanCand && !isDowngradedConsumerPoolProject(cleanCand)) {
    if (cfg && typeof cfg === "object") {
      if (!cfg.__meta__ || typeof cfg.__meta__ !== "object") cfg.__meta__ = {};
      if (!cfg.__meta__.companionProjectsByEmail || typeof cfg.__meta__.companionProjectsByEmail !== "object") {
        cfg.__meta__.companionProjectsByEmail = {};
      }
      if (cleanEmail) {
        cfg.__meta__.companionProjectsByEmail[cleanEmail] = cleanCand;
      }
    }
    return cleanCand;
  }
  const fromMeta = cleanEmail ? String(cfg?.__meta__?.companionProjectsByEmail?.[cleanEmail] || "").trim() : "";
  if (fromMeta && !isDowngradedConsumerPoolProject(fromMeta)) {
    return fromMeta;
  }
  const known = cleanEmail ? String(KNOWN_COMPANION_PROJECTS_BY_EMAIL[cleanEmail] || "").trim() : "";
  if (known) {
    if (cfg && typeof cfg === "object") {
      if (!cfg.__meta__ || typeof cfg.__meta__ !== "object") cfg.__meta__ = {};
      if (!cfg.__meta__.companionProjectsByEmail || typeof cfg.__meta__.companionProjectsByEmail !== "object") {
        cfg.__meta__.companionProjectsByEmail = {};
      }
      cfg.__meta__.companionProjectsByEmail[cleanEmail] = known;
    }
    return known;
  }
  return "";
}

export function normalizePersonalQuotaPool(_rawPool) {
  return "daily";
}

export function normalizeAccountChannels(cfg) {
  if (!cfg.accounts || typeof cfg.accounts !== "object") cfg.accounts = {};
  if (!Array.isArray(cfg.gcpProjects)) cfg.gcpProjects = [];
  if (!cfg.__meta__ || typeof cfg.__meta__ !== "object") cfg.__meta__ = {};
  if (!cfg.__meta__.companionProjectsByEmail || typeof cfg.__meta__.companionProjectsByEmail !== "object") {
    cfg.__meta__.companionProjectsByEmail = {};
  }
  for (const [kEmail, kPid] of Object.entries(KNOWN_COMPANION_PROJECTS_BY_EMAIL)) {
    if (!cfg.__meta__.companionProjectsByEmail[kEmail] || isDowngradedConsumerPoolProject(cfg.__meta__.companionProjectsByEmail[kEmail])) {
      cfg.__meta__.companionProjectsByEmail[kEmail] = kPid;
    }
  }
  ensureDynamicModelRegistry(cfg);
  if (cfg.__meta__?.liveTierModels && typeof cfg.__meta__.liveTierModels === "object") {
    for (const tKey of ["gcp", "personal"]) {
      const tpl = cfg.__meta__.liveTierModels[tKey];
      if (!Array.isArray(tpl)) continue;
      const mergedTpl = new Map();
      for (const m of tpl) {
        const rawLbl = String(m?.label || m?.modelId || "").trim();
        const baseLbl = stripModelVariantSuffix(rawLbl);
        if (!baseLbl || isLegacyDeprecatedModel(baseLbl)) continue;
        const vars = Array.isArray(m.variantIds) ? m.variantIds : [baseLbl, rawLbl];
        if (!mergedTpl.has(baseLbl)) {
          mergedTpl.set(baseLbl, {
            label: baseLbl,
            modelId: baseLbl,
            variantIds: Array.from(new Set([baseLbl, rawLbl, ...vars])).filter(Boolean)
          });
        } else {
          const ex = mergedTpl.get(baseLbl);
          for (const v of [rawLbl, ...vars]) {
            if (v && !ex.variantIds.includes(v)) ex.variantIds.push(v);
          }
        }
      }
      cfg.__meta__.liveTierModels[tKey] = Array.from(mergedTpl.values());
    }
  }
  const activePool = normalizePersonalQuotaPool(cfg.routing?.personalQuotaPool);
  if (cfg.routing && typeof cfg.routing === "object") {
    cfg.routing.personalQuotaPool = activePool;
  }
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
      const cleanCompanionPid = !isGcp
        ? resolvePersonalCompanionProjectId(cfg, email, item.companionProjectId || item.cachedQuota?.companionProjectId || "")
        : "";
      let cachedQuota = sanitizeCachedQuotaModels(
        item.cachedQuota || null,
        Boolean(isGcp && pid),
        liveTierTemplate,
        isGcp && pid ? cleanGcpTier : cleanPersonalTier,
        item.tierCode || ""
      );
      let cachedQuotaByPool = undefined;
      if (!isGcp && !pid) {
        cachedQuotaByPool = {};
        const rawByPool = item.cachedQuotaByPool && typeof item.cachedQuotaByPool === "object"
          ? item.cachedQuotaByPool
          : {};
        for (const pKey of ["daily"]) {
          if (rawByPool[pKey] && typeof rawByPool[pKey] === "object") {
            const sanitizedPool = sanitizeCachedQuotaModels(
              rawByPool[pKey],
              false,
              liveTierTemplate,
              cleanPersonalTier,
              item.tierCode || ""
            );
            if (sanitizedPool) {
              sanitizedPool.pool = "daily";
              sanitizedPool.quotaPool = "daily";
              sanitizedPool.upstreamHostname = "daily-cloudcode-pa.googleapis.com";
              if (cleanCompanionPid) sanitizedPool.companionProjectId = cleanCompanionPid;
              cachedQuotaByPool.daily = sanitizedPool;
            }
          }
        }
        if (cachedQuota && Array.isArray(cachedQuota.quotaGroups) && cachedQuota.quotaGroups.length > 0) {
          const rawTag = cachedQuota.pool || cachedQuota.quotaPool || "daily";
          if (rawTag === "daily" && !cachedQuotaByPool.daily) {
            cachedQuota.pool = "daily";
            cachedQuota.quotaPool = "daily";
            if (cleanCompanionPid) cachedQuota.companionProjectId = cleanCompanionPid;
            cachedQuotaByPool.daily = cachedQuota;
          }
        }
        if (cachedQuotaByPool.daily?.quotaGroups?.length) {
          cachedQuota = cachedQuotaByPool.daily;
        }
      }
      if (cachedQuota && cleanCompanionPid && !isGcp) {
        cachedQuota.companionProjectId = cleanCompanionPid;
      }
      const resolvedTierCode = isGcp && pid
        ? "GCP"
        : (cachedQuota?.tierCode || item.tierCode || (/ultra/i.test(cleanPersonalTier) ? "Ultra" : (/plus/i.test(cleanPersonalTier) ? "Plus" : (/free/i.test(cleanPersonalTier) ? "Free" : "Pro"))));
      const resolvedPersonalTierName = cachedQuota?.tierName || cleanPersonalTier;
      if (isGcp && pid && gcpBillingMode === "agent_platform") {
        const curModels = cachedQuota?.availableModels || [];
        const hasValidGcpModels =
          curModels.length >= 6 &&
          curModels.some((m) => isGcpOnlyModel(m?.label || m?.modelId || ""));
        if (!hasValidGcpModels) {
          const baseGcpModels =
            liveTierTemplate.length >= 6 && liveTierTemplate.some((m) => isGcpOnlyModel(m?.label || m?.modelId || ""))
              ? liveTierTemplate
              : AGENT_PLATFORM_DEFAULT_MODELS;
          cachedQuota = {
            tierCode: "GCP",
            tierName: cleanGcpTier,
            hasArgonAccess: true,
            isPaidProOrUltra: false,
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

      const dedicatedGcpTok = (isGcp && pid) ? cfg.__meta__?.gcpOAuthTokensByEmail?.[email] : null;
      const dedicatedPersTok = (!isGcp) ? cfg.__meta__?.oauthTokensByEmail?.[email] : null;
      const rawChannelTok =
        (isGcp && pid && dedicatedGcpTok?.token?.refresh_token
          ? dedicatedGcpTok
          : (!isGcp && dedicatedPersTok?.token?.refresh_token ? dedicatedPersTok : null)) ||
        item.storedToken ||
        cfg.__meta__?.channelTokensById?.[normKey] ||
        findStoredTokenForEmail(cfg, email, Boolean(isGcp && pid));
      const isolatedChannelTok = rawChannelTok
        ? buildCleanChannelToken(
            JSON.parse(JSON.stringify(rawChannelTok)),
            isGcp && pid ? pid : "",
            gcpBillingMode === "agent_platform" ? gcpLocation : "",
            false,
            gcpBillingMode
          )
        : null;
      if (!cfg.__meta__.channelTokensById || typeof cfg.__meta__.channelTokensById !== "object") {
        cfg.__meta__.channelTokensById = {};
      }
      if (isolatedChannelTok) {
        cfg.__meta__.channelTokensById[normKey] = JSON.parse(JSON.stringify(isolatedChannelTok));
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
        companionProjectId: cleanCompanionPid,
        tierName: isGcp && pid ? cleanGcpTier : resolvedPersonalTierName,
        storedToken: isolatedChannelTok,
        cachedQuota,
        ...(cachedQuotaByPool ? { cachedQuotaByPool } : {})
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
          storedToken: item.storedToken
            ? buildCleanChannelToken(item.storedToken, oldPid, "global", false, "agent_platform")
            : null,
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
        const rawComp = String(item.companionProjectId || item.cachedQuota?.companionProjectId || "").trim();
        nextAccounts[personalKey] = {
          id: personalKey,
          alias: item.alias || email,
          email,
          channelType: "personal",
          tierName: "Google AI Pro",
          gcpProjectId: "",
          gcpBillingMode: "",
          gcpLocation: "",
          companionProjectId: isDowngradedConsumerPoolProject(rawComp) ? "" : rawComp,
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
        const rawRef = targetVal.slice(8).trim();
        const hashIdx = rawRef.indexOf("#");
        const poolAtIdx = hashIdx >= 0 ? rawRef.indexOf("@", hashIdx) : -1;
        const refId = (poolAtIdx >= 0 ? rawRef.slice(0, poolAtIdx) : rawRef).trim();
        const refAcc = nextAccounts[refId] || (!refId.includes("#") ? nextAccounts[`${refId}#personal`] : null);
        if (!refAcc || refAcc.channelType === "gcp" || refAcc.gcpProjectId) {
          delete cfg.routing.models[mKey];
        }
      }
    }
  }

  delete cfg.activeChannelId;
  delete cfg.activeEmail;
  delete cfg.activeMode;
  delete cfg.activeProjectId;
  cfg.accounts = nextAccounts;
}

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
