import https from "node:https";
import http from "node:http";
import zlib from "node:zlib";
import {
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
  learnModelsFromCloudCodeResponse
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
  selectBestPersonalChannelForModel,
  getValidPersonalAccessToken
};

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
      const routeMap = cfg.routing?.models || {};
      routeSpec = routeMap[baseFamily] || routeMap[rawModel] || "follow_current";
      if (parsedBodyJson.model) {
        parsedBodyJson.model = normalizeConsumerModelId(parsedBodyJson.model, cfg);
      }
    } catch {}
  }

  const excludedIds = new Set();

  const prepareAttemptPayload = async () => {
    const outHeaders = { ...baseHeaders };
    let outBodyBuf = rawBodyBuf || Buffer.alloc(0);
    let routedTargetAcc = null;
    let targetPool = defaultPool;
    let targetHostname = defaultUpstreamHostname;
    let strippedSigCount = 0;

    if (isGenerateEndpoint && parsedBodyJson) {
      const bodyClone = JSON.parse(JSON.stringify(parsedBodyJson));
      if (routeSpec === "auto_poll") {
        const bestCand = selectBestPersonalRouteCandidate(baseFamily, cfg, excludedIds);
        if (bestCand) {
          routedTargetAcc = bestCand.acc;
          targetPool = bestCand.pool;
          targetHostname = getCloudCodeHostnameForPool(targetPool);
        } else if (activePersonalAcc && !excludedIds.has(`${activePersonalAcc.id}@${defaultPool}`)) {
          routedTargetAcc = activePersonalAcc;
          targetPool = defaultPool;
          targetHostname = getCloudCodeHostnameForPool(targetPool);
        }
      } else if (typeof routeSpec === "string" && routeSpec.startsWith("account:")) {
        const rawRef = routeSpec.slice(8).trim();
        const hashIdx = rawRef.indexOf("#");
        const poolAtIdx = hashIdx >= 0 ? rawRef.indexOf("@", hashIdx) : -1;
        const refId = poolAtIdx >= 0 ? rawRef.slice(0, poolAtIdx) : rawRef;
        const explicitPool = poolAtIdx >= 0 ? rawRef.slice(poolAtIdx + 1) : "";
        const candidateAcc = cfg.accounts?.[refId] || (!refId.includes("#") ? cfg.accounts?.[`${refId}#personal`] : null);
        if (candidateAcc && candidateAcc.channelType !== "gcp" && !candidateAcc.gcpProjectId) {
          let chosenPool = explicitPool ? normalizePersonalQuotaPool(explicitPool) : defaultPool;
          const chosenQuota = candidateAcc.cachedQuotaByPool?.[chosenPool] || (chosenPool === defaultPool ? candidateAcc.cachedQuota : null);
          const matchedChosen = (chosenQuota?.availableModels || []).find(
            (m) => (m.modelId || m.label || "").toLowerCase() === baseFamily.toLowerCase()
          );
          const chosenDual = extractModelDualQuota(chosenQuota, matchedChosen, baseFamily);
          if (!explicitPool && (chosenDual.weeklyPct <= 0 || chosenDual.fiveHourPct <= 0 || excludedIds.has(`${candidateAcc.id}@${chosenPool}`))) {
            const altPool = chosenPool === "prod" ? "daily" : "prod";
            const altQuota = candidateAcc.cachedQuotaByPool?.[altPool];
            const matchedAlt = (altQuota?.availableModels || []).find(
              (m) => (m.modelId || m.label || "").toLowerCase() === baseFamily.toLowerCase()
            );
            const altDual = extractModelDualQuota(altQuota, matchedAlt, baseFamily);
            if (altDual.weeklyPct > 0 && altDual.fiveHourPct > 0 && !excludedIds.has(`${candidateAcc.id}@${altPool}`)) {
              chosenPool = altPool;
            }
          }
          if (!excludedIds.has(candidateAcc.id) && !excludedIds.has(`${candidateAcc.id}@${chosenPool}`)) {
            routedTargetAcc = candidateAcc;
            targetPool = chosenPool;
            targetHostname = getCloudCodeHostnameForPool(targetPool);
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
      }

      outHeaders["Host"] = targetHostname;
      // 个人号之间共享同一套消费级 Tink 签名密钥，无感剥离跨通道遗留的 GCP 签名（含带 6 字节 Protobuf 长度头的长签名），防未手动点清除签名时触发 400
      strippedSigCount = stripThoughtSignaturesFromJson(bodyClone, { onlyGcpSignatures: true });

      if (routedTargetAcc) {
        const targetToken = await getValidPersonalAccessToken(cfg, routedTargetAcc);
        if (targetToken) {
          outHeaders["authorization"] = `Bearer ${targetToken}`;
          delete outHeaders["Authorization"];
          delete outHeaders["x-goog-user-project"];
          delete outHeaders["X-Goog-User-Project"];
          const targetCompanionPid = await ensurePersonalCompanionProjectId(cfg, routedTargetAcc, targetToken, targetHostname);
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
      }
      outBodyBuf = Buffer.from(JSON.stringify(bodyClone), "utf8");
    } else {
      outHeaders["Host"] = targetHostname;
    }

    outHeaders["Content-Length"] = outBodyBuf.length;
    return { outHeaders, outBodyBuf, routedTargetAcc, targetPool, targetHostname };
  };

  const reqStartAt = Date.now();
  const isStreamOrGenerate = /^\/v1internal:(streamGenerateContent|generateContent)\b/i.test(reqUrl);

  const executeUpstreamAttempt = async (attemptIdx) => {
    const { outHeaders, outBodyBuf, routedTargetAcc, targetPool, targetHostname } = await prepareAttemptPayload();

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
          if (
            isGenerateEndpoint &&
            upRes.statusCode === 429 &&
            routedTargetAcc?.id &&
            attemptIdx < 5
          ) {
            excludedIds.add(`${routedTargetAcc.id}@${targetPool}`);
            const altPool = targetPool === "prod" ? "daily" : "prod";
            const hasExplicitPoolLock = typeof routeSpec === "string" &&
              routeSpec.startsWith("account:") &&
              routeSpec.indexOf("#") >= 0 &&
              routeSpec.indexOf("@", routeSpec.indexOf("#")) >= 0;
            const hasNextCandidate = routeSpec === "auto_poll"
              ? Boolean(selectBestPersonalRouteCandidate(baseFamily, cfg, excludedIds))
              : (!hasExplicitPoolLock && !excludedIds.has(`${routedTargetAcc.id}@${altPool}`));
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
                const enc = String(upRes.headers["content-encoding"] || "").toLowerCase();
                const decodedBuf = enc === "gzip" ? zlib.gunzipSync(respBuf) : respBuf;
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

          if (isFetchModelsEndpoint && upRes.statusCode === 200 && !upRes.headers["content-encoding"]) {
            const chunks = [];
            upRes.on("data", (c) => chunks.push(c));
            upRes.on("end", () => {
              let respBuf = Buffer.concat(chunks);
              try {
                const respJson = JSON.parse(respBuf.toString("utf8"));
                if (respJson?.models && typeof respJson.models === "object") {
                  learnModelsFromCloudCodeResponse(cfg, respJson);
                  const routeMap = cfg.routing?.models || {};
                  const curPool = getActivePersonalQuotaPool(cfg);
                  let modified = false;
                  for (const [mKey, mObj] of Object.entries(respJson.models)) {
                    if (!mObj || typeof mObj !== "object" || /disabled$/i.test(mKey)) continue;
                    const mFamily = resolveBaseModelFamilyFromId(mKey, cfg);
                    const rSpec = routeMap[mFamily] || routeMap[mKey] || "follow_current";
                    let tAcc = null;
                    let tPool = curPool;
                    if (rSpec === "auto_poll") {
                      const bestCand = selectBestPersonalRouteCandidate(mFamily, cfg);
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
                      tAcc = cfg.accounts?.[refId] || (!refId.includes("#") ? cfg.accounts?.[`${refId}#personal`] : null);
                      if (expPool) tPool = normalizePersonalQuotaPool(expPool);
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
          upRes.on("data", (chunk) => {
            if (!firstChunkAt) firstChunkAt = Date.now();
            if (isStreamOrGenerate && !upRes.headers["content-encoding"] && streamSampleLen < 524288) {
              streamSampleChunks.push(chunk);
              streamSampleLen += chunk.length;
            }
            try { res.write(chunk); } catch {}
          });
          upRes.on("end", () => {
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
    let changed = false;
    if (instMeta.cloudCodeProxyUrl !== desiredUrl || instMeta.cloudCodeProxyMode !== desiredMode) {
      instMeta.cloudCodeProxyUrl = desiredUrl;
      instMeta.cloudCodeProxyMode = desiredMode;
      changed = true;
    }
    if (!ctx.isIsolatedInstance && (cfg.__meta__.cloudCodeProxyUrl !== desiredUrl || cfg.__meta__.cloudCodeProxyMode !== desiredMode)) {
      cfg.__meta__.cloudCodeProxyUrl = desiredUrl;
      cfg.__meta__.cloudCodeProxyMode = desiredMode;
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
