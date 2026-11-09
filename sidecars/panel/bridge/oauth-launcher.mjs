import https from "node:https";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  HOME_DIR,
  JETSKI_TOKEN_FILE,
  readRelayConfig,
  writeRelayConfig,
  resolveCurrentInstanceContext,
  writeInstanceDescriptor,
  getInstanceMeta,
  getInstanceTokenFilePath,
  ensureInstanceIsolatedHome
} from "../store.mjs";
import { inspectConversationSignatureStatus } from "./signature-scrub.mjs";
import {
  AGY_OAUTH_CLIENT_ID,
  AGY_OAUTH_CLIENT_SECRET,
  AGY_OAUTH_SCOPES,
  AGY_AUTH_SUCCESS_URL,
  getOAuthClientForChannel,
  readWinCredToken,
  writeWinCredToken,
  writeInstanceTokenFile,
  syncInstanceAppStorage,
  buildStateVscdbSyncPayload,
  syncInstanceStateVscdb,
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

function sendCdpCommandOverWebSocket(wsUrl, method, params = {}) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(wsUrl);
      const key = crypto.randomBytes(16).toString("base64");
      const req = http.request({
        hostname: parsed.hostname || "127.0.0.1",
        port: Number(parsed.port),
        path: parsed.pathname + (parsed.search || ""),
        method: "GET",
        headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key },
        timeout: 1200
      });
      let settled = false;
      const finish = (ok) => { if (!settled) { settled = true; resolve(Boolean(ok)); } };
      req.on("upgrade", (_res, socket) => {
        try {
          const payload = Buffer.from(JSON.stringify({ id: 1, method, params }), "utf8");
          const mask = crypto.randomBytes(4);
          let header;
          if (payload.length < 126) {
            header = Buffer.alloc(6);
            header[0] = 0x81; header[1] = 0x80 | payload.length;
            mask.copy(header, 2);
          } else {
            header = Buffer.alloc(8);
            header[0] = 0x81; header[1] = 0x80 | 126;
            header.writeUInt16BE(payload.length, 2);
            mask.copy(header, 4);
          }
          const masked = Buffer.alloc(payload.length);
          for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
          socket.write(Buffer.concat([header, masked]));
          setTimeout(() => { try { socket.end(); socket.destroy(); } catch {} finish(true); }, 120);
        } catch {
          try { socket.destroy(); } catch {}
          finish(false);
        }
      });
      req.on("error", () => finish(false));
      req.on("timeout", () => { try { req.destroy(); } catch {} finish(false); });
      req.end();
    } catch { resolve(false); }
  });
}

function fetchCdpTargetsList(port, timeout = 320) {
  return new Promise((resolve) => {
    if (!port || port <= 1024) return resolve([]);
    const req = http.get({ hostname: "127.0.0.1", port, path: "/json", timeout }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve([]); }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          resolve(Array.isArray(parsed) ? parsed : []);
        } catch { resolve([]); }
      });
    });
    req.on("error", () => resolve([]));
    req.on("timeout", () => { try { req.destroy(); } catch {} resolve([]); });
  });
}

export async function reloadInstanceWorkbenchViaCdp(ctx = null) {
  const activeCtx = ctx || resolveCurrentInstanceContext();
  const port = discoverInstanceCdpPort(activeCtx);
  const targets = await fetchCdpTargetsList(port, 800);
  const pageTargets = targets.filter((t) => {
    if (!t || t.type !== "page" || typeof t.webSocketDebuggerUrl !== "string") return false;
    const u = String(t.url || "").trim().toLowerCase();
    if (!u || u.startsWith("devtools://") || u.startsWith("chrome-devtools://") || u.startsWith("plugin://")) return false;
    return true;
  });
  if (pageTargets.length === 0) return false;
  let anyOk = false;
  for (const pt of pageTargets) {
    const ok = await sendCdpCommandOverWebSocket(pt.webSocketDebuggerUrl, "Page.reload", { ignoreCache: false });
    if (ok) anyOk = true;
  }
  return anyOk;
}

export async function restartCurrentAntigravityInstance(ctx = null, opts = {}) {
  const activeCtx = ctx || resolveCurrentInstanceContext();
  const exePath = resolveAntigravityExePath();
  if (!exePath) {
    return reloadInstanceWorkbenchViaCdp(activeCtx);
  }
  const isIsolated = Boolean(activeCtx?.isIsolatedInstance && activeCtx?.userDataDir);
  const safeId = isIsolated
    ? String(activeCtx.instanceId || "iso").replace(/[^a-zA-Z0-9._-]+/g, "_")
    : "main";
  const userDataDir = String(activeCtx?.userDataDir || "");
  const isoHomeDir = isIsolated ? ensureInstanceIsolatedHome(userDataDir) : "";
  const appStoragePath = userDataDir ? path.join(userDataDir, "app_storage.json") : "";
  let appStorageContent = "";
  try {
    if (appStoragePath && fs.existsSync(appStoragePath)) {
      appStorageContent = fs.readFileSync(appStoragePath, "utf8");
    }
  } catch {}
  const tokenFilePath = isIsolated
    ? getInstanceTokenFilePath(userDataDir)
    : JETSKI_TOKEN_FILE;
  const tokenContent = opts?.tokenObj ? JSON.stringify(opts.tokenObj) : "";
  const stateVscdbPath = userDataDir ? path.join(userDataDir, "User", "globalStorage", "state.vscdb") : "";
  const vscdbPayload = opts?.tokenObj
    ? buildStateVscdbSyncPayload(opts.tokenObj, opts.email || "", opts.gcpProjectId || "")
    : null;

  const geminiDir = path.join(HOME_DIR, ".gemini");
  fs.mkdirSync(geminiDir, { recursive: true });
  const configPath = path.join(geminiDir, `agy-relay-restart-${safeId}.json`);
  const scriptPath = path.join(geminiDir, `agy-relay-restart-${safeId}.ps1`);
  const vscdbSyncScriptPath = path.join(geminiDir, "agy-relay-sync-vscdb.mjs");

  const vscdbSyncMjs = [
    'import fs from "node:fs";',
    'import path from "node:path";',
    'import { DatabaseSync } from "node:sqlite";',
    'const cfgPath = process.argv[2] || "";',
    'if (!cfgPath || !fs.existsSync(cfgPath)) process.exit(0);',
    'try {',
    '  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));',
    '  if (cfg.appStoragePath && cfg.appStorageContent) {',
    '    try { fs.writeFileSync(cfg.appStoragePath, cfg.appStorageContent, "utf8"); } catch {}',
    '  }',
    '  const targetHome = String(cfg.isIsolated && cfg.isoHomeDir ? cfg.isoHomeDir : cfg.realHomeDir || "");',
    '  if (targetHome) {',
    '    try {',
    '      const geminiCfgPath = path.join(targetHome, ".gemini", "config", "config.json");',
    '      if (fs.existsSync(geminiCfgPath)) {',
    '        const gCfg = JSON.parse(fs.readFileSync(geminiCfgPath, "utf8"));',
    '        if (gCfg && typeof gCfg === "object") {',
    '          if (!gCfg.userSettings || typeof gCfg.userSettings !== "object") gCfg.userSettings = {};',
    '          if (cfg.vscdbPayload?.isGcp) {',
    '            gCfg.userSettings.gcpRegion = cfg.gcpLocation || "global";',
    '          }',
    '          fs.writeFileSync(geminiCfgPath, JSON.stringify(gCfg, null, 2), "utf8");',
    '        }',
    '      }',
    '    } catch {}',
    '  }',
    '  const dbPath = String(cfg.stateVscdbPath || "");',
    '  const p = cfg.vscdbPayload;',
    '  if (dbPath && p && fs.existsSync(dbPath)) {',
    '    const db = new DatabaseSync(dbPath);',
    '    try {',
    '      try { db.exec("PRAGMA busy_timeout = 5000;"); } catch {}',
    '      db.exec("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");',
    '      const upsert = db.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)");',
    '      if (p.oauthTokenB64) upsert.run("antigravityUnifiedStateSync.oauthToken", p.oauthTokenB64);',
    '      if (p.userStatusB64) upsert.run("antigravityUnifiedStateSync.userStatus", p.userStatusB64);',
    '      if (p.isGcp && p.enterprisePrefsB64) {',
    '        upsert.run("antigravityUnifiedStateSync.enterprisePreferences", p.enterprisePrefsB64);',
    '      } else {',
    '        db.prepare("DELETE FROM ItemTable WHERE key = ?").run("antigravityUnifiedStateSync.enterprisePreferences");',
    '      }',
    '      let gcaObj = {};',
    '      try {',
    '        const gcaRow = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("google.geminicodeassist");',
    '        if (gcaRow && gcaRow.value) {',
    '          const parsedGca = JSON.parse(String(gcaRow.value));',
    '          if (parsedGca && typeof parsedGca === "object") gcaObj = { ...parsedGca };',
    '        }',
    '      } catch {}',
    '      if (p.isGcp && p.gcpProjectId) {',
    '        gcaObj["geminicodeassist.project"] = p.gcpProjectId;',
    '      } else {',
    '        delete gcaObj["geminicodeassist.project"];',
    '      }',
    '      upsert.run("google.geminicodeassist", JSON.stringify(gcaObj));',
    '      let authObj = { name: p.email ? p.email.split("@")[0] : "User", email: p.email || "", apiKey: p.accessToken || "" };',
    '      try {',
    '        const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("antigravityAuthStatus");',
    '        if (row && row.value) {',
    '          const parsed = JSON.parse(String(row.value));',
    '          if (parsed && typeof parsed === "object") {',
    '            authObj = { ...parsed, email: p.email || parsed.email || "", apiKey: p.accessToken || parsed.apiKey || "" };',
    '            delete authObj.userStatusProtoBinaryBase64;',
    '          }',
    '        }',
    '      } catch {}',
    '      upsert.run("antigravityAuthStatus", JSON.stringify(authObj));',
    '      try { db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch {}',
    '    } finally {',
    '      db.close();',
    '    }',
    '  }',
    '  if (cfg.scrubConvId && cfg.realHomeDir && cfg.protoScrubPath && fs.existsSync(cfg.protoScrubPath)) {',
    '    try {',
    '      const { createRequire } = await import("node:module");',
    '      const req = createRequire(import.meta.url);',
    '      const { scrubSingleConversationDbSync } = req(cfg.protoScrubPath);',
    '      const convDir = path.join(cfg.realHomeDir, ".gemini", "antigravity", "conversations");',
    '      const targetDb = path.join(convDir, cfg.scrubConvId.endsWith(".db") ? cfg.scrubConvId : `${cfg.scrubConvId}.db`);',
    '      if (fs.existsSync(targetDb)) scrubSingleConversationDbSync(targetDb);',
    '      const sumDbPath = path.join(cfg.realHomeDir, ".gemini", "antigravity", "conversation_summaries.db");',
    '      if (fs.existsSync(sumDbPath)) {',
    '        const sdb = new DatabaseSync(sumDbPath);',
    '        try {',
    '          const children = sdb.prepare("SELECT conversation_id FROM conversation_summaries WHERE parent_conversation_id = ?").all(cfg.scrubConvId);',
    '          for (const ch of children) {',
    '            const chDb = path.join(convDir, `${ch.conversation_id}.db`);',
    '            if (fs.existsSync(chDb)) scrubSingleConversationDbSync(chDb);',
    '          }',
    '        } finally { sdb.close(); }',
    '      }',
    '    } catch {}',
    '  }',
    '} catch {}'
  ].join("\n");
  try {
    fs.writeFileSync(vscdbSyncScriptPath, vscdbSyncMjs, "utf8");
  } catch {}

  const protoScrubPath = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1")), "../../../lib/proto-scrub.cjs");

  const restartCfg = {
    isIsolated,
    instanceId: String(activeCtx?.instanceId || ""),
    userDataDir,
    isoHomeDir,
    realHomeDir: HOME_DIR,
    appDataDir: process.env.APPDATA || path.join(HOME_DIR, "AppData", "Roaming"),
    localAppDataDir: process.env.LOCALAPPDATA || path.join(HOME_DIR, "AppData", "Local"),
    exePath,
    exeDir: path.dirname(exePath),
    nodeExePath: process.execPath,
    vscdbSyncScriptPath,
    protoScrubPath,
    stateVscdbPath,
    vscdbPayload,
    gcpLocation: String(opts?.gcpLocation || "global"),
    scrubConvId: String(opts?.scrubConvId || ""),
    lsPid: Number(opts?.lsPid || 0),
    appStoragePath,
    appStorageContent,
    tokenFilePath: String(tokenFilePath || ""),
    tokenContent
  };
  fs.writeFileSync(configPath, JSON.stringify(restartCfg, null, 2), "utf8");

  const psScript = [
    "param([string]$ConfigPath)",
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$utf8NoBom = New-Object System.Text.UTF8Encoding($false)",
    "if (-not [System.IO.File]::Exists($ConfigPath)) { exit 1 }",
    "$cfgRaw = [System.IO.File]::ReadAllText($ConfigPath, $utf8NoBom)",
    "$cfg = $cfgRaw | ConvertFrom-Json",
    "Start-Sleep -Milliseconds 650",
    "$allProcs = Get-CimInstance Win32_Process -Filter \"Name = 'Antigravity.exe' OR Name LIKE 'language_server%'\"",
    "$targetPids = New-Object System.Collections.Generic.HashSet[int]",
    "if ($cfg.lsPid -gt 0) { [void]$targetPids.Add([int]$cfg.lsPid) }",
    "if ($cfg.isIsolated -and $cfg.instanceId) {",
    "  $instKey = [string]$cfg.instanceId",
    "  $dataDir = [string]$cfg.userDataDir",
    "  foreach ($p in $allProcs) {",
    "    $cmd = [string]$p.CommandLine",
    "    if (($cmd -and $cmd.IndexOf($instKey, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) -or ($dataDir -and $cmd -and $cmd.IndexOf($dataDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)) {",
    "      [void]$targetPids.Add([int]$p.ProcessId)",
    "    }",
    "  }",
    "  for ($pass = 0; $pass -lt 3; $pass++) {",
    "    foreach ($p in $allProcs) {",
    "      if ($targetPids.Contains([int]$p.ParentProcessId)) { [void]$targetPids.Add([int]$p.ProcessId) }",
    "    }",
    "  }",
    "} else {",
    "  $isoPids = New-Object System.Collections.Generic.HashSet[int]",
    "  foreach ($p in $allProcs) {",
    "    $cmd = [string]$p.CommandLine",
    "    if ($cmd -and $cmd.IndexOf('antigravity-instances', [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {",
    "      [void]$isoPids.Add([int]$p.ProcessId)",
    "    }",
    "  }",
    "  for ($pass = 0; $pass -lt 3; $pass++) {",
    "    foreach ($p in $allProcs) {",
    "      if ($isoPids.Contains([int]$p.ParentProcessId)) { [void]$isoPids.Add([int]$p.ProcessId) }",
    "    }",
    "  }",
    "  foreach ($p in $allProcs) {",
    "    $pidVal = [int]$p.ProcessId",
    "    if (-not $isoPids.Contains($pidVal)) { [void]$targetPids.Add($pidVal) }",
    "  }",
    "}",
    "if ($targetPids.Count -gt 0) {",
    "  $pidArray = [int[]]::new($targetPids.Count)",
    "  $targetPids.CopyTo($pidArray)",
    "  Stop-Process -Id $pidArray -Force -ErrorAction SilentlyContinue",
    "  Wait-Process -Id $pidArray -Timeout 4 -ErrorAction SilentlyContinue",
    "}",
    "for ($w = 0; $w -lt 8; $w++) {",
    "  $rem = Get-CimInstance Win32_Process -Filter \"Name = 'Antigravity.exe' OR Name LIKE 'language_server%'\" | Where-Object { $targetPids.Contains([int]$_.ProcessId) }",
    "  if (-not $rem) { break }",
    "  foreach ($rp in $rem) { Stop-Process -Id ([int]$rp.ProcessId) -Force -ErrorAction SilentlyContinue }",
    "  Start-Sleep -Milliseconds 250",
    "}",
    "Start-Sleep -Milliseconds 350",
    "if ($cfg.appStoragePath -and $cfg.appStorageContent) {",
    "  [System.IO.File]::WriteAllText([string]$cfg.appStoragePath, [string]$cfg.appStorageContent, $utf8NoBom)",
    "}",
    "if ($cfg.tokenFilePath -and $cfg.tokenContent) {",
    "  $tokDir = [System.IO.Path]::GetDirectoryName([string]$cfg.tokenFilePath)",
    "  if ($tokDir -and -not [System.IO.Directory]::Exists($tokDir)) {",
    "    [System.IO.Directory]::CreateDirectory($tokDir) | Out-Null",
    "  }",
    "  if ($cfg.isIsolated -or [System.IO.File]::Exists([string]$cfg.tokenFilePath)) {",
    "    [System.IO.File]::WriteAllText([string]$cfg.tokenFilePath, [string]$cfg.tokenContent, $utf8NoBom)",
    "  }",
    "}",
    "if ($cfg.vscdbSyncScriptPath -and [System.IO.File]::Exists([string]$cfg.vscdbSyncScriptPath)) {",
    "  $nodeCmd = if ($cfg.nodeExePath -and [System.IO.File]::Exists([string]$cfg.nodeExePath)) { [string]$cfg.nodeExePath } else { 'node' }",
    "  $env:ELECTRON_RUN_AS_NODE = '1'",
    "  & $nodeCmd ([string]$cfg.vscdbSyncScriptPath) $ConfigPath | Out-Null",
    "  Remove-Item Env:\\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue",
    "}",
    "if (-not $cfg.isIsolated -and $cfg.tokenContent) {",
    "  Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "using System.Text;",
    "public class AgyWinCredRestart {",
    "    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]",
    "    public struct CREDENTIAL {",
    "        public uint Flags;",
    "        public uint Type;",
    "        public IntPtr TargetName;",
    "        public IntPtr Comment;",
    "        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;",
    "        public uint CredentialBlobSize;",
    "        public IntPtr CredentialBlob;",
    "        public uint Persist;",
    "        public uint AttributeCount;",
    "        public IntPtr Attributes;",
    "        public IntPtr TargetAlias;",
    "        public IntPtr UserName;",
    "    }",
    "    [DllImport(\"Advapi32.dll\", SetLastError = true, CharSet = CharSet.Unicode)]",
    "    public static extern bool CredWriteW([In] ref CREDENTIAL userCredential, [In] uint flags);",
    "    [DllImport(\"Advapi32.dll\", SetLastError = true, CharSet = CharSet.Unicode)]",
    "    public static extern bool CredDeleteW(string target, uint type, uint flags);",
    "    public static bool Write(string target, string user, string secret) {",
    "        for (int i = 0; i < 10; i++) { CredDeleteW(target + \":\" + i, 1, 0); }",
    "        byte[] byteArray = Encoding.UTF8.GetBytes(secret);",
    "        CREDENTIAL cred = new CREDENTIAL();",
    "        cred.Flags = 0;",
    "        cred.Type = 1;",
    "        cred.TargetName = Marshal.StringToCoTaskMemUni(target);",
    "        cred.UserName = Marshal.StringToCoTaskMemUni(user);",
    "        cred.CredentialBlobSize = (uint)byteArray.Length;",
    "        cred.CredentialBlob = Marshal.AllocCoTaskMem(byteArray.Length);",
    "        Marshal.Copy(byteArray, 0, cred.CredentialBlob, byteArray.Length);",
    "        cred.Persist = 2;",
    "        try { return CredWriteW(ref cred, 0); }",
    "        finally {",
    "            if (cred.TargetName != IntPtr.Zero) Marshal.FreeCoTaskMem(cred.TargetName);",
    "            if (cred.UserName != IntPtr.Zero) Marshal.FreeCoTaskMem(cred.UserName);",
    "            if (cred.CredentialBlob != IntPtr.Zero) Marshal.FreeCoTaskMem(cred.CredentialBlob);",
    "        }",
    "    }",
    "}",
    "'@ -ErrorAction SilentlyContinue",
    "  [void][AgyWinCredRestart]::Write('gemini:antigravity', 'antigravity', [string]$cfg.tokenContent)",
    "}",
    "$env:APPDATA = [string]$cfg.appDataDir",
    "$env:LOCALAPPDATA = [string]$cfg.localAppDataDir",
    "if ($cfg.isIsolated) {",
    "  $env:USERPROFILE = [string]$cfg.isoHomeDir",
    "  $env:HOME = [string]$cfg.isoHomeDir",
    "  $env:SSH_TTY = '1'",
    "  $env:AGY_REAL_USERPROFILE = [string]$cfg.realHomeDir",
    "  $env:AGY_RELAY_INSTANCE_ID = [string]$cfg.instanceId",
    "  $env:AGY_RELAY_INSTANCE_USER_DATA_DIR = [string]$cfg.userDataDir",
    "  $env:PLUGIN_SWITCHER_DISABLE_8088 = '1'",
    "  $dataArg = \"--user-data-dir=$($cfg.userDataDir)\"",
    "  Start-Process -FilePath ([string]$cfg.exePath) -WorkingDirectory ([string]$cfg.exeDir) -ArgumentList @($dataArg) -WindowStyle Normal",
    "} else {",
    "  $env:USERPROFILE = [string]$cfg.realHomeDir",
    "  $env:HOME = [string]$cfg.realHomeDir",
    "  Remove-Item Env:\\SSH_TTY -ErrorAction SilentlyContinue",
    "  Remove-Item Env:\\AGY_REAL_USERPROFILE -ErrorAction SilentlyContinue",
    "  Remove-Item Env:\\AGY_RELAY_INSTANCE_ID -ErrorAction SilentlyContinue",
    "  Remove-Item Env:\\AGY_RELAY_INSTANCE_USER_DATA_DIR -ErrorAction SilentlyContinue",
    "  Remove-Item Env:\\PLUGIN_SWITCHER_DISABLE_8088 -ErrorAction SilentlyContinue",
    "  Start-Process -FilePath ([string]$cfg.exePath) -WorkingDirectory ([string]$cfg.exeDir) -WindowStyle Normal",
    "}"
  ].join("\r\n");
  fs.writeFileSync(scriptPath, psScript, "utf8");

  try {
    const escapedScript = scriptPath.replace(/'/g, "''");
    const escapedCfg = configPath.replace(/'/g, "''");
    const wmiCmd = `$startup = New-CimInstance -CimClass (Get-CimClass Win32_ProcessStartup) -ClientOnly; $startup.ShowWindow = [uint16]0; $cmdLine = 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${escapedScript}" -ConfigPath "${escapedCfg}"'; Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdLine; ProcessStartupInformation = $startup } | Out-Null`;
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", wmiCmd],
      { encoding: "utf8", timeout: 5000, windowsHide: true }
    );
    return true;
  } catch {
    try {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-ConfigPath", configPath],
        { detached: true, stdio: "ignore", windowsHide: true }
      );
      child.unref();
      return true;
    } catch {
      return false;
    }
  }
}

async function fetchWindowActiveConvIdViaCdp(port) {
  const targets = await fetchCdpTargetsList(port, 260);
  for (const t of targets) {
    if (t && t.type === "page" && typeof t.url === "string") {
      const m = t.url.match(/\/(?:c|cascade)\/([0-9a-f-]{36})/i);
      if (m && m[1]) return m[1];
    }
  }
  return "";
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

const convTranscriptCache = new Map();

function extractProjectNameFromWorkspaceUris(rawUris) {
  if (!rawUris || typeof rawUris !== "string") return "";
  try {
    const arr = JSON.parse(rawUris);
    if (Array.isArray(arr) && arr.length > 0) {
      const first = decodeURIComponent(String(arr[0] || "")).replace(/\\/g, "/").replace(/\/+$/, "");
      const base = first.split("/").pop() || "";
      return base;
    }
  } catch {}
  return "";
}

function parseSingleConversationTranscript(convId, brainDir, knownDict, fallbackModel = "Gemini 4 Argon") {
  const cleanId = String(convId || "").trim();
  const emptyStat = {
    sessionInputTokens: 0,
    sessionCacheTokens: 0,
    sessionOutputTokens: 0,
    sessionTotalTokens: 0,
    lastInputTokens: 0,
    lastCacheTokens: 0,
    lastContextTokens: 0,
    lastOutputTokens: 0,
    cacheHitPct: 0,
    turnCount: 0,
    checkpointCount: 0,
    checkpointTokens: 0,
    byModel: []
  };
  if (!cleanId) return emptyStat;
  const logPath = path.join(brainDir, cleanId, ".system_generated", "logs", "transcript.jsonl");
  if (!fs.existsSync(logPath)) return emptyStat;

  let st = null;
  try {
    st = fs.statSync(logPath);
  } catch {
    return emptyStat;
  }

  const cached = convTranscriptCache.get(cleanId);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.data;
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

  try {
    const rawText = fs.readFileSync(logPath, "utf8");
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

    let currentModel = initialBeforeChangeModel || fallbackModel || "Gemini 4 Argon";
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

  const lastContextTokens = (lastInputTokens || 0) + (lastCacheTokens || 0);
  const sessionTotalTokens = sessionInputTokens + sessionOutputTokens;
  const cacheHitPct = (sessionInputTokens + sessionCacheTokens) > 0
    ? Math.round((sessionCacheTokens / (sessionInputTokens + sessionCacheTokens)) * 100)
    : 0;

  const byModel = Array.from(modelMap.values())
    .map((m) => ({
      modelName: m.modelName,
      turns: m.turns,
      inputTokens: m.inputTokens,
      cacheTokens: m.cacheTokens,
      outputTokens: m.outputTokens,
      totalTokens: m.inputTokens + m.outputTokens,
      cacheHitPct: (m.inputTokens + m.cacheTokens) > 0 ? Math.round((m.cacheTokens / (m.inputTokens + m.cacheTokens)) * 100) : 0,
      lastUsedIndex: m.lastUsedIndex
    }))
    .sort((a, b) => b.lastUsedIndex - a.lastUsedIndex)
    .map(({ lastUsedIndex, ...rest }) => rest);

  const data = {
    sessionInputTokens,
    sessionCacheTokens,
    sessionOutputTokens,
    sessionTotalTokens,
    lastInputTokens: lastInputTokens || 0,
    lastCacheTokens: lastCacheTokens || 0,
    lastContextTokens,
    lastOutputTokens: lastOutputTokens || 0,
    cacheHitPct,
    turnCount,
    checkpointCount,
    checkpointTokens,
    byModel
  };

  convTranscriptCache.set(cleanId, {
    mtimeMs: st.mtimeMs,
    size: st.size,
    data
  });
  return data;
}

export async function computeSessionTelemetrySnapshot(cfgInput = null, instanceCtx = null, activeIsGcpInput = undefined) {
  const cfg = cfgInput || readRelayConfig();
  const ctx = instanceCtx || resolveCurrentInstanceContext();
  const instMeta = getInstanceMeta(cfg, ctx);
  const activeIsGcp = activeIsGcpInput !== undefined
    ? Boolean(activeIsGcpInput)
    : Boolean(instMeta.lastAppliedGcpProject || (!ctx.isIsolatedInstance && cfg.__meta__?.lastAppliedGcpProject));
  const knownDict = buildKnownTelemetryModelDict(cfg);
  const brainDir = path.join(HOME_DIR, ".gemini", "antigravity", "brain");

  // 1. 优先通过当前实例专属 CDP 端口直读正在打开的会话路由 (/c/<convId>)，次选当前实例专属 language_server.log 尾部会话 ID
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

  // 仅当主实例尚未从 CDP/日志解析出会话时，回退至 brain 下最新会话；多开独立实例严禁盲抓全局最新会话防跨实例串数
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

  // 2. 读取官方 conversation_summaries.db，关联当前会话所属项目下的全部会话与标题
  const sumDbPath = path.join(HOME_DIR, ".gemini", "antigravity", "conversation_summaries.db");
  let projectId = "";
  let projectName = "";
  let mainTargetConvId = targetConvId;
  let projectMainRows = [];

  try {
    if (fs.existsSync(sumDbPath)) {
      const sumDb = new DatabaseSync(sumDbPath);
      try {
        if (targetConvId) {
          const curRow = sumDb
            .prepare("SELECT conversation_id, title, project_id, workspace_uris, parent_conversation_id, nesting_depth, step_count, last_modified_time FROM conversation_summaries WHERE conversation_id = ?")
            .get(targetConvId);
          if (curRow) {
            projectId = String(curRow.project_id || "").trim();
            projectName = extractProjectNameFromWorkspaceUris(curRow.workspace_uris);
            if (Number(curRow.nesting_depth || 0) > 0 && curRow.parent_conversation_id) {
              mainTargetConvId = String(curRow.parent_conversation_id).trim();
            }
          }
        }
        if (projectId) {
          projectMainRows = sumDb
            .prepare("SELECT conversation_id, title, project_id, workspace_uris, parent_conversation_id, nesting_depth, step_count, last_modified_time FROM conversation_summaries WHERE project_id = ? AND nesting_depth = 0 ORDER BY last_modified_time DESC LIMIT 25")
            .all(projectId);
          if (!projectName && projectMainRows.length > 0) {
            projectName = extractProjectNameFromWorkspaceUris(projectMainRows[0].workspace_uris);
          }
        } else if (mainTargetConvId) {
          const singleRow = sumDb
            .prepare("SELECT conversation_id, title, project_id, workspace_uris, parent_conversation_id, nesting_depth, step_count, last_modified_time FROM conversation_summaries WHERE conversation_id = ?")
            .get(mainTargetConvId);
          if (singleRow) {
            projectMainRows = [singleRow];
            projectName = extractProjectNameFromWorkspaceUris(singleRow.workspace_uris);
          }
        }
      } finally {
        sumDb.close();
      }
    }
  } catch {}

  if (mainTargetConvId) {
    targetConvId = mainTargetConvId;
    instMeta.lastActiveConvId = mainTargetConvId;
  }

  if (projectMainRows.length === 0 && targetConvId) {
    projectMainRows = [
      {
        conversation_id: targetConvId,
        title: targetConvId.slice(0, 8),
        project_id: projectId,
        workspace_uris: "",
        parent_conversation_id: "",
        nesting_depth: 0,
        step_count: 0,
        last_modified_time: ""
      }
    ];
  }

  const fallbackModel = logFallback.lastModel || "Gemini 4 Argon";
  const projectConversations = [];
  let projInputTokens = 0;
  let projCacheTokens = 0;
  let projOutputTokens = 0;
  let projTurnCount = 0;
  let projCheckpointCount = 0;
  let projCheckpointTokens = 0;
  const projModelMap = new Map();
  let projHasGcpSig = false;
  let projHasPersonalSig = false;
  let projMismatchedCount = 0;

  for (let idx = 0; idx < projectMainRows.length; idx++) {
    const r = projectMainRows[idx];
    const cid = String(r.conversation_id || "").trim();
    if (!cid) continue;
    const tStat = parseSingleConversationTranscript(cid, brainDir, knownDict, fallbackModel);
    const sigStat = inspectConversationSignatureStatus(cid, activeIsGcp, cid === targetConvId);
    if (sigStat.hasGcpSig) projHasGcpSig = true;
    if (sigStat.hasPersonalSig) projHasPersonalSig = true;
    if (sigStat.mismatched) projMismatchedCount += 1;

    projInputTokens += tStat.sessionInputTokens;
    projCacheTokens += tStat.sessionCacheTokens;
    projOutputTokens += tStat.sessionOutputTokens;
    projTurnCount += tStat.turnCount;
    projCheckpointCount += tStat.checkpointCount;
    projCheckpointTokens += tStat.checkpointTokens;

    for (const m of tStat.byModel) {
      if (!projModelMap.has(m.modelName)) {
        projModelMap.set(m.modelName, {
          modelName: m.modelName,
          turns: 0,
          inputTokens: 0,
          cacheTokens: 0,
          outputTokens: 0,
          orderIdx: idx
        });
      }
      const pm = projModelMap.get(m.modelName);
      pm.turns += m.turns;
      pm.inputTokens += m.inputTokens;
      pm.cacheTokens += m.cacheTokens;
      pm.outputTokens += m.outputTokens;
    }

    const rawTitle = String(r.title || "").trim();
    projectConversations.push({
      fullConversationId: cid,
      conversationId: cid.slice(0, 8),
      title: rawTitle || cid.slice(0, 8),
      isCurrentActive: cid === targetConvId,
      lastModifiedTime: r.last_modified_time || "",
      signatureStatus: {
        sigType: sigStat.sigType,
        hasGcpSig: sigStat.hasGcpSig,
        hasPersonalSig: sigStat.hasPersonalSig,
        mismatched: sigStat.mismatched
      },
      ...tStat
    });
  }

  const activeConvItem =
    projectConversations.find((c) => c.fullConversationId === targetConvId) ||
    projectConversations[0] ||
    {
      fullConversationId: targetConvId || "",
      conversationId: targetConvId ? targetConvId.slice(0, 8) : "",
      title: targetConvId ? targetConvId.slice(0, 8) : "",
      isCurrentActive: true,
      signatureStatus: inspectConversationSignatureStatus(targetConvId, activeIsGcp, true),
      ...parseSingleConversationTranscript(targetConvId, brainDir, knownDict, fallbackModel)
    };

  const projTotalTokens = projInputTokens + projOutputTokens;
  const projCacheHitPct = (projInputTokens + projCacheTokens) > 0
    ? Math.round((projCacheTokens / (projInputTokens + projCacheTokens)) * 100)
    : 0;
  const projByModel = Array.from(projModelMap.values())
    .map((m) => ({
      modelName: m.modelName,
      turns: m.turns,
      inputTokens: m.inputTokens,
      cacheTokens: m.cacheTokens,
      outputTokens: m.outputTokens,
      totalTokens: m.inputTokens + m.outputTokens,
      cacheHitPct: (m.inputTokens + m.cacheTokens) > 0 ? Math.round((m.cacheTokens / (m.inputTokens + m.cacheTokens)) * 100) : 0
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  let projSigType = "none";
  if (activeIsGcp && projHasGcpSig) projSigType = "gcp";
  else if (!activeIsGcp && projHasPersonalSig) projSigType = "personal";
  else if (projHasGcpSig) projSigType = "gcp";
  else if (projHasPersonalSig) projSigType = "personal";

  const projectTotal = {
    projectId,
    projectName: projectName || "",
    conversationCount: projectConversations.length,
    lastInputTokens: activeConvItem.lastInputTokens || 0,
    lastCacheTokens: activeConvItem.lastCacheTokens || 0,
    lastContextTokens: activeConvItem.lastContextTokens || 0,
    lastOutputTokens: activeConvItem.lastOutputTokens || 0,
    sessionInputTokens: projInputTokens,
    sessionCacheTokens: projCacheTokens,
    sessionOutputTokens: projOutputTokens,
    sessionTotalTokens: projTotalTokens,
    cacheHitPct: projCacheHitPct,
    turnCount: projTurnCount,
    checkpointCount: projCheckpointCount,
    checkpointTokens: projCheckpointTokens,
    byModel: projByModel,
    signatureStatus: {
      sigType: projSigType,
      hasGcpSig: projHasGcpSig,
      hasPersonalSig: projHasPersonalSig,
      mismatched: projMismatchedCount > 0,
      mismatchedCount: projMismatchedCount
    }
  };

  return {
    fullConversationId: activeConvItem.fullConversationId,
    conversationId: activeConvItem.conversationId,
    title: activeConvItem.title,
    projectId,
    projectName: projectName || "",
    signatureStatus: activeConvItem.signatureStatus,
    lastInputTokens: activeConvItem.lastInputTokens || 0,
    lastCacheTokens: activeConvItem.lastCacheTokens || 0,
    lastContextTokens: activeConvItem.lastContextTokens || 0,
    lastOutputTokens: activeConvItem.lastOutputTokens || 0,
    sessionInputTokens: activeConvItem.sessionInputTokens || 0,
    sessionCacheTokens: activeConvItem.sessionCacheTokens || 0,
    sessionOutputTokens: activeConvItem.sessionOutputTokens || 0,
    sessionTotalTokens: activeConvItem.sessionTotalTokens || 0,
    cacheHitPct: activeConvItem.cacheHitPct || 0,
    turnCount: activeConvItem.turnCount || 0,
    checkpointCount: activeConvItem.checkpointCount || 0,
    checkpointTokens: activeConvItem.checkpointTokens || 0,
    byModel: activeConvItem.byModel || [],
    projectConversations,
    projectTotal,
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
    throw new Error("个人通道与 GCP 通道独立实例均已在场上运行，不能再开新实例；同通道账号请在对应实例内启用或配置算力路由");
  }
  if (targetIsGcp && fieldStatus.otherGcpInstance) {
    throw new Error(`GCP 通道已在另一实例 (${fieldStatus.otherGcpInstance.email}) 运行中，无需重复多开`);
  }
  if (!targetIsGcp && fieldStatus.otherPersonalInstance) {
    throw new Error(`个人通道已在另一实例 (${fieldStatus.otherPersonalInstance.email}) 运行中，无需重复多开`);
  }

  const exePath = resolveAntigravityExePath();
  if (!exePath) {
    throw new Error("未找到本机 Antigravity.exe 可执行文件");
  }

  const targetProject = (target.gcpProjectId || "").trim();
  const targetBillingMode = targetProject ? (target.gcpBillingMode || "agent_platform") : "";
  const targetLocation = targetProject
    ? (targetBillingMode === "agent_platform" ? (target.gcpLocation || "global") : "")
    : "";

  const baseToken =
    cfg.__meta__?.channelTokensById?.[target.id] ||
    target.storedToken ||
    findStoredTokenForEmail(cfg, target.email, Boolean(targetProject));
  if (!baseToken) {
    throw new Error(`未找到账号 ${target.email} 的凭据快照`);
  }

  const clonedBase = JSON.parse(JSON.stringify(baseToken));
  if (clonedBase.token?.refresh_token) {
    try {
      const rt = clonedBase.token.refresh_token;
      const refreshed = await refreshOAuthAccessToken(rt);
      if (refreshed && refreshed.access_token) {
        const newExpiry = new Date(Date.now() + (refreshed.expires_in || 3599) * 1000).toISOString();
        clonedBase.token.access_token = refreshed.access_token;
        clonedBase.token.refreshedForRt = rt;
        clonedBase.token.expiry = newExpiry;
      }
    } catch {}
  }

  const tokenToWrite = buildCleanChannelToken(clonedBase, targetProject, targetLocation, true, targetBillingMode);
  target.storedToken = tokenToWrite;
  if (!cfg.__meta__.channelTokensById || typeof cfg.__meta__.channelTokensById !== "object") {
    cfg.__meta__.channelTokensById = {};
  }
  cfg.__meta__.channelTokensById[target.id] = JSON.parse(JSON.stringify(tokenToWrite));

  const safeFolder = rawId.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const instanceUserDataDir = path.join(HOME_DIR, ".gemini", "antigravity-instances", safeFolder);
  const instanceUserDir = path.join(instanceUserDataDir, "User");
  const instanceGlobalStorageDir = path.join(instanceUserDir, "globalStorage");
  const instanceLogsDir = path.join(instanceUserDataDir, "logs");
  const isoHomeDir = ensureInstanceIsolatedHome(instanceUserDataDir);
  writeInstanceTokenFile(instanceUserDataDir, tokenToWrite);

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
    const srcWinState = path.join(mainAppDataDir, "window_state.json");
    const dstWinState = path.join(instanceUserDataDir, "window_state.json");
    if (fs.existsSync(srcWinState) && !fs.existsSync(dstWinState)) {
      fs.copyFileSync(srcWinState, dstWinState);
    }
    const srcStateVscdb = path.join(mainAppDataDir, "User", "globalStorage", "state.vscdb");
    const dstStateVscdb = path.join(instanceGlobalStorageDir, "state.vscdb");
    if (fs.existsSync(srcStateVscdb) && !fs.existsSync(dstStateVscdb)) {
      fs.copyFileSync(srcStateVscdb, dstStateVscdb);
    }
    syncInstanceAppStorage(
      instanceUserDataDir,
      target.email,
      Boolean(targetProject),
      true,
      targetProject,
      targetBillingMode,
      targetLocation
    );
    syncInstanceStateVscdb(instanceUserDataDir, tokenToWrite, target.email, targetProject);
  } catch {}

  const launchedAt = Date.now();
  writeInstanceDescriptor(instanceUserDataDir, {
    instanceId: safeFolder,
    activeChannelId: target.id,
    email: target.email,
    gcpProjectId: targetProject,
    userDataDir: instanceUserDataDir,
    isolatedTokenStorage: "file",
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
  isoMeta.switchedViaPanel = true;
  writeRelayConfig(cfg);

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
  cleanEnv.USERPROFILE = isoHomeDir;
  cleanEnv.HOME = isoHomeDir;
  cleanEnv.SSH_TTY = "1";
  cleanEnv.AGY_REAL_USERPROFILE = HOME_DIR;
  cleanEnv.AGY_RELAY_INSTANCE_ID = safeFolder;
  cleanEnv.AGY_RELAY_INSTANCE_USER_DATA_DIR = instanceUserDataDir;
  cleanEnv.PLUGIN_SWITCHER_DISABLE_8088 = "1";

  const userDataArg = `--user-data-dir=${instanceUserDataDir}`;
  let launchedPid = 0;
  try {
    const geminiDir = path.join(HOME_DIR, ".gemini");
    fs.mkdirSync(geminiDir, { recursive: true });
    const launchScriptPath = path.join(geminiDir, `agy-relay-launch-${safeFolder}.ps1`);
    const psExe = exePath.replace(/'/g, "''");
    const psDir = path.dirname(exePath).replace(/'/g, "''");
    const psDataArg = userDataArg.replace(/'/g, "''");
    const psIsoHome = isoHomeDir.replace(/'/g, "''");
    const psRealHome = HOME_DIR.replace(/'/g, "''");
    const psSafeId = safeFolder.replace(/'/g, "''");
    const psDataDir = instanceUserDataDir.replace(/'/g, "''");
    const launchPsContent = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      `$env:USERPROFILE = '${psIsoHome}'`,
      `$env:HOME = '${psIsoHome}'`,
      "$env:SSH_TTY = '1'",
      `$env:AGY_REAL_USERPROFILE = '${psRealHome}'`,
      `$env:AGY_RELAY_INSTANCE_ID = '${psSafeId}'`,
      `$env:AGY_RELAY_INSTANCE_USER_DATA_DIR = '${psDataDir}'`,
      "$env:PLUGIN_SWITCHER_DISABLE_8088 = '1'",
      "Remove-Item Env:\\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue",
      `Start-Process -FilePath '${psExe}' -WorkingDirectory '${psDir}' -ArgumentList @('${psDataArg}') -WindowStyle Normal`
    ].join("\r\n");
    fs.writeFileSync(launchScriptPath, launchPsContent, "utf8");
    const escapedLaunchScript = launchScriptPath.replace(/'/g, "''");
    const wmiLaunchCmd = `$startup = New-CimInstance -CimClass (Get-CimClass Win32_ProcessStartup) -ClientOnly; $startup.ShowWindow = [uint16]0; $cmdLine = 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${escapedLaunchScript}"'; $res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdLine; ProcessStartupInformation = $startup }; if ($res -and $res.ProcessId) { Write-Output $res.ProcessId }`;
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", wmiLaunchCmd],
      {
        env: cleanEnv,
        encoding: "utf8",
        timeout: 6000,
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
            access_token: tokenResp.access_token, token_type: tokenResp.token_type || "Bearer",
            refresh_token: tokenResp.refresh_token, expiry: expiryDate, expires_in: tokenResp.expires_in || 3599
          },
          id_token: tokenResp.id_token || "", id_token_email: email
        }, "", "");

        const cfg = readRelayConfig();
        normalizeAccountChannels(cfg);
        if (!cfg.__meta__.oauthTokensByEmail || typeof cfg.__meta__.oauthTokensByEmail !== "object") cfg.__meta__.oauthTokensByEmail = {};
        cfg.__meta__.oauthTokensByEmail[email] = storedToken;
        if (targetChannelType === "gcp") {
          if (!cfg.__meta__.gcpOAuthTokensByEmail || typeof cfg.__meta__.gcpOAuthTokensByEmail !== "object") cfg.__meta__.gcpOAuthTokensByEmail = {};
          cfg.__meta__.gcpOAuthTokensByEmail[email] = storedToken;
        }

        for (const existingAcc of Object.values(cfg.accounts || {})) {
          if (existingAcc.email === email) {
            const existingIsGcp = Boolean(existingAcc.gcpProjectId || existingAcc.channelType === "gcp");
            if (targetChannelType === "personal" && existingIsGcp && existingAcc.storedToken?.token?.refresh_token && !existingAcc.authExpired) continue;
            if (targetChannelType === "gcp" && !existingIsGcp && existingAcc.storedToken?.token?.refresh_token && !existingAcc.authExpired) continue;
            existingAcc.authExpired = false;
            existingAcc.storedToken = existingAcc.gcpProjectId
              ? buildCleanChannelToken(
                  storedToken,
                  existingAcc.gcpProjectId,
                  existingAcc.gcpBillingMode === "agent_platform" ? (existingAcc.gcpLocation || "global") : "",
                  false,
                  existingAcc.gcpBillingMode || "agent_platform"
                )
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
            if (!cfg.gcpProjects.includes(targetGcpProjectId)) cfg.gcpProjects.push(targetGcpProjectId);
            cfg.accounts[gcpKey] = {
              id: gcpKey, alias: `${email} (${targetGcpProjectId})`, email, channelType: "gcp", tierName,
              authExpired: false,
              gcpProjectId: targetGcpProjectId, gcpBillingMode: targetGcpBillingMode, gcpLocation: targetGcpLocation,
              projectName: targetGcpProjectId, savedAt: new Date().toISOString(),
              storedToken: buildCleanChannelToken(
                storedToken,
                targetGcpProjectId,
                targetGcpBillingMode === "agent_platform" ? targetGcpLocation : "",
                true,
                targetGcpBillingMode
              ),
              cachedQuota: targetGcpBillingMode === "agent_platform"
                ? { isGcpUnlimited: true, quotaGroups: [], availableModels: AGENT_PLATFORM_DEFAULT_MODELS.map((m) => ({ ...m, variantIds: [...m.variantIds] })), updatedAt: Date.now() }
                : { isGcpUnlimited: true, quotaGroups: [], availableModels: [], updatedAt: Date.now() }
            };
            writeRelayConfig(cfg);
            if (onCompleteCallback) onCompleteCallback({ success: true, email, channelType: "gcp", gcpProjectId: targetGcpProjectId, autoScanGcp: false });
          } else {
            writeRelayConfig(cfg);
            if (onCompleteCallback) onCompleteCallback({ success: true, email, channelType: "gcp", autoScanGcp: true });
          }
          return;
        }

        const personalKey = `${email}#personal`;
        if (Array.isArray(cfg.__meta__.deletedChannelIds)) {
          cfg.__meta__.deletedChannelIds = cfg.__meta__.deletedChannelIds.filter((id) => id !== personalKey);
        }
        cfg.accounts[personalKey] = {
          ...(cfg.accounts[personalKey] || {}),
          id: personalKey, alias: email, email, channelType: "personal",
          authExpired: false,
          tierName: cfg.accounts[personalKey]?.tierName || "Google AI Pro",
          gcpProjectId: "", savedAt: new Date().toISOString(), storedToken
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
