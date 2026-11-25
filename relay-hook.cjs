// Antigravity Relay: 模型与子智能体算力池路由、跨通道签名防报错自愈及 Sidecar 自动拉起钩子
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const os = require("os");
const {
  sendLsRpcMethod,
  scrubConversationOppositeSignaturesSync,
  scrubAndReloadCascadeIfNeeded,
  scrubAllConversationDbsSync
} = require("./lib/proto-scrub.cjs");

const homeDir = os.homedir();
const relayDataDir = path.join(__dirname, "data");
const relayConfigPath = path.join(relayDataDir, "agy-relay-config.json");
const oldRelayConfigPath = path.join(homeDir, ".gemini", "config", "agy-relay-config.json");
const profilesPath = path.join(homeDir, ".gemini", "config", "project-plugin-profiles.json");
const convDbPath = path.join(homeDir, ".gemini", "antigravity", "conversation_summaries.db");
const convDir = path.join(homeDir, ".gemini", "antigravity", "conversations");

function readJsonSafe(filePath, fallback = null) {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      if (raw && raw.trim()) return JSON.parse(raw);
    }
  } catch (e) {}
  return fallback;
}

function writeJsonSafe(filePath, obj) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {}
  const serialized = JSON.stringify(obj, null, 2);
  try {
    if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf-8") === serialized) {
      return;
    }
  } catch (e) {}
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, serialized, "utf-8");
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    try {
      fs.writeFileSync(filePath, serialized, "utf-8");
    } catch {}
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => { resolve(data); });
  });
}

function reply(obj) {
  process.stdout.write(JSON.stringify(obj || {}));
  process.exit(0);
}

function isRelayEnabledForPayload(payload) {
  try {
    const profiles = readJsonSafe(profilesPath, null);
    if (!profiles) return true;
    const convId = payload.conversationId || payload.conversation_id || "";
    let projId = "";
    if (convId && fs.existsSync(convDbPath)) {
      try {
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(convDbPath, { readOnly: true, open: true });
        const row = db.prepare("SELECT project_id FROM conversation_summaries WHERE conversation_id = ?").get(convId);
        db.close();
        if (row && row.project_id) projId = String(row.project_id);
      } catch (e) {}
    }
    if (!projId && convId && profiles.__meta__?.convProjectMap?.[convId]) {
      projId = profiles.__meta__.convProjectMap[convId];
    }
    if (projId && profiles[projId]?.plugins && profiles[projId].plugins["antigravity-relay"] === false) {
      return false;
    }
  } catch (e) {}
  return true;
}

const WEEK_PENALTY_MS = 7 * 24 * 3600 * 1000;

function extractModelDualQuotaForHook(accOrQuota, matched, baseModelName) {
  const now = Date.now();
  const defaultWeeklyMs = now + WEEK_PENALTY_MS;
  const groups = Array.isArray(accOrQuota?.quotaGroups)
    ? accOrQuota.quotaGroups
    : (accOrQuota?.cachedQuota?.quotaGroups || []);
  const clean = String(baseModelName || matched?.label || matched?.modelId || "").toLowerCase();

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

function sendValidateRpc({ hostname, port, protocol, csrf }, payload) {
  return new Promise((resolve) => {
    const transport = protocol === "https" ? https : http;
    const opts = {
      hostname: hostname || "127.0.0.1",
      port: Number(port),
      path: "/exa.language_server_pb.LanguageServerService/ValidateProject",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        "x-codeium-csrf-token": csrf,
        "Content-Length": payload.length
      },
      timeout: 1200
    };
    if (protocol === "https") {
      opts.rejectUnauthorized = false;
    }
    const req = transport.request(opts, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode === 200));
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.write(payload);
    req.end();
  });
}

async function callValidateProjectRpc(lsTarget, projectId, location = "") {
  if (!lsTarget || !lsTarget.port || !lsTarget.csrf) return false;
  const cleanLoc = projectId ? (["global", "us", "eu"].includes(location) ? location : (location === "" ? "" : "global")) : "";
  const payload = Buffer.from(JSON.stringify({
    projectId: projectId || "",
    location: cleanLoc
  }), "utf-8");
  const primaryProto = lsTarget.protocol || "http";
  const ok = await sendValidateRpc({
    hostname: lsTarget.hostname,
    port: lsTarget.port,
    protocol: primaryProto,
    csrf: lsTarget.csrf
  }, payload);
  if (ok) return true;

  const fallbackPort = lsTarget.altPort && lsTarget.altPort !== lsTarget.port ? lsTarget.altPort : lsTarget.port;
  const fallbackProto = lsTarget.altPort && lsTarget.altPort !== lsTarget.port
    ? (lsTarget.altProtocol || (primaryProto === "http" ? "https" : "http"))
    : (primaryProto === "http" ? "https" : "http");
  return sendValidateRpc({
    hostname: lsTarget.hostname,
    port: fallbackPort,
    protocol: fallbackProto,
    csrf: lsTarget.csrf
  }, payload);
}

function isTemporarilyBlockedForHook(acc, nowMs = Date.now()) {
  if (!acc || acc.authExpired) return true;
  const blockedUntil = Number(acc.routeBlockedUntil || 0);
  if (blockedUntil > nowMs) return true;
  const errAt = Number(acc.lastProbeError?.at || 0);
  const errMsg = String(acc.lastProbeError?.message || "");
  return errAt > 0 && (nowMs - errAt) < 600000 && /#3501|valid license|\b401\b|\b403\b/i.test(errMsg);
}

const PERSONAL_TIER_KEYS_HOOK = ["free", "plus", "pro_lite", "pro", "ultra"];

function parseTierRouteSpecForHook(spec) {
  const s = String(spec || "").trim().toLowerCase();
  if (!s.startsWith("tier:")) return "";
  const key = s.slice(5).trim();
  return PERSONAL_TIER_KEYS_HOOK.includes(key) ? key : "";
}

function getPersonalAccountTierKeyForHook(acc) {
  if (!acc || acc.channelType === "gcp" || acc.gcpProjectId) return "";
  const rawCode = String(acc.tierCode || acc.cachedQuota?.tierCode || acc.cachedQuotaByPool?.daily?.tierCode || "").trim();
  const tName = String(acc.tierName || acc.cachedQuota?.tierName || "").trim();
  if (/^ultra$/i.test(rawCode) || /\bultra\b/i.test(tName)) return "ultra";
  if (/^pro$/i.test(rawCode) || /\bpro\b/i.test(tName)) {
    const subCode = String(
      acc.tierSubCode || acc.cachedQuota?.tierSubCode || acc.cachedQuotaByPool?.daily?.tierSubCode || ""
    ).trim().toLowerCase();
    const isRestricted =
      subCode === "pro_lite" ||
      acc.paidProRestricted === true ||
      acc.cachedQuota?.paidProRestricted === true ||
      acc.cachedQuotaByPool?.daily?.paidProRestricted === true;
    return isRestricted ? "pro_lite" : "pro";
  }
  if (/^plus$/i.test(rawCode) || /\bplus\b/i.test(tName)) return "plus";
  if (/^free$/i.test(rawCode) || /\bfree\b|standard|starter/i.test(tName)) return "free";
  return "";
}

function resolveBestAvailableChannelSpec(baseModelName, relayCfg, activeMeta = null, opts = null) {
  const accounts = Object.values(relayCfg?.accounts || {});
  if (accounts.length === 0) return null;
  const activeEmail = (activeMeta?.activeEmail || relayCfg?.__meta__?.activeEmail || "").trim();
  const activeChannelId = activeEmail ? `${activeEmail}#personal` : "";
  const preferredPool = "daily";
  const poolOrder = ["daily"];
  const thresholdPct = Number(relayCfg?.routing?.lowQuotaThresholdPct ?? 5);
  const targetLower = (baseModelName || "").toLowerCase();
  const preferredTierKey = String(opts?.preferredTierKey || "").trim().toLowerCase();
  const allowFallback = opts?.allowFallback !== false;
  const excludeAccountId = String(opts?.excludeAccountId || "").trim();
  const nowMs = Date.now();

  const collectAndRank = (tierFilterKey = "") => {
    const candidates = [];
    for (const acc of accounts) {
      const isGcp = acc.channelType === "gcp" || Boolean(acc.gcpProjectId);
      if (isGcp || (excludeAccountId && acc.id === excludeAccountId) || isTemporarilyBlockedForHook(acc, nowMs)) continue;
      if (tierFilterKey && getPersonalAccountTierKeyForHook(acc) !== tierFilterKey) continue;
      for (const pool of poolOrder) {
        const poolQuota = acc?.cachedQuotaByPool?.[pool] || (pool === preferredPool ? acc?.cachedQuota : null);
        if (!poolQuota || typeof poolQuota !== "object") continue;
        const models = poolQuota.availableModels || [];
        const matched = models.find((m) => {
          const id = (m.modelId || m.label || "").toLowerCase();
          if (id === targetLower) return true;
          return Array.isArray(m.variantIds) && m.variantIds.some((v) => String(v).toLowerCase() === targetLower);
        });
        if (!matched && targetLower) continue;
        const dual = extractModelDualQuotaForHook(poolQuota, matched, baseModelName);
        if (dual.weeklyPct <= 0 || dual.fiveHourPct <= 0) continue;

        const weeklyLow = dual.weeklyPct <= thresholdPct;
        const effectiveWeeklyResetMs = dual.weeklyResetMs + (weeklyLow ? WEEK_PENALTY_MS : 0);
        const fiveHourAboveThreshold = dual.fiveHourPct > thresholdPct;

        candidates.push({
          acc,
          pool,
          weeklyPct: dual.weeklyPct,
          fiveHourPct: dual.fiveHourPct,
          fiveHourAboveThreshold,
          effectiveWeeklyResetMs,
          fiveHourResetMs: dual.fiveHourResetMs,
          isPreferredPool: pool === preferredPool,
          isCurrent: acc.id === activeChannelId,
          sameEmail: acc.email === activeEmail
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
      if (b.weeklyPct !== a.weeklyPct) return b.weeklyPct - a.weeklyPct;
      if (b.fiveHourPct !== a.fiveHourPct) return b.fiveHourPct - a.fiveHourPct;
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      if (a.sameEmail !== b.sameEmail) return a.sameEmail ? -1 : 1;
      return 0;
    });

    return `account:${candidates[0].acc.id}@${candidates[0].pool}`;
  };

  if (preferredTierKey) {
    const matchedTierSpec = collectAndRank(preferredTierKey);
    if (matchedTierSpec) return matchedTierSpec;
    if (!allowFallback) return null;
    return collectAndRank("");
  }

  return collectAndRank("");
}

function resolvePinnedOrFallbackChannelSpec(accId, explicitPool, baseModelName, relayCfg, activeMeta = null, opts = null) {
  const cleanId = String(accId || "").trim();
  if (!cleanId) return null;
  const acc = relayCfg?.accounts?.[cleanId] || (!cleanId.includes("#") ? relayCfg?.accounts?.[`${cleanId}#personal`] : null);
  if (!acc || acc.channelType === "gcp" || acc.gcpProjectId) return null;
  const allowFallback = opts?.allowFallback !== false;
  const nowMs = Date.now();
  const blocked = isTemporarilyBlockedForHook(acc, nowMs);
  const preferredPool = "daily";
  const chosenPool = explicitPool ? explicitPool : preferredPool;
  const targetLower = String(baseModelName || "").toLowerCase();

  const checkPool = (poolKey) => {
    const poolQuota = acc?.cachedQuotaByPool?.[poolKey] || (poolKey === preferredPool ? acc?.cachedQuota : null);
    if (!poolQuota || typeof poolQuota !== "object") return false;
    const models = poolQuota.availableModels || [];
    const matched = models.find((m) => {
      const id = (m.modelId || m.label || "").toLowerCase();
      if (id === targetLower) return true;
      return Array.isArray(m.variantIds) && m.variantIds.some((v) => String(v).toLowerCase() === targetLower);
    });
    if (!matched && targetLower) return false;
    const dual = extractModelDualQuotaForHook(poolQuota, matched, baseModelName);
    return dual.weeklyPct > 0 && dual.fiveHourPct > 0;
  };

  if (!blocked) {
    if (checkPool(chosenPool)) return `account:${acc.id}@${chosenPool}`;
    if (!explicitPool) {
      const altPool = chosenPool === "prod" ? "daily" : "prod";
      if (checkPool(altPool)) return `account:${acc.id}@${altPool}`;
    }
  }

  if (!allowFallback) return null;
  return resolveBestAvailableChannelSpec(baseModelName, relayCfg, activeMeta, {
    preferredTierKey: getPersonalAccountTierKeyForHook(acc),
    allowFallback: true,
    excludeAccountId: acc.id
  });
}

function resolveHookInstanceMeta(relayCfg) {
  const meta = relayCfg?.__meta__ || {};
  const instances = meta.instances || {};
  const envId = String(process.env.AGY_RELAY_INSTANCE_ID || "").trim();
  if (envId && instances[envId]) {
    return instances[envId];
  }
  const ppid = Number(process.ppid || 0);
  if (ppid > 0) {
    for (const inst of Object.values(instances)) {
      if (inst && Number(inst.lsRpcTarget?.pid || inst.cloudCodeProxyPid || 0) === ppid) {
        return inst;
      }
    }
  }
  return instances.main || meta;
}

async function ensureLocalCloudCodeProxyMounted(lsTarget, relayCfg, instMeta = null) {
  if (!lsTarget || !lsTarget.port || !lsTarget.csrf) return false;
  const savedProxyUrl = String(instMeta?.cloudCodeProxyUrl || relayCfg?.__meta__?.cloudCodeProxyUrl || "").trim();
  const proxyUrl = /^http:\/\/127\.0\.0\.1:809\d$/i.test(savedProxyUrl) ? savedProxyUrl : "http://127.0.0.1:8091";
  const isIsoInst = Boolean(process.env.AGY_RELAY_INSTANCE_ID);
  const syncedAtMs = Math.max(
    Number(instMeta?.cloudCodeProxySyncedAt || 0),
    (!isIsoInst &&
      relayCfg?.__meta__?.cloudCodeProxyMode === "local_proxy" &&
      Number(relayCfg?.__meta__?.cloudCodeProxyPid || 0) === Number(lsTarget.pid || 0) &&
      relayCfg?.__meta__?.cloudCodeProxyUrl === proxyUrl)
      ? Number(relayCfg?.__meta__?.cloudCodeProxySyncedAt || 0)
      : 0
  );
  const syncedAgoMs = Date.now() - syncedAtMs;
  if (
    instMeta &&
    instMeta.cloudCodeProxyMode === "local_proxy" &&
    Number(instMeta.cloudCodeProxyPid || 0) > 0 &&
    Number(instMeta.cloudCodeProxyPid) === Number(lsTarget.pid || 0) &&
    instMeta.cloudCodeProxyUrl === proxyUrl &&
    syncedAgoMs >= 0 &&
    syncedAgoMs < 300000
  ) {
    return true;
  }
  const payload = Buffer.from(JSON.stringify({ url: proxyUrl }), "utf-8");
  const primaryProto = lsTarget.protocol || "http";
  let ok = await sendLsRpcMethod(
    { hostname: lsTarget.hostname, port: lsTarget.port, protocol: primaryProto, csrf: lsTarget.csrf },
    "SetCloudCodeURL",
    payload
  );
  if (!ok) {
    const fallbackPort = lsTarget.altPort && lsTarget.altPort !== lsTarget.port ? lsTarget.altPort : lsTarget.port;
    const fallbackProto = lsTarget.altPort && lsTarget.altPort !== lsTarget.port
      ? (lsTarget.altProtocol || (primaryProto === "http" ? "https" : "http"))
      : (primaryProto === "http" ? "https" : "http");
    ok = await sendLsRpcMethod(
      { hostname: lsTarget.hostname, port: fallbackPort, protocol: fallbackProto, csrf: lsTarget.csrf },
      "SetCloudCodeURL",
      payload
    );
  }
  if (ok && instMeta) {
    const nowSyncAt = Date.now();
    instMeta.cloudCodeProxyMode = "local_proxy";
    instMeta.cloudCodeProxyUrl = proxyUrl;
    instMeta.cloudCodeProxySyncedAt = nowSyncAt;
    if (lsTarget.pid) instMeta.cloudCodeProxyPid = lsTarget.pid;
    if (!isIsoInst && relayCfg?.__meta__) {
      relayCfg.__meta__.cloudCodeProxyMode = "local_proxy";
      relayCfg.__meta__.cloudCodeProxyUrl = proxyUrl;
      relayCfg.__meta__.cloudCodeProxySyncedAt = nowSyncAt;
      if (lsTarget.pid) relayCfg.__meta__.cloudCodeProxyPid = lsTarget.pid;
    }
  }
  return ok;
}

function normalizeBaseModelFamily(rawModelStr) {
  const s = String(rawModelStr || "").trim();
  if (!s) return "";
  const lower = s.toLowerCase();
  if (/neon|m537/i.test(lower)) return "Gemini 4 Neon";
  if (/argon|orchestrator.*g1-pro|m417|m418|m419|m668/i.test(lower)) return "Gemini 4 Argon";
  if (/hydrogen/i.test(lower)) return "Gemini 4 Hydrogen";
  if (/carbon/i.test(lower)) return "Gemini 4 Carbon";
  if (/3[._-\s]*8[._-\s]*flash|m420|m421|m422|m318|m319|m320/i.test(lower)) return "Gemini 3.8 Flash";
  if (/3[._-\s]*7[._-\s]*flash|m55|m62|m63|m298|m299|m300/i.test(lower)) return "Gemini 3.7 Flash";
  if (/3[._-\s]*6[._-\s]*flash|m51|m60|m61|m71|m72|m73/i.test(lower)) return "Gemini 3.6 Flash";
  if (/3[._-\s]*1[._-\s]*pro|m36|m37/i.test(lower)) return "Gemini 3.1 Pro";
  if (/opus[._-\s]*5[._-]5|m409|m410|m411|m412|m400|m401|m402|m406/i.test(lower)) return "Claude Opus 5.5";
  if (/sonnet[._-\s]*5[._-]5|m413|m414|m415|m416|m403|m404|m405|m407/i.test(lower)) return "Claude Sonnet 5.5";
  if (/sonnet[._-\s]*4[._-]6/i.test(lower)) return "Claude Sonnet 4.6 (Thinking)";
  if (/opus[._-\s]*4[._-]6/i.test(lower)) return "Claude Opus 4.6 (Thinking)";
  if (/gpt[._-\s]*oss/i.test(lower)) return "GPT-OSS 120B";
  const unwrapped = s
    .replace(/^orchestrator\s*\(([^)]+)\)\s*$/i, "$1")
    .replace(/^orchestrator\s+/i, "")
    .trim();
  return unwrapped
    .replace(/\s*\((Low|Medium|High|XHigh|Extra\s*High|Max|Extra)\)\s*$/i, "")
    .replace(/\s+(Low|Medium|High|XHigh|Extra\s*High|Max)\s*$/i, "")
    .replace(/-(low|medium|high|xhigh|extra[-_]?high|max|extra)$/i, "")
    .trim();
}

function parseHookAccountRef(spec) {
  if (!spec || typeof spec !== "string") return null;
  const trimmed = spec.trim();
  if (!trimmed.startsWith("account:") && !trimmed.startsWith("channel:")) return null;
  const rawRef = trimmed.replace(/^(account|channel):/, "").trim();
  if (!rawRef) return null;
  const hashIdx = rawRef.indexOf("#");
  const poolAtIdx = hashIdx >= 0 ? rawRef.indexOf("@", hashIdx) : -1;
  const accId = poolAtIdx >= 0 ? rawRef.slice(0, poolAtIdx) : rawRef;
  const explicitPool = poolAtIdx >= 0 ? rawRef.slice(poolAtIdx + 1) : "";
  return { accId, explicitPool };
}

async function applyGcpTargetRoute(targetSpec, relayCfg, baseModelName = "", rawModelName = "", instMeta = null) {
  const activeMeta = instMeta || resolveHookInstanceMeta(relayCfg);
  if (!activeMeta?.lastAppliedGcpProject) return false;
  if (!relayCfg.__meta__) relayCfg.__meta__ = {};
  const isIsoInst = Boolean(process.env.AGY_RELAY_INSTANCE_ID || (activeMeta.instanceId && activeMeta.instanceId !== "main"));
  const modelVal = rawModelName || baseModelName || "";
  activeMeta.lastRoutedModel = modelVal;
  if (!isIsoInst) relayCfg.__meta__.lastRoutedModel = modelVal;

  if (!targetSpec || targetSpec === "follow_current") {
    activeMeta.lastRoutedChannelId = activeMeta.activeChannelId || "";
    if (!isIsoInst) relayCfg.__meta__.lastRoutedChannelId = activeMeta.activeChannelId || "";
    writeJsonSafe(relayConfigPath, relayCfg);
    return false;
  }

  const parsedGcpRef = parseHookAccountRef(targetSpec);
  if (parsedGcpRef) {
    const accId = parsedGcpRef.accId;
    const acc = relayCfg?.accounts?.[accId];
    const targetPid = String(acc?.gcpProjectId || "").trim();
    // GCP Vertex AI 使用当前登录 OAuth 凭据直连，严禁跨不同邮箱调用 ValidateProject 篡改 Project ID（否则必报 403 PERMISSION_DENIED）
    if (!acc || !targetPid || (activeMeta.activeEmail && acc.email !== activeMeta.activeEmail)) {
      activeMeta.lastRoutedChannelId = activeMeta.activeChannelId || "";
      if (!isIsoInst) relayCfg.__meta__.lastRoutedChannelId = activeMeta.activeChannelId || "";
      writeJsonSafe(relayConfigPath, relayCfg);
      return false;
    }
    const lsTarget = activeMeta?.lsRpcTarget || (!isIsoInst ? relayCfg?.__meta__?.lsRpcTarget : null);
    if (lsTarget && targetPid !== activeMeta.lastAppliedGcpProject) {
      const targetLoc = acc.gcpBillingMode === "gemini_enterprise" ? "" : (acc.gcpLocation || "global");
      await callValidateProjectRpc(lsTarget, targetPid, targetLoc);
      activeMeta.lastAppliedGcpProject = targetPid;
    }
    activeMeta.lastRoutedChannelId = acc.id;
    if (!isIsoInst) relayCfg.__meta__.lastRoutedChannelId = acc.id;
    writeJsonSafe(relayConfigPath, relayCfg);
    return true;
  }

  writeJsonSafe(relayConfigPath, relayCfg);
  return false;
}

async function applyTargetRoute(targetSpec, relayCfg, baseModelName = "", rawModelName = "", instMeta = null) {
  const activeMeta = instMeta || resolveHookInstanceMeta(relayCfg);
  if (activeMeta?.lastAppliedGcpProject) {
    return applyGcpTargetRoute(targetSpec, relayCfg, baseModelName, rawModelName, activeMeta);
  }

  if (!relayCfg.__meta__) relayCfg.__meta__ = {};
  const isIsoInst = Boolean(process.env.AGY_RELAY_INSTANCE_ID || (activeMeta?.instanceId && activeMeta.instanceId !== "main"));
  const modelVal = rawModelName || baseModelName || "";
  if (activeMeta) activeMeta.lastRoutedModel = modelVal;
  if (!isIsoInst) relayCfg.__meta__.lastRoutedModel = modelVal;

  const ensurePersonalProxyMounted = async () => {
    const lsTarget = activeMeta?.lsRpcTarget || (!isIsoInst ? relayCfg?.__meta__?.lsRpcTarget : null);
    if (lsTarget) {
      await ensureLocalCloudCodeProxyMounted(lsTarget, relayCfg, activeMeta);
    }
  };

  if (!targetSpec || targetSpec === "follow_current") {
    const preferredPool = String(relayCfg?.routing?.personalQuotaPool || "daily").toLowerCase() === "prod" ? "prod" : "daily";
    await ensurePersonalProxyMounted();
    if (activeMeta) {
      activeMeta.lastRoutedChannelId = activeMeta.activeChannelId || "";
      activeMeta.lastRoutedPool = preferredPool;
    }
    if (!isIsoInst) {
      relayCfg.__meta__.lastRoutedChannelId = activeMeta?.activeChannelId || "";
      relayCfg.__meta__.lastRoutedPool = preferredPool;
    }
    writeJsonSafe(relayConfigPath, relayCfg);
    return false;
  }

  let resolvedSpec = targetSpec;
  const targetTierKey = parseTierRouteSpecForHook(resolvedSpec);
  if (resolvedSpec === "auto_poll" || targetTierKey) {
    const allowFallback = relayCfg?.routing?.tierFallbackToAny !== false;
    resolvedSpec = resolveBestAvailableChannelSpec(
      baseModelName,
      relayCfg,
      activeMeta,
      targetTierKey ? { preferredTierKey: targetTierKey, allowFallback } : null
    ) || "follow_current";
    if (resolvedSpec === "follow_current") {
      await ensurePersonalProxyMounted();
      if (activeMeta) activeMeta.lastRoutedChannelId = activeMeta.activeChannelId || "";
      if (!isIsoInst) relayCfg.__meta__.lastRoutedChannelId = activeMeta?.activeChannelId || "";
      writeJsonSafe(relayConfigPath, relayCfg);
      return false;
    }
  }

  const parsedRef = parseHookAccountRef(resolvedSpec);
  if (parsedRef) {
    let targetAccId = parsedRef.accId;
    let targetExplicitPool = parsedRef.explicitPool;
    const allowFallback = relayCfg?.routing?.tierFallbackToAny !== false;
    if (!targetTierKey && resolvedSpec === targetSpec && allowFallback) {
      const resolvedFallback = resolvePinnedOrFallbackChannelSpec(
        targetAccId,
        targetExplicitPool,
        baseModelName,
        relayCfg,
        activeMeta,
        { allowFallback: true }
      );
      const reparsed = resolvedFallback ? parseHookAccountRef(resolvedFallback) : null;
      if (reparsed) {
        targetAccId = reparsed.accId;
        targetExplicitPool = reparsed.explicitPool;
      }
    }
    const acc = relayCfg?.accounts?.[targetAccId] || (!targetAccId.includes("#") ? relayCfg?.accounts?.[`${targetAccId}#personal`] : null);
    if (!acc || acc.channelType === "gcp" || acc.gcpProjectId) {
      writeJsonSafe(relayConfigPath, relayCfg);
      return false;
    }
    const lsTarget = activeMeta?.lsRpcTarget || (!isIsoInst ? relayCfg?.__meta__?.lsRpcTarget : null);
    if (lsTarget) {
      await ensureLocalCloudCodeProxyMounted(lsTarget, relayCfg, activeMeta);
    }
    const routedPool = targetExplicitPool || String(relayCfg?.routing?.personalQuotaPool || "daily");
    if (activeMeta) {
      activeMeta.lastRoutedChannelId = acc.id;
      activeMeta.lastRoutedPool = routedPool;
    }
    if (!isIsoInst) {
      relayCfg.__meta__.lastRoutedChannelId = acc.id;
      relayCfg.__meta__.lastRoutedPool = routedPool;
    }
    writeJsonSafe(relayConfigPath, relayCfg);
    return true;
  }

  writeJsonSafe(relayConfigPath, relayCfg);
  return false;
}

async function main() {
  const mode = process.argv[2] || "pre-invocation";
  const defaultReply = mode === "pre-tool" ? { decision: "allow" } : {};

  try {
    const raw = await readStdin();
    let payload = {};
    if (raw && raw.trim()) {
      try { payload = JSON.parse(raw); } catch (e) {}
    }

    if (!isRelayEnabledForPayload(payload)) {
      return reply(defaultReply);
    }

    let relayCfg = readJsonSafe(relayConfigPath, null);
    if (!relayCfg && fs.existsSync(oldRelayConfigPath)) {
      relayCfg = readJsonSafe(oldRelayConfigPath, null);
      if (relayCfg) writeJsonSafe(relayConfigPath, relayCfg);
    }
    if (!relayCfg) relayCfg = { routing: {}, __meta__: {} };
    if (!relayCfg.routing) relayCfg.routing = {};
    if (!relayCfg.__meta__) relayCfg.__meta__ = {};

    if (mode === "pre-invocation") {
      const convId = (payload.conversationId || payload.conversation_id || "").trim();
      const modelName = (payload.modelName || "").trim();
      const baseModelName = normalizeBaseModelFamily(modelName);
      const activeMeta = resolveHookInstanceMeta(relayCfg);
      const isGcpMode = Boolean(activeMeta?.lastAppliedGcpProject);
      const routeMap = isGcpMode
        ? (relayCfg.routing.gcpModels || {})
        : (relayCfg.routing.models || {});
      // 优先以标准模型族名（如 "Gemini 4 Argon"）读取路由配置，防止旧小写变体键残留污染
      const targetSpec = routeMap[baseModelName] || routeMap[modelName] || "follow_current";
      if (targetSpec && targetSpec !== "follow_current") {
        await applyTargetRoute(targetSpec, relayCfg, baseModelName, modelName, activeMeta);
      } else {
        await applyTargetRoute("follow_current", relayCfg, baseModelName, modelName, activeMeta);
      }
      if (convId) {
        // 若用户切换到另一个历史会话发消息，仅对该单个会话定向剥离异种通道签名（绝不清空其他未打开的历史会话）
        try {
          scrubConversationOppositeSignaturesSync(convId, isGcpMode, convDir);
        } catch (e) {}
        const currentActiveChannel =
          relayCfg.__meta__?.lastRoutedChannelId ||
          activeMeta?.activeChannelId ||
          `${activeMeta?.activeEmail || ""}#${activeMeta?.lastAppliedGcpProject || "personal"}`;
        if (!relayCfg.__meta__.convLastChannelMap) relayCfg.__meta__.convLastChannelMap = {};
        if (relayCfg.__meta__.convLastChannelMap[convId] !== currentActiveChannel) {
          relayCfg.__meta__.convLastChannelMap[convId] = currentActiveChannel;
          writeJsonSafe(relayConfigPath, relayCfg);
        }
      }
      return reply({});
    }

    if (mode === "pre-tool") {
      return reply({ decision: "allow" });
    }

    if (mode === "stop") {
      return reply({});
    }

    return reply(defaultReply);
  } catch (e) {
    return reply(defaultReply);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  callValidateProjectRpc,
  normalizeBaseModelFamily,
  parseTierRouteSpecForHook,
  getPersonalAccountTierKeyForHook,
  resolveBestAvailableChannelSpec,
  resolvePinnedOrFallbackChannelSpec,
  scrubAndReloadCascadeIfNeeded: (cascadeId, lsTarget) => scrubAndReloadCascadeIfNeeded(cascadeId, lsTarget, convDir),
  scrubAllConversationDbsSync: () => scrubAllConversationDbsSync(convDir)
};
