import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  PLUGINS_DIR,
  RELAY_CONFIG_FILE,
  APP_STORAGE_FILE,
  PRELOAD_SDK_PATH,
  readRelayConfig,
  writeRelayConfig,
  resolveCurrentInstanceContext,
  getActiveIsolatedSidecarPorts
} from "./store.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.PORT || 8089);
globalThis.__AGY_RELAY_MAIN_V2__ = true;

let isHostLsReachable = true;
let lsProbeFailCount = 0;

function parseHostLsAddress() {
  const raw = String(process.env.ANTIGRAVITY_LS_ADDRESS || "").trim();
  if (!raw) return null;
  const idx = raw.lastIndexOf(":");
  if (idx <= 0) return null;
  const host = raw.slice(0, idx).replace(/^\[|\]$/g, "").trim() || "127.0.0.1";
  const port = Number(raw.slice(idx + 1));
  if (!Number.isFinite(port) || port <= 0) return null;
  return { host, port };
}

function probeHostLsTcpOnce(timeoutMs = 1500) {
  const target = parseHostLsAddress();
  if (!target) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const sock = net.createConnection({ host: target.host, port: target.port });
      sock.setTimeout(timeoutMs);
      sock.once("connect", () => {
        try { sock.destroy(); } catch {}
        done(true);
      });
      sock.once("timeout", () => {
        try { sock.destroy(); } catch {}
        done(false);
      });
      sock.once("error", () => {
        try { sock.destroy(); } catch {}
        done(false);
      });
    } catch {
      done(false);
    }
  });
}

async function checkParentLanguageServerAlive() {
  const ppid = Number(process.env.AGY_PARENT_LS_PID || process.ppid || 0);
  if (ppid > 0) {
    try {
      process.kill(ppid, 0);
    } catch (err) {
      if (err && err.code === "ESRCH") {
        process.exit(0);
      }
    }
  }
  if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT && parseHostLsAddress()) {
    const alive = await probeHostLsTcpOnce(1200);
    if (alive) {
      isHostLsReachable = true;
      lsProbeFailCount = 0;
    } else if (process.uptime() > 15) {
      lsProbeFailCount += 1;
      if (lsProbeFailCount >= 2) {
        isHostLsReachable = false;
        process.exit(0);
      }
    }
  }
  return true;
}

setInterval(() => { checkParentLanguageServerAlive().catch(() => {}); }, 5000).unref();
try {
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
} catch {}

let activeProxyRequests = 0;
let pendingRestartTimer = null;
let isRestartingSelf = false;
function restartSelfGracefully() {
  if (isRestartingSelf) return;
  if (pendingRestartTimer) clearTimeout(pendingRestartTimer);
  pendingRestartTimer = setTimeout(() => {
    const activeUpstream = Number(globalThis.__agyActiveProxyRequests || 0) + activeProxyRequests;
    const recentDone = Date.now() - Number(globalThis.__agyLastProxyRequestDoneAt || 0) < 3500;
    if (activeUpstream > 0 || recentDone) {
      pendingRestartTimer = null;
      restartSelfGracefully();
      return;
    }
    isRestartingSelf = true;
    process.exit(0);
  }, 2000);
}

let lsBridge = await import("./ls-bridge.mjs");

const watchedBackendFiles = [
  path.join(__dirname, "ls-bridge.mjs"),
  path.join(__dirname, "store.mjs"),
  path.join(__dirname, "bridge", "wincred-ls.mjs"),
  path.join(__dirname, "bridge", "channel-catalog.mjs"),
  path.join(__dirname, "bridge", "cloudcode-discovery.mjs"),
  path.join(__dirname, "bridge", "quota-probe.mjs"),
  path.join(__dirname, "bridge", "route-selector.mjs"),
  path.join(__dirname, "bridge", "cloudcode-proxy.mjs"),
  path.join(__dirname, "bridge", "oauth-launcher.mjs"),
  path.join(__dirname, "bridge", "signature-scrub.mjs")
];
for (const wp of watchedBackendFiles) {
  try {
    fs.watchFile(wp, { interval: 1000 }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs) {
        restartSelfGracefully();
      }
    });
  } catch {}
}

process.on("uncaughtException", (err) => {
  console.error("[AGY Relay Sidecar] Uncaught exception:", err?.message || err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[AGY Relay Sidecar] Unhandled rejection:", reason);
});

const sseClients = new Set();
let latestSnapshot = null;
let snapshotRevision = 1;
let snapshotUpdatedAt = Date.now();
let lastSnapshotSignature = "";
let latestOAuthEvent = null;
let latestOAuthEventAt = 0;

function computeRelaySnapshotSignature(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return "";
  const activeId = snapshot.activeAccount?.channelId || snapshot.activeAccount?.id || "";
  const accountsSig = Array.isArray(snapshot.accounts)
    ? snapshot.accounts.map((a) => {
        const groups = Array.isArray(a.quotaGroups)
          ? a.quotaGroups.map((g) => `${g.groupKey || g.label || ""}:${g.remainingPercent ?? g.remainingFraction ?? ""}:${g.resetTime || ""}`).join(",")
          : "";
        return `${a.channelId || a.id || ""}|${a.tierCode || ""}|${a.lastProbeError?.code || a.lastProbeError?.message || ""}|${groups}`;
      }).join(";")
    : "";
  const topGroups = Array.isArray(snapshot.quotaGroups)
    ? snapshot.quotaGroups.map((g) => `${g.groupKey || g.label || ""}:${g.remainingPercent ?? g.remainingFraction ?? ""}:${g.resetTime || ""}`).join(",")
    : "";
  const tel = snapshot.telemetry || {};
  const telSig = `${tel.fullConversationId || tel.conversationId || ""}:${tel.totalTokens ?? ""}:${tel.roundCount ?? ""}`;
  const oauthSig = `${snapshot.oauthPending ? 1 : 0}:${snapshot.lastOAuthEvent?.eventId || snapshot.lastOAuthEvent?.email || ""}`;
  const routeSig = snapshot.routing ? JSON.stringify(snapshot.routing) : "";
  return `${snapshot.frontendVersion || ""}|${snapshot.lsOnline ? 1 : 0}|${snapshot.personalQuotaPool || ""}|${activeId}|${topGroups}|${accountsSig}|${telSig}|${oauthSig}|${routeSig}`;
}

function getFrontendAssetsVersion() {
  let ver = 0;
  for (const f of ["index.html", "styles.css", "i18n.js", "ui-session-quota.js", "ui-channels-drawers.js", "app.js"]) {
    try {
      ver += Math.floor(fs.statSync(path.join(__dirname, f)).mtimeMs);
    } catch {}
  }
  return String(ver);
}

function broadcastSnapshot(snapshot) {
  if (!snapshot) return;
  snapshot.frontendVersion = getFrontendAssetsVersion();
  if (snapshot.lastOAuthEvent?.success) {
    latestOAuthEvent = {
      ...snapshot.lastOAuthEvent,
      eventId: snapshot.lastOAuthEvent.eventId || `${snapshot.lastOAuthEvent.email || ""}:${Date.now()}`
    };
    latestOAuthEventAt = Date.now();
    snapshot.lastOAuthEvent = latestOAuthEvent;
  } else if (latestOAuthEvent && (Date.now() - latestOAuthEventAt < 60000) && !snapshot.lastOAuthEvent) {
    snapshot.lastOAuthEvent = latestOAuthEvent;
  }
  const nextSig = computeRelaySnapshotSignature(snapshot);
  if (nextSig && nextSig !== lastSnapshotSignature) {
    lastSnapshotSignature = nextSig;
    snapshotRevision += 1;
    snapshotUpdatedAt = Date.now();
  }
  snapshot.stateRevision = snapshotRevision;
  latestSnapshot = snapshot;
  if (sseClients.size === 0) return;
  const payload = `data: ${JSON.stringify(snapshot)}\n\n`;
  for (const clientRes of [...sseClients]) {
    try {
      if (clientRes.destroyed || clientRes.writableEnded) {
        clientRes.__sseCleanup?.();
        sseClients.delete(clientRes);
        continue;
      }
      clientRes.write(payload);
    } catch {
      clientRes.__sseCleanup?.();
      sseClients.delete(clientRes);
    }
  }
}

setInterval(() => {
  if (sseClients.size === 0) return;
  for (const clientRes of [...sseClients]) {
    try {
      if (clientRes.destroyed || clientRes.writableEnded) {
        clientRes.__sseCleanup?.();
        sseClients.delete(clientRes);
      } else {
        clientRes.write(": keepalive\n\n");
      }
    } catch {
      clientRes.__sseCleanup?.();
      sseClients.delete(clientRes);
    }
  }
}, 25000).unref();

globalThis.__agyBroadcastLatestSnapshot = async () => {
  try {
    const snap = await lsBridge.fetchLiveSystemSnapshot(false, { skipPersonalProbe: true });
    broadcastSnapshot(snap);
  } catch {}
};

function readRawBufferBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate"
  });
  res.end(JSON.stringify(obj));
}

async function requestHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Sidecar-Token");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // 透明反向代理拦截 Language Server 发往 /v1internal* 的 CloudCode 请求（个人模式下实现免重载跨账号 Token 替换与内存签名剥离）
  if (pathname.startsWith("/v1internal") || pathname === "/__agy_proxy_ping") {
    try {
      const rawBodyBuf = await readRawBufferBody(req);
      await lsBridge.proxyCloudCodeRequest(req, res, rawBodyBuf);
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 502, { error: `CloudCode proxy error: ${err?.message || err}` });
      } else {
        try { res.end(); } catch {}
      }
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/restart-sidecar") {
    const onlyStandalone = url.searchParams.get("onlyStandalone") === "1";
    if (onlyStandalone && process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
      const lsAlive = await probeHostLsTcpOnce(400);
      if (lsAlive) {
        isHostLsReachable = true;
        return sendJson(res, 200, { success: false, ignored: true });
      }
      isHostLsReachable = false;
      sendJson(res, 200, { success: true, evictedStaleParent: true });
      setTimeout(() => process.exit(0), 100);
      return;
    }
    sendJson(res, 200, { success: true });
    if (onlyStandalone) {
      setTimeout(() => process.exit(0), 150);
    } else {
      restartSelfGracefully();
    }
    return;
  }

  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    const htmlPath = path.join(__dirname, "index.html");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate"
    });
    res.end(fs.readFileSync(htmlPath, "utf-8"));
    return;
  }

  if (req.method === "GET" && pathname === "/styles.css") {
    res.writeHead(200, {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate"
    });
    res.end(fs.readFileSync(path.join(__dirname, "styles.css"), "utf-8"));
    return;
  }

  if (req.method === "GET" && pathname === "/i18n.js") {
    res.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate"
    });
    res.end(fs.readFileSync(path.join(__dirname, "i18n.js"), "utf-8"));
    return;
  }

  if (req.method === "GET" && (pathname === "/app.js" || pathname === "/ui-session-quota.js" || pathname === "/ui-channels-drawers.js")) {
    const scriptName = pathname.slice(1);
    res.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate"
    });
    res.end(fs.readFileSync(path.join(__dirname, scriptName), "utf-8"));
    return;
  }

  if (req.method === "GET" && pathname === "/preload.js") {
    if (fs.existsSync(PRELOAD_SDK_PATH)) {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      res.end(fs.readFileSync(PRELOAD_SDK_PATH, "utf-8"));
    } else {
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end("// preload shim");
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/state-version") {
    let configMtimeMs = 0;
    try {
      if (fs.existsSync(RELAY_CONFIG_FILE)) {
        configMtimeMs = Math.floor(fs.statSync(RELAY_CONFIG_FILE).mtimeMs);
      }
    } catch {}
    return sendJson(res, 200, {
      revision: snapshotRevision,
      frontendVersion: getFrontendAssetsVersion(),
      configMtimeMs,
      activeChannelId: latestSnapshot?.activeAccount?.channelId || latestSnapshot?.activeAccount?.id || "",
      oauthPending: Boolean(latestSnapshot?.oauthPending),
      lastOAuthEventId: latestOAuthEvent && (Date.now() - latestOAuthEventAt < 60000) ? latestOAuthEvent.eventId : "",
      updatedAt: snapshotUpdatedAt
    });
  }

  if (req.method === "GET" && pathname === "/api/events") {
    const localPort = Number(req.socket?.localPort || PORT);
    const isGatewayPort = Boolean(PORT !== 8089 && localPort === PORT);
    res.__localPort = localPort;

    if (isGatewayPort) {
      // Safeguard plugin:// LS gateway against Chromium 6-socket pool exhaustion from legacy/cached tabs
      const gatewayClients = [...sseClients].filter((c) => c.__localPort === PORT);
      while (gatewayClients.length >= 2) {
        const oldest = gatewayClients.shift();
        if (oldest) {
          oldest.__sseCleanup?.();
          sseClients.delete(oldest);
          try { oldest.end(); } catch {}
        }
      }
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Connection": isGatewayPort ? "close" : "keep-alive"
    });
    res.write(isGatewayPort ? "retry: 3000\n: connected\n\n" : ": connected\n\n");
    if (latestSnapshot) {
      try {
        res.write(`data: ${JSON.stringify(latestSnapshot)}\n\n`);
      } catch {}
    }

    let cleaned = false;
    let ttlTimer = null;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (ttlTimer) clearTimeout(ttlTimer);
      sseClients.delete(res);
    };
    res.__sseCleanup = cleanup;
    sseClients.add(res);
    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
    req.socket?.on("close", cleanup);

    if (isGatewayPort) {
      ttlTimer = setTimeout(() => {
        cleanup();
        try { res.end(); } catch {}
      }, 20000);
      ttlTimer.unref();
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/status") {
    try {
      const force = url.searchParams.get("force") === "1";
      const isLight = url.searchParams.get("light") === "1";
      if (force) {
        await lsBridge.probeAllChannelsQuotaSnapshot().catch(() => {});
      }
      const snap = await lsBridge.fetchLiveSystemSnapshot(force, { skipPersonalProbe: force || isLight });
      broadcastSnapshot(snap);
      return sendJson(res, 200, snap);
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // 1. 识别并保存当前已登录账户（仅当用户主动点击「收录当前」时才把当前原生登录账号写入通道池）
  if (req.method === "POST" && pathname === "/api/save-current-account") {
    try {
      let snap = await lsBridge.fetchLiveSystemSnapshot(true);
      const email = snap.activeAccount?.email || "";
      const gcpProjectId = snap.activeAccount?.gcpProjectId || "";
      if (email) {
        if (gcpProjectId) {
          lsBridge.addOrUpdateGcpChannelCard(email, gcpProjectId, {
            gcpBillingMode: snap.activeAccount?.gcpBillingMode || "agent_platform",
            gcpLocation: snap.activeAccount?.gcpLocation || "global"
          });
        } else {
          lsBridge.addOrUpdatePersonalChannelCard(email);
          await lsBridge.probeChannelQuotaSnapshot(`${email}#personal`).catch(() => {});
        }
        snap = await lsBridge.fetchLiveSystemSnapshot(false);
      }
      broadcastSnapshot(snap);
      return sendJson(res, 200, {
        success: true,
        email,
        snapshot: snap
      });
    } catch (err) {
      return sendJson(res, 500, { success: false, error: err.message });
    }
  }

  // 2. 呼出 Antigravity 官方浏览器登录界面（旁路零打断，支持传入个人或 GCP 目标通道参数）
  if (req.method === "POST" && pathname === "/api/start-oauth-login") {
    try {
      const oauthOpts = await readJsonBody(req).catch(() => ({}));
      const info = await lsBridge.startIsolatedOAuthFlow(oauthOpts, async (result) => {
        try {
          const snap = await lsBridge.fetchLiveSystemSnapshot(false);
          snap.lastOAuthEvent = result;
          broadcastSnapshot(snap);
        } catch {}
      });
      const snap = await lsBridge.fetchLiveSystemSnapshot(false);
      broadcastSnapshot(snap);
      return sendJson(res, 200, { success: true, ...info, snapshot: snap });
    } catch (err) {
      return sendJson(res, 500, { success: false, error: err.message });
    }
  }

  // 3. 取消旁路浏览器登录等待（不打断当前账号）
  if (req.method === "POST" && pathname === "/api/cancel-oauth-login") {
    lsBridge.cancelIsolatedOAuthFlow();
    const snap = await lsBridge.fetchLiveSystemSnapshot(false);
    broadcastSnapshot(snap);
    return sendJson(res, 200, { success: true, snapshot: snap });
  }

  // 4. 毫秒级无重启切换计费项目（个人 Pro 额度 <-> GCP 赠金项目）
  if (req.method === "POST" && pathname === "/api/switch-project") {
    try {
      const { projectId } = await readJsonBody(req);
      await lsBridge.switchBillingProjectInstant(projectId || "");
      const snap = await lsBridge.fetchLiveSystemSnapshot(true);
      broadcastSnapshot(snap);
      return sendJson(res, 200, { success: true, projectId: projectId || "", snapshot: snap });
    } catch (err) {
      return sendJson(res, 500, { success: false, error: err.message });
    }
  }

  // 5. 切换通道或谷歌账号（先准备重启配置并立刻返回 HTTP 200，再在响应落盘后触发独立重启进程）
  if (req.method === "POST" && pathname === "/api/switch-account") {
    try {
      const { accountId, scrubSignatures, conversationId } = await readJsonBody(req);
      const targetConvId = conversationId || latestSnapshot?.telemetry?.fullConversationId || latestSnapshot?.telemetry?.conversationId || "";
      const result = await lsBridge.switchActiveGoogleAccount(accountId, {
        scrubSignatures,
        conversationId: targetConvId,
        deferRestart: true
      });
      const { triggerRestart, ...publicResult } = result || {};
      const snap = publicResult?.restarting && latestSnapshot
        ? latestSnapshot
        : await lsBridge.fetchLiveSystemSnapshot(false);
      if (!publicResult?.restarting) {
        broadcastSnapshot(snap);
      }
      let triggered = false;
      const fireRestart = () => {
        if (triggered) return;
        triggered = true;
        if (typeof triggerRestart === "function") {
          setTimeout(() => {
            Promise.resolve(triggerRestart()).catch((err) => {
              console.error("[AGY Relay] deferred restart failed:", err?.message || err);
            });
          }, 60);
        }
      };
      if (typeof triggerRestart === "function") {
        res.once("finish", fireRestart);
      }
      sendJson(res, 200, { success: true, ...publicResult, snapshot: snap });
      fireRestart();
      return;
    } catch (err) {
      return sendJson(res, 500, { success: false, error: err.message });
    }
  }

  // 5-0. 手动清除会话思维签名（支持仅清除当前会话 current 与全项目扫描清除不匹配签名 mismatched 两种模式）
  if (req.method === "POST" && pathname === "/api/scrub-signatures") {
    try {
      const body = await readJsonBody(req).catch(() => ({}));
      const preSnap = latestSnapshot || await lsBridge.fetchLiveSystemSnapshot(false);
      const activeIsGcp = Boolean(preSnap?.activeAccount?.gcpProjectId);
      const targetConvId = body?.conversationId || preSnap?.telemetry?.fullConversationId || preSnap?.telemetry?.conversationId || "";
      const result = await lsBridge.manualScrubAllSignatures({
        mode: body?.mode || "mismatched",
        conversationId: targetConvId,
        activeIsGcp
      });
      const snap = await lsBridge.fetchLiveSystemSnapshot(false);
      broadcastSnapshot(snap);
      return sendJson(res, 200, { success: true, ...result, snapshot: snap });
    } catch (err) {
      return sendJson(res, 500, { success: false, error: err.message });
    }
  }

  // 5a. 多开独立 Antigravity 实例（预置目标通道凭据 + 独立 --user-data-dir，满足 GCP 与个人号双开同屏需求）
  if (req.method === "POST" && pathname === "/api/launch-instance") {
    try {
      const { accountId } = await readJsonBody(req);
      const result = await lsBridge.launchIsolatedAntigravityInstance(accountId || "");
      const snap = await lsBridge.fetchLiveSystemSnapshot(false);
      broadcastSnapshot(snap);
      for (const delayMs of [2500, 6000]) {
        setTimeout(async () => {
          try {
            const followSnap = await lsBridge.fetchLiveSystemSnapshot(false);
            broadcastSnapshot(followSnap);
          } catch {}
        }, delayMs);
      }
      return sendJson(res, 200, { success: true, ...result, snapshot: snap });
    } catch (err) {
      return sendJson(res, 500, { success: false, error: err.message });
    }
  }

  // 5b. 自动扫描指定账号下的可用 GCP 项目（仅返回项目列表供前端填入或下拉选择，不直接写入通道池）
  if (req.method === "POST" && pathname === "/api/discover-gcp-projects") {
    try {
      const { email } = await readJsonBody(req);
      const result = await lsBridge.discoverGcpProjectsForAccount(email || "");
      return sendJson(res, 200, { success: true, ...result });
    } catch (err) {
      return sendJson(res, 500, { success: false, error: err.message });
    }
  }

  // 5b-2. 为已登录邮箱添加独立个人通道卡片（处于云项目通道时也可一键恢复个人通道）
  if (req.method === "POST" && pathname === "/api/add-personal-channel") {
    try {
      const { email } = await readJsonBody(req);
      const card = lsBridge.addOrUpdatePersonalChannelCard(email || "");
      if (card?.id) {
        await lsBridge.probeChannelQuotaSnapshot(card.id).catch(() => {});
      }
      const snap = await lsBridge.fetchLiveSystemSnapshot(false);
      broadcastSnapshot(snap);
      return sendJson(res, 200, { success: Boolean(card), card, snapshot: snap });
    } catch (err) {
      return sendJson(res, 500, { success: false, error: err.message });
    }
  }

  // 5b-3. 模型算力路由静默借道（不篡改前台激活通道状态，也不强杀重启 Language Server）
  if (req.method === "POST" && pathname === "/api/route-channel") {
    try {
      const { accountId } = await readJsonBody(req);
      const result = await lsBridge.routeChannelEphemeral(accountId || "");
      return sendJson(res, 200, { success: Boolean(result?.routed), ...result });
    } catch (err) {
      return sendJson(res, 500, { success: false, error: err.message });
    }
  }

  // 5c. 手动为某邮箱派生独立 GCP 通道卡片（支持选择 Agent Platform 按量计费 / Gemini Enterprise 及区域）
  if (req.method === "POST" && pathname === "/api/add-gcp-channel") {
    try {
      const { email, projectId, gcpBillingMode, gcpLocation } = await readJsonBody(req);
      const card = lsBridge.addOrUpdateGcpChannelCard(email, projectId, {
        gcpBillingMode,
        gcpLocation
      });
      const snap = await lsBridge.fetchLiveSystemSnapshot(false);
      broadcastSnapshot(snap);
      return sendJson(res, 200, { success: Boolean(card), card, snapshot: snap });
    } catch (err) {
      return sendJson(res, 500, { success: false, error: err.message });
    }
  }

  // 5d. 旁路查询任意指定通道的配额快照（供顶部「会话与使用量」下拉框预览其他账号余额）
  if (req.method === "POST" && pathname === "/api/probe-channel-quota") {
    try {
      const { channelId } = await readJsonBody(req);
      const cachedQuota = await lsBridge.probeChannelQuotaSnapshot(channelId || "");
      const probeDiagnostic = typeof lsBridge.getLastProbeDiagnostic === "function"
        ? lsBridge.getLastProbeDiagnostic(channelId || "")
        : null;
      const snap = await lsBridge.fetchLiveSystemSnapshot(false);
      broadcastSnapshot(snap);
      return sendJson(res, 200, { success: true, channelId, cachedQuota, probeDiagnostic, snapshot: snap });
    } catch (err) {
      return sendJson(res, 500, { success: false, error: err.message });
    }
  }

  // 5e. 切换个人通道当前查看与优先路由的官方配额账本（prod: cloudcode-pa 正式服 / daily: daily-cloudcode-pa Daily 服）
  if (req.method === "POST" && pathname === "/api/switch-quota-pool") {
    try {
      const { pool } = await readJsonBody(req).catch(() => ({}));
      const result = await lsBridge.switchPersonalQuotaPool(pool || "prod");
      const snap = await lsBridge.fetchLiveSystemSnapshot(false);
      broadcastSnapshot(snap);
      return sendJson(res, 200, { success: true, ...result, snapshot: snap });
    } catch (err) {
      return sendJson(res, 500, { success: false, error: err.message });
    }
  }

  // 6. 修改账号绑定的 GCP Project ID、计费模式、区域或备注
  if (req.method === "POST" && pathname === "/api/update-account") {
    try {
      const { accountId, gcpProjectId, gcpBillingMode, gcpLocation, alias } = await readJsonBody(req);
      const cfg = readRelayConfig();
      const acc = cfg.accounts?.[accountId];
      if (!acc) {
        return sendJson(res, 404, { success: false, error: "Account not found" });
      }
      const oldPid = (acc.gcpProjectId || "").trim();
      const nextPid = gcpProjectId !== undefined ? String(gcpProjectId).trim() : oldPid;
      const nextMode = gcpBillingMode !== undefined
        ? (gcpBillingMode === "gemini_enterprise" ? "gemini_enterprise" : "agent_platform")
        : (acc.gcpBillingMode || "agent_platform");
      const nextLoc = gcpLocation !== undefined
        ? (["global", "us", "eu"].includes(gcpLocation) ? gcpLocation : "global")
        : (acc.gcpLocation || "global");

      if (acc.channelType === "gcp" && nextPid) {
        acc.gcpProjectId = nextPid;
        acc.projectName = nextPid;
        acc.gcpBillingMode = nextMode;
        acc.gcpLocation = nextLoc;
        acc.tierName = nextMode === "gemini_enterprise" ? "Gemini Enterprise" : "Agent Platform";
        if (acc.storedToken) {
          acc.storedToken.auth_method = "gcp";
          acc.storedToken.project_id = nextPid;
          acc.storedToken.region = nextMode === "agent_platform" ? nextLoc : "";
        }
        if (!cfg.gcpProjects.includes(nextPid)) {
          cfg.gcpProjects.push(nextPid);
        }
        const newKey = `${acc.email}#gcp:${nextPid}`;
        if (newKey !== accountId) {
          acc.id = newKey;
          acc.alias = `${acc.email} (${nextPid})`;
          cfg.accounts[newKey] = acc;
          delete cfg.accounts[accountId];
        }
      }
      if (alias !== undefined && String(alias).trim()) {
        acc.alias = String(alias).trim();
      }
      writeRelayConfig(cfg);

      // 若修改的恰好是当前活跃的 GCP 通道，立即同步应用新的项目 ID / 计费模式 / 区域
      const isCurrentActive = acc.email === cfg.__meta__?.activeEmail && oldPid && oldPid === cfg.__meta__?.lastAppliedGcpProject;
      if (isCurrentActive && nextPid) {
        await lsBridge.switchBillingProjectInstant(nextPid, {
          gcpBillingMode: nextMode,
          gcpLocation: nextLoc
        });
      }

      const snap = await lsBridge.fetchLiveSystemSnapshot(false);
      broadcastSnapshot(snap);
      return sendJson(res, 200, { success: true, snapshot: snap });
    } catch (err) {
      return sendJson(res, 500, { success: false, error: err.message });
    }
  }

  // 6b. 安全拉起外部 Google 账号验证或帮助链接（仅允许安全 HTTPS Google 域名）
  if (req.method === "POST" && pathname === "/api/open-external-url") {
    try {
      const { url: targetUrl } = await readJsonBody(req).catch(() => ({}));
      const cleanUrl = String(targetUrl || "").trim();
      let parsed = null;
      try { parsed = new URL(cleanUrl); } catch {}
      const hostAllowed = Boolean(
        parsed &&
        parsed.protocol === "https:" &&
        /(^|\.)(google\.com|googleapis\.com|googleusercontent\.com)$/i.test(parsed.hostname)
      );
      if (!hostAllowed) {
        return sendJson(res, 400, { success: false, error: "Unsupported or non-HTTPS verification URL" });
      }
      spawn("rundll32.exe", ["url.dll,FileProtocolHandler", parsed.toString()], {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      }).unref();
      return sendJson(res, 200, { success: true, url: parsed.toString() });
    } catch (err) {
      return sendJson(res, 500, { success: false, error: err.message });
    }
  }

  // 7. 删除账号快照
  if (req.method === "POST" && pathname === "/api/delete-account") {
    try {
      const { accountId } = await readJsonBody(req);
      const cfg = readRelayConfig();
      const targetAcc = cfg.accounts?.[accountId];
      if (targetAcc) {
        if (targetAcc.email && targetAcc.storedToken?.token) {
          if (!cfg.__meta__.oauthTokensByEmail || typeof cfg.__meta__.oauthTokensByEmail !== "object") {
            cfg.__meta__.oauthTokensByEmail = {};
          }
          if (!cfg.__meta__.oauthTokensByEmail[targetAcc.email]) {
            cfg.__meta__.oauthTokensByEmail[targetAcc.email] = targetAcc.storedToken;
          }
        }
        delete cfg.accounts[accountId];
      }
      if (!Array.isArray(cfg.__meta__.deletedChannelIds)) {
        cfg.__meta__.deletedChannelIds = [];
      }
      if (accountId && !cfg.__meta__.deletedChannelIds.includes(accountId)) {
        cfg.__meta__.deletedChannelIds.push(accountId);
      }
      writeRelayConfig(cfg);
      const snap = await lsBridge.fetchLiveSystemSnapshot(false);
      broadcastSnapshot(snap);
      return sendJson(res, 200, { success: true, snapshot: snap });
    } catch (err) {
      return sendJson(res, 500, { success: false, error: err.message });
    }
  }

  // 8. 保存模型与子智能体算力路由规则（支持 personal 与 gcp 两套独立路由表）
  if (req.method === "POST" && pathname === "/api/save-routing") {
    try {
      const { modelId, variantIds, targetSpec, routeScope, subagentDefaultTarget, autoRelayOnLowQuota } = await readJsonBody(req);
      const cfg = readRelayConfig();
      const isGcpScope = routeScope === "gcp";
      if (!cfg.routing.models || typeof cfg.routing.models !== "object") cfg.routing.models = {};
      if (!cfg.routing.gcpModels || typeof cfg.routing.gcpModels !== "object") cfg.routing.gcpModels = {};
      const targetRouteMap = isGcpScope ? cfg.routing.gcpModels : cfg.routing.models;
      if (modelId && targetSpec !== undefined) {
        const cleanBase = String(modelId).trim();
        targetRouteMap[cleanBase] = targetSpec;
        if (Array.isArray(variantIds)) {
          for (const vid of variantIds) {
            if (vid) targetRouteMap[vid] = targetSpec;
          }
        }
        // 同步更新同模型族下的所有小写连字符变体键（如 gemini-4-argon-medium），彻底杜绝旧键残留
        const slugPrefix = cleanBase
          .toLowerCase()
          .replace(/\s*\([^)]*\)\s*/g, "")
          .trim()
          .replace(/[\s_]+/g, "-");
        if (slugPrefix) {
          for (const existingKey of Object.keys(targetRouteMap)) {
            const ekLower = existingKey.toLowerCase();
            if (ekLower === slugPrefix || ekLower.startsWith(`${slugPrefix}-`)) {
              targetRouteMap[existingKey] = targetSpec;
            }
          }
        }
        const dynReg = cfg.__meta__?.dynamicModelRegistry;
        if (dynReg && typeof dynReg === "object") {
          const cleanLower = cleanBase.toLowerCase();
          const directSlug = dynReg.labelToSlug?.[cleanLower];
          if (directSlug && directSlug !== "orchestrator-argon") {
            targetRouteMap[directSlug] = targetSpec;
          }
          for (const [phKey, fam] of Object.entries(dynReg.placeholderToFamily || {})) {
            if (String(fam || "").trim().toLowerCase() === cleanLower && phKey !== "orchestrator-argon") {
              targetRouteMap[phKey] = targetSpec;
              if (/^model_/i.test(phKey)) {
                targetRouteMap[phKey.toUpperCase()] = targetSpec;
              }
            }
          }
        }
      }
      if (subagentDefaultTarget !== undefined) {
        cfg.routing.subagentDefaultTarget = subagentDefaultTarget;
      }
      if (autoRelayOnLowQuota !== undefined) {
        cfg.routing.autoRelayOnLowQuota = Boolean(autoRelayOnLowQuota);
      }
      cfg.routing.updatedAt = Date.now();
      writeRelayConfig(cfg);
      const snap = await lsBridge.fetchLiveSystemSnapshot(false);
      broadcastSnapshot(snap);
      return sendJson(res, 200, { success: true, snapshot: snap });
    } catch (err) {
      return sendJson(res, 500, { success: false, error: err.message });
    }
  }

  // 9. 切换中英文并同步外层标题
  if (req.method === "POST" && pathname === "/api/set-language") {
    try {
      const { lang } = await readJsonBody(req);
      const isEn = lang === "en";
      const pluginJsonPath = path.join(PLUGINS_DIR, "antigravity-relay", "plugin.json");
      const localSidecarPath = path.join(__dirname, "sidecar.json");
      const targetDisplayName = isEn ? "Account & Quota Manager" : "账号与配额管理";
      const targetSidecarTitle = isEn ? "Account & Quota" : "账号与配额";

      if (fs.existsSync(pluginJsonPath)) {
        const pj = JSON.parse(fs.readFileSync(pluginJsonPath, "utf-8"));
        pj.displayName = targetDisplayName;
        fs.writeFileSync(pluginJsonPath, JSON.stringify(pj, null, 2), "utf-8");
      }
      if (fs.existsSync(localSidecarPath)) {
        const sj = JSON.parse(fs.readFileSync(localSidecarPath, "utf-8"));
        sj.display_name = targetSidecarTitle;
        if (sj.ui_config?.views?.[0]) sj.ui_config.views[0].title = targetSidecarTitle;
        fs.writeFileSync(localSidecarPath, JSON.stringify(sj, null, 2), "utf-8");
      }
      return sendJson(res, 200, { success: true, lang: isEn ? "en" : "zh" });
    } catch (err) {
      return sendJson(res, 500, { success: false, error: err.message });
    }
  }

  res.writeHead(404);
  res.end("Not Found");
}

function configureSidecarHttpServer(srv) {
  srv.keepAliveTimeout = 4000;
  srv.headersTimeout = 6000;
  return srv;
}

const server = configureSidecarHttpServer(http.createServer(requestHandler));
server.on("error", (err) => {
  console.log(`[AGY Relay Sidecar] Port ${PORT} notice: ${err.message}`);
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[AGY Relay Sidecar] Listening on http://127.0.0.1:${PORT}`);
});

const startupInstanceCtx = resolveCurrentInstanceContext();

if (PORT !== 8089 && !startupInstanceCtx.isIsolatedInstance) {
  const standaloneServer = configureSidecarHttpServer(http.createServer(requestHandler));
  let retriedStandalone8089 = false;
  standaloneServer.on("error", (err) => {
    if (!retriedStandalone8089 && err && err.code === "EADDRINUSE") {
      retriedStandalone8089 = true;
      try {
        const evictReq = http.request({
          hostname: "127.0.0.1",
          port: 8089,
          path: "/api/restart-sidecar?onlyStandalone=1",
          method: "POST",
          timeout: 800
        }, () => {});
        evictReq.on("error", () => {});
        evictReq.end();
      } catch {}
      setTimeout(() => {
        try { standaloneServer.listen(8089, "127.0.0.1"); } catch {}
      }, 650);
    }
  });
  try {
    standaloneServer.listen(8089, "127.0.0.1", () => {
      console.log("[AGY Relay Sidecar] Dual listening on http://127.0.0.1:8089");
    });
  } catch {}
}

const boundPorts = new Set([PORT, 8089]);
let lastObservedAppStorageMtime = 0;
function bindAdditionalRelayPorts(forceScan = false) {
  try {
    const ctx = resolveCurrentInstanceContext();
    if (ctx.isIsolatedInstance) return;
    let currentMtime = 0;
    try {
      if (fs.existsSync(APP_STORAGE_FILE)) {
        currentMtime = Math.floor(fs.statSync(APP_STORAGE_FILE).mtimeMs);
      }
    } catch {}
    if (!forceScan && currentMtime === lastObservedAppStorageMtime && boundPorts.size > 2) return;
    lastObservedAppStorageMtime = currentMtime;

    const isolatedPorts = getActiveIsolatedSidecarPorts();
    const candidatePorts = new Set();
    const cfg = readRelayConfig();
    if (PORT !== 8089 && !isolatedPorts.has(PORT) && !cfg.__meta__.recentSidecarPorts.includes(PORT)) {
      cfg.__meta__.recentSidecarPorts.unshift(PORT);
      cfg.__meta__.recentSidecarPorts = cfg.__meta__.recentSidecarPorts.slice(0, 10);
      writeRelayConfig(cfg);
    }
    for (const p of cfg.__meta__.recentSidecarPorts) {
      const num = Number(p);
      if (num > 1024 && !isolatedPorts.has(num)) candidatePorts.add(num);
    }
    if (fs.existsSync(APP_STORAGE_FILE)) {
      const rawText = fs.readFileSync(APP_STORAGE_FILE, "utf-8");
      const regex = /antigravity-relay--panel-(\d+)/g;
      let match;
      while ((match = regex.exec(rawText)) !== null) {
        const num = Number(match[1]);
        if (num > 1024 && num < 65535 && !isolatedPorts.has(num)) candidatePorts.add(num);
      }
    }
    for (const p of candidatePorts) {
      if (boundPorts.has(p)) continue;
      boundPorts.add(p);
      try {
        const s = configureSidecarHttpServer(http.createServer(requestHandler));
        s.on("error", () => boundPorts.delete(p));
        s.listen(p, "127.0.0.1");
      } catch {
        boundPorts.delete(p);
      }
    }
  } catch {}
}

if (!startupInstanceCtx.isIsolatedInstance) {
  bindAdditionalRelayPorts(true);
  setTimeout(() => bindAdditionalRelayPorts(true), 4000);
  setInterval(() => bindAdditionalRelayPorts(false), 30000).unref();
}

// 启动即预热一次实时状态快照与全通道余额探测，同步更新 agy-relay-config.json 与 SSE 缓存
lsBridge.fetchLiveSystemSnapshot(false)
  .then(async (snap) => {
    broadcastSnapshot(snap);
    await lsBridge.probeAllChannelsQuotaSnapshot().catch(() => {});
    const updatedSnap = await lsBridge.fetchLiveSystemSnapshot(false);
    broadcastSnapshot(updatedSnap);
  })
  .catch(() => {});
