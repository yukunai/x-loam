(function initSpokenPolisherContent() {
  let copiedText = "";
  let overlay = null;
  let selectionSnapshot = null;
  let activePort = null;
  let activeStreamTimer = null;
  let suppressSelectionUntil = 0;

  // 取消进行中的流式请求：断开 port（后台 onDisconnect 会中止生成省 token），解锁按钮。
  // 场景：流式没结束时用户重新选中文字——不取消的话旧流的 chunk/done 会继续写进刚重置的弹窗，内容串台。
  function cancelActiveStream() {
    window.clearTimeout(activeStreamTimer);
    activeStreamTimer = null;
    if (!activePort) {
      if (overlay) {
        setPolishDisabled(false);
      }
      return;
    }
    const port = activePort;
    activePort = null; // 先置空：自己 disconnect 不触发本端 onDisconnect，靠这个标记让旧流的残余消息失效
    try {
      port.disconnect();
    } catch (e) { /* 已断开 */ }
    if (overlay) {
      setPolishDisabled(false);
    }
  }

  // 用捕获阶段监听：部分网站会在自己的 copy 处理里 stopPropagation，冒泡阶段收不到
  document.addEventListener("copy", onMaybeSelection, true);
  // 选中即弹（豆包式交互）：鼠标抬起/双击/Shift+方向键选完就出工具条，不用按复制
  document.addEventListener("mouseup", onMaybeSelection, true);
  document.addEventListener("dblclick", onMaybeSelection, true);
  document.addEventListener("selectionchange", debounceSelectionCheck, true);
  document.addEventListener("keyup", (event) => {
    if (event.shiftKey || event.key === "Shift") {
      onMaybeSelection(event);
    }
  }, true);

  // 豆包式交互：点弹窗以外的任意空白处，工具条/面板立即收起（重新选中文字会再弹出）
  document.addEventListener("mousedown", (event) => {
    if (!overlay || overlay.hidden) {
      return;
    }
    if (event.target && overlay.contains(event.target)) {
      return; // 点的是弹窗自己，不收
    }
    cancelActiveStream();
    stopSpeaking();
    overlay.hidden = true;
  }, true);
  // 按 Esc 也能关
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && overlay && !overlay.hidden) {
      cancelActiveStream();
      stopSpeaking();
      overlay.hidden = true;
    }
  }, true);

  let selectionTimer = null;

  function debounceSelectionCheck() {
    window.clearTimeout(selectionTimer);
    selectionTimer = window.setTimeout(() => onMaybeSelection(), 80);
  }

  function onMaybeSelection(event) {
    if (Date.now() < suppressSelectionUntil) {
      return;
    }
    if (event && event.target && overlay && overlay.contains(event.target)) {
      return; // 在工具条/面板里的操作不要重新弹窗，否则会清掉刚生成的结果
    }
    if (isSelectionInsideOverlay()) {
      return;
    }
    // 等浏览器把选区状态结算完再读，mouseup 时选区有时还是上一拍的
    window.setTimeout(() => {
      const snapshot = captureSelection();
      const selected = snapshot ? snapshot.text : "";
      if (selected && selected !== copiedText) {
        copiedText = selected;
        showOverlay(selected, snapshot);
      } else if (selected && overlay && overlay.hidden) {
        showOverlay(selected, snapshot);
      } else if (selected && overlay && !activePort) {
        setPolishDisabled(false);
      }
    }, 0);
  }

  function isSelectionInsideOverlay() {
    if (!overlay || overlay.hidden) {
      return false;
    }
    if (overlay.contains(document.activeElement)) {
      return true;
    }
    const selection = window.getSelection ? window.getSelection() : null;
    return Boolean(selection && selection.anchorNode && overlay.contains(selection.anchorNode));
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== "SPOKEN_POLISH_SELECTION") {
      return;
    }
    const snapshot = captureSelection();
    copiedText = message.text || (snapshot && snapshot.text) || "";
    showOverlay(copiedText, snapshot);
  });

  function captureSelection() {
    const active = document.activeElement;
    if (active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT")) {
      const start = active.selectionStart;
      const end = active.selectionEnd;
      if (typeof start === "number" && typeof end === "number" && end > start) {
        return {
          kind: "text-control",
          element: active,
          start,
          end,
          text: String(active.value || "").slice(start, end).trim(),
          rect: active.getBoundingClientRect(),
          editable: true
        };
      }
    }
    const selection = window.getSelection ? window.getSelection() : null;
    if (!selection || selection.rangeCount === 0) {
      return null;
    }
    const range = selection.getRangeAt(0);
    const text = String(selection).trim();
    if (!text) {
      return null;
    }
    const rect = range.getBoundingClientRect();
    const parent = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    const editable = closestEditable(parent);
    const offsets = editable ? getRangeTextOffsets(editable, range) : null;
    return {
      kind: "range",
      range: range.cloneRange(),
      text,
      rect: rect && rect.width && rect.height ? rect : null,
      editable: Boolean(editable),
      editableElement: editable || null,
      editableText: editable ? String(editable.textContent || "") : "",
      startOffset: offsets ? offsets.start : null,
      endOffset: offsets ? offsets.end : null
    };
  }

  function getRangeTextOffsets(root, range) {
    if (!root || !range) {
      return null;
    }
    try {
      const startRange = document.createRange();
      startRange.selectNodeContents(root);
      startRange.setEnd(range.startContainer, range.startOffset);
      const endRange = document.createRange();
      endRange.selectNodeContents(root);
      endRange.setEnd(range.endContainer, range.endOffset);
      return {
        start: startRange.toString().length,
        end: endRange.toString().length
      };
    } catch (e) {
      return null;
    }
  }

  // contenteditable 检测：isContentEditable 覆盖 contenteditable=""（合法写法，等价 true）和继承场景，
  // 仅按 [contenteditable="true"] 选择器匹配会漏掉它们，导致「插入/替换」在这类编辑器里被误禁用
  function closestEditable(element) {
    if (!element) {
      return null;
    }
    const bySelector = element.closest('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]');
    if (bySelector) {
      return bySelector;
    }
    return element.isContentEditable ? element : null;
  }

  function showOverlay(text, snapshot) {
    if (!text.trim()) {
      return;
    }
    selectionSnapshot = snapshot || null;

    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "spoken-polisher";
      overlay.innerHTML = [
        '<div class="spoken-polisher__bar">',
        '<span class="spoken-polisher__grip" aria-hidden="true">☰</span>',
        '<button type="button" data-action="copy-source">复制</button>',
        '<button type="button" data-action="polish" class="spoken-polisher__primary">润色</button>',
        '<button type="button" data-action="rewrite">改写</button>',
        '<button type="button" data-action="speak">朗读</button>',
        '<button type="button" data-action="toggle-panel" aria-label="更多设置">⋯</button>',
        '<button type="button" data-action="close" aria-label="关闭">×</button>',
        "</div>",
        '<div class="spoken-polisher__body" hidden>',
        '<div class="spoken-polisher__card-head">',
        '<strong data-role="title">润色</strong>',
        '<span data-role="status"></span>',
        "</div>",
        '<div class="spoken-polisher__result" data-role="output" aria-live="polite"></div>',
        '<div class="spoken-polisher__panel-controls">',
        '<select data-role="skill" aria-label="选择技能">',
        '<option value="">口语化润色</option>',
        "</select>",
        '<select data-role="provider" aria-label="选择模型">',
        '<option value="">默认模型</option>',
        '<option value="anthropic">Claude</option>',
        '<option value="deepseek">DeepSeek</option>',
        '<option value="openai">ChatGPT</option>',
        "</select>",
        '<select data-role="tier" aria-label="模型档位">',
        '<option value="">快速（默认）</option>',
        '<option value="strong">最强</option>',
        "</select>",
        "</div>",
        '<div class="spoken-polisher__actions">',
        '<button type="button" data-action="insert" disabled>插入</button>',
        '<button type="button" data-action="replace" disabled>替换</button>',
        '<button type="button" data-action="speak">朗读</button>',
        '<button type="button" data-action="copy" disabled>复制</button>',
        '<button type="button" data-action="polish" title="重新润色">↻</button>',
        "</div>",
        "</div>"
      ].join("");
      document.documentElement.appendChild(overlay);
      overlay.addEventListener("click", onOverlayClick);
    }

    cancelActiveStream(); // 新选区到来，旧流式请求作废，防止旧结果写进新弹窗
    overlay.querySelector('[data-role="output"]').textContent = "";
    overlay.querySelector('[data-action="copy"]').disabled = true;
    updateEditActions(false);
    stopSpeaking();
    setStatus("");
    overlay.hidden = false;
    overlay.querySelector(".spoken-polisher__body").hidden = true;
    positionOverlay(snapshot && snapshot.rect);
    loadSkills();
  }

  function positionOverlay(anchorRect) {
    const gap = 8;
    const fallbackTop = Math.max(12, window.innerHeight - overlay.offsetHeight - 18);
    const fallbackLeft = 18;
    let top = fallbackTop;
    let left = fallbackLeft;

    if (anchorRect) {
      top = anchorRect.bottom + gap;
      left = anchorRect.left;
    }

    const maxLeft = Math.max(8, window.innerWidth - overlay.offsetWidth - 8);
    const maxTop = Math.max(8, window.innerHeight - overlay.offsetHeight - 8);
    overlay.style.left = `${Math.min(Math.max(8, left), maxLeft)}px`;
    overlay.style.top = `${Math.min(Math.max(8, top), maxTop)}px`;
  }

  function loadSkills() {
    safeRuntimeSendMessage({ type: "SPOKEN_POLISH_SKILLS" }, (response, error) => {
      if (error || !response || !response.ok) {
        if (error && isExtensionContextInvalidated(error.message)) {
          setStatus("插件刚刚重新加载过，请刷新当前网页。");
        }
        return; // 拿不到列表时保留内置选项，不影响润色
      }
      renderSkillOptions(response.skills);
    });
  }

  function safeRuntimeSendMessage(message, callback) {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError || null;
        callback(response, error);
      });
    } catch (error) {
      callback(null, error);
    }
  }

  function isExtensionContextInvalidated(message) {
    return String(message || "").toLowerCase().includes("extension context invalidated");
  }

  function renderSkillOptions(skills) {
    const select = overlay.querySelector('[data-role="skill"]');
    const current = select.value;
    select.textContent = "";
    skills.forEach((skill) => {
      const option = document.createElement("option");
      option.value = skill.id;
      option.textContent = skill.name;
      select.appendChild(option);
    });
    const stillExists = Array.prototype.some.call(select.options, (option) => option.value === current);
    if (stillExists) {
      select.value = current;
    }
  }

  function onOverlayClick(event) {
    const action = event.target && event.target.getAttribute("data-action");
    if (action === "close") {
      cancelActiveStream();
      stopSpeaking();
      overlay.hidden = true;
      return;
    }
    if (action === "polish") {
      requestPolish();
      return;
    }
    if (action === "rewrite") {
      // 改写原文：意思保持 ≥90%，字面相似度 ≤35%
      requestPolish("deep-rewrite");
      return;
    }
    if (action === "toggle-panel") {
      togglePanel();
      return;
    }
    if (action === "copy-source") {
      copySource();
      return;
    }
    if (action === "speak") {
      toggleSpeak();
      return;
    }
    if (action === "insert") {
      insertOutput();
      return;
    }
    if (action === "replace") {
      replaceOutput();
      return;
    }
    if (action === "copy") {
      copyOutput();
    }
  }

  function togglePanel(forceOpen) {
    const body = overlay.querySelector(".spoken-polisher__body");
    const controls = overlay.querySelector(".spoken-polisher__panel-controls");
    body.hidden = false;
    if (controls) {
      controls.hidden = typeof forceOpen === "boolean" ? !forceOpen : !controls.hidden;
    }
    positionOverlay(selectionSnapshot && selectionSnapshot.rect);
  }

  // 有声阅读：浏览器自带 speechSynthesis，零权限。优先读润色结果，没有就读原文；再点一次停止。
  function toggleSpeak() {
    if (!window.speechSynthesis) {
      setStatus("当前浏览器不支持语音朗读。");
      return;
    }
    if (window.speechSynthesis.speaking) {
      stopSpeaking();
      return;
    }
    const text = overlay.querySelector('[data-role="output"]').textContent.trim()
      || copiedText;
    if (!text) {
      setStatus("没有可朗读的文字。");
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    utterance.onend = () => {
      setSpeakLabels("朗读");
      setStatus("");
    };
    utterance.onerror = (event) => {
      setSpeakLabels("朗读");
      if (event.error === "canceled" || event.error === "interrupted") {
        setStatus(""); // 主动停止或被新朗读打断，不是错误
        return;
      }
      setStatus("朗读出错，换个浏览器或检查系统语音设置。");
    };
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    setSpeakLabels("停止");
    setStatus("正在朗读...");
  }

  // 工具条和卡片各有一个朗读按钮，状态要一起变
  function setSpeakLabels(label) {
    if (!overlay) {
      return;
    }
    overlay.querySelectorAll('[data-action="speak"]').forEach((button) => {
      button.textContent = label;
    });
  }

  function stopSpeaking() {
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    setSpeakLabels("朗读");
  }

  function requestPolish(skillIdOverride) {
    cancelActiveStream(); // 先废掉旧流，再置灰当前请求；避免旧流状态把按钮卡死
    const provider = overlay.querySelector('[data-role="provider"]').value || undefined;
    const skillSelect = overlay.querySelector('[data-role="skill"]');
    if (skillIdOverride) {
      // 工具条快捷按钮（如「改写」）指定技能时，同步下拉框，这样 ↻ 重新生成会沿用同一技能
      const exists = Array.prototype.some.call(skillSelect.options, (option) => option.value === skillIdOverride);
      if (exists) {
        skillSelect.value = skillIdOverride;
      }
    }
    const skillId = skillIdOverride || skillSelect.value || undefined;
    // 卡片标题：润色显示「润色」，改写显示「改写原文」，自定义技能显示技能名
    let skillName;
    if (!skillId || skillId === "spoken-polisher") {
      skillName = "润色";
    } else if (skillId === "deep-rewrite") {
      skillName = "改写原文";
    } else {
      skillName = skillSelect.selectedOptions[0] ? skillSelect.selectedOptions[0].textContent : "润色";
    }
    overlay.querySelector('[data-role="title"]').textContent = skillName;
    // 按任务临时选档：strong = 本次用最强模型（不改存储设置），默认走快速档
    const tier = overlay.querySelector('[data-role="tier"]').value || undefined;
    const text = copiedText || (selectionSnapshot && selectionSnapshot.text) || "";
    setPolishDisabled(true);
    stopSpeaking();
    overlay.querySelector(".spoken-polisher__body").hidden = false;
    overlay.querySelector(".spoken-polisher__panel-controls").hidden = true;
    const outputEl = overlay.querySelector('[data-role="output"]');
    outputEl.textContent = "";
    updateEditActions(false);
    setStatus(skillId === "deep-rewrite" ? "正在改写..." : "正在润色...");

    // 流式：长连接逐字上屏（豆包式）。chunk 边收边追加；phase 表示进入强化改写、清屏重来；
    // done 收尾启用按钮；error 显示原因。弹窗中途关闭会断开 port，后台随即中止生成省 token。
    let firstChunk = true;
    let repositioned = false;
    let port;
    try {
      port = chrome.runtime.connect({ name: "spoken-polish-stream" });
    } catch (error) {
      setPolishDisabled(false);
      setStatus(isExtensionContextInvalidated(error && error.message)
        ? "插件刚刚重新加载过，请刷新当前网页。"
        : "连接后台失败，请刷新页面或重新加载插件。");
      return;
    }
    activePort = port;
    // 兜底计时器是「无活动超时」而不是总时长：最强档+长文改写+相似度强化重试是两次串行
    // 流式调用，总时长可以正常超过 120 秒；只要 chunk/phase 还在到达就不断重置，
    // 只有 120 秒收不到任何回包（后台真死了）才取消。
    const armStreamWatchdog = () => {
      window.clearTimeout(activeStreamTimer);
      activeStreamTimer = window.setTimeout(() => {
        if (port !== activePort) {
          return;
        }
        cancelActiveStream();
        if (outputEl.textContent.trim()) {
          overlay.querySelector('[data-action="copy"]').disabled = false;
          setStatus("连接超时，已保留当前结果，可复制或重试。");
        } else {
          setStatus("连接超时，请点「润色」或「改写」重试。");
        }
      }, 120000);
    };
    armStreamWatchdog();
    port.onMessage.addListener((message) => {
      if (!message || port !== activePort) {
        return; // 已被取消的旧流发来的残余消息，直接丢弃
      }
      if (message.type === "chunk") {
        armStreamWatchdog(); // 还在产出，喂狗
        if (firstChunk) {
          firstChunk = false;
          setStatus(""); // 第一个字到了，撤掉「正在润色…」
        }
        outputEl.textContent += message.delta;
        outputEl.scrollTop = outputEl.scrollHeight;
        if (!repositioned && outputEl.textContent.length > 40) {
          repositioned = true; // 内容初具规模时调一次位置，避免每个字都跳
          positionOverlay(selectionSnapshot && selectionSnapshot.rect);
        }
        return;
      }
      if (message.type === "phase") {
        armStreamWatchdog(); // 进入强化改写等新阶段，同样算活动
        setStatus(message.label || "");
        outputEl.textContent = "";
        firstChunk = true;
        return;
      }
      if (message.type === "done") {
        window.clearTimeout(activeStreamTimer);
        activeStreamTimer = null;
        outputEl.textContent = message.text;
        outputEl.scrollTop = 0;
        setPolishDisabled(false);
        overlay.querySelector('[data-action="copy"]').disabled = false;
        updateEditActions(true);
        setStatus(message.notice || "已完成。");
        positionOverlay(selectionSnapshot && selectionSnapshot.rect);
        activePort = null;
        port.disconnect();
        return;
      }
      if (message.type === "error") {
        window.clearTimeout(activeStreamTimer);
        activeStreamTimer = null;
        setPolishDisabled(false);
        setStatus(message.error || "润色失败。");
        activePort = null;
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      // 只处理后台异常断开（service worker 被回收等）；正常 done/error/主动取消都已把 activePort 置空
      if (port !== activePort) {
        return;
      }
      window.clearTimeout(activeStreamTimer);
      activeStreamTimer = null;
      activePort = null;
      setPolishDisabled(false);
      // 内容优先：已经流出来的部分结果保留可复制，不让用户白等
      if (outputEl.textContent.trim()) {
        overlay.querySelector('[data-action="copy"]').disabled = false;
      }
      setStatus("连接中断，请点「润色」或「↻」重试。");
    });
    try {
      port.postMessage({ type: "SPOKEN_POLISH_STREAM", text, provider, skillId, tier });
    } catch (error) {
      if (port === activePort) {
        activePort = null;
      }
      try {
        port.disconnect();
      } catch (ignored) { /* 已断开 */ }
      window.clearTimeout(activeStreamTimer);
      activeStreamTimer = null;
      setPolishDisabled(false);
      setStatus("发送请求失败，请刷新页面或重新加载插件。");
    }
  }

  function setPolishDisabled(disabled) {
    if (!overlay) {
      return;
    }
    overlay.querySelectorAll('[data-action="polish"], [data-action="rewrite"]').forEach((button) => {
      button.disabled = disabled;
    });
  }

  function copyOutput() {
    const output = overlay.querySelector('[data-role="output"]').textContent;
    navigator.clipboard.writeText(output)
      .then(() => setStatus("结果已复制。"))
      .catch(() => setStatus("复制失败，请手动选择结果。"));
  }

  function copySource() {
    navigator.clipboard.writeText(copiedText)
      .then(() => setStatus("原文已复制。"))
      .catch(() => setStatus("复制失败，请手动选择原文。"));
  }

  function insertOutput() {
    const output = overlay.querySelector('[data-role="output"]').textContent;
    if (!output || !insertText(output)) {
      setStatus("当前页面不支持直接插入，结果已保留可复制。");
      return;
    }
    finishEditAndClose();
  }

  async function replaceOutput() {
    const output = overlay.querySelector('[data-role="output"]').textContent;
    if (!output || !(await replaceText(output))) {
      setStatus("当前页面不支持直接替换，结果已保留可复制。");
      return;
    }
    finishEditAndClose();
  }

  function finishEditAndClose() {
    suppressSelectionUntil = Date.now() + 800;
    cancelActiveStream();
    stopSpeaking();
    if (overlay) {
      overlay.hidden = true;
    }
  }

  function insertText(text) {
    if (!selectionSnapshot || !selectionSnapshot.editable) {
      return false;
    }
    if (selectionSnapshot.kind === "text-control") {
      return editTextControl(text, false);
    }
    return editContentEditable(text, false);
  }

  async function replaceText(text) {
    if (!selectionSnapshot || !selectionSnapshot.editable) {
      return false;
    }
    const mainWorldResult = await editInPageMainWorld(text, true);
    if (mainWorldResult) {
      return true;
    }
    if (selectionSnapshot.kind === "text-control") {
      return editTextControl(text, true);
    }
    return editContentEditable(text, true);
  }

  function prepareSelectionForPageEdit(replace) {
    if (!selectionSnapshot || !selectionSnapshot.editable) {
      return false;
    }
    if (selectionSnapshot.kind === "text-control") {
      const element = selectionSnapshot.element;
      if (!element) {
        return false;
      }
      element.focus();
      try {
        const start = replace ? selectionSnapshot.start : selectionSnapshot.end;
        const end = replace ? selectionSnapshot.end : selectionSnapshot.end;
        element.setSelectionRange(start, end);
      } catch (e) { /* number/email 等 input 可能不支持选择，交给 fallback */ }
      return true;
    }
    const range = selectionSnapshot.range;
    const editable = selectionSnapshot.editableElement || (range && getEditableRoot(range));
    if (editable && typeof editable.focus === "function") {
      editable.focus();
    }
    return restoreEditableSelection(range, replace);
  }

  function editInPageMainWorld(text, replace) {
    if (!prepareSelectionForPageEdit(replace)) {
      return Promise.resolve(false);
    }
    const selectionMeta = {
      kind: selectionSnapshot.kind,
      editableText: selectionSnapshot.editableText || "",
      startOffset: selectionSnapshot.startOffset,
      endOffset: selectionSnapshot.endOffset,
      start: selectionSnapshot.start,
      end: selectionSnapshot.end
    };
    return new Promise((resolve) => {
      safeRuntimeSendMessage({
        type: "SPOKEN_POLISH_PAGE_EDIT",
        text,
        replace,
        selectionMeta
      }, (response, error) => {
        if (error || !response || !response.ok) {
          if (error && isExtensionContextInvalidated(error.message)) {
            setStatus("插件刚刚重新加载过，请刷新当前网页。");
          }
          resolve(false);
          return;
        }
        resolve(true);
      });
    });
  }

  function editTextControl(text, replace) {
    const element = selectionSnapshot && selectionSnapshot.element;
    if (!element) {
      return false;
    }
    const valueText = normalizeTextForControl(element, text);
    element.focus();
    const value = String(element.value || "");
    const start = replace ? selectionSnapshot.start : selectionSnapshot.end;
    const end = replace ? selectionSnapshot.end : selectionSnapshot.end;
    const nextValue = value.slice(0, start) + valueText + value.slice(end);
    try {
      setNativeControlValue(element, nextValue);
      element.setSelectionRange(start + valueText.length, start + valueText.length);
    } catch (e) {
      element.value = nextValue;
      try {
        element.setSelectionRange(start + valueText.length, start + valueText.length);
      } catch (ignored) { /* email/number 等类型不支持光标定位，忽略 */ }
    }
    dispatchEditEvents(element, replace ? "insertReplacementText" : "insertText", valueText);
    return true;
  }

  function setNativeControlValue(element, value) {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && typeof descriptor.set === "function") {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  function normalizeTextForControl(element, text) {
    const value = String(text || "");
    if (element && element.tagName === "TEXTAREA") {
      return value;
    }
    // 单行 input 天生不能保存换行。把多段结果合成一行完整文字，避免浏览器只接收第一行。
    return value.replace(/\r\n/g, "\n").split(/\n+/).map((line) => line.trim()).filter(Boolean).join(" ");
  }

  function editContentEditable(text, replace) {
    const range = selectionSnapshot && selectionSnapshot.range;
    if (!range) {
      return false;
    }
    const editable = selectionSnapshot.editableElement || getEditableRoot(range);
    if (editable && typeof editable.focus === "function") {
      editable.focus();
    }

    if (!restoreEditableSelection(range, replace)) {
      return mutateRange(range, text, replace, editable);
    }

    // 优先走浏览器编辑命令，让 ProseMirror/Notion/微信公众号等编辑器接收到真实输入事件。
    // 直接 insertNode 会绕过编辑器状态，部分站点会显示成不可继续编辑的“死文字”。
    // 多行文本用 insertHTML + <br>，否则部分编辑器的 insertText 只吃第一行。
    let beforeText = editable ? editable.textContent : null;
    let replacedOriginal = false;
    if (replace) {
      const deleted = deleteEditableSelection(range, editable, beforeText);
      if (!deleted) {
        return replaceEditablePlainText(text, editable) || mutateRange(range, text, true, editable);
      }
      replacedOriginal = true;
      beforeText = editable ? editable.textContent : null;
    }
    if (hasLineBreak(text) && document.queryCommandSupported && document.queryCommandSupported("insertHTML")) {
      try {
        const ok = document.execCommand("insertHTML", false, multilineTextToHtml(text));
        if (ok && editableMutationApplied(editable, beforeText, text)) {
          if (editable) {
            dispatchEditEvents(editable, replace ? "insertReplacementText" : "insertText", text);
          }
          return true;
        }
      } catch (e) {
        // 回退到 insertText / DOM 写入。
      }
    }
    if (document.queryCommandSupported && document.queryCommandSupported("insertText")) {
      try {
        if (!replace) {
          restoreEditableSelection(range, false);
        }
        const ok = document.execCommand("insertText", false, text);
        if (ok && editableMutationApplied(editable, beforeText, text)) {
          if (editable) {
            dispatchEditEvents(editable, replace ? "insertReplacementText" : "insertText", text);
          }
          return true;
        }
      } catch (e) {
        // 回退到 DOM 写入。
      }
    }

    if (replace && replaceEditablePlainText(text, editable)) {
      return true;
    }
    return mutateRange(range, text, replace && !replacedOriginal, editable);
  }

  function deleteEditableSelection(range, editable, beforeText) {
    if (!restoreEditableSelection(range, true)) {
      return false;
    }
    if (!(document.queryCommandSupported && document.queryCommandSupported("delete"))) {
      return false;
    }
    try {
      const ok = document.execCommand("delete", false, null);
      if (!ok) {
        return false;
      }
      if (!editable || beforeText === null) {
        return true;
      }
      return editable.textContent !== beforeText;
    } catch (e) {
      return false;
    }
  }

  function restoreEditableSelection(range, replace) {
    const selection = window.getSelection && window.getSelection();
    if (!selection) {
      return false;
    }
    try {
      const working = range.cloneRange();
      if (!replace) {
        working.collapse(false);
      }
      selection.removeAllRanges();
      selection.addRange(working);
      return true;
    } catch (e) {
      return false;
    }
  }

  function editableMutationApplied(editable, beforeText, insertedText) {
    if (!editable || beforeText === null) {
      return true;
    }
    const afterText = editable.textContent;
    if (afterText !== beforeText) {
      return true;
    }
    return !String(insertedText || "").trim();
  }

  function replaceEditablePlainText(text, editable) {
    const root = editable || (selectionSnapshot && selectionSnapshot.editableElement);
    if (!root || !selectionSnapshot || selectionSnapshot.startOffset === null || selectionSnapshot.endOffset === null) {
      return false;
    }
    const source = String(selectionSnapshot.editableText || root.textContent || "");
    const start = Math.max(0, Math.min(selectionSnapshot.startOffset, source.length));
    const end = Math.max(start, Math.min(selectionSnapshot.endOffset, source.length));
    const next = source.slice(0, start) + String(text || "") + source.slice(end);
    root.textContent = next;
    placeCursorInTextNode(root, start + String(text || "").length);
    dispatchEditEvents(root, "insertReplacementText", text);
    return root.textContent === next;
  }

  function placeCursorInTextNode(root, offset) {
    const selection = window.getSelection && window.getSelection();
    if (!selection || !root.firstChild || root.firstChild.nodeType !== Node.TEXT_NODE) {
      return;
    }
    const position = Math.max(0, Math.min(offset, root.firstChild.textContent.length));
    const range = document.createRange();
    range.setStart(root.firstChild, position);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function hasLineBreak(text) {
    return /\r|\n/.test(String(text || ""));
  }

  function multilineTextToHtml(text) {
    return String(text || "")
      .replace(/\r\n/g, "\n")
      .split(/\n/)
      .map((line) => escapeHtml(line))
      .join("<br>");
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function getEditableRoot(range) {
    const node = range.commonAncestorContainer;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return closestEditable(element);
  }

  function mutateRange(range, text, replace, editableRoot) {
    if (!range) {
      return false;
    }
    let working;
    try {
      working = range.cloneRange();
      if (!replace) {
        working.collapse(false);
      } else {
        working.deleteContents();
      }
    } catch (e) {
      return false;
    }
    const insertion = createEditableInsertion(text);
    working.insertNode(insertion.node);
    if (insertion.lastNode) {
      working.setStartAfter(insertion.lastNode);
    }
    working.collapse(true);
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(working);
    }
    const anchor = insertion.lastNode && insertion.lastNode.parentElement;
    const editable = editableRoot || closestEditable(anchor);
    if (editable) {
      dispatchEditEvents(editable, replace ? "insertReplacementText" : "insertText", text);
    }
    return true;
  }

  function createEditableInsertion(text) {
    const value = String(text || "").replace(/\r\n/g, "\n");
    if (!hasLineBreak(value)) {
      const node = document.createTextNode(value);
      return { node, lastNode: node };
    }
    const fragment = document.createDocumentFragment();
    let lastNode = null;
    value.split(/\n/).forEach((line, index) => {
      if (index > 0) {
        lastNode = document.createElement("br");
        fragment.appendChild(lastNode);
      }
      lastNode = document.createTextNode(line);
      fragment.appendChild(lastNode);
    });
    return { node: fragment, lastNode };
  }

  function dispatchEditEvents(element, inputType, data) {
    const type = inputType || "insertText";
    try {
      element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: type, data: String(data || "") }));
    } catch (e) { /* 老浏览器不支持完整 InputEvent 初始化，继续派发 input */ }
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: type, data: String(data || "") }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function updateEditActions(hasOutput) {
    const canEdit = Boolean(hasOutput && selectionSnapshot && selectionSnapshot.editable);
    overlay.querySelector('[data-action="insert"]').disabled = !canEdit;
    overlay.querySelector('[data-action="replace"]').disabled = !canEdit;
  }

  function setStatus(message) {
    overlay.querySelector('[data-role="status"]').textContent = message;
  }
})();
