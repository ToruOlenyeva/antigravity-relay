import {
  readRelayConfig,
  writeRelayConfig
} from "../store.mjs";
import {
  refreshOAuthAccessToken,
  buildLoadCodeAssistMetadata
} from "./wincred-ls.mjs";
import {
  findStoredTokenForEmail,
  callCloudCodeApi,
  isDowngradedConsumerPoolProject,
  resolvePersonalCompanionProjectId,
  getCloudCodeHostnameForPool,
  stripModelVariantSuffix,
  deriveCloudCodeSlugFromLabel
} from "./quota-probe.mjs";

const GCP_SIG_BIN_MAGIC = Buffer.from([0x01, 0x8f, 0x3d, 0x6b, 0x5f]);

export function isGcpThoughtSignature(sigVal) {
  if (typeof sigVal !== "string") return false;
  const s = sigVal.trim();
  if (!s) return false;
  if (s.includes("AY89a18") || s.includes("IDxACGAIqQ") || s.includes("CA8QAhgCKk")) {
    return true;
  }
  try {
    const buf = Buffer.from(s, "base64");
    if (buf.length >= 5 && buf.includes(GCP_SIG_BIN_MAGIC)) return true;
  } catch {}
  return false;
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
  let strippedHere = false;
  for (const key of Object.keys(node)) {
    if (key === "thoughtSignature" || key === "thought_signature") {
      if (!onlyGcpSignatures || isGcpThoughtSignature(node[key])) {
        delete node[key];
        strippedHere = true;
        count++;
      }
    } else if (node[key] && typeof node[key] === "object") {
      const subCount = stripThoughtSignaturesFromJson(node[key], opts);
      count += subCount;
      if (subCount > 0 && key === "parts" && Array.isArray(node.parts)) {
        const filteredParts = node.parts.filter((p) => {
          if (!p || typeof p !== "object" || Array.isArray(p)) return true;
          const keys = Object.keys(p);
          if (keys.length === 0) return false;
          if (keys.length === 1 && keys[0] === "thought" && p.thought === true) return false;
          return true;
        });
        node.parts = filteredParts.length > 0 ? filteredParts : [{ text: "..." }];
      }
    }
  }
  if (strippedHere && (!node.text || String(node.text).trim() === "")) {
    const remainingKeys = Object.keys(node).filter((k) => k !== "thought");
    if (remainingKeys.length === 0) {
      delete node.thought;
    }
  }
  return count;
}

export function resolveBaseModelFamilyFromId(rawModelStr, cfg) {
  const s = String(rawModelStr || "").trim();
  if (!s) return "";
  const lower = s.toLowerCase();

  // 1. 优先从动态自学习注册表（随客户端版本自动更新）解析模型家族
  const dynReg = cfg?.__meta__?.dynamicModelRegistry;
  if (dynReg?.placeholderToFamily?.[lower]) {
    return stripModelVariantSuffix(dynReg.placeholderToFamily[lower]);
  }
  const strippedLower = stripModelVariantSuffix(s).toLowerCase();
  if (dynReg?.placeholderToFamily?.[strippedLower]) {
    return stripModelVariantSuffix(dynReg.placeholderToFamily[strippedLower]);
  }
  if (dynReg?.labelToSlug) {
    for (const [lbl, slug] of Object.entries(dynReg.labelToSlug)) {
      if (lbl === lower || String(slug || "").toLowerCase() === lower) {
        const fam = dynReg.placeholderToFamily?.[String(slug || "").toLowerCase()];
        if (fam) return stripModelVariantSuffix(fam);
      }
    }
  }

  // 2. 扫描 liveTierModels 与已收录账号的 availableModels 变体表
  const liveLists = Object.values(cfg?.__meta__?.liveTierModels || {});
  const accLists = Object.values(cfg?.accounts || {}).flatMap((acc) => [
    acc?.cachedQuota?.availableModels,
    acc?.cachedQuotaByPool?.daily?.availableModels,
    acc?.cachedQuotaByPool?.prod?.availableModels
  ]);
  for (const list of [...liveLists, ...accLists]) {
    for (const m of (list || [])) {
      const mLabel = stripModelVariantSuffix(m.modelId || m.label || "");
      if (!mLabel) continue;
      if (mLabel.toLowerCase() === lower || mLabel.toLowerCase() === strippedLower) return mLabel;
      if (Array.isArray(m.variantIds) && m.variantIds.some((v) => String(v).toLowerCase() === lower)) {
        return mLabel;
      }
    }
  }

  return stripModelVariantSuffix(s);
}

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
  const liveLists = Object.values(activeCfg?.__meta__?.liveTierModels || {});
  const accLists = Object.values(activeCfg?.accounts || {}).flatMap((acc) => [
    acc?.cachedQuota?.availableModels,
    acc?.cachedQuotaByPool?.daily?.availableModels,
    acc?.cachedQuotaByPool?.prod?.availableModels
  ]);
  for (const list of [...liveLists, ...accLists]) {
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

  // 3. 若传入的是带空格或括号的展示名，动态按语义规则转成标准云端 slug
  if (/\s|\(/.test(s)) {
    return deriveCloudCodeSlugFromLabel(s);
  }

  return s;
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

export function hasActivePersonalRoutingConfig(_cfg) {
  return true;
}

export function selectBestPersonalRouteCandidate(baseFamily, cfg, excludedIds = null) {
  const accounts = Object.values(cfg?.accounts || {});
  const activeEmail = (cfg?.__meta__?.activeEmail || "").trim();
  const activeChannelId = activeEmail ? `${activeEmail}#personal` : "";
  const preferredPool = "daily";
  const poolsOrder = ["daily"];
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
    if (a.fiveHourAboveThreshold !== b.fiveHourAboveThreshold) {
      return a.fiveHourAboveThreshold ? -1 : 1;
    }
    if (Math.abs(a.effectiveWeeklyResetMs - b.effectiveWeeklyResetMs) > 120000) {
      return a.effectiveWeeklyResetMs - b.effectiveWeeklyResetMs;
    }
    if (Math.abs(a.fiveHourResetMs - b.fiveHourResetMs) > 60000) {
      return a.fiveHourResetMs - b.fiveHourResetMs;
    }
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
