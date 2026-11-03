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

// 顶部「会话与使用量」当前选中的查看通道 ID（空字符串表示跟随当前激活通道）
let selectedQuotaChannelId = "";
// 当前展开编辑设置的 GCP 通道卡片 ID 集合与顶部添加 GCP 抽屉开关状态
let expandedGcpConfigIds = new Set();
let isAddGcpDrawerOpen = false;
let addGcpDraft = {
  channelType: "gcp",
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

function formatResetCountdown(isoStr) {
  if (!isoStr) return "";
  const diffMs = new Date(isoStr).getTime() - Date.now();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return "";
  const t = I18N[currentLang];
  const totalMins = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMins / 1440);
  const hours = Math.floor((totalMins % 1440) / 60);
  const mins = totalMins % 60;
  if (days > 0) return hours > 0 ? `${days}${t.unitDay} ${hours}${t.unitHour}` : `${days}${t.unitDay}`;
  if (hours > 0) return `${hours}${t.unitHour} ${mins}${t.unitMin}`;
  return `${mins}${t.unitMin}`;
}

function translateQuotaGroupName(rawName) {
  if (currentLang !== "zh") return rawName;
  const n = (rawName || "").trim();
  if (/^gemini models$/i.test(n)) return "Gemini 模型";
  if (/^claude and gpt models$/i.test(n)) return "Claude 和 GPT 模型";
  return n;
}

function getChannelBadgeInfo(ch) {
  const t = I18N[currentLang];
  if (!ch) return { badgeType: "personal", badgeText: t.channelPersonalBadge };
  const isGcp = ch.channelType === "gcp" || Boolean(ch.gcpProjectId);
  if (isGcp) {
    return { badgeType: "gcp", badgeText: t.channelGcpBadge };
  }
  const code = String(ch.tierCode || ch.cachedQuota?.tierCode || "").trim();
  const tName = String(ch.tierName || ch.cachedQuota?.tierName || "").trim();
  if (/^ultra$/i.test(code) || /ultra/i.test(tName)) {
    return { badgeType: "ultra", badgeText: "Ultra" };
  }
  if (/^plus$/i.test(code) || /plus/i.test(tName)) {
    return { badgeType: "plus", badgeText: "Plus" };
  }
  if (/^free$/i.test(code) || /free|standard/i.test(tName)) {
    return { badgeType: "free", badgeText: "Free" };
  }
  if (ch.cachedQuota && ch.cachedQuota.isPaidProOrUltra === false) {
    return { badgeType: "plus", badgeText: "Plus" };
  }
  return { badgeType: "personal", badgeText: t.channelPersonalBadge };
}

function applyI18n() {
  const t = I18N[currentLang];
  document.getElementById("uiAppTitle").textContent = t.appTitle;
  document.getElementById("langToggleBtn").textContent = t.langBtn;
  document.getElementById("refreshBtn").textContent = t.refreshBtn;
  document.getElementById("secCurrentTitle").textContent = t.secCurrentTitle;
  document.getElementById("secAccountsTitle").textContent = t.secAccountsTitle;
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
  renderAddGcpDrawer();
  renderAccountList();
  renderRoutingList();
}

function renderSessionSelector() {
  const mount = document.getElementById("sessionChannelSelectorMount");
  if (!mount) return;
  mount.innerHTML = "";
  const t = I18N[currentLang];
  const active = state.activeAccount || {};
  const activeChannelId = active.channelId || (active.email ? `${active.email}#personal` : "");
  const accounts = state.accounts || [];

  // 构建可查看余额的通道列表
  const channelOptions = [];
  const seen = new Set();

  if (active.email && activeChannelId) {
    const existingActive = accounts.find((a) => a.id === activeChannelId);
    seen.add(activeChannelId);
    channelOptions.push(existingActive || {
      id: activeChannelId,
      email: active.email,
      channelType: active.gcpProjectId ? "gcp" : "personal",
      gcpProjectId: active.gcpProjectId || ""
    });
  }

  for (const acc of accounts) {
    if (!seen.has(acc.id)) {
      seen.add(acc.id);
      channelOptions.push(acc);
    }
  }

  const targetId = (selectedQuotaChannelId && seen.has(selectedQuotaChannelId))
    ? selectedQuotaChannelId
    : activeChannelId;
  const currentViewed = channelOptions.find((c) => c.id === targetId) || {
    id: activeChannelId,
    email: active.email || "-",
    channelType: active.gcpProjectId ? "gcp" : "personal",
    gcpProjectId: active.gcpProjectId || ""
  };

  const isViewingActive = !selectedQuotaChannelId || currentViewed.id === activeChannelId;
  const isGcp = currentViewed.channelType === "gcp" || Boolean(currentViewed.gcpProjectId);

  const wrapper = document.createElement("div");
  wrapper.className = "custom-dropdown session-selector-dropdown";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "dropdown-trigger";

  const leftWrap = document.createElement("div");
  leftWrap.className = "active-email-wrap";

  const dot = document.createElement("span");
  dot.className = "status-dot" + (state.lsOnline && isViewingActive ? " online" : "");
  leftWrap.appendChild(dot);

  const curBadge = getChannelBadgeInfo(currentViewed);
  const prefixBadge = document.createElement("span");
  prefixBadge.className = "channel-type-badge " + curBadge.badgeType;
  prefixBadge.textContent = curBadge.badgeText;
  leftWrap.appendChild(prefixBadge);

  const emailText = document.createElement("span");
  emailText.className = "active-email";
  emailText.textContent = isGcp && currentViewed.gcpProjectId
    ? `${currentViewed.email} · ${currentViewed.gcpProjectId}`
    : (currentViewed.email || "-");
  leftWrap.appendChild(emailText);

  const rightWrap = document.createElement("div");
  rightWrap.className = "session-trigger-right";

  const arrowSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  arrowSvg.setAttribute("class", "dropdown-arrow");
  arrowSvg.setAttribute("viewBox", "0 0 16 16");
  arrowSvg.setAttribute("fill", "none");
  arrowSvg.innerHTML = `<path d="M4 6L8 10L12 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;
  rightWrap.appendChild(arrowSvg);

  trigger.appendChild(leftWrap);
  trigger.appendChild(rightWrap);

  const menu = document.createElement("div");
  menu.className = "dropdown-menu";

  for (const ch of channelOptions) {
    const chIsGcp = ch.channelType === "gcp" || Boolean(ch.gcpProjectId);
    const chIsActive = ch.id === currentViewed.id;
    const item = document.createElement("div");
    item.className = "dropdown-option" + (chIsActive ? " active" : "");

    const itemLeft = document.createElement("div");
    itemLeft.className = "active-email-wrap";

    const itemDot = document.createElement("span");
    itemDot.className = "status-dot" + (ch.id === activeChannelId && state.lsOnline ? " online" : "");
    itemLeft.appendChild(itemDot);

    const chBadge = getChannelBadgeInfo(ch);
    const itemBadge = document.createElement("span");
    itemBadge.className = "channel-type-badge " + chBadge.badgeType;
    itemBadge.textContent = chBadge.badgeText;
    itemLeft.appendChild(itemBadge);

    const itemLabel = document.createElement("span");
    itemLabel.className = "dropdown-option-label";
    itemLabel.textContent = chIsGcp && ch.gcpProjectId
      ? `${ch.email} · ${ch.gcpProjectId}`
      : ch.email;
    itemLeft.appendChild(itemLabel);

    const itemRight = document.createElement("div");
    itemRight.className = "session-trigger-right";

    const checkSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    checkSvg.setAttribute("class", "check-icon");
    checkSvg.setAttribute("viewBox", "0 0 16 16");
    checkSvg.setAttribute("fill", "none");
    checkSvg.innerHTML = `<path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;
    itemRight.appendChild(checkSvg);

    item.appendChild(itemLeft);
    item.appendChild(itemRight);

    item.onclick = (ev) => {
      ev.stopPropagation();
      wrapper.classList.remove("open");
      selectedQuotaChannelId = ch.id === activeChannelId ? "" : ch.id;
      renderSessionSelector();
      renderQuotaGroups();
      if (ch.id !== activeChannelId) {
        probeChannelQuotaInBackground(ch.id);
      }
    };

    menu.appendChild(item);
  }

  trigger.onclick = (ev) => {
    ev.stopPropagation();
    const isOpen = wrapper.classList.contains("open");
    document.querySelectorAll(".custom-dropdown.open").forEach((el) => el.classList.remove("open"));
    if (!isOpen) {
      wrapper.classList.add("open");
    }
  };

  wrapper.appendChild(trigger);
  wrapper.appendChild(menu);
  mount.appendChild(wrapper);
}

async function probeChannelQuotaInBackground(channelId) {
  try {
    const res = await fetch("/api/probe-channel-quota", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelId })
    });
    const data = await res.json();
    if (data && data.snapshot) {
      state = data.snapshot;
      renderSessionSelector();
      renderQuotaGroups();
    }
  } catch (e) {}
}

function createQuotaRingSvg(pct) {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  const r = 5.4;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - clamped / 100);
  const colorClass = clamped <= 10 ? " low" : clamped <= 30 ? " warn" : "";
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "quota-ring-svg");
  svg.setAttribute("viewBox", "0 0 14 14");

  const track = document.createElementNS(ns, "circle");
  track.setAttribute("class", "quota-ring-track");
  track.setAttribute("cx", "7");
  track.setAttribute("cy", "7");
  track.setAttribute("r", String(r));

  const fill = document.createElementNS(ns, "circle");
  fill.setAttribute("class", `quota-ring-fill${colorClass}`);
  fill.setAttribute("cx", "7");
  fill.setAttribute("cy", "7");
  fill.setAttribute("r", String(r));
  fill.setAttribute("stroke-dasharray", String(c.toFixed(2)));
  fill.setAttribute("stroke-dashoffset", String(offset.toFixed(2)));

  svg.appendChild(track);
  svg.appendChild(fill);
  return svg;
}

// 1:1 对齐官方「使用量」弹窗：每个分组下把「周限额」和「5h limit」拆成独立行 + 右侧百分比 + SVG 圆环 + Resets in ...
function renderQuotaGroups() {
  const container = document.getElementById("quotaGroupsContainer");
  container.innerHTML = "";
  const t = I18N[currentLang];
  const activeChannelId = state.activeAccount?.channelId || "";
  const targetChannelId = selectedQuotaChannelId || activeChannelId;
  const viewedAcc = (state.accounts || []).find((a) => a.id === targetChannelId);
  const isViewingActive = !selectedQuotaChannelId || selectedQuotaChannelId === activeChannelId;
  const isGcpChannel = Boolean(
    viewedAcc
      ? (viewedAcc.channelType === "gcp" || viewedAcc.gcpProjectId)
      : state.activeAccount?.gcpProjectId
  );

  let groups = (isViewingActive
    ? (state.quotaGroups || [])
    : (viewedAcc?.cachedQuota?.quotaGroups || [])
  ).filter((g) => {
    const gName = String(g?.displayName || g?.id || "").trim();
    const bks = Array.isArray(g?.buckets) ? g.buckets : [];
    if (/^all\s*models$/i.test(gName) || bks.length > 3) return false;
    return true;
  });

  // 若查看的是 GCP 通道，顶部展示当前 GCP 计费模式（按量计费 Agent Platform / Gemini Enterprise）与可用模型芯片，绝对不显示剩余百分比
  if (isGcpChannel) {
    const gcpCard = document.createElement("div");
    gcpCard.className = "gcp-billing-card";

    const header = document.createElement("div");
    header.className = "gcp-billing-header";

    const gcpMode = viewedAcc?.gcpBillingMode || state.activeAccount?.gcpBillingMode || "agent_platform";
    const gcpLoc = viewedAcc?.gcpLocation || state.activeAccount?.gcpLocation || "global";
    const locLabel = gcpLoc === "us" ? t.gcpRegionUs : gcpLoc === "eu" ? t.gcpRegionEu : t.gcpRegionGlobal;
    const title = document.createElement("span");
    title.className = "gcp-billing-title";
    title.textContent = gcpMode === "gemini_enterprise"
      ? t.gcpBillingTitleEnterprise
      : `${t.gcpBillingTitlePayg} · ${locLabel}`;

    const pill = document.createElement("span");
    pill.className = "gcp-unlimited-pill";
    pill.textContent = gcpMode === "gemini_enterprise" ? t.gcpPillEnterprise : t.gcpPillPayg;

    header.appendChild(title);
    header.appendChild(pill);
    gcpCard.appendChild(header);

    const gcpModels = viewedAcc?.cachedQuota?.availableModels || (isViewingActive ? state.availableModels : []) || [];
    if (gcpModels.length > 0) {
      const modelsLabel = document.createElement("div");
      modelsLabel.className = "gcp-models-label";
      modelsLabel.textContent = t.gcpModelsLabel;
      gcpCard.appendChild(modelsLabel);

      const chipsWrap = document.createElement("div");
      chipsWrap.className = "gcp-model-chips";
      for (const gm of gcpModels) {
        const chip = document.createElement("span");
        chip.className = "gcp-model-chip";
        chip.textContent = gm.label || gm.modelId;
        chipsWrap.appendChild(chip);
      }
      gcpCard.appendChild(chipsWrap);
    }

    container.appendChild(gcpCard);
    return;
  }

  if (groups.length === 0 && !isGcpChannel) {
    const hint = document.createElement("div");
    hint.className = "section-hint";
    hint.style.padding = "6px 2px";
    hint.textContent = t.quotaNoCacheHint;
    container.appendChild(hint);
    return;
  }

  for (const g of groups) {
    const buckets = g.buckets || [];
    if (buckets.length === 0) continue;

    const groupEl = document.createElement("div");
    groupEl.className = "quota-group";

    const titleEl = document.createElement("div");
    titleEl.className = "quota-group-title";
    titleEl.textContent = translateQuotaGroupName(g.displayName);
    groupEl.appendChild(titleEl);

    for (const b of buckets) {
      const pct = b.remainingPct ?? 100;
      const countdown = formatResetCountdown(b.resetTime);
      const isWeekly = /weekly/i.test(b.window || b.bucketId || "");
      const rowLabel = isWeekly ? t.weeklyLimitLabel : t.fiveHourLimitLabel;

      const row = document.createElement("div");
      row.className = "quota-bucket-row";

      const labelEl = document.createElement("span");
      labelEl.className = "quota-bucket-label";
      labelEl.textContent = rowLabel;

      const rightCol = document.createElement("div");
      rightCol.className = "quota-bucket-right";

      const mainLine = document.createElement("div");
      mainLine.className = "quota-bucket-main";

      const pctSpan = document.createElement("span");
      pctSpan.className = "quota-bucket-pct" + (pct === 100 ? " full" : "");
      pctSpan.textContent = `${t.pctLeftPrefix}${pct}${t.pctLeftSuffix}`;

      mainLine.appendChild(pctSpan);
      mainLine.appendChild(createQuotaRingSvg(pct));
      rightCol.appendChild(mainLine);

      if (countdown) {
        const resetLine = document.createElement("div");
        resetLine.className = "quota-bucket-reset";
        resetLine.textContent = `${t.resetsInPrefix}${countdown}${t.resetsInSuffix}`;
        rightCol.appendChild(resetLine);
      }

      row.appendChild(labelEl);
      row.appendChild(rightCol);
      groupEl.appendChild(row);
    }

    container.appendChild(groupEl);
  }
}

function createCompactFormDropdown(options, selectedValue, onSelect) {
  const activeOpt = options.find((o) => o.value === selectedValue) || options[0] || { value: "", label: "-" };

  const wrapper = document.createElement("div");
  wrapper.className = "custom-dropdown compact-form-dropdown";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "dropdown-trigger";

  const leftWrap = document.createElement("div");
  leftWrap.className = "active-email-wrap";

  if (activeOpt.badgeText) {
    const b = document.createElement("span");
    b.className = "channel-type-badge " + (activeOpt.badgeType || "personal");
    b.textContent = activeOpt.badgeText;
    leftWrap.appendChild(b);
  }

  const triggerText = document.createElement("span");
  triggerText.className = "dropdown-trigger-text";
  triggerText.textContent = activeOpt.label;
  leftWrap.appendChild(triggerText);

  const arrowSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  arrowSvg.setAttribute("class", "dropdown-arrow");
  arrowSvg.setAttribute("viewBox", "0 0 16 16");
  arrowSvg.setAttribute("fill", "none");
  arrowSvg.innerHTML = `<path d="M4 6L8 10L12 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;

  trigger.appendChild(leftWrap);
  trigger.appendChild(arrowSvg);

  const menu = document.createElement("div");
  menu.className = "dropdown-menu";

  for (const opt of options) {
    const item = document.createElement("div");
    item.className = "dropdown-option" + (opt.value === activeOpt.value ? " active" : "");

    const itemLeft = document.createElement("div");
    itemLeft.className = "active-email-wrap";

    if (opt.badgeText) {
      const b = document.createElement("span");
      b.className = "channel-type-badge " + (opt.badgeType || "personal");
      b.textContent = opt.badgeText;
      itemLeft.appendChild(b);
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
      wrapper.classList.add("open");
    }
  };

  wrapper.appendChild(trigger);
  wrapper.appendChild(menu);
  return wrapper;
}

function toggleAddGcpDrawer() {
  isAddGcpDrawerOpen = !isAddGcpDrawerOpen;
  renderAddGcpDrawer();
}

function renderAddGcpDrawer() {
  const drawer = document.getElementById("addGcpDrawer");
  if (!drawer) return;
  if (!isAddGcpDrawerOpen) {
    drawer.style.display = "none";
    drawer.innerHTML = "";
    return;
  }
  drawer.style.display = "flex";
  drawer.innerHTML = "";
  const t = I18N[currentLang];

  // 收集所有已保存了 OAuth Token 的唯一 Google 邮箱，支持免二次浏览器登录直接绑定 GCP 项目
  const uniqueEmails = [];
  if (state.activeAccount?.email) {
    uniqueEmails.push(state.activeAccount.email);
  }
  for (const acc of (state.accounts || [])) {
    if (acc.email && !uniqueEmails.includes(acc.email)) {
      uniqueEmails.push(acc.email);
    }
  }
  if (!addGcpDraft.email || !uniqueEmails.includes(addGcpDraft.email)) {
    addGcpDraft.email = uniqueEmails[0] || "";
  }

  const header = document.createElement("div");
  header.className = "gcp-drawer-header";
  const titleSpan = document.createElement("span");
  titleSpan.textContent = t.gcpDrawerTitle;
  const headerBtns = document.createElement("div");
  headerBtns.className = "btn-group";
  if (addGcpDraft.channelType !== "personal") {
    const scanBtn = document.createElement("button");
    scanBtn.className = "secondary small";
    scanBtn.textContent = t.btnDiscoverGcp;
    scanBtn.onclick = () => handleDiscoverGcpProjects(addGcpDraft.email);
    headerBtns.appendChild(scanBtn);
  }
  const closeBtn = document.createElement("button");
  closeBtn.className = "secondary small";
  closeBtn.textContent = t.btnCloseGcpConfig;
  closeBtn.onclick = () => {
    isAddGcpDrawerOpen = false;
    renderAddGcpDrawer();
  };
  headerBtns.appendChild(closeBtn);
  header.appendChild(titleSpan);
  header.appendChild(headerBtns);
  drawer.appendChild(header);

  // 第 1 行：选择要复用凭据的账号 + 选择要添加的通道类型（云项目通道 / 个人通道）
  const emailRow = document.createElement("div");
  emailRow.className = "gcp-config-row";
  const emailOpts = uniqueEmails.map((em) => ({
    value: em,
    label: em
  }));
  emailOpts.push({ value: "__new_oauth__", label: t.gcpNewBrowserLoginOpt });

  const emailDropdown = createCompactFormDropdown(emailOpts, addGcpDraft.email || "__new_oauth__", (val) => {
    if (val === "__new_oauth__") {
      startIsolatedBrowserLogin();
      return;
    }
    addGcpDraft.email = val;
    addGcpDraft.scannedProjects = [];
    renderAddGcpDrawer();
  });

  const existingPersonalForDraft = (state.accounts || []).find(
    (a) => a.email === addGcpDraft.email && a.channelType !== "gcp" && !a.gcpProjectId
  );
  const draftPersonalBadge = existingPersonalForDraft
    ? getChannelBadgeInfo(existingPersonalForDraft)
    : { badgeType: "personal", badgeText: t.channelPersonalBadge };
  const typeOpts = [
    { value: "gcp", label: t.drawerChannelTypeGcp, badgeType: "gcp", badgeText: t.channelGcpBadge },
    { value: "personal", label: t.drawerChannelTypePersonal, badgeType: draftPersonalBadge.badgeType, badgeText: draftPersonalBadge.badgeText }
  ];
  const typeDropdown = createCompactFormDropdown(typeOpts, addGcpDraft.channelType || "gcp", (val) => {
    addGcpDraft.channelType = val;
    renderAddGcpDrawer();
  });

  emailRow.appendChild(emailDropdown);
  emailRow.appendChild(typeDropdown);
  drawer.appendChild(emailRow);

  // 若选择添加个人通道（例如当前处于云项目通道时补充同邮箱的个人通道）
  if (addGcpDraft.channelType === "personal") {
    const personalSubmitRow = document.createElement("div");
    personalSubmitRow.className = "gcp-config-row";
    personalSubmitRow.style.justifyContent = "flex-end";
    const submitPersonalBtn = document.createElement("button");
    submitPersonalBtn.className = "small";
    submitPersonalBtn.textContent = t.btnAddGcpForEmail;
    submitPersonalBtn.onclick = () => {
      if (!addGcpDraft.email) return;
      addPersonalChannelForEmail(addGcpDraft.email);
      isAddGcpDrawerOpen = false;
      renderAddGcpDrawer();
    };
    personalSubmitRow.appendChild(submitPersonalBtn);
    drawer.appendChild(personalSubmitRow);
    return;
  }

  // 第 2 行：选择云项目计费模式与区域（圆角悬浮下拉）
  const modeLocRow = document.createElement("div");
  modeLocRow.className = "gcp-config-row";
  const modeOpts = [
    { value: "agent_platform", label: t.gcpModePaygShort },
    { value: "gemini_enterprise", label: t.gcpModeEnterpriseShort }
  ];
  const modeDropdown = createCompactFormDropdown(modeOpts, addGcpDraft.gcpBillingMode, (val) => {
    addGcpDraft.gcpBillingMode = val;
    renderAddGcpDrawer();
  });
  modeLocRow.appendChild(modeDropdown);

  if (addGcpDraft.gcpBillingMode === "agent_platform") {
    const locOpts = [
      { value: "global", label: t.gcpRegionGlobal },
      { value: "us", label: t.gcpRegionUs },
      { value: "eu", label: t.gcpRegionEu }
    ];
    const locDropdown = createCompactFormDropdown(locOpts, addGcpDraft.gcpLocation, (val) => {
      addGcpDraft.gcpLocation = val;
      renderAddGcpDrawer();
    });
    modeLocRow.appendChild(locDropdown);
  }
  drawer.appendChild(modeLocRow);

  // 若自动扫描发现了多个项目 ID，提供下拉列表点击填入输入框（仅单个项目时已直接填入，无需下拉）
  if (Array.isArray(addGcpDraft.scannedProjects) && addGcpDraft.scannedProjects.length > 1) {
    const scannedRow = document.createElement("div");
    scannedRow.className = "gcp-config-row";
    const scannedOpts = addGcpDraft.scannedProjects.map((p) => ({
      value: p.projectId,
      label: p.name && p.name !== p.projectId ? `${p.projectId} (${p.name})` : p.projectId,
      badgeType: "gcp",
      badgeText: t.channelGcpBadge
    }));
    const scannedDropdown = createCompactFormDropdown(
      scannedOpts,
      addGcpDraft.projectId || scannedOpts[0]?.value || "",
      (selectedPid) => {
        addGcpDraft.projectId = selectedPid;
        renderAddGcpDrawer();
      }
    );
    scannedRow.appendChild(scannedDropdown);
    drawer.appendChild(scannedRow);
  }

  // 第 3 行：输入云项目编号 + 确认添加
  const pidRow = document.createElement("div");
  pidRow.className = "gcp-config-row";
  const pidInput = document.createElement("input");
  pidInput.type = "text";
  pidInput.className = "compact-input";
  pidInput.placeholder = t.accGcpPlaceholder;
  pidInput.value = addGcpDraft.projectId || "";
  pidInput.oninput = () => {
    addGcpDraft.projectId = pidInput.value;
  };
  const submitBtn = document.createElement("button");
  submitBtn.className = "small";
  submitBtn.textContent = t.btnAddGcpForEmail;
  submitBtn.onclick = () => {
    const cleanPid = (pidInput.value || "").trim();
    if (!cleanPid || !addGcpDraft.email) return;
    addGcpChannelForEmail(addGcpDraft.email, cleanPid, addGcpDraft.gcpBillingMode, addGcpDraft.gcpLocation);
    addGcpDraft.projectId = "";
    addGcpDraft.scannedProjects = [];
    isAddGcpDrawerOpen = false;
    renderAddGcpDrawer();
  };
  pidRow.appendChild(pidInput);
  pidRow.appendChild(submitBtn);
  drawer.appendChild(pidRow);
}

function renderAccountList() {
  const container = document.getElementById("accountListContainer");
  container.innerHTML = "";
  const t = I18N[currentLang];
  const accounts = state.accounts || [];
  const activeEmail = state.activeAccount?.email || "";
  const activeGcp = state.activeAccount?.gcpProjectId || "";

  if (accounts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "section-hint";
    empty.style.padding = "6px 2px";
    empty.textContent = t.emptyAccounts;
    container.appendChild(empty);
    return;
  }

  for (const acc of accounts) {
    const isGcpChannel = acc.channelType === "gcp" || Boolean(acc.gcpProjectId);
    const accPid = (acc.gcpProjectId || "").trim();
    const isCurrent = Boolean(
      acc.email === activeEmail &&
      ((isGcpChannel && accPid === activeGcp && activeGcp !== "") || (!isGcpChannel && activeGcp === ""))
    );

    const card = document.createElement("div");
    card.className = "account-card" + (isCurrent ? " current" : "");

    const top = document.createElement("div");
    top.className = "account-card-top";

    const titleWrap = document.createElement("div");
    titleWrap.className = "account-title-wrap";

    const badgeInfo = getChannelBadgeInfo(acc);
    const typeBadge = document.createElement("span");
    typeBadge.className = "channel-type-badge " + badgeInfo.badgeType;
    typeBadge.textContent = badgeInfo.badgeText;
    titleWrap.appendChild(typeBadge);

    const emailEl = document.createElement("span");
    emailEl.className = "account-email";
    emailEl.textContent = acc.email || acc.id;
    titleWrap.appendChild(emailEl);

    top.appendChild(titleWrap);

    const rightBadges = document.createElement("div");
    rightBadges.className = "btn-group";

    if (isGcpChannel) {
      const editBtn = document.createElement("button");
      editBtn.className = "secondary small";
      const isExpanded = expandedGcpConfigIds.has(acc.id);
      editBtn.textContent = isExpanded ? t.btnCloseGcpConfig : t.btnEditGcpConfig;
      editBtn.onclick = () => {
        if (expandedGcpConfigIds.has(acc.id)) {
          expandedGcpConfigIds.delete(acc.id);
        } else {
          expandedGcpConfigIds.add(acc.id);
        }
        renderAccountList();
      };
      rightBadges.appendChild(editBtn);
    }

    if (isCurrent) {
      const curTag = document.createElement("span");
      curTag.className = "badge";
      curTag.textContent = t.currentBadge;
      rightBadges.appendChild(curTag);
    } else {
      const switchBtn = document.createElement("button");
      switchBtn.className = "small";
      switchBtn.textContent = t.btnSwitchAccount;
      switchBtn.onclick = () => switchGoogleAccount(acc.id);
      rightBadges.appendChild(switchBtn);
    }

    const delBtn = document.createElement("button");
    delBtn.className = "danger small";
    delBtn.textContent = t.btnDeleteAccount;
    delBtn.onclick = () => deleteAccountProfile(acc.id);
    rightBadges.appendChild(delBtn);

    top.appendChild(rightBadges);
    card.appendChild(top);

    // 个人 Pro 通道卡片保持单行纯净，不再挂载任何 GCP 计费表单；GCP 通道卡片默认展示紧凑摘要条，点击「设置」才展开圆角下拉框编辑
    if (isGcpChannel) {
      const bottom = document.createElement("div");
      bottom.className = "account-card-bottom";

      const curMode = acc.gcpBillingMode === "gemini_enterprise" ? "gemini_enterprise" : "agent_platform";
      const curLoc = ["global", "us", "eu"].includes(acc.gcpLocation) ? acc.gcpLocation : "global";
      const modeLabel = curMode === "gemini_enterprise" ? t.gcpModeEnterpriseShort : t.gcpModePaygShort;
      const locLabel = curLoc === "us" ? t.gcpRegionUs : curLoc === "eu" ? t.gcpRegionEu : t.gcpRegionGlobal;

      const summaryBar = document.createElement("div");
      summaryBar.className = "gcp-summary-bar";
      const summaryText = document.createElement("span");
      summaryText.className = "gcp-summary-text";
      summaryText.textContent = curMode === "agent_platform"
        ? `${modeLabel} · ${locLabel} · ${accPid}`
        : `${modeLabel} · ${accPid}`;
      summaryBar.appendChild(summaryText);
      bottom.appendChild(summaryBar);

      if (expandedGcpConfigIds.has(acc.id)) {
        const configRow1 = document.createElement("div");
        configRow1.className = "gcp-config-row";

        const modeOpts = [
          { value: "agent_platform", label: t.gcpModePaygShort },
          { value: "gemini_enterprise", label: t.gcpModeEnterpriseShort }
        ];
        const modeDropdown = createCompactFormDropdown(modeOpts, curMode, (newMode) => {
          updateAccountGcpConfig(acc.id, accPid, newMode, curLoc);
        });
        configRow1.appendChild(modeDropdown);

        if (curMode === "agent_platform") {
          const locOpts = [
            { value: "global", label: t.gcpRegionGlobal },
            { value: "us", label: t.gcpRegionUs },
            { value: "eu", label: t.gcpRegionEu }
          ];
          const locDropdown = createCompactFormDropdown(locOpts, curLoc, (newLoc) => {
            updateAccountGcpConfig(acc.id, accPid, curMode, newLoc);
          });
          configRow1.appendChild(locDropdown);
        }

        const configRow2 = document.createElement("div");
        configRow2.className = "gcp-config-row";

        const pidInput = document.createElement("input");
        pidInput.type = "text";
        pidInput.className = "compact-input";
        pidInput.value = accPid;
        pidInput.placeholder = t.accGcpPlaceholder;

        const saveBtn = document.createElement("button");
        saveBtn.className = "secondary small";
        saveBtn.textContent = t.btnSaveGcpConfig;
        saveBtn.onclick = () => {
          updateAccountGcpConfig(acc.id, pidInput.value, curMode, curLoc);
        };

        configRow2.appendChild(pidInput);
        configRow2.appendChild(saveBtn);

        bottom.appendChild(configRow1);
        bottom.appendChild(configRow2);
      }

      card.appendChild(bottom);
    }

    container.appendChild(card);
  }
}

function getUnifiedPoolModels() {
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

  // 聚合通道池中所有已收录个人通道（Pro / Ultra）的可用模型并集（GCP 模式独立切换，不参与底部免重载路由）
  for (const acc of (state.accounts || [])) {
    const isGcp = acc.channelType === "gcp" || Boolean(acc.gcpProjectId);
    if (isGcp) continue;
    for (const m of (acc.cachedQuota?.availableModels || [])) {
      addModelEntry(m, false);
    }
  }

  // 若个人通道池尚无缓存且当前处于个人模式，则兜底合并当前活跃会话模型
  if (modelMap.size === 0 && !state.activeAccount?.gcpProjectId) {
    for (const m of (state.availableModels || [])) {
      addModelEntry(m, false);
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

function buildRouteOptionsList(modelObj = null) {
  const t = I18N[currentLang];
  const options = [
    { value: "follow_current", label: t.routeFollowCurrent, badgeType: "", badgeText: "" },
    { value: "auto_poll", label: t.routeAutoPoll, badgeType: "", badgeText: "" }
  ];

  const seenValues = new Set(["follow_current", "auto_poll"]);

  for (const acc of (state.accounts || [])) {
    const isGcp = acc.channelType === "gcp" || Boolean(acc.gcpProjectId);
    // GCP 模式已彻底独立出底部免重载路由池，仅列出个人通道（Free / Plus / Pro / Ultra）
    if (isGcp) continue;
    // 若指定了模型对象，则下拉框仅列出实际支持该模型的个人通道
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

function createCustomDropdown(selectedValue, onSelect, modelObj = null) {
  const options = buildRouteOptionsList(modelObj);
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

function selectAutoPollChannel(accounts, m, activeChannelId, thresholdPct = 5) {
  const candidates = [];
  for (const acc of accounts) {
    const isGcp = acc.channelType === "gcp" || Boolean(acc.gcpProjectId);
    if (isGcp) continue;
    const matched = findModelInChannel(acc, m);
    if (!matched) continue;
    const pct = Number(matched.remainingPct ?? 100);
    if (pct <= 0) continue;
    const resetMs = matched.resetTime ? new Date(matched.resetTime).getTime() : Number.MAX_SAFE_INTEGER;
    candidates.push({
      acc,
      matched,
      isGcp: false,
      pct,
      aboveThreshold: pct > thresholdPct,
      resetMs: Number.isFinite(resetMs) && resetMs > 0 ? resetMs : Number.MAX_SAFE_INTEGER,
      isCurrent: acc.id === activeChannelId
    });
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    // 1. 优先选剩余额度高于阈值 (>5%) 的个人通道
    if (a.aboveThreshold !== b.aboveThreshold) return a.aboveThreshold ? -1 : 1;
    // 2. 按最快重置时间优先（resetMs 越小越先重置，优先把即将重置的额度用完，避免从高到低用一点就来回切号）
    if (Math.abs(a.resetMs - b.resetMs) > 120000) {
      return a.resetMs - b.resetMs;
    }
    // 3. 若重置时间相近（例如均为未启用满额窗口），保持当前活跃通道稳定不跳变
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return b.pct - a.pct;
  });

  return candidates[0];
}

function formatModelQuotaSubText(m, selectedRoute) {
  const t = I18N[currentLang];
  const accounts = state.accounts || [];
  const activeChannelId = state.activeAccount?.channelId || "";
  const thresholdPct = Number(state.routing?.lowQuotaThresholdPct ?? 5);

  // 1. 自动轮询有余额通道：按最快重置时间优先选出可用通道并持续用尽再切
  if (selectedRoute === "auto_poll") {
    const picked = selectAutoPollChannel(accounts, m, activeChannelId, thresholdPct);
    if (picked) {
      const { acc: bestAcc, matched: bestModel, isGcp } = picked;
      const shortName = isGcp ? `${t.channelGcpBadge}·${bestAcc.gcpProjectId.slice(0, 12)}` : bestAcc.email.split("@")[0];
      if (isGcp) {
        return `${t.autoPollSubPrefix}${shortName} · ${t.gcpRouteSubUnlimited}`;
      }
      const countdown = formatResetCountdown(bestModel.resetTime);
      return countdown
        ? `${t.autoPollSubPrefix}${shortName} · ${t.remainingLabel} ${bestModel.remainingPct}% · ${t.resetsInPrefix}${countdown}${t.resetsInSuffix}`
        : `${t.autoPollSubPrefix}${shortName} · ${t.remainingLabel} ${bestModel.remainingPct}%`;
    }
  }

  // 2. 指定具体通道：显示所选通道下该模型的真实剩余百分比与重置倒计时
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

  // 3. 跟随当前通道：显示当前激活通道的配额与重置时间（若当前通道为 GCP 则不显示剩余百分比；若当前通道不支持该模型则提示）
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
  const models = getUnifiedPoolModels();
  const routeMap = state.routing?.models || {};

  for (const m of models) {
    let selectedRoute = routeMap[m.modelId] || "follow_current";
    // 若原先绑定的特定通道不支持该模型，自动回退显示为 follow_current
    if (selectedRoute.startsWith("account:")) {
      const targetAcc = (state.accounts || []).find((a) => a.id === selectedRoute.slice(8));
      if (!targetAcc || !findModelInChannel(targetAcc, m)) {
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
      saveRoutingRule({ modelId: m.modelId, variantIds: m.variantIds || [], targetSpec: newVal });
      if (newVal.startsWith("account:")) {
        probeChannelQuotaInBackground(newVal.slice(8));
      } else if (newVal === "auto_poll") {
        loadSystemStatus(true, true);
      }
    }, m);

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
      state = data;
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
      renderAddGcpDrawer();
      showToast(t.toastGcpNoneFound);
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

async function startIsolatedBrowserLogin() {
  try {
    const res = await fetch("/api/start-oauth-login", { method: "POST" });
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

async function switchGoogleAccount(accountId) {
  try {
    selectedQuotaChannelId = "";
    showToast(I18N[currentLang].toastAccountSwitching);
    const res = await fetch("/api/switch-account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId })
    });
    const data = await res.json();
    if (data.snapshot) {
      state = data.snapshot;
      renderAll();
    }
    if (data.instant) {
      showToast(I18N[currentLang].toastProjectSwitched);
    } else {
      showToast(I18N[currentLang].toastRefreshed);
      setTimeout(() => loadSystemStatus(true, true), 1200);
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
            if (currentFrontendVersion && currentFrontendVersion !== snap.frontendVersion) {
              window.location.reload();
              return;
            }
            currentFrontendVersion = snap.frontendVersion;
          }
          const prevOAuthEvent = snap.lastOAuthEvent;
          state = snap;
          renderAll();
          if (prevOAuthEvent?.success && prevOAuthEvent.email) {
            showToast(`${I18N[currentLang].toastOAuthSuccess}${prevOAuthEvent.email}`);
          }
        }
      } catch (e) {}
    };
  } catch (e) {}
}

applyI18n();
loadSystemStatus(false, true);
connectSse();
setInterval(() => {
  if (!document.hidden) {
    loadSystemStatus(false, true);
  }
}, 45000);
