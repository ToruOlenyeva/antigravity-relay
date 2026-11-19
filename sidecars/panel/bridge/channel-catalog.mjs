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
    /2[-_.\s]*5|gemini[\s-]*3(?:\.0)?[\s-]*flash\b|gemini[\s-]*3\.5[\s-]*flash[\s-]*lite|gemini[\s-]*3\.1[\s-]*flash|3\.8-flash-tiered|\bsonar\b|chat_|tab_/i.test(s) ||
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
  if (/^orchestrator\s*\(argon\)$/i.test(clean)) {
    return "gemini-pro-orchestrator-g1-pro";
  }
  const orchMatch = /^\s*orchestrator\s*\(([^)]+)\)\s*$/i.exec(clean);
  if (orchMatch) {
    const innerSlug = orchMatch[1]
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (innerSlug) {
      return `gemini-pro-orchestrator-${innerSlug}`;
    }
  }
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

const GENERIC_MODEL_MATCH_TOKENS = new Set([
  "model",
  "placeholder",
  "gemini",
  "claude",
  "gpt",
  "oss",
  "pro",
  "flash",
  "sonnet",
  "opus",
  "lite",
  "g1",
  "g2",
  "g3",
  "tiered",
  "thinking",
  "low",
  "medium",
  "high",
  "xhigh",
  "extra",
  "max",
  "the",
  "and",
  "for",
  "with",
  "preview",
  "latest",
  "exp"
]);

function extractDistinctiveModelTokens(str) {
  return String(str || "")
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter((tok) => tok && !GENERIC_MODEL_MATCH_TOKENS.has(tok));
}

/**
 * 判断模型 slug 是否为旧版规则错误拼接的 `orchestrator-<target>` 猜测名。
 * @param {string} slug 模型 ID 或 slug
 * @returns {boolean}
 */
export function isGuessedOrchestratorSlug(slug) {
  return /^orchestrator-[a-z0-9._-]+$/i.test(String(slug || "").trim());
}

/**
 * 从模型显示名或云端 slug 中动态提取 Orchestrator 目标标识（例如 `Neon` / `Argon` / `Krypton`）。
 * @param {string} labelOrId 模型显示名或云端 slug
 * @returns {string}
 */
export function extractOrchestratorTarget(labelOrId) {
  const s = String(labelOrId || "").trim();
  if (!s) return "";
  const parenMatch = /^orchestrator\s*\(([^)]+)\)$/i.exec(s);
  if (parenMatch) {
    return parenMatch[1].trim().toLowerCase();
  }
  if (/orchestrator.*g1-pro|^orchestrator-argon$/i.test(s)) {
    return "argon";
  }
  const slugMatch = /orchestrator[-_]([a-z0-9][a-z0-9._-]*)$/i.exec(s);
  if (slugMatch) {
    const raw = slugMatch[1]
      .toLowerCase()
      .replace(/^g\d+[-_](?=[a-z])/i, "")
      .replace(/[-_]+/g, " ")
      .trim();
    return raw === "pro" ? "argon" : raw;
  }
  return "";
}

function matchesModelTargetTokens(text, target) {
  const cleanTarget = String(target || "").trim().toLowerCase();
  if (!cleanTarget) return false;
  const tokens = cleanTarget.split(/[^a-z0-9.]+/i).filter(Boolean);
  if (tokens.length === 0) return false;
  const hay = String(text || "");
  return tokens.every((tok) => {
    const escaped = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9.])${escaped}([^a-z0-9.]|$)`, "i").test(hay);
  });
}

/**
 * 判断模型是否仅限 Argon 权限账号访问（精确限定 Argon 与 Orchestrator (Argon)，不误伤其他 Orchestrator）。
 * @param {string} labelOrId 模型显示名、slug 或占位符
 * @returns {boolean}
 */
export function isArgonGatedLabelOrId(labelOrId) {
  return /\bargon\b|orchestrator.*g1-pro|\bmodel_placeholder_m(417|418|419|421|668)\b|^orchestrator-argon$/i.test(
    String(labelOrId || "").trim()
  );
}

/**
 * 解析云端内部模型 ID（含无 displayName 或新上架模型）对应的 Antigravity 原生模型家族展示名。
 * @param {string} modelKey 云端模型 slug 或占位符
 * @param {object|null} modelObj 可选的模型元数据对象
 * @param {object|null} regInput 动态模型注册表对象
 * @returns {string}
 */
export function resolveFamilyForCloudSlug(modelKey, modelObj = null, regInput = null) {
  const rawKey = String(modelKey || "").trim();
  if (!rawKey || isLegacyDeprecatedModel(rawKey)) return "";
  const lowerKey = rawKey.toLowerCase();
  const reg = regInput || globalThis.__agyDynamicModelRegistryRef || {};

  const regFam = reg.placeholderToFamily?.[lowerKey];
  if (regFam) {
    const kOrch = (!/^model_(placeholder|openai)_/i.test(lowerKey) && !/g1-pro/i.test(lowerKey))
      ? extractOrchestratorTarget(lowerKey)
      : "";
    const fOrch = extractOrchestratorTarget(regFam);
    if (!(kOrch && fOrch && kOrch !== fOrch)) {
      return stripModelVariantSuffix(regFam);
    }
  }
  if (/^gemini-pro-orchestrator-g1-pro$|orchestrator.*g1-pro|^orchestrator-argon$/i.test(lowerKey)) {
    return "Orchestrator (Argon)";
  }

  const aliasId = String(modelObj?.modelOrAlias?.model || modelObj?.modelOrAlias?.alias || modelObj?.model || "").trim().toLowerCase();
  if (aliasId && reg.placeholderToFamily?.[aliasId]) {
    return stripModelVariantSuffix(reg.placeholderToFamily[aliasId]);
  }

  const rawDisplay = String(modelObj?.displayName || modelObj?.label || "").trim();
  const hasRichDisplay = Boolean(
    rawDisplay &&
    rawDisplay.toLowerCase() !== lowerKey &&
    (/[\s()]/.test(rawDisplay) || /[A-Z]/.test(rawDisplay))
  );
  if (hasRichDisplay) {
    return stripModelVariantSuffix(rawDisplay);
  }

  const catalog = Array.isArray(reg.clientCatalog) ? reg.clientCatalog : [];
  if (catalog.length > 0) {
    for (const item of catalog) {
      if (Array.isArray(item?.variantIds) && item.variantIds.some((v) => String(v).toLowerCase() === lowerKey)) {
        return item.label;
      }
    }
    const slugTokensList = extractDistinctiveModelTokens(lowerKey);
    const slugTokens = new Set(slugTokensList);
    const slugIsOrch = slugTokens.has("orchestrator");
    const slugVerTokens = slugTokensList.filter((t) => /^\d+(?:\.\d+)?$/.test(t));
    const mReset = String(modelObj?.quotaInfo?.resetTime || "").trim();
    const mFrac = modelObj?.quotaInfo?.remainingFraction;
    let bestLabel = "";
    let bestScore = 0;
    let tied = false;
    for (const item of catalog) {
      if (!item?.label) continue;
      const catTokens = extractDistinctiveModelTokens(item.label);
      const catIsOrch = catTokens.includes("orchestrator");
      if (slugIsOrch !== catIsOrch) continue;
      if (slugIsOrch) {
        const catTargetTokens = catTokens.filter((t) => t !== "orchestrator");
        const targetOverlap = catTargetTokens.filter((t) => slugTokens.has(t)).length;
        if (catTargetTokens.length === 0 || targetOverlap === 0) continue;
      }
      const catVerTokens = catTokens.filter((t) => /^\d+(?:\.\d+)?$/.test(t));
      if (slugVerTokens.length > 0 && catVerTokens.length > 0) {
        const verMismatch = slugVerTokens.some((sv) => !catVerTokens.includes(sv));
        if (verMismatch) continue;
      }
      let overlap = 0;
      for (const t of catTokens) {
        if (slugTokens.has(t)) overlap++;
      }
      if (overlap === 0) continue;
      let score = overlap * 10;
      if (mReset && item.quotaFingerprint?.resetTime && mReset === item.quotaFingerprint.resetTime) {
        score += 5;
        if (mFrac !== undefined && item.quotaFingerprint.remainingFraction === mFrac) {
          score += 2;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestLabel = item.label;
        tied = false;
      } else if (score === bestScore) {
        tied = true;
      }
    }
    if (bestLabel && !tied && bestScore >= 10) {
      return bestLabel;
    }
  }

  const orchTarget = extractOrchestratorTarget(lowerKey);
  if (orchTarget) {
    const matchedCat = catalog.find((item) => extractOrchestratorTarget(item?.label || "") === orchTarget);
    if (matchedCat?.label) return matchedCat.label;
    const titled = orchTarget
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
    if (titled) return `Orchestrator (${titled})`;
  }
  return "";
}

/**
 * 运行时自学习真实观测到的上游模型 Wire Slug 与所属模型家族映射，同时清理旧 Guessing Slug。
 * @param {object} cfg 配置对象
 * @param {string} rawModel 真实请求或响应中的模型 slug
 * @param {string} baseFamily 解析出的标准模型家族名
 * @returns {boolean} 是否变更了注册表
 */
export function learnObservedWireSlugForFamily(cfg, rawModel, baseFamily) {
  const raw = String(rawModel || "").trim();
  const baseFam = stripModelVariantSuffix(String(baseFamily || "").trim());
  if (
    !cfg ||
    !raw ||
    !baseFam ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(raw) ||
    /^model_(placeholder|openai)_/i.test(raw) ||
    isGuessedOrchestratorSlug(raw) ||
    /disabled$/i.test(raw) ||
    isLegacyDeprecatedModel(raw) ||
    isLegacyDeprecatedModel(baseFam)
  ) {
    return false;
  }
  const reg = ensureDynamicModelRegistry(cfg);
  let changed = false;
  const lowerRaw = raw.toLowerCase();
  const baseLower = baseFam.toLowerCase();
  const isOrchFam = Boolean(extractOrchestratorTarget(baseFam));

  if (reg.placeholderToFamily[lowerRaw] !== baseFam) {
    reg.placeholderToFamily[lowerRaw] = baseFam;
    changed = true;
  }
  const prevSlug = reg.labelToSlug[baseLower];
  if (!prevSlug || isGuessedOrchestratorSlug(prevSlug) || (isOrchFam && prevSlug !== raw)) {
    if (prevSlug !== raw) {
      reg.labelToSlug[baseLower] = raw;
      changed = true;
    }
  }
  for (const [ph, fam] of Object.entries(reg.placeholderToFamily)) {
    if (String(fam || "").trim() === baseFam && /^model_(placeholder|openai)_/i.test(ph)) {
      const curPhSlug = reg.placeholderToSlug[ph];
      if (!curPhSlug || isGuessedOrchestratorSlug(curPhSlug) || (isOrchFam && curPhSlug !== raw)) {
        if (curPhSlug !== raw) {
          reg.placeholderToSlug[ph] = raw;
          changed = true;
        }
      }
    }
  }
  for (const catItem of reg.clientCatalog) {
    if (catItem?.label === baseFam) {
      const prevVars = Array.isArray(catItem.variantIds) ? catItem.variantIds : [baseFam];
      const cleanedVars = prevVars.filter((v) => v && !isGuessedOrchestratorSlug(v));
      if (!cleanedVars.includes(raw)) cleanedVars.push(raw);
      if (JSON.stringify(prevVars) !== JSON.stringify(cleanedVars)) {
        catItem.variantIds = cleanedVars;
        changed = true;
      }
    }
  }
  return changed;
}

export function ensureDynamicModelRegistry(cfg) {
  if (!cfg || typeof cfg !== "object") {
    return { placeholderToSlug: {}, placeholderToFamily: {}, labelToSlug: {}, clientCatalog: [] };
  }
  if (!cfg.__meta__ || typeof cfg.__meta__ !== "object") cfg.__meta__ = {};
  if (!cfg.__meta__.dynamicModelRegistry || typeof cfg.__meta__.dynamicModelRegistry !== "object") {
    cfg.__meta__.dynamicModelRegistry = {
      placeholderToSlug: {},
      placeholderToFamily: {},
      labelToSlug: {},
      clientCatalog: []
    };
  }
  const reg = cfg.__meta__.dynamicModelRegistry;
  if (!reg.placeholderToSlug) reg.placeholderToSlug = {};
  if (!reg.placeholderToFamily) reg.placeholderToFamily = {};
  if (!reg.labelToSlug) reg.labelToSlug = {};
  if (!Array.isArray(reg.clientCatalog)) reg.clientCatalog = [];

  for (const [k, fam] of Object.entries(reg.placeholderToFamily)) {
    if (isLegacyDeprecatedModel(k) || isLegacyDeprecatedModel(fam)) {
      delete reg.placeholderToFamily[k];
      continue;
    }
    if (isGuessedOrchestratorSlug(k) && k.toLowerCase() !== "orchestrator-argon") {
      delete reg.placeholderToFamily[k];
      continue;
    }
    if (/orchestrator/i.test(k) && !/^model_(placeholder|openai)_/i.test(k) && !/g1-pro/i.test(k)) {
      const kTarget = extractOrchestratorTarget(k);
      const famTarget = extractOrchestratorTarget(fam);
      if (kTarget && famTarget && kTarget !== famTarget) {
        delete reg.placeholderToFamily[k];
        continue;
      }
    }
    const cleanFam = stripModelVariantSuffix(fam);
    if (cleanFam && cleanFam !== fam) {
      reg.placeholderToFamily[k] = cleanFam;
    }
  }
  for (const [lbl, slug] of Object.entries(reg.labelToSlug)) {
    if (isLegacyDeprecatedModel(lbl) || isLegacyDeprecatedModel(slug)) {
      delete reg.labelToSlug[lbl];
      continue;
    }
    if (isGuessedOrchestratorSlug(slug)) {
      const replacement = deriveCloudCodeSlugFromLabel(lbl);
      if (replacement && !isGuessedOrchestratorSlug(replacement)) {
        reg.labelToSlug[lbl] = replacement;
      } else {
        delete reg.labelToSlug[lbl];
      }
    }
  }
  for (const [k, slug] of Object.entries(reg.placeholderToSlug)) {
    if (isLegacyDeprecatedModel(k) || isLegacyDeprecatedModel(slug)) {
      delete reg.placeholderToSlug[k];
      continue;
    }
    if (isGuessedOrchestratorSlug(slug)) {
      const famName = reg.placeholderToFamily[k] || "";
      const mapped = famName ? reg.labelToSlug[famName.toLowerCase()] : "";
      const replacement = (mapped && !isGuessedOrchestratorSlug(mapped))
        ? mapped
        : deriveCloudCodeSlugFromLabel(famName);
      if (replacement && !isGuessedOrchestratorSlug(replacement)) {
        reg.placeholderToSlug[k] = replacement;
      } else {
        delete reg.placeholderToSlug[k];
      }
    }
  }
  for (const catItem of reg.clientCatalog) {
    if (!catItem) continue;
    catItem.requiresArgon = isArgonGatedLabelOrId(catItem.label);
    if (Array.isArray(catItem.variantIds)) {
      catItem.variantIds = catItem.variantIds.filter(
        (v) => v && !isLegacyDeprecatedModel(v) && !isGuessedOrchestratorSlug(v)
      );
    } else {
      catItem.variantIds = [catItem.label].filter(Boolean);
    }
    const knownSlug = reg.labelToSlug[(catItem.label || "").toLowerCase()];
    if (knownSlug && !isGuessedOrchestratorSlug(knownSlug) && !catItem.variantIds.includes(knownSlug)) {
      catItem.variantIds.push(knownSlug);
    }
  }

  // 修正并固化 Orchestrator (Argon) 占位符与云端模型 ID 映射，避免误推导为 orchestrator-argon
  if (!reg.placeholderToSlug["model_placeholder_m668"] || reg.placeholderToSlug["model_placeholder_m668"] === "orchestrator-argon") {
    reg.placeholderToSlug["model_placeholder_m668"] = "gemini-pro-orchestrator-g1-pro";
  }
  if (!reg.labelToSlug["orchestrator (argon)"] || reg.labelToSlug["orchestrator (argon)"] === "orchestrator-argon") {
    reg.labelToSlug["orchestrator (argon)"] = "gemini-pro-orchestrator-g1-pro";
  }
  reg.placeholderToFamily["model_placeholder_m668"] = "Orchestrator (Argon)";
  reg.placeholderToFamily["gemini-pro-orchestrator-g1-pro"] = "Orchestrator (Argon)";
  reg.placeholderToFamily["orchestrator-argon"] = "Orchestrator (Argon)";

  globalThis.__agyDynamicModelRegistryRef = reg;
  return reg;
}

export function learnModelsFromCloudCodeResponse(cfg, rawModelsResp) {
  const modelsObj = rawModelsResp?.models;
  if (!modelsObj || typeof modelsObj !== "object") return false;
  const reg = ensureDynamicModelRegistry(cfg);
  let changed = false;
  for (const [modelKey, m] of Object.entries(modelsObj)) {
    if (!m || typeof m !== "object" || /disabled$/i.test(modelKey) || isLegacyDeprecatedModel(modelKey)) continue;
    const lowerKey = modelKey.toLowerCase();
    const rawLabel = String(m.displayName || m.label || "").trim();
    const baseFamily = resolveFamilyForCloudSlug(modelKey, m, reg);
    if (!baseFamily || isLegacyDeprecatedModel(baseFamily) || (rawLabel && isLegacyDeprecatedModel(rawLabel))) continue;

    if (rawLabel && rawLabel.toLowerCase() !== lowerKey) {
      const lowerLabel = rawLabel.toLowerCase();
      if (reg.labelToSlug[lowerLabel] !== modelKey) {
        reg.labelToSlug[lowerLabel] = modelKey;
        changed = true;
      }
    }
    const baseLower = baseFamily.toLowerCase();
    if (!stripModelVariantSuffix(modelKey).includes(modelKey) || !/\((Low|Medium|High|XHigh|Extra|Max)\)$/i.test(rawLabel)) {
      if (!reg.labelToSlug[baseLower] || isGuessedOrchestratorSlug(reg.labelToSlug[baseLower])) {
        reg.labelToSlug[baseLower] = modelKey;
        changed = true;
      }
    }
    if (reg.placeholderToFamily[lowerKey] !== baseFamily) {
      reg.placeholderToFamily[lowerKey] = baseFamily;
      changed = true;
    }
    const famSlug = deriveCloudCodeSlugFromLabel(baseFamily);
    if (famSlug && !isGuessedOrchestratorSlug(famSlug) && reg.placeholderToFamily[famSlug] !== baseFamily) {
      reg.placeholderToFamily[famSlug] = baseFamily;
      changed = true;
    }
    for (const catItem of reg.clientCatalog) {
      if (catItem?.label === baseFamily && Array.isArray(catItem.variantIds) && !catItem.variantIds.includes(modelKey)) {
        catItem.variantIds.push(modelKey);
        changed = true;
      }
    }
  }
  return changed;
}

export function learnModelsFromLsClientConfigs(cfg, clientModelConfigs, opts = {}) {
  if (!Array.isArray(clientModelConfigs) || clientModelConfigs.length === 0) return false;
  const reg = ensureDynamicModelRegistry(cfg);
  let changed = false;
  const isPersonal = Boolean(opts?.isPersonal);
  const catalogMap = new Map();

  for (const m of clientModelConfigs) {
    if (!m || typeof m !== "object") continue;
    const rawLabel = String(m.label || m.displayName || "").trim();
    const modelId = String(m.modelOrAlias?.model || m.modelOrAlias?.alias || m.model || "").trim();
    if (!rawLabel || !modelId || isLegacyDeprecatedModel(rawLabel) || isLegacyDeprecatedModel(modelId)) continue;
    const baseFamily = stripModelVariantSuffix(rawLabel);
    if (!baseFamily || isLegacyDeprecatedModel(baseFamily)) continue;

    const lowerId = modelId.toLowerCase();
    const lowerLabel = rawLabel.toLowerCase();
    const rawNativeSlug = String(m.modelId || "").trim();
    const validNativeSlug = (
      rawNativeSlug &&
      !/disabled$/i.test(rawNativeSlug) &&
      !/^model_(placeholder|openai)_/i.test(rawNativeSlug) &&
      !isLegacyDeprecatedModel(rawNativeSlug) &&
      !isGuessedOrchestratorSlug(rawNativeSlug)
    ) ? rawNativeSlug : "";
    const existingLabelSlug = isGuessedOrchestratorSlug(reg.labelToSlug[lowerLabel]) ? "" : reg.labelToSlug[lowerLabel];
    const existingPhSlug = isGuessedOrchestratorSlug(reg.placeholderToSlug[lowerId]) ? "" : reg.placeholderToSlug[lowerId];
    const derivedSlug = deriveCloudCodeSlugFromLabel(rawLabel);
    const cloudSlug = validNativeSlug || existingLabelSlug || existingPhSlug || derivedSlug;

    if (reg.placeholderToFamily[lowerId] !== baseFamily) {
      reg.placeholderToFamily[lowerId] = baseFamily;
      changed = true;
    }
    if (validNativeSlug) {
      if (reg.placeholderToSlug[lowerId] !== validNativeSlug) {
        reg.placeholderToSlug[lowerId] = validNativeSlug;
        changed = true;
      }
      if (reg.labelToSlug[lowerLabel] !== validNativeSlug) {
        reg.labelToSlug[lowerLabel] = validNativeSlug;
        changed = true;
      }
      if (lowerLabel === baseFamily.toLowerCase() && reg.labelToSlug[baseFamily.toLowerCase()] !== validNativeSlug) {
        reg.labelToSlug[baseFamily.toLowerCase()] = validNativeSlug;
        changed = true;
      }
    } else {
      if (cloudSlug && !existingPhSlug) {
        reg.placeholderToSlug[lowerId] = cloudSlug;
        changed = true;
      }
      if (cloudSlug && !existingLabelSlug) {
        reg.labelToSlug[lowerLabel] = cloudSlug;
        changed = true;
      }
    }
    if (cloudSlug && !isGuessedOrchestratorSlug(cloudSlug) && reg.placeholderToFamily[cloudSlug.toLowerCase()] !== baseFamily) {
      reg.placeholderToFamily[cloudSlug.toLowerCase()] = baseFamily;
      changed = true;
    }
    const famSlug = deriveCloudCodeSlugFromLabel(baseFamily);
    if (famSlug && !isGuessedOrchestratorSlug(famSlug) && reg.placeholderToFamily[famSlug] !== baseFamily) {
      reg.placeholderToFamily[famSlug] = baseFamily;
      changed = true;
    }

    if (isPersonal && !isModelEntryRestrictedOrSunset(m) && !isGcpOnlyModel(baseFamily) && !isGcpOnlyModel(modelId)) {
      const candidateVars = [baseFamily, rawLabel, modelId, cloudSlug].filter(
        (v) => v && !isGuessedOrchestratorSlug(v)
      );
      const baseSlug = reg.labelToSlug[baseFamily.toLowerCase()];
      if (baseSlug && !isGuessedOrchestratorSlug(baseSlug)) candidateVars.push(baseSlug);
      if (!catalogMap.has(baseFamily)) {
        catalogMap.set(baseFamily, {
          label: baseFamily,
          variantIds: Array.from(new Set(candidateVars)),
          requiresArgon: isArgonGatedLabelOrId(baseFamily),
          quotaFingerprint: m.quotaInfo
            ? {
                resetTime: String(m.quotaInfo.resetTime || ""),
                remainingFraction: m.quotaInfo.remainingFraction
              }
            : null
        });
      } else {
        const entry = catalogMap.get(baseFamily);
        for (const v of candidateVars) {
          if (!entry.variantIds.includes(v)) entry.variantIds.push(v);
        }
        if (!entry.quotaFingerprint && m.quotaInfo) {
          entry.quotaFingerprint = {
            resetTime: String(m.quotaInfo.resetTime || ""),
            remainingFraction: m.quotaInfo.remainingFraction
          };
        }
      }
    }
  }

  if (isPersonal && catalogMap.size > 0) {
    const prevByLabel = new Map((reg.clientCatalog || []).map((item) => [item?.label, item]));
    const nextCatalog = Array.from(catalogMap.values()).map((item) => {
      const prev = prevByLabel.get(item.label);
      const mergedVars = prev?.variantIds
        ? Array.from(new Set([...item.variantIds, ...prev.variantIds.filter((v) => v && !isGuessedOrchestratorSlug(v))]))
        : item.variantIds;
      return { ...item, variantIds: mergedVars };
    });
    if (JSON.stringify(reg.clientCatalog) !== JSON.stringify(nextCatalog)) {
      reg.clientCatalog = nextCatalog;
      changed = true;
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

/**
 * 解析上游 CloudCode / OAuth HTTP 错误与 loadCodeAssist 受限响应，完整保留 status、reason、validationUrl 等诊断信息
 */
export function parseCloudCodeApiError(resp, endpoint = "") {
  if (!resp) return null;
  const errObj = Array.isArray(resp.data)
    ? resp.data[0]?.error
    : (resp.data?.error && typeof resp.data.error === "object" ? resp.data.error : null);
  const status = Number(errObj?.code || resp.status || 0);
  const apiStatus = String(errObj?.status || "").trim();
  const rawDetails = Array.isArray(errObj?.details) ? errObj.details : [];
  const ineligibleTiers = Array.isArray(resp.data?.ineligibleTiers) ? resp.data.ineligibleTiers : [];

  let reason = "";
  let validationUrl = "";
  let detailMessage = "";
  const helpLinks = [];

  for (const d of rawDetails) {
    if (!d || typeof d !== "object") continue;
    if (!reason && d.reason) {
      reason = String(d.reason).trim();
    }
    const meta = d.metadata && typeof d.metadata === "object" ? d.metadata : null;
    if (meta) {
      if (!validationUrl) {
        const candUrl = String(meta.validation_url || meta.validationUrl || meta.appeal_url || meta.url || "").trim();
        if (/^https?:\/\//i.test(candUrl)) validationUrl = candUrl;
      }
      if (!detailMessage) {
        const metaMsg = String(meta.validation_error_message || meta.message || "").trim();
        if (metaMsg) detailMessage = metaMsg;
      }
    }
    if (Array.isArray(d.links)) {
      for (const lnk of d.links) {
        const lUrl = String(lnk?.url || "").trim();
        const lDesc = String(lnk?.description || "").trim();
        if (/^https?:\/\//i.test(lUrl)) {
          helpLinks.push({ description: lDesc, url: lUrl });
          if (!validationUrl && /accounts\.google\.com|myaccount\.google\.com|support\.google\.com|one\.google\.com/i.test(lUrl)) {
            validationUrl = lUrl;
          }
        }
      }
    }
  }

  for (const tierItem of ineligibleTiers) {
    if (!tierItem || typeof tierItem !== "object") continue;
    if (!reason && tierItem.reasonCode) reason = String(tierItem.reasonCode).trim();
    if (!detailMessage && tierItem.reasonMessage) detailMessage = String(tierItem.reasonMessage).trim();
    const vUrl = String(tierItem.validationUrl || "").trim();
    if (!validationUrl && /^https?:\/\//i.test(vUrl)) validationUrl = vUrl;
  }

  const rawBodyMsg = String(
    errObj?.message ||
    resp.data?.error_description ||
    resp.data?.message ||
    resp.error ||
    (resp.raw ? String(resp.raw).replace(/\s+/g, " ").trim() : "") ||
    apiStatus ||
    ""
  ).trim();

  if (!validationUrl) {
    const urlMatch = /https:\/\/[^\s"'<>]+/i.exec(`${detailMessage} ${rawBodyMsg}`);
    if (urlMatch) validationUrl = urlMatch[0].replace(/[.,;)]+$/, "");
  }

  if (!reason && /#3501|valid license/i.test(rawBodyMsg)) {
    reason = "#3501";
  }

  const combined = `${reason} ${apiStatus} ${rawBodyMsg} ${detailMessage}`.trim();
  let category = "upstream_error";
  if (status === 401 || /invalid_grant|UNAUTHENTICATED|invalid authentication/i.test(combined)) {
    category = "auth_expired";
  } else if (/#3501|valid license/i.test(combined)) {
    category = "license_3501";
  } else if (/VALIDATION_REQUIRED|verify your account|validation_url/i.test(combined) || Boolean(validationUrl)) {
    category = "validation_required";
    if (!reason) reason = "VALIDATION_REQUIRED";
  } else if (/SERVICE_DISABLED/i.test(combined)) {
    category = "api_disabled";
  } else if (status === 429 || /RESOURCE_EXHAUSTED|rate limit|quota/i.test(combined)) {
    category = "quota_exhausted";
  } else if (status === 403 || /PERMISSION_DENIED|not eligible|country|region|unsupported/i.test(combined)) {
    category = "region_or_eligibility";
  } else if (status < 0 || /timeout|ECONN|ETIMEDOUT|ENOTFOUND|socket|network/i.test(combined)) {
    category = "network_error";
  }

  const message = rawBodyMsg
    ? (status > 0 && !new RegExp(`^HTTP\\s+${status}\\b`, "i").test(rawBodyMsg)
        ? `HTTP ${status}: ${rawBodyMsg}`
        : rawBodyMsg).slice(0, 600)
    : (status > 0 ? `HTTP ${status}` : "");

  if (!message && !detailMessage && !validationUrl && status === 0) return null;
  return {
    status,
    apiStatus,
    reason,
    category,
    endpoint: String(endpoint || "").trim(),
    message,
    detailMessage: detailMessage && detailMessage !== rawBodyMsg ? detailMessage.slice(0, 400) : "",
    validationUrl,
    helpLinks: helpLinks.slice(0, 4)
  };
}

function detectArgonAccessFromModels(rawModelsListOrMap, tierCode = "Unknown", prevHasArgon = undefined) {
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
    if (prevHasArgon !== undefined) return Boolean(prevHasArgon);
    return tierCode === "Ultra" || tierCode === "Pro";
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
  } else if (/\bfree\b|standard-tier|free-tier|legacy-tier|basic-tier|individual-tier|starter[-_ ]?quota|starter[-_ ]?tier|\bstarter\b|no[-_ ]?tier|unsubscribed/i.test(combinedTier)) {
    tierCode = "Free";
    tierName = "Google AI Free";
  } else if (prevTierCode && /^(Ultra|Pro|Plus|Free)$/i.test(prevTierCode)) {
    const norm = prevTierCode.charAt(0).toUpperCase() + prevTierCode.slice(1).toLowerCase();
    tierCode = norm;
    tierName = `Google AI ${norm}`;
  } else {
    tierCode = "Unknown";
    tierName = "Unknown";
  }

  const hasArgonAccess = detectArgonAccessFromModels(rawModelsListOrMap, tierCode, prevHasArgon);
  return {
    tierCode,
    tierName,
    hasArgonAccess,
    isPaidProOrUltra: tierCode === "Ultra" || tierCode === "Pro"
  };
}

/**
 * 结合 Antigravity 原生客户端目录与当前账号权限（hasArgonAccess），补全并规范个人账号可用模型列表。
 * 既保留每个账号独立云端探测得到的专属可用集，又确保如 Orchestrator (Argon) 等客户端派生/同池模型在所有达标账号中自动识别、排序与关联变体。
 * @param {Array} sourceModels 原始模型数组
 * @param {boolean} hasArgonAccess 账号是否具备 Argon 权限
 * @param {boolean} _isPaidProOrUltra 是否付费 Pro/Ultra 等级
 * @param {object|null} cfg 可选配置对象
 * @returns {Array}
 */
export function mergeNativeCatalogIntoPersonalModels(
  sourceModels = [],
  hasArgonAccess = true,
  _isPaidProOrUltra = true,
  cfg = null
) {
  const reg = (cfg && ensureDynamicModelRegistry(cfg)) || globalThis.__agyDynamicModelRegistryRef || {};
  const catalog = Array.isArray(reg.clientCatalog) ? reg.clientCatalog : [];
  const mergedMap = new Map();

  const addOrMergeModel = (item) => {
    if (!item || typeof item !== "object") return;
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
    if (!hasArgonAccess && isArgonGatedLabelOrId(baseLabel)) return;

    const existingVars = Array.isArray(item.variantIds) ? item.variantIds : [baseLabel, rawLabel];
    const extraVars = [];
    const regSlug = reg.labelToSlug?.[baseLabel.toLowerCase()];
    if (regSlug && !isGuessedOrchestratorSlug(regSlug)) {
      extraVars.push(regSlug);
    }
    if (/^orchestrator\s*\(argon\)$/i.test(baseLabel)) {
      extraVars.push("Orchestrator (Argon)", "MODEL_PLACEHOLDER_M668", "gemini-pro-orchestrator-g1-pro");
    }
    const cleanVars = Array.from(new Set([baseLabel, rawLabel, ...existingVars, ...extraVars])).filter(
      (v) => v && !isGuessedOrchestratorSlug(v) && !isLegacyDeprecatedModel(v) && !isGcpOnlyModel(v)
    );

    if (!mergedMap.has(baseLabel)) {
      mergedMap.set(baseLabel, {
        ...item,
        label: baseLabel,
        modelId: baseLabel,
        variantIds: cleanVars
      });
    } else {
      const existing = mergedMap.get(baseLabel);
      for (const v of cleanVars) {
        if (!existing.variantIds.includes(v)) existing.variantIds.push(v);
      }
      if (existing.remainingPct === undefined && item.remainingPct !== undefined) {
        existing.remainingPct = item.remainingPct;
      }
      if (!existing.resetTime && item.resetTime) {
        existing.resetTime = item.resetTime;
      }
      if (existing.weeklyPct === undefined && item.weeklyPct !== undefined) {
        existing.weeklyPct = item.weeklyPct;
      }
      if (!existing.weeklyResetTime && item.weeklyResetTime) {
        existing.weeklyResetTime = item.weeklyResetTime;
      }
      if (existing.fiveHourPct === undefined && item.fiveHourPct !== undefined) {
        existing.fiveHourPct = item.fiveHourPct;
      }
      if (!existing.fiveHourResetTime && item.fiveHourResetTime) {
        existing.fiveHourResetTime = item.fiveHourResetTime;
      }
    }
  };

  for (const m of Array.isArray(sourceModels) ? sourceModels : []) {
    addOrMergeModel(m);
  }

  // 动态同步原生目录中的全部 Orchestrator (<目标>) 编排模型：只要当前账号实测具备对应底层模型家族（且通过 Argon 门控），自动补全
  const accountBaseLabels = Array.from(mergedMap.keys()).filter((lbl) => !extractOrchestratorTarget(lbl));
  for (const catItem of catalog) {
    const orchTarget = extractOrchestratorTarget(catItem?.label || "");
    if (!orchTarget) continue;
    if (isArgonGatedLabelOrId(catItem.label) && !hasArgonAccess) continue;
    const hasUnderlying = accountBaseLabels.some((lbl) => matchesModelTargetTokens(lbl, orchTarget));
    if (hasUnderlying) {
      addOrMergeModel({
        label: catItem.label,
        modelId: catItem.label,
        variantIds: catItem.variantIds || [catItem.label],
        unlimited: false
      });
    }
  }
  if (catalog.length === 0 && hasArgonAccess && accountBaseLabels.some((lbl) => /\bargon\b/i.test(lbl))) {
    addOrMergeModel({
      label: "Orchestrator (Argon)",
      modelId: "Orchestrator (Argon)",
      variantIds: [
        "Orchestrator (Argon)",
        "MODEL_PLACEHOLDER_M668",
        "gemini-pro-orchestrator-g1-pro"
      ],
      unlimited: false
    });
  }

  // 若原生目录已知顺序，优先按原生 UI 顺序排列已命中的模型
  const ordered = [];
  const emitted = new Set();
  for (const catItem of catalog) {
    const key = catItem?.label;
    if (key && mergedMap.has(key) && !emitted.has(key)) {
      ordered.push(mergedMap.get(key));
      emitted.add(key);
    }
  }
  for (const [key, val] of mergedMap.entries()) {
    if (!emitted.has(key)) {
      ordered.push(val);
      emitted.add(key);
    }
  }

  // 确保 Orchestrator (Argon) 紧随 Gemini 4 Hydrogen / Gemini 4 Argon 之后（若未在 clientCatalog 确定位置）
  if (catalog.length === 0) {
    const orchIdx = ordered.findIndex((m) => /^orchestrator\s*\(argon\)$/i.test(m.label));
    if (orchIdx >= 0) {
      const [orchItem] = ordered.splice(orchIdx, 1);
      const hydIdx = ordered.findIndex((m) => /^gemini\s*4\s*hydrogen$/i.test(m.label));
      const argIdx = ordered.findIndex((m) => /^gemini\s*4\s*argon$/i.test(m.label));
      const targetIdx = hydIdx >= 0 ? hydIdx + 1 : (argIdx >= 0 ? argIdx + 1 : ordered.length);
      ordered.splice(targetIdx, 0, orchItem);
    }
  }

  return ordered;
}

/**
 * 4 层动态配额分组匹配器：精确描述命中 -> Orchestrator 目标词匹配分组名/描述 -> resetTime 桶指纹 -> 关键词兜底。
 * @param {Array} groups 官方 quotaGroups 列表
 * @param {string} label 模型家族名或 ID
 * @param {object|null} item 可选模型项（含 resetTime / remainingPct）
 * @returns {object|null}
 */
export function findQuotaGroupForModel(groups, label, item = null) {
  const grpList = Array.isArray(groups) ? groups : [];
  if (grpList.length === 0) return null;
  const clean = String(label || item?.label || item?.modelId || "").trim().toLowerCase();
  const geminiGroup = grpList.find((g) => /gemini\s*models/i.test(g.id || g.displayName || ""));
  const claudeGroup = grpList.find((g) => /claude|gpt/i.test(g.id || g.displayName || ""));
  const argonGroup = grpList.find((g) => /\bargon\b/i.test(g.id || g.displayName || ""));

  if (clean) {
    for (const g of grpList) {
      const desc = String(g.description || "").toLowerCase();
      const gName = String(g.displayName || g.id || "").toLowerCase();
      if (desc.includes(clean) || gName === clean) {
        return g;
      }
    }

    const target = extractOrchestratorTarget(clean);
    if (target) {
      for (const g of grpList) {
        if (matchesModelTargetTokens(g.displayName || g.id || "", target)) {
          return g;
        }
      }
      for (const g of grpList) {
        if (matchesModelTargetTokens(g.description || "", target)) {
          return g;
        }
      }
    }
  }

  const itemReset = String(item?.resetTime || "").trim();
  if (itemReset) {
    const exactHit = grpList.find((g) =>
      (g.buckets || []).some(
        (b) => b.resetTime && b.resetTime === itemReset && (item.remainingPct === undefined || b.remainingPct === item.remainingPct)
      )
    );
    if (exactHit) return exactHit;

    const resetOnlyHits = grpList.filter((g) =>
      (g.buckets || []).some((b) => b.resetTime && b.resetTime === itemReset)
    );
    if (resetOnlyHits.length === 1) return resetOnlyHits[0];
  }

  if (clean) {
    if (isArgonGatedLabelOrId(clean)) return argonGroup || geminiGroup || null;
    if (/gemini/i.test(clean)) return geminiGroup || null;
    if (/claude|gpt/i.test(clean)) return claudeGroup || null;
    if (/orchestrator/i.test(clean)) return geminiGroup || null;
  }

  return null;
}

export function buildProModelsFromQuotaGroups(
  quotaGroups,
  prevModels = [],
  dynamicApiModels = [],
  liveTierTemplate = [],
  hasArgonAccess = true,
  cfg = null
) {
  const groups = Array.isArray(quotaGroups) ? quotaGroups : [];

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

  const matchGroupInfoForModel = (label, item = null) => {
    const grp = findQuotaGroupForModel(groups, label, item);
    return grp ? extractGroupDualBuckets(grp) : null;
  };

  // 基于本次真实 API 返回的可用模型列表，并按 hasArgonAccess 权限合入原生同池客户端模型
  const sourceModels = mergeNativeCatalogIntoPersonalModels(
    Array.isArray(dynamicApiModels) ? dynamicApiModels : [],
    hasArgonAccess,
    true,
    cfg
  );

  return sourceModels.map((tpl) => {
    const grpInfo = matchGroupInfoForModel(tpl.label, tpl);
    const matchedBk = grpInfo?.primary || null;
    const wkBk = grpInfo?.weeklyBucket || null;
    const fhBk = grpInfo?.fiveHourBucket || null;
    const pct = matchedBk?.remainingPct ?? tpl.remainingPct ?? 100;
    const rst = matchedBk?.resetTime || tpl.resetTime || "";
    const weeklyPct = wkBk?.remainingPct ?? tpl.weeklyPct ?? pct;
    const weeklyResetTime = wkBk?.resetTime || tpl.weeklyResetTime || rst;
    const fiveHourPct = fhBk?.remainingPct ?? tpl.fiveHourPct ?? pct;
    const fiveHourResetTime = fhBk?.resetTime || tpl.fiveHourResetTime || rst;

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

export function sanitizeCachedQuotaModels(
  cachedQuota,
  isGcp,
  liveTierTemplate = [],
  hintTierName = "",
  hintTierId = "",
  preferHint = false
) {
  if (!cachedQuota || typeof cachedQuota !== "object") return cachedQuota;
  const rawList = Array.isArray(cachedQuota.availableModels) ? cachedQuota.availableModels : [];
  const hasHint = Boolean(preferHint && (hintTierName || hintTierId));
  const tierInfo = isGcp
    ? { tierCode: "GCP", tierName: hintTierName || "Agent Platform", hasArgonAccess: true, isPaidProOrUltra: false }
    : detectPersonalAccountTier(
        rawList,
        hasHint ? (hintTierName || "") : (cachedQuota.tierName || hintTierName || ""),
        hasHint ? (hintTierId || "") : (hintTierId || cachedQuota.tierCode || ""),
        hasHint ? undefined : cachedQuota.hasArgonAccess,
        hasHint ? (hintTierId || "") : (cachedQuota.tierCode || hintTierId || "")
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
    if (!isGcp && !hasArgonAccess && isArgonGatedLabelOrId(baseLabel)) {
      continue;
    }
    const rawVars = Array.isArray(m.variantIds) ? m.variantIds : [baseLabel, rawLabel];
    const hadDistinctRawVariant = rawVars.some((v) => v && v !== baseLabel && v !== rawLabel);
    const vars = rawVars.filter(
      (v) => v && !isLegacyDeprecatedModel(v) && (isGcp || !isGcpOnlyModel(v))
    );
    if (hadDistinctRawVariant && !vars.some((v) => v && v !== baseLabel && v !== rawLabel)) {
      continue;
    }
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
        [],
        availableModels,
        [],
        hasArgonAccess
      );
    } else {
      availableModels = mergeNativeCatalogIntoPersonalModels(
        availableModels,
        hasArgonAccess,
        isPaidProOrUltra
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
    delete cfg.__meta__.liveTierModels.personal;
    for (const tKey of ["gcp"]) {
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
        ? ""
        : (item.tierName || "");
      const cleanGcpTier = gcpBillingMode === "gemini_enterprise" ? "Gemini Enterprise" : "Agent Platform";

      const liveTierTemplate = (isGcp && pid) ? (cfg.__meta__?.liveTierModels?.gcp || []) : [];
      const cleanCompanionPid = !isGcp
        ? resolvePersonalCompanionProjectId(cfg, email, item.companionProjectId || item.cachedQuota?.companionProjectId || "")
        : "";
      const confirmedFromRaw = (!isGcp && item.tierConfirmed && item.tierRaw)
        ? detectPersonalAccountTier([], item.tierRaw, item.tierRaw, undefined, "")
        : null;
      const hasAuthoritativeRawTier = Boolean(confirmedFromRaw && confirmedFromRaw.tierCode !== "Unknown");
      const hasValidSnapshot = (q) => Boolean(
        q &&
        typeof q === "object" &&
        ((Array.isArray(q.quotaGroups) && q.quotaGroups.length > 0) ||
         (q.probedVia === "cloudcode_http" && Array.isArray(q.availableModels) && q.availableModels.length > 0))
      );
      const hasConfirmedHistoricalQuota = Boolean(
        item.tierConfirmed ||
        item.cachedQuota?.probedVia ||
        hasValidSnapshot(item.cachedQuota)
      );
      const effectiveHintName = hasAuthoritativeRawTier
        ? confirmedFromRaw.tierName
        : (hasConfirmedHistoricalQuota ? cleanPersonalTier : "");
      const effectiveHintCode = hasAuthoritativeRawTier
        ? confirmedFromRaw.tierCode
        : (hasConfirmedHistoricalQuota ? (item.tierCode || "") : "");
      let cachedQuota = sanitizeCachedQuotaModels(
        item.cachedQuota || null,
        Boolean(isGcp && pid),
        liveTierTemplate,
        isGcp && pid ? cleanGcpTier : effectiveHintName,
        effectiveHintCode,
        hasAuthoritativeRawTier
      );
      let cachedQuotaByPool = undefined;
      if (!isGcp && !pid) {
        cachedQuotaByPool = {};
        const rawByPool = item.cachedQuotaByPool && typeof item.cachedQuotaByPool === "object"
          ? item.cachedQuotaByPool
          : {};
        for (const pKey of ["daily"]) {
          if (rawByPool[pKey] && typeof rawByPool[pKey] === "object") {
            const poolConfirmed = Boolean(hasConfirmedHistoricalQuota || rawByPool[pKey].probedVia || hasValidSnapshot(rawByPool[pKey]));
            const sanitizedPool = sanitizeCachedQuotaModels(
              rawByPool[pKey],
              false,
              [],
              hasAuthoritativeRawTier ? confirmedFromRaw.tierName : (poolConfirmed ? cleanPersonalTier : ""),
              hasAuthoritativeRawTier ? confirmedFromRaw.tierCode : (poolConfirmed ? (item.tierCode || "") : ""),
              hasAuthoritativeRawTier
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
        if (cachedQuota && hasValidSnapshot(cachedQuota)) {
          const rawTag = cachedQuota.pool || cachedQuota.quotaPool || "daily";
          if (rawTag === "daily" && !cachedQuotaByPool.daily) {
            cachedQuota.pool = "daily";
            cachedQuota.quotaPool = "daily";
            if (cleanCompanionPid) cachedQuota.companionProjectId = cleanCompanionPid;
            cachedQuotaByPool.daily = cachedQuota;
          }
        }
        if (hasValidSnapshot(cachedQuotaByPool.daily)) {
          cachedQuota = cachedQuotaByPool.daily;
        }
      }
      if (cachedQuota && cleanCompanionPid && !isGcp) {
        cachedQuota.companionProjectId = cleanCompanionPid;
      }
      const isPersonalTierConfirmed = Boolean(
        !isGcp &&
        (item.tierConfirmed ||
         cachedQuota?.probedVia ||
         hasValidSnapshot(cachedQuota))
      );
      let resolvedTierCode = "Unknown";
      let resolvedPersonalTierName = "Unknown";
      if (isGcp && pid) {
        resolvedTierCode = "GCP";
      } else if (isPersonalTierConfirmed) {
        const rawTierCand = hasAuthoritativeRawTier
          ? confirmedFromRaw.tierCode
          : (cachedQuota?.tierCode || item.tierCode || cleanPersonalTier);
        if (/ultra/i.test(rawTierCand)) resolvedTierCode = "Ultra";
        else if (/\bpro\b|g1-pro/i.test(rawTierCand)) resolvedTierCode = "Pro";
        else if (/\bplus\b|g1-plus/i.test(rawTierCand)) resolvedTierCode = "Plus";
        else if (/\bfree\b|free-tier|starter/i.test(rawTierCand)) resolvedTierCode = "Free";
        else resolvedTierCode = "Unknown";
        const expectedTierName = resolvedTierCode !== "Unknown" ? `Google AI ${resolvedTierCode}` : "Unknown";
        if (hasAuthoritativeRawTier) {
          resolvedPersonalTierName = expectedTierName;
        } else {
          const cachedName = String(cachedQuota?.tierName || "").trim();
          const nameMatchesCode = cachedName && new RegExp(`\\b${resolvedTierCode}\\b`, "i").test(cachedName);
          resolvedPersonalTierName = resolvedTierCode !== "Unknown"
            ? (nameMatchesCode ? cachedName : expectedTierName)
            : "Unknown";
        }
      }
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
        tierConfirmed: isGcp ? Boolean(pid) : isPersonalTierConfirmed,
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
          tierCode: "Unknown",
          tierName: "Unknown",
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
  const keepExistingTier = Boolean(
    existing?.tierConfirmed ||
    existing?.cachedQuota?.probedVia ||
    existing?.cachedQuota?.quotaGroups?.length
  );
  cfg.accounts[personalKey] = {
    ...existing,
    id: personalKey,
    alias: existing?.alias || cleanEmail,
    email: cleanEmail,
    channelType: "personal",
    tierCode: keepExistingTier ? (existing?.tierCode || "Unknown") : "Unknown",
    tierName: keepExistingTier && existing?.tierName && !/agent\s*platform|enterprise|gcp/i.test(existing.tierName)
      ? existing.tierName
      : "Unknown",
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
