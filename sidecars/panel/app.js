// 全局状态管理、主题与多语言同步、第 4 板块（模型算力路由）与 API / SSE 通信主控制器

let savedLang = null;
try { savedLang = localStorage.getItem("agy_relay_lang"); } catch (e) {}
const defaultBrowserLang = (typeof navigator !== "undefined" && typeof navigator.language === "string" && /^zh\b/i.test(navigator.language)) ? "zh" : "en";
let currentLang = (savedLang === "en" || savedLang === "zh") ? savedLang : defaultBrowserLang;

let state = {
  lsOnline: false,
  activeAccount: { email: "", tierName: "Google AI Pro", gcpProjectId: "", channelId: "" },
  availableModels: [],
  quotaGroups: [],
  accounts: [],
  gcpProjects: [],
  routing: { models: {}, subagentDefaultTarget: "follow_current" },
  oauthPending: false
};

// 顶部「账户模型额度」当前选中的查看通道 ID（空字符串表示跟随当前激活通道）
let selectedQuotaChannelId = "";
// 第 2 板块「当前会话统计」当前选中的查看会话 ID（空字符串表示跟随当前活跃会话，__PROJECT_TOTAL__ 表示项目全部会话汇总）
let selectedTelemetryConvId = "";
// 当前处于待二次确认删除状态的通道 ID
let pendingDeleteAccountId = "";
let pendingDeleteTimer = null;
// 当前处于跨通道切换待确认是否清除签名的通道 ID
let pendingCrossSwitchAccountId = "";
// 当前处于「切换中...」过渡态的目标通道 ID（等待底层完成切换与界面刷新后才变为「使用中」）
let switchingAccountId = "";
// 顶部手动清除签名确认抽屉与多开实例抽屉开关状态
let isScrubSigsDrawerOpen = false;
let isMultiInstanceDrawerOpen = false;
let selectedMultiInstanceTargetId = "";
// 当前展开编辑设置的 GCP 通道卡片 ID 集合与顶部添加 GCP 抽屉开关状态
let expandedGcpConfigIds = new Set();
let isAddGcpDrawerOpen = false;
let addGcpDraft = {
  sourceMode: "new_oauth",
  channelType: "personal",
  email: "",
  gcpBillingMode: "agent_platform",
  gcpLocation: "global",
  projectId: "",
  scannedProjects: []
};

function showToast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.style.display = "block";
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => {
    el.style.display = "none";
  }, 2600);
}

// 自动跟随 Antigravity 宿主与系统深浅色主题（无手动按钮）
window.addEventListener("message", (event) => {
  if (event.data && event.data.type === "theme-change") {
    const vars = event.data.payload?.cssVariables || {};
    let bg = (vars["--background"] || vars["--bg-base"] || vars["--vscode-editor-background"] || "").trim().toLowerCase();
    if (bg) {
      const isLight = bg.startsWith("#f") || bg.startsWith("#e") || bg.startsWith("#d") || bg === "white" || bg.startsWith("rgb(25") || bg.startsWith("rgb(24");
      const mode = isLight ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", mode);
      try { localStorage.setItem("antigravity_theme_mode", mode); } catch (e) {}
    }
  }
});

if (window.matchMedia) {
  try {
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", (e) => {
      const mode = e.matches ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", mode);
    });
  } catch (e) {}
}

// 点击空白处收起所有悬浮下拉框
document.addEventListener("click", (e) => {
  if (!e.target.closest(".custom-dropdown")) {
    document.querySelectorAll(".custom-dropdown.open").forEach((el) => el.classList.remove("open"));
  }
});

function toggleLanguage() {
  currentLang = currentLang === "zh" ? "en" : "zh";
  try { localStorage.setItem("agy_relay_lang", currentLang); } catch (e) {}
  applyI18n();
  fetch("/api/set-language", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lang: currentLang })
  }).catch(() => {});
}

function applyI18n() {
  const t = I18N[currentLang];
  document.getElementById("uiAppTitle").textContent = t.appTitle;
  document.getElementById("langToggleBtn").textContent = t.langBtn;
  document.getElementById("refreshBtn").textContent = t.refreshBtn;
  document.getElementById("secCurrentTitle").textContent = t.secCurrentTitle;
  const telTitleEl = document.getElementById("secTelemetryTitle");
  if (telTitleEl && t.secTelemetryTitle) {
    telTitleEl.textContent = t.secTelemetryTitle;
  }
  document.getElementById("secAccountsTitle").textContent = t.secAccountsTitle;
  const scrubBtn = document.getElementById("btnScrubSignatures");
  if (scrubBtn) scrubBtn.textContent = t.btnScrubSignatures;
  const multiDrawerBtn = document.getElementById("btnToggleMultiInstance");
  if (multiDrawerBtn) multiDrawerBtn.textContent = t.btnOpenMultiDrawer;
  const addGcpBtn = document.getElementById("btnToggleAddGcp");
  if (addGcpBtn) addGcpBtn.textContent = t.btnAddGcpChannel;
  document.getElementById("btnCaptureCurrent").textContent = t.btnCaptureCurrent;
  document.getElementById("btnAddOAuthAccount").textContent = t.btnAddOAuth;
  document.getElementById("oauthBannerText").textContent = t.oauthBannerText;
  document.getElementById("btnCancelOAuth").textContent = t.btnCancelOAuth;
  document.getElementById("secRoutingTitle").textContent = t.secRoutingTitle;
  document.getElementById("secRoutingHint").textContent = t.secRoutingHint;
  renderAll();
}

function renderAll() {
  const t = I18N[currentLang];
  const lsBadge = document.getElementById("uiLsBadge");
  if (state.lsOnline) {
    lsBadge.textContent = t.online;
    lsBadge.classList.remove("offline");
  } else {
    lsBadge.textContent = t.offline;
    lsBadge.classList.add("offline");
  }

  const oauthBanner = document.getElementById("oauthPendingBanner");
  oauthBanner.style.display = state.oauthPending ? "flex" : "none";

  renderSessionSelector();
  renderQuotaGroups();
  renderSessionTelemetry();
  renderScrubSignaturesDrawer();
  renderMultiInstanceDrawer();
  renderAddGcpDrawer();
  renderAccountList();
  renderRoutingList();
}

function getPoolModelsForScope(isGcpScope = false) {
  const modelMap = new Map();
  const addModelEntry = (m, isFromGcp) => {
    if (!m) return;
    const rawLabel = String(m.label || m.modelId || "").trim();
    if (!rawLabel) return;
    const baseLabel = rawLabel.replace(/\s*\((Low|Medium|High|Max)\)\s*$/i, "").trim();
    const vars = Array.isArray(m.variantIds) ? m.variantIds : [baseLabel, rawLabel];
    if (!modelMap.has(baseLabel)) {
      modelMap.set(baseLabel, {
        label: baseLabel,
        modelId: baseLabel,
        variantIds: Array.from(new Set([baseLabel, rawLabel, ...vars])),
        remainingPct: isFromGcp ? 100 : (m.remainingPct ?? 100),
        resetTime: isFromGcp ? "" : (m.resetTime || ""),
        unlimited: Boolean(isFromGcp || m.unlimited)
      });
    } else {
      const existing = modelMap.get(baseLabel);
      for (const v of [rawLabel, ...vars]) {
        if (v && !existing.variantIds.includes(v)) {
          existing.variantIds.push(v);
        }
      }
    }
  };

  if (isGcpScope) {
    // GCP 通道激活时，仅汇总已收录 GCP 通道与当前活跃 GCP 会话支持的模型
    for (const acc of (state.accounts || [])) {
      const isGcp = acc.channelType === "gcp" || Boolean(acc.gcpProjectId);
      if (!isGcp) continue;
      for (const m of (acc.cachedQuota?.availableModels || [])) {
        addModelEntry(m, true);
      }
    }
    if (state.activeAccount?.gcpProjectId) {
      for (const m of (state.availableModels || [])) {
        addModelEntry(m, true);
      }
    }
  } else {
    // 个人通道激活时，仅汇总已收录个人通道（Free / Plus / Pro / Ultra）支持的模型
    for (const acc of (state.accounts || [])) {
      const isGcp = acc.channelType === "gcp" || Boolean(acc.gcpProjectId);
      if (isGcp) continue;
      for (const m of (acc.cachedQuota?.availableModels || [])) {
        addModelEntry(m, false);
      }
    }
    if (modelMap.size === 0 && !state.activeAccount?.gcpProjectId) {
      for (const m of (state.availableModels || [])) {
        addModelEntry(m, false);
      }
    }
  }

  const preferredOrder = [
    "Gemini 4 Argon",
    "Gemini 3.8 Flash",
    "Gemini 3.7 Flash",
    "Gemini 3.6 Flash",
    "Gemini 3.1 Pro",
    "Claude Opus 5.5",
    "Claude Sonnet 5.5"
  ];

  return Array.from(modelMap.values()).sort((a, b) => {
    const idxA = preferredOrder.findIndex((p) => p.toLowerCase() === a.modelId.toLowerCase());
    const idxB = preferredOrder.findIndex((p) => p.toLowerCase() === b.modelId.toLowerCase());
    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;
    return a.label.localeCompare(b.label);
  });
}

function buildRouteOptionsList(modelObj = null, isGcpScope = false) {
  const t = I18N[currentLang];
  if (isGcpScope) {
    // GCP 通道专属路由表：无自动轮询，不混入任何个人账号，仅提供「跟随当前 GCP 通道」与手选其他已收录 GCP 通道
    const gcpOptions = [
      { value: "follow_current", label: t.routeFollowCurrentGcp || t.routeFollowCurrent, badgeType: "", badgeText: "" }
    ];
    const seenGcp = new Set(["follow_current"]);
    for (const acc of (state.accounts || [])) {
      const isGcp = acc.channelType === "gcp" || Boolean(acc.gcpProjectId);
      if (!isGcp) continue;
      if (modelObj && acc.cachedQuota?.availableModels?.length && !findModelInChannel(acc, modelObj)) {
        continue;
      }
      const val = `account:${acc.id}`;
      if (seenGcp.has(val)) continue;
      seenGcp.add(val);
      const badgeInfo = getChannelBadgeInfo(acc);
      gcpOptions.push({
        value: val,
        label: acc.gcpProjectId ? `${acc.email} · ${acc.gcpProjectId}` : acc.email,
        badgeType: badgeInfo.badgeType,
        badgeText: badgeInfo.badgeText
      });
    }
    return gcpOptions;
  }

  const options = [
    { value: "follow_current", label: t.routeFollowCurrent, badgeType: "", badgeText: "" },
    { value: "auto_poll", label: t.routeAutoPoll, badgeType: "", badgeText: "" }
  ];

  const seenValues = new Set(["follow_current", "auto_poll"]);

  for (const acc of (state.accounts || [])) {
    const isGcp = acc.channelType === "gcp" || Boolean(acc.gcpProjectId);
    // 个人通道路由表仅列出个人账号（Free / Plus / Pro / Ultra），绝不混入 GCP 通道
    if (isGcp) continue;
    if (modelObj && !findModelInChannel(acc, modelObj)) {
      continue;
    }
    const val = `account:${acc.id}`;
    if (seenValues.has(val)) continue;
    seenValues.add(val);
    const badgeInfo = getChannelBadgeInfo(acc);
    options.push({
      value: val,
      label: acc.email,
      badgeType: badgeInfo.badgeType,
      badgeText: badgeInfo.badgeText
    });
  }

  return options;
}

function createCustomDropdown(selectedValue, onSelect, modelObj = null, isGcpScope = false) {
  const options = buildRouteOptionsList(modelObj, isGcpScope);
  const activeOpt = options.find((o) => o.value === selectedValue) || options[0];

  const wrapper = document.createElement("div");
  wrapper.className = "custom-dropdown";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "dropdown-trigger";

  const triggerLeft = document.createElement("div");
  triggerLeft.className = "active-email-wrap";

  if (activeOpt.badgeText) {
    const trigBadge = document.createElement("span");
    trigBadge.className = "channel-type-badge " + activeOpt.badgeType;
    trigBadge.textContent = activeOpt.badgeText;
    triggerLeft.appendChild(trigBadge);
  }

  const triggerText = document.createElement("span");
  triggerText.className = "dropdown-trigger-text";
  triggerText.textContent = activeOpt.label;
  triggerLeft.appendChild(triggerText);

  const arrowSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  arrowSvg.setAttribute("class", "dropdown-arrow");
  arrowSvg.setAttribute("viewBox", "0 0 16 16");
  arrowSvg.setAttribute("fill", "none");
  arrowSvg.innerHTML = `<path d="M4 6L8 10L12 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;

  trigger.appendChild(triggerLeft);
  trigger.appendChild(arrowSvg);

  const menu = document.createElement("div");
  menu.className = "dropdown-menu";

  for (const opt of options) {
    const item = document.createElement("div");
    item.className = "dropdown-option" + (opt.value === activeOpt.value ? " active" : "");

    const itemLeft = document.createElement("div");
    itemLeft.className = "active-email-wrap";

    if (opt.badgeText) {
      const optBadge = document.createElement("span");
      optBadge.className = "channel-type-badge " + opt.badgeType;
      optBadge.textContent = opt.badgeText;
      itemLeft.appendChild(optBadge);
    }

    const itemLabel = document.createElement("span");
    itemLabel.className = "dropdown-option-label";
    itemLabel.textContent = opt.label;
    itemLeft.appendChild(itemLabel);

    const checkSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    checkSvg.setAttribute("class", "check-icon");
    checkSvg.setAttribute("viewBox", "0 0 16 16");
    checkSvg.setAttribute("fill", "none");
    checkSvg.innerHTML = `<path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;

    item.appendChild(itemLeft);
    item.appendChild(checkSvg);

    item.onclick = (ev) => {
      ev.stopPropagation();
      wrapper.classList.remove("open");
      if (opt.value !== activeOpt.value) {
        onSelect(opt.value);
      }
    };

    menu.appendChild(item);
  }

  trigger.onclick = (ev) => {
    ev.stopPropagation();
    const isOpen = wrapper.classList.contains("open");
    document.querySelectorAll(".custom-dropdown.open").forEach((el) => el.classList.remove("open"));
    if (!isOpen) {
      const rect = wrapper.getBoundingClientRect();
      if (window.innerHeight - rect.bottom < 190) {
        wrapper.classList.add("drop-up");
      } else {
        wrapper.classList.remove("drop-up");
      }
      wrapper.classList.add("open");
    }
  };

  wrapper.appendChild(trigger);
  wrapper.appendChild(menu);
  return wrapper;
}

function findModelInChannel(acc, modelObj) {
  const list = acc?.cachedQuota?.availableModels || [];
  const targetId = (modelObj.modelId || modelObj.label || "").toLowerCase();
  const direct = list.find((item) => {
    const id = (item.modelId || item.label || "").toLowerCase();
    return id === targetId;
  });
  if (direct) return direct;
  return null;
}

const WEEK_PENALTY_MS = 7 * 24 * 3600 * 1000;

function extractModelDualQuotaUi(acc, matched, m) {
  const now = Date.now();
  const defaultWeeklyMs = now + WEEK_PENALTY_MS;
  const groups = acc?.cachedQuota?.quotaGroups || [];
  const clean = String(m?.label || m?.modelId || matched?.label || matched?.modelId || "").toLowerCase();

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
  const weeklyResetTime = matched?.weeklyResetTime || bWk?.resetTime || matched?.resetTime || "";
  const parsedWkMs = weeklyResetTime ? new Date(weeklyResetTime).getTime() : defaultWeeklyMs;
  const weeklyResetMs = Number.isFinite(parsedWkMs) && parsedWkMs > 0 ? parsedWkMs : defaultWeeklyMs;

  const fiveHourPct = Number(
    matched?.fiveHourPct ?? b5h?.remainingPct ?? weeklyPct
  );
  const fiveHourResetTime = matched?.fiveHourResetTime || b5h?.resetTime || weeklyResetTime;
  const parsed5hMs = fiveHourResetTime ? new Date(fiveHourResetTime).getTime() : weeklyResetMs;
  const fiveHourResetMs = Number.isFinite(parsed5hMs) && parsed5hMs > 0 ? parsed5hMs : weeklyResetMs;

  return {
    weeklyPct,
    weeklyResetTime,
    weeklyResetMs,
    fiveHourPct,
    fiveHourResetTime,
    fiveHourResetMs,
    hasDistinct5h: Boolean(b5h || (matched?.fiveHourResetTime && matched.fiveHourResetTime !== matched.weeklyResetTime))
  };
}

function selectAutoPollChannel(accounts, m, activeChannelId, thresholdPct = 5) {
  const candidates = [];
  for (const acc of accounts) {
    const isGcp = acc.channelType === "gcp" || Boolean(acc.gcpProjectId);
    if (isGcp) continue;
    const matched = findModelInChannel(acc, m);
    if (!matched) continue;
    const dual = extractModelDualQuotaUi(acc, matched, m);
    if (dual.weeklyPct <= 0 || dual.fiveHourPct <= 0) continue;

    const weeklyLow = dual.weeklyPct < thresholdPct;
    const effectiveWeeklyResetMs = dual.weeklyResetMs + (weeklyLow ? WEEK_PENALTY_MS : 0);
    const fiveHourAboveThreshold = dual.fiveHourPct > thresholdPct;

    candidates.push({
      acc,
      matched,
      dual,
      isGcp: false,
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
    if (a.fiveHourAboveThreshold !== b.fiveHourAboveThreshold) {
      return a.fiveHourAboveThreshold ? -1 : 1;
    }
    if (Math.abs(a.effectiveWeeklyResetMs - b.effectiveWeeklyResetMs) > 120000) {
      return a.effectiveWeeklyResetMs - b.effectiveWeeklyResetMs;
    }
    if (Math.abs(a.fiveHourResetMs - b.fiveHourResetMs) > 60000) {
      return a.fiveHourResetMs - b.fiveHourResetMs;
    }
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return b.weeklyPct - a.weeklyPct;
  });

  return candidates[0];
}

function formatModelQuotaSubText(m, selectedRoute) {
  const t = I18N[currentLang];
  const accounts = state.accounts || [];
  const activeChannelId = state.activeAccount?.channelId || "";
  const thresholdPct = Number(state.routing?.lowQuotaThresholdPct ?? 5);

  if (selectedRoute === "auto_poll") {
    const picked = selectAutoPollChannel(accounts, m, activeChannelId, thresholdPct);
    if (picked) {
      const { acc: bestAcc, matched: bestModel, dual, isGcp } = picked;
      const shortName = isGcp ? `${t.channelGcpBadge}·${bestAcc.gcpProjectId.slice(0, 12)}` : bestAcc.email.split("@")[0];
      if (isGcp) {
        return `${t.autoPollSubPrefix}${shortName} · ${t.gcpRouteSubUnlimited}`;
      }
      const wkCountdown = formatResetCountdown(dual?.weeklyResetTime || bestModel.resetTime);
      if (dual?.hasDistinct5h) {
        const wkLabel = currentLang === "zh" ? "周" : "Wk";
        return wkCountdown
          ? `${t.autoPollSubPrefix}${shortName} · ${wkLabel} ${dual.weeklyPct}% (${wkCountdown}) · 5h ${dual.fiveHourPct}%`
          : `${t.autoPollSubPrefix}${shortName} · ${wkLabel} ${dual.weeklyPct}% · 5h ${dual.fiveHourPct}%`;
      }
      return wkCountdown
        ? `${t.autoPollSubPrefix}${shortName} · ${t.remainingLabel} ${dual ? dual.weeklyPct : bestModel.remainingPct}% · ${t.resetsInPrefix}${wkCountdown}${t.resetsInSuffix}`
        : `${t.autoPollSubPrefix}${shortName} · ${t.remainingLabel} ${dual ? dual.weeklyPct : bestModel.remainingPct}%`;
    }
  }

  if (selectedRoute && selectedRoute.startsWith("account:")) {
    const accId = selectedRoute.slice(8);
    const targetAcc = accounts.find((a) => a.id === accId);
    if (targetAcc) {
      const isGcp = targetAcc.channelType === "gcp" || Boolean(targetAcc.gcpProjectId);
      const matched = findModelInChannel(targetAcc, m);
      if (isGcp) {
        return matched ? t.gcpRouteSubUnlimited : t.gcpRouteSubUnsupported;
      }
      if (matched) {
        const countdown = formatResetCountdown(matched.resetTime);
        return countdown
          ? `${t.remainingLabel} ${matched.remainingPct}% · ${t.resetsInPrefix}${countdown}${t.resetsInSuffix}`
          : `${t.remainingLabel} ${matched.remainingPct}%`;
      }
      return t.gcpRouteSubUnsupported;
    }
  }

  const activeAcc = accounts.find((a) => a.id === activeChannelId);
  if (activeAcc) {
    const isGcp = activeAcc.channelType === "gcp" || Boolean(activeAcc.gcpProjectId);
    const matched = findModelInChannel(activeAcc, m);
    if (isGcp) {
      return matched ? t.gcpRouteSubUnlimited : t.gcpRouteSubUnsupported;
    }
    if (matched) {
      const countdown = formatResetCountdown(matched.resetTime);
      return countdown
        ? `${t.remainingLabel} ${matched.remainingPct}% · ${t.resetsInPrefix}${countdown}${t.resetsInSuffix}`
        : `${t.remainingLabel} ${matched.remainingPct}%`;
    }
    return t.gcpRouteSubUnsupported;
  }

  if (state.activeAccount?.gcpProjectId || m.unlimited) {
    return t.gcpRouteSubUnlimited;
  }
  const countdown = formatResetCountdown(m.resetTime);
  return countdown
    ? `${t.remainingLabel} ${m.remainingPct}% · ${t.resetsInPrefix}${countdown}${t.resetsInSuffix}`
    : `${t.remainingLabel} ${m.remainingPct}%`;
}

function renderRoutingList() {
  const container = document.getElementById("modelRoutingContainer");
  container.innerHTML = "";
  const t = I18N[currentLang];
  const isGcpScope = Boolean(state.activeAccount?.gcpProjectId);

  const routingTitleEl = document.getElementById("secRoutingTitle");
  const routingHintEl = document.getElementById("secRoutingHint");
  if (routingTitleEl) {
    routingTitleEl.textContent = isGcpScope
      ? (t.secRoutingTitleGcp || t.secRoutingTitle)
      : (t.secRoutingTitlePersonal || t.secRoutingTitle);
  }
  if (routingHintEl) {
    routingHintEl.textContent = isGcpScope
      ? (t.secRoutingHintGcp || t.secRoutingHint)
      : (t.secRoutingHintPersonal || t.secRoutingHint);
  }

  const models = getPoolModelsForScope(isGcpScope);
  const routeMap = isGcpScope
    ? (state.routing?.gcpModels || {})
    : (state.routing?.models || {});
  const routeScope = isGcpScope ? "gcp" : "personal";

  for (const m of models) {
    let selectedRoute = routeMap[m.modelId] || "follow_current";
    if (isGcpScope && selectedRoute === "auto_poll") {
      selectedRoute = "follow_current";
    }
    if (selectedRoute.startsWith("account:")) {
      const targetAcc = (state.accounts || []).find((a) => a.id === selectedRoute.slice(8));
      const targetAccIsGcp = targetAcc ? (targetAcc.channelType === "gcp" || Boolean(targetAcc.gcpProjectId)) : false;
      if (!targetAcc || targetAccIsGcp !== isGcpScope || (!isGcpScope && !findModelInChannel(targetAcc, m))) {
        selectedRoute = "follow_current";
      }
    }
    const row = document.createElement("div");
    row.className = "routing-row";

    const info = document.createElement("div");
    info.className = "routing-model-info";

    const title = document.createElement("span");
    title.className = "routing-model-name";
    title.textContent = m.label;

    const sub = document.createElement("span");
    sub.className = "routing-model-sub";
    sub.textContent = formatModelQuotaSubText(m, selectedRoute);

    info.appendChild(title);
    info.appendChild(sub);

    const dropdown = createCustomDropdown(selectedRoute, (newVal) => {
      saveRoutingRule({
        modelId: m.modelId,
        variantIds: m.variantIds || [],
        targetSpec: newVal,
        routeScope
      });
      if (newVal.startsWith("account:")) {
        probeChannelQuotaInBackground(newVal.slice(8));
      } else if (newVal === "auto_poll") {
        loadSystemStatus(true, true);
      }
    }, m, isGcpScope);

    row.appendChild(info);
    row.appendChild(dropdown);
    container.appendChild(row);
  }
}

let currentFrontendVersion = "";

async function loadSystemStatus(force = false, silent = false) {
  try {
    const res = await fetch(`/api/status${force ? "?force=1" : ""}`);
    const data = await res.json();
    if (data && !data.error) {
      if (data.frontendVersion) {
        if (currentFrontendVersion && currentFrontendVersion !== data.frontendVersion) {
          window.location.reload();
          return;
        }
        currentFrontendVersion = data.frontendVersion;
      }
      const prevActive = state.activeAccount;
      state = data;
      if (switchingAccountId && prevActive?.channelId) {
        state.activeAccount = prevActive;
      }
      renderAll();
      if (!silent) showToast(I18N[currentLang].toastRefreshed);
    }
  } catch (e) {}
}

function handleManualRefresh() {
  loadSystemStatus(true, false);
}

async function handleDiscoverGcpProjects(targetEmail = "") {
  try {
    const email = targetEmail || state.activeAccount?.email || "";
    const res = await fetch("/api/discover-gcp-projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    const list = Array.isArray(data.discovered) ? data.discovered : [];
    const t = I18N[currentLang];
    if (list.length === 1) {
      addGcpDraft.scannedProjects = [];
      addGcpDraft.projectId = list[0].projectId || "";
      renderAddGcpDrawer();
      showToast(`${t.toastGcpSingleFilled}${addGcpDraft.projectId}`);
    } else if (list.length > 1) {
      addGcpDraft.scannedProjects = list;
      addGcpDraft.projectId = list[0].projectId || "";
      renderAddGcpDrawer();
      showToast(`${t.toastGcpMultiFound}${list.length}`);
    } else {
      addGcpDraft.scannedProjects = [];
      if (/^(aicode-consumers|rising-fact-|gen-lang-client-)/i.test(addGcpDraft.projectId || "")) {
        addGcpDraft.projectId = "";
      }
      renderAddGcpDrawer();
    }
  } catch (e) {}
}

async function addPersonalChannelForEmail(email) {
  try {
    const cleanEmail = (email || "").trim();
    if (!cleanEmail) return;
    const res = await fetch("/api/add-gcp-channel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: cleanEmail,
        projectId: "__PERSONAL__",
        channelType: "personal"
      })
    });
    const data = await res.json();
    if (data.snapshot) {
      state = data.snapshot;
      renderAll();
    }
    fetch("/api/probe-channel-quota", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelId: `${cleanEmail}#personal` })
    })
      .then((r) => r.json())
      .then((d) => {
        if (d?.snapshot) {
          state = d.snapshot;
          renderAll();
        }
      })
      .catch(() => {});
    showToast(`${I18N[currentLang].toastPersonalAdded}${cleanEmail}`);
  } catch (e) {}
}

async function addGcpChannelForEmail(email, projectId, gcpBillingMode = "agent_platform", gcpLocation = "global") {
  try {
    const cleanPid = (projectId || "").trim();
    const packedPid = `${cleanPid}|${gcpBillingMode}|${gcpLocation}`;
    const res = await fetch("/api/add-gcp-channel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, projectId: packedPid, gcpBillingMode, gcpLocation })
    });
    const data = await res.json();
    if (data.snapshot) {
      state = data.snapshot;
      renderAll();
    }
    showToast(`${I18N[currentLang].toastGcpAdded}${cleanPid}`);
  } catch (e) {}
}

async function updateAccountGcpConfig(accountId, gcpProjectId, gcpBillingMode, gcpLocation) {
  try {
    const targetAcc = (state.accounts || []).find((a) => a.id === accountId);
    const email = targetAcc?.email || "";
    const oldPid = (targetAcc?.gcpProjectId || "").trim();
    const cleanPid = (gcpProjectId || "").trim();
    const packedPid = `${cleanPid}|${gcpBillingMode}|${gcpLocation}|${oldPid}`;
    const res = await fetch("/api/add-gcp-channel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        projectId: packedPid,
        gcpBillingMode,
        gcpLocation
      })
    });
    const data = await res.json();
    if (data.snapshot) {
      state = data.snapshot;
      renderAll();
    }
    showToast(I18N[currentLang].toastGcpUpdated);
  } catch (e) {}
}

async function captureCurrentAccount() {
  try {
    const res = await fetch("/api/save-current-account", { method: "POST" });
    const data = await res.json();
    if (data.snapshot) {
      state = data.snapshot;
      renderAll();
    }
    showToast(`${I18N[currentLang].toastCaptured}${data.email || ""}`);
  } catch (e) {}
}

async function startIsolatedBrowserLogin(opts = {}) {
  try {
    const res = await fetch("/api/start-oauth-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts || {})
    });
    const data = await res.json();
    if (data.snapshot) {
      state = data.snapshot;
      renderAll();
    }
    showToast(I18N[currentLang].toastOAuthStarted);
  } catch (e) {}
}

async function cancelBrowserLogin() {
  try {
    const res = await fetch("/api/cancel-oauth-login", { method: "POST" });
    const data = await res.json();
    if (data.snapshot) {
      state = data.snapshot;
      renderAll();
    }
    showToast(I18N[currentLang].toastOAuthCanceled);
  } catch (e) {}
}

async function switchBillingProject(projectId) {
  try {
    const res = await fetch("/api/switch-project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId })
    });
    const data = await res.json();
    if (data.snapshot) {
      state = data.snapshot;
      renderAll();
    }
    showToast(I18N[currentLang].toastProjectSwitched);
  } catch (e) {}
}

function applyGcpInputProject() {
  const val = (document.getElementById("gcpProjectInput")?.value || "").trim();
  switchBillingProject(val);
}

async function handleManualScrubSignatures(mode = "mismatched") {
  try {
    const tel = state.telemetry || {};
    const targetConvId =
      (selectedTelemetryConvId && selectedTelemetryConvId !== "__PROJECT_TOTAL__")
        ? selectedTelemetryConvId
        : (tel.fullConversationId || tel.conversationId || "");
    const res = await fetch("/api/scrub-signatures", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: mode === "current" ? "current" : "mismatched",
        conversationId: targetConvId
      })
    });
    const data = await res.json();
    if (data.snapshot) {
      state = data.snapshot;
      renderAll();
    }
    const t = I18N[currentLang];
    const toastPrefix = mode === "current"
      ? (t.toastScrubbedCurrent || t.toastSignaturesScrubbed)
      : (t.toastScrubbedMismatched || t.toastSignaturesScrubbed);
    showToast(`${toastPrefix}${data.scrubbedCount ?? 0}`);
  } catch (e) {}
}

async function switchGoogleAccount(accountId, scrubSignatures = false) {
  if (switchingAccountId) return;
  try {
    selectedQuotaChannelId = "";
    switchingAccountId = accountId;
    renderAccountList();
    showToast(I18N[currentLang].toastAccountSwitching);
    const res = await fetch("/api/switch-account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId, scrubSignatures: Boolean(scrubSignatures) })
    });
    const data = await res.json();
    if (data && data.error) {
      switchingAccountId = "";
      showToast(data.error);
      if (data.snapshot) {
        state = data.snapshot;
      }
      renderAll();
      return;
    }
    // 保持「切换中...」过渡态直至 Workbench 自动刷新重载完成（若在独立浏览器打开无 CDP 重载，则在 1.8 秒后切换为「使用中」）
    setTimeout(() => {
      switchingAccountId = "";
      if (data && data.snapshot) {
        state = data.snapshot;
      }
      renderAll();
      showToast(I18N[currentLang].toastRefreshed);
      loadSystemStatus(true, true);
    }, 1800);
  } catch (e) {
    switchingAccountId = "";
    renderAccountList();
  }
}

async function launchIsolatedInstance(accountId) {
  try {
    let res = await fetch("/api/launch-instance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId })
    });
    if (res.status === 404) {
      res = await fetch("/api/switch-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: `launch_instance:${accountId}` })
      });
    }
    const data = await res.json();
    if (data?.snapshot) {
      state = data.snapshot;
      renderAll();
    }
    if (data && (data.success || data.launched) && !data.error) {
      const label = data.gcpProjectId ? `${data.email} (${data.gcpProjectId})` : (data.email || accountId);
      showToast(`${I18N[currentLang].toastInstanceLaunched}${label}`);
      setTimeout(() => loadSystemStatus(false, true), 2500);
    } else if (data?.error) {
      showToast(data.error);
    }
  } catch (e) {}
}

async function deleteAccountProfile(accountId) {
  try {
    const res = await fetch("/api/delete-account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId })
    });
    const data = await res.json();
    if (data.snapshot) {
      state = data.snapshot;
      renderAll();
    }
    showToast(I18N[currentLang].toastDeleted);
  } catch (e) {}
}

async function saveRoutingRule(payload) {
  try {
    const res = await fetch("/api/save-routing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.snapshot) {
      state = data.snapshot;
      renderAll();
    }
    showToast(I18N[currentLang].toastRoutingSaved);
  } catch (e) {}
}

// 启动 SSE 实时流与定时轮询
function connectSse() {
  try {
    const es = new EventSource("/api/events");
    es.onmessage = (ev) => {
      try {
        const snap = JSON.parse(ev.data);
        if (snap && !snap.error) {
          if (snap.frontendVersion) {
            if (currentFrontendVersion && currentFrontendVersion !== dataFrontendVer(snap)) {
              window.location.reload();
              return;
            }
            currentFrontendVersion = snap.frontendVersion;
          }
          const prevOAuthEvent = snap.lastOAuthEvent;
          const prevActive = state.activeAccount;
          state = snap;
          if (switchingAccountId && prevActive?.channelId) {
            state.activeAccount = prevActive;
          }
          if (prevOAuthEvent?.success && prevOAuthEvent.email) {
            if (prevOAuthEvent.autoScanGcp) {
              isAddGcpDrawerOpen = true;
              addGcpDraft.sourceMode = "existing";
              addGcpDraft.email = prevOAuthEvent.email;
              addGcpDraft.channelType = "gcp";
              addGcpDraft.scannedProjects = [];
              renderAll();
              showToast(`${I18N[currentLang].toastOAuthSuccess}${prevOAuthEvent.email}`);
              return;
            }
            renderAll();
            showToast(`${I18N[currentLang].toastOAuthSuccess}${prevOAuthEvent.email}`);
            return;
          }
          renderAll();
        }
      } catch (e) {}
    };
  } catch (e) {}
}

function dataFrontendVer(snap) {
  return snap?.frontendVersion || "";
}

applyI18n();
loadSystemStatus(false, true);
connectSse();
setInterval(() => {
  if (!document.hidden) {
    loadSystemStatus(false, true);
  }
}, 45000);
