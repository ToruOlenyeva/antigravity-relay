import https from "node:https";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { execFileSync, spawn } from "node:child_process";
import {
  LS_LOG_FILE,
  JETSKI_TOKEN_FILE,
  readRelayConfig,
  writeRelayConfig
} from "./store.mjs";

function loadOAuthClients() {
  try {
    const cfg = readRelayConfig();
    if (Array.isArray(cfg?.__meta__?.oauthClients) && cfg.__meta__.oauthClients.length > 0) {
      return cfg.__meta__.oauthClients;
    }
  } catch {}
  if (process.env.AGY_OAUTH_CLIENT_ID && process.env.AGY_OAUTH_CLIENT_SECRET) {
    return [{ clientId: process.env.AGY_OAUTH_CLIENT_ID, clientSecret: process.env.AGY_OAUTH_CLIENT_SECRET }];
  }
  return [{ clientId: "", clientSecret: "" }];
}
const AGY_OAUTH_CLIENTS = loadOAuthClients();
const AGY_OAUTH_CLIENT_ID = AGY_OAUTH_CLIENTS[0]?.clientId || "";
const AGY_OAUTH_CLIENT_SECRET = AGY_OAUTH_CLIENTS[0]?.clientSecret || "";
const AGY_PRO_TIER_HEADER_B64 = Buffer.from("\x0a\x18AGY_LLM_GATEWAY_TIER_PRO").toString("base64");
const AGY_OAUTH_SCOPES = [
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
const AGY_AUTH_SUCCESS_URL = "https://antigravity.google/auth-success?app=antigravity";

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
  } catch (e) {}
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
  } catch (e) {}
}

let cachedLsInfo = null;
let cachedLsInfoAt = 0;

function parseLsLogInfo() {
  let pid = 0;
  let httpPort = 0;
  let httpsPort = 0;
  let lastProjectId = "";
  let lastLocation = "";
  let lastUserTier = "";
  let enableBusinessLogin = null;
  try {
    if (fs.existsSync(LS_LOG_FILE)) {
      const logText = fs.readFileSync(LS_LOG_FILE, "utf8");
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
  } catch (e) {}
  return { pid, httpPort, httpsPort, lastProjectId, lastLocation, lastUserTier, enableBusinessLogin };
}

export function discoverLanguageServer(force = false) {
  if (!force && cachedLsInfo && cachedLsInfo.port > 0 && Date.now() - cachedLsInfoAt < 4000) {
    return cachedLsInfo;
  }

  const logInfo = parseLsLogInfo();
  const envAddr = process.env.ANTIGRAVITY_LS_ADDRESS || "";
  const envCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN || "";

  // 优先级 1：结合 language_server.log 最新端口/PID 与宿主注入的 CSRF (0ms 免子进程)
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
        csrf: envCsrf
      };
      cachedLsInfoAt = Date.now();
      return cachedLsInfo;
    }
  }

  // 优先级 2：扫描 language_server 进程命令行与日志端口
  let cimPid = 0;
  let cimCsrf = "";
  try {
    const psScript = `Get-CimInstance Win32_Process -Filter "Name LIKE 'language_server%'" | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress`;
    const raw = execFileSync("powershell.exe", ["-NoProfile", "-Command", psScript], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true
    }).trim();

    if (raw) {
      const list = JSON.parse(raw);
      const proc = Array.isArray(list) ? list[0] : list;
      const cmd = proc?.CommandLine || "";
      const csrfMatch = /--csrf_token[=\s]+([0-9a-fA-F-]+)/.exec(cmd);
      cimCsrf = csrfMatch ? csrfMatch[1] : "";
      cimPid = Number(proc?.ProcessId || 0);
    }
  } catch (e) {}

  let savedTarget = null;
  try {
    const cfg = readRelayConfig();
    savedTarget = cfg?.__meta__?.lsRpcTarget || null;
  } catch (e) {}

  const finalCsrf = cimCsrf || envCsrf || savedTarget?.csrf || "";
  const finalPid = cimPid || logInfo.pid || 0;
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
      csrf: finalCsrf
    };
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
  } catch (primaryErr) {
    // 自动尝试备用端口或翻转 HTTP/HTTPS 协议重试
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

const AGENT_PLATFORM_DEFAULT_MODELS = [
  {
    label: "Gemini 4 Argon",
    modelId: "Gemini 4 Argon",
    variantIds: [
      "Gemini 4 Argon",
      "Gemini 4 Argon (Medium)",
      "MODEL_PLACEHOLDER_M418",
      "Gemini 4 Argon (High)",
      "MODEL_PLACEHOLDER_M417",
      "Gemini 4 Argon (Low)",
      "MODEL_PLACEHOLDER_M419"
    ],
    remainingPct: 100,
    resetTime: "",
    unlimited: true
  },
  {
    label: "Gemini 3.8 Flash",
    modelId: "Gemini 3.8 Flash",
    variantIds: [
      "Gemini 3.8 Flash",
      "Gemini 3.8 Flash (Medium)",
      "MODEL_PLACEHOLDER_M421",
      "Gemini 3.8 Flash (High)",
      "MODEL_PLACEHOLDER_M420",
      "Gemini 3.8 Flash (Low)",
      "MODEL_PLACEHOLDER_M422"
    ],
    remainingPct: 100,
    resetTime: "",
    unlimited: true
  },
  {
    label: "Gemini 3.7 Flash",
    modelId: "Gemini 3.7 Flash",
    variantIds: [
      "Gemini 3.7 Flash",
      "Gemini 3.7 Flash (Medium)",
      "MODEL_PLACEHOLDER_M62",
      "Gemini 3.7 Flash (High)",
      "MODEL_PLACEHOLDER_M55",
      "Gemini 3.7 Flash (Low)",
      "MODEL_PLACEHOLDER_M63"
    ],
    remainingPct: 100,
    resetTime: "",
    unlimited: true
  },
  {
    label: "Gemini 3.6 Flash",
    modelId: "Gemini 3.6 Flash",
    variantIds: [
      "Gemini 3.6 Flash",
      "Gemini 3.6 Flash (Medium)",
      "MODEL_PLACEHOLDER_M60",
      "Gemini 3.6 Flash (High)",
      "MODEL_PLACEHOLDER_M51",
      "Gemini 3.6 Flash (Low)",
      "MODEL_PLACEHOLDER_M61"
    ],
    remainingPct: 100,
    resetTime: "",
    unlimited: true
  },
  {
    label: "Gemini 3.1 Pro",
    modelId: "Gemini 3.1 Pro",
    variantIds: [
      "Gemini 3.1 Pro",
      "Gemini 3.1 Pro (High)",
      "MODEL_PLACEHOLDER_M37",
      "Gemini 3.1 Pro (Low)",
      "MODEL_PLACEHOLDER_M36"
    ],
    remainingPct: 100,
    resetTime: "",
    unlimited: true
  },
  {
    label: "Claude Opus 5.5",
    modelId: "Claude Opus 5.5",
    variantIds: [
      "Claude Opus 5.5",
      "Claude Opus 5.5 (Low)",
      "MODEL_PLACEHOLDER_M409",
      "Claude Opus 5.5 (Medium)",
      "MODEL_PLACEHOLDER_M410",
      "Claude Opus 5.5 (High)",
      "MODEL_PLACEHOLDER_M411",
      "Claude Opus 5.5 (Max)",
      "MODEL_PLACEHOLDER_M412"
    ],
    remainingPct: 100,
    resetTime: "",
    unlimited: true
  },
  {
    label: "Claude Sonnet 5.5",
    modelId: "Claude Sonnet 5.5",
    variantIds: [
      "Claude Sonnet 5.5",
      "Claude Sonnet 5.5 (Low)",
      "MODEL_PLACEHOLDER_M413",
      "Claude Sonnet 5.5 (Medium)",
      "MODEL_PLACEHOLDER_M414",
      "Claude Sonnet 5.5 (High)",
      "MODEL_PLACEHOLDER_M415",
      "Claude Sonnet 5.5 (Max)",
      "MODEL_PLACEHOLDER_M416"
    ],
    remainingPct: 100,
    resetTime: "",
    unlimited: true
  }
];

const GOOGLE_AI_PRO_DEFAULT_MODELS = [
  {
    label: "Gemini 4 Argon",
    modelId: "Gemini 4 Argon",
    variantIds: [
      "Gemini 4 Argon",
      "Gemini 4 Argon (Medium)",
      "gemini-4-argon-medium",
      "MODEL_PLACEHOLDER_M418",
      "Gemini 4 Argon (High)",
      "gemini-4-argon-high",
      "MODEL_PLACEHOLDER_M417",
      "Gemini 4 Argon (Low)",
      "gemini-4-argon-low",
      "MODEL_PLACEHOLDER_M419"
    ],
    remainingPct: 100,
    resetTime: "",
    unlimited: false
  },
  {
    label: "Gemini 3.8 Flash",
    modelId: "Gemini 3.8 Flash",
    variantIds: [
      "Gemini 3.8 Flash",
      "Gemini 3.8 Flash (High)",
      "gemini-3.8-flash-high",
      "MODEL_PLACEHOLDER_M420",
      "Gemini 3.8 Flash (Medium)",
      "gemini-3.8-flash-medium",
      "MODEL_PLACEHOLDER_M421",
      "Gemini 3.8 Flash (Low)",
      "gemini-3.8-flash-low",
      "MODEL_PLACEHOLDER_M422"
    ],
    remainingPct: 100,
    resetTime: "",
    unlimited: false
  },
  {
    label: "Claude Opus 5.5",
    modelId: "Claude Opus 5.5",
    variantIds: [
      "Claude Opus 5.5",
      "Claude Opus 5.5 (Low)",
      "claude-opus-5-5-low",
      "MODEL_PLACEHOLDER_M409",
      "Claude Opus 5.5 (Medium)",
      "claude-opus-5-5-medium",
      "MODEL_PLACEHOLDER_M410",
      "Claude Opus 5.5 (High)",
      "claude-opus-5-5-high",
      "MODEL_PLACEHOLDER_M411"
    ],
    remainingPct: 100,
    resetTime: "",
    unlimited: false
  },
  {
    label: "Claude Sonnet 5.5",
    modelId: "Claude Sonnet 5.5",
    variantIds: [
      "Claude Sonnet 5.5",
      "Claude Sonnet 5.5 (Low)",
      "claude-sonnet-5-5-low",
      "MODEL_PLACEHOLDER_M413",
      "Claude Sonnet 5.5 (Medium)",
      "claude-sonnet-5-5-medium",
      "MODEL_PLACEHOLDER_M414",
      "Claude Sonnet 5.5 (High)",
      "claude-sonnet-5-5-high",
      "MODEL_PLACEHOLDER_M415"
    ],
    remainingPct: 100,
    resetTime: "",
    unlimited: false
  }
];

function isLegacyDeprecatedModel(labelOrId) {
  const s = String(labelOrId || "").trim();
  return (
    /4[-_.\s]*6|2[-_.\s]*5|gemini[\s-]*3(?:\.0)?[\s-]*flash\b|gemini[\s-]*3\.5[\s-]*flash[\s-]*lite|gemini[\s-]*3\.1[\s-]*flash|gpt-oss|chat_|tab_/i.test(s) ||
    /^(gemini\s*(flash|pro)|claude\s*(opus|sonnet)|gpt-oss)$/i.test(s)
  );
}

function isModelEntryRestrictedOrSunset(m) {
  if (!m || typeof m !== "object") return true;
  if (m.disabled === true || m.isUnavailable === true || m.unavailable === true) return true;
  const tagTitle = String(m.tagTitle || m.tag || "").trim();
  const tagDesc = String(m.tagDescription || m.notice || m.description || "").trim();
  if (/^unavailable|deprecated$/i.test(tagTitle)) return true;
  if (/will be removed|no longer be available|available to Ultra and paid Pro|now available on paid Pro and Ultra/i.test(tagDesc)) {
    return true;
  }
  return false;
}

function detectArgonAccessFromModels(rawModelsListOrMap, tierCode = "Pro", prevHasArgon = undefined) {
  if (tierCode === "Free" || tierCode === "Plus") return false;
  if (!Array.isArray(rawModelsListOrMap) && rawModelsListOrMap && typeof rawModelsListOrMap === "object") {
    if (Object.prototype.hasOwnProperty.call(rawModelsListOrMap, "gemini-4-argon-disabled")) {
      return false;
    }
  }
  const entries = Array.isArray(rawModelsListOrMap)
    ? rawModelsListOrMap
    : Object.values(rawModelsListOrMap || {});
  if (entries.length === 0) {
    return prevHasArgon !== undefined ? Boolean(prevHasArgon) : (tierCode === "Ultra" || tierCode === "Pro");
  }
  let sawArgonEnabled = false;
  let sawArgonRestricted = false;
  for (const m of entries) {
    if (!m || typeof m !== "object") continue;
    const lbl = String(m.displayName || m.label || m.modelId || "").trim();
    const id = String(m.modelOrAlias?.model || m.modelOrAlias?.alias || m.model || "").trim();
    const tagDesc = String(m.tagDescription || m.notice || "").trim();
    if (/argon|m417|m418|m419/i.test(lbl) || /argon|m417|m418|m419/i.test(id)) {
      if (isModelEntryRestrictedOrSunset(m) || /now available on paid Pro and Ultra|available to Ultra and paid Pro/i.test(tagDesc)) {
        sawArgonRestricted = true;
      } else {
        sawArgonEnabled = true;
      }
    }
  }
  if (sawArgonRestricted) return false;
  if (sawArgonEnabled) return true;
  if (prevHasArgon !== undefined) return Boolean(prevHasArgon);
  return false;
}

export function detectPersonalAccountTier(
  rawModelsListOrMap,
  rawTierName = "",
  rawTierId = "",
  prevHasArgon = undefined,
  prevTierCode = ""
) {
  const combinedTier = `${rawTierName || ""} ${rawTierId || ""}`.trim();
  let tierCode = "";
  let tierName = "";

  // 严格按照 Google 官方返回的 userTier (paidTier / currentTier) 判定会员等级徽章 (Ultra / Pro / Plus / Free)
  if (/ultra|g1-ultra/i.test(combinedTier)) {
    tierCode = "Ultra";
    tierName = "Google AI Ultra";
  } else if (/\bpro\b|g1-pro/i.test(combinedTier)) {
    tierCode = "Pro";
    tierName = "Google AI Pro";
  } else if (/\bplus\b|g1-plus/i.test(combinedTier)) {
    tierCode = "Plus";
    tierName = "Google AI Plus";
  } else if (/\bfree\b|standard-tier|free-tier/i.test(combinedTier)) {
    tierCode = "Free";
    tierName = "Google AI Free";
  } else if (prevTierCode && /^(Ultra|Pro|Plus|Free)$/i.test(prevTierCode)) {
    const norm = prevTierCode.charAt(0).toUpperCase() + prevTierCode.slice(1).toLowerCase();
    tierCode = norm;
    tierName = `Google AI ${norm}`;
  } else {
    tierCode = "Pro";
    tierName = "Google AI Pro";
  }

  const hasArgonAccess = detectArgonAccessFromModels(rawModelsListOrMap, tierCode, prevHasArgon);
  return {
    tierCode,
    tierName,
    hasArgonAccess,
    isPaidProOrUltra: tierCode === "Ultra" || tierCode === "Pro"
  };
}

function buildProModelsFromQuotaGroups(
  quotaGroups,
  prevModels = [],
  dynamicApiModels = [],
  liveTierTemplate = [],
  hasArgonAccess = true
) {
  const groups = Array.isArray(quotaGroups) ? quotaGroups : [];
  const geminiGroup = groups.find((g) => /gemini\s*models/i.test(g.id || g.displayName || ""));
  const claudeGroup = groups.find((g) => /claude|gpt/i.test(g.id || g.displayName || ""));
  const argonGroup = groups.find((g) => /argon/i.test(g.id || g.displayName || ""));

  const extractGroupDualBuckets = (grp) => {
    const bks = grp?.buckets || [];
    const b5h = bks.find((b) => /5h/i.test(b.window || b.bucketId || ""));
    const bWk = bks.find((b) => /weekly|7d/i.test(b.window || b.bucketId || ""));
    const primary = (b5h && bWk)
      ? ((bWk.remainingPct ?? 100) <= 5 ? bWk : b5h)
      : (b5h || bWk || bks[0] || null);
    return {
      primary,
      weeklyBucket: bWk || primary,
      fiveHourBucket: b5h || bWk || primary
    };
  };

  const matchGroupInfoForModel = (label) => {
    const clean = String(label || "").trim().toLowerCase();
    if (!clean) return null;
    for (const g of groups) {
      const desc = String(g.description || "").toLowerCase();
      const gName = String(g.displayName || g.id || "").toLowerCase();
      if (desc.includes(clean) || gName === clean) {
        return extractGroupDualBuckets(g);
      }
    }
    if (/argon/i.test(clean)) return extractGroupDualBuckets(argonGroup);
    if (/gemini/i.test(clean)) return extractGroupDualBuckets(geminiGroup);
    if (/claude|gpt/i.test(clean)) return extractGroupDualBuckets(claudeGroup);
    return null;
  };

  const mergedTemplateMap = new Map();
  const upsertCandidate = (item) => {
    if (!item) return;
    const rawLabel = String(item.label || item.modelId || "").trim();
    if (!rawLabel) return;
    const baseLabel = rawLabel.replace(/\s*\((Low|Medium|High|Max)\)\s*$/i, "").trim();
    if (!baseLabel || isLegacyDeprecatedModel(baseLabel) || isLegacyDeprecatedModel(rawLabel)) return;
    if (!hasArgonAccess && /argon/i.test(baseLabel)) return;
    const vars = (Array.isArray(item.variantIds) ? item.variantIds : [baseLabel, rawLabel]).filter(
      (v) => v && !isLegacyDeprecatedModel(v)
    );
    if (!mergedTemplateMap.has(baseLabel)) {
      mergedTemplateMap.set(baseLabel, {
        label: baseLabel,
        modelId: baseLabel,
        variantIds: Array.from(new Set([baseLabel, ...vars])),
        remainingPct: item.remainingPct,
        resetTime: item.resetTime || "",
        weeklyPct: item.weeklyPct,
        weeklyResetTime: item.weeklyResetTime || "",
        fiveHourPct: item.fiveHourPct,
        fiveHourResetTime: item.fiveHourResetTime || ""
      });
    } else {
      const existing = mergedTemplateMap.get(baseLabel);
      for (const v of vars) {
        if (!existing.variantIds.includes(v)) existing.variantIds.push(v);
      }
      if (existing.remainingPct === undefined && item.remainingPct !== undefined) {
        existing.remainingPct = item.remainingPct;
      }
      if (!existing.resetTime && item.resetTime) {
        existing.resetTime = item.resetTime;
      }
    }
  };

  for (const m of (Array.isArray(dynamicApiModels) ? dynamicApiModels : [])) upsertCandidate(m);
  for (const m of (Array.isArray(liveTierTemplate) ? liveTierTemplate : [])) upsertCandidate(m);
  for (const m of GOOGLE_AI_PRO_DEFAULT_MODELS) upsertCandidate(m);
  for (const m of (Array.isArray(prevModels) ? prevModels : [])) upsertCandidate(m);

  return Array.from(mergedTemplateMap.values()).map((tpl) => {
    const grpInfo = matchGroupInfoForModel(tpl.label);
    const matchedBk = grpInfo?.primary || null;
    const wkBk = grpInfo?.weeklyBucket || null;
    const fhBk = grpInfo?.fiveHourBucket || null;
    const prevMatch = (prevModels || []).find(
      (p) => String(p.label || p.modelId || "").toLowerCase() === tpl.label.toLowerCase()
    );
    const pct = matchedBk?.remainingPct ?? tpl.remainingPct ?? prevMatch?.remainingPct ?? 100;
    const rst = matchedBk?.resetTime || tpl.resetTime || prevMatch?.resetTime || "";
    const weeklyPct = wkBk?.remainingPct ?? tpl.weeklyPct ?? prevMatch?.weeklyPct ?? pct;
    const weeklyResetTime = wkBk?.resetTime || tpl.weeklyResetTime || prevMatch?.weeklyResetTime || rst;
    const fiveHourPct = fhBk?.remainingPct ?? tpl.fiveHourPct ?? prevMatch?.fiveHourPct ?? pct;
    const fiveHourResetTime = fhBk?.resetTime || tpl.fiveHourResetTime || prevMatch?.fiveHourResetTime || rst;

    return {
      label: tpl.label,
      modelId: tpl.modelId,
      variantIds: [...tpl.variantIds],
      remainingPct: pct,
      resetTime: rst,
      weeklyPct,
      weeklyResetTime,
      fiveHourPct,
      fiveHourResetTime,
      unlimited: false
    };
  });
}

function isValidOfficialQuotaGroup(g) {
  if (!g || typeof g !== "object") return false;
  const gName = String(g.displayName || g.id || g.groupId || "").trim();
  if (/^all\s*models$/i.test(gName)) return false;
  const bks = Array.isArray(g.buckets) ? g.buckets : [];
  if (bks.length === 0 || bks.length > 3) return false;
  if (bks.some((b) => b.bucketId === "argon-weekly")) return false;
  return true;
}

function normalizeIsoExpiry(rawExpiry) {
  if (!rawExpiry) {
    return new Date(Date.now() + 3500 * 1000).toISOString();
  }
  const str = String(rawExpiry).trim();
  // 若原本已是合法 RFC3339 / ISO 格式则直接保留
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(str)) {
    return str;
  }
  const parsed = new Date(str);
  if (!Number.isNaN(parsed.getTime()) && parsed.getTime() > 0) {
    return parsed.toISOString();
  }
  return new Date(Date.now() + 3500 * 1000).toISOString();
}

function buildCleanChannelToken(baseToken, targetProject = "", targetLocation = "") {
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
  if (!next.writer_id) {
    next.writer_id = cachedWinCred?.writer_id || "iHdmCYy1qVTj84_gl_aPUA";
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

function sanitizeCachedQuotaModels(cachedQuota, isGcp, liveTierTemplate = [], hintTierName = "", hintTierId = "") {
  if (!cachedQuota || typeof cachedQuota !== "object") return cachedQuota;
  const rawList = Array.isArray(cachedQuota.availableModels) ? cachedQuota.availableModels : [];
  const tierInfo = isGcp
    ? { tierCode: "GCP", tierName: hintTierName || "Agent Platform", hasArgonAccess: true, isPaidProOrUltra: false }
    : detectPersonalAccountTier(
        rawList,
        cachedQuota.tierName || hintTierName || "",
        hintTierId || cachedQuota.tierCode || "",
        cachedQuota.hasArgonAccess,
        cachedQuota.tierCode || hintTierId || ""
      );
  const hasArgonAccess = tierInfo.hasArgonAccess;
  const isPaidProOrUltra = tierInfo.isPaidProOrUltra;
  const merged = new Map();
  for (const m of rawList) {
    const rawLabel = String(m.label || m.modelId || "").trim();
    if (!rawLabel) continue;
    const baseLabel = rawLabel.replace(/\s*\((Low|Medium|High|Max)\)\s*$/i, "").trim();
    if (isLegacyDeprecatedModel(baseLabel) || isLegacyDeprecatedModel(rawLabel)) {
      continue;
    }
    if (!isGcp && !hasArgonAccess && /argon/i.test(baseLabel)) {
      continue;
    }
    const vars = (Array.isArray(m.variantIds) ? m.variantIds : [baseLabel, rawLabel]).filter(
      (v) => !isLegacyDeprecatedModel(v)
    );
    if (!merged.has(baseLabel)) {
      merged.set(baseLabel, {
        ...m,
        label: baseLabel,
        modelId: baseLabel,
        variantIds: Array.from(new Set([baseLabel, rawLabel, ...vars])),
        remainingPct: isGcp ? 100 : (m.remainingPct ?? 100),
        resetTime: isGcp ? "" : (m.resetTime || ""),
        unlimited: isGcp ? true : Boolean(m.unlimited)
      });
    } else {
      const entry = merged.get(baseLabel);
      for (const v of [rawLabel, ...vars]) {
        if (v && !entry.variantIds.includes(v)) entry.variantIds.push(v);
      }
    }
  }

  let quotaGroups = isGcp ? [] : (Array.isArray(cachedQuota.quotaGroups) ? [...cachedQuota.quotaGroups] : []);
  let availableModels = Array.from(merged.values());

  if (!isGcp) {
    quotaGroups = quotaGroups.filter(
      (g) =>
        isValidOfficialQuotaGroup(g) &&
        (hasArgonAccess || !/argon/i.test(g.id || g.displayName || ""))
    );
    if (quotaGroups.length > 0 && tierInfo.tierCode !== "Free") {
      availableModels = buildProModelsFromQuotaGroups(
        quotaGroups,
        availableModels,
        availableModels,
        liveTierTemplate,
        hasArgonAccess
      );
    }
  }

  return {
    ...cachedQuota,
    tierCode: tierInfo.tierCode,
    tierName: tierInfo.tierName,
    hasArgonAccess,
    isPaidProOrUltra,
    isGcpUnlimited: isGcp ? true : Boolean(cachedQuota.isGcpUnlimited),
    quotaGroups,
    availableModels
  };
}

function normalizeAccountChannels(cfg) {
  if (!cfg.accounts || typeof cfg.accounts !== "object") cfg.accounts = {};
  if (!Array.isArray(cfg.gcpProjects)) cfg.gcpProjects = [];
  const nextAccounts = {};

  // 预扫描哪些邮箱已存在独立 GCP 通道
  const emailsWithGcp = new Set();
  for (const [k, v] of Object.entries(cfg.accounts)) {
    if (!v || typeof v !== "object") continue;
    const em = (v.email || v.storedToken?.id_token_email || k.split("#")[0] || "").trim();
    if (em && (k.includes("#gcp:") || v.channelType === "gcp" || v.gcpProjectId)) {
      emailsWithGcp.add(em);
    }
  }

  for (const [key, item] of Object.entries(cfg.accounts)) {
    if (!item || typeof item !== "object") continue;
    const email = (item.email || item.storedToken?.id_token_email || key.split("#")[0] || "").trim();
    if (!email) continue;

    if (key.includes("#personal") || key.includes("#gcp:")) {
      const isGcp = key.includes("#gcp:") || item.channelType === "gcp" || Boolean(item.gcpProjectId);
      const pid = isGcp ? (item.gcpProjectId || key.split("#gcp:")[1] || "").trim() : "";

      const normKey = isGcp && pid ? `${email}#gcp:${pid}` : `${email}#personal`;
      const gcpBillingMode = isGcp && pid
        ? (item.gcpBillingMode === "gemini_enterprise" ? "gemini_enterprise" : "agent_platform")
        : "";
      const gcpLocation = isGcp && pid
        ? (["global", "us", "eu"].includes(item.gcpLocation) ? item.gcpLocation : "global")
        : "";
      const cleanPersonalTier = /agent\s*platform|enterprise|gcp/i.test(item.tierName || "")
        ? "Google AI Pro"
        : (item.tierName || "Google AI Pro");
      const cleanGcpTier = gcpBillingMode === "gemini_enterprise" ? "Gemini Enterprise" : "Agent Platform";

      const liveTierKey = isGcp && pid ? "gcp" : "personal";
      const liveTierTemplate = cfg.__meta__?.liveTierModels?.[liveTierKey] || [];
      let cachedQuota = sanitizeCachedQuotaModels(
        item.cachedQuota || null,
        Boolean(isGcp && pid),
        liveTierTemplate,
        cleanPersonalTier,
        item.tierCode || ""
      );
      const resolvedTierCode = isGcp && pid
        ? "GCP"
        : (cachedQuota?.tierCode || item.tierCode || (/ultra/i.test(cleanPersonalTier) ? "Ultra" : (/plus/i.test(cleanPersonalTier) ? "Plus" : (/free/i.test(cleanPersonalTier) ? "Free" : "Pro"))));
      const resolvedPersonalTierName = cachedQuota?.tierName || cleanPersonalTier;
      if (isGcp && pid && gcpBillingMode === "agent_platform") {
        const curModels = cachedQuota?.availableModels || [];
        if (curModels.length < 6) {
          const baseGcpModels = liveTierTemplate.length >= 6 ? liveTierTemplate : AGENT_PLATFORM_DEFAULT_MODELS;
          cachedQuota = {
            tierCode: "GCP",
            isGcpUnlimited: true,
            quotaGroups: [],
            availableModels: baseGcpModels.map((m) => ({
              label: m.label,
              modelId: m.modelId || m.label,
              variantIds: [...(m.variantIds || [m.label])],
              remainingPct: 100,
              resetTime: "",
              unlimited: true
            })),
            updatedAt: cachedQuota?.updatedAt || Date.now()
          };
        }
      }

      if (item.storedToken && typeof item.storedToken === "object" && item.storedToken.token && item.storedToken.token.expiry) {
        item.storedToken.token.expiry = normalizeIsoExpiry(item.storedToken.token.expiry);
      }

      nextAccounts[normKey] = {
        ...item,
        id: normKey,
        email,
        channelType: isGcp && pid ? "gcp" : "personal",
        tierCode: resolvedTierCode,
        gcpProjectId: isGcp && pid ? pid : "",
        gcpBillingMode,
        gcpLocation,
        tierName: isGcp && pid ? cleanGcpTier : resolvedPersonalTierName,
        cachedQuota
      };
      if (pid && !cfg.gcpProjects.includes(pid)) cfg.gcpProjects.push(pid);
    } else {
      const oldPid = (item.gcpProjectId || item.storedToken?.project_id || "").trim();
      if (oldPid) {
        const gcpKey = `${email}#gcp:${oldPid}`;
        nextAccounts[gcpKey] = {
          id: gcpKey,
          alias: `${email} (${oldPid})`,
          email,
          channelType: "gcp",
          tierName: "Agent Platform",
          gcpProjectId: oldPid,
          gcpBillingMode: "agent_platform",
          gcpLocation: "global",
          projectName: item.projectName || oldPid,
          savedAt: item.savedAt || new Date().toISOString(),
          storedToken: item.storedToken ? { ...item.storedToken, auth_method: "gcp", project_id: oldPid, region: "global" } : null,
          cachedQuota: {
            isGcpUnlimited: true,
            quotaGroups: [],
            availableModels: AGENT_PLATFORM_DEFAULT_MODELS.map((m) => ({ ...m, variantIds: [...m.variantIds] })),
            updatedAt: Date.now()
          }
        };
        if (!cfg.gcpProjects.includes(oldPid)) cfg.gcpProjects.push(oldPid);
      } else {
        const personalKey = `${email}#personal`;
        const baseToken = item.storedToken ? buildCleanChannelToken(item.storedToken, "", "") : null;
        nextAccounts[personalKey] = {
          id: personalKey,
          alias: item.alias || email,
          email,
          channelType: "personal",
          tierName: "Google AI Pro",
          gcpProjectId: "",
          gcpBillingMode: "",
          gcpLocation: "",
          savedAt: item.savedAt || new Date().toISOString(),
          storedToken: baseToken
        };
      }
    }
  }

  // 清理路由表中已淘汰的 4.6 / 2.5 / 3.0 模型键、已不存在的通道引用及 GCP 通道引用（GCP 通道已独立出底部免重载路由池）
  if (cfg.routing && typeof cfg.routing === "object") {
    delete cfg.routing.subagentDefaultTarget;
  }
  if (cfg.routing?.models && typeof cfg.routing.models === "object") {
    for (const [mKey, targetVal] of Object.entries(cfg.routing.models)) {
      if (isLegacyDeprecatedModel(mKey)) {
        delete cfg.routing.models[mKey];
        continue;
      }
      if (typeof targetVal === "string" && targetVal.startsWith("account:")) {
        const refId = targetVal.slice(8);
        const refAcc = nextAccounts[refId];
        if (!refAcc || refAcc.channelType === "gcp" || refAcc.gcpProjectId) {
          delete cfg.routing.models[mKey];
        }
      }
    }
  }

  cfg.accounts = nextAccounts;
}

function findStoredTokenForEmail(cfg, email) {
  if (!email) return null;
  for (const acc of Object.values(cfg.accounts || {})) {
    if (acc.email === email && acc.storedToken?.token) {
      return acc.storedToken;
    }
  }
  const winCred = readWinCredToken(false);
  if (winCred && winCred.id_token_email === email) return winCred;
  return null;
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

async function refreshOAuthAccessToken(refreshToken) {
  if (!refreshToken) throw new Error("Missing refresh_token");
  let lastErr = null;
  for (const c of AGY_OAUTH_CLIENTS) {
    try {
      return await refreshOAuthAccessTokenWithClient(refreshToken, c.clientId, c.clientSecret);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("Refresh token failed across all OAuth clients");
}

function fetchCloudResourceProjects(accessToken) {
  return new Promise((resolve) => {
    if (!accessToken) return resolve([]);
    const req = https.request(
      {
        hostname: "cloudresourcemanager.googleapis.com",
        port: 443,
        path: "/v1/projects?filter=lifecycleState%3AACTIVE&pageSize=50",
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json"
        },
        timeout: 4500
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode !== 200) return resolve([]);
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const list = (parsed.projects || [])
              .filter((p) => p && p.projectId && p.lifecycleState === "ACTIVE")
              .map((p) => ({
                projectId: String(p.projectId).trim(),
                name: String(p.name || p.projectId).trim()
              }));
            resolve(list);
          } catch {
            resolve([]);
          }
        });
      }
    );
    req.on("error", () => resolve([]));
    req.on("timeout", () => {
      req.destroy();
      resolve([]);
    });
    req.end();
  });
}

function callCloudCodeApi(endpointPath, accessToken, payloadObj = {}, extraHeaders = {}) {
  return new Promise((resolve) => {
    if (!accessToken) return resolve({ status: 0, data: null });
    const body = Buffer.from(JSON.stringify(payloadObj || {}), "utf8");
    const req = https.request(
      {
        hostname: "daily-cloudcode-pa.googleapis.com",
        port: 443,
        path: endpointPath,
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": "antigravity/hub/2.28.2 (aidev_client; os_type=windows; arch=amd64; cl=1009437749)",
          "Content-Length": body.length,
          ...extraHeaders
        },
        timeout: 6000
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode || 0, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode || 0, data: null, raw: raw.slice(0, 300) });
          }
        });
      }
    );
    req.on("error", (err) => resolve({ status: -1, data: null, error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: -2, data: null, error: "timeout" });
    });
    req.write(body);
    req.end();
  });
}

function fetchCloudCodeCompanionProject(accessToken) {
  return callCloudCodeApi("/v1internal:loadCodeAssist", accessToken, {
    metadata: { ideType: "JETSKI", pluginType: "GEMINI" }
  }).then((res) => {
    if (res.status !== 200 || !res.data) return [];
    const pid = String(
      res.data.cloudaicompanionProject?.id ||
      res.data.cloudaicompanionProject ||
      ""
    ).trim();
    return pid ? [{ projectId: pid, name: pid }] : [];
  });
}

function fetchCloudCodeQuotaByToken(accessToken, gcpProjectId = "") {
  const payload = gcpProjectId ? { project: gcpProjectId } : {};
  return callCloudCodeApi("/v1internal:fetchAvailableModels", accessToken, payload).then((r) => r.data);
}

export async function discoverGcpProjectsForAccount(targetEmail = "") {
  const cfg = readRelayConfig();
  normalizeAccountChannels(cfg);
  const cred = readWinCredToken(false);
  const email = (targetEmail || cred?.id_token_email || cfg.__meta__?.activeEmail || "").trim();
  if (!email) return { email: "", discovered: [] };

  const storedToken = findStoredTokenForEmail(cfg, email) || cred;
  if (!storedToken || !storedToken.token) return { email, discovered: [] };

  let accessToken = storedToken.token.access_token || "";
  const refreshToken = storedToken.token.refresh_token || "";

  const mergeDiscovered = (listA, listB) => {
    const map = new Map();
    for (const item of [...(listA || []), ...(listB || [])]) {
      if (item && item.projectId && !map.has(item.projectId)) {
        map.set(item.projectId, item);
      }
    }
    return Array.from(map.values());
  };

  let [crmProjects, ccProjects] = await Promise.all([
    fetchCloudResourceProjects(accessToken),
    fetchCloudCodeCompanionProject(accessToken)
  ]);
  let projects = mergeDiscovered(crmProjects, ccProjects);

  if (projects.length === 0 && refreshToken) {
    try {
      const refreshed = await refreshOAuthAccessToken(refreshToken);
      if (refreshed && refreshed.access_token) {
        accessToken = refreshed.access_token;
        storedToken.token.access_token = accessToken;
        [crmProjects, ccProjects] = await Promise.all([
          fetchCloudResourceProjects(accessToken),
          fetchCloudCodeCompanionProject(accessToken)
        ]);
        projects = mergeDiscovered(crmProjects, ccProjects);
      }
    } catch {}
  }

  for (const existingAcc of Object.values(cfg.accounts || {})) {
    if (existingAcc.email === email && existingAcc.gcpProjectId) {
      if (!projects.some((p) => p.projectId === existingAcc.gcpProjectId)) {
        projects.push({
          projectId: existingAcc.gcpProjectId,
          name: existingAcc.projectName || existingAcc.gcpProjectId
        });
      }
    }
  }

  // 仅返回扫描到的云项目列表供前端填入表单或下拉选择，严禁自动向通道池写入未确认的 GCP 卡片
  return { email, discovered: projects };
}

export function addOrUpdatePersonalChannelCard(email) {
  const cleanEmail = (email || "").trim();
  if (!cleanEmail) return null;
  const cfg = readRelayConfig();
  normalizeAccountChannels(cfg);
  const baseToken = findStoredTokenForEmail(cfg, cleanEmail) || readWinCredToken(false);
  const personalKey = `${cleanEmail}#personal`;
  const existing = cfg.accounts[personalKey];
  cfg.accounts[personalKey] = {
    ...existing,
    id: personalKey,
    alias: existing?.alias || cleanEmail,
    email: cleanEmail,
    channelType: "personal",
    tierName: existing?.tierName && !/agent\s*platform|enterprise|gcp/i.test(existing.tierName)
      ? existing.tierName
      : "Google AI Pro",
    gcpProjectId: "",
    gcpBillingMode: "",
    gcpLocation: "",
    savedAt: existing?.savedAt || new Date().toISOString(),
    storedToken: baseToken
      ? buildCleanChannelToken(baseToken, "", "")
      : (existing?.storedToken || null)
  };
  writeRelayConfig(cfg);
  return cfg.accounts[personalKey];
}

export function addOrUpdateGcpChannelCard(email, projectId, opts = {}) {
  const cleanEmail = (email || "").trim();
  const rawPidStr = (projectId || "").trim();
  const options = typeof opts === "string" ? { projectName: opts } : (opts || {});
  if (cleanEmail && (rawPidStr === "__PERSONAL__" || options.channelType === "personal")) {
    const card = addOrUpdatePersonalChannelCard(cleanEmail);
    if (card?.id) {
      probeChannelQuotaSnapshot(card.id).catch(() => {});
    }
    return card;
  }
  if (!cleanEmail || !rawPidStr) return null;

  const parts = rawPidStr.split("|").map((s) => s.trim());
  const cleanPid = parts[0] || "";
  if (!cleanPid) return null;
  const modeFromStr = parts[1] || "";
  const locFromStr = parts[2] || "";
  const oldPidFromStr = parts[3] || "";
  const projectName = (options.projectName || "").trim();

  const cfg = readRelayConfig();
  normalizeAccountChannels(cfg);
  const baseToken = findStoredTokenForEmail(cfg, cleanEmail) || readWinCredToken(false);
  if (!cfg.gcpProjects.includes(cleanPid)) {
    cfg.gcpProjects.push(cleanPid);
  }
  const gcpKey = `${cleanEmail}#gcp:${cleanPid}`;
  const oldKey = oldPidFromStr && oldPidFromStr !== cleanPid ? `${cleanEmail}#gcp:${oldPidFromStr}` : "";
  const existing = cfg.accounts[gcpKey] || (oldKey ? cfg.accounts[oldKey] : null);
  const gcpBillingMode = options.gcpBillingMode || modeFromStr || existing?.gcpBillingMode || "agent_platform";
  const rawLoc = options.gcpLocation || locFromStr || existing?.gcpLocation || "global";
  const gcpLocation = ["global", "us", "eu"].includes(rawLoc) ? rawLoc : "global";
  const tierName = gcpBillingMode === "gemini_enterprise" ? "Gemini Enterprise" : "Agent Platform";

  cfg.accounts[gcpKey] = {
    ...existing,
    id: gcpKey,
    alias: existing?.alias && !oldKey ? existing.alias : `${cleanEmail} (${cleanPid})`,
    email: cleanEmail,
    channelType: "gcp",
    tierName,
    gcpProjectId: cleanPid,
    gcpBillingMode,
    gcpLocation,
    projectName: projectName || existing?.projectName || cleanPid,
    savedAt: existing?.savedAt || new Date().toISOString(),
    storedToken: baseToken
      ? {
          ...baseToken,
          auth_method: "gcp",
          project_id: cleanPid,
          region: gcpBillingMode === "agent_platform" ? gcpLocation : ""
        }
      : (existing?.storedToken || null),
    cachedQuota: gcpBillingMode === "agent_platform"
      ? {
          isGcpUnlimited: true,
          quotaGroups: [],
          availableModels: AGENT_PLATFORM_DEFAULT_MODELS.map((m) => ({ ...m, variantIds: [...m.variantIds] })),
          updatedAt: Date.now()
        }
      : (existing?.cachedQuota || {
          isGcpUnlimited: true,
          quotaGroups: [],
          availableModels: [],
          updatedAt: Date.now()
        })
  };

  if (oldKey && cfg.accounts[oldKey]) {
    delete cfg.accounts[oldKey];
    if (cfg.routing?.models) {
      for (const [mKey, rVal] of Object.entries(cfg.routing.models)) {
        if (rVal === `account:${oldKey}`) {
          cfg.routing.models[mKey] = `account:${gcpKey}`;
        }
      }
    }
    if (cfg.routing?.subagentDefaultTarget === `account:${oldKey}`) {
      cfg.routing.subagentDefaultTarget = `account:${gcpKey}`;
    }
  }

  writeRelayConfig(cfg);

  const activeEmail = (cfg.__meta__?.activeEmail || "").trim();
  const activePid = (cfg.__meta__?.lastAppliedGcpProject || "").trim();
  if (activeEmail === cleanEmail && (activePid === cleanPid || (oldPidFromStr && activePid === oldPidFromStr))) {
    switchBillingProjectInstant(cleanPid, { gcpBillingMode, gcpLocation }).catch(() => {});
  }

  return cfg.accounts[gcpKey];
}

function findFirstGcpProjectForEmail(cfg, email) {
  if (!email) return "";
  for (const acc of Object.values(cfg.accounts || {})) {
    if (acc.email === email && acc.gcpProjectId) {
      return acc.gcpProjectId;
    }
  }
  return "";
}

export async function fetchLiveSystemSnapshot(forceWinCred = false) {
  const cfg = readRelayConfig();
  normalizeAccountChannels(cfg);

  let ls = discoverLanguageServer(false);
  let userStatusResp = null;
  let quotaSummaryResp = null;

  if (ls) {
    try {
      [userStatusResp, quotaSummaryResp] = await Promise.all([
        callLsRpc(ls, "GetUserStatus", {}),
        callLsRpc(ls, "RetrieveUserQuotaSummary", {}).catch(() => null)
      ]);
    } catch {
      ls = discoverLanguageServer(true);
      if (ls) {
        try {
          [userStatusResp, quotaSummaryResp] = await Promise.all([
            callLsRpc(ls, "GetUserStatus", {}),
            callLsRpc(ls, "RetrieveUserQuotaSummary", {}).catch(() => null)
          ]);
        } catch {}
      }
    }
  }

  const logInfo = parseLsLogInfo();
  const cred = readWinCredToken(forceWinCred);
  const us = userStatusResp?.userStatus || {};
  const planStatus = us?.planStatus || {};
  const cascadeConfig = us?.cascadeModelConfigData || {};
  const clientModelConfigs = cascadeConfig?.clientModelConfigs || [];

  const lsEmail = (us.email || "").trim();
  const credEmail = (cred?.id_token_email || "").trim();
  const activeEmail = credEmail || cfg.__meta__?.activeEmail || lsEmail || "";
  const activeName = us.name || "";
  const rawTierName = us.userTier?.name || planStatus?.planInfo?.planName || "";
  const activeTierId = us.userTier?.id || "";

  // 以 Windows 凭据管理器 (gemini:antigravity) 与当前激活通道配置作为判定 GCP 模式的唯一权威事实源，防止刚从 GCP 切回个人号时被旧 LS 日志残留误判回 GCP
  const tierIndicatesGcp = /agent\s*platform|enterprise/i.test(rawTierName);
  const credPid = String(cred?.project_id || "").trim();
  const logPid = String(logInfo.lastProjectId || "").trim();
  const metaPid = String(cfg.__meta__?.lastAppliedGcpProject || "").trim();

  let isLiveGcp = false;
  if (cred) {
    isLiveGcp = Boolean(cred.auth_method === "gcp" || credPid);
  } else if (metaPid) {
    isLiveGcp = true;
  } else if (tierIndicatesGcp) {
    isLiveGcp = true;
  }

  const activeGcpProject = isLiveGcp
    ? (credPid || metaPid || logPid || findFirstGcpProjectForEmail(cfg, activeEmail))
    : "";
  const activeGcpBillingMode = isLiveGcp
    ? (/enterprise/i.test(rawTierName) || logInfo.lastUserTier === "enterprise" ? "gemini_enterprise" : "agent_platform")
    : "";
  const activeGcpLocation = isLiveGcp
    ? (logInfo.lastLocation || cred?.region || "global")
    : "";
  const activeTierName = isLiveGcp
    ? (activeGcpBillingMode === "gemini_enterprise" ? "Gemini Enterprise" : "Agent Platform")
    : (rawTierName || "Google AI Pro");

  if (activeEmail) {
    cfg.__meta__.activeEmail = activeEmail;
  }
  cfg.__meta__.lastAppliedGcpProject = activeGcpProject;

  // 1. 仅当凭据管理器处于个人 consumer 模式（或该 #personal 卡片原本已存在）时同步更新个人通道 Token，严禁在 GCP 模式下自动派生空壳 #personal 卡片
  if (cred && credEmail && !isLiveGcp && cred.auth_method !== "gcp" && !credPid) {
    const credPersonalKey = `${credEmail}#personal`;
    const existingCredPersonal = cfg.accounts[credPersonalKey];
    cfg.accounts[credPersonalKey] = {
      ...existingCredPersonal,
      id: credPersonalKey,
      alias: existingCredPersonal?.alias || credEmail,
      email: credEmail,
      channelType: "personal",
      tierName: "Google AI Pro",
      gcpProjectId: "",
      gcpBillingMode: "",
      gcpLocation: "",
      savedAt: existingCredPersonal?.savedAt || new Date().toISOString(),
      storedToken: buildCleanChannelToken(cred, "", "")
    };
  }

  // 2. 按当前真实激活模式维护对应通道卡片（GCP 模式仅维护 #gcp:<projectId>，个人 Pro 模式仅维护 #personal，彻底物理隔离）
  if (activeEmail) {
    const matchingCred = cred && credEmail === activeEmail
      ? cred
      : findStoredTokenForEmail(cfg, activeEmail);

    if (!isLiveGcp) {
      const personalKey = `${activeEmail}#personal`;
      const existingPersonal = cfg.accounts[personalKey];
      cfg.accounts[personalKey] = {
        ...existingPersonal,
        id: personalKey,
        alias: existingPersonal?.alias || activeEmail,
        email: activeEmail,
        channelType: "personal",
        tierName: "Google AI Pro",
        gcpProjectId: "",
        gcpBillingMode: "",
        gcpLocation: "",
        savedAt: existingPersonal?.savedAt || new Date().toISOString(),
        storedToken: matchingCred ? buildCleanChannelToken(matchingCred, "", "") : null
      };
    } else if (activeGcpProject) {
      const gcpKey = `${activeEmail}#gcp:${activeGcpProject}`;
      const existingGcp = cfg.accounts[gcpKey];
      const resolvedMode = activeGcpBillingMode || existingGcp?.gcpBillingMode || "agent_platform";
      const resolvedLoc = activeGcpLocation || existingGcp?.gcpLocation || "global";
      cfg.accounts[gcpKey] = {
        ...existingGcp,
        id: gcpKey,
        alias: existingGcp?.alias || `${activeEmail} (${activeGcpProject})`,
        email: activeEmail,
        channelType: "gcp",
        tierName: resolvedMode === "gemini_enterprise" ? "Gemini Enterprise" : "Agent Platform",
        gcpProjectId: activeGcpProject,
        gcpBillingMode: resolvedMode,
        gcpLocation: resolvedLoc,
        projectName: existingGcp?.projectName || activeGcpProject,
        savedAt: existingGcp?.savedAt || new Date().toISOString(),
        storedToken: matchingCred
          ? {
              ...matchingCred,
              auth_method: "gcp",
              project_id: activeGcpProject,
              region: resolvedMode === "agent_platform" ? resolvedLoc : ""
            }
          : existingGcp?.storedToken || null
      };
      if (!cfg.gcpProjects.includes(activeGcpProject)) {
        cfg.gcpProjects.push(activeGcpProject);
      }
    }
  }

  if (ls) {
    cfg.__meta__.lsRpcTarget = {
      hostname: ls.hostname,
      port: ls.port,
      protocol: ls.protocol || "http",
      altPort: ls.altPort || 0,
      altProtocol: ls.altProtocol || "https",
      csrf: ls.csrf,
      updatedAt: Date.now()
    };

    // 当处于个人模式（!isLiveGcp）时，自动将 Language Server 的 CloudCode 网关挂载到本地透明反向代理（默认 8091，冲突时自动回退 8092..），实现免重载跨账号路由与内存剥离签名
    const desiredProxyMode = isLiveGcp ? "direct" : "local_proxy";
    const localProxyUrl = getActiveCloudCodeProxyUrl(cfg);
    const targetUrl = isLiveGcp ? "https://daily-cloudcode-pa.googleapis.com" : localProxyUrl;
    if (
      cfg.__meta__.cloudCodeProxyPid !== ls.pid ||
      cfg.__meta__.cloudCodeProxyMode !== desiredProxyMode ||
      cfg.__meta__.cloudCodeProxyUrl !== targetUrl
    ) {
      await callLsRpc(ls, "SetCloudCodeURL", { url: targetUrl })
        .then(() => {
          cfg.__meta__.cloudCodeProxyPid = ls.pid;
          cfg.__meta__.cloudCodeProxyMode = desiredProxyMode;
          cfg.__meta__.cloudCodeProxyUrl = targetUrl;
        })
        .catch(() => {});
    }
  }

  // 检测当前个人账号真实会员等级（严格按 Google 官方 userTier 判定 Free / Plus / Pro / Ultra，并将等级徽章与 Gemini 4 Argon 权限解耦）
  const liveChannelKey = activeEmail
    ? (activeGcpProject ? `${activeEmail}#gcp:${activeGcpProject}` : `${activeEmail}#personal`)
    : "";
  const cachedHasArgon = liveChannelKey ? cfg.accounts?.[liveChannelKey]?.cachedQuota?.hasArgonAccess : undefined;
  const cachedTierCode = liveChannelKey ? (cfg.accounts?.[liveChannelKey]?.tierCode || cfg.accounts?.[liveChannelKey]?.cachedQuota?.tierCode || "") : "";
  const liveTierInfo = activeGcpProject
    ? { tierCode: "GCP", tierName: activeTierName, hasArgonAccess: true, isPaidProOrUltra: false }
    : detectPersonalAccountTier(clientModelConfigs, rawTierName, activeTierId, cachedHasArgon, cachedTierCode);
  const hasLiveArgonAccess = liveTierInfo.hasArgonAccess;
  const isLivePaidProOrUltra = liveTierInfo.isPaidProOrUltra;
  if (!activeGcpProject && liveChannelKey && cfg.accounts[liveChannelKey]) {
    cfg.accounts[liveChannelKey].tierCode = liveTierInfo.tierCode;
    cfg.accounts[liveChannelKey].tierName = liveTierInfo.tierName;
  }

  // 按基础模型家族聚合 (合并 Low / Medium / High / Max 思考档位，过滤已下线或当前套餐不可用的模型)
  const groupedModelMap = new Map();
  for (const m of clientModelConfigs) {
    const rawLabel = (m.label || "").trim();
    const modelId = m.modelOrAlias?.model || m.modelOrAlias?.alias || "";
    if (!rawLabel || !modelId) continue;
    const baseLabel = rawLabel.replace(/\s*\((Low|Medium|High|Max)\)\s*$/i, "").trim();
    if (!activeGcpProject) {
      if (isLegacyDeprecatedModel(baseLabel) || isLegacyDeprecatedModel(rawLabel) || isModelEntryRestrictedOrSunset(m)) {
        continue;
      }
      if (!hasLiveArgonAccess && /argon/i.test(baseLabel)) {
        continue;
      }
    }
    const remainingPct = activeGcpProject
      ? 100
      : (m.quotaInfo?.remainingFraction !== undefined
          ? Math.round(m.quotaInfo.remainingFraction * 100)
          : (m.quotaInfo?.resetTime ? 0 : 100));
    const resetTime = activeGcpProject ? "" : (m.quotaInfo?.resetTime || "");

    if (!groupedModelMap.has(baseLabel)) {
      groupedModelMap.set(baseLabel, {
        label: baseLabel,
        modelId: baseLabel,
        variantIds: [baseLabel, rawLabel, modelId],
        remainingPct,
        resetTime,
        unlimited: Boolean(activeGcpProject)
      });
    } else {
      const entry = groupedModelMap.get(baseLabel);
      if (!entry.variantIds.includes(rawLabel)) entry.variantIds.push(rawLabel);
      if (!entry.variantIds.includes(modelId)) entry.variantIds.push(modelId);
    }
  }
  let availableModels = Array.from(groupedModelMap.values());
  if (availableModels.length === 0 && activeGcpProject && activeGcpBillingMode === "agent_platform") {
    availableModels = AGENT_PLATFORM_DEFAULT_MODELS.map((m) => ({ ...m, variantIds: [...m.variantIds] }));
  }

  // 三大配额池汇总（GCP 通道不显示剩余额度百分比桶；个人 Pro 通道保留完整周限额与 5h limit 独立桶位，无 Argon 权限时剔除 Argon 组，并过滤 All Models 兜底组）
  const rawQuotaGroups = activeGcpProject
    ? []
    : (quotaSummaryResp?.response?.groups || [])
        .map((g) => ({
          id: g.groupId || g.displayName || "",
          displayName: g.displayName || "",
          description: g.description || "",
          buckets: (g.buckets || []).map((b) => ({
            bucketId: b.bucketId || "",
            window: b.window || "",
            remainingPct: b.remainingFraction !== undefined
              ? Math.round(b.remainingFraction * 100)
              : (b.resetTime ? 0 : 100),
            resetTime: b.resetTime || ""
          }))
        }))
        .filter((g) => isValidOfficialQuotaGroup(g));
  let quotaGroups = (!activeGcpProject && !hasLiveArgonAccess)
    ? rawQuotaGroups.filter((g) => !/argon/i.test(g.id || g.displayName || ""))
    : rawQuotaGroups;

  if (!activeGcpProject && quotaGroups.length > 0 && liveTierInfo.tierCode !== "Free") {
    const liveTierTpl = cfg.__meta__?.liveTierModels?.personal || [];
    availableModels = buildProModelsFromQuotaGroups(
      quotaGroups,
      cfg.accounts?.[liveChannelKey]?.cachedQuota?.availableModels || [],
      availableModels,
      liveTierTpl,
      hasLiveArgonAccess
    );
  }

  // 若用户在前端显式固定了前台主会话通道（activeChannelId），背景模型路由不会篡改前台使用中状态
  const detectedChannelId = activeEmail
    ? (activeGcpProject ? `${activeEmail}#gcp:${activeGcpProject}` : `${activeEmail}#personal`)
    : "";
  const pinnedChannelId = String(cfg.__meta__?.activeChannelId || "").trim();
  const activeChannelId = (pinnedChannelId && cfg.accounts?.[pinnedChannelId])
    ? pinnedChannelId
    : detectedChannelId;

  // 当个人 Pro 通道因 LS 刚启动或异常返回 All Models 导致 quotaGroups 为空时，主动通过 Cloud Code API 补齐真实的双组配额
  if (!activeGcpProject && quotaGroups.length === 0 && detectedChannelId && cfg.accounts[detectedChannelId]) {
    const cachedGroups = (cfg.accounts[detectedChannelId].cachedQuota?.quotaGroups || []).filter((g) => isValidOfficialQuotaGroup(g));
    if (cachedGroups.length > 0 && !forceWinCred) {
      quotaGroups = cachedGroups;
    } else {
      await probeChannelQuotaSnapshot(detectedChannelId).catch(() => {});
      const freshCfg = readRelayConfig();
      const probed = freshCfg?.accounts?.[detectedChannelId]?.cachedQuota;
      if (probed) {
        cfg.accounts[detectedChannelId].cachedQuota = probed;
        if (Array.isArray(probed.quotaGroups) && probed.quotaGroups.length > 0) {
          quotaGroups = probed.quotaGroups.filter((g) => isValidOfficialQuotaGroup(g));
        }
        if (availableModels.length === 0 && Array.isArray(probed.availableModels) && probed.availableModels.length > 0) {
          availableModels = probed.availableModels;
        }
      }
    }
  }

  if (availableModels.length > 0 && clientModelConfigs.length > 0 && (activeGcpProject || hasLiveArgonAccess)) {
    if (!cfg.__meta__.liveTierModels || typeof cfg.__meta__.liveTierModels !== "object") {
      cfg.__meta__.liveTierModels = {};
    }
    const tierKey = activeGcpProject ? "gcp" : "personal";
    cfg.__meta__.liveTierModels[tierKey] = availableModels.map((m) => ({
      label: m.label,
      modelId: m.modelId,
      variantIds: [...(m.variantIds || [m.label])]
    }));
  }

  if (detectedChannelId && cfg.accounts[detectedChannelId] && (quotaGroups.length > 0 || availableModels.length > 0 || activeGcpProject)) {
    cfg.accounts[detectedChannelId].cachedQuota = {
      tierCode: liveTierInfo.tierCode,
      tierName: liveTierInfo.tierName,
      hasArgonAccess: hasLiveArgonAccess,
      isPaidProOrUltra: isLivePaidProOrUltra,
      isGcpUnlimited: Boolean(activeGcpProject),
      quotaGroups,
      availableModels: availableModels.length > 0
        ? availableModels
        : (cfg.accounts[detectedChannelId].cachedQuota?.availableModels || []),
      updatedAt: Date.now()
    };
  }
  if (activeChannelId && activeChannelId !== detectedChannelId && cfg.accounts[activeChannelId]) {
    const cachedAt = Number(cfg.accounts[activeChannelId].cachedQuota?.updatedAt || 0);
    if (forceWinCred || !cfg.accounts[activeChannelId].cachedQuota?.quotaGroups?.length || (Date.now() - cachedAt > 45000)) {
      await probeChannelQuotaSnapshot(activeChannelId).catch(() => {});
      const freshCfg = readRelayConfig();
      if (freshCfg?.accounts?.[activeChannelId]?.cachedQuota) {
        cfg.accounts[activeChannelId].cachedQuota = freshCfg.accounts[activeChannelId].cachedQuota;
      }
    }
  }
  const activeAccObj = activeChannelId ? cfg.accounts[activeChannelId] : null;
  const displayAccount = activeAccObj
    ? {
        email: activeAccObj.email,
        name: activeName,
        tierCode: activeAccObj.tierCode || activeAccObj.cachedQuota?.tierCode || liveTierInfo.tierCode,
        tierName: activeAccObj.tierName || activeTierName,
        tierId: activeTierId,
        gcpProjectId: activeAccObj.gcpProjectId || "",
        gcpBillingMode: activeAccObj.gcpBillingMode || "",
        gcpLocation: activeAccObj.gcpLocation || "",
        channelId: activeChannelId
      }
    : {
        email: activeEmail,
        name: activeName,
        tierCode: liveTierInfo.tierCode,
        tierName: activeTierName,
        tierId: activeTierId,
        gcpProjectId: activeGcpProject,
        gcpBillingMode: activeGcpBillingMode,
        gcpLocation: activeGcpLocation,
        channelId: activeChannelId
      };
  const displayModels = (activeAccObj && activeChannelId !== detectedChannelId && activeAccObj.cachedQuota?.availableModels?.length > 0)
    ? activeAccObj.cachedQuota.availableModels
    : (availableModels.length > 0 ? availableModels : (activeAccObj?.cachedQuota?.availableModels || []));
  const displayQuotaGroups = (activeAccObj && activeChannelId !== detectedChannelId && activeAccObj.cachedQuota?.quotaGroups)
    ? activeAccObj.cachedQuota.quotaGroups
    : quotaGroups;
  writeRelayConfig(cfg);

  // 排序通道列表：同一邮箱下先排 personal 再排 gcp
  const channelList = Object.values(cfg.accounts || {})
    .map(({ storedToken, ...rest }) => rest)
    .sort((a, b) => {
      if (a.email !== b.email) return a.email.localeCompare(b.email);
      if (a.channelType !== b.channelType) return a.channelType === "personal" ? -1 : 1;
      return (a.gcpProjectId || "").localeCompare(b.gcpProjectId || "");
    });

  const telemetry = computeSessionTelemetrySnapshot(cfg);

  return {
    lsOnline: Boolean(ls && userStatusResp),
    lsPid: ls?.pid || 0,
    lsPort: ls?.port || 0,
    activeAccount: displayAccount,
    availableModels: displayModels,
    quotaGroups: displayQuotaGroups,
    accounts: channelList,
    gcpProjects: cfg.gcpProjects || [],
    routing: cfg.routing || {},
    oauthPending: Boolean(activeOAuthSession),
    telemetry
  };
}

function parseCloudCodeModelsAndQuota(
  rawModelsResp,
  rawQuotaSummaryResp = null,
  isGcpChannel = false,
  userTier = "",
  prevCachedQuota = null,
  liveTierTemplate = []
) {
  const modelsObj = rawModelsResp?.models;
  if (!modelsObj || typeof modelsObj !== "object") {
    return null;
  }

  // 严格提取官方 agentModelSorts 推荐分组中的模型 ID 白名单，彻底排除底层字典中的旧版内部模型（如 Gemini 2.5 Pro / Gemini 3 Flash）
  const allowedModelIds = new Set();
  const sorts = Array.isArray(rawModelsResp?.agentModelSorts) ? rawModelsResp.agentModelSorts : [];
  for (const s of sorts) {
    for (const grp of (s?.groups || [])) {
      for (const mid of (grp?.modelIds || [])) {
        if (mid) allowedModelIds.add(String(mid));
      }
    }
  }

  const orderedEntries = [];
  if (allowedModelIds.size > 0) {
    for (const mid of allowedModelIds) {
      if (modelsObj[mid]) {
        orderedEntries.push([mid, modelsObj[mid]]);
      }
    }
  } else {
    for (const [mid, m] of Object.entries(modelsObj)) {
      const lbl = String(m?.displayName || m?.label || "").trim();
      if (/gemini\s*4\s*argon|gemini\s*3\.8\s*flash|claude\s*opus|claude\s*sonnet|gpt-oss/i.test(lbl)) {
        orderedEntries.push([mid, m]);
      }
    }
  }

  const tierInfo = isGcpChannel
    ? { tierCode: "GCP", tierName: "Agent Platform", hasArgonAccess: true, isPaidProOrUltra: false }
    : detectPersonalAccountTier(
        modelsObj,
        userTier,
        userTier,
        prevCachedQuota?.hasArgonAccess,
        prevCachedQuota?.tierCode || ""
      );
  const hasArgonAccess = tierInfo.hasArgonAccess;
  const isPaidProOrUltra = tierInfo.isPaidProOrUltra;
  const groupedModelMap = new Map();

  for (const [modelId, m] of orderedEntries) {
    if (!m || typeof m !== "object") continue;
    if (/disabled$/i.test(modelId)) continue;
    if (!isGcpChannel && (isModelEntryRestrictedOrSunset(m) || !m.quotaInfo)) continue;
    const rawLabel = String(m.displayName || m.label || "").trim();
    if (!rawLabel) continue;
    const baseLabel = rawLabel.replace(/\s*\((Low|Medium|High|Max)\)\s*$/i, "").trim();
    if (!isGcpChannel) {
      if (isLegacyDeprecatedModel(baseLabel) || isLegacyDeprecatedModel(rawLabel) || isLegacyDeprecatedModel(modelId)) {
        continue;
      }
      if (!hasArgonAccess && /argon/i.test(baseLabel)) {
        continue;
      }
    }
    const remainingPct = isGcpChannel
      ? 100
      : (m.quotaInfo?.remainingFraction !== undefined
          ? Math.round(Number(m.quotaInfo.remainingFraction) * 100)
          : (m.quotaInfo?.resetTime ? 0 : 100));
    const resetTime = isGcpChannel ? "" : (m.quotaInfo?.resetTime || "");

    if (!groupedModelMap.has(baseLabel)) {
      groupedModelMap.set(baseLabel, {
        label: baseLabel,
        modelId: baseLabel,
        variantIds: [baseLabel, rawLabel, modelId],
        remainingPct,
        resetTime,
        unlimited: isGcpChannel
      });
    } else {
      const entry = groupedModelMap.get(baseLabel);
      if (!entry.variantIds.includes(rawLabel)) entry.variantIds.push(rawLabel);
      if (!entry.variantIds.includes(modelId)) entry.variantIds.push(modelId);
    }
  }

  const quotaGroups = [];
  if (!isGcpChannel) {
    const rawGroups = rawQuotaSummaryResp?.groups || rawQuotaSummaryResp?.response?.groups || [];
    if (Array.isArray(rawGroups) && rawGroups.length > 0) {
      for (const g of rawGroups) {
        const gId = g.groupId || g.displayName || "";
        if (!hasArgonAccess && /argon/i.test(gId)) continue;
        const candidateGroup = {
          id: gId,
          displayName: g.displayName || "",
          description: g.description || "",
          buckets: (g.buckets || []).map((b) => ({
            bucketId: b.bucketId || "",
            window: b.window || "",
            remainingPct: b.remainingFraction !== undefined
              ? Math.round(Number(b.remainingFraction) * 100)
              : (b.resetTime ? 0 : 100),
            resetTime: b.resetTime || ""
          }))
        };
        if (isValidOfficialQuotaGroup(candidateGroup)) {
          quotaGroups.push(candidateGroup);
        }
      }
    }
  }

  // 所有具备官方配额池的会员个人通道（Ultra / Pro / Jio Pro / Plus）统一合并真实支持的模型并绑定双层（周 + 5h）配额桶；若无 Argon 权限则仅剔除 Gemini 4 Argon，保留 Gemini 3.8 Flash 与 Claude 5.5
  if (!isGcpChannel && quotaGroups.length > 0 && tierInfo.tierCode !== "Free") {
    const dynamicApiModels = Array.from(groupedModelMap.values()).filter(
      (m) => !isLegacyDeprecatedModel(m.label) && !isLegacyDeprecatedModel(m.modelId)
    );
    const proModels = buildProModelsFromQuotaGroups(
      quotaGroups,
      prevCachedQuota?.availableModels || [],
      dynamicApiModels,
      liveTierTemplate,
      hasArgonAccess
    );
    return {
      tierCode: tierInfo.tierCode,
      tierName: tierInfo.tierName,
      hasArgonAccess,
      isPaidProOrUltra,
      isGcpUnlimited: false,
      quotaGroups,
      availableModels: proModels,
      updatedAt: Date.now()
    };
  }

  const availableModels = Array.from(groupedModelMap.values()).filter(
    (m) => !isLegacyDeprecatedModel(m.label) && !isLegacyDeprecatedModel(m.modelId)
  );

  return {
    tierCode: tierInfo.tierCode,
    tierName: tierInfo.tierName,
    hasArgonAccess,
    isPaidProOrUltra,
    isGcpUnlimited: isGcpChannel,
    quotaGroups,
    availableModels,
    updatedAt: Date.now()
  };
}

export async function probeChannelQuotaSnapshot(channelId) {
  const cfg = readRelayConfig();
  normalizeAccountChannels(cfg);
  const acc = cfg.accounts?.[channelId];
  if (!acc) return null;

  const isGcp = acc.channelType === "gcp" || Boolean(acc.gcpProjectId);
  const gcpPid = (acc.gcpProjectId || "").trim();
  const gcpBillingMode = isGcp ? (acc.gcpBillingMode || "agent_platform") : "";

  // 若目标通道就是当前 Language Server 正在使用的活跃通道，直接读取 LS 原生 GetUserStatus + RetrieveUserQuotaSummary
  const ls = discoverLanguageServer(false);
  const activeEmail = (cfg.__meta__?.activeEmail || "").trim();
  const originalGcpPid = String(cfg.__meta__?.lastAppliedGcpProject || "").trim();

  if (ls && acc.email && acc.email === activeEmail && gcpPid === originalGcpPid) {
    try {
      const [usResp, qsResp] = await Promise.all([
        callLsRpc(ls, "GetUserStatus", {}).catch(() => null),
        callLsRpc(ls, "RetrieveUserQuotaSummary", {}).catch(() => null)
      ]);

      const clientModels = usResp?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
      const rawGroups = qsResp?.response?.groups || [];
      const usTierName = usResp?.userStatus?.userTier?.name || usResp?.userStatus?.planStatus?.planInfo?.planName || "";
      const usTierId = usResp?.userStatus?.userTier?.id || "";
      if (clientModels.length > 0 || rawGroups.length > 0) {
        const tierInfo = isGcp
          ? { tierCode: "GCP", tierName: acc.tierName || "Agent Platform", hasArgonAccess: true, isPaidProOrUltra: false }
          : detectPersonalAccountTier(
              clientModels,
              usTierName,
              usTierId,
              acc.cachedQuota?.hasArgonAccess,
              acc.tierCode || acc.cachedQuota?.tierCode || ""
            );
        const hasArgonAccess = tierInfo.hasArgonAccess;
        const isPaidProOrUltra = tierInfo.isPaidProOrUltra;
        const groupedMap = new Map();
        for (const m of clientModels) {
          const rawLabel = (m.label || "").trim();
          const modelId = m.modelOrAlias?.model || m.modelOrAlias?.alias || "";
          if (!rawLabel || !modelId) continue;
          const baseLabel = rawLabel.replace(/\s*\((Low|Medium|High|Max)\)\s*$/i, "").trim();
          if (!isGcp) {
            if (isLegacyDeprecatedModel(baseLabel) || isLegacyDeprecatedModel(rawLabel) || isModelEntryRestrictedOrSunset(m)) {
              continue;
            }
            if (!hasArgonAccess && /argon/i.test(baseLabel)) {
              continue;
            }
          }
          const hasFraction = m.quotaInfo?.remainingFraction !== undefined;
          const remainingPct = isGcp
            ? 100
            : (hasFraction ? Math.round(m.quotaInfo.remainingFraction * 100) : (m.quotaInfo?.resetTime ? 0 : 100));
          const resetTime = isGcp ? "" : (m.quotaInfo?.resetTime || "");
          if (!groupedMap.has(baseLabel)) {
            groupedMap.set(baseLabel, {
              label: baseLabel,
              modelId: baseLabel,
              variantIds: [baseLabel, rawLabel, modelId],
              remainingPct,
              resetTime,
              unlimited: isGcp
            });
          } else {
            const entry = groupedMap.get(baseLabel);
            if (!entry.variantIds.includes(rawLabel)) entry.variantIds.push(rawLabel);
            if (!entry.variantIds.includes(modelId)) entry.variantIds.push(modelId);
          }
        }
        const quotaGroups = isGcp
          ? []
          : rawGroups
              .filter((g) => hasArgonAccess || !/argon/i.test(g.groupId || g.displayName || ""))
              .map((g) => ({
                id: g.groupId || g.displayName || "",
                displayName: g.displayName || "",
                description: g.description || "",
                buckets: (g.buckets || []).map((b) => ({
                  bucketId: b.bucketId || "",
                  window: b.window || "",
                  remainingPct: b.remainingFraction !== undefined
                    ? Math.round(b.remainingFraction * 100)
                    : (b.resetTime ? 0 : 100),
                  resetTime: b.resetTime || ""
                }))
              }))
              .filter((g) => isValidOfficialQuotaGroup(g));

        let liveModels = Array.from(groupedMap.values());
        if (!isGcp && quotaGroups.length > 0 && tierInfo.tierCode !== "Free") {
          liveModels = buildProModelsFromQuotaGroups(
            quotaGroups,
            acc.cachedQuota?.availableModels || [],
            liveModels,
            cfg.__meta__?.liveTierModels?.personal || [],
            hasArgonAccess
          );
        }
        if (liveModels.length > 0 && clientModels.length > 0 && (isGcp || hasArgonAccess)) {
          if (!cfg.__meta__.liveTierModels || typeof cfg.__meta__.liveTierModels !== "object") {
            cfg.__meta__.liveTierModels = {};
          }
          cfg.__meta__.liveTierModels[isGcp ? "gcp" : "personal"] = liveModels.map((m) => ({
            label: m.label,
            modelId: m.modelId,
            variantIds: [...(m.variantIds || [m.label])]
          }));
        }

        if ((isGcp && liveModels.length > 0) || (!isGcp && quotaGroups.length > 0 && liveModels.length > 0)) {
          if (!isGcp) {
            acc.tierCode = tierInfo.tierCode;
            acc.tierName = tierInfo.tierName;
          }
          acc.cachedQuota = {
            tierCode: tierInfo.tierCode,
            tierName: tierInfo.tierName,
            hasArgonAccess,
            isPaidProOrUltra,
            isGcpUnlimited: isGcp,
            quotaGroups,
            availableModels: liveModels,
            probedVia: "language_server_rpc",
            updatedAt: Date.now()
          };
          writeRelayConfig(cfg);
          return acc.cachedQuota;
        }
      }
    } catch {}
  }

  const liveTierTemplate = cfg.__meta__?.liveTierModels?.[isGcp ? "gcp" : "personal"] || [];

  // 对于按量计费 (Agent Platform / Vertex AI) 的非当前活跃 GCP 通道，优先合并 LS 实时 GCP 模板与官方 Agent Platform 目录
  if (isGcp && gcpBillingMode === "agent_platform") {
    const existingModels = acc.cachedQuota?.availableModels || [];
    const baseGcpModels = liveTierTemplate.length >= 6 ? liveTierTemplate : AGENT_PLATFORM_DEFAULT_MODELS;
    acc.cachedQuota = {
      isGcpUnlimited: true,
      quotaGroups: [],
      availableModels: existingModels.length >= 6
        ? sanitizeCachedQuotaModels(acc.cachedQuota, true, liveTierTemplate).availableModels
        : baseGcpModels.map((m) => ({
            label: m.label,
            modelId: m.modelId || m.label,
            variantIds: [...(m.variantIds || [m.label])],
            remainingPct: 100,
            resetTime: "",
            unlimited: true
          })),
      probedVia: "agent_platform_catalog",
      updatedAt: Date.now()
    };
    writeRelayConfig(cfg);
    return acc.cachedQuota;
  }

  const baseToken = acc.storedToken || findStoredTokenForEmail(cfg, acc.email);
  if (!baseToken || !baseToken.token) {
    return acc.cachedQuota || null;
  }

  let accessToken = baseToken.token.access_token || "";
  const refreshToken = baseToken.token.refresh_token || "";

  const tryProbeWithToken = async (tok) => {
    let companionPid = gcpPid;
    const loadPayload = {
      metadata: {
        ideType: "JETSKI",
        pluginType: "GEMINI"
      }
    };
    if (gcpPid) {
      loadPayload.cloudaicompanionProject = gcpPid;
      loadPayload.metadata.duetProject = gcpPid;
    }
    const loadResp = await callCloudCodeApi("/v1internal:loadCodeAssist", tok, loadPayload);
    let userTier = "";
    if (loadResp.status === 200 && loadResp.data) {
      if (!companionPid) {
        companionPid = String(
          loadResp.data.cloudaicompanionProject?.id ||
          loadResp.data.cloudaicompanionProject ||
          ""
        ).trim();
      }
      const pTier = loadResp.data.paidTier || loadResp.data.currentTier || {};
      userTier = String(
        isGcp
          ? (loadResp.data.currentTier?.id || "standard-tier")
          : `${pTier.id || ""} ${pTier.name || ""}`
      ).trim();
    }

    // 个人通道（!isGcp）对齐 language_server.exe 原生行为传入空对象 {}，从而 100% 获取真实的 agentModelSorts（自动识别 Jio 渠道版 gemini-4-argon-disabled）与完整的 2/3 组官方配额池
    const reqPayload = isGcp && companionPid ? { project: companionPid } : {};

    const [modelsResp, quotaSummaryResp] = await Promise.all([
      callCloudCodeApi("/v1internal:fetchAvailableModels", tok, reqPayload),
      !isGcp
        ? callCloudCodeApi("/v1internal:retrieveUserQuotaSummary", tok, reqPayload)
        : Promise.resolve({ status: 0, data: null })
    ]);
    return { loadResp, modelsResp, quotaSummaryResp, companionPid, userTier };
  };

  let probeRes = await tryProbeWithToken(accessToken);
  if ((probeRes.modelsResp.status === 401 || probeRes.modelsResp.status === 403 || !probeRes.modelsResp.data) && refreshToken) {
    try {
      const refreshed = await refreshOAuthAccessToken(refreshToken);
      if (refreshed && refreshed.access_token) {
        accessToken = refreshed.access_token;
        baseToken.token.access_token = accessToken;
        baseToken.token.expiry = new Date(Date.now() + (refreshed.expires_in || 3599) * 1000).toISOString();
        // 同步更新同邮箱下所有通道的 access_token
        for (const item of Object.values(cfg.accounts || {})) {
          if (item.email === acc.email && item.storedToken?.token) {
            item.storedToken.token.access_token = accessToken;
            item.storedToken.token.expiry = baseToken.token.expiry;
          }
        }
        probeRes = await tryProbeWithToken(accessToken);
      }
    } catch {}
  }

  if (probeRes.modelsResp.status === 200 && probeRes.modelsResp.data) {
    const parsed = parseCloudCodeModelsAndQuota(
      probeRes.modelsResp.data,
      probeRes.quotaSummaryResp?.data || null,
      isGcp,
      probeRes.userTier,
      acc.cachedQuota || null,
      liveTierTemplate
    );
    if (parsed) {
      if (!isGcp && parsed.tierCode) {
        acc.tierCode = parsed.tierCode;
        acc.tierName = parsed.tierName || acc.tierName;
      }
      acc.cachedQuota = parsed;
      writeRelayConfig(cfg);
    }
  }

  return acc.cachedQuota || null;
}

export async function probeAllChannelsQuotaSnapshot() {
  const cfg0 = readRelayConfig();
  normalizeAccountChannels(cfg0);
  if (cfg0.__meta__?.probeDebug) {
    delete cfg0.__meta__.probeDebug;
    writeRelayConfig(cfg0);
  }
  const channelIds = Object.keys(cfg0.accounts || {});
  const results = {};
  for (const cid of channelIds) {
    try {
      results[cid] = await probeChannelQuotaSnapshot(cid);
    } catch (err) {
      results[cid] = { error: err.message };
    }
  }
  return results;
}

function scheduleDetachedLanguageServerRestart(tokenToLock = null, activeLsHint = null) {
  const oldLogInfo = parseLsLogInfo();
  const activeLs = activeLsHint || discoverLanguageServer(false);
  const oldPid = oldLogInfo.pid || activeLs?.pid || 0;
  cachedLsInfo = null;

  try {
    const b64Json = tokenToLock
      ? Buffer.from(JSON.stringify(tokenToLock), "utf8").toString("base64")
      : "";
    const stopClause = oldPid > 0
      ? `Stop-Process -Id ${oldPid} -Force -ErrorAction SilentlyContinue`
      : `Stop-Process -Name "language_server*" -Force -ErrorAction SilentlyContinue`;
    const psScript = `
Start-Sleep -Milliseconds 260
${stopClause}
Start-Sleep -Milliseconds 160
if ("${b64Json}" -ne "") {
  $bytes = [Convert]::FromBase64String("${b64Json}")
  $code = @"
using System;
using System.Runtime.InteropServices;
public class CredLock {
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
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredWrite([In] ref CREDENTIAL userCredential, [In] uint flags);
    public static void WriteRaw(string target, byte[] blob) {
        CREDENTIAL cred = new CREDENTIAL();
        cred.Flags = 0;
        cred.Type = 1;
        cred.TargetName = target;
        cred.CredentialBlobSize = (uint)blob.Length;
        cred.CredentialBlob = Marshal.AllocHGlobal(blob.Length);
        Marshal.Copy(blob, 0, cred.CredentialBlob, blob.Length);
        cred.Persist = 2;
        cred.UserName = "antigravity";
        try { CredWrite(ref cred, 0); }
        finally { Marshal.FreeHGlobal(cred.CredentialBlob); }
    }
}
"@
  Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue
  [CredLock]::WriteRaw("gemini:antigravity", $bytes)
}
`;
    spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", psScript], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }).unref();
  } catch {}
}

const THOUGHT_SIG_MAGIC_RAW = Buffer.from([0x01, 0x69, 0x14, 0x7d, 0x13]);
const THOUGHT_SIG_MAGIC_B64_1 = Buffer.from("AWkUfR", "utf8");
const THOUGHT_SIG_MAGIC_B64_2 = Buffer.from("FpFH0T", "utf8");

function readProtoVarint(buf, offset) {
  let res = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const b = buf[pos++];
    res |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { val: res, next: pos };
    shift += 7n;
    if (shift > 63n) return null;
  }
  return null;
}

function encodeProtoVarint(val) {
  let v = BigInt(val);
  const bytes = [];
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function hasThoughtSignatureMagic(buf) {
  return (
    buf.includes(THOUGHT_SIG_MAGIC_RAW) ||
    buf.includes(THOUGHT_SIG_MAGIC_B64_1) ||
    buf.includes(THOUGHT_SIG_MAGIC_B64_2)
  );
}

function isValidProtoSubMessage(buf) {
  if (!buf || buf.length === 0) return false;
  let pos = 0;
  let count = 0;
  while (pos < buf.length) {
    const tag = readProtoVarint(buf, pos);
    if (!tag || tag.val === 0n) return false;
    const wire = Number(tag.val & 7n);
    const field = Number(tag.val >> 3n);
    if (field <= 0 || field > 5000) return false;
    pos = tag.next;
    if (wire === 0) {
      const v = readProtoVarint(buf, pos);
      if (!v) return false;
      pos = v.next;
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 2) {
      const l = readProtoVarint(buf, pos);
      if (!l || l.val < 0n || l.next + Number(l.val) > buf.length) return false;
      pos = l.next + Number(l.val);
    } else if (wire === 5) {
      pos += 4;
    } else {
      return false;
    }
    count++;
  }
  return pos === buf.length && count > 0;
}

function scrubThoughtSignaturesFromProto(buf) {
  if (!buf || !hasThoughtSignatureMagic(buf)) return { buf, changed: false };
  let pos = 0;
  let changed = false;
  const out = [];
  while (pos < buf.length) {
    const start = pos;
    const tag = readProtoVarint(buf, pos);
    if (!tag || tag.val === 0n) return { buf, changed: false };
    const wire = Number(tag.val & 7n);
    pos = tag.next;
    if (wire === 0) {
      const v = readProtoVarint(buf, pos);
      if (!v) return { buf, changed: false };
      pos = v.next;
      out.push(buf.subarray(start, pos));
    } else if (wire === 1) {
      if (pos + 8 > buf.length) return { buf, changed: false };
      pos += 8;
      out.push(buf.subarray(start, pos));
    } else if (wire === 2) {
      const l = readProtoVarint(buf, pos);
      if (!l || l.val < 0n || l.next + Number(l.val) > buf.length) return { buf, changed: false };
      const valStart = l.next;
      const valEnd = valStart + Number(l.val);
      const sub = buf.subarray(valStart, valEnd);
      pos = valEnd;
      if (hasThoughtSignatureMagic(sub)) {
        const isDirectLeafSig =
          sub.subarray(0, 14).includes(THOUGHT_SIG_MAGIC_RAW) ||
          sub.subarray(0, 18).includes(THOUGHT_SIG_MAGIC_B64_1) ||
          sub.subarray(0, 18).includes(THOUGHT_SIG_MAGIC_B64_2);
        if (!isDirectLeafSig && isValidProtoSubMessage(sub)) {
          const res = scrubThoughtSignaturesFromProto(sub);
          if (res.changed) {
            changed = true;
            if (res.buf.length > 0) {
              out.push(buf.subarray(start, tag.next), encodeProtoVarint(res.buf.length), res.buf);
            }
            continue;
          }
        }
        changed = true;
        continue;
      }
      out.push(buf.subarray(start, pos));
    } else if (wire === 5) {
      if (pos + 4 > buf.length) return { buf, changed: false };
      pos += 4;
      out.push(buf.subarray(start, pos));
    } else {
      return { buf, changed: false };
    }
  }
  return changed ? { buf: Buffer.concat(out), changed: true } : { buf, changed: false };
}

export async function scrubRecentConversationsSignatures(ls = null) {
  const convDir = path.join(os.homedir(), ".gemini", "antigravity", "conversations");
  if (!fs.existsSync(convDir)) return [];
  const activeLs = ls || discoverLanguageServer(false);
  const reloadedIds = [];
  try {
    const entries = fs
      .readdirSync(convDir)
      .filter((f) => f.endsWith(".db"))
      .map((f) => {
        const fullPath = path.join(convDir, f);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(fullPath).mtimeMs;
        } catch {}
        return { cascadeId: f.slice(0, -3), fullPath, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 30);

    for (const item of entries) {
      let modified = false;
      try {
        const rawBytes = fs.readFileSync(item.fullPath);
        if (!hasThoughtSignatureMagic(rawBytes)) continue;
        const db = new DatabaseSync(item.fullPath);
        try {
          const steps = db.prepare("SELECT idx, metadata, step_payload FROM steps").all();
          const updStep = db.prepare("UPDATE steps SET metadata = ?, step_payload = ? WHERE idx = ?");
          db.exec("BEGIN");
          for (const r of steps) {
            const m = r.metadata ? Buffer.from(r.metadata) : null;
            const p = r.step_payload ? Buffer.from(r.step_payload) : null;
            const rm = m ? scrubThoughtSignaturesFromProto(m) : { buf: m, changed: false };
            const rp = p ? scrubThoughtSignaturesFromProto(p) : { buf: p, changed: false };
            if (rm.changed || rp.changed) {
              updStep.run(rm.buf, rp.buf, r.idx);
              modified = true;
            }
          }
          try {
            const gens = db.prepare("SELECT idx, data FROM gen_metadata").all();
            const updGen = db.prepare("UPDATE gen_metadata SET data = ?, size = ? WHERE idx = ?");
            for (const g of gens) {
              const d = g.data ? Buffer.from(g.data) : null;
              const rd = d ? scrubThoughtSignaturesFromProto(d) : { buf: d, changed: false };
              if (rd.changed) {
                updGen.run(rd.buf, rd.buf.length, g.idx);
                modified = true;
              }
            }
          } catch {}
          db.exec("COMMIT");
        } finally {
          db.close();
        }
      } catch {}

      if (modified && activeLs) {
        try {
          await callLsRpc(activeLs, "LoadTrajectory", { cascadeId: item.cascadeId });
          reloadedIds.push(item.cascadeId);
        } catch {}
      }
    }
  } catch {}
  return reloadedIds;
}

export async function switchBillingProjectInstant(projectId, opts = {}) {
  const ls = discoverLanguageServer(false) || discoverLanguageServer(true);
  const cleanId = (projectId || "").trim();
  const cfg = readRelayConfig();
  normalizeAccountChannels(cfg);

  const cred = readWinCredToken(true) || readWinCredToken(false);
  const activeEmail = (cred?.id_token_email || cfg.__meta__?.activeEmail || "").trim();
  const existingGcp = cleanId && activeEmail ? cfg.accounts[`${activeEmail}#gcp:${cleanId}`] : null;
  const gcpBillingMode = cleanId
    ? (opts.gcpBillingMode || existingGcp?.gcpBillingMode || "agent_platform")
    : "";
  const gcpLocation = cleanId
    ? (["global", "us", "eu"].includes(opts.gcpLocation) ? opts.gcpLocation : (existingGcp?.gcpLocation || "global"))
    : "";
  const location = cleanId ? (gcpBillingMode === "agent_platform" ? gcpLocation : "") : "";

  const prevAuthMethod = cred?.auth_method || (cfg.__meta__?.lastAppliedGcpProject ? "gcp" : "consumer");
  const nextAuthMethod = cleanId ? "gcp" : "consumer";

  if (cred) {
    const cleanedCred = buildCleanChannelToken(cred, cleanId, location);
    writeWinCredToken(cleanedCred);
  }

  cfg.__meta__.lastAppliedGcpProject = cleanId;

  if (cleanId && activeEmail) {
    if (!cfg.gcpProjects.includes(cleanId)) {
      cfg.gcpProjects.push(cleanId);
    }
    const gcpKey = `${activeEmail}#gcp:${cleanId}`;
    const existing = cfg.accounts[gcpKey];
    const baseToken = findStoredTokenForEmail(cfg, activeEmail) || cred;
    cfg.accounts[gcpKey] = {
      ...existing,
      id: gcpKey,
      alias: existing?.alias || `${activeEmail} (${cleanId})`,
      email: activeEmail,
      channelType: "gcp",
      tierName: gcpBillingMode === "gemini_enterprise" ? "Gemini Enterprise" : "Agent Platform",
      gcpProjectId: cleanId,
      gcpBillingMode,
      gcpLocation,
      projectName: existing?.projectName || cleanId,
      savedAt: existing?.savedAt || new Date().toISOString(),
      storedToken: baseToken
        ? buildCleanChannelToken(baseToken, cleanId, location)
        : existing?.storedToken || null
    };
  }
  writeRelayConfig(cfg);

  if (ls) {
    try {
      await callLsRpc(ls, "ValidateProject", { projectId: cleanId, location });
    } catch {
      try {
        await callLsRpc(ls, "ValidateProject", { projectId: cleanId });
      } catch {}
    }
  }

  return { projectId: cleanId, gcpBillingMode, gcpLocation };
}

function stripThoughtSignaturesFromJson(node) {
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

function resolveBaseModelFamilyFromId(rawModelStr, cfg) {
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

function extractModelDualQuota(acc, matched, baseFamily) {
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
    // 1. 5小时限额门控：优先选 5小时限额 > 5% 的通道；达到 5小时限额 (<=5%) 时顺位切换，重置后自动切回
    if (a.fiveHourAboveThreshold !== b.fiveHourAboveThreshold) {
      return a.fiveHourAboveThreshold ? -1 : 1;
    }
    // 2. 第一层排序：按周重置时间升序（若周限额 < 5%，重置时间 +7天 进入队尾）
    if (Math.abs(a.effectiveWeeklyResetMs - b.effectiveWeeklyResetMs) > 120000) {
      return a.effectiveWeeklyResetMs - b.effectiveWeeklyResetMs;
    }
    // 3. 第二层排序：周重置时间相近时，按 5小时重置时间升序
    if (Math.abs(a.fiveHourResetMs - b.fiveHourResetMs) > 60000) {
      return a.fiveHourResetMs - b.fiveHourResetMs;
    }
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return b.weeklyPct - a.weeklyPct;
  });
  return candidates[0].acc;
}

async function getValidPersonalAccessToken(cfg, targetAcc) {
  const baseToken = targetAcc?.storedToken || findStoredTokenForEmail(cfg, targetAcc?.email);
  if (!baseToken || !baseToken.token) return "";
  let accessToken = baseToken.token.access_token || "";
  const refreshToken = baseToken.token.refresh_token || "";
  const expiryStr = baseToken.token.expiry || "";
  const expiryMs = expiryStr ? new Date(expiryStr).getTime() : 0;
  const isExpiringSoon = !accessToken || (expiryMs > 0 && expiryMs - Date.now() < 300000);

  if (isExpiringSoon && refreshToken) {
    try {
      const refreshed = await refreshOAuthAccessToken(refreshToken);
      if (refreshed && refreshed.access_token) {
        accessToken = refreshed.access_token;
        const newExpiry = new Date(Date.now() + (refreshed.expires_in || 3599) * 1000).toISOString();
        baseToken.token.access_token = accessToken;
        baseToken.token.expiry = newExpiry;
        for (const item of Object.values(cfg.accounts || {})) {
          if (item.email === targetAcc.email && item.storedToken?.token) {
            item.storedToken.token.access_token = accessToken;
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
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "antigravity-relay-proxy",
        pid: process.pid,
        port: globalThis.__agyCloudCodeProxyPort || 8091
      })
    );
    return;
  }
  const cfg = readRelayConfig();
  normalizeAccountChannels(cfg);
  const isGenerateEndpoint = /^\/v1internal:(streamGenerateContent|generateContent|countTokens)\b/i.test(reqUrl);
  const isFetchModelsEndpoint = /^\/v1internal:fetchAvailableModels\b/i.test(reqUrl);

  const outHeaders = {};
  for (const [k, v] of Object.entries(req.headers || {})) {
    const lk = k.toLowerCase();
    if (lk === "host" || lk === "connection" || lk === "content-length") continue;
    outHeaders[k] = v;
  }
  outHeaders["Host"] = "daily-cloudcode-pa.googleapis.com";

  let outBodyBuf = rawBodyBuf || Buffer.alloc(0);
  let routedTargetAcc = null;
  let strippedSigCount = 0;

  if (isGenerateEndpoint && outBodyBuf.length > 0) {
    try {
      const bodyJson = JSON.parse(outBodyBuf.toString("utf8"));
      const rawModel = String(bodyJson.model || cfg.__meta__?.lastRoutedModel || "").trim();
      const baseFamily = resolveBaseModelFamilyFromId(rawModel, cfg);
      const routeMap = cfg.routing?.models || {};
      const routeSpec = routeMap[baseFamily] || routeMap[rawModel] || "follow_current";

      // 始终在内存代理层递归剥离请求体中的 thoughtSignature，彻底消除跨账号连续对话 400 签名校验报错
      strippedSigCount = stripThoughtSignaturesFromJson(bodyJson);

      if (routeSpec === "auto_poll") {
        routedTargetAcc = selectBestPersonalChannelForModel(baseFamily, cfg);
      } else if (typeof routeSpec === "string" && routeSpec.startsWith("account:")) {
        const refId = routeSpec.slice(8).trim();
        const candidateAcc = cfg.accounts?.[refId];
        if (candidateAcc && candidateAcc.channelType !== "gcp" && !candidateAcc.gcpProjectId) {
          routedTargetAcc = candidateAcc;
        }
      }

      if (routedTargetAcc) {
        const targetToken = await getValidPersonalAccessToken(cfg, routedTargetAcc);
        if (targetToken) {
          outHeaders["authorization"] = `Bearer ${targetToken}`;
          delete outHeaders["Authorization"];
          if (!bodyJson.project || bodyJson.project === "aicode-consumers") {
            bodyJson.project = "aicode-consumers";
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
      }

      if (routedTargetAcc || strippedSigCount > 0) {
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
        hostname: "daily-cloudcode-pa.googleapis.com",
        port: 443,
        path: reqUrl,
        method: req.method || "POST",
        headers: outHeaders,
        timeout: 120000
      },
      (upRes) => {
        // 对 /v1internal:fetchAvailableModels 响应做动态配额覆盖，避免主账号某模型 0% 时前端锁死已配置路由的模型
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

const CLOUDCODE_PROXY_CANDIDATE_PORTS = [8091, 8092, 8093, 8094, 8095, 0];
globalThis.__agyCloudCodeProxyHandler = proxyCloudCodeRequest;

export function getActiveCloudCodeProxyUrl(cfg = null) {
  if (globalThis.__agyCloudCodeProxyUrl) {
    return globalThis.__agyCloudCodeProxyUrl;
  }
  const saved = String(cfg?.__meta__?.cloudCodeProxyUrl || "").trim();
  if (/^http:\/\/127\.0\.0\.1:\d+$/i.test(saved)) {
    return saved;
  }
  return "http://127.0.0.1:8091";
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
            resolve(Boolean(data && data.service === "antigravity-relay-proxy"));
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
  globalThis.__agyCloudCodeProxyUrl = proxyUrl;
  try {
    const cfg = readRelayConfig();
    if (!cfg.__meta__) cfg.__meta__ = {};
    if (cfg.__meta__.cloudCodeProxyUrl !== proxyUrl) {
      cfg.__meta__.cloudCodeProxyUrl = proxyUrl;
      writeRelayConfig(cfg);
    }
    const isLiveGcp = Boolean(cfg.__meta__.lastAppliedGcpProject);
    if (!isLiveGcp) {
      const ls = discoverLanguageServer(false);
      if (ls) {
        callLsRpc(ls, "SetCloudCodeURL", { url: proxyUrl }).catch(() => {});
      }
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
        // 若端口已被本插件另一进程占用则直接复用，若被其他无关软件占用则自动递增回退至下一端口 (8092..8095..0)
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
  // 仅当当前进程作为正式 Sidecar Web Server 启动时才自动监听本地反向代理端口，防止一次性 CLI 探测脚本因绑定监听句柄而挂起
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

  // 仅更新路由目标标记并确保个人模式下 Language Server CloudCode 网关挂载到本地透明反向代理（默认 8091，冲突时自动回退），绝不覆写系统凭据或重启 LS
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

export async function switchActiveGoogleAccount(accountId) {
  const rawId = String(accountId || "").trim();
  if (rawId.startsWith("ephemeral:")) {
    return routeChannelEphemeral(rawId.slice(10).trim());
  }
  if (rawId.startsWith("launch_instance:")) {
    return launchIsolatedAntigravityInstance(rawId.slice(16).trim());
  }
  const cfg = readRelayConfig();
  normalizeAccountChannels(cfg);
  const target = cfg.accounts?.[rawId];
  if (!target) {
    throw new Error(`未找到通道快照: ${rawId}`);
  }

  const targetProject = (target.gcpProjectId || "").trim();
  const targetBillingMode = targetProject ? (target.gcpBillingMode || "agent_platform") : "";
  const targetLocation = targetProject
    ? (targetBillingMode === "agent_platform" ? (target.gcpLocation || "global") : "")
    : "";

  const baseToken = target.storedToken || findStoredTokenForEmail(cfg, target.email);
  if (!baseToken) {
    throw new Error(`未找到账号 ${target.email} 的凭据快照`);
  }

  // 切换通道前强制刷新或校验 OAuth AccessToken 与 RFC3339 标准 ISO Expiry（防止非 RFC3339 时间格式导致 Go time.Time 解析失败报错 You are not logged into Antigravity）
  if (baseToken.token?.refresh_token) {
    try {
      const refreshed = await refreshOAuthAccessToken(baseToken.token.refresh_token);
      if (refreshed && refreshed.access_token) {
        const newExpiry = new Date(Date.now() + (refreshed.expires_in || 3599) * 1000).toISOString();
        baseToken.token.access_token = refreshed.access_token;
        baseToken.token.expiry = newExpiry;
        for (const item of Object.values(cfg.accounts || {})) {
          if (item.email === target.email && item.storedToken?.token) {
            item.storedToken.token.access_token = refreshed.access_token;
            item.storedToken.token.expiry = newExpiry;
          }
        }
      }
    } catch {}
  }

  const tokenToWrite = buildCleanChannelToken(baseToken, targetProject, targetLocation);
  target.storedToken = tokenToWrite;
  writeWinCredToken(tokenToWrite);

  cfg.__meta__.activeChannelId = target.id;
  cfg.__meta__.activeEmail = target.email;
  cfg.__meta__.lastAppliedGcpProject = targetProject;
  cfg.__meta__.lastRoutedChannelId = target.id;
  cfg.__meta__.convLastChannelMap = {};
  writeRelayConfig(cfg);

  // 点击独立通道池「启用」按钮（无论跨账号还是同账号 Pro <-> GCP）：
  // 先离线剥离最近 30 个会话 .db 中的跨通道不兼容思维签名，再异步调度重启 language_server.exe 并二次锁定 WinCred 凭据（避免旧 LS 退出回写或 Electron 杀 Sidecar 中断 HTTP 响应）
  const currentLs = discoverLanguageServer(false);
  await scrubRecentConversationsSignatures(currentLs).catch(() => {});
  scheduleDetachedLanguageServerRestart(tokenToWrite, currentLs);

  return {
    switchedTo: target.email,
    gcpProjectId: targetProject,
    channelId: target.id,
    instant: false
  };
}

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

export function computeSessionTelemetrySnapshot(cfgInput = null) {
  const cfg = cfgInput || readRelayConfig();
  const proxyTel = cfg?.__meta__?.telemetry || {};
  const brainDir = path.join(os.homedir(), ".gemini", "antigravity", "brain");

  let latestConvId = "";
  let latestLogPath = "";
  let latestMtime = 0;

  try {
    if (fs.existsSync(brainDir)) {
      const dirs = fs.readdirSync(brainDir);
      for (const d of dirs) {
        const logP = path.join(brainDir, d, ".system_generated", "logs", "transcript.jsonl");
        try {
          if (fs.existsSync(logP)) {
            const st = fs.statSync(logP);
            if (st.mtimeMs > latestMtime) {
              latestMtime = st.mtimeMs;
              latestConvId = d;
              latestLogPath = logP;
            }
          }
        } catch {}
      }
    }
  } catch {}

  let sessionInputTokens = 0;
  let sessionOutputTokens = 0;
  let lastInputTokens = 0;
  let lastOutputTokens = 0;
  let lastTokPerSec = 0;
  let totalWeightedSpeedTokens = 0;
  let totalWeightedDurationSec = 0;
  let turnCount = 0;

  if (latestLogPath && fs.existsSync(latestLogPath)) {
    try {
      const rawText = fs.readFileSync(latestLogPath, "utf8");
      const lines = rawText.split(/\r?\n/).filter(Boolean);
      let prevTimeMs = 0;
      let currentTurnIn = 0;

      for (const line of lines) {
        let row = null;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        const tsMs = row.created_at ? new Date(row.created_at).getTime() : 0;
        const stepType = String(row.type || "");
        const contentStr = typeof row.content === "string" ? row.content : JSON.stringify(row.content || "");
        const thinkingStr = typeof row.thinking === "string" ? row.thinking : "";
        const toolsStr = row.tool_calls ? JSON.stringify(row.tool_calls) : "";

        if (stepType === "USER_INPUT") {
          const inTok = estimateTokensFromString(contentStr);
          sessionInputTokens += inTok;
          currentTurnIn = inTok;
          if (tsMs > 0) prevTimeMs = tsMs;
        } else if (stepType === "PLANNER_RESPONSE") {
          const outTok = estimateTokensFromString(contentStr) + estimateTokensFromString(thinkingStr) + estimateTokensFromString(toolsStr);
          if (outTok > 0) {
            sessionOutputTokens += outTok;
            lastOutputTokens = outTok;
            if (currentTurnIn > 0) lastInputTokens = currentTurnIn;
            turnCount++;
            if (tsMs > 0 && prevTimeMs > 0 && tsMs > prevTimeMs) {
              const deltaSec = (tsMs - prevTimeMs) / 1000;
              if (deltaSec >= 0.4 && deltaSec <= 180) {
                const stepSpeed = Math.round((outTok / deltaSec) * 10) / 10;
                if (stepSpeed >= 2 && stepSpeed <= 350) {
                  lastTokPerSec = stepSpeed;
                  totalWeightedSpeedTokens += outTok;
                  totalWeightedDurationSec += deltaSec;
                }
              }
            }
          }
          if (tsMs > 0) prevTimeMs = tsMs;
        } else {
          const ctxTok = Math.round(estimateTokensFromString(contentStr) * 0.35);
          sessionInputTokens += ctxTok;
          if (tsMs > 0) prevTimeMs = tsMs;
        }
      }
    } catch {}
  }

  let avgTokPerSec = totalWeightedDurationSec > 0
    ? Math.round((totalWeightedSpeedTokens / totalWeightedDurationSec) * 10) / 10
    : 0;

  const proxyRecent = proxyTel.updatedAt && (Date.now() - Number(proxyTel.updatedAt) < 1800000);
  if (proxyRecent && Number(proxyTel.lastTokPerSec) > 0) {
    lastTokPerSec = Number(proxyTel.lastTokPerSec);
    if (Number(proxyTel.proxyAvgTokPerSec) > 0) {
      avgTokPerSec = avgTokPerSec > 0
        ? Math.round(((avgTokPerSec + Number(proxyTel.proxyAvgTokPerSec)) / 2) * 10) / 10
        : Number(proxyTel.proxyAvgTokPerSec);
    }
    if (Number(proxyTel.lastInputTokens) > 0) lastInputTokens = Number(proxyTel.lastInputTokens);
    if (Number(proxyTel.lastOutputTokens) > 0) lastOutputTokens = Number(proxyTel.lastOutputTokens);
  }

  if (avgTokPerSec <= 0 && lastTokPerSec > 0) {
    avgTokPerSec = lastTokPerSec;
  }
  if (lastTokPerSec <= 0 && avgTokPerSec > 0) {
    lastTokPerSec = avgTokPerSec;
  }

  const sessionTotalTokens = sessionInputTokens + sessionOutputTokens;

  return {
    conversationId: latestConvId ? latestConvId.slice(0, 8) : "",
    avgTokPerSec: avgTokPerSec || 0,
    lastTokPerSec: lastTokPerSec || 0,
    lastInputTokens: lastInputTokens || 0,
    lastOutputTokens: lastOutputTokens || 0,
    sessionInputTokens,
    sessionOutputTokens,
    sessionTotalTokens,
    turnCount,
    source: proxyRecent ? "live_proxy_and_session" : "session_transcript"
  };
}

function resolveAntigravityExePath() {
  const candidates = [
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

  const exePath = resolveAntigravityExePath();
  if (!exePath) {
    throw new Error("未找到本机 Antigravity.exe 可执行文件");
  }

  const targetProject = (target.gcpProjectId || "").trim();
  const targetBillingMode = targetProject ? (target.gcpBillingMode || "agent_platform") : "";
  const targetLocation = targetProject
    ? (targetBillingMode === "agent_platform" ? (target.gcpLocation || "global") : "")
    : "";

  const baseToken = target.storedToken || findStoredTokenForEmail(cfg, target.email);
  if (!baseToken) {
    throw new Error(`未找到账号 ${target.email} 的凭据快照`);
  }

  if (baseToken.token?.refresh_token) {
    try {
      const refreshed = await refreshOAuthAccessToken(baseToken.token.refresh_token);
      if (refreshed && refreshed.access_token) {
        const newExpiry = new Date(Date.now() + (refreshed.expires_in || 3599) * 1000).toISOString();
        baseToken.token.access_token = refreshed.access_token;
        baseToken.token.expiry = newExpiry;
        for (const item of Object.values(cfg.accounts || {})) {
          if (item.email === target.email && item.storedToken?.token) {
            item.storedToken.token.access_token = refreshed.access_token;
            item.storedToken.token.expiry = newExpiry;
          }
        }
      }
    } catch {}
  }

  const tokenToWrite = buildCleanChannelToken(baseToken, targetProject, targetLocation);
  target.storedToken = tokenToWrite;
  writeWinCredToken(tokenToWrite);
  writeRelayConfig(cfg);

  const safeFolder = rawId.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const instanceUserDataDir = path.join(os.homedir(), ".gemini", "antigravity-instances", safeFolder);
  const instanceUserDir = path.join(instanceUserDataDir, "User");
  const instanceGlobalStorageDir = path.join(instanceUserDir, "globalStorage");

  try {
    fs.mkdirSync(instanceGlobalStorageDir, { recursive: true });
    const mainAppDataDir = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Antigravity");
    const mainSettings = path.join(mainAppDataDir, "User", "settings.json");
    const destSettings = path.join(instanceUserDir, "settings.json");
    if (fs.existsSync(mainSettings) && !fs.existsSync(destSettings)) {
      fs.copyFileSync(mainSettings, destSettings);
    }
    const mainStorage = path.join(mainAppDataDir, "User", "globalStorage", "storage.json");
    const destStorage = path.join(instanceGlobalStorageDir, "storage.json");
    if (fs.existsSync(mainStorage) && !fs.existsSync(destStorage)) {
      fs.copyFileSync(mainStorage, destStorage);
    }
  } catch {}

  await scrubRecentConversationsSignatures(null).catch(() => {});

  const child = spawn(exePath, ["--new-window", "--user-data-dir", instanceUserDataDir], {
    detached: true,
    stdio: "ignore",
    windowsHide: false
  });
  child.unref();

  return {
    launched: true,
    pid: child.pid || 0,
    channelId: target.id,
    email: target.email,
    gcpProjectId: targetProject,
    userDataDir: instanceUserDataDir
  };
}

// 旁路隔离 OAuth 会话管理（中途取消或完成登录均绝对不打断当前账号）
let activeOAuthSession = null;

function exchangeOAuthCodeForTokens({ code, redirectUri, codeVerifier }) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      client_id: AGY_OAUTH_CLIENT_ID,
      client_secret: AGY_OAUTH_CLIENT_SECRET,
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
    try { clearTimeout(activeOAuthSession.timer); } catch (e) {}
    try { activeOAuthSession.server.close(); } catch (e) {}
    activeOAuthSession = null;
    return true;
  }
  return false;
}

export function startIsolatedOAuthFlow(onCompleteCallback) {
  cancelIsolatedOAuthFlow();

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

        const tokenResp = await exchangeOAuthCodeForTokens({ code, redirectUri, codeVerifier });
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
        const personalKey = `${email}#personal`;
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

        // 异步探测新登录个人通道的真实模型与配额，严禁自动扫描创建未使用的 GCP 项目卡片
        try {
          await probeChannelQuotaSnapshot(personalKey);
        } catch {}

        if (onCompleteCallback) onCompleteCallback({ success: true, email });
      } catch (err) {
        cancelIsolatedOAuthFlow();
        if (onCompleteCallback) onCompleteCallback({ error: err.message });
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const redirectUri = `http://localhost:${port}/auth/callback`;
      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.searchParams.set("client_id", AGY_OAUTH_CLIENT_ID);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", AGY_OAUTH_SCOPES.join(" "));
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("prompt", "consent");
      authUrl.searchParams.set("code_challenge", codeChallenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("state", state);

      const timer = setTimeout(() => {
        cancelIsolatedOAuthFlow();
        if (onCompleteCallback) onCompleteCallback({ canceled: true, timeout: true });
      }, 180000);

      activeOAuthSession = { server, timer, authUrl: authUrl.toString() };

      try {
        // 使用 Win32 原生 url.dll,FileProtocolHandler 直接拉起浏览器，避免 cmd.exe 将 URL 中的 & 截断导致缺失 response_type
        spawn("rundll32.exe", ["url.dll,FileProtocolHandler", authUrl.toString()], {
          detached: true,
          stdio: "ignore",
          windowsHide: true
        }).unref();
      } catch (e) {}

      resolve({ authUrl: authUrl.toString(), redirectUri });
    });

    server.on("error", (err) => {
      cancelIsolatedOAuthFlow();
      reject(err);
    });
  });
}
