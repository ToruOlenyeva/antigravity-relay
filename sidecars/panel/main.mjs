import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  PLUGINS_DIR,
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

function checkParentLanguageServerAlive() {
  const ppid = Number(process.ppid || 0);
  if (ppid <= 0) return true;
  try {
    process.kill(ppid, 0);
    return true;
  } catch (err) {
    if (err && err.code === "ESRCH") {
      process.exit(0);
    }
    return true;
  }
}

setInterval(checkParentLanguageServerAlive, 5000).unref();
try {
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
} catch {}

function restartSelfGracefully() {
  setTimeout(() => {
    process.exit(0);
  }, 120);
}

let lsBridge = await import("./ls-bridge.mjs");

const bridgePath = path.join(__dirname, "ls-bridge.mjs");
try {
  fs.watchFile(bridgePath, { interval: 1000 }, async (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) {
      restartSelfGracefully();
    }
  });
} catch (e) {}

process.on("uncaughtException", (err) => {
  console.error("[AGY Relay Sidecar] Uncaught exception:", err?.message || err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[AGY Relay Sidecar] Unhandled rejection:", reason);
});

const sseClients = new Set();
let latestSnapshot = null;

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
  latestSnapshot = snapshot;
  const payload = `data: ${JSON.stringify(snapshot)}\n\n`;
  for (const clientRes of sseClients) {
    try {
      clientRes.write(payload);
    } catch {
      sseClients.delete(clientRes);
    }
  }
}

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
      return sendJson(res, 200, { success: false, ignored: true });
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

  if (req.method === "GET" && pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Connection": "keep-alive"
    });
    res.write(": connected\n\n");
    if (latestSnapshot) {
      try {
        res.write(`data: ${JSON.stringify(latestSnapshot)}\n\n`);
      } catch {}
    }
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (req.method === "GET" && pathname === "/api/status") {
    try {
      const force = url.searchParams.get("force") === "1";
      if (force) {
        await lsBridge.probeAllChannelsQuotaSnapshot().catch(() => {});
      }
      const snap = await lsBridge.fetchLiveSystemSnapshot(force);
      broadcastSnapshot(snap);
      return sendJson(res, 200, snap);
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // 1. 识别并保存当前已登录账户（若当前处于云项目通道且尚未收录同邮箱个人通道，同步补齐个人通道卡片）
  if (req.method === "POST" && pathname === "/api/save-current-account") {
    try {
      let snap = await lsBridge.fetchLiveSystemSnapshot(true);
      const email = snap.activeAccount?.email || "";
      if (email && snap.activeAccount?.gcpProjectId) {
        const hasPersonal = (snap.accounts || []).some((a) => a.id === `${email}#personal`);
        if (!hasPersonal) {
          lsBridge.addOrUpdatePersonalChannelCard(email);
          await lsBridge.probeChannelQuotaSnapshot(`${email}#personal`).catch(() => {});
          snap = await lsBridge.fetchLiveSystemSnapshot(false);
        }
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

  // 5. 切换通道或谷歌账号（写入凭据并异步调度重启 Language Server，先返回 HTTP 响应防止被宿主重载打断，并自动延时跟进推送 SSE 快照）
  if (req.method === "POST" && pathname === "/api/switch-account") {
    try {
      const { accountId, scrubSignatures } = await readJsonBody(req);
      const result = await lsBridge.switchActiveGoogleAccount(accountId, { scrubSignatures });
      const snap = await lsBridge.fetchLiveSystemSnapshot(false);
      broadcastSnapshot(snap);
      for (const delayMs of [1200, 2600, 4500]) {
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

  // 5-0. 手动一键清除全盘历史会话中的思维签名（用于用户按需手动修复跨通道报错）
  if (req.method === "POST" && pathname === "/api/scrub-signatures") {
    try {
      const result = await lsBridge.manualScrubAllSignatures();
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
      const snap = await lsBridge.fetchLiveSystemSnapshot(false);
      broadcastSnapshot(snap);
      return sendJson(res, 200, { success: true, channelId, cachedQuota, snapshot: snap });
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

  // 7. 删除账号快照
  if (req.method === "POST" && pathname === "/api/delete-account") {
    try {
      const { accountId } = await readJsonBody(req);
      const cfg = readRelayConfig();
      if (cfg.accounts?.[accountId]) {
        delete cfg.accounts[accountId];
        writeRelayConfig(cfg);
      }
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
        targetRouteMap[modelId] = targetSpec;
        if (Array.isArray(variantIds)) {
          for (const vid of variantIds) {
            if (vid) targetRouteMap[vid] = targetSpec;
          }
        }
      }
      if (subagentDefaultTarget !== undefined) {
        cfg.routing.subagentDefaultTarget = subagentDefaultTarget;
      }
      if (autoRelayOnLowQuota !== undefined) {
        cfg.routing.autoRelayOnLowQuota = Boolean(autoRelayOnLowQuota);
      }
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

const server = http.createServer(requestHandler);
server.on("error", (err) => {
  console.log(`[AGY Relay Sidecar] Port ${PORT} notice: ${err.message}`);
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[AGY Relay Sidecar] Listening on http://127.0.0.1:${PORT}`);
});

const startupInstanceCtx = resolveCurrentInstanceContext();

if (PORT !== 8089 && !startupInstanceCtx.isIsolatedInstance) {
  const standaloneServer = http.createServer(requestHandler);
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
          timeout: 500
        }, () => {});
        evictReq.on("error", () => {});
        evictReq.end();
      } catch {}
      setTimeout(() => {
        try { standaloneServer.listen(8089, "127.0.0.1"); } catch {}
      }, 400);
    }
  });
  try {
    standaloneServer.listen(8089, "127.0.0.1", () => {
      console.log("[AGY Relay Sidecar] Dual listening on http://127.0.0.1:8089");
    });
  } catch {}
}

const boundPorts = new Set([PORT, 8089]);
function bindAdditionalRelayPorts() {
  try {
    const ctx = resolveCurrentInstanceContext();
    if (ctx.isIsolatedInstance) return;
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
        const s = http.createServer(requestHandler);
        s.on("error", () => boundPorts.delete(p));
        s.listen(p, "127.0.0.1");
      } catch {
        boundPorts.delete(p);
      }
    }
  } catch {}
}

if (!startupInstanceCtx.isIsolatedInstance) {
  bindAdditionalRelayPorts();
  setTimeout(bindAdditionalRelayPorts, 4000);
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
