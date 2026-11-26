// 系统代理自动探测与 HTTP CONNECT / RFC 1928 SOCKS5 隧道传输模块

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { execFile } from "node:child_process";

const SYS_PROXY_CACHE_MS = 15_000;
const noopSocketError = () => {};

let winRegProxyMemo = {
  rawOut: "",
  fetchedAtMs: 0,
  inFlight: null
};

function isLoopbackHost(hostname) {
  const host = String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0.0.0.0";
}

export function shouldBypassProxy(hostname, noProxyRaw) {
  const target = String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  const list = String(noProxyRaw || "").trim();
  if (!target || !list) return false;
  for (const part of list.split(/[;,\s]+/)) {
    const raw = part.trim().toLowerCase();
    if (!raw) continue;
    if (raw === "*") return true;
    if (raw === "<local>") {
      if (isLoopbackHost(target) || (!target.includes(".") && !target.includes(":"))) {
        return true;
      }
      continue;
    }
    const strippedPort = raw.startsWith("[")
      ? raw.replace(/^\[([^\]]+)\](?::\d+)?$/, "$1")
      : (raw.includes(":") && raw.indexOf(":") === raw.lastIndexOf(":")
          ? raw.replace(/:\d+$/, "")
          : raw);
    if (!strippedPort) continue;
    if (strippedPort.includes("*") && !(strippedPort.startsWith("*.") && !strippedPort.slice(2).includes("*"))) {
      const pattern = `^${strippedPort.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`;
      if (new RegExp(pattern, "i").test(target)) return true;
      continue;
    }
    const rule = strippedPort.replace(/^\*\./, ".");
    if (!rule) continue;
    if (rule.startsWith(".")) {
      if (target.endsWith(rule) || target === rule.slice(1)) return true;
    } else if (target === rule || target.endsWith(`.${rule}`)) {
      return true;
    }
  }
  return false;
}

export function normalizeProxyUrl(rawVal) {
  let s = String(rawVal || "").trim();
  if (!s) return "";
  if (/^socks:\/\//i.test(s)) {
    s = `socks5://${s.slice("socks://".length)}`;
  }
  const hasExplicitScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s);
  if (hasExplicitScheme && !/^(?:https?|socks5h?):\/\//i.test(s)) {
    return "";
  }
  const candidate = hasExplicitScheme ? s : `http://${s}`;
  try {
    const parsed = new URL(candidate);
    if (!parsed.hostname) return "";
    if (parsed.port) {
      const p = Number(parsed.port);
      if (!Number.isInteger(p) || p <= 0 || p > 65535) return "";
    }
    return candidate;
  } catch {
    return "";
  }
}

export function parseWindowsProxyServerValue(rawVal) {
  const srv = String(rawVal || "").trim();
  if (!srv) return "";
  if (srv.includes("=")) {
    const parts = srv.split(";").map((p) => p.trim()).filter(Boolean);
    const httpsPart = parts.find((p) => p.toLowerCase().startsWith("https="));
    const httpPart = parts.find((p) => p.toLowerCase().startsWith("http="));
    const socksPart = parts.find((p) => p.toLowerCase().startsWith("socks="));
    const chosen = httpsPart || httpPart || socksPart || "";
    if (!chosen) return "";
    const rawHostPort = chosen.slice(chosen.indexOf("=") + 1).trim();
    if (!rawHostPort) return "";
    if (chosen === socksPart && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawHostPort)) {
      return normalizeProxyUrl(`socks5://${rawHostPort}`);
    }
    return normalizeProxyUrl(rawHostPort);
  }
  return normalizeProxyUrl(srv);
}

function readWindowsInternetSettingsAsync() {
  const nowMs = Date.now();
  if (winRegProxyMemo.fetchedAtMs > 0 && nowMs - winRegProxyMemo.fetchedAtMs < SYS_PROXY_CACHE_MS) {
    return Promise.resolve(winRegProxyMemo.rawOut);
  }
  if (winRegProxyMemo.inFlight) {
    return winRegProxyMemo.inFlight;
  }
  winRegProxyMemo.inFlight = new Promise((resolveOut) => {
    execFile(
      "reg",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"],
      { encoding: "utf8", timeout: 2500, windowsHide: true },
      (err, stdout) => {
        const out = err ? "" : String(stdout || "");
        winRegProxyMemo.rawOut = out;
        winRegProxyMemo.fetchedAtMs = Date.now();
        winRegProxyMemo.inFlight = null;
        resolveOut(out);
      }
    );
  });
  return winRegProxyMemo.inFlight;
}

export async function detectSystemHttpsProxy(targetHostname = "", { env = process.env, platform = process.platform } = {}) {
  const noProxy = env?.NO_PROXY || env?.no_proxy || "";
  if (shouldBypassProxy(targetHostname, noProxy)) return "";
  const envCandidates = [env?.HTTPS_PROXY, env?.https_proxy, env?.ALL_PROXY, env?.all_proxy];
  for (const rawCandidate of envCandidates) {
    const normalized = normalizeProxyUrl(rawCandidate);
    if (normalized) return normalized;
  }
  if (platform !== "win32") return "";
  try {
    const out = await readWindowsInternetSettingsAsync();
    if (!out || !/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(out)) return "";
    const overrideMatch = out.match(/ProxyOverride\s+REG_SZ\s+([^\r\n]+)/i);
    if (overrideMatch && shouldBypassProxy(targetHostname, overrideMatch[1])) {
      return "";
    }
    const serverMatch = out.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
    return serverMatch ? parseWindowsProxyServerValue(serverMatch[1]) : "";
  } catch {
    return "";
  }
}

function safeDecodeUriPart(raw) {
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return String(raw);
  }
}

function readExactBytes(socket, count) {
  return new Promise((resolve, reject) => {
    let acc = Buffer.alloc(0);
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onErr);
      socket.off("close", onClose);
      socket.off("end", onClose);
    };
    const onErr = (err) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("SOCKS5 proxy closed connection prematurely"));
    };
    const onData = (chunk) => {
      acc = acc.length === 0 ? chunk : Buffer.concat([acc, chunk]);
      if (acc.length >= count) {
        cleanup();
        socket.pause();
        const needed = acc.subarray(0, count);
        const rest = acc.subarray(count);
        if (rest.length > 0) socket.unshift(rest);
        resolve(needed);
      }
    };
    socket.on("data", onData);
    socket.once("error", onErr);
    socket.once("close", onClose);
    socket.once("end", onClose);
    socket.resume();
  });
}

function encodeIpv6Bytes(ipv6Str) {
  let host = String(ipv6Str || "").trim().replace(/^\[|\]$/g, "");
  const zoneIdx = host.indexOf("%");
  if (zoneIdx !== -1) host = host.slice(0, zoneIdx);
  const lastColon = host.lastIndexOf(":");
  if (lastColon !== -1 && host.slice(lastColon + 1).includes(".")) {
    const v4Parts = host.slice(lastColon + 1).split(".").map((n) => Number(n));
    if (v4Parts.length !== 4 || v4Parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    const hi = ((v4Parts[0] << 8) | v4Parts[1]).toString(16);
    const lo = ((v4Parts[2] << 8) | v4Parts[3]).toString(16);
    host = `${host.slice(0, lastColon)}:${hi}:${lo}`;
  }
  const dblParts = host.split("::");
  if (dblParts.length > 2) return null;
  const left = dblParts[0] ? dblParts[0].split(":") : [];
  const right = dblParts.length === 2 && dblParts[1] ? dblParts[1].split(":") : [];
  const missing = 8 - (left.length + right.length);
  if (dblParts.length === 1 ? left.length !== 8 : missing < 1) return null;
  const groups = dblParts.length === 2 ? [...left, ...new Array(missing).fill("0"), ...right] : left;
  if (groups.length !== 8) return null;
  const buf = Buffer.allocUnsafe(16);
  for (let i = 0; i < 8; i += 1) {
    const val = Number.parseInt(groups[i], 16);
    if (!Number.isInteger(val) || val < 0 || val > 0xffff) return null;
    buf.writeUInt16BE(val, i * 2);
  }
  return buf;
}

async function connectSocks5Socket(parsedProxy, targetHost, targetPort) {
  const proxyHost = parsedProxy.hostname.replace(/^\[|\]$/g, "");
  const proxyPort = Number(parsedProxy.port || 1080);
  const rawUser = safeDecodeUriPart(parsedProxy.username);
  const rawPass = safeDecodeUriPart(parsedProxy.password);
  const hasAuth = Boolean(rawUser || rawPass);

  const socket = await new Promise((resolve, reject) => {
    const s = net.connect({ host: proxyHost, port: proxyPort });
    const onErr = (err) => {
      s.destroy();
      reject(err);
    };
    s.once("error", onErr);
    s.once("connect", () => {
      s.off("error", onErr);
      s.on("error", noopSocketError);
      resolve(s);
    });
  });

  try {
    const greeting = hasAuth
      ? Buffer.from([0x05, 0x02, 0x00, 0x02])
      : Buffer.from([0x05, 0x01, 0x00]);
    socket.write(greeting);
    const methodReply = await readExactBytes(socket, 2);
    if (methodReply[0] !== 0x05 || methodReply[1] === 0xff) {
      throw new Error("SOCKS5 proxy rejected authentication methods");
    }
    if (methodReply[1] === 0x02) {
      if (!hasAuth) throw new Error("SOCKS5 proxy requires authentication");
      const userBuf = Buffer.from(rawUser, "utf8");
      const passBuf = Buffer.from(rawPass, "utf8");
      if (userBuf.length > 255 || passBuf.length > 255) {
        throw new Error("SOCKS5 credentials exceed 255 bytes");
      }
      socket.write(Buffer.concat([
        Buffer.from([0x01, userBuf.length]),
        userBuf,
        Buffer.from([passBuf.length]),
        passBuf
      ]));
      const authReply = await readExactBytes(socket, 2);
      if (authReply[1] !== 0x00) {
        throw new Error("SOCKS5 authentication failed");
      }
    } else if (methodReply[1] !== 0x00) {
      throw new Error(`Unsupported SOCKS5 auth method (${methodReply[1]})`);
    }

    const cleanHost = String(targetHost || "").replace(/^\[|\]$/g, "");
    const ipVer = net.isIP(cleanHost);
    let addrPart;
    if (ipVer === 4) {
      const octets = cleanHost.split(".").map((n) => Number(n));
      addrPart = Buffer.from([0x01, octets[0], octets[1], octets[2], octets[3]]);
    } else if (ipVer === 6) {
      const ipv6Bytes = encodeIpv6Bytes(cleanHost);
      if (!ipv6Bytes) throw new Error("Invalid SOCKS5 target IPv6 address");
      addrPart = Buffer.concat([Buffer.from([0x04]), ipv6Bytes]);
    } else {
      const hostBuf = Buffer.from(cleanHost, "utf8");
      if (hostBuf.length === 0 || hostBuf.length > 255) {
        throw new Error("Invalid SOCKS5 target hostname");
      }
      addrPart = Buffer.concat([Buffer.from([0x03, hostBuf.length]), hostBuf]);
    }
    const portBuf = Buffer.allocUnsafe(2);
    portBuf.writeUInt16BE(Number(targetPort), 0);
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addrPart, portBuf]));

    const repHead = await readExactBytes(socket, 4);
    if (repHead[0] !== 0x05 || repHead[1] !== 0x00) {
      throw new Error(`SOCKS5 CONNECT failed (code ${repHead[1]})`);
    }
    const atyp = repHead[3];
    if (atyp === 0x01) {
      await readExactBytes(socket, 6);
    } else if (atyp === 0x03) {
      const lenBuf = await readExactBytes(socket, 1);
      await readExactBytes(socket, lenBuf[0] + 2);
    } else if (atyp === 0x04) {
      await readExactBytes(socket, 18);
    } else {
      throw new Error(`Unsupported SOCKS5 reply address type (${atyp})`);
    }
    socket.resume();
    return socket;
  } catch (err) {
    socket.destroy();
    throw err;
  }
}

export function openProxyTunnelSocket(targetHost, targetPort, proxyUrl, { timeoutMs = 4500 } = {}) {
  const normalizedUrl = normalizeProxyUrl(proxyUrl);
  if (!normalizedUrl) return Promise.resolve(null);
  const parsedProxy = new URL(normalizedUrl);
  const cleanTargetHost = String(targetHost || "").replace(/^\[|\]$/g, "");
  const sniOpts = net.isIP(cleanTargetHost) !== 0 ? {} : { servername: cleanTargetHost };
  const connectAuthority = cleanTargetHost.includes(":")
    ? `[${cleanTargetHost}]:${targetPort}`
    : `${cleanTargetHost}:${targetPort}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    let connectReq = null;
    let rawSocket = null;
    let tlsSocket = null;

    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => fail(new Error(`Proxy tunnel timed out after ${timeoutMs}ms`)), timeoutMs)
      : null;
    timer?.unref?.();

    function cleanupTimer() {
      if (timer) clearTimeout(timer);
    }

    function fail(err) {
      if (settled) return;
      settled = true;
      cleanupTimer();
      try { connectReq?.destroy(); } catch {}
      try { tlsSocket?.destroy(); } catch {}
      try { rawSocket?.destroy(); } catch {}
      reject(err);
    }

    function upgradeToTls(sock, headBuf = null) {
      rawSocket = sock;
      sock.on("error", noopSocketError);
      if (headBuf && headBuf.length > 0) {
        sock.unshift(headBuf);
      }
      tlsSocket = tls.connect({
        socket: sock,
        ALPNProtocols: ["http/1.1"],
        ...sniOpts
      });
      tlsSocket.on("error", noopSocketError);
      tlsSocket.once("secureConnect", () => {
        if (settled) {
          tlsSocket.destroy();
          return;
        }
        settled = true;
        cleanupTimer();
        tlsSocket.off("error", fail);
        resolve(tlsSocket);
      });
      tlsSocket.once("error", fail);
    }

    const proto = parsedProxy.protocol.toLowerCase();
    if (proto === "socks5:" || proto === "socks5h:") {
      connectSocks5Socket(parsedProxy, cleanTargetHost, targetPort)
        .then((sock) => {
          if (settled) {
            sock.destroy();
            return;
          }
          upgradeToTls(sock);
        })
        .catch(fail);
      return;
    }

    const isHttpsProxy = proto === "https:";
    const proxyTransport = isHttpsProxy ? https : http;
    const headers = { Host: connectAuthority };
    if (parsedProxy.username || parsedProxy.password) {
      const user = safeDecodeUriPart(parsedProxy.username);
      const pass = safeDecodeUriPart(parsedProxy.password);
      headers["Proxy-Authorization"] = `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;
    }

    connectReq = proxyTransport.request({
      hostname: parsedProxy.hostname.replace(/^\[|\]$/g, ""),
      port: Number(parsedProxy.port || (isHttpsProxy ? 443 : 80)),
      method: "CONNECT",
      path: connectAuthority,
      headers
    });
    connectReq.on("connect", (res, socket, head) => {
      socket.on("error", noopSocketError);
      if (settled) {
        socket.destroy();
        return;
      }
      if (res.statusCode !== 200) {
        socket.destroy();
        fail(new Error(`Proxy CONNECT failed (${res.statusCode})`));
        return;
      }
      upgradeToTls(socket, head);
    });
    connectReq.on("error", fail);
    connectReq.end();
  });
}

export async function createProxiedHttpsAgent(targetHostname, targetPort = 443, { timeoutMs = 4500 } = {}) {
  const proxyUrl = await detectSystemHttpsProxy(targetHostname);
  if (!proxyUrl) {
    return { agent: null, proxyUrl: "", cleanup: () => {} };
  }
  try {
    const tlsSocket = await openProxyTunnelSocket(targetHostname, targetPort, proxyUrl, { timeoutMs });
    if (!tlsSocket) {
      return { agent: null, proxyUrl: "", cleanup: () => {} };
    }
    let consumed = false;
    let cleaned = false;
    const agent = new https.Agent({ keepAlive: false });
    agent.createConnection = () => {
      consumed = true;
      return tlsSocket;
    };
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (!consumed) {
        try { tlsSocket.destroy(); } catch {}
      }
      try { agent.destroy(); } catch {}
    };
    return { agent, proxyUrl, cleanup };
  } catch {
    return { agent: null, proxyUrl: "", fallbackDirect: true, cleanup: () => {} };
  }
}
