import https from "node:https";
import http from "node:http";
import {
  readRelayConfig,
  writeRelayConfig,
  resolveCurrentInstanceContext,
  getInstanceMeta
} from "../store.mjs";
import {
  discoverLanguageServer,
  callLsRpc,
  refreshOAuthAccessToken
} from "./wincred-ls.mjs";
import {
  normalizeAccountChannels,
  findStoredTokenForEmail,
  probeChannelQuotaSnapshot
} from "./quota-probe.mjs";

export function stripThoughtSignaturesFromJson(node) {
  if (!node || typeof node !== "object") return 0;
  let count = 0;
  if (Array.isArray(node)) {
    for (const item of node) {
      count += stripThoughtSignaturesFromJson(item);
    }
    return count;
  }
  for (const key of Object.keys(node)) {
    if (key === "thoughtSignature" || key === "thought_signature") {
      delete node[key];
      count++;
    } else if (node[key] && typeof node[key] === "object") {
      count += stripThoughtSignaturesFromJson(node[key]);
    }
  }
  return count;
}

export function resolveBaseModelFamilyFromId(rawModelStr, cfg) {
  const s = String(rawModelStr || "").trim();
  if (!s) return "";
  const lower = s.toLowerCase();
  if (/argon|m417|m418|m419/i.test(lower)) return "Gemini 4 Argon";
  if (/3[._-]8[._-]flash|m420|m421|m422/i.test(lower)) return "Gemini 3.8 Flash";
  if (/3[._-]7[._-]flash|m55|m62|m63/i.test(lower)) return "Gemini 3.7 Flash";
  if (/3[._-]6[._-]flash|m51|m60|m61/i.test(lower)) return "Gemini 3.6 Flash";
  if (/3[._-]1[._-]pro|m36|m37/i.test(lower)) return "Gemini 3.1 Pro";
  if (/opus[._-\s]*5[._-]5|m409|m410|m411|m412/i.test(lower)) return "Claude Opus 5.5";
  if (/sonnet[._-\s]*5[._-]5|m413|m414|m415|m416/i.test(lower)) return "Claude Sonnet 5.5";
  if (/sonnet[._-\s]*4[._-]6/i.test(lower)) return "Claude Sonnet 4.6 (Thinking)";
  if (/opus[._-\s]*4[._-]6/i.test(lower)) return "Claude Opus 4.6 (Thinking)";
  if (/gpt[._-\s]*oss/i.test(lower)) return "GPT-OSS 120B";

  for (const acc of Object.values(cfg?.accounts || {})) {
    for (const m of (acc?.cachedQuota?.availableModels || [])) {
      const mLabel = String(m.modelId || m.label || "").trim();
      if (mLabel.toLowerCase() === lower) return mLabel;
      if (Array.isArray(m.variantIds) && m.variantIds.some((v) => String(v).toLowerCase() === lower)) {
        return mLabel;
      }
    }
  }
  return s.replace(/\s*\((Low|Medium|High|Max)\)\s*$/i, "").trim();
}

const WEEK_PENALTY_MS = 7 * 24 * 3600 * 1000;

export function extractModelDualQuota(acc, matched, baseFamily) {
  const now = Date.now();
  const defaultWeeklyMs = now + WEEK_PENALTY_MS;
  const groups = acc?.cachedQuota?.quotaGroups || [];
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

export function selectBestPersonalChannelForModel(baseFamily, cfg) {
  const accounts = Object.values(cfg?.accounts || {});
  const activeEmail = (cfg?.__meta__?.activeEmail || "").trim();
  const activeChannelId = activeEmail ? `${activeEmail}#personal` : "";
  const thresholdPct = Number(cfg?.routing?.lowQuotaThresholdPct ?? 5);
  const targetLower = (baseFamily || "").toLowerCase();
  const candidates = [];

  for (const acc of accounts) {
    const isGcp = acc.channelType === "gcp" || Boolean(acc.gcpProjectId);
    if (isGcp) continue;
    const models = acc?.cachedQuota?.availableModels || [];
    const matched = models.find((m) => {
      const id = (m.modelId || m.label || "").toLowerCase();
      if (id === targetLower) return true;
      return Array.isArray(m.variantIds) && m.variantIds.some((v) => String(v).toLowerCase() === targetLower);
    });
    if (!matched && targetLower) continue;
    const dual = extractModelDualQuota(acc, matched, baseFamily);
    if (dual.weeklyPct <= 0 || dual.fiveHourPct <= 0) continue;

    const weeklyLow = dual.weeklyPct < thresholdPct;
    const effectiveWeeklyResetMs = dual.weeklyResetMs + (weeklyLow ? WEEK_PENALTY_MS : 0);
    const fiveHourAboveThreshold = dual.fiveHourPct > thresholdPct;

    candidates.push({
      acc,
      matched,
      weeklyPct: dual.weeklyPct,
      fiveHourPct: dual.fiveHourPct,
      fiveHourAboveThreshold,
      effectiveWeeklyResetMs,
      fiveHourResetMs: dual.fiveHourResetMs,
      isCurrent: acc.id === activeChannelId
    });
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
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return b.weeklyPct - a.weeklyPct;
  });
  return candidates[0].acc;
}

export async function getValidPersonalAccessToken(cfg, targetAcc) {
  const preferredStored = (targetAcc?.storedToken && !targetAcc.storedToken.project_id && targetAcc.storedToken.auth_method !== "gcp")
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
        for (const item of Object.values(cfg.accounts || {})) {
          if (item.storedToken?.token?.refresh_token === refreshToken) {
            item.storedToken.token.access_token = accessToken;
            item.storedToken.token.refreshedForRt = refreshToken;
            item.storedToken.token.expiry = newExpiry;
          }
        }
        writeRelayConfig(cfg);
      }
    } catch {}
  }
  return accessToken;
}

export async function proxyCloudCodeRequest(req, res, rawBodyBuf) {
  const reqUrl = req.url || "";
  if (reqUrl === "/__agy_proxy_ping" || reqUrl.startsWith("/__agy_proxy_ping?")) {
    const ctx = resolveCurrentInstanceContext();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "antigravity-relay-proxy",
        pid: process.pid,
        instanceId: ctx.instanceId,
        port: globalThis.__agyCloudCodeProxyPort || 8091
      })
    );
    return;
  }
  const cfg = readRelayConfig();
  normalizeAccountChannels(cfg);
  const ctx = resolveCurrentInstanceContext();
  const instMeta = getInstanceMeta(cfg, ctx);
  const isGenerateEndpoint = /^\/v1internal:(streamGenerateContent|generateContent|countTokens)\b/i.test(reqUrl);
  const isFetchModelsEndpoint = /^\/v1internal:fetchAvailableModels\b/i.test(reqUrl);
  const isPersonalControlEndpoint = !isGenerateEndpoint && /^\/v1internal:/i.test(reqUrl);

  const outHeaders = {};
  for (const [k, v] of Object.entries(req.headers || {})) {
    const lk = k.toLowerCase();
    if (lk === "host" || lk === "connection" || lk === "content-length") continue;
    outHeaders[k] = v;
  }
  outHeaders["Host"] = "cloudcode-pa.googleapis.com";

  let outBodyBuf = rawBodyBuf || Buffer.alloc(0);
  let routedTargetAcc = null;
  let strippedSigCount = 0;

  const descId = ctx.isIsolatedInstance ? String(ctx.descriptor?.activeChannelId || "").trim() : "";
  const descTs = ctx.isIsolatedInstance ? Math.max(Number(ctx.descriptor?.switchedAt || 0), Number(ctx.descriptor?.launchedAt || 0)) : 0;
  const metaTs = Math.max(Number(instMeta?.switchedAt || 0), Number(instMeta?.seededLaunchAt || 0));
  const activeChannelId = String(
    (descId && descTs >= metaTs ? descId : (instMeta?.activeChannelId || descId || (!ctx.isIsolatedInstance ? cfg.__meta__?.activeChannelId : ""))) || ""
  ).trim();
  const activePersonalAcc = (activeChannelId && cfg.accounts?.[activeChannelId] && cfg.accounts[activeChannelId].channelType !== "gcp" && !cfg.accounts[activeChannelId].gcpProjectId)
    ? cfg.accounts[activeChannelId]
    : null;

  if (isGenerateEndpoint && outBodyBuf.length > 0) {
    try {
      const bodyJson = JSON.parse(outBodyBuf.toString("utf8"));
      const rawModel = String(bodyJson.model || cfg.__meta__?.lastRoutedModel || "").trim();
      const baseFamily = resolveBaseModelFamilyFromId(rawModel, cfg);
      const routeMap = cfg.routing?.models || {};
      const routeSpec = routeMap[baseFamily] || routeMap[rawModel] || "follow_current";

      if (routeSpec === "auto_poll") {
        routedTargetAcc = selectBestPersonalChannelForModel(baseFamily, cfg) || activePersonalAcc;
      } else if (typeof routeSpec === "string" && routeSpec.startsWith("account:")) {
        const refId = routeSpec.slice(8).trim();
        const candidateAcc = cfg.accounts?.[refId];
        if (candidateAcc && candidateAcc.channelType !== "gcp" && !candidateAcc.gcpProjectId) {
          routedTargetAcc = candidateAcc;
        }
      }

      const isCrossPersonalRoute = Boolean(
        routedTargetAcc &&
        activePersonalAcc &&
        routedTargetAcc.id !== activePersonalAcc.id
      );

      if (isCrossPersonalRoute) {
        strippedSigCount = stripThoughtSignaturesFromJson(bodyJson);
        const targetToken = await getValidPersonalAccessToken(cfg, routedTargetAcc);
        if (targetToken) {
          outHeaders["authorization"] = `Bearer ${targetToken}`;
          delete outHeaders["Authorization"];
          delete outHeaders["x-goog-user-project"];
          delete outHeaders["X-Goog-User-Project"];
          if (routedTargetAcc.companionProjectId) {
            bodyJson.project = routedTargetAcc.companionProjectId;
          } else if (bodyJson.project && activePersonalAcc?.companionProjectId && bodyJson.project === activePersonalAcc.companionProjectId) {
            delete bodyJson.project;
          }
          cfg.__meta__.lastRoutedChannelId = routedTargetAcc.id;
          cfg.__meta__.lastProxyHit = {
            at: new Date().toISOString(),
            endpoint: reqUrl,
            rawModel,
            baseFamily,
            routeSpec,
            targetChannelId: routedTargetAcc.id,
            targetEmail: routedTargetAcc.email,
            strippedSignatures: strippedSigCount
          };
          writeRelayConfig(cfg);
        }
        outBodyBuf = Buffer.from(JSON.stringify(bodyJson), "utf8");
      }
    } catch {}
  }

  outHeaders["Content-Length"] = outBodyBuf.length;
  const reqStartAt = Date.now();
  const isStreamOrGenerate = /^\/v1internal:(streamGenerateContent|generateContent)\b/i.test(reqUrl);

  await new Promise((resolve) => {
    const upReq = https.request(
      {
        hostname: "cloudcode-pa.googleapis.com",
        port: 443,
        path: reqUrl,
        method: req.method || "POST",
        headers: outHeaders,
        timeout: 120000
      },
      (upRes) => {
        if (isFetchModelsEndpoint && upRes.statusCode === 200 && !upRes.headers["content-encoding"]) {
          const chunks = [];
          upRes.on("data", (c) => chunks.push(c));
          upRes.on("end", () => {
            let respBuf = Buffer.concat(chunks);
            try {
              const respJson = JSON.parse(respBuf.toString("utf8"));
              if (respJson?.models && typeof respJson.models === "object") {
                const routeMap = cfg.routing?.models || {};
                let modified = false;
                for (const [mKey, mObj] of Object.entries(respJson.models)) {
                  if (!mObj || typeof mObj !== "object" || /disabled$/i.test(mKey)) continue;
                  const baseFamily = resolveBaseModelFamilyFromId(mKey, cfg);
                  const rSpec = routeMap[baseFamily] || routeMap[mKey] || "follow_current";
                  let tAcc = null;
                  if (rSpec === "auto_poll") {
                    tAcc = selectBestPersonalChannelForModel(baseFamily, cfg);
                  } else if (typeof rSpec === "string" && rSpec.startsWith("account:")) {
                    tAcc = cfg.accounts?.[rSpec.slice(8).trim()] || null;
                  }
                  if (tAcc && tAcc.channelType !== "gcp" && !tAcc.gcpProjectId) {
                    const matchedModel = (tAcc.cachedQuota?.availableModels || []).find(
                      (item) => (item.modelId || item.label || "").toLowerCase() === baseFamily.toLowerCase()
                    );
                    if (matchedModel && matchedModel.remainingPct > 0) {
                      if (!mObj.quotaInfo) mObj.quotaInfo = {};
                      mObj.quotaInfo.remainingFraction = Math.min(1, matchedModel.remainingPct / 100);
                      if (matchedModel.resetTime) mObj.quotaInfo.resetTime = matchedModel.resetTime;
                      modified = true;
                    }
                  }
                }
                if (modified) {
                  respBuf = Buffer.from(JSON.stringify(respJson), "utf8");
                }
              }
            } catch {}
            const respHeaders = { ...upRes.headers, "content-length": String(respBuf.length) };
            res.writeHead(upRes.statusCode || 200, respHeaders);
            res.end(respBuf);
            resolve();
          });
          return;
        }

        res.writeHead(upRes.statusCode || 200, upRes.headers);
        let firstChunkAt = 0;
        const streamSampleChunks = [];
        let streamSampleLen = 0;
        upRes.on("data", (chunk) => {
          if (!firstChunkAt) firstChunkAt = Date.now();
          if (isStreamOrGenerate && !upRes.headers["content-encoding"] && streamSampleLen < 524288) {
            streamSampleChunks.push(chunk);
            streamSampleLen += chunk.length;
          }
          try { res.write(chunk); } catch {}
        });
        upRes.on("end", () => {
          try { res.end(); } catch {}
          if (isStreamOrGenerate && streamSampleChunks.length > 0) {
            try {
              const endAt = Date.now();
              const text = Buffer.concat(streamSampleChunks).toString("utf8");
              const promptMatches = [...text.matchAll(/"promptTokenCount"\s*:\s*(\d+)/g)];
              const candMatches = [...text.matchAll(/"candidatesTokenCount"\s*:\s*(\d+)/g)];
              const thoughtMatches = [...text.matchAll(/"thoughtsTokenCount"\s*:\s*(\d+)/g)];
              const totalMatches = [...text.matchAll(/"totalTokenCount"\s*:\s*(\d+)/g)];
              const inTok = promptMatches.length > 0 ? Number(promptMatches[promptMatches.length - 1][1]) : 0;
              const candTok = candMatches.length > 0 ? Number(candMatches[candMatches.length - 1][1]) : 0;
              const thTok = thoughtMatches.length > 0 ? Number(thoughtMatches[thoughtMatches.length - 1][1]) : 0;
              const totTok = totalMatches.length > 0 ? Number(totalMatches[totalMatches.length - 1][1]) : (inTok + candTok + thTok);
              const outTok = (candTok + thTok) > 0 ? (candTok + thTok) : Math.max(0, Math.round(text.length / 12));
              const elapsedSec = Math.max(0.25, (endAt - (firstChunkAt || reqStartAt)) / 1000);
              const speed = Math.round((outTok / elapsedSec) * 10) / 10;
              if (outTok > 0 && speed > 0) {
                const freshCfg = readRelayConfig();
                if (!freshCfg.__meta__) freshCfg.__meta__ = {};
                const prevTel = freshCfg.__meta__.telemetry || {};
                const prevSamples = Number(prevTel.proxySampleCount || 0);
                const prevAvg = Number(prevTel.proxyAvgTokPerSec || speed);
                const nextAvg = Math.round((((prevAvg * prevSamples) + speed) / (prevSamples + 1)) * 10) / 10;
                freshCfg.__meta__.telemetry = {
                  ...prevTel,
                  lastTokPerSec: speed,
                  proxyAvgTokPerSec: nextAvg,
                  proxySampleCount: prevSamples + 1,
                  lastInputTokens: inTok,
                  lastOutputTokens: outTok,
                  lastTotalTokens: totTok || (inTok + outTok),
                  updatedAt: Date.now()
                };
                writeRelayConfig(freshCfg);
              }
            } catch {}
          }
          if (routedTargetAcc?.id && isStreamOrGenerate) {
            setTimeout(() => {
              probeChannelQuotaSnapshot(routedTargetAcc.id).catch(() => {});
            }, 2000);
          }
          resolve();
        });
      }
    );
    upReq.on("error", (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      } else {
        try { res.end(); } catch {}
      }
      resolve();
    });
    upReq.on("timeout", () => {
      upReq.destroy();
      if (!res.headersSent) {
        res.writeHead(504, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Upstream CloudCode timeout" }));
      } else {
        try { res.end(); } catch {}
      }
      resolve();
    });
    if (outBodyBuf.length > 0) {
      upReq.write(outBodyBuf);
    }
    upReq.end();
  });
}

const CLOUDCODE_PROXY_CANDIDATE_PORTS = [8091, 8092, 8093, 8094, 8095, 8096, 8097, 8098, 8099, 0];
globalThis.__agyCloudCodeProxyHandler = proxyCloudCodeRequest;

export function getActiveCloudCodeProxyUrl(cfg = null) {
  if (
    globalThis.__agyCloudCodeProxyUrl &&
    /^http:\/\/127\.0\.0\.1:809\d$/i.test(globalThis.__agyCloudCodeProxyUrl)
  ) {
    return globalThis.__agyCloudCodeProxyUrl;
  }
  const ctx = resolveCurrentInstanceContext();
  const instSaved = cfg ? String(getInstanceMeta(cfg, ctx)?.cloudCodeProxyUrl || "").trim() : "";
  if (/^http:\/\/127\.0\.0\.1:809\d$/i.test(instSaved)) {
    return instSaved;
  }
  const saved = !ctx.isIsolatedInstance ? String(cfg?.__meta__?.cloudCodeProxyUrl || "").trim() : "";
  if (/^http:\/\/127\.0\.0\.1:809\d$/i.test(saved)) {
    return saved;
  }
  return ctx.isIsolatedInstance ? "http://127.0.0.1:8092" : "http://127.0.0.1:8091";
}

function checkExistingRelayProxyOnPort(port) {
  return new Promise((resolve) => {
    if (!port || port <= 0) return resolve(false);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/__agy_proxy_ping",
        method: "GET",
        timeout: 350
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode !== 200) return resolve(false);
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            resolve(Boolean(data && data.service === "antigravity-relay-proxy" && data.pid === process.pid));
          } catch {
            resolve(false);
          }
        });
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function persistAndSyncProxyUrl(proxyUrl) {
  if (!proxyUrl) return;
  const effectiveUrl = proxyUrl;
  globalThis.__agyCloudCodeProxyUrl = effectiveUrl;
  try {
    const cfg = readRelayConfig();
    const ctx = resolveCurrentInstanceContext();
    const instMeta = getInstanceMeta(cfg, ctx);
    const isLiveGcp = Boolean(instMeta.lastAppliedGcpProject || (!ctx.isIsolatedInstance && cfg.__meta__?.lastAppliedGcpProject));
    const hasActivePersonalRouting = !isLiveGcp && Object.values(cfg.routing?.models || {}).some(
      (v) => typeof v === "string" && v !== "follow_current" && v.trim() !== ""
    );
    const isLocalProxy = !isLiveGcp && hasActivePersonalRouting;
    const desiredUrl = isLocalProxy ? effectiveUrl : "https://cloudcode-pa.googleapis.com";
    const prevMode = instMeta.cloudCodeProxyMode;
    let changed = false;
    if (instMeta.cloudCodeProxyUrl !== desiredUrl) {
      instMeta.cloudCodeProxyUrl = desiredUrl;
      changed = true;
    }
    if (!ctx.isIsolatedInstance && cfg.__meta__.cloudCodeProxyUrl !== desiredUrl) {
      cfg.__meta__.cloudCodeProxyUrl = desiredUrl;
      changed = true;
    }
    if (changed) {
      writeRelayConfig(cfg);
    }
    const ls = discoverLanguageServer(false);
    if (ls && (isLocalProxy || (prevMode === "local_proxy" && instMeta.cloudCodeProxyPid === ls.pid))) {
      callLsRpc(ls, "SetCloudCodeURL", { url: desiredUrl }).catch(() => {});
    }
  } catch {}
}

export function ensureCloudCodeProxyServer() {
  if (globalThis.__agyCloudCodeProxyServer) {
    if (globalThis.__agyCloudCodeProxyPort && !globalThis.__agyCloudCodeProxyUrl) {
      persistAndSyncProxyUrl(`http://127.0.0.1:${globalThis.__agyCloudCodeProxyPort}`);
    }
    return globalThis.__agyCloudCodeProxyServer;
  }

  const createProxyHttpServer = () =>
    http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        const rawBuf = Buffer.concat(chunks);
        const handler = globalThis.__agyCloudCodeProxyHandler || proxyCloudCodeRequest;
        try {
          await handler(req, res, rawBuf);
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
        }
      });
    });

  const tryBindCandidateIndex = (idx) => {
    if (idx >= CLOUDCODE_PROXY_CANDIDATE_PORTS.length) return;
    const candidatePort = CLOUDCODE_PROXY_CANDIDATE_PORTS[idx];
    const srv = createProxyHttpServer();

    srv.once("error", async (err) => {
      try { srv.close(); } catch {}
      if (err && err.code === "EADDRINUSE" && candidatePort > 0) {
        const isOurProxy = await checkExistingRelayProxyOnPort(candidatePort);
        if (isOurProxy) {
          globalThis.__agyCloudCodeProxyPort = candidatePort;
          persistAndSyncProxyUrl(`http://127.0.0.1:${candidatePort}`);
          return;
        }
      }
      tryBindCandidateIndex(idx + 1);
    });

    srv.once("listening", () => {
      const actualPort = srv.address()?.port || candidatePort || 8091;
      srv.unref();
      globalThis.__agyCloudCodeProxyServer = srv;
      globalThis.__agyCloudCodeProxyPort = actualPort;
      persistAndSyncProxyUrl(`http://127.0.0.1:${actualPort}`);
    });

    srv.listen(candidatePort, "127.0.0.1");
  };

  tryBindCandidateIndex(0);
  return globalThis.__agyCloudCodeProxyServer || null;
}

function tryLaunchCloudCodeProxyOnStartup() {
  const isSidecarDaemon =
    Boolean(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) ||
    Boolean(process.env.PORT) ||
    process.argv.some((a) => /main\.mjs$/i.test(String(a)));
  if (isSidecarDaemon) {
    ensureCloudCodeProxyServer();
  }
}

tryLaunchCloudCodeProxyOnStartup();

export async function routeChannelEphemeral(accountId) {
  const cfg = readRelayConfig();
  normalizeAccountChannels(cfg);
  const target = cfg.accounts?.[accountId];
  if (!target || target.channelType === "gcp" || target.gcpProjectId) {
    return { routed: false, error: `Personal channel not found: ${accountId}` };
  }

  const isLiveGcp = Boolean(cfg.__meta__?.lastAppliedGcpProject);
  if (!isLiveGcp) {
    const ls = discoverLanguageServer(false) || discoverLanguageServer(true);
    const proxyUrl = getActiveCloudCodeProxyUrl(cfg);
    if (ls) {
      await callLsRpc(ls, "SetCloudCodeURL", { url: proxyUrl }).catch(() => {});
      cfg.__meta__.cloudCodeProxyPid = ls.pid;
      cfg.__meta__.cloudCodeProxyMode = "local_proxy";
      cfg.__meta__.cloudCodeProxyUrl = proxyUrl;
    }
  }

  cfg.__meta__.lastRoutedChannelId = target.id;
  writeRelayConfig(cfg);

  return {
    routed: true,
    channelId: target.id,
    email: target.email,
    gcpProjectId: ""
  };
}
