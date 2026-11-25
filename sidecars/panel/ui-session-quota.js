// 第 1 板块（账户模型额度）与第 2 板块（当前会话统计）视图渲染模块

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

function getPersonalAccountTierKeyUi(ch) {
  if (!ch) return "";
  const isGcp = ch.channelType === "gcp" || Boolean(ch.gcpProjectId);
  if (isGcp) return "";
  const code = String(ch.tierCode || ch.cachedQuota?.tierCode || ch.cachedQuotaByPool?.daily?.tierCode || "").trim();
  const tName = String(ch.tierName || ch.cachedQuota?.tierName || "").trim();
  if (/^ultra$/i.test(code) || /\bultra\b/i.test(tName)) return "ultra";
  if (/^pro$/i.test(code) || /\bpro\b/i.test(tName)) {
    const subCode = String(
      ch.tierSubCode || ch.cachedQuota?.tierSubCode || ch.cachedQuotaByPool?.daily?.tierSubCode || ""
    ).trim().toLowerCase();
    const isRestricted =
      subCode === "pro_lite" ||
      ch.paidProRestricted === true ||
      ch.cachedQuota?.paidProRestricted === true ||
      ch.cachedQuotaByPool?.daily?.paidProRestricted === true;
    return isRestricted ? "pro_lite" : "pro";
  }
  if (/^plus$/i.test(code) || /\bplus\b/i.test(tName)) return "plus";
  if (/^free$/i.test(code) || /\bfree\b|standard|starter/i.test(tName)) return "free";
  return "";
}

function getChannelBadgeInfo(ch) {
  const t = I18N[currentLang];
  if (!ch) return { badgeType: "unknown", badgeText: t.channelUnknownBadge || "未知", badgeSubText: "" };
  const isGcp = ch.channelType === "gcp" || Boolean(ch.gcpProjectId);
  if (isGcp) {
    return { badgeType: "gcp", badgeText: t.channelGcpBadge, badgeSubText: "" };
  }
  const tierKey = getPersonalAccountTierKeyUi(ch);
  if (tierKey === "ultra") {
    return { badgeType: "ultra", badgeText: "Ultra", badgeSubText: "" };
  }
  if (tierKey === "pro_lite") {
    return { badgeType: "pro-lite", badgeText: "Pro", badgeSubText: "Trial" };
  }
  if (tierKey === "pro") {
    return { badgeType: "personal", badgeText: t.channelPersonalBadge || "Pro", badgeSubText: "Paid" };
  }
  if (tierKey === "plus") {
    return { badgeType: "plus", badgeText: "Plus", badgeSubText: "" };
  }
  if (tierKey === "free") {
    return { badgeType: "free", badgeText: "Free", badgeSubText: "" };
  }
  return { badgeType: "unknown", badgeText: t.channelUnknownBadge || "未知", badgeSubText: "" };
}

/**
 * 创建带防外部 DOM 翻译保护的通道类型徽章节点（支持单行与双层微徽章）。
 * @param {string} badgeType 徽章样式类别
 * @param {string} badgeText 徽章主文本
 * @param {string} badgeSubText 可选上行辅助小字（如 Trial / Paid）
 * @returns {HTMLSpanElement}
 */
function createChannelBadgeNode(badgeType, badgeText, badgeSubText = "") {
  const badge = document.createElement("span");
  badge.className = `channel-type-badge ${badgeType || "personal"}${badgeSubText ? " stacked" : ""} notranslate`;
  badge.setAttribute("translate", "no");
  if (badgeSubText) {
    const subEl = document.createElement("span");
    subEl.className = "badge-sub";
    subEl.textContent = badgeSubText;
    const mainEl = document.createElement("span");
    mainEl.className = "badge-main";
    mainEl.textContent = badgeText;
    badge.appendChild(subEl);
    badge.appendChild(mainEl);
    badge.title = `${badgeSubText} ${badgeText}`;
  } else {
    badge.textContent = badgeText;
  }
  return badge;
}

function getSignatureBadgeDisplay(sigStatus, t) {
  const st = sigStatus || { sigType: "none", mismatched: false };
  const sigType = st.sigType || "none";
  if (sigType === "gcp") {
    return {
      text: `${t.sigBadgeGcp || "签名: GCP"}${st.mismatched ? (t.sigMismatchSuffix || " · 不匹配") : ""}`,
      shortText: "GCP",
      className: "telemetry-sig-badge gcp" + (st.mismatched ? " mismatched" : ""),
      pillType: st.mismatched ? "mismatch" : "gcp"
    };
  }
  if (sigType === "personal") {
    return {
      text: `${t.sigBadgePersonal || "签名: 个人"}${st.mismatched ? (t.sigMismatchSuffix || " · 不匹配") : ""}`,
      shortText: currentLang === "zh" ? "个人" : "Pro",
      className: "telemetry-sig-badge personal" + (st.mismatched ? " mismatched" : ""),
      pillType: st.mismatched ? "mismatch" : "personal"
    };
  }
  return {
    text: t.sigBadgeNone || "无签名",
    shortText: currentLang === "zh" ? "无签名" : "Clean",
    className: "telemetry-sig-badge none",
    pillType: "none"
  };
}

function renderTelemetryConvSelector(tel, viewedItem) {
  const mount = document.getElementById("telemetryConvSelectorMount");
  if (!mount) return;
  mount.innerHTML = "";
  const t = I18N[currentLang];
  const convList = Array.isArray(tel.projectConversations) ? tel.projectConversations : [];
  if (convList.length === 0 && !tel.conversationId) return;

  const options = [];
  for (const c of convList) {
    const sigDisp = getSignatureBadgeDisplay(c.signatureStatus, t);
    options.push({
      value: c.fullConversationId || c.conversationId,
      label: c.title || c.conversationId,
      badgeText: sigDisp.shortText,
      badgeType: sigDisp.pillType,
      isCurrentActive: Boolean(c.isCurrentActive)
    });
  }

  if (options.length === 0) return;

  const selectedVal = viewedItem.fullConversationId || viewedItem.conversationId || options[0].value;
  const activeOpt = options.find((o) => o.value === selectedVal) || options[0];

  const wrapper = document.createElement("div");
  wrapper.className = "custom-dropdown session-selector-dropdown telemetry-conv-dropdown";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "dropdown-trigger";

  const leftWrap = document.createElement("div");
  leftWrap.className = "active-email-wrap";

  const triggerDot = document.createElement("span");
  triggerDot.className = "status-dot" + (activeOpt.isCurrentActive ? " online" : "");
  leftWrap.appendChild(triggerDot);

  if (activeOpt.badgeText) {
    leftWrap.appendChild(createChannelBadgeNode(activeOpt.badgeType || "personal", activeOpt.badgeText));
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

    const itemDot = document.createElement("span");
    itemDot.className = "status-dot" + (opt.isCurrentActive ? " online" : "");
    itemLeft.appendChild(itemDot);

    if (opt.badgeText) {
      itemLeft.appendChild(createChannelBadgeNode(opt.badgeType || "personal", opt.badgeText));
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
      const defaultActiveId = tel.fullConversationId || tel.conversationId || "";
      selectedTelemetryConvId = (opt.value === defaultActiveId) ? "" : opt.value;
      renderSessionTelemetry();
      if (typeof flushDeferredRender === "function") flushDeferredRender();
    };

    menu.appendChild(item);
  }

  trigger.onclick = (ev) => {
    ev.stopPropagation();
    if (typeof toggleCustomDropdownWrapper === "function") {
      toggleCustomDropdownWrapper(wrapper);
    }
  };

  wrapper.appendChild(trigger);
  wrapper.appendChild(menu);
  mount.appendChild(wrapper);
}

function renderSessionTelemetry() {
  const t = I18N[currentLang];
  const tel = state.telemetry || {};
  const convList = Array.isArray(tel.projectConversations) ? tel.projectConversations : [];

  let viewedItem = tel;
  if (selectedTelemetryConvId) {
    const matched = convList.find(
      (c) => c.fullConversationId === selectedTelemetryConvId || c.conversationId === selectedTelemetryConvId
    );
    if (matched) {
      viewedItem = matched;
    } else {
      selectedTelemetryConvId = "";
      viewedItem = convList.find((c) => c.isCurrentActive) || convList[0] || tel;
    }
  } else {
    viewedItem = convList.find((c) => c.isCurrentActive) || convList[0] || tel;
  }

  const telTitleEl = document.getElementById("secTelemetryTitle");
  if (telTitleEl && t.secTelemetryTitle) {
    telTitleEl.textContent = t.secTelemetryTitle;
  }

  // 渲染顶栏当前查看会话的签名来源徽章（GCP 签名 / 个人签名 / 混合冲突 / 无签名）
  const sigBadgeMount = document.getElementById("telemetrySigBadgeMount");
  if (sigBadgeMount) {
    sigBadgeMount.innerHTML = "";
    const sigDisp = getSignatureBadgeDisplay(viewedItem.signatureStatus || tel.signatureStatus, t);
    const sigBadgeEl = document.createElement("span");
    sigBadgeEl.className = sigDisp.className;
    sigBadgeEl.textContent = sigDisp.text;
    sigBadgeMount.appendChild(sigBadgeEl);
  }

  // 渲染项目会话签名切换下拉框
  renderTelemetryConvSelector(tel, viewedItem);
}

function renderSessionSelector() {
  const mount = document.getElementById("sessionChannelSelectorMount");
  if (!mount) return;
  mount.innerHTML = "";
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
      tierCode: active.tierCode || "",
      tierName: active.tierName || "",
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
  leftWrap.appendChild(createChannelBadgeNode(curBadge.badgeType, curBadge.badgeText, curBadge.badgeSubText));

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
    itemLeft.appendChild(createChannelBadgeNode(chBadge.badgeType, chBadge.badgeText, chBadge.badgeSubText));

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
      if (typeof flushDeferredRender === "function") flushDeferredRender();
      if (ch.id !== activeChannelId) {
        probeChannelQuotaInBackground(ch.id);
      }
    };

    menu.appendChild(item);
  }

  trigger.onclick = (ev) => {
    ev.stopPropagation();
    if (typeof toggleCustomDropdownWrapper === "function") {
      toggleCustomDropdownWrapper(wrapper);
    }
  };

  wrapper.appendChild(trigger);
  wrapper.appendChild(menu);
  mount.appendChild(wrapper);
}

let lastAutoProbedChannelId = "";
let lastAutoProbedAt = 0;

async function probeChannelQuotaInBackground(channelId) {
  try {
    if (!channelId) return;
    lastAutoProbedChannelId = channelId;
    lastAutoProbedAt = Date.now();
    const res = await fetch("/api/probe-channel-quota", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelId })
    });
    const data = await res.json();
    if (data && data.snapshot) {
      state = data.snapshot;
      if (typeof safeRenderAll === "function") {
        safeRenderAll();
      } else if (typeof renderAll === "function") {
        renderAll();
      } else {
        renderSessionSelector();
        renderQuotaGroups();
      }
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

function getActivePersonalPoolUi() {
  return "daily";
}

function renderQuotaPoolSwitch(_isGcpChannel) {
  const mount = document.getElementById("quotaPoolSwitchMount");
  if (!mount) return;
  mount.innerHTML = "";
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

  renderQuotaPoolSwitch(isGcpChannel);

  const activePool = getActivePersonalPoolUi();
  const poolSnapshot = !isGcpChannel
    ? (viewedAcc?.cachedQuotaByPool?.[activePool] ||
       ((viewedAcc?.cachedQuota?.pool || viewedAcc?.cachedQuota?.quotaPool || "") === activePool
         ? viewedAcc?.cachedQuota
         : null))
    : (viewedAcc?.cachedQuota || null);

  const rawSourceGroups = !isGcpChannel
    ? (Array.isArray(poolSnapshot?.quotaGroups) && poolSnapshot.quotaGroups.length > 0
        ? poolSnapshot.quotaGroups
        : (isViewingActive && Array.isArray(state.quotaGroups) ? state.quotaGroups : []))
    : [];
  let groups = rawSourceGroups.filter((g) => {
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

    const isOrchUiModel = (m) => /^orchestrator\b|orchestrator[-_]|^model_placeholder_m(537|667|668)$/i.test(String(m?.label || m?.modelId || "").trim());
    const rawGcpModels = viewedAcc?.cachedQuota?.availableModels || (isViewingActive ? state.availableModels : []) || [];
    const gcpModels = rawGcpModels.filter((m) => m && !isOrchUiModel(m));
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

  const isOrchUiModel = (m) => /^orchestrator\b|orchestrator[-_]|^model_placeholder_m(537|667|668)$/i.test(String(m?.label || m?.modelId || "").trim());
  const rawPersonalModels = Array.isArray(poolSnapshot?.availableModels) && poolSnapshot.availableModels.length > 0
    ? poolSnapshot.availableModels
    : (isViewingActive && Array.isArray(state.availableModels) ? state.availableModels : []);
  const personalModels = rawPersonalModels.filter((m) => m && !isOrchUiModel(m));

  if (groups.length === 0 && !isGcpChannel) {
    const hasAuthExp = Boolean(viewedAcc?.authExpired);
    const hasProbeErr = Boolean(viewedAcc?.lastProbeError?.message);
    if (!hasAuthExp && !hasProbeErr && personalModels.length > 0) {
      const groupEl = document.createElement("div");
      groupEl.className = "quota-group";

      const titleEl = document.createElement("div");
      titleEl.className = "quota-group-title";
      titleEl.textContent = currentLang === "zh" ? "可用模型实时额度" : "Live Model Quotas";
      groupEl.appendChild(titleEl);

      for (const pm of personalModels) {
        const pct = pm.remainingPct ?? 100;
        const countdown = formatResetCountdown(pm.resetTime);

        const row = document.createElement("div");
        row.className = "quota-bucket-row";

        const labelEl = document.createElement("span");
        labelEl.className = "quota-bucket-label";
        labelEl.textContent = pm.label || pm.modelId;

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
      if (
        viewedAcc?.cachedQuota?.probedVia !== "cloudcode_http" &&
        targetChannelId &&
        (lastAutoProbedChannelId !== targetChannelId || Date.now() - lastAutoProbedAt > 8000)
      ) {
        probeChannelQuotaInBackground(targetChannelId);
      }
      return;
    }

    const hint = document.createElement("div");
    hint.className = "section-hint" + ((hasAuthExp || hasProbeErr) ? " quota-error-hint" : "");
    hint.style.padding = "6px 2px";
    if (hasAuthExp) {
      hint.textContent = t.quotaAuthExpiredHint || "登录凭据已过期，请点击下方账号卡片徽章重新登录";
    } else if (hasProbeErr) {
      hint.textContent = t.quotaProbeFailedHint || "配额获取失败，请点击下方账号卡片异常徽章查看详情";
    } else {
      hint.textContent = t.quotaNoCacheHint;
    }
    container.appendChild(hint);
    if (
      !hasAuthExp &&
      !hasProbeErr &&
      targetChannelId &&
      (lastAutoProbedChannelId !== targetChannelId || Date.now() - lastAutoProbedAt > 8000)
    ) {
      probeChannelQuotaInBackground(targetChannelId);
    }
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

  if (personalModels.length > 0) {
    const modelsCard = document.createElement("div");
    modelsCard.className = "personal-pool-models-bar";

    const modelsLabel = document.createElement("div");
    modelsLabel.className = "gcp-models-label";
    modelsLabel.textContent = t.personalModelsLabel || t.personalModelsLabelDaily || "该账号已识别可用模型：";
    modelsCard.appendChild(modelsLabel);

    const chipsWrap = document.createElement("div");
    chipsWrap.className = "gcp-model-chips";
    for (const pm of personalModels) {
      const chip = document.createElement("span");
      chip.className = "gcp-model-chip";
      chip.textContent = pm.label || pm.modelId;
      chipsWrap.appendChild(chip);
    }
    modelsCard.appendChild(chipsWrap);
    container.appendChild(modelsCard);
  }
}
