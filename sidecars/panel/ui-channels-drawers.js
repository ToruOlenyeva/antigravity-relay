// 第 3 板块（通道与账号管理）及顶部三大操作抽屉（清除签名 / 多开实例 / 添加通道）视图渲染模块

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

function toggleScrubSignaturesDrawer() {
  isScrubSigsDrawerOpen = !isScrubSigsDrawerOpen;
  if (isScrubSigsDrawerOpen) {
    isMultiInstanceDrawerOpen = false;
    isAddGcpDrawerOpen = false;
  }
  renderScrubSignaturesDrawer();
  renderMultiInstanceDrawer();
  renderAddGcpDrawer();
}

function renderScrubSignaturesDrawer() {
  const drawer = document.getElementById("scrubSigsDrawer");
  if (!drawer) return;
  if (!isScrubSigsDrawerOpen) {
    drawer.style.display = "none";
    drawer.innerHTML = "";
    return;
  }
  drawer.style.display = "flex";
  drawer.innerHTML = "";
  const t = I18N[currentLang];

  const header = document.createElement("div");
  header.className = "gcp-drawer-header";
  const titleSpan = document.createElement("span");
  titleSpan.textContent = t.scrubDrawerTitle;
  header.appendChild(titleSpan);
  drawer.appendChild(header);

  const actionRow = document.createElement("div");
  actionRow.className = "gcp-config-row";
  actionRow.style.justifyContent = "flex-end";
  actionRow.style.flexWrap = "wrap";

  const currentOnlyBtn = document.createElement("button");
  currentOnlyBtn.className = "secondary small";
  currentOnlyBtn.textContent = t.btnScrubCurrentConv || "仅清除当前会话";
  currentOnlyBtn.onclick = async () => {
    isScrubSigsDrawerOpen = false;
    renderScrubSignaturesDrawer();
    await handleManualScrubSignatures("current");
  };

  const scanMismatchBtn = document.createElement("button");
  scanMismatchBtn.className = "danger small";
  scanMismatchBtn.textContent = t.btnScrubProjectMismatched || "全项目扫描清除不匹配签名";
  scanMismatchBtn.onclick = async () => {
    isScrubSigsDrawerOpen = false;
    renderScrubSignaturesDrawer();
    await handleManualScrubSignatures("mismatched");
  };

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "secondary small";
  cancelBtn.textContent = t.btnCloseGcpConfig;
  cancelBtn.onclick = () => {
    isScrubSigsDrawerOpen = false;
    renderScrubSignaturesDrawer();
  };

  actionRow.appendChild(currentOnlyBtn);
  actionRow.appendChild(scanMismatchBtn);
  actionRow.appendChild(cancelBtn);
  drawer.appendChild(actionRow);
}

function toggleMultiInstanceDrawer() {
  isMultiInstanceDrawerOpen = !isMultiInstanceDrawerOpen;
  if (isMultiInstanceDrawerOpen) {
    isScrubSigsDrawerOpen = false;
    isAddGcpDrawerOpen = false;
  }
  renderScrubSignaturesDrawer();
  renderMultiInstanceDrawer();
  renderAddGcpDrawer();
}

function renderMultiInstanceDrawer() {
  const drawer = document.getElementById("multiInstanceDrawer");
  if (!drawer) return;
  if (!isMultiInstanceDrawerOpen) {
    drawer.style.display = "none";
    drawer.innerHTML = "";
    return;
  }
  drawer.style.display = "flex";
  drawer.innerHTML = "";
  const t = I18N[currentLang];

  const currentIsGcp = Boolean(state.activeAccount?.gcpProjectId);
  const inst = state.instance || {};
  const isMultiLocked = Boolean(
    inst.multiLaunchLocked ||
    (currentIsGcp && inst.otherPersonalInstance) ||
    (!currentIsGcp && inst.otherGcpInstance)
  );
  const allAccounts = state.accounts || [];
  // 处于个人通道时列出 GCP 通道供多开；处于 GCP 通道时列出个人账号供多开
  const complementaryList = allAccounts.filter((acc) => {
    const isGcp = acc.channelType === "gcp" || Boolean(acc.gcpProjectId);
    return currentIsGcp ? !isGcp : isGcp;
  });

  const header = document.createElement("div");
  header.className = "gcp-drawer-header";
  const titleSpan = document.createElement("span");
  titleSpan.textContent = isMultiLocked
    ? t.multiDrawerLockedTitle
    : (currentIsGcp ? t.multiDrawerTitleFromGcp : t.multiDrawerTitleFromPersonal);
  const closeBtn = document.createElement("button");
  closeBtn.className = "secondary small";
  closeBtn.textContent = t.btnCloseGcpConfig;
  closeBtn.onclick = () => {
    isMultiInstanceDrawerOpen = false;
    renderMultiInstanceDrawer();
  };
  header.appendChild(titleSpan);
  header.appendChild(closeBtn);
  drawer.appendChild(header);

  if (isMultiLocked) {
    const lockHint = document.createElement("div");
    lockHint.className = "section-hint";
    lockHint.style.padding = "4px 2px";
    lockHint.style.lineHeight = "1.45";
    const otherInfo = currentIsGcp
      ? (inst.otherPersonalInstance?.email || "")
      : (inst.otherGcpInstance ? `${inst.otherGcpInstance.email} · ${inst.otherGcpInstance.gcpProjectId}` : "");
    lockHint.textContent = otherInfo
      ? `${t.multiDrawerLockedDesc} (${otherInfo})`
      : t.multiDrawerLockedDesc;
    drawer.appendChild(lockHint);
    return;
  }

  if (complementaryList.length === 0) {
    const emptyHint = document.createElement("div");
    emptyHint.className = "section-hint";
    emptyHint.style.padding = "4px 2px";
    emptyHint.textContent = currentIsGcp ? t.multiDrawerEmptyPersonal : t.multiDrawerEmptyGcp;
    drawer.appendChild(emptyHint);
    return;
  }

  if (!selectedMultiInstanceTargetId || !complementaryList.some((c) => c.id === selectedMultiInstanceTargetId)) {
    selectedMultiInstanceTargetId = complementaryList[0].id;
  }

  const row = document.createElement("div");
  row.className = "gcp-config-row";

  const opts = complementaryList.map((acc) => {
    const isGcp = acc.channelType === "gcp" || Boolean(acc.gcpProjectId);
    const badgeInfo = getChannelBadgeInfo(acc);
    return {
      value: acc.id,
      label: isGcp ? `${acc.email} · ${acc.gcpProjectId}` : acc.email,
      badgeType: badgeInfo.badgeType,
      badgeText: badgeInfo.badgeText
    };
  });

  const targetDropdown = createCompactFormDropdown(opts, selectedMultiInstanceTargetId, (val) => {
    selectedMultiInstanceTargetId = val;
    renderMultiInstanceDrawer();
  });

  const launchBtn = document.createElement("button");
  launchBtn.className = "small";
  launchBtn.textContent = t.btnConfirmLaunchMulti;
  launchBtn.onclick = () => {
    if (!selectedMultiInstanceTargetId) return;
    const targetId = selectedMultiInstanceTargetId;
    isMultiInstanceDrawerOpen = false;
    renderMultiInstanceDrawer();
    launchIsolatedInstance(targetId);
  };

  row.appendChild(targetDropdown);
  row.appendChild(launchBtn);
  drawer.appendChild(row);
}

function toggleAddGcpDrawer() {
  isAddGcpDrawerOpen = !isAddGcpDrawerOpen;
  if (isAddGcpDrawerOpen) {
    isScrubSigsDrawerOpen = false;
    isMultiInstanceDrawerOpen = false;
  }
  renderScrubSignaturesDrawer();
  renderMultiInstanceDrawer();
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

  // 收集所有已保存了 OAuth Token 的唯一 Google 邮箱（含通过浏览器登录但尚未绑定 GCP 项目的邮箱）
  const uniqueEmails = [];
  if (state.activeAccount?.email) {
    uniqueEmails.push(state.activeAccount.email);
  }
  for (const acc of (state.accounts || [])) {
    if (acc.email && !uniqueEmails.includes(acc.email)) {
      uniqueEmails.push(acc.email);
    }
  }
  for (const em of (state.oauthEmails || [])) {
    if (em && !uniqueEmails.includes(em)) {
      uniqueEmails.push(em);
    }
  }
  if (!addGcpDraft.email || !uniqueEmails.includes(addGcpDraft.email)) {
    addGcpDraft.email = uniqueEmails[0] || "";
  }
  if (uniqueEmails.length === 0) {
    addGcpDraft.sourceMode = "new_oauth";
  } else if (!addGcpDraft.sourceMode) {
    addGcpDraft.sourceMode = "new_oauth";
  }

  const isNewOAuthMode = addGcpDraft.sourceMode === "new_oauth";

  // 复用已有账号模式下：若所选邮箱已经存在个人通道卡片，则通道类型仅允许添加 GCP 通道；若该邮箱仅有 GCP 通道，则允许添加 GCP 新项目或个人通道
  const existingPersonalForDraft = !isNewOAuthMode
    ? (state.accounts || []).find(
        (a) => a.email === addGcpDraft.email && a.channelType !== "gcp" && !a.gcpProjectId
      )
    : null;
  if (!isNewOAuthMode && existingPersonalForDraft) {
    addGcpDraft.channelType = "gcp";
  } else if (!addGcpDraft.channelType) {
    addGcpDraft.channelType = isNewOAuthMode ? "personal" : "gcp";
  }

  const header = document.createElement("div");
  header.className = "gcp-drawer-header";
  const titleSpan = document.createElement("span");
  titleSpan.textContent = t.gcpDrawerTitle;
  const headerBtns = document.createElement("div");
  headerBtns.className = "btn-group";
  const hasExistingGcpForDraft = !isNewOAuthMode && addGcpDraft.email
    ? (state.accounts || []).some(
        (a) => a.email === addGcpDraft.email && (a.channelType === "gcp" || Boolean(a.gcpProjectId))
      )
    : false;
  if (!isNewOAuthMode && addGcpDraft.channelType !== "personal" && addGcpDraft.email && hasExistingGcpForDraft) {
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

  // 第 1 行：选择账号来源模式（浏览器登录新账号置顶 / 复用本地已有账号凭据居次） + 通道类型（个人通道 / GCP 通道，无前置方形徽章）
  const modeTypeRow = document.createElement("div");
  modeTypeRow.className = "gcp-config-row";

  const sourceOpts = [
    { value: "new_oauth", label: t.addModeBrowserNew }
  ];
  if (uniqueEmails.length > 0) {
    sourceOpts.push({ value: "existing", label: t.addModeReuseExisting });
  }

  const sourceDropdown = createCompactFormDropdown(sourceOpts, addGcpDraft.sourceMode, (val) => {
    addGcpDraft.sourceMode = val;
    addGcpDraft.scannedProjects = [];
    if (val === "new_oauth") {
      addGcpDraft.channelType = "personal";
    }
    renderAddGcpDrawer();
  });

  const typeOpts = [];
  if (isNewOAuthMode || !existingPersonalForDraft) {
    typeOpts.push({
      value: "personal",
      label: t.drawerChannelTypePersonal
    });
  }
  typeOpts.push({
    value: "gcp",
    label: t.drawerChannelTypeGcp
  });
  if (!typeOpts.some((o) => o.value === addGcpDraft.channelType)) {
    addGcpDraft.channelType = typeOpts[0].value;
  }

  const typeDropdown = createCompactFormDropdown(typeOpts, addGcpDraft.channelType, (val) => {
    addGcpDraft.channelType = val;
    renderAddGcpDrawer();
  });

  modeTypeRow.appendChild(sourceDropdown);
  modeTypeRow.appendChild(typeDropdown);
  drawer.appendChild(modeTypeRow);

  // 分支 A：浏览器登录新账号模式
  if (isNewOAuthMode) {
    if (addGcpDraft.channelType === "personal") {
      const oauthActionRow = document.createElement("div");
      oauthActionRow.className = "gcp-config-row";
      oauthActionRow.style.justifyContent = "flex-end";
      const loginPersonalBtn = document.createElement("button");
      loginPersonalBtn.className = "small";
      loginPersonalBtn.textContent = t.btnStartNewOAuthPersonal;
      loginPersonalBtn.onclick = () => {
        isAddGcpDrawerOpen = false;
        renderAddGcpDrawer();
        startIsolatedBrowserLogin({ channelType: "personal" });
      };
      oauthActionRow.appendChild(loginPersonalBtn);
      drawer.appendChild(oauthActionRow);
      return;
    }

    // 浏览器登录新 GCP 账号：可选择计费方式与区域，项目 ID 可预填（一步直绑）或留空（登录完成后自动触发扫描）
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

    const pidRow = document.createElement("div");
    pidRow.className = "gcp-config-row";
    const pidInput = document.createElement("input");
    pidInput.type = "text";
    pidInput.className = "compact-input";
    pidInput.placeholder = t.accGcpPlaceholder;
    pidInput.value = addGcpDraft.projectId || "";
    const loginGcpBtn = document.createElement("button");
    loginGcpBtn.className = "small";
    loginGcpBtn.textContent = t.btnStartNewOAuthGcpDirect;
    pidInput.oninput = () => {
      addGcpDraft.projectId = pidInput.value;
    };
    loginGcpBtn.onclick = () => {
      const cleanPid = (pidInput.value || "").trim();
      if (cleanPid) {
        isAddGcpDrawerOpen = false;
        addGcpDraft.projectId = "";
        renderAddGcpDrawer();
      }
      startIsolatedBrowserLogin({
        channelType: "gcp",
        gcpProjectId: cleanPid,
        gcpBillingMode: addGcpDraft.gcpBillingMode,
        gcpLocation: addGcpDraft.gcpLocation
      });
    };
    pidRow.appendChild(pidInput);
    pidRow.appendChild(loginGcpBtn);
    drawer.appendChild(pidRow);
    return;
  }

  // 分支 B：复用本地已有账号凭据模式 —— 选择已有邮箱
  const emailRow = document.createElement("div");
  emailRow.className = "gcp-config-row";
  const emailOpts = uniqueEmails.map((em) => ({
    value: em,
    label: em
  }));
  const emailDropdown = createCompactFormDropdown(emailOpts, addGcpDraft.email, (val) => {
    addGcpDraft.email = val;
    addGcpDraft.scannedProjects = [];
    renderAddGcpDrawer();
  });
  emailRow.appendChild(emailDropdown);

  // 若所选已有账号尚无个人通道卡片且用户选了添加个人通道，同行右侧直接放确认添加按钮
  if (addGcpDraft.channelType === "personal") {
    const submitPersonalBtn = document.createElement("button");
    submitPersonalBtn.className = "small";
    submitPersonalBtn.textContent = t.btnAddGcpForEmail;
    submitPersonalBtn.onclick = () => {
      if (!addGcpDraft.email) return;
      addPersonalChannelForEmail(addGcpDraft.email);
      isAddGcpDrawerOpen = false;
      renderAddGcpDrawer();
    };
    emailRow.appendChild(submitPersonalBtn);
    drawer.appendChild(emailRow);
    return;
  }
  drawer.appendChild(emailRow);

  // 选择云项目计费模式与区域（圆角悬浮下拉）
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

  // 若自动扫描发现了多个项目 ID，提供下拉列表点击填入输入框
  if (Array.isArray(addGcpDraft.scannedProjects) && addGcpDraft.scannedProjects.length > 1) {
    const scannedRow = document.createElement("div");
    scannedRow.className = "gcp-config-row";
    const scannedOpts = addGcpDraft.scannedProjects.map((p) => ({
      value: p.projectId,
      label: p.name && p.name !== p.projectId ? `${p.projectId} (${p.name})` : p.projectId
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

  // 输入云项目编号 + 确认添加
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

function buildAccountCardElement(acc, activeEmail, activeGcp) {
  const t = I18N[currentLang];
  const isGcpChannel = acc.channelType === "gcp" || Boolean(acc.gcpProjectId);
  const accPid = (acc.gcpProjectId || "").trim();
  const activeChannelId = String(state.activeAccount?.channelId || "").trim();
  const isCurrent = activeChannelId
    ? acc.id === activeChannelId
    : Boolean(
        acc.email === activeEmail &&
        ((isGcpChannel && accPid === activeGcp && activeGcp !== "") || (!isGcpChannel && activeGcp === ""))
      );
  const currentIsGcp = Boolean(activeGcp);
  const isCrossChannelSwitch = currentIsGcp !== isGcpChannel;
  const inst = state.instance || {};
  const otherPersonalInst = inst.otherPersonalInstance || null;
  const otherGcpInst = inst.otherGcpInstance || null;
  const isLockedByOtherWindow = Boolean(
    isCrossChannelSwitch &&
    ((isGcpChannel && otherGcpInst) || (!isGcpChannel && otherPersonalInst))
  );
  const isActiveInOtherWindow = Boolean(
    (isGcpChannel && otherGcpInst && (otherGcpInst.activeChannelId === acc.id || (otherGcpInst.email === acc.email && otherGcpInst.gcpProjectId === accPid))) ||
    (!isGcpChannel && otherPersonalInst && (otherPersonalInst.activeChannelId === acc.id || otherPersonalInst.email === acc.email))
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

  const isSwitchingThis = Boolean(switchingAccountId && switchingAccountId === acc.id);
  const isEffectiveCurrent = isCurrent && !isSwitchingThis && !switchingAccountId;

  if (isSwitchingThis) {
    const switchingBtn = document.createElement("button");
    switchingBtn.className = "secondary small";
    switchingBtn.disabled = true;
    switchingBtn.style.opacity = "0.85";
    switchingBtn.style.cursor = "wait";
    switchingBtn.textContent = t.switchingBadge || "切换中...";
    rightBadges.appendChild(switchingBtn);
  } else if (isEffectiveCurrent) {
    const curTag = document.createElement("span");
    curTag.className = "badge";
    curTag.textContent = t.currentBadge;
    rightBadges.appendChild(curTag);
  } else if (isLockedByOtherWindow) {
    const lockedBtn = document.createElement("button");
    lockedBtn.className = "secondary small";
    lockedBtn.style.opacity = "0.75";
    lockedBtn.textContent = isActiveInOtherWindow ? t.otherWindowActiveBadge : t.otherWindowLockedBtn;
    lockedBtn.onclick = () => {
      showToast(isGcpChannel ? t.toastLockedGcpInOtherWindow : t.toastLockedPersonalInOtherWindow);
    };
    rightBadges.appendChild(lockedBtn);
  } else {
    const switchBtn = document.createElement("button");
    switchBtn.className = "small";
    switchBtn.disabled = Boolean(switchingAccountId);
    switchBtn.textContent = t.btnSwitchAccount;
    switchBtn.onclick = () => {
      if (switchingAccountId) return;
      // 同通道切换（个人 <-> 个人 或 GCP <-> GCP）直接无感切换且绝不清除签名；
      // 仅当跨通道切换（个人 <-> GCP）时展开内联签名清理确认条
      if (!isCrossChannelSwitch) {
        pendingCrossSwitchAccountId = "";
        switchGoogleAccount(acc.id, false);
      } else {
        pendingCrossSwitchAccountId = pendingCrossSwitchAccountId === acc.id ? "" : acc.id;
        renderAccountList();
      }
    };
    rightBadges.appendChild(switchBtn);
  }

  if (pendingDeleteAccountId === acc.id) {
    const confirmBtn = document.createElement("button");
    confirmBtn.className = "danger small";
    confirmBtn.textContent = t.btnConfirmDelete;
    confirmBtn.onclick = () => {
      pendingDeleteAccountId = "";
      clearTimeout(pendingDeleteTimer);
      deleteAccountProfile(acc.id);
    };
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "secondary small";
    cancelBtn.textContent = t.btnCancelDelete;
    cancelBtn.onclick = () => {
      pendingDeleteAccountId = "";
      clearTimeout(pendingDeleteTimer);
      renderAccountList();
    };
    rightBadges.appendChild(confirmBtn);
    rightBadges.appendChild(cancelBtn);
  } else {
    const delBtn = document.createElement("button");
    delBtn.className = "danger small";
    delBtn.textContent = t.btnDeleteAccount;
    delBtn.onclick = () => {
      pendingDeleteAccountId = acc.id;
      clearTimeout(pendingDeleteTimer);
      pendingDeleteTimer = setTimeout(() => {
        if (pendingDeleteAccountId === acc.id) {
          pendingDeleteAccountId = "";
          renderAccountList();
        }
      }, 4000);
      renderAccountList();
    };
    rightBadges.appendChild(delBtn);
  }

  top.appendChild(rightBadges);
  card.appendChild(top);

  if (pendingCrossSwitchAccountId === acc.id && !isCurrent) {
    const confirmBar = document.createElement("div");
    confirmBar.className = "cross-switch-confirm-bar";

    const promptEl = document.createElement("div");
    promptEl.className = "cross-switch-prompt";
    promptEl.textContent = t.crossSwitchPrompt;
    confirmBar.appendChild(promptEl);

    const actionsEl = document.createElement("div");
    actionsEl.className = "cross-switch-actions";

    const scrubAndSwitchBtn = document.createElement("button");
    scrubAndSwitchBtn.className = "small";
    scrubAndSwitchBtn.textContent = t.btnSwitchAndScrub;
    scrubAndSwitchBtn.onclick = () => {
      pendingCrossSwitchAccountId = "";
      switchGoogleAccount(acc.id, true);
    };

    const switchOnlyBtn = document.createElement("button");
    switchOnlyBtn.className = "secondary small";
    switchOnlyBtn.textContent = t.btnSwitchKeepSig;
    switchOnlyBtn.onclick = () => {
      pendingCrossSwitchAccountId = "";
      switchGoogleAccount(acc.id, false);
    };

    const cancelSwitchBtn = document.createElement("button");
    cancelSwitchBtn.className = "secondary small";
    cancelSwitchBtn.textContent = t.btnCancelDelete;
    cancelSwitchBtn.onclick = () => {
      pendingCrossSwitchAccountId = "";
      renderAccountList();
    };

    actionsEl.appendChild(scrubAndSwitchBtn);
    actionsEl.appendChild(switchOnlyBtn);
    actionsEl.appendChild(cancelSwitchBtn);
    confirmBar.appendChild(actionsEl);
    card.appendChild(confirmBar);
  }

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

  return card;
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

  const personalAccounts = accounts.filter((a) => a.channelType !== "gcp" && !a.gcpProjectId);
  const gcpAccounts = accounts.filter((a) => a.channelType === "gcp" || Boolean(a.gcpProjectId));
  const inst = state.instance || {};
  const lockPersonalGroup = Boolean(activeGcp && inst.otherPersonalInstance);
  const lockGcpGroup = Boolean(!activeGcp && inst.otherGcpInstance);

  if (personalAccounts.length > 0) {
    const pGroup = document.createElement("div");
    pGroup.className = "channel-group-box";
    const pHeader = document.createElement("div");
    pHeader.className = "channel-group-header";
    const pTitle = document.createElement("span");
    pTitle.className = "channel-group-title";
    pTitle.textContent = `${t.groupPersonalTitle} (${personalAccounts.length})`;
    const pHint = document.createElement("span");
    pHint.className = "channel-group-hint";
    pHint.textContent = lockPersonalGroup ? t.groupLockedByOtherPersonal : t.groupPersonalHint;
    pHeader.appendChild(pTitle);
    pHeader.appendChild(pHint);
    pGroup.appendChild(pHeader);

    for (const acc of personalAccounts) {
      pGroup.appendChild(buildAccountCardElement(acc, activeEmail, activeGcp));
    }
    container.appendChild(pGroup);
  }

  if (gcpAccounts.length > 0) {
    const gGroup = document.createElement("div");
    gGroup.className = "channel-group-box";
    const gHeader = document.createElement("div");
    gHeader.className = "channel-group-header";
    const gTitle = document.createElement("span");
    gTitle.className = "channel-group-title";
    gTitle.textContent = `${t.groupGcpTitle} (${gcpAccounts.length})`;
    const gHint = document.createElement("span");
    gHint.className = "channel-group-hint";
    gHint.textContent = lockGcpGroup ? t.groupLockedByOtherGcp : t.groupGcpHint;
    gHeader.appendChild(gTitle);
    gHeader.appendChild(gHint);
    gGroup.appendChild(gHeader);

    for (const acc of gcpAccounts) {
      gGroup.appendChild(buildAccountCardElement(acc, activeEmail, activeGcp));
    }
    container.appendChild(gGroup);
  }
}
