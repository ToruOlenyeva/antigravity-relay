import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveHostHomeDir() {
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
export const PRELOAD_SDK_PATH = path.join(HOME_DIR, ".gemini", "antigravity", "lib", "node_modules", "sidecar_sdk", "preload.js");

let lastValidCache = null;

function createDefaultConfig() {
  return {
    accounts: {},
    gcpProjects: [],
    routing: {
      autoRelayOnLowQuota: true,
      lowQuotaThresholdPct: 5,
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
  if (!cfg.routing.models || typeof cfg.routing.models !== "object") cfg.routing.models = {};
  if (!cfg.routing.gcpModels || typeof cfg.routing.gcpModels !== "object") cfg.routing.gcpModels = {};
  delete cfg.routing.subagentDefaultTarget;
  if (!cfg.__meta__ || typeof cfg.__meta__ !== "object") cfg.__meta__ = {};
  if (!Array.isArray(cfg.__meta__.recentSidecarPorts)) cfg.__meta__.recentSidecarPorts = [];
  migrateLegacyProfilesIfNeeded(cfg);
  return cfg;
}

function migrateLegacyProfilesIfNeeded(cfg) {
  try {
    let changed = false;
    if (fs.existsSync(OLD_RELAY_CONFIG_FILE)) {
      try {
        const oldCfg = JSON.parse(fs.readFileSync(OLD_RELAY_CONFIG_FILE, "utf-8"));
        if (oldCfg?.accounts && typeof oldCfg.accounts === "object") {
          for (const [k, v] of Object.entries(oldCfg.accounts)) {
            if (!cfg.accounts[k]) {
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
            if (!cfg.accounts[key]) {
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
    if (changed) {
      writeRelayConfig(cfg);
    }
  } catch (e) {}
}

export function writeRelayConfig(cfg) {
  try {
    const dir = path.dirname(RELAY_CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
