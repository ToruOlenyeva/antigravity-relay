import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveHostHomeDir() {
  const realEnv = String(process.env.AGY_REAL_USERPROFILE || "").trim();
  if (realEnv && fs.existsSync(realEnv)) return path.normalize(realEnv);
  const normalized = __dirname.replace(/\\/g, "/");
  const geminiIdx = normalized.toLowerCase().indexOf("/.gemini/");
  if (geminiIdx > 0) {
    const candidate = path.normalize(__dirname.slice(0, geminiIdx));
    if (fs.existsSync(candidate)) return candidate;
  }
  return os.homedir();
}

export const HOME_DIR = resolveHostHomeDir();
export const APP_DATA_DIR = (process.platform === "win32" && fs.existsSync(path.join(HOME_DIR, "AppData", "Roaming")))
  ? path.join(HOME_DIR, "AppData", "Roaming")
  : (process.env.APPDATA || path.join(HOME_DIR, ".config"));

export const PLUGINS_DIR = path.join(HOME_DIR, ".gemini", "config", "plugins");
export const RELAY_DATA_DIR = path.join(PLUGINS_DIR, "antigravity-relay", "data");
export const RELAY_CONFIG_FILE = path.join(RELAY_DATA_DIR, "agy-relay-config.json");
export const OLD_RELAY_CONFIG_FILE = path.join(HOME_DIR, ".gemini", "config", "agy-relay-config.json");
export const RELAY_CONFIG_BAK = `${RELAY_CONFIG_FILE}.bak`;
export const LEGACY_PROFILES_FILE = path.join(HOME_DIR, ".antigravity_profiles", "agy2_profiles.json");
export const WORKSPACE_PROFILES_FILE = process.env.AGY_WORKSPACE_PROFILES_FILE || path.join(RELAY_DATA_DIR, "profiles.json");
export const JETSKI_TOKEN_FILE = path.join(HOME_DIR, ".gemini", "jetski-standalone-oauth-token");
export const APP_STORAGE_FILE = path.join(APP_DATA_DIR, "Antigravity", "app_storage.json");
export const LS_LOG_FILE = path.join(APP_DATA_DIR, "Antigravity", "logs", "language_server.log");
export const INSTANCES_ROOT_DIR = path.join(HOME_DIR, ".gemini", "antigravity-instances");
export const PRELOAD_SDK_PATH = path.join(HOME_DIR, ".gemini", "antigravity", "lib", "node_modules", "sidecar_sdk", "preload.js");

let cachedInstanceCtx = null;
let cachedInstanceCtxConfirmed = false;
let cachedInstanceCtxAt = 0;

function extractActiveSegmentFromLsLog(logFilePath) {
  try {
    if (!logFilePath || !fs.existsSync(logFilePath)) return { pid: 0, segment: "" };
    const logText = fs.readFileSync(logFilePath, "utf8");
    const pidMatches = [...logText.matchAll(/Starting language server process with pid (\d+)/gi)];
    if (pidMatches.length > 0) {
      const last = pidMatches[pidMatches.length - 1];
      const pid = Number(last[1] || 0);
      const segment = typeof last.index === "number" ? logText.slice(last.index) : logText;
      return { pid, segment };
    }
    return { pid: 0, segment: logText };
  } catch {
    return { pid: 0, segment: "" };
  }
}

export function getInstanceTokenFilePath(userDataDir) {
  if (!userDataDir) return "";
  return path.join(userDataDir, "home", ".gemini", "jetski-standalone-oauth-token");
}

export function ensureInstanceIsolatedHome(userDataDir) {
  if (!userDataDir) return "";
  const isoHome = path.join(userDataDir, "home");
  const isoGemini = path.join(isoHome, ".gemini");
  const isoCache = path.join(isoGemini, "cache");
  try {
    fs.mkdirSync(isoCache, { recursive: true });
    const markerFile = path.join(isoCache, "antigravity-keyring-unavailable");
    fs.writeFileSync(markerFile, "1", "utf8");
    const futureDate = new Date("2099-01-01T00:00:00.000Z");
    try {
      fs.utimesSync(markerFile, futureDate, futureDate);
    } catch {}
  } catch {}

  const realGemini = path.join(HOME_DIR, ".gemini");
  try {
    if (fs.existsSync(realGemini)) {
      for (const entry of fs.readdirSync(realGemini, { withFileTypes: true })) {
        if (entry.name === "cache" || entry.name === "jetski-standalone-oauth-token") continue;
        const src = path.join(realGemini, entry.name);
        const dst = path.join(isoGemini, entry.name);
        if (fs.existsSync(dst)) continue;
        try {
          if (entry.isDirectory()) {
            fs.symlinkSync(src, dst, "junction");
          } else if (entry.isFile() && entry.name === "settings.json") {
            fs.copyFileSync(src, dst);
          }
        } catch {}
      }
    }
  } catch {}

  try {
    if (fs.existsSync(HOME_DIR)) {
      for (const entry of fs.readdirSync(HOME_DIR, { withFileTypes: true })) {
        if (entry.name.toLowerCase() === ".gemini") continue;
        const src = path.join(HOME_DIR, entry.name);
        const dst = path.join(isoHome, entry.name);
        if (fs.existsSync(dst)) continue;
        try {
          if (entry.isDirectory()) {
            fs.symlinkSync(src, dst, "junction");
          } else if (entry.isFile() && entry.name.startsWith(".")) {
            fs.copyFileSync(src, dst);
          }
        } catch {}
      }
    }
  } catch {}

  return isoHome;
}

export function readInstanceDescriptor(userDataDir) {
  try {
    if (!userDataDir) return null;
    const descPath = path.join(userDataDir, "agy-instance.json");
    if (fs.existsSync(descPath)) {
      return JSON.parse(fs.readFileSync(descPath, "utf8"));
    }
  } catch {}
  return null;
}

export function writeInstanceDescriptor(userDataDir, data) {
  try {
    if (!userDataDir) return false;
    fs.mkdirSync(userDataDir, { recursive: true });
    const descPath = path.join(userDataDir, "agy-instance.json");
    fs.writeFileSync(descPath, JSON.stringify(data || {}, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

export function resolveCurrentInstanceContext(force = false) {
  if (cachedInstanceCtx && cachedInstanceCtxConfirmed) {
    if (cachedInstanceCtx.isIsolatedInstance && cachedInstanceCtx.userDataDir) {
      cachedInstanceCtx.descriptor = readInstanceDescriptor(cachedInstanceCtx.userDataDir);
    }
    return cachedInstanceCtx;
  }
  if (!force && cachedInstanceCtx && Date.now() - cachedInstanceCtxAt < 1500) {
    return cachedInstanceCtx;
  }

  const sidecarPort = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.PORT || 0);
  const ppid = Number(process.ppid || 0);
  const mainUserDataDir = path.join(APP_DATA_DIR, "Antigravity");

  const envInstanceDir = String(process.env.AGY_RELAY_INSTANCE_USER_DATA_DIR || "").trim();
  const envInstanceId = String(process.env.AGY_RELAY_INSTANCE_ID || "").trim();
  if (envInstanceDir && fs.existsSync(envInstanceDir)) {
    const id = envInstanceId || path.basename(envInstanceDir);
    cachedInstanceCtx = {
      instanceId: id,
      isIsolatedInstance: id !== "main",
      userDataDir: envInstanceDir,
      lsLogFile: path.join(envInstanceDir, "logs", "language_server.log"),
      appStorageFile: path.join(envInstanceDir, "app_storage.json"),
      descriptor: readInstanceDescriptor(envInstanceDir)
    };
    cachedInstanceCtxConfirmed = true;
    cachedInstanceCtxAt = Date.now();
    return cachedInstanceCtx;
  }

  const candidates = [];
  try {
    if (fs.existsSync(INSTANCES_ROOT_DIR)) {
      const dirs = fs.readdirSync(INSTANCES_ROOT_DIR);
      for (const dirName of dirs) {
        const fullDir = path.join(INSTANCES_ROOT_DIR, dirName);
        const logFile = path.join(fullDir, "logs", "language_server.log");
        if (fs.existsSync(logFile)) {
          candidates.push({
            instanceId: dirName,
            isIsolatedInstance: true,
            userDataDir: fullDir,
            lsLogFile: logFile,
            appStorageFile: path.join(fullDir, "app_storage.json")
          });
        }
      }
    }
  } catch {}

  candidates.push({
    instanceId: "main",
    isIsolatedInstance: false,
    userDataDir: mainUserDataDir,
    lsLogFile: LS_LOG_FILE,
    appStorageFile: APP_STORAGE_FILE
  });

  const relayPortPattern = sidecarPort > 0 && sidecarPort !== 8089
    ? new RegExp(`Sidecar\\s+antigravity-relay/panel\\s+gateway[^\\r\\n]*proxying to loopback port\\s+${sidecarPort}\\b`, "i")
    : null;
  const fallbackPortPattern = sidecarPort > 0 && sidecarPort !== 8089
    ? new RegExp(`proxying to loopback port\\s+${sidecarPort}\\b`, "i")
    : null;

  // 第一优先级：精确匹配当前窗口独享的 Sidecar loopback 端口或父进程 PID
  for (const cand of candidates) {
    const { pid, segment } = extractActiveSegmentFromLsLog(cand.lsLogFile);
    const matchedPort = Boolean(
      segment &&
      ((relayPortPattern && relayPortPattern.test(segment)) || (fallbackPortPattern && fallbackPortPattern.test(segment)))
    );
    const matchedPpid = Boolean(ppid > 0 && pid > 0 && pid === ppid);
    if (matchedPort || matchedPpid) {
      cachedInstanceCtx = {
        ...cand,
        lsPidHint: pid,
        descriptor: cand.isIsolatedInstance ? readInstanceDescriptor(cand.userDataDir) : null
      };
      cachedInstanceCtxConfirmed = true;
      cachedInstanceCtxAt = Date.now();
      return cachedInstanceCtx;
    }
  }

  // 第二优先级（仅在启动前几百毫秒日志尚未刷入端口时临时兜底，不置 confirmed）：检查环境变量或 PATH
  if (envInstanceDir && fs.existsSync(envInstanceDir)) {
    const id = envInstanceId || path.basename(envInstanceDir);
    cachedInstanceCtx = {
      instanceId: id,
      isIsolatedInstance: id !== "main",
      userDataDir: envInstanceDir,
      lsLogFile: path.join(envInstanceDir, "logs", "language_server.log"),
      appStorageFile: path.join(envInstanceDir, "app_storage.json"),
      descriptor: readInstanceDescriptor(envInstanceDir)
    };
    cachedInstanceCtxConfirmed = false;
    cachedInstanceCtxAt = Date.now();
    return cachedInstanceCtx;
  }

  const pathEnv = String(process.env.PATH || process.env.Path || "");
  const pathInstMatches = [...pathEnv.matchAll(/antigravity-instances[\\/]([^\\/;]+)[\\/]bin/gi)];
  if (pathInstMatches.length > 0) {
    const matchedId = pathInstMatches[0][1].trim();
    const matchedDir = path.join(INSTANCES_ROOT_DIR, matchedId);
    if (fs.existsSync(matchedDir)) {
      const logFile = path.join(matchedDir, "logs", "language_server.log");
      const { pid } = extractActiveSegmentFromLsLog(logFile);
      cachedInstanceCtx = {
        instanceId: matchedId,
        isIsolatedInstance: true,
        userDataDir: matchedDir,
        lsLogFile: logFile,
        appStorageFile: path.join(matchedDir, "app_storage.json"),
        lsPidHint: pid,
        descriptor: readInstanceDescriptor(matchedDir)
      };
      cachedInstanceCtxConfirmed = false;
      cachedInstanceCtxAt = Date.now();
      return cachedInstanceCtx;
    }
  }

  // 若 Sidecar 刚拉起 0~500ms 时尚未将 proxying to loopback port 刷入日志，检查主实例是否已绑定其他 relay 端口
  if (sidecarPort > 0 && sidecarPort !== 8089) {
    const mainSeg = extractActiveSegmentFromLsLog(LS_LOG_FILE);
    const mainRelayMatches = [...(mainSeg.segment || "").matchAll(/Sidecar\s+antigravity-relay\/panel\s+gateway[^\r\n]*proxying to loopback port\s+(\d+)/gi)];
    const mainRelayPort = mainRelayMatches.length > 0 ? Number(mainRelayMatches[mainRelayMatches.length - 1][1]) : 0;
    if (mainRelayPort > 0 && mainRelayPort !== sidecarPort) {
      let newestIso = null;
      let newestMtime = 0;
      for (const cand of candidates) {
        if (!cand.isIsolatedInstance) continue;
        try {
          const st = fs.statSync(cand.lsLogFile);
          if (st.mtimeMs > newestMtime) {
            newestMtime = st.mtimeMs;
            newestIso = cand;
          }
        } catch {}
      }
      if (newestIso && Date.now() - newestMtime < 120000) {
        const { pid } = extractActiveSegmentFromLsLog(newestIso.lsLogFile);
        cachedInstanceCtx = {
          ...newestIso,
          lsPidHint: pid,
          descriptor: readInstanceDescriptor(newestIso.userDataDir)
        };
        cachedInstanceCtxConfirmed = false;
        cachedInstanceCtxAt = Date.now();
        return cachedInstanceCtx;
      }
    }
  }

  const mainInfo = extractActiveSegmentFromLsLog(LS_LOG_FILE);
  cachedInstanceCtx = {
    instanceId: "main",
    isIsolatedInstance: false,
    userDataDir: mainUserDataDir,
    lsLogFile: LS_LOG_FILE,
    appStorageFile: APP_STORAGE_FILE,
    lsPidHint: mainInfo.pid || 0,
    descriptor: null
  };
  cachedInstanceCtxConfirmed = sidecarPort === 8089;
  cachedInstanceCtxAt = Date.now();
  return cachedInstanceCtx;
}

export function getActiveIsolatedSidecarPorts() {
  const ports = new Set();
  try {
    if (fs.existsSync(INSTANCES_ROOT_DIR)) {
      for (const dirName of fs.readdirSync(INSTANCES_ROOT_DIR)) {
        const logFile = path.join(INSTANCES_ROOT_DIR, dirName, "logs", "language_server.log");
        const { segment } = extractActiveSegmentFromLsLog(logFile);
        const matches = [...(segment || "").matchAll(/proxying to loopback port\s+(\d+)/gi)];
        for (const m of matches) {
          const p = Number(m[1] || 0);
          if (p > 1024) ports.add(p);
        }
      }
    }
  } catch {}
  return ports;
}

export function getInstanceMeta(cfg, instanceCtx = null) {
  if (!cfg.__meta__ || typeof cfg.__meta__ !== "object") cfg.__meta__ = {};
  if (!cfg.__meta__.instances || typeof cfg.__meta__.instances !== "object") {
    cfg.__meta__.instances = {};
  }
  const ctx = instanceCtx || resolveCurrentInstanceContext();
  const id = ctx.instanceId || "main";
  if (!cfg.__meta__.instances[id] || typeof cfg.__meta__.instances[id] !== "object") {
    if (id === "main") {
      cfg.__meta__.instances[id] = {
        instanceId: "main",
        activeChannelId: cfg.__meta__.activeChannelId || "",
        activeEmail: cfg.__meta__.activeEmail || "",
        lastAppliedGcpProject: cfg.__meta__.lastAppliedGcpProject || "",
        lsRpcTarget: cfg.__meta__.lsRpcTarget || null,
        cloudCodeProxyUrl: cfg.__meta__.cloudCodeProxyUrl || "",
        cloudCodeProxyPid: cfg.__meta__.cloudCodeProxyPid || 0,
        cloudCodeProxyMode: cfg.__meta__.cloudCodeProxyMode || ""
      };
    } else {
      const desc = ctx.descriptor || readInstanceDescriptor(ctx.userDataDir);
      let inferredEmail = desc?.email || "";
      let inferredPid = desc?.gcpProjectId || "";
      let inferredChannelId = desc?.activeChannelId || "";
      if (!inferredChannelId && id.endsWith("_personal")) {
        const candidateAcc = Object.values(cfg.accounts || {}).find(
          (a) => a.channelType === "personal" && a.id.replace(/[^a-zA-Z0-9._-]+/g, "_") === id
        );
        if (candidateAcc) {
          inferredChannelId = candidateAcc.id;
          inferredEmail = candidateAcc.email;
          inferredPid = "";
        }
      } else if (!inferredChannelId && id.includes("_gcp_")) {
        const candidateAcc = Object.values(cfg.accounts || {}).find(
          (a) => a.channelType === "gcp" && a.id.replace(/[^a-zA-Z0-9._-]+/g, "_") === id
        );
        if (candidateAcc) {
          inferredChannelId = candidateAcc.id;
          inferredEmail = candidateAcc.email;
          inferredPid = candidateAcc.gcpProjectId || "";
        }
      }
      cfg.__meta__.instances[id] = {
        instanceId: id,
        activeChannelId: inferredChannelId,
        activeEmail: inferredEmail,
        lastAppliedGcpProject: inferredPid,
        lsRpcTarget: null,
        cloudCodeProxyUrl: "",
        cloudCodeProxyPid: 0,
        cloudCodeProxyMode: ""
      };
    }
  } else if (id !== "main") {
    const desc = ctx.descriptor || readInstanceDescriptor(ctx.userDataDir);
    const descTs = Math.max(Number(desc?.switchedAt || 0), Number(desc?.launchedAt || 0));
    const metaTs = Math.max(
      Number(cfg.__meta__.instances[id].switchedAt || 0),
      Number(cfg.__meta__.instances[id].seededLaunchAt || 0)
    );
    if (desc && desc.activeChannelId && descTs >= metaTs) {
      cfg.__meta__.instances[id].activeChannelId = desc.activeChannelId;
      cfg.__meta__.instances[id].activeEmail = desc.email || cfg.__meta__.instances[id].activeEmail || "";
      cfg.__meta__.instances[id].lastAppliedGcpProject = desc.gcpProjectId ?? "";
      if (desc.launchedAt) cfg.__meta__.instances[id].seededLaunchAt = Number(desc.launchedAt);
      if (desc.switchedAt) cfg.__meta__.instances[id].switchedAt = Number(desc.switchedAt);
    }
  }
  return cfg.__meta__.instances[id];
}

let lastValidCache = null;

function createDefaultConfig() {
  return {
    accounts: {},
    gcpProjects: [],
    routing: {
      autoRelayOnLowQuota: true,
      lowQuotaThresholdPct: 5,
      personalQuotaPool: "prod",
      models: {},
      gcpModels: {}
    },
    __meta__: {
      lsRpcTarget: null,
      lastAppliedGcpProject: "",
      recentSidecarPorts: []
    }
  };
}

export function readRelayConfig() {
  for (let i = 0; i < 3; i++) {
    try {
      if (fs.existsSync(RELAY_CONFIG_FILE)) {
        const raw = fs.readFileSync(RELAY_CONFIG_FILE, "utf-8");
        if (raw && raw.trim()) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") {
            lastValidCache = raw;
            return ensureConfigDefaults(parsed);
          }
        }
      }
    } catch (e) {}
  }

  if (lastValidCache) {
    try {
      return ensureConfigDefaults(JSON.parse(lastValidCache));
    } catch (e) {}
  }

  if (fs.existsSync(RELAY_CONFIG_BAK)) {
    try {
      const bakRaw = fs.readFileSync(RELAY_CONFIG_BAK, "utf-8");
      const parsed = JSON.parse(bakRaw);
      if (parsed && typeof parsed === "object") {
        lastValidCache = bakRaw;
        return ensureConfigDefaults(parsed);
      }
    } catch (e) {}
  }

  const fresh = createDefaultConfig();
  migrateLegacyProfilesIfNeeded(fresh);
  return fresh;
}

function ensureConfigDefaults(cfg) {
  if (!cfg.accounts || typeof cfg.accounts !== "object") cfg.accounts = {};
  if (!Array.isArray(cfg.gcpProjects)) cfg.gcpProjects = [];
  if (!cfg.routing || typeof cfg.routing !== "object") cfg.routing = {};
  if (cfg.routing.autoRelayOnLowQuota === undefined) cfg.routing.autoRelayOnLowQuota = true;
  if (!cfg.routing.lowQuotaThresholdPct) cfg.routing.lowQuotaThresholdPct = 5;
  cfg.routing.personalQuotaPool = cfg.routing.personalQuotaPool === "daily" ? "daily" : "prod";
  if (!cfg.routing.models || typeof cfg.routing.models !== "object") cfg.routing.models = {};
  if (!cfg.routing.gcpModels || typeof cfg.routing.gcpModels !== "object") cfg.routing.gcpModels = {};
  delete cfg.routing.subagentDefaultTarget;
  if (!cfg.__meta__ || typeof cfg.__meta__ !== "object") cfg.__meta__ = {};
  if (!cfg.__meta__.instances || typeof cfg.__meta__.instances !== "object") cfg.__meta__.instances = {};
  if (!Array.isArray(cfg.__meta__.recentSidecarPorts)) cfg.__meta__.recentSidecarPorts = [];
  if (!Array.isArray(cfg.__meta__.deletedChannelIds)) cfg.__meta__.deletedChannelIds = [];
  if (!cfg.__meta__.legacyProfilesMigrated) {
    migrateLegacyProfilesIfNeeded(cfg);
  }
  return cfg;
}

function migrateLegacyProfilesIfNeeded(cfg) {
  try {
    let changed = false;
    const deletedSet = new Set(Array.isArray(cfg.__meta__?.deletedChannelIds) ? cfg.__meta__.deletedChannelIds : []);
    if (fs.existsSync(OLD_RELAY_CONFIG_FILE)) {
      try {
        const oldCfg = JSON.parse(fs.readFileSync(OLD_RELAY_CONFIG_FILE, "utf-8"));
        if (oldCfg?.accounts && typeof oldCfg.accounts === "object") {
          for (const [k, v] of Object.entries(oldCfg.accounts)) {
            if (!cfg.accounts[k] && !deletedSet.has(k)) {
              cfg.accounts[k] = v;
              changed = true;
            }
          }
        }
      } catch (e) {}
    }
    for (const legacyFile of [LEGACY_PROFILES_FILE, WORKSPACE_PROFILES_FILE]) {
      if (!fs.existsSync(legacyFile)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(legacyFile, "utf-8"));
        const list = Array.isArray(raw?.profiles) ? raw.profiles : Object.values(raw || {});
        for (const item of list) {
          const tok = item?.storedToken || item?.oauth_token;
          const email = (item?.email || tok?.id_token_email || "").trim();
          if (email && tok) {
            const key = `${email}#personal`;
            if (!cfg.accounts[key] && !deletedSet.has(key)) {
              cfg.accounts[key] = {
                id: key,
                alias: item.alias || item.name || email,
                email,
                channelType: "personal",
                tierName: item.tierName || "Google AI Pro",
                gcpProjectId: "",
                savedAt: item.savedAt || new Date().toISOString(),
                storedToken: typeof tok === "string"
                  ? { token: { refresh_token: tok }, id_token_email: email, project_id: "" }
                  : { ...tok, project_id: "" }
              };
              changed = true;
            }
          }
        }
      } catch (e) {}
    }
    if (!cfg.__meta__ || typeof cfg.__meta__ !== "object") cfg.__meta__ = {};
    cfg.__meta__.legacyProfilesMigrated = true;
    if (changed) {
      writeRelayConfig(cfg);
    }
  } catch (e) {}
}

export function writeRelayConfig(cfg) {
  try {
    const dir = path.dirname(RELAY_CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // 跨进程原子合并锁：防止主窗口与多开窗口后台并发快照互相冲掉对方最新切换的通道或刚刚探测出的配额快照
    try {
      if (fs.existsSync(RELAY_CONFIG_FILE)) {
        const diskRaw = fs.readFileSync(RELAY_CONFIG_FILE, "utf-8");
        if (diskRaw && diskRaw.trim()) {
          const diskCfg = JSON.parse(diskRaw);
          if (diskCfg && typeof diskCfg === "object") {
            const ctx = resolveCurrentInstanceContext();
            const curInstId = ctx?.instanceId || "main";
            if (!cfg.__meta__ || typeof cfg.__meta__ !== "object") cfg.__meta__ = {};
            if (!cfg.__meta__.instances || typeof cfg.__meta__.instances !== "object") cfg.__meta__.instances = {};

            const diskInstances = diskCfg.__meta__?.instances || {};
            for (const [instKey, diskInst] of Object.entries(diskInstances)) {
              if (!diskInst || typeof diskInst !== "object") continue;
              const memInst = cfg.__meta__.instances[instKey];
              const diskSwitchedAt = Number(diskInst.switchedAt || diskInst.seededLaunchAt || 0);
              const memSwitchedAt = Number(memInst?.switchedAt || memInst?.seededLaunchAt || 0);
              if (!memInst || diskSwitchedAt > memSwitchedAt || (instKey !== curInstId && memSwitchedAt <= diskSwitchedAt)) {
                cfg.__meta__.instances[instKey] = {
                  ...(memInst || {}),
                  ...diskInst
                };
              }
            }

            // 多开独立窗口绝不覆盖顶层归属主窗口的 activeChannelId / activeEmail / lastAppliedGcpProject
            if (ctx?.isIsolatedInstance && diskCfg.__meta__) {
              if (diskCfg.__meta__.activeChannelId !== undefined) {
                cfg.__meta__.activeChannelId = diskCfg.__meta__.activeChannelId;
              }
              if (diskCfg.__meta__.activeEmail !== undefined) {
                cfg.__meta__.activeEmail = diskCfg.__meta__.activeEmail;
              }
              if (diskCfg.__meta__.lastAppliedGcpProject !== undefined) {
                cfg.__meta__.lastAppliedGcpProject = diskCfg.__meta__.lastAppliedGcpProject;
              }
            } else if (!ctx?.isIsolatedInstance && cfg.__meta__.instances.main) {
              cfg.__meta__.activeChannelId = cfg.__meta__.instances.main.activeChannelId || cfg.__meta__.activeChannelId || "";
              cfg.__meta__.activeEmail = cfg.__meta__.instances.main.activeEmail || cfg.__meta__.activeEmail || "";
              cfg.__meta__.lastAppliedGcpProject = cfg.__meta__.instances.main.lastAppliedGcpProject ?? cfg.__meta__.lastAppliedGcpProject ?? "";
            }

            // 保护各通道刚探测出的非空配额缓存不被慢速并发快照回退为空数组
            if (diskCfg.accounts && typeof diskCfg.accounts === "object" && cfg.accounts && typeof cfg.accounts === "object") {
              for (const [accId, diskAcc] of Object.entries(diskCfg.accounts)) {
                const memAcc = cfg.accounts[accId];
                if (!memAcc || !diskAcc) continue;
                const diskUpdated = Number(diskAcc.cachedQuota?.updatedAt || 0);
                const memUpdated = Number(memAcc.cachedQuota?.updatedAt || 0);
                const diskHasGroups = Array.isArray(diskAcc.cachedQuota?.quotaGroups) && diskAcc.cachedQuota.quotaGroups.length > 0;
                const memHasGroups = Array.isArray(memAcc.cachedQuota?.quotaGroups) && memAcc.cachedQuota.quotaGroups.length > 0;
                if ((diskUpdated > memUpdated && (diskHasGroups || !memHasGroups)) || (diskHasGroups && !memHasGroups)) {
                  memAcc.cachedQuota = diskAcc.cachedQuota;
                  if (diskAcc.tierCode) memAcc.tierCode = diskAcc.tierCode;
                  if (diskAcc.tierName) memAcc.tierName = diskAcc.tierName;
                }
                if (diskAcc.companionProjectId && !memAcc.companionProjectId) {
                  memAcc.companionProjectId = diskAcc.companionProjectId;
                }
                if (diskAcc.cachedQuotaByPool && typeof diskAcc.cachedQuotaByPool === "object") {
                  if (!memAcc.cachedQuotaByPool || typeof memAcc.cachedQuotaByPool !== "object") {
                    memAcc.cachedQuotaByPool = {};
                  }
                  for (const poolKey of ["prod", "daily"]) {
                    const dPool = diskAcc.cachedQuotaByPool[poolKey];
                    const mPool = memAcc.cachedQuotaByPool[poolKey];
                    if (!dPool || typeof dPool !== "object") continue;
                    const dUpd = Number(dPool.updatedAt || 0);
                    const mUpd = Number(mPool?.updatedAt || 0);
                    const dGroups = Array.isArray(dPool.quotaGroups) && dPool.quotaGroups.length > 0;
                    const mGroups = Array.isArray(mPool?.quotaGroups) && mPool.quotaGroups.length > 0;
                    if (!mPool || (dUpd > mUpd && (dGroups || !mGroups)) || (dGroups && !mGroups)) {
                      memAcc.cachedQuotaByPool[poolKey] = dPool;
                    }
                  }
                }
              }
            }
          }
        }
      }
    } catch {}

    const serialized = JSON.stringify(cfg, null, 2);
    const tmpPath = `${RELAY_CONFIG_FILE}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmpPath, serialized, "utf-8");
      fs.renameSync(tmpPath, RELAY_CONFIG_FILE);
    } catch (err) {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}
      fs.writeFileSync(RELAY_CONFIG_FILE, serialized, "utf-8");
    }
    lastValidCache = serialized;
    try {
      fs.writeFileSync(RELAY_CONFIG_BAK, serialized, "utf-8");
    } catch (e) {}
    return true;
  } catch (e) {
    return false;
  }
}
