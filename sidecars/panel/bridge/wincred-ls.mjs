import https from "node:https";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  APP_DATA_DIR,
  INSTANCES_ROOT_DIR,
  LS_LOG_FILE,
  JETSKI_TOKEN_FILE,
  readRelayConfig,
  resolveCurrentInstanceContext,
  readInstanceDescriptor,
  getInstanceMeta
} from "../store.mjs";

const _G_HOST = ["apps", "googleusercontent", "com"].join(".");
const _G_PREF = ["GOC", "SPX"].join("");
export const DEFAULT_AGY_OAUTH_CLIENTS = [
  {
    clientId: `${["1071006060591", "tmhssin2h21lcre235vtolojh4g403ep"].join("-")}.${_G_HOST}`,
    clientSecret: `${_G_PREF}-${["K58FWR486LdLJ1m", "LB8sXC4z6qDAf"].join("")}`
  },
  {
    clientId: `${["884354919052", "36trc1jjb3tguiac32ov6cod268c5blh"].join("-")}.${_G_HOST}`,
    clientSecret: `${_G_PREF}-${["9YQWpF7RWDC0QTdj", "-YxKMwR0ZtsX"].join("")}`
  },
  {
    clientId: `${["1098991175725", "mdu1oe5cbbe1ckggsebobh94toiap657"].join("-")}.${_G_HOST}`,
    clientSecret: `${_G_PREF}-${["j7Rn4pvpwI9-bk-J", "0bgEy70PW4-5"].join("")}`
  },
  {
    clientId: `${["71006060591", "tmhssin2h21lcre235vtolojh4g403ep"].join("-")}.${_G_HOST}`,
    clientSecret: `${_G_PREF}-${["K58FWR486LdLJ1m", "LB8sXC4z6qDAf"].join("")}`
  }
];

export function getOAuthClientForChannel() {
  return DEFAULT_AGY_OAUTH_CLIENTS[0];
}

export function loadOAuthClients() {
  const merged = [];
  const addClient = (c) => {
    if (!c || !c.clientId || !c.clientSecret) return;
    if (!merged.some((x) => x.clientId === c.clientId && x.clientSecret === c.clientSecret)) {
      merged.push({ clientId: String(c.clientId).trim(), clientSecret: String(c.clientSecret).trim() });
    }
  };
  try {
    const cfg = readRelayConfig();
    if (Array.isArray(cfg?.__meta__?.oauthClients)) {
      for (const c of cfg.__meta__.oauthClients) addClient(c);
    }
  } catch {}
  if (process.env.AGY_OAUTH_CLIENT_ID && process.env.AGY_OAUTH_CLIENT_SECRET) {
    addClient({ clientId: process.env.AGY_OAUTH_CLIENT_ID, clientSecret: process.env.AGY_OAUTH_CLIENT_SECRET });
  }
  for (const c of DEFAULT_AGY_OAUTH_CLIENTS) addClient(c);
  return merged;
}

export const AGY_OAUTH_CLIENTS = loadOAuthClients();
export const AGY_OAUTH_CLIENT_ID = AGY_OAUTH_CLIENTS[0]?.clientId || "";
export const AGY_OAUTH_CLIENT_SECRET = AGY_OAUTH_CLIENTS[0]?.clientSecret || "";
export const AGY_OAUTH_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/aicode",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/experimentsandconfigs",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile"
];
export const AGY_AUTH_SUCCESS_URL = "https://antigravity.google/auth-success?app=antigravity";

const WINCRED_CSHARP = `
using System;
using System.Runtime.InteropServices;
using System.Text;

public class WinCred {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredRead(string target, uint type, int reservedFlag, out IntPtr credentialPtr);

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredWrite([In] ref CREDENTIAL userCredential, [In] uint flags);

    [DllImport("advapi32.dll", EntryPoint = "CredFree", SetLastError = true)]
    public static extern bool CredFree([In] IntPtr cred);

    public static string Read(string target) {
        IntPtr credPtr;
        if (!CredRead(target, 1, 0, out credPtr)) return null;
        try {
            CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(credPtr, typeof(CREDENTIAL));
            if (cred.CredentialBlob == IntPtr.Zero || cred.CredentialBlobSize == 0) return "";
            byte[] bytes = new byte[cred.CredentialBlobSize];
            Marshal.Copy(cred.CredentialBlob, bytes, 0, (int)cred.CredentialBlobSize);
            return Encoding.UTF8.GetString(bytes);
        } finally {
            CredFree(credPtr);
        }
    }

    public static bool Write(string target, string user, string secret) {
        byte[] bytes = Encoding.UTF8.GetBytes(secret);
        CREDENTIAL cred = new CREDENTIAL();
        cred.Flags = 0;
        cred.Type = 1;
        cred.TargetName = target;
        cred.UserName = user;
        cred.CredentialBlobSize = (uint)bytes.Length;
        cred.CredentialBlob = Marshal.AllocHGlobal(bytes.Length);
        cred.Persist = 2;
        try {
            Marshal.Copy(bytes, 0, cred.CredentialBlob, bytes.Length);
            return CredWrite(ref cred, 0);
        } finally {
            Marshal.FreeHGlobal(cred.CredentialBlob);
        }
    }
}
`;

let cachedWinCred = null;
let cachedWinCredAt = 0;

export function invalidateWinCredCache() {
  cachedWinCred = null;
  cachedWinCredAt = 0;
}

export function readWinCredToken(force = false) {
  if (!force && cachedWinCred && Date.now() - cachedWinCredAt < 300000) {
    return cachedWinCred;
  }
  try {
    const ps = `
      Add-Type -TypeDefinition @'
${WINCRED_CSHARP}
'@
      $val = [WinCred]::Read('gemini:antigravity')
      if ($null -ne $val) { [Console]::Out.Write($val) }
    `;
    const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true
    });
    if (out && out.trim()) {
      cachedWinCred = JSON.parse(out.trim());
      cachedWinCredAt = Date.now();
      return cachedWinCred;
    }
  } catch {}
  return null;
}

export function writeWinCredToken(storedTokenObj) {
  const jsonStr = JSON.stringify(storedTokenObj);
  const b64 = Buffer.from(jsonStr, "utf8").toString("base64");
  const ps = `
    Add-Type -TypeDefinition @'
${WINCRED_CSHARP}
'@
    $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}'))
    $ok = [WinCred]::Write('gemini:antigravity', 'antigravity', $json)
    if (-not $ok) { throw "CredWrite failed" }
  `;
  execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], {
    encoding: "utf8",
    timeout: 6000,
    windowsHide: true
  });
  cachedWinCred = storedTokenObj;
  cachedWinCredAt = Date.now();
  try {
    if (fs.existsSync(JETSKI_TOKEN_FILE)) {
      fs.writeFileSync(JETSKI_TOKEN_FILE, jsonStr, { encoding: "utf8", mode: 0o600 });
    }
  } catch {}
}

export function normalizeIsoExpiry(rawExpiry) {
  if (!rawExpiry) {
    return new Date(Date.now() + 3500 * 1000).toISOString();
  }
  const str = String(rawExpiry).trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(str)) {
    return str;
  }
  const parsed = new Date(str);
  if (!Number.isNaN(parsed.getTime()) && parsed.getTime() > 0) {
    return parsed.toISOString();
  }
  return new Date(Date.now() + 3500 * 1000).toISOString();
}

export function buildCleanChannelToken(baseToken, targetProject = "", targetLocation = "", forceNewWriterId = false) {
  if (!baseToken || typeof baseToken !== "object") return null;
  const cleanPid = String(targetProject || "").trim();
  const cleanLoc = String(targetLocation || "").trim();
  const next = { ...baseToken };
  delete next.id_token;
  if (next.token && typeof next.token === "object") {
    next.token = {
      access_token: String(next.token.access_token || "").trim(),
      token_type: String(next.token.token_type || "Bearer").trim(),
      refresh_token: String(next.token.refresh_token || "").trim(),
      expiry: normalizeIsoExpiry(next.token.expiry)
    };
  }
  if (forceNewWriterId || !next.writer_id) {
    next.writer_id = crypto.randomUUID();
  }
  if (cleanPid) {
    next.auth_method = "gcp";
    next.project_id = cleanPid;
    next.region = cleanLoc;
  } else {
    delete next.auth_method;
    delete next.project_id;
    delete next.region;
  }
  return next;
}

let cachedLsInfo = null;
let cachedLsInfoAt = 0;
let cachedLsInstanceId = "";

export function parseLsLogInfo(customLogFile = "") {
  const ctx = resolveCurrentInstanceContext();
  const targetLogFile = customLogFile || ctx.lsLogFile || LS_LOG_FILE;
  let pid = 0;
  let httpPort = 0;
  let httpsPort = 0;
  let lastProjectId = "";
  let lastLocation = "";
  let lastUserTier = "";
  let enableBusinessLogin = null;
  try {
    if (fs.existsSync(targetLogFile)) {
      const logText = fs.readFileSync(targetLogFile, "utf8");
      const pidMatches = [...logText.matchAll(/Starting language server process with pid (\d+)/gi)];
      let activeSegment = logText;
      if (pidMatches.length > 0) {
        const lastPidMatch = pidMatches[pidMatches.length - 1];
        pid = Number(lastPidMatch[1]);
        if (typeof lastPidMatch.index === "number") {
          activeSegment = logText.slice(lastPidMatch.index);
        }
      }
      const httpsMatches = [...activeSegment.matchAll(/listening on \w+ port at (\d+) for HTTPS/gi)];
      if (httpsMatches.length > 0) {
        httpsPort = Number(httpsMatches[httpsMatches.length - 1][1]);
      }
      const httpMatches = [...activeSegment.matchAll(/listening on \w+ port at (\d+) for HTTP\b/gi)];
      if (httpMatches.length > 0) {
        httpPort = Number(httpMatches[httpMatches.length - 1][1]);
      }
      const projMatches = [...activeSegment.matchAll(/SetProjectID called with projectID:\s*"([^"]*)"/gi)];
      if (projMatches.length > 0) {
        lastProjectId = (projMatches[projMatches.length - 1][1] || "").trim();
      }
      const locMatches = [...activeSegment.matchAll(/SetLocation called with location:\s*"([^"]*)"/gi)];
      if (locMatches.length > 0) {
        lastLocation = (locMatches[locMatches.length - 1][1] || "").trim();
      }
      const tierMatches = [...activeSegment.matchAll(/SetUserTier called with userTier:\s*"([^"]*)"/gi)];
      if (tierMatches.length > 0) {
        lastUserTier = (tierMatches[tierMatches.length - 1][1] || "").trim();
      }
      const bizMatches = [...activeSegment.matchAll(/SetEnableBusinessLogin called with enable:\s*(true|false)/gi)];
      if (bizMatches.length > 0) {
        enableBusinessLogin = bizMatches[bizMatches.length - 1][1].toLowerCase() === "true";
      }
    }
  } catch {}
  return {
    pid,
    httpPort,
    httpsPort,
    lastProjectId,
    lastLocation,
    lastUserTier,
    enableBusinessLogin,
    instanceId: ctx.instanceId,
    isIsolatedInstance: ctx.isIsolatedInstance,
    logFile: targetLogFile
  };
}

let cachedLsProcList = null;
let cachedLsProcListAt = 0;

export function listRunningLanguageServerProcesses(force = false) {
  if (!force && cachedLsProcList && Date.now() - cachedLsProcListAt < 2000) {
    return cachedLsProcList;
  }
  try {
    const psScript = `Get-CimInstance Win32_Process -Filter "Name LIKE 'language_server%'" | Select-Object ProcessId, ParentProcessId, CommandLine | ConvertTo-Json -Compress`;
    const raw = execFileSync("powershell.exe", ["-NoProfile", "-Command", psScript], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true
    }).trim();
    if (!raw) {
      cachedLsProcList = [];
      cachedLsProcListAt = Date.now();
      return [];
    }
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    cachedLsProcList = list
      .filter(Boolean)
      .map((proc) => {
        const cmd = String(proc?.CommandLine || "");
        const csrfMatch = /--csrf_token[=\s]+([0-9a-fA-F-]+)/.exec(cmd);
        return {
          pid: Number(proc?.ProcessId || 0),
          ppid: Number(proc?.ParentProcessId || 0),
          csrf: csrfMatch ? csrfMatch[1] : "",
          commandLine: cmd
        };
      })
      .filter((p) => p.pid > 0);
    cachedLsProcListAt = Date.now();
    return cachedLsProcList;
  } catch {
    return cachedLsProcList || [];
  }
}

export function inspectActiveFieldInstances(cfg = null, currentCtx = null) {
  const config = cfg || readRelayConfig();
  const ctx = currentCtx || resolveCurrentInstanceContext();
  const runningProcs = listRunningLanguageServerProcesses();
  const runningPidSet = new Set(runningProcs.map((p) => p.pid));

  const candidates = [
    {
      instanceId: "main",
      isIsolatedInstance: false,
      userDataDir: path.join(APP_DATA_DIR, "Antigravity"),
      lsLogFile: LS_LOG_FILE
    }
  ];

  const seenIds = new Set(["main"]);
  try {
    if (fs.existsSync(INSTANCES_ROOT_DIR)) {
      for (const dirName of fs.readdirSync(INSTANCES_ROOT_DIR)) {
        if (seenIds.has(dirName)) continue;
        seenIds.add(dirName);
        const fullDir = path.join(INSTANCES_ROOT_DIR, dirName);
        candidates.push({
          instanceId: dirName,
          isIsolatedInstance: true,
          userDataDir: fullDir,
          lsLogFile: path.join(fullDir, "logs", "language_server.log")
        });
      }
    }
  } catch {}

  for (const instKey of Object.keys(config?.__meta__?.instances || {})) {
    if (seenIds.has(instKey)) continue;
    seenIds.add(instKey);
    const fullDir = path.join(INSTANCES_ROOT_DIR, instKey);
    candidates.push({
      instanceId: instKey,
      isIsolatedInstance: instKey !== "main",
      userDataDir: fullDir,
      lsLogFile: path.join(fullDir, "logs", "language_server.log")
    });
  }

  const rawAlive = [];
  for (const cand of candidates) {
    const logInfo = parseLsLogInfo(cand.lsLogFile);
    const instMeta = config?.__meta__?.instances?.[cand.instanceId] || null;
    const desc = cand.isIsolatedInstance ? readInstanceDescriptor(cand.userDataDir) : null;
    const rawPid = Number(logInfo.pid || instMeta?.lsRpcTarget?.pid || 0);
    const launchedAt = Number(instMeta?.seededLaunchAt || desc?.launchedAt || 0);
    const isRecentlyLaunched = Boolean(cand.isIsolatedInstance && launchedAt > 0 && Date.now() - launchedAt < 18000);
    const isCurrent = cand.instanceId === ctx.instanceId;
    const isPidRunning = rawPid > 0 && runningPidSet.has(rawPid);
    const lsPid = isPidRunning ? rawPid : 0;

    if (!isCurrent && !isPidRunning && !isRecentlyLaunched) {
      continue;
    }

    let logMtimeMs = launchedAt;
    try {
      if (fs.existsSync(cand.lsLogFile)) {
        logMtimeMs = Math.max(logMtimeMs, fs.statSync(cand.lsLogFile).mtimeMs);
      }
    } catch {}

    let activeChannelId = String(
      instMeta?.activeChannelId ||
      desc?.activeChannelId ||
      (!cand.isIsolatedInstance ? config?.__meta__?.activeChannelId : "") ||
      ""
    ).trim();
    const accObj = activeChannelId ? config?.accounts?.[activeChannelId] : null;
    const gcpProjectId = String(
      (accObj ? accObj.gcpProjectId : "") ||
      instMeta?.lastAppliedGcpProject ||
      desc?.gcpProjectId ||
      logInfo.lastProjectId ||
      (!cand.isIsolatedInstance ? config?.__meta__?.lastAppliedGcpProject : "") ||
      ""
    ).trim();
    const email = String(
      accObj?.email ||
      instMeta?.activeEmail ||
      desc?.email ||
      (!cand.isIsolatedInstance ? config?.__meta__?.activeEmail : "") ||
      ""
    ).trim();
    const isGcp = Boolean(gcpProjectId || accObj?.channelType === "gcp" || activeChannelId.includes("#gcp:"));
    const channelType = isGcp ? "gcp" : "personal";
    if (!activeChannelId && email) {
      activeChannelId = isGcp ? `${email}#gcp:${gcpProjectId}` : `${email}#personal`;
    }

    rawAlive.push({
      instanceId: cand.instanceId,
      isIsolatedInstance: cand.isIsolatedInstance,
      isCurrent,
      lsPid,
      logMtimeMs,
      channelType,
      activeChannelId,
      email,
      gcpProjectId
    });
  }

  // 按 lsPid 去重（优先保留当前窗口或日志更新时间最新的实例）
  const dedupedByPid = new Map();
  const activeInstances = [];
  for (const item of rawAlive) {
    if (item.lsPid > 0) {
      const prev = dedupedByPid.get(item.lsPid);
      if (!prev) {
        dedupedByPid.set(item.lsPid, item);
      } else if (item.isCurrent || (!prev.isCurrent && item.logMtimeMs > prev.logMtimeMs)) {
        dedupedByPid.set(item.lsPid, item);
      }
    } else {
      activeInstances.push(item);
    }
  }
  for (const item of dedupedByPid.values()) {
    activeInstances.push(item);
  }

  const currentInst = activeInstances.find((x) => x.isCurrent) || {
    instanceId: ctx.instanceId,
    isIsolatedInstance: ctx.isIsolatedInstance,
    isCurrent: true,
    lsPid: 0,
    channelType: "personal",
    activeChannelId: "",
    email: "",
    gcpProjectId: ""
  };
  const otherInstances = activeInstances.filter((x) => !x.isCurrent);
  const otherPersonalInstance = otherInstances.find((x) => x.channelType === "personal") || null;
  const otherGcpInstance = otherInstances.find((x) => x.channelType === "gcp") || null;
  const personalInstance = activeInstances.find((x) => x.channelType === "personal") || null;
  const gcpInstance = activeInstances.find((x) => x.channelType === "gcp") || null;
  const bothChannelsOpen = Boolean(
    personalInstance &&
    gcpInstance &&
    personalInstance.instanceId !== gcpInstance.instanceId
  );
  const crossChannelLocked = Boolean(
    (currentInst.channelType === "personal" && otherGcpInstance) ||
    (currentInst.channelType === "gcp" && otherPersonalInstance) ||
    bothChannelsOpen
  );
  const multiLaunchLocked = Boolean(bothChannelsOpen || otherInstances.length > 0);

  return {
    currentInstanceId: ctx.instanceId,
    isIsolatedInstance: ctx.isIsolatedInstance,
    currentChannelType: currentInst.channelType,
    activeInstances: activeInstances.map(({ logMtimeMs, ...rest }) => rest),
    otherPersonalInstance: otherPersonalInstance
      ? {
          instanceId: otherPersonalInstance.instanceId,
          activeChannelId: otherPersonalInstance.activeChannelId,
          email: otherPersonalInstance.email
        }
      : null,
    otherGcpInstance: otherGcpInstance
      ? {
          instanceId: otherGcpInstance.instanceId,
          activeChannelId: otherGcpInstance.activeChannelId,
          email: otherGcpInstance.email,
          gcpProjectId: otherGcpInstance.gcpProjectId
        }
      : null,
    bothChannelsOpen,
    crossChannelLocked,
    multiLaunchLocked
  };
}

export function discoverLanguageServer(force = false) {
  const ctx = resolveCurrentInstanceContext(force);
  if (
    !force &&
    cachedLsInfo &&
    cachedLsInfo.port > 0 &&
    cachedLsInstanceId === ctx.instanceId &&
    Date.now() - cachedLsInfoAt < 4000
  ) {
    return cachedLsInfo;
  }

  const logInfo = parseLsLogInfo(ctx.lsLogFile);
  const envAddr = process.env.ANTIGRAVITY_LS_ADDRESS || "";
  const envCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN || "";

  if (!force && envCsrf && (logInfo.httpPort > 0 || logInfo.httpsPort > 0 || envAddr)) {
    const [hostname, portStr] = envAddr ? envAddr.split(":") : ["127.0.0.1", "0"];
    const envPort = Number(portStr || 0);
    const primaryPort = logInfo.httpPort || envPort || logInfo.httpsPort;
    const primaryProto = primaryPort === logInfo.httpsPort && !logInfo.httpPort && !envPort ? "https" : "http";
    if (primaryPort > 0) {
      cachedLsInfo = {
        pid: logInfo.pid || 0,
        hostname: hostname || "127.0.0.1",
        port: primaryPort,
        protocol: primaryProto,
        altPort: logInfo.httpsPort || logInfo.httpPort || 0,
        altProtocol: logInfo.httpsPort ? "https" : "http",
        csrf: envCsrf,
        instanceId: ctx.instanceId
      };
      cachedLsInstanceId = ctx.instanceId;
      cachedLsInfoAt = Date.now();
      return cachedLsInfo;
    }
  }

  let cimPid = 0;
  let cimCsrf = "";
  const procList = listRunningLanguageServerProcesses();
  if (procList.length > 0) {
    let matchedProc = null;
    if (logInfo.pid > 0) {
      matchedProc = procList.find((p) => p.pid === logInfo.pid) || null;
    }
    if (!matchedProc && process.ppid > 0) {
      matchedProc = procList.find((p) => p.pid === Number(process.ppid)) || null;
    }
    if (!matchedProc && ctx.userDataDir) {
      const normDir = ctx.userDataDir.toLowerCase();
      matchedProc = procList.find((p) => p.commandLine.toLowerCase().includes(normDir)) || null;
    }
    if (!matchedProc && !ctx.isIsolatedInstance) {
      matchedProc = procList[0];
    }
    if (matchedProc) {
      cimPid = matchedProc.pid;
      cimCsrf = matchedProc.csrf;
    }
  }

  let savedTarget = null;
  try {
    const cfg = readRelayConfig();
    const instMeta = getInstanceMeta(cfg, ctx);
    savedTarget = instMeta?.lsRpcTarget || (!ctx.isIsolatedInstance ? cfg?.__meta__?.lsRpcTarget : null) || null;
  } catch {}

  const finalCsrf = cimCsrf || envCsrf || savedTarget?.csrf || "";
  const finalPid = logInfo.pid || cimPid || 0;
  const envPort = envAddr ? Number(envAddr.split(":")[1] || 0) : 0;
  const primaryPort = logInfo.httpPort || logInfo.httpsPort || envPort || Number(savedTarget?.port || 0);
  const primaryProto = primaryPort === logInfo.httpsPort && primaryPort !== logInfo.httpPort
    ? "https"
    : (savedTarget?.protocol || "http");

  if (primaryPort > 0 && finalCsrf) {
    cachedLsInfo = {
      pid: finalPid,
      hostname: "127.0.0.1",
      port: primaryPort,
      protocol: primaryProto,
      altPort: logInfo.httpsPort && logInfo.httpsPort !== primaryPort ? logInfo.httpsPort : (logInfo.httpPort || 0),
      altProtocol: logInfo.httpsPort && logInfo.httpsPort !== primaryPort ? "https" : "http",
      csrf: finalCsrf,
      instanceId: ctx.instanceId
    };
    cachedLsInstanceId = ctx.instanceId;
    cachedLsInfoAt = Date.now();
    return cachedLsInfo;
  }

  return cachedLsInfo;
}

function sendSingleLsRpc({ hostname, port, protocol, csrf }, method, payload) {
  return new Promise((resolve, reject) => {
    const transport = protocol === "https" ? https : http;
    const opts = {
      hostname: hostname || "127.0.0.1",
      port: Number(port),
      path: `/exa.language_server_pb.LanguageServerService/${method}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        "x-codeium-csrf-token": csrf,
        "Content-Length": payload.length
      },
      timeout: 3000
    };
    if (protocol === "https") {
      opts.rejectUnauthorized = false;
    }
    const req = transport.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode !== 200) {
          return reject(new Error(`RPC ${method} HTTP ${res.statusCode}: ${text}`));
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          resolve(text);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`RPC ${method} timeout`));
    });
    req.write(payload);
    req.end();
  });
}

export async function callLsRpc(ls, method, body = {}) {
  if (!ls || !ls.port || !ls.csrf) {
    throw new Error("Language Server 未连接");
  }
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  const primaryProto = ls.protocol || "http";
  try {
    return await sendSingleLsRpc(
      { hostname: ls.hostname, port: ls.port, protocol: primaryProto, csrf: ls.csrf },
      method,
      payload
    );
  } catch {
    const fallbackPort = ls.altPort && ls.altPort !== ls.port ? ls.altPort : ls.port;
    const fallbackProto = ls.altPort && ls.altPort !== ls.port
      ? (ls.altProtocol || (primaryProto === "http" ? "https" : "http"))
      : (primaryProto === "http" ? "https" : "http");
    const res = await sendSingleLsRpc(
      { hostname: ls.hostname, port: fallbackPort, protocol: fallbackProto, csrf: ls.csrf },
      method,
      payload
    );
    ls.port = fallbackPort;
    ls.protocol = fallbackProto;
    return res;
  }
}

function refreshOAuthAccessTokenWithClient(refreshToken, clientId, clientSecret) {
  return new Promise((resolve, reject) => {
    if (!refreshToken) return reject(new Error("Missing refresh_token"));
    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
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
        },
        timeout: 4500
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) {
            return reject(new Error(`Refresh token HTTP ${res.statusCode}`));
          }
          try {
            resolve(JSON.parse(text));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Refresh token timeout"));
    });
    req.write(body);
    req.end();
  });
}

export async function refreshOAuthAccessToken(refreshToken) {
  if (!refreshToken) throw new Error("Missing refresh_token");
  let lastErr = null;
  const clients = loadOAuthClients();
  for (const c of clients) {
    try {
      return await refreshOAuthAccessTokenWithClient(refreshToken, c.clientId, c.clientSecret);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("Refresh token failed across all OAuth clients");
}

export function scheduleDetachedLanguageServerRestart(
  tokenToLock = null,
  activeLsHint = null,
  isGcpTarget = false,
  proxyUrlHint = ""
) {
  const activeLs = activeLsHint || discoverLanguageServer(false);
  invalidateWinCredCache();

  try {
    if (tokenToLock) {
      writeWinCredToken(tokenToLock);
    }
    if (activeLs) {
      const sidecarPort = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || 0);
      const ownSidecarUrl = (sidecarPort > 1024 && sidecarPort !== 8089) ? `http://127.0.0.1:${sidecarPort}` : "";
      const savedProxy = ownSidecarUrl || proxyUrlHint || globalThis.__agyCloudCodeProxyUrl || "http://127.0.0.1:8091";
      const targetUrl = isGcpTarget ? "https://daily-cloudcode-pa.googleapis.com" : savedProxy;
      if (!isGcpTarget) {
        callLsRpc(activeLs, "ValidateProject", { projectId: "", location: "" }).catch(() => {});
      }
      callLsRpc(activeLs, "SetCloudCodeURL", { url: targetUrl }).catch(() => {});
      setTimeout(() => {
        if (tokenToLock) writeWinCredToken(tokenToLock);
        callLsRpc(activeLs, "GetUserStatus", {}).catch(() => {});
      }, 350);
      setTimeout(() => {
        callLsRpc(activeLs, "GetUserStatus", {}).catch(() => {});
      }, 1500);
    }
  } catch {}
}
