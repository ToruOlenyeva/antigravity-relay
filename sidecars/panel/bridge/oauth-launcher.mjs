import https from "node:https";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawn } from "node:child_process";
import {
  HOME_DIR,
  readRelayConfig,
  writeRelayConfig,
  resolveCurrentInstanceContext,
  writeInstanceDescriptor,
  getInstanceMeta
} from "../store.mjs";
import {
  AGY_OAUTH_CLIENT_ID,
  AGY_OAUTH_CLIENT_SECRET,
  AGY_OAUTH_SCOPES,
  AGY_AUTH_SUCCESS_URL,
  getOAuthClientForChannel,
  readWinCredToken,
  writeWinCredToken,
  buildCleanChannelToken,
  refreshOAuthAccessToken,
  inspectActiveFieldInstances
} from "./wincred-ls.mjs";
import {
  AGENT_PLATFORM_DEFAULT_MODELS,
  normalizeAccountChannels,
  findStoredTokenForEmail,
  probeChannelQuotaSnapshot
} from "./quota-probe.mjs";

function estimateTokensFromString(str) {
  if (!str) return 0;
  const s = String(str);
  let cjk = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0x4e00 && code <= 0x9fff) cjk++;
  }
  const nonCjk = s.length - cjk;
  return Math.max(1, Math.round(cjk * 1.45 + nonCjk / 3.8));
}

function stripModelVariantSuffix(rawName) {
  return String(rawName || "")
    .replace(/\s*\((Low|Medium|High|Max|Thinking)\)\s*$/i, "")
    .trim();
}

function buildKnownTelemetryModelDict(cfg) {
  const dict = new Map();
  const registerModelObj = (m) => {
    if (!m || typeof m !== "object") return;
    const baseLabel = stripModelVariantSuffix(m.label || m.modelId || "");
    if (!baseLabel) return;
    dict.set(baseLabel.toLowerCase(), baseLabel);
    if (m.label) dict.set(String(m.label).trim().toLowerCase(), baseLabel);
    if (m.modelId) dict.set(String(m.modelId).trim().toLowerCase(), baseLabel);
    if (Array.isArray(m.variantIds)) {
      for (const v of m.variantIds) {
        const vs = String(v || "").trim();
        if (!vs) continue;
        dict.set(vs.toLowerCase(), baseLabel);
        const strippedV = stripModelVariantSuffix(vs);
        if (strippedV) dict.set(strippedV.toLowerCase(), baseLabel);
      }
    }
  };

  for (const m of AGENT_PLATFORM_DEFAULT_MODELS) {
    registerModelObj(m);
  }
  const liveTierModels = cfg?.__meta__?.liveTierModels;
  if (liveTierModels && typeof liveTierModels === "object") {
    for (const list of Object.values(liveTierModels)) {
      if (Array.isArray(list)) {
        for (const m of list) registerModelObj(m);
      }
    }
  }
  try {
    const channels = normalizeAccountChannels(cfg);
    if (Array.isArray(channels)) {
      for (const ch of channels) {
        const avail = ch?.cachedQuota?.availableModels;
        if (Array.isArray(avail)) {
          for (const m of avail) registerModelObj(m);
        }
      }
    }
  } catch {}
  if (cfg?.accounts && typeof cfg.accounts === "object") {
    const accList = Array.isArray(cfg.accounts) ? cfg.accounts : Object.values(cfg.accounts);
    for (const acc of accList) {
      const avail = acc?.cachedQuota?.availableModels;
      if (Array.isArray(avail)) {
        for (const m of avail) registerModelObj(m);
      }
    }
  }
  return dict;
}

function matchKnownTelemetryModel(rawCandidate, knownDict) {
  const raw = String(rawCandidate || "").trim();
  if (!raw || /^none$/i.test(raw)) return "";

  if (knownDict && knownDict.size > 0) {
    const exactHit = knownDict.get(raw.toLowerCase());
    if (exactHit) return exactHit;
    const stripped = stripModelVariantSuffix(raw);
    const strippedHit = knownDict.get(stripped.toLowerCase());
    if (strippedHit) return strippedHit;
  }

  // 兼容 language_server.log 中的官方 API URL slug（如 gemini-4-argon / gemini-3.8-flash）
  if (/^gemini[-_\s]*4[-_\s]*argon$/i.test(raw)) return "Gemini 4 Argon";
  if (/^gemini[-_\s]*3[._-]*8[-_\s]*flash$/i.test(raw)) return "Gemini 3.8 Flash";
  if (/^gemini[-_\s]*3[._-]*7[-_\s]*flash$/i.test(raw)) return "Gemini 3.7 Flash";
  if (/^gemini[-_\s]*3[._-]*6[-_\s]*flash$/i.test(raw)) return "Gemini 3.6 Flash";
  if (/^gemini[-_\s]*3[._-]*1[-_\s]*pro$/i.test(raw)) return "Gemini 3.1 Pro";
  if (/^claude[-_\s]*opus[-_\s]*5[._-]*5$/i.test(raw)) return "Claude Opus 5.5";
  if (/^claude[-_\s]*sonnet[-_\s]*5[._-]*5$/i.test(raw)) return "Claude Sonnet 5.5";
  if (/^gemini[-_\s]*3(\s+\([a-z]+\))?$/i.test(raw)) return "Gemini 3";
  return "";
}

function discoverInstanceCdpPort(ctx) {
  try {
    if (ctx?.userDataDir) {
      const portFile = path.join(ctx.userDataDir, "DevToolsActivePort");
      if (fs.existsSync(portFile)) {
        const firstLine = (fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0] || "").trim();
        const p = Number(firstLine);
        if (p > 1024 && p < 65535) return p;
      }
    }
  } catch {}
  try {
    if (ctx?.lsLogFile && fs.existsSync(ctx.lsLogFile)) {
      const st = fs.statSync(ctx.lsLogFile);
      const readSize = Math.min(st.size, 32768);
      const fd = fs.openSync(ctx.lsLogFile, "r");
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, Math.max(0, st.size - readSize));
      fs.closeSync(fd);
      const tail = buf.toString("utf8");
      const matches = [...tail.matchAll(/ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\//g)];
      if (matches.length > 0) {
        const p = Number(matches[matches.length - 1][1]);
        if (p > 1024 && p < 65535) return p;
      }
    }
  } catch {}
  return 0;
}

function fetchWindowActiveConvIdViaCdp(port) {
  return new Promise((resolve) => {
    if (!port || port <= 1024) return resolve("");
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/json",
        timeout: 260
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve("");
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            const targets = JSON.parse(body);
            if (Array.isArray(targets)) {
              for (const t of targets) {
                if (t && t.type === "page" && typeof t.url === "string") {
                  const m = t.url.match(/\/(?:c|cascade)\/([0-9a-f-]{36})/i);
                  if (m && m[1]) return resolve(m[1]);
                }
              }
            }
          } catch {}
          resolve("");
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve("");
    });
    req.on("error", () => resolve(""));
  });
}

function extractFallbackConvAndModelFromLsLog(lsLogFile, knownDict) {
  let convId = "";
  let lastModel = "";
  try {
    if (lsLogFile && fs.existsSync(lsLogFile)) {
      const st = fs.statSync(lsLogFile);
      const readSize = Math.min(st.size, 65536);
      const fd = fs.openSync(lsLogFile, "r");
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, Math.max(0, st.size - readSize));
      fs.closeSync(fd);
      const tail = buf.toString("utf8");

      const convMatches = [
        ...tail.matchAll(/(?:root_conversation_id="|cascade_id:)([0-9a-f-]{36})/gi)
      ];
      if (convMatches.length > 0) {
        convId = convMatches[convMatches.length - 1][1] || "";
      }

      const modelMatches = [
        ...tail.matchAll(/models\/([a-zA-Z0-9._-]+):streamGenerateContent/g)
      ];
      for (let i = modelMatches.length - 1; i >= 0; i--) {
        const rawSlug = modelMatches[i][1] || "";
        if (/flash-lite/i.test(rawSlug)) continue;
        const norm = matchKnownTelemetryModel(rawSlug, knownDict);
        if (norm) {
          lastModel = norm;
          break;
        }
      }
    }
  } catch {}
  return { convId, lastModel };
}

function parseSettingsChangeModels(contentStr, knownDict) {
  if (typeof contentStr !== "string" || !contentStr.includes("<USER_SETTINGS_CHANGE>")) {
    return null;
  }
  const idx = contentStr.indexOf("changed setting `Model Selection` from ");
  if (idx < 0) return null;
  const sub = contentStr.slice(idx + "changed setting `Model Selection` from ".length);
  const firstSentence = sub.split(/\.\s+No need|\r?\n/i)[0].replace(/\.\s*$/, "").trim();
  const toIdx = firstSentence.indexOf(" to ");
  if (toIdx < 0) return null;
  const rawFrom = firstSentence.slice(0, toIdx).trim();
  const rawTo = firstSentence.slice(toIdx + 4).trim();
  return {
    fromModel: matchKnownTelemetryModel(rawFrom, knownDict),
    toModel: matchKnownTelemetryModel(rawTo, knownDict)
  };
}

export async function computeSessionTelemetrySnapshot(cfgInput = null, instanceCtx = null) {
  const cfg = cfgInput || readRelayConfig();
  const ctx = instanceCtx || resolveCurrentInstanceContext();
  const instMeta = getInstanceMeta(cfg, ctx);
  const knownDict = buildKnownTelemetryModelDict(cfg);
  const brainDir = path.join(HOME_DIR, ".gemini", "antigravity", "brain");

  // 1. 优先通过当前窗口专属 CDP 端口直读正在打开的会话路由 (/c/<convId>)，次选当前窗口专属 language_server.log 尾部会话 ID
  const cdpPort = discoverInstanceCdpPort(ctx);
  const cdpConvId = await fetchWindowActiveConvIdViaCdp(cdpPort);
  const logFallback = extractFallbackConvAndModelFromLsLog(ctx.lsLogFile, knownDict);

  let targetConvId = cdpConvId || logFallback.convId || String(instMeta.lastActiveConvId || "").trim();
  let targetLogPath = targetConvId
    ? path.join(brainDir, targetConvId, ".system_generated", "logs", "transcript.jsonl")
    : "";

  if (targetLogPath && !fs.existsSync(targetLogPath)) {
    targetLogPath = "";
  }

  // 仅当主窗口尚未从 CDP/日志解析出会话时，回退至 brain 下最新会话；多开独立窗口严禁盲抓全局最新会话防跨窗口串数
  if (!targetLogPath && !ctx.isIsolatedInstance) {
    let latestMtime = 0;
    try {
      if (fs.existsSync(brainDir)) {
        for (const d of fs.readdirSync(brainDir)) {
          const logP = path.join(brainDir, d, ".system_generated", "logs", "transcript.jsonl");
          try {
            if (fs.existsSync(logP)) {
              const st = fs.statSync(logP);
              if (st.mtimeMs > latestMtime) {
                latestMtime = st.mtimeMs;
                targetConvId = d;
                targetLogPath = logP;
              }
            }
          } catch {}
        }
      }
    } catch {}
  }

  if (targetConvId) {
    instMeta.lastActiveConvId = targetConvId;
  }

  let sessionInputTokens = 0;
  let sessionCacheTokens = 0;
  let sessionOutputTokens = 0;
  let lastInputTokens = 0;
  let lastCacheTokens = 0;
  let lastOutputTokens = 0;
  let turnCount = 0;
  let checkpointCount = 0;
  let checkpointTokens = 0;
  const modelMap = new Map();

  if (targetLogPath && fs.existsSync(targetLogPath)) {
    try {
      const rawText = fs.readFileSync(targetLogPath, "utf8");
      const lines = rawText.split(/\r?\n/).filter(Boolean);
      const rows = [];
      let initialBeforeChangeModel = "";

      for (const line of lines) {
        try {
          const r = JSON.parse(line);
          rows.push(r);
          if (!initialBeforeChangeModel && typeof r.content === "string" && r.content.includes("<USER_SETTINGS_CHANGE>")) {
            const parsed = parseSettingsChangeModels(r.content, knownDict);
            if (parsed && parsed.fromModel) {
              initialBeforeChangeModel = parsed.fromModel;
            }
          }
        } catch {}
      }

      let currentModel = initialBeforeChangeModel || logFallback.lastModel || "Gemini 4 Argon";
      let currentTurnEstIn = 0;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const stepType = String(row.type || "");
        const contentStr = typeof row.content === "string" ? row.content : JSON.stringify(row.content || "");
        const thinkingStr = typeof row.thinking === "string" ? row.thinking : "";
        const toolsStr = row.tool_calls ? JSON.stringify(row.tool_calls) : "";

        if (contentStr.includes("<USER_SETTINGS_CHANGE>")) {
          const parsed = parseSettingsChangeModels(contentStr, knownDict);
          if (parsed && parsed.toModel) {
            currentModel = parsed.toModel;
          }
        }

        if (stepType === "USER_INPUT") {
          currentTurnEstIn = estimateTokensFromString(contentStr);
        } else if (stepType === "PLANNER_RESPONSE" || stepType === "CHECKPOINT") {
          const hasOfficial =
            typeof row.input_tokens === "number" ||
            typeof row.output_tokens === "number" ||
            typeof row.cache_read_tokens === "number";
          const inTok = hasOfficial ? Number(row.input_tokens || 0) : currentTurnEstIn;
          const cacheTok = hasOfficial ? Number(row.cache_read_tokens || 0) : 0;
          const outTok = hasOfficial
            ? Number(row.output_tokens || 0)
            : (estimateTokensFromString(contentStr) + estimateTokensFromString(thinkingStr) + estimateTokensFromString(toolsStr));

          if (inTok > 0 || outTok > 0 || cacheTok > 0) {
            sessionInputTokens += inTok;
            sessionCacheTokens += cacheTok;
            sessionOutputTokens += outTok;

            if (stepType === "CHECKPOINT") {
              checkpointCount += 1;
              checkpointTokens += inTok + outTok;
            } else {
              lastInputTokens = inTok;
              lastCacheTokens = cacheTok;
              lastOutputTokens = outTok;
              turnCount++;
            }

            const modelKey = currentModel || "Gemini 4 Argon";
            if (!modelMap.has(modelKey)) {
              modelMap.set(modelKey, {
                modelName: modelKey,
                turns: 0,
                inputTokens: 0,
                cacheTokens: 0,
                outputTokens: 0,
                lastUsedIndex: i
              });
            }
            const mStat = modelMap.get(modelKey);
            if (stepType === "PLANNER_RESPONSE") {
              mStat.turns += 1;
            }
            mStat.inputTokens += inTok;
            mStat.cacheTokens += cacheTok;
            mStat.outputTokens += outTok;
            mStat.lastUsedIndex = i;
          }
        }
      }
    } catch {}
  }

  const lastContextTokens = (lastInputTokens || 0) + (lastCacheTokens || 0);
  const sessionTotalTokens = sessionInputTokens + sessionOutputTokens;
  const cacheHitPct = (sessionInputTokens + sessionCacheTokens) > 0
    ? Math.round((sessionCacheTokens / (sessionInputTokens + sessionCacheTokens)) * 100)
    : 0;

  const byModel = Array.from(modelMap.values())
    .map((m) => {
      const mTotal = m.inputTokens + m.outputTokens;
      const mCacheHitPct = (m.inputTokens + m.cacheTokens) > 0
        ? Math.round((m.cacheTokens / (m.inputTokens + m.cacheTokens)) * 100)
        : 0;
      return {
        modelName: m.modelName,
        turns: m.turns,
        inputTokens: m.inputTokens,
        cacheTokens: m.cacheTokens,
        outputTokens: m.outputTokens,
        totalTokens: mTotal,
        cacheHitPct: mCacheHitPct,
        lastUsedIndex: m.lastUsedIndex
      };
    })
    .sort((a, b) => b.lastUsedIndex - a.lastUsedIndex)
    .map(({ lastUsedIndex, ...rest }) => rest);

  return {
    conversationId: targetConvId ? targetConvId.slice(0, 8) : "",
    lastInputTokens: lastInputTokens || 0,
    lastCacheTokens: lastCacheTokens || 0,
    lastContextTokens,
    lastOutputTokens: lastOutputTokens || 0,
    sessionInputTokens,
    sessionCacheTokens,
    sessionOutputTokens,
    sessionTotalTokens,
    cacheHitPct,
    turnCount,
    checkpointCount,
    checkpointTokens,
    byModel,
    source: "official_transcript"
  };
}

export function resolveAntigravityExePath() {
  const candidates = [
    process.execPath && /antigravity\.exe$/i.test(process.execPath) ? process.execPath : "",
    path.join(HOME_DIR, "AppData", "Local", "Programs", "antigravity", "Antigravity.exe"),
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Programs", "antigravity", "Antigravity.exe"),
    path.join(os.homedir(), "AppData", "Local", "Programs", "antigravity", "Antigravity.exe"),
    "C:\\Program Files\\Antigravity\\Antigravity.exe"
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return "";
}

export async function launchIsolatedAntigravityInstance(accountId) {
  const rawId = String(accountId || "").trim();
  const cfg = readRelayConfig();
  normalizeAccountChannels(cfg);
  const target = cfg.accounts?.[rawId];
  if (!target) {
    throw new Error(`未找到通道快照: ${rawId}`);
  }

  const fieldStatus = inspectActiveFieldInstances(cfg);
  const targetIsGcp = Boolean(target.gcpProjectId || target.channelType === "gcp");
  if (fieldStatus.multiLaunchLocked) {
    throw new Error("个人通道与 GCP 通道独立窗口均已在场上运行，不能再开新实例；同通道账号请在对应窗口内启用或配置算力路由");
  }
  if (targetIsGcp && fieldStatus.otherGcpInstance) {
    throw new Error(`GCP 通道已在另一窗口 (${fieldStatus.otherGcpInstance.email}) 运行中，无需重复多开`);
  }
  if (!targetIsGcp && fieldStatus.otherPersonalInstance) {
    throw new Error(`个人通道已在另一窗口 (${fieldStatus.otherPersonalInstance.email}) 运行中，无需重复多开`);
  }

  const exePath = resolveAntigravityExePath();
  if (!exePath) {
    throw new Error("未找到本机 Antigravity.exe 可执行文件");
  }

  const originalMainCred = readWinCredToken(true) || readWinCredToken(false);

  const targetProject = (target.gcpProjectId || "").trim();
  const targetBillingMode = targetProject ? (target.gcpBillingMode || "agent_platform") : "";
  const targetLocation = targetProject
    ? (targetBillingMode === "agent_platform" ? (target.gcpLocation || "global") : "")
    : "";

  const baseToken = target.storedToken || findStoredTokenForEmail(cfg, target.email, Boolean(targetProject));
  if (!baseToken) {
    throw new Error(`未找到账号 ${target.email} 的凭据快照`);
  }

  if (baseToken.token?.refresh_token) {
    try {
      const rt = baseToken.token.refresh_token;
      const refreshed = await refreshOAuthAccessToken(rt);
      if (refreshed && refreshed.access_token) {
        const newExpiry = new Date(Date.now() + (refreshed.expires_in || 3599) * 1000).toISOString();
        baseToken.token.access_token = refreshed.access_token;
        baseToken.token.refreshedForRt = rt;
        baseToken.token.expiry = newExpiry;
        for (const item of Object.values(cfg.accounts || {})) {
          if (item.storedToken?.token?.refresh_token === rt) {
            item.storedToken.token.access_token = refreshed.access_token;
            item.storedToken.token.refreshedForRt = rt;
            item.storedToken.token.expiry = newExpiry;
          }
        }
      }
    } catch {}
  }

  // 关键防串扰机制：保留主实例原本的 writer_id（forceNewWriterId = false），使主实例的 language_server.exe (1s 轮询 writer_id) 完全无感、不触发切换，而新拉起的实例进程在冷启动时直接读取该目标通道凭据
  const tokenToWrite = buildCleanChannelToken(baseToken, targetProject, targetLocation, false);
  if (originalMainCred?.writer_id) {
    tokenToWrite.writer_id = originalMainCred.writer_id;
  }
  target.storedToken = tokenToWrite;
  writeWinCredToken(tokenToWrite);
  writeRelayConfig(cfg);

  const safeFolder = rawId.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const instanceUserDataDir = path.join(HOME_DIR, ".gemini", "antigravity-instances", safeFolder);
  const instanceUserDir = path.join(instanceUserDataDir, "User");
  const instanceGlobalStorageDir = path.join(instanceUserDir, "globalStorage");
  const instanceLogsDir = path.join(instanceUserDataDir, "logs");

  try {
    fs.mkdirSync(instanceGlobalStorageDir, { recursive: true });
    fs.mkdirSync(instanceLogsDir, { recursive: true });
    const mainAppDataDir = path.join(
      process.env.APPDATA || path.join(HOME_DIR, "AppData", "Roaming"),
      "Antigravity"
    );
    const mainSettings = path.join(mainAppDataDir, "User", "settings.json");
    const destSettings = path.join(instanceUserDir, "settings.json");
    if (fs.existsSync(mainSettings) && !fs.existsSync(destSettings)) {
      fs.copyFileSync(mainSettings, destSettings);
    }
    // 同步主实例的 app_storage.json 与 window_state.json，跳过首次引导向导 ([IDE Wizard] Already shown, skipping) 并直达 Hub 主界面，同时剥离主实例旧 Sidecar 端口缓存防止多开窗口面板串流
    for (const rootFile of ["app_storage.json", "window_state.json"]) {
      const srcPath = path.join(mainAppDataDir, rootFile);
      const dstPath = path.join(instanceUserDataDir, rootFile);
      if (fs.existsSync(srcPath) && !fs.existsSync(dstPath)) {
        fs.copyFileSync(srcPath, dstPath);
      }
    }
    const isoAppStoragePath = path.join(instanceUserDataDir, "app_storage.json");
    if (fs.existsSync(isoAppStoragePath)) {
      try {
        const storageObj = JSON.parse(fs.readFileSync(isoAppStoragePath, "utf8"));
        if (storageObj && typeof storageObj === "object") {
          delete storageObj["aux-pane-v2-session"];
          delete storageObj["aux-pane-session"];
          fs.writeFileSync(isoAppStoragePath, JSON.stringify(storageObj, null, 2), "utf8");
        }
      } catch {}
    }
  } catch {}

  const launchedAt = Date.now();
  writeInstanceDescriptor(instanceUserDataDir, {
    instanceId: safeFolder,
    activeChannelId: target.id,
    email: target.email,
    gcpProjectId: targetProject,
    userDataDir: instanceUserDataDir,
    launchedAt
  });
  const isoMeta = getInstanceMeta(cfg, {
    instanceId: safeFolder,
    isIsolatedInstance: true,
    userDataDir: instanceUserDataDir
  });
  isoMeta.activeChannelId = target.id;
  isoMeta.activeEmail = target.email;
  isoMeta.lastAppliedGcpProject = targetProject;
  isoMeta.seededLaunchAt = launchedAt;
  isoMeta.switchedAt = launchedAt;
  writeRelayConfig(cfg);

  const instanceLsLogPath = path.join(instanceLogsDir, "language_server.log");
  let prevLsLogSize = 0;
  try {
    if (fs.existsSync(instanceLsLogPath)) {
      prevLsLogSize = fs.statSync(instanceLsLogPath).size;
    }
  } catch {}

  // 剔除 Sidecar 宿主私有环境变量（ELECTRON_RUN_AS_NODE=1、CHROME_CRASHPAD_PIPE_NAME 等），确保拉起完整 GUI 窗口，同时注入当前多开实例标识
  const cleanEnv = { ...process.env };
  for (const k of Object.keys(cleanEnv)) {
    if (
      k === "ELECTRON_RUN_AS_NODE" ||
      k === "ELECTRON_NO_ATTACH_CONSOLE" ||
      k === "NODE_OPTIONS" ||
      k === "PORT" ||
      k === "ORIGINAL_XDG_CURRENT_DESKTOP" ||
      k.startsWith("CHROME_") ||
      k.startsWith("ELECTRON_") ||
      k.startsWith("ANTIGRAVITY_") ||
      k.startsWith("VSCODE_")
    ) {
      delete cleanEnv[k];
    }
  }
  cleanEnv.AGY_RELAY_INSTANCE_ID = safeFolder;
  cleanEnv.AGY_RELAY_INSTANCE_USER_DATA_DIR = instanceUserDataDir;
  cleanEnv.PLUGIN_SWITCHER_DISABLE_8088 = "1";

  // Chromium 底层仅识别等号连接的 --user-data-dir=<path> 参数以在 app.requestSingleInstanceLock() 前切换数据目录锁
  const userDataArg = `--user-data-dir=${instanceUserDataDir}`;
  let launchedPid = 0;
  try {
    const psExe = exePath.replace(/'/g, "''");
    const psDir = path.dirname(exePath).replace(/'/g, "''");
    const psDataArg = userDataArg.replace(/'/g, "''");
    const psCmd = `$p = Start-Process -FilePath '${psExe}' -WorkingDirectory '${psDir}' -ArgumentList @('${psDataArg}') -WindowStyle Normal -PassThru; if ($p) { Write-Output $p.Id }`;
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", psCmd],
      {
        env: cleanEnv,
        encoding: "utf8",
        timeout: 8000,
        windowsHide: true
      }
    );
    launchedPid = Number(String(out || "").trim()) || 0;
  } catch {
    const child = spawn(exePath, [userDataArg], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      cwd: path.dirname(exePath),
      env: cleanEnv
    });
    child.unref();
    launchedPid = child.pid || 0;
  }

  // 轮询新实例 logs/language_server.log 确认 Auth succeeded（或最长 9 秒超时）后，无感还原主实例原本的 WinCred 凭据（保持相同 writer_id，新旧实例双端零互扰）
  if (originalMainCred) {
    const startWait = Date.now();
    const restoreOriginalCred = () => {
      try {
        writeWinCredToken(originalMainCred);
      } catch {}
    };
    const pollTimer = setInterval(() => {
      const elapsed = Date.now() - startWait;
      let authReady = false;
      try {
        if (fs.existsSync(instanceLsLogPath)) {
          const st = fs.statSync(instanceLsLogPath);
          if (st.size > prevLsLogSize) {
            const fd = fs.openSync(instanceLsLogPath, "r");
            try {
              const len = st.size - prevLsLogSize;
              const buf = Buffer.alloc(len);
              fs.readSync(fd, buf, 0, len, prevLsLogSize);
              const tailText = buf.toString("utf8");
              if (/Auth succeeded|Starting language server process with pid/i.test(tailText) && elapsed >= 3200) {
                authReady = true;
              }
            } finally {
              fs.closeSync(fd);
            }
          }
        }
      } catch {}
      if (authReady || elapsed >= 9000) {
        clearInterval(pollTimer);
        restoreOriginalCred();
      }
    }, 500);
    if (typeof pollTimer.unref === "function") pollTimer.unref();
  }

  return {
    launched: true,
    pid: launchedPid,
    channelId: target.id,
    email: target.email,
    gcpProjectId: targetProject,
    userDataDir: instanceUserDataDir
  };
}

let activeOAuthSession = null;

export function hasActiveOAuthSession() {
  return Boolean(activeOAuthSession);
}

function exchangeOAuthCodeForTokens({ code, redirectUri, codeVerifier, clientId, clientSecret }) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      client_id: clientId || AGY_OAUTH_CLIENT_ID,
      client_secret: clientSecret || AGY_OAUTH_CLIENT_SECRET,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri
    });
    const body = Buffer.from(params.toString(), "utf8");
    const req = https.request(
      {
        hostname: "oauth2.googleapis.com",
        port: 443,
        path: "/token",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": body.length
        }
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) {
            return reject(new Error(`OAuth token exchange HTTP ${res.statusCode}: ${text}`));
          }
          resolve(JSON.parse(text));
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function decodeJwtEmail(idToken) {
  if (!idToken || typeof idToken !== "string") return "";
  const parts = idToken.split(".");
  if (parts.length < 2) return "";
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload.email || "";
  } catch {
    return "";
  }
}

export function cancelIsolatedOAuthFlow() {
  if (activeOAuthSession) {
    try { clearTimeout(activeOAuthSession.timer); } catch {}
    try { activeOAuthSession.server.close(); } catch {}
    activeOAuthSession = null;
    return true;
  }
  return false;
}

export function startIsolatedOAuthFlow(optionsOrCallback = {}, maybeCallback = null) {
  cancelIsolatedOAuthFlow();

  const opts = typeof optionsOrCallback === "function" ? {} : (optionsOrCallback || {});
  const onCompleteCallback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
  const targetChannelType = opts.channelType === "gcp" ? "gcp" : "personal";
  const targetGcpProjectId = String(opts.gcpProjectId || "").trim();
  const targetGcpBillingMode = opts.gcpBillingMode === "gemini_enterprise" ? "gemini_enterprise" : "agent_platform";
  const targetGcpLocation = ["global", "us", "eu"].includes(opts.gcpLocation) ? opts.gcpLocation : "global";
  const loginHint = String(opts.loginHint || opts.email || "").trim();
  const oauthClient = getOAuthClientForChannel(targetChannelType);

  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("hex");

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url, `http://${req.headers.host}`);
        if (reqUrl.pathname !== "/auth/callback") {
          res.writeHead(404);
          res.end("Not Found");
          return;
        }

        const errParam = reqUrl.searchParams.get("error");
        const code = reqUrl.searchParams.get("code");
        const returnedState = reqUrl.searchParams.get("state");

        if (errParam || !code || returnedState !== state) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<h3>已取消登录，当前 Antigravity 会话未受任何影响，可关闭此页面。</h3>");
          cancelIsolatedOAuthFlow();
          if (onCompleteCallback) onCompleteCallback({ canceled: true });
          return;
        }

        res.writeHead(302, { Location: AGY_AUTH_SUCCESS_URL });
        res.end();

        const port = server.address()?.port;
        const redirectUri = `http://localhost:${port}/auth/callback`;
        cancelIsolatedOAuthFlow();

        const tokenResp = await exchangeOAuthCodeForTokens({
          code,
          redirectUri,
          codeVerifier,
          clientId: oauthClient.clientId,
          clientSecret: oauthClient.clientSecret
        });
        const email = decodeJwtEmail(tokenResp.id_token) || `account_${Date.now()}`;
        const expiryDate = new Date(Date.now() + (tokenResp.expires_in || 3599) * 1000).toISOString();

        const storedToken = buildCleanChannelToken({
          token: {
            access_token: tokenResp.access_token,
            token_type: tokenResp.token_type || "Bearer",
            refresh_token: tokenResp.refresh_token,
            expiry: expiryDate,
            expires_in: tokenResp.expires_in || 3599
          },
          id_token: tokenResp.id_token || "",
          id_token_email: email
        }, "", "");

        const cfg = readRelayConfig();
        normalizeAccountChannels(cfg);
        if (!cfg.__meta__.oauthTokensByEmail || typeof cfg.__meta__.oauthTokensByEmail !== "object") {
          cfg.__meta__.oauthTokensByEmail = {};
        }
        cfg.__meta__.oauthTokensByEmail[email] = storedToken;
        if (targetChannelType === "gcp") {
          if (!cfg.__meta__.gcpOAuthTokensByEmail || typeof cfg.__meta__.gcpOAuthTokensByEmail !== "object") {
            cfg.__meta__.gcpOAuthTokensByEmail = {};
          }
          cfg.__meta__.gcpOAuthTokensByEmail[email] = storedToken;
        }

        for (const existingAcc of Object.values(cfg.accounts || {})) {
          if (existingAcc.email === email) {
            const existingIsGcp = Boolean(existingAcc.gcpProjectId || existingAcc.channelType === "gcp");
            if (targetChannelType === "personal" && existingIsGcp && existingAcc.storedToken?.token?.refresh_token) {
              continue;
            }
            if (targetChannelType === "gcp" && !existingIsGcp && existingAcc.storedToken?.token?.refresh_token) {
              continue;
            }
            existingAcc.storedToken = existingAcc.gcpProjectId
              ? {
                  ...storedToken,
                  auth_method: "gcp",
                  project_id: existingAcc.gcpProjectId,
                  region: existingAcc.gcpBillingMode === "agent_platform" ? (existingAcc.gcpLocation || "global") : ""
                }
              : storedToken;
          }
        }

        if (targetChannelType === "gcp") {
          if (targetGcpProjectId) {
            const gcpKey = `${email}#gcp:${targetGcpProjectId}`;
            if (Array.isArray(cfg.__meta__.deletedChannelIds)) {
              cfg.__meta__.deletedChannelIds = cfg.__meta__.deletedChannelIds.filter((id) => id !== gcpKey);
            }
            const tierName = targetGcpBillingMode === "gemini_enterprise" ? "Gemini Enterprise" : "Agent Platform";
            if (!cfg.gcpProjects.includes(targetGcpProjectId)) {
              cfg.gcpProjects.push(targetGcpProjectId);
            }
            cfg.accounts[gcpKey] = {
              id: gcpKey,
              alias: `${email} (${targetGcpProjectId})`,
              email,
              channelType: "gcp",
              tierName,
              gcpProjectId: targetGcpProjectId,
              gcpBillingMode: targetGcpBillingMode,
              gcpLocation: targetGcpLocation,
              projectName: targetGcpProjectId,
              savedAt: new Date().toISOString(),
              storedToken: {
                ...storedToken,
                auth_method: "gcp",
                project_id: targetGcpProjectId,
                region: targetGcpBillingMode === "agent_platform" ? targetGcpLocation : ""
              },
              cachedQuota: targetGcpBillingMode === "agent_platform"
                ? {
                    isGcpUnlimited: true,
                    quotaGroups: [],
                    availableModels: AGENT_PLATFORM_DEFAULT_MODELS.map((m) => ({ ...m, variantIds: [...m.variantIds] })),
                    updatedAt: Date.now()
                  }
                : { isGcpUnlimited: true, quotaGroups: [], availableModels: [], updatedAt: Date.now() }
            };
            writeRelayConfig(cfg);
            if (onCompleteCallback) {
              onCompleteCallback({
                success: true,
                email,
                channelType: "gcp",
                gcpProjectId: targetGcpProjectId,
                autoScanGcp: false
              });
            }
          } else {
            writeRelayConfig(cfg);
            if (onCompleteCallback) {
              onCompleteCallback({
                success: true,
                email,
                channelType: "gcp",
                autoScanGcp: true
              });
            }
          }
          return;
        }

        const personalKey = `${email}#personal`;
        if (Array.isArray(cfg.__meta__.deletedChannelIds)) {
          cfg.__meta__.deletedChannelIds = cfg.__meta__.deletedChannelIds.filter((id) => id !== personalKey);
        }
        cfg.accounts[personalKey] = {
          id: personalKey,
          alias: email,
          email,
          channelType: "personal",
          tierName: cfg.accounts[personalKey]?.tierName || "Google AI Pro",
          gcpProjectId: "",
          savedAt: new Date().toISOString(),
          storedToken
        };
        writeRelayConfig(cfg);

        try {
          await probeChannelQuotaSnapshot(personalKey);
        } catch {}

        if (onCompleteCallback) onCompleteCallback({ success: true, email, channelType: "personal" });
      } catch (err) {
        cancelIsolatedOAuthFlow();
        if (onCompleteCallback) onCompleteCallback({ error: err.message });
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const redirectUri = `http://localhost:${port}/auth/callback`;
      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.searchParams.set("client_id", oauthClient.clientId || AGY_OAUTH_CLIENT_ID);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", AGY_OAUTH_SCOPES.join(" "));
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("prompt", "consent");
      if (loginHint) {
        authUrl.searchParams.set("login_hint", loginHint);
      }
      authUrl.searchParams.set("code_challenge", codeChallenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("state", state);

      const timer = setTimeout(() => {
        cancelIsolatedOAuthFlow();
        if (onCompleteCallback) onCompleteCallback({ canceled: true, timeout: true });
      }, 180000);

      activeOAuthSession = { server, timer, authUrl: authUrl.toString() };

      try {
        spawn("rundll32.exe", ["url.dll,FileProtocolHandler", authUrl.toString()], {
          detached: true,
          stdio: "ignore",
          windowsHide: true
        }).unref();
      } catch {}

      resolve({ authUrl: authUrl.toString(), redirectUri });
    });

    server.on("error", (err) => {
      cancelIsolatedOAuthFlow();
      reject(err);
    });
  });
}
