import https from "node:https";
import http from "node:http";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import {
  HOME_DIR,
  readRelayConfig,
  writeRelayConfig,
  resolveCurrentInstanceContext,
  getInstanceMeta
} from "../store.mjs";
import {
  discoverLanguageServer,
  callLsRpc,
  getCloudCodeUserAgent
} from "./wincred-ls.mjs";
import {
  normalizeAccountChannels,
  probeChannelQuotaSnapshot,
  isDowngradedConsumerPoolProject,
  normalizePersonalQuotaPool,
  getActivePersonalQuotaPool,
  getCloudCodeHostnameForPool,
  learnModelsFromCloudCodeResponse,
  learnObservedWireSlugForFamily,
  isGuessedOrchestratorSlug,
  isLegacyDeprecatedModel,
  stripModelVariantSuffix,
  ensureDynamicModelRegistry,
  resolveFamilyForCloudSlug,
  parseCloudCodeApiError,
  parseTierRouteSpec,
  getPersonalAccountTierKey
} from "./quota-probe.mjs";
import {
  isGcpThoughtSignature,
  stripThoughtSignaturesFromJson,
  resolveBaseModelFamilyFromId,
  normalizeConsumerModelId,
  ensurePersonalCompanionProjectId,
  extractModelDualQuota,
  hasActivePersonalRoutingConfig,
  selectBestPersonalRouteCandidate,
  selectPinnedPersonalAccountCandidate,
  selectBestPersonalChannelForModel,
  getValidPersonalAccessToken
} from "./route-selector.mjs";

export {
  isGcpThoughtSignature,
  stripThoughtSignaturesFromJson,
  resolveBaseModelFamilyFromId,
  normalizeConsumerModelId,
  ensurePersonalCompanionProjectId,
  extractModelDualQuota,
  hasActivePersonalRoutingConfig,
  selectBestPersonalRouteCandidate,
  selectPinnedPersonalAccountCandidate,
  selectBestPersonalChannelForModel,
  getValidPersonalAccessToken
};

function decodeCompressedBody(respBuf, contentEncoding) {
  const enc = String(contentEncoding || "").toLowerCase();
  if (enc.includes("gzip")) return zlib.gunzipSync(respBuf);
  if (enc.includes("deflate")) return zlib.inflateSync(respBuf);
  if (enc.includes("br")) return zlib.brotliDecompressSync(respBuf);
  return respBuf;
}

function parseHttpErrorDetails(statusCode, rawBuf, contentEncoding = "", endpoint = "") {
  let text = "";
  try {
    text = decodeCompressedBody(rawBuf, contentEncoding).toString("utf8");
  } catch {
    text = rawBuf ? rawBuf.toString("utf8") : "";
  }
  let parsedData = null;
  try {
    const parsed = JSON.parse(text);
    parsedData = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {}
  return parseCloudCodeApiError(
    { status: statusCode, data: parsedData, raw: parsedData ? "" : text },
    endpoint
  );
}

function recordProxyFailure(cfg, info) {
  if (!cfg.__meta__ || typeof cfg.__meta__ !== "object") cfg.__meta__ = {};
  const errObj = info.errorObj && typeof info.errorObj === "object" ? info.errorObj : null;
  const entry = {
    at: new Date().toISOString(),
    statusCode: Number(info.statusCode || errObj?.status || 0),
    endpoint: info.endpoint || errObj?.endpoint || "",
    rawModel: info.rawModel || "",
    mappedModel: info.mappedModel || "",
    baseFamily: info.baseFamily || "",
    routeSpec: info.routeSpec || "",
    targetChannelId: info.targetChannelId || "",
    targetEmail: info.targetEmail || "",
    targetPool: info.targetPool || "",
    reason: errObj?.reason || "",
    category: errObj?.category || "",
    validationUrl: errObj?.validationUrl || "",
    message: String(errObj?.message || info.message || "").slice(0, 600)
  };
  cfg.__meta__.lastProxyError = entry;
  const list = Array.isArray(cfg.__meta__.recentProxyErrors) ? cfg.__meta__.recentProxyErrors : [];
  list.unshift(entry);
  cfg.__meta__.recentProxyErrors = list.slice(0, 15);
  const acc = entry.targetChannelId ? cfg.accounts?.[entry.targetChannelId] : null;
  if (acc && (entry.statusCode === 401 || entry.statusCode === 403)) {
    acc.lastProbeError = {
      at: Date.now(),
      status: entry.statusCode,
      apiStatus: errObj?.apiStatus || "",
      reason: errObj?.reason || "",
      category: errObj?.category || "",
      endpoint: entry.endpoint,
      message: entry.message,
      detailMessage: errObj?.detailMessage || "",
      validationUrl: errObj?.validationUrl || "",
      helpLinks: Array.isArray(errObj?.helpLinks) ? errObj.helpLinks : []
    };
    if (entry.statusCode === 403 && /#3501|valid license/i.test(entry.message)) {
      acc.routeBlockedUntil = Date.now() + 600000;
      acc.routeBlockedReason = "HTTP 403 (#3501)";
    } else if (entry.statusCode === 403 && (errObj?.category === "validation_required" || /VALIDATION_REQUIRED|verify your account/i.test(entry.message))) {
      acc.routeBlockedUntil = Date.now() + 600000;
      acc.routeBlockedReason = "HTTP 403 (VALIDATION_REQUIRED)";
    }
  }
  writeRelayConfig(cfg);
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
  const isLoadCodeAssistEndpoint = /^\/v1internal:loadCodeAssist\b/i.test(reqUrl);
  const defaultPool = getActivePersonalQuotaPool(cfg);
  const defaultUpstreamHostname = getCloudCodeHostnameForPool(defaultPool, false);

  const baseHeaders = {};
  for (const [k, v] of Object.entries(req.headers || {})) {
    const lk = k.toLowerCase();
    if (lk === "host" || lk === "connection" || lk === "content-length") continue;
    baseHeaders[k] = v;
  }
  baseHeaders["Host"] = defaultUpstreamHostname;
  const incomingUa = String(baseHeaders["user-agent"] || baseHeaders["User-Agent"] || "");
  if (!incomingUa || !/aidev_client|antigravity\/hub/i.test(incomingUa)) {
    delete baseHeaders["User-Agent"];
    baseHeaders["user-agent"] = getCloudCodeUserAgent();
  }

  const descId = ctx.isIsolatedInstance ? String(ctx.descriptor?.activeChannelId || "").trim() : "";
  const descTs = ctx.isIsolatedInstance ? Math.max(Number(ctx.descriptor?.switchedAt || 0), Number(ctx.descriptor?.launchedAt || 0)) : 0;
  const metaTs = Math.max(Number(instMeta?.switchedAt || 0), Number(instMeta?.seededLaunchAt || 0));
  const activeChannelId = String(
    (descId && descTs >= metaTs ? descId : (instMeta?.activeChannelId || descId || (!ctx.isIsolatedInstance ? cfg.__meta__?.activeChannelId : ""))) || ""
  ).trim();
  const activePersonalAcc = (activeChannelId && cfg.accounts?.[activeChannelId] && cfg.accounts[activeChannelId].channelType !== "gcp" && !cfg.accounts[activeChannelId].gcpProjectId)
    ? cfg.accounts[activeChannelId]
    : null;

  let parsedBodyJson = null;
  let rawModel = "";
  let baseFamily = "";
  let routeSpec = "follow_current";

  if (isGenerateEndpoint && rawBodyBuf && rawBodyBuf.length > 0) {
    try {
      parsedBodyJson = JSON.parse(rawBodyBuf.toString("utf8"));
      rawModel = String(parsedBodyJson.model || cfg.__meta__?.lastRoutedModel || "").trim();
      baseFamily = resolveBaseModelFamilyFromId(rawModel, cfg);
      const reg = ensureDynamicModelRegistry(cfg);
      if (rawModel && (!baseFamily || baseFamily.toLowerCase() === rawModel.toLowerCase())) {
        let inferred = resolveFamilyForCloudSlug(rawModel, null, reg);
        if (!inferred) {
          const convId = String(instMeta?.lastActiveConvId || cfg.__meta__?.lastActiveConvId || "").trim();
          if (convId) {
            try {
              const tPath = path.join(HOME_DIR, ".gemini", "antigravity", "brain", convId, ".system_generated", "logs", "transcript.jsonl");
              if (fs.existsSync(tPath)) {
                const st = fs.statSync(tPath);
                const readSize = Math.min(st.size, 65536);
                const fd = fs.openSync(tPath, "r");
                const buf = Buffer.alloc(readSize);
                try {
                  fs.readSync(fd, buf, 0, readSize, Math.max(0, st.size - readSize));
                } finally {
                  fs.closeSync(fd);
                }
                const matches = [...buf.toString("utf8").matchAll(/changed setting `Model Selection` from .*? to ([^.\r\n]+)/g)];
                if (matches.length > 0) {
                  const selFam = stripModelVariantSuffix(String(matches[matches.length - 1][1] || "").trim());
                  const selLower = selFam.toLowerCase();
                  const existingSlug = reg.labelToSlug?.[selLower];
                  if (selFam && (!existingSlug || isGuessedOrchestratorSlug(existingSlug) || existingSlug.toLowerCase() === rawModel.toLowerCase())) {
                    inferred = selFam;
                  }
                }
              }
            } catch {}
          }
        }
        if (inferred) {
          baseFamily = inferred;
        }
      }
      if (rawModel && baseFamily && baseFamily.toLowerCase() !== rawModel.toLowerCase()) {
        if (learnObservedWireSlugForFamily(cfg, rawModel, baseFamily)) {
          writeRelayConfig(cfg);
        }
      }
      const routeMap = cfg.routing?.models || {};
      routeSpec =
        routeMap[baseFamily] ||
        routeMap[rawModel] ||
        routeMap[rawModel.toLowerCase()] ||
        routeMap[rawModel.toUpperCase()] ||
        "follow_current";
      if (parsedBodyJson.model) {
        parsedBodyJson.model = normalizeConsumerModelId(parsedBodyJson.model, cfg);
      }
    } catch {}
  }

  const excludedIds = new Set();
  const targetTierKey = parseTierRouteSpec(routeSpec);
  const allowTierFallback = cfg.routing?.tierFallbackToAny !== false;
  const tierSelectOpts = targetTierKey
    ? { preferredTierKey: targetTierKey, allowFallback: allowTierFallback }
    : null;
  let pinnedCandidateAcc = null;
  let pinnedExplicitPool = "";
  if (typeof routeSpec === "string" && routeSpec.startsWith("account:")) {
    const rawRef = routeSpec.slice(8).trim();
    const hashIdx = rawRef.indexOf("#");
    const poolAtIdx = hashIdx >= 0 ? rawRef.indexOf("@", hashIdx) : -1;
    const refId = poolAtIdx >= 0 ? rawRef.slice(0, poolAtIdx) : rawRef;
    pinnedExplicitPool = poolAtIdx >= 0 ? normalizePersonalQuotaPool(rawRef.slice(poolAtIdx + 1)) : "";
    const resolvedPinned = cfg.accounts?.[refId] || (!refId.includes("#") ? cfg.accounts?.[`${refId}#personal`] : null);
    if (resolvedPinned && resolvedPinned.channelType !== "gcp" && !resolvedPinned.gcpProjectId) {
      pinnedCandidateAcc = resolvedPinned;
    }
  }

  const prepareAttemptPayload = async () => {
    const outHeaders = { ...baseHeaders };
    let outBodyBuf = rawBodyBuf || Buffer.alloc(0);
    let routedTargetAcc = null;
    let targetPool = defaultPool;
    let targetHostname = defaultUpstreamHostname;
    let strippedSigCount = 0;
    let resolvedToken = "";
    let tokenErrorAcc = null;
    let tierExhaustedError = null;

    if (isGenerateEndpoint && parsedBodyJson) {
      const bodyClone = JSON.parse(JSON.stringify(parsedBodyJson));
      if (routeSpec === "auto_poll" || targetTierKey) {
        let lastTokenFailedAcc = null;
        for (let tokTry = 0; tokTry < 6; tokTry++) {
          const bestCand = selectBestPersonalRouteCandidate(baseFamily, cfg, excludedIds, tierSelectOpts);
          let candAcc = null;
          let candPool = defaultPool;
          const canUseActiveAsLastResort = Boolean(
            activePersonalAcc &&
            !excludedIds.has(activePersonalAcc.id) &&
            !excludedIds.has(`${activePersonalAcc.id}@${defaultPool}`) &&
            (!targetTierKey || allowTierFallback || getPersonalAccountTierKey(activePersonalAcc) === targetTierKey)
          );
          if (bestCand) {
            candAcc = bestCand.acc;
            candPool = bestCand.pool;
          } else if (canUseActiveAsLastResort) {
            candAcc = activePersonalAcc;
            candPool = defaultPool;
          } else {
            break;
          }
          const tok = await getValidPersonalAccessToken(cfg, candAcc);
          if (tok) {
            routedTargetAcc = candAcc;
            targetPool = candPool;
            targetHostname = getCloudCodeHostnameForPool(targetPool);
            resolvedToken = tok;
            break;
          }
          excludedIds.add(candAcc.id);
          excludedIds.add(`${candAcc.id}@${candPool}`);
          lastTokenFailedAcc = candAcc;
        }
        if (!routedTargetAcc) {
          if (lastTokenFailedAcc) {
            tokenErrorAcc = lastTokenFailedAcc;
          } else if (targetTierKey && !allowTierFallback) {
            tierExhaustedError = { tierKey: targetTierKey, baseFamily };
          }
        }
      } else if (pinnedCandidateAcc) {
        if (allowTierFallback) {
          let lastTokenFailedAcc = null;
          for (let tokTry = 0; tokTry < 6; tokTry++) {
            const bestCand = selectPinnedPersonalAccountCandidate(
              pinnedCandidateAcc,
              baseFamily,
              cfg,
              excludedIds,
              { explicitPool: pinnedExplicitPool, allowFallback: true }
            );
            if (!bestCand) break;
            const tok = await getValidPersonalAccessToken(cfg, bestCand.acc);
            if (tok) {
              routedTargetAcc = bestCand.acc;
              targetPool = bestCand.pool;
              targetHostname = getCloudCodeHostnameForPool(targetPool);
              resolvedToken = tok;
              break;
            }
            excludedIds.add(bestCand.acc.id);
            excludedIds.add(`${bestCand.acc.id}@${bestCand.pool}`);
            lastTokenFailedAcc = bestCand.acc;
          }
          if (!routedTargetAcc && lastTokenFailedAcc) {
            tokenErrorAcc = lastTokenFailedAcc;
          }
        } else {
          let chosenPool = pinnedExplicitPool || defaultPool;
          const chosenQuota = pinnedCandidateAcc.cachedQuotaByPool?.[chosenPool] || (chosenPool === defaultPool ? pinnedCandidateAcc.cachedQuota : null);
          const matchedChosen = (chosenQuota?.availableModels || []).find(
            (m) => (m.modelId || m.label || "").toLowerCase() === baseFamily.toLowerCase()
          );
          const chosenDual = extractModelDualQuota(chosenQuota, matchedChosen, baseFamily);
          if (!pinnedExplicitPool && (chosenDual.weeklyPct <= 0 || chosenDual.fiveHourPct <= 0 || excludedIds.has(`${pinnedCandidateAcc.id}@${chosenPool}`))) {
            const altPool = chosenPool === "prod" ? "daily" : "prod";
            const altQuota = pinnedCandidateAcc.cachedQuotaByPool?.[altPool];
            const matchedAlt = (altQuota?.availableModels || []).find(
              (m) => (m.modelId || m.label || "").toLowerCase() === baseFamily.toLowerCase()
            );
            const altDual = extractModelDualQuota(altQuota, matchedAlt, baseFamily);
            if (altDual.weeklyPct > 0 && altDual.fiveHourPct > 0 && !excludedIds.has(`${pinnedCandidateAcc.id}@${altPool}`)) {
              chosenPool = altPool;
            }
          }
          if (!excludedIds.has(pinnedCandidateAcc.id) && !excludedIds.has(`${pinnedCandidateAcc.id}@${chosenPool}`)) {
            routedTargetAcc = pinnedCandidateAcc;
            targetPool = chosenPool;
            targetHostname = getCloudCodeHostnameForPool(targetPool);
            resolvedToken = await getValidPersonalAccessToken(cfg, routedTargetAcc);
            if (!resolvedToken && routedTargetAcc.id !== activePersonalAcc?.id) {
              tokenErrorAcc = routedTargetAcc;
            }
          }
        }
      } else if (activePersonalAcc) {
        let chosenPool = defaultPool;
        if (excludedIds.has(`${activePersonalAcc.id}@${chosenPool}`)) {
          const altPool = chosenPool === "prod" ? "daily" : "prod";
          if (!excludedIds.has(`${activePersonalAcc.id}@${altPool}`)) {
            chosenPool = altPool;
          }
        }
        routedTargetAcc = activePersonalAcc;
        targetPool = chosenPool;
        targetHostname = getCloudCodeHostnameForPool(targetPool);
        resolvedToken = await getValidPersonalAccessToken(cfg, routedTargetAcc);
      }

      outHeaders["Host"] = targetHostname;
      // 个人号之间共享同一套消费级 Tink 签名密钥，无感剥离跨通道遗留的 GCP 签名（含带 6 字节 Protobuf 长度头的长签名），防未手动点清除签名时触发 400
      strippedSigCount = stripThoughtSignaturesFromJson(bodyClone, { onlyGcpSignatures: true });

      if (routedTargetAcc && resolvedToken) {
        outHeaders["authorization"] = `Bearer ${resolvedToken}`;
        delete outHeaders["Authorization"];
        delete outHeaders["x-goog-user-project"];
        delete outHeaders["X-Goog-User-Project"];
        const targetCompanionPid = await ensurePersonalCompanionProjectId(cfg, routedTargetAcc, resolvedToken, targetHostname);
        bodyClone.project = targetCompanionPid || (targetPool === "daily" ? "aicode-consumers" : "");
        cfg.__meta__.lastRoutedChannelId = routedTargetAcc.id;
        cfg.__meta__.lastRoutedPool = targetPool;
        cfg.__meta__.lastProxyHit = {
          at: new Date().toISOString(),
          endpoint: reqUrl,
          rawModel,
          mappedModel: bodyClone.model || rawModel,
          baseFamily,
          routeSpec,
          targetChannelId: routedTargetAcc.id,
          targetEmail: routedTargetAcc.email,
          targetPool,
          targetHostname,
          targetCompanionProject: bodyClone.project || "",
          strippedSignatures: strippedSigCount
        };
        writeRelayConfig(cfg);
      }
      outBodyBuf = Buffer.from(JSON.stringify(bodyClone), "utf8");
    } else {
      outHeaders["Host"] = targetHostname;
    }

    outHeaders["Content-Length"] = outBodyBuf.length;
    return { outHeaders, outBodyBuf, routedTargetAcc, targetPool, targetHostname, tokenErrorAcc, tierExhaustedError };
  };

  const reqStartAt = Date.now();
  const isStreamOrGenerate = /^\/v1internal:(streamGenerateContent|generateContent)\b/i.test(reqUrl);

  const executeUpstreamAttempt = async (attemptIdx) => {
    const { outHeaders, outBodyBuf, routedTargetAcc, targetPool, targetHostname, tokenErrorAcc, tierExhaustedError } = await prepareAttemptPayload();
    if (tierExhaustedError) {
      const errMsg = `Tier '${tierExhaustedError.tierKey}' quota exhausted/unavailable for ${tierExhaustedError.baseFamily || "model"} and tier auto-fallback is disabled.`;
      recordProxyFailure(cfg, {
        statusCode: 429,
        endpoint: reqUrl,
        rawModel,
        mappedModel: parsedBodyJson?.model || rawModel,
        baseFamily,
        routeSpec,
        targetChannelId: "",
        targetEmail: "",
        targetPool,
        message: `HTTP 429: ${errMsg}`
      });
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: 429, message: errMsg, status: "RESOURCE_EXHAUSTED" } }));
      return;
    }
    if (tokenErrorAcc) {
      const errMsg = tokenErrorAcc.lastTokenRefreshError?.message || "Target channel OAuth token unavailable or expired";
      recordProxyFailure(cfg, {
        statusCode: 401,
        endpoint: reqUrl,
        rawModel,
        mappedModel: parsedBodyJson?.model || rawModel,
        baseFamily,
        routeSpec,
        targetChannelId: tokenErrorAcc.id,
        targetEmail: tokenErrorAcc.email,
        targetPool,
        message: `HTTP 401: ${errMsg}`
      });
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: 401, message: errMsg, status: "UNAUTHENTICATED" } }));
      return;
    }

    return new Promise((resolve) => {
      const upReq = https.request(
        {
          hostname: targetHostname,
          port: 443,
          path: reqUrl,
          method: req.method || "POST",
          family: 4,
          headers: outHeaders,
          timeout: 120000
        },
        (upRes) => {
          const isRetryableStatus = upRes.statusCode === 429 || upRes.statusCode === 401 || upRes.statusCode === 403;
          if (
            isGenerateEndpoint &&
            isRetryableStatus &&
            routedTargetAcc?.id &&
            attemptIdx < 5
          ) {
            if (upRes.statusCode === 401 || upRes.statusCode === 403) {
              const errChunks = [];
              let errLen = 0;
              upRes.on("data", (c) => {
                if (errLen < 65536) {
                  errChunks.push(c);
                  errLen += c.length;
                }
              });
              upRes.on("end", () => {
                const errBuf = Buffer.concat(errChunks);
                const errObj = parseHttpErrorDetails(upRes.statusCode, errBuf, upRes.headers["content-encoding"], reqUrl);
                recordProxyFailure(cfg, {
                  statusCode: upRes.statusCode,
                  endpoint: reqUrl,
                  rawModel,
                  mappedModel: parsedBodyJson?.model || rawModel,
                  baseFamily,
                  routeSpec,
                  targetChannelId: routedTargetAcc.id,
                  targetEmail: routedTargetAcc.email,
                  targetPool,
                  errorObj: errObj,
                  message: errObj?.message || `HTTP ${upRes.statusCode}`
                });
                excludedIds.add(routedTargetAcc.id);
                excludedIds.add(`${routedTargetAcc.id}@${targetPool}`);
                const hasFallback =
                  ((routeSpec === "auto_poll" || Boolean(targetTierKey)) &&
                    Boolean(selectBestPersonalRouteCandidate(baseFamily, cfg, excludedIds, tierSelectOpts))) ||
                  Boolean(
                    pinnedCandidateAcc &&
                    allowTierFallback &&
                    selectPinnedPersonalAccountCandidate(pinnedCandidateAcc, baseFamily, cfg, excludedIds, {
                      explicitPool: pinnedExplicitPool,
                      allowFallback: true
                    })
                  );
                if (hasFallback) {
                  executeUpstreamAttempt(attemptIdx + 1).then(resolve);
                  return;
                }
                const respHeaders = {
                  ...upRes.headers,
                  "content-length": String(errBuf.length),
                  "x-agy-routed-channel": routedTargetAcc?.id || "",
                  "x-agy-routed-pool": targetPool || ""
                };
                delete respHeaders["transfer-encoding"];
                delete respHeaders["Transfer-Encoding"];
                res.writeHead(upRes.statusCode || 403, respHeaders);
                res.end(errBuf);
                resolve();
              });
              return;
            }
            excludedIds.add(`${routedTargetAcc.id}@${targetPool}`);
            const altPool = targetPool === "prod" ? "daily" : "prod";
            const hasExplicitPoolLock = typeof routeSpec === "string" &&
              routeSpec.startsWith("account:") &&
              routeSpec.indexOf("#") >= 0 &&
              routeSpec.indexOf("@", routeSpec.indexOf("#")) >= 0;
            const hasNextCandidate = (routeSpec === "auto_poll" || Boolean(targetTierKey))
              ? Boolean(selectBestPersonalRouteCandidate(baseFamily, cfg, excludedIds, tierSelectOpts))
              : (pinnedCandidateAcc && allowTierFallback
                  ? Boolean(
                      selectPinnedPersonalAccountCandidate(pinnedCandidateAcc, baseFamily, cfg, excludedIds, {
                        explicitPool: pinnedExplicitPool,
                        allowFallback: true
                      })
                    )
                  : (!hasExplicitPoolLock && !excludedIds.has(`${routedTargetAcc.id}@${altPool}`)));
            if (hasNextCandidate) {
              upRes.resume();
              setTimeout(() => {
                probeChannelQuotaSnapshot(routedTargetAcc.id).catch(() => {});
              }, 500);
              executeUpstreamAttempt(attemptIdx + 1).then(resolve);
              return;
            }
          }

          if (isLoadCodeAssistEndpoint && upRes.statusCode === 200) {
            const chunks = [];
            upRes.on("data", (c) => chunks.push(c));
            upRes.on("end", () => {
              const respBuf = Buffer.concat(chunks);
              try {
                const decodedBuf = decodeCompressedBody(respBuf, upRes.headers["content-encoding"]);
                const respJson = JSON.parse(decodedBuf.toString("utf8"));
                const cPid = String(
                  respJson?.cloudaicompanionProject?.id ||
                  respJson?.cloudaicompanionProject ||
                  ""
                ).trim();
                if (cPid && !isDowngradedConsumerPoolProject(cPid) && activePersonalAcc) {
                  activePersonalAcc.companionProjectId = cPid;
                  if (activePersonalAcc.cachedQuota && typeof activePersonalAcc.cachedQuota === "object") {
                    activePersonalAcc.cachedQuota.companionProjectId = cPid;
                  }
                  writeRelayConfig(cfg);
                }
              } catch {}
              const respHeaders = { ...upRes.headers, "content-length": String(respBuf.length) };
              delete respHeaders["transfer-encoding"];
              delete respHeaders["Transfer-Encoding"];
              res.writeHead(upRes.statusCode || 200, respHeaders);
              res.end(respBuf);
              resolve();
            });
            return;
          }

          if (isFetchModelsEndpoint && upRes.statusCode === 200) {
            const chunks = [];
            upRes.on("data", (c) => chunks.push(c));
            upRes.on("end", () => {
              let respBuf = Buffer.concat(chunks);
              let modified = false;
              try {
                const decodedBuf = decodeCompressedBody(respBuf, upRes.headers["content-encoding"]);
                const respJson = JSON.parse(decodedBuf.toString("utf8"));
                if (respJson?.models && typeof respJson.models === "object") {
                  if (learnModelsFromCloudCodeResponse(cfg, respJson)) {
                    writeRelayConfig(cfg);
                  }
                  const routeMap = cfg.routing?.models || {};
                  const curPool = getActivePersonalQuotaPool(cfg);
                  for (const [mKey, mObj] of Object.entries(respJson.models)) {
                    if (!mObj || typeof mObj !== "object" || /disabled$/i.test(mKey)) continue;
                    const mFamily = resolveBaseModelFamilyFromId(mKey, cfg);
                    const rSpec = routeMap[mFamily] || routeMap[mKey] || "follow_current";
                    const rTierKey = parseTierRouteSpec(rSpec);
                    let tAcc = null;
                    let tPool = curPool;
                    if (rSpec === "auto_poll" || rTierKey) {
                      const bestCand = selectBestPersonalRouteCandidate(
                        mFamily,
                        cfg,
                        null,
                        rTierKey ? { preferredTierKey: rTierKey, allowFallback: allowTierFallback } : null
                      );
                      if (bestCand) {
                        tAcc = bestCand.acc;
                        tPool = bestCand.pool;
                      }
                    } else if (typeof rSpec === "string" && rSpec.startsWith("account:")) {
                      const rawRef = rSpec.slice(8).trim();
                      const hashIdx = rawRef.indexOf("#");
                      const poolAtIdx = hashIdx >= 0 ? rawRef.indexOf("@", hashIdx) : -1;
                      const refId = poolAtIdx >= 0 ? rawRef.slice(0, poolAtIdx) : rawRef;
                      const expPool = poolAtIdx >= 0 ? rawRef.slice(poolAtIdx + 1) : "";
                      const refAcc = cfg.accounts?.[refId] || (!refId.includes("#") ? cfg.accounts?.[`${refId}#personal`] : null);
                      const normExpPool = expPool ? normalizePersonalQuotaPool(expPool) : "";
                      if (refAcc && allowTierFallback) {
                        const resolvedPinned = selectPinnedPersonalAccountCandidate(refAcc, mFamily, cfg, null, {
                          explicitPool: normExpPool,
                          allowFallback: true
                        });
                        if (resolvedPinned) {
                          tAcc = resolvedPinned.acc;
                          tPool = resolvedPinned.pool;
                        }
                      } else {
                        tAcc = refAcc;
                        if (normExpPool) tPool = normExpPool;
                      }
                    }
                    if (tAcc && tAcc.channelType !== "gcp" && !tAcc.gcpProjectId) {
                      const curFraction = mObj.quotaInfo?.remainingFraction !== undefined
                        ? Number(mObj.quotaInfo.remainingFraction)
                        : (mObj.quotaInfo?.resetTime ? 0 : 1);
                      const snapModels = tAcc.cachedQuotaByPool?.[tPool]?.availableModels || tAcc.cachedQuota?.availableModels || [];
                      const matchedModel = snapModels.find(
                        (item) => (item.modelId || item.label || "").toLowerCase() === mFamily.toLowerCase()
                      );
                      if (curFraction <= 0 && matchedModel && matchedModel.remainingPct > 0) {
                        if (!mObj.quotaInfo) mObj.quotaInfo = {};
                        mObj.quotaInfo.remainingFraction = 0.01;
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
              if (modified) {
                delete respHeaders["content-encoding"];
                delete respHeaders["Content-Encoding"];
              }
              delete respHeaders["transfer-encoding"];
              delete respHeaders["Transfer-Encoding"];
              res.writeHead(upRes.statusCode || 200, respHeaders);
              res.end(respBuf);
              resolve();
            });
            return;
          }

          res.writeHead(upRes.statusCode || 200, {
            ...upRes.headers,
            "x-agy-routed-channel": routedTargetAcc?.id || "",
            "x-agy-routed-pool": targetPool || ""
          });
          let firstChunkAt = 0;
          const streamSampleChunks = [];
          let streamSampleLen = 0;
          const isErrorStatus = Number(upRes.statusCode || 200) >= 400;
          const errSampleChunks = [];
          let errSampleLen = 0;
          upRes.on("data", (chunk) => {
            if (!firstChunkAt) firstChunkAt = Date.now();
            if (isErrorStatus && errSampleLen < 16384) {
              errSampleChunks.push(chunk);
              errSampleLen += chunk.length;
            }
            if (isStreamOrGenerate && !upRes.headers["content-encoding"] && streamSampleLen < 524288) {
              streamSampleChunks.push(chunk);
              streamSampleLen += chunk.length;
            }
            try { res.write(chunk); } catch {}
          });
          upRes.on("end", () => {
            if (isErrorStatus) {
              const errObj = parseHttpErrorDetails(upRes.statusCode, Buffer.concat(errSampleChunks), upRes.headers["content-encoding"], reqUrl);
              recordProxyFailure(cfg, {
                statusCode: upRes.statusCode,
                endpoint: reqUrl,
                rawModel,
                mappedModel: parsedBodyJson?.model || rawModel,
                baseFamily,
                routeSpec,
                targetChannelId: routedTargetAcc?.id || "",
                targetEmail: routedTargetAcc?.email || "",
                targetPool,
                errorObj: errObj,
                message: errObj?.message || `HTTP ${upRes.statusCode}`
              });
            } else if (isStreamOrGenerate && routedTargetAcc?.id && (routedTargetAcc.lastProbeError || routedTargetAcc.routeBlockedUntil || routedTargetAcc.lastTokenRefreshError)) {
              delete routedTargetAcc.lastProbeError;
              delete routedTargetAcc.routeBlockedUntil;
              delete routedTargetAcc.routeBlockedReason;
              delete routedTargetAcc.lastTokenRefreshError;
              writeRelayConfig(cfg);
            }
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
            try { res.end(); } catch {}
            if (routedTargetAcc?.id && isStreamOrGenerate) {
              setTimeout(async () => {
                try {
                  await probeChannelQuotaSnapshot(routedTargetAcc.id);
                  if (typeof globalThis.__agyBroadcastLatestSnapshot === "function") {
                    await globalThis.__agyBroadcastLatestSnapshot();
                  }
                } catch {}
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
  };

  await executeUpstreamAttempt(0);
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
    const hasPersonalRouting = hasActivePersonalRoutingConfig(cfg);
    const isLocalProxy = !isLiveGcp && hasPersonalRouting;
    const directUpstreamUrl = isLiveGcp
      ? "https://cloudcode-pa.googleapis.com"
      : "https://daily-cloudcode-pa.googleapis.com";
    const desiredUrl = isLocalProxy ? effectiveUrl : directUpstreamUrl;
    const desiredMode = isLocalProxy ? "local_proxy" : "direct";
    const prevMode = instMeta.cloudCodeProxyMode;
    const prevPid = Number(instMeta.cloudCodeProxyPid || 0);
    const prevUrl = instMeta.cloudCodeProxyUrl || "";
    let changed = false;
    if (prevUrl !== desiredUrl || prevMode !== desiredMode) {
      instMeta.cloudCodeProxyUrl = desiredUrl;
      instMeta.cloudCodeProxyMode = desiredMode;
      changed = true;
    }
    if (!ctx.isIsolatedInstance && (cfg.__meta__.cloudCodeProxyUrl !== desiredUrl || cfg.__meta__.cloudCodeProxyMode !== desiredMode)) {
      cfg.__meta__.cloudCodeProxyUrl = desiredUrl;
      cfg.__meta__.cloudCodeProxyMode = desiredMode;
      changed = true;
    }
    const ls = discoverLanguageServer(false);
    const syncedAgo = Date.now() - Number(instMeta.cloudCodeProxySyncedAt || 0);
    const shouldCallRpc = Boolean(
      ls &&
      (isLocalProxy || (prevMode === "local_proxy" && prevPid === ls.pid)) &&
      (changed || prevPid !== ls.pid || prevUrl !== desiredUrl || syncedAgo < 0 || syncedAgo > 300000)
    );
    if (shouldCallRpc) {
      const nowSyncAt = Date.now();
      instMeta.cloudCodeProxyPid = ls.pid;
      instMeta.cloudCodeProxySyncedAt = nowSyncAt;
      if (!ctx.isIsolatedInstance) {
        cfg.__meta__.cloudCodeProxyPid = ls.pid;
        cfg.__meta__.cloudCodeProxySyncedAt = nowSyncAt;
      }
      changed = true;
      callLsRpc(ls, "SetCloudCodeURL", { url: desiredUrl }).catch(() => {});
    }
    if (changed) {
      writeRelayConfig(cfg);
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
