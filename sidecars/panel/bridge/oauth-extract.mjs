// 从本机 Antigravity PE64 二进制动态提取官方 OAuth Client ID 与 Secret（零源码硬编码）

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const OAUTH_CLIENT_ID_RE = /^\d+-[\w-]+\.apps\.googleusercontent\.com$/;
const OAUTH_CLIENT_SECRET_RE = /^GOCSPX-[\w-]+$/;

const PE_ID_LEN_OP = Buffer.from([0x48, 0xc7, 0x40, 0x08]);
const PE_LEA_RIP_OP = Buffer.from([0x48, 0x8d, 0x0d]);
const PE_BETWEEN_OP = Buffer.from([0x48, 0x89, 0x08, 0x48, 0xc7, 0x40, 0x18]);

let cachedNativeOAuthClients = null;

function resolveHomeDir() {
  const realEnv = String(process.env.AGY_REAL_USERPROFILE || "").trim();
  if (realEnv && fs.existsSync(realEnv)) return path.normalize(realEnv);
  return os.homedir();
}

export function parsePeTextAndRdata(headerBuf) {
  if (!Buffer.isBuffer(headerBuf) || headerBuf.length < 64) return null;
  const pe = headerBuf.readUInt16LE(0) === 0x5a4d ? headerBuf.readUInt32LE(60) : 0;
  if (!pe || pe + 24 > headerBuf.length || headerBuf.readUInt32LE(pe) !== 0x4550 || headerBuf.readUInt16LE(pe + 4) !== 0x8664) {
    return null;
  }
  const count = headerBuf.readUInt16LE(pe + 6);
  const table = pe + 24 + headerBuf.readUInt16LE(pe + 20);
  if (table + count * 40 > headerBuf.length) return null;

  let text = null;
  let rodata = null;
  for (let i = 0; i < count; i += 1) {
    const offset = table + i * 40;
    const name = headerBuf.toString("ascii", offset, offset + 8).replace(/\0+$/, "");
    const section = {
      name,
      rva: headerBuf.readUInt32LE(offset + 12),
      size: headerBuf.readUInt32LE(offset + 16),
      start: headerBuf.readUInt32LE(offset + 20)
    };
    if (name === ".text") text = section;
    else if (name === ".rdata") rodata = section;
  }
  return text && rodata ? { text, rodata } : null;
}

function scanGoOAuthInitializerMatches(machineCode, textRva, rodata) {
  const matches = [];
  for (
    let i = machineCode.indexOf(PE_ID_LEN_OP);
    i >= 0 && i + 33 <= machineCode.length;
    i = machineCode.indexOf(PE_ID_LEN_OP, i + 1)
  ) {
    if (
      !machineCode.subarray(i + 8, i + 11).equals(PE_LEA_RIP_OP) ||
      !machineCode.subarray(i + 15, i + 22).equals(PE_BETWEEN_OP) ||
      !machineCode.subarray(i + 26, i + 29).equals(PE_LEA_RIP_OP)
    ) {
      continue;
    }
    const idLen = machineCode.readUInt32LE(i + 4);
    const secretLen = machineCode.readUInt32LE(i + 22);
    if (idLen <= 0 || idLen > 100 || secretLen <= 0 || secretLen > 100) continue;
    const idRva = textRva + (i + 11) + 4 + machineCode.readInt32LE(i + 11);
    const secretRva = textRva + (i + 29) + 4 + machineCode.readInt32LE(i + 29);
    const idOffset = idRva - rodata.rva;
    const secretOffset = secretRva - rodata.rva;
    if (
      idOffset < 0 ||
      idOffset + idLen > rodata.size ||
      secretOffset < 0 ||
      secretOffset + secretLen > rodata.size
    ) {
      continue;
    }
    matches.push({ idOffset, idLen, secretOffset, secretLen });
  }
  return matches;
}

function fallbackScanRdataPairs(fd, rodata) {
  const clients = new Map();
  const chunkSize = 2 * 1024 * 1024;
  const overlap = 4096;
  const secretGlobalRe = /GOCSPX-[\w-]{12,64}/g;
  const idGlobalRe = /\d{6,20}-[\w-]{16,64}\.apps\.googleusercontent\.com/g;

  for (let rel = 0; rel < rodata.size; rel += chunkSize - overlap) {
    const len = Math.min(chunkSize, rodata.size - rel);
    if (len <= 0) break;
    const buf = Buffer.allocUnsafe(len);
    const read = fs.readSync(fd, buf, 0, len, rodata.start + rel);
    if (read <= 0) break;
    const ascii = buf.subarray(0, read).toString("latin1");
    secretGlobalRe.lastIndex = 0;
    let secMatch;
    while ((secMatch = secretGlobalRe.exec(ascii)) !== null) {
      const secret = secMatch[0];
      if (!OAUTH_CLIENT_SECRET_RE.test(secret)) continue;
      const winStart = Math.max(0, secMatch.index - 4096);
      const winEnd = Math.min(ascii.length, secMatch.index + secret.length + 4096);
      const win = ascii.slice(winStart, winEnd);
      idGlobalRe.lastIndex = 0;
      const idMatch = idGlobalRe.exec(win);
      if (idMatch && OAUTH_CLIENT_ID_RE.test(idMatch[0])) {
        clients.set(idMatch[0], { clientId: idMatch[0], clientSecret: secret });
      }
    }
    if (rel + len >= rodata.size) break;
  }
  return Array.from(clients.values()).reverse();
}

export function extractNativeOAuthClientsFromFileSync(filePath) {
  if (!filePath) return [];
  let fd = null;
  try {
    fd = fs.openSync(filePath, "r");
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size < 64) return [];

    const headerLen = Math.min(4096, st.size);
    const headerBuf = Buffer.allocUnsafe(headerLen);
    fs.readSync(fd, headerBuf, 0, headerLen, 0);
    const sections = parsePeTextAndRdata(headerBuf);
    if (!sections) return [];

    const { text, rodata } = sections;
    if (text.start + text.size > st.size || rodata.start + rodata.size > st.size) {
      return [];
    }

    const textBuf = Buffer.allocUnsafe(text.size);
    let offset = 0;
    while (offset < text.size) {
      const n = fs.readSync(fd, textBuf, offset, text.size - offset, text.start + offset);
      if (n <= 0) break;
      offset += n;
    }

    const matches = scanGoOAuthInitializerMatches(textBuf.subarray(0, offset), text.rva, rodata);
    const clients = new Map();
    for (const m of matches) {
      const idBuf = Buffer.allocUnsafe(m.idLen);
      const secBuf = Buffer.allocUnsafe(m.secretLen);
      const idRead = fs.readSync(fd, idBuf, 0, m.idLen, rodata.start + m.idOffset);
      const secRead = fs.readSync(fd, secBuf, 0, m.secretLen, rodata.start + m.secretOffset);
      if (idRead !== m.idLen || secRead !== m.secretLen) continue;
      const clientId = idBuf.toString("ascii");
      const clientSecret = secBuf.toString("ascii");
      if (OAUTH_CLIENT_ID_RE.test(clientId) && OAUTH_CLIENT_SECRET_RE.test(clientSecret)) {
        clients.set(clientId, { clientId, clientSecret });
      }
    }

    if (clients.size > 0) {
      return Array.from(clients.values()).reverse();
    }
    return fallbackScanRdataPairs(fd, rodata);
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

export function collectNativeOAuthBinaryCandidates({ env = process.env, homeDir = resolveHomeDir() } = {}) {
  const seen = new Set();
  const candidates = [];
  const add = (filePath) => {
    const clean = String(filePath || "").trim();
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(clean);
  };
  const addFromInstallRoot = (installRoot) => {
    if (!installRoot) return;
    add(path.join(installRoot, "resources", "bin", "language_server.exe"));
    add(path.join(installRoot, "resources", "app", "extensions", "antigravity", "bin", "language_server_windows_x64.exe"));
  };

  add(env?.ANTIGRAVITY_LS_BIN);
  const hints = [
    env?.ANTIGRAVITY_AGENTAPI_EXE,
    env?.CHROME_DEVTOOLS_MCP_JS,
    process.execPath
  ];
  for (const rawHint of hints) {
    const hint = String(rawHint || "").trim();
    if (!hint) continue;
    const leaf = path.basename(hint).toLowerCase();
    if (/^(?:language_server.*|agy)\.exe$/i.test(leaf)) {
      add(hint);
      continue;
    }
    if (/\.exe$/i.test(leaf)) {
      addFromInstallRoot(path.dirname(hint));
    }
    let cur = hint;
    for (let depth = 0; depth < 8 && cur && path.dirname(cur) !== cur; depth += 1) {
      if (path.basename(cur).toLowerCase() === "resources") {
        addFromInstallRoot(path.dirname(cur));
        break;
      }
      cur = path.dirname(cur);
    }
  }

  const localAppData = String(env?.LOCALAPPDATA || "").trim() || path.join(homeDir, "AppData", "Local");
  const programFiles = String(env?.ProgramFiles || "").trim() || "C:\\Program Files";
  const geminiBase = String(env?.ANTIGRAVITY_GEMINI_DIR || "").trim() || path.join(homeDir, ".gemini");
  addFromInstallRoot(path.join(localAppData, "Programs", "Antigravity"));
  addFromInstallRoot(path.join(localAppData, "Programs", "Antigravity IDE"));
  addFromInstallRoot(path.join(programFiles, "Antigravity"));
  addFromInstallRoot(path.join(programFiles, "Antigravity IDE"));
  add(path.join(geminiBase, "bin", "agy.exe"));

  return candidates.filter((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

function discoverRunningOAuthBinaryPathsSync() {
  if (process.platform !== "win32") return [];
  const shell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const cmd =
    "Get-CimInstance Win32_Process -Filter \"Name LIKE 'language_server%' OR Name LIKE 'agy%'\" | Select-Object -ExpandProperty ExecutablePath -Unique";
  try {
    const out = execFileSync(shell, ["-NoProfile", "-NonInteractive", "-Command", cmd], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true
    });
    return String(out || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((p) => p && /^(?:language_server.*|agy)\.exe$/i.test(path.basename(p)));
  } catch {
    return [];
  }
}

export function getDynamicOAuthClientsSync(force = false) {
  if (!force && Array.isArray(cachedNativeOAuthClients) && cachedNativeOAuthClients.length > 0) {
    return cachedNativeOAuthClients;
  }
  const tried = new Set();
  for (const filePath of collectNativeOAuthBinaryCandidates()) {
    tried.add(filePath.toLowerCase());
    const clients = extractNativeOAuthClientsFromFileSync(filePath);
    if (clients.length > 0) {
      cachedNativeOAuthClients = Object.freeze(clients.map((c) => Object.freeze({ ...c })));
      return cachedNativeOAuthClients;
    }
  }
  for (const filePath of discoverRunningOAuthBinaryPathsSync()) {
    const key = String(filePath || "").trim().toLowerCase();
    if (!key || tried.has(key)) continue;
    tried.add(key);
    const clients = extractNativeOAuthClientsFromFileSync(filePath);
    if (clients.length > 0) {
      cachedNativeOAuthClients = Object.freeze(clients.map((c) => Object.freeze({ ...c })));
      return cachedNativeOAuthClients;
    }
  }
  return [];
}

export function clearDynamicOAuthCache() {
  cachedNativeOAuthClients = null;
}
