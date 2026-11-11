importScripts("polish-core.js");

const CORE = self.SpokenPolisherCore;
const MENU_ID = "spoken-polisher-polish";
const CACHE_TTL_MS = 5 * 60 * 1000;
const EMPTY_OUTPUT_MESSAGE = "模型没有返回可用文本。";
const resultCache = new Map();
const inFlight = new Map();

chrome.runtime.onInstalled.addListener(() => {
  // 扩展更新/重载时 onInstalled 会再次触发，先清掉旧菜单避免 duplicate id 报错
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "润色成口语化文风",
      contexts: ["selection"]
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || !tab.id) {
    return;
  }
  chrome.tabs.sendMessage(tab.id, {
    type: "SPOKEN_POLISH_SELECTION",
    text: info.selectionText || ""
  });
});

// ===== 流式通道（豆包式逐字上屏）=====
// content 用 chrome.runtime.connect({name:"spoken-polish-stream"}) 建长连接，
// 后台边收 SSE 边转发：{type:"chunk",delta} → {type:"phase",label}(改写强化时) → {type:"done",text,notice} / {type:"error",error}
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "spoken-polish-stream") {
    return;
  }
  port.onMessage.addListener((message) => {
    if (!message || message.type !== "SPOKEN_POLISH_STREAM") {
      return;
    }
    streamPolish(port, message).catch((error) => {
      safePost(port, { type: "error", error: error.message || String(error) });
    });
  });
});

function safePost(port, message) {
  try {
    port.postMessage(message);
  } catch (e) { /* 弹窗已关、port 断开——静默 */ }
}

async function streamPolish(port, message) {
  const settings = await chrome.storage.local.get(null);
  const normalized = CORE.applyModelTier(CORE.normalizeSettings(settings), message.tier);
  const provider = message.provider || normalized.provider;
  const text = message.text;
  const skillId = message.skillId;

  // 命中缓存直接秒回（相同文字+模型+技能 5 分钟内）
  const cacheKey = buildCacheKey(text, provider, skillId, message.tier, normalized);
  const cached = getCached(cacheKey);
  if (cached) {
    safePost(port, { type: "done", text: cached.text, notice: cached.notice || "（缓存）秒回。" });
    return;
  }

  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort()); // 用户关弹窗就停止生成，省 token

  let output = await streamOrFallback(provider,
    CORE.buildProviderRequest(provider, text, normalized, skillId, true),
    CORE.buildProviderRequest(provider, text, normalized, skillId, false),
    (delta) => safePost(port, { type: "chunk", delta }),
    controller.signal);

  let notice = "";
  if (skillId === CORE.REWRITE_SKILL.id) {
    let similarity = CORE.surfaceSimilarity(text, output);
    if (similarity > CORE.REWRITE_MAX_SIMILARITY) {
      // 第一稿相似度超标 → 通知前端清屏，流式强化改写；失败则保留第一稿（内容必须生产出来）
      safePost(port, { type: "phase", label: `相似度 ${Math.round(similarity * 100)}%，强化改写中…` });
      try {
        output = await streamOrFallback(provider,
          CORE.buildRewriteRetryRequest(provider, output, text, normalized, true),
          CORE.buildRewriteRetryRequest(provider, output, text, normalized, false),
          (delta) => safePost(port, { type: "chunk", delta }),
          controller.signal);
        similarity = CORE.surfaceSimilarity(text, output);
      } catch (e) {
        safePost(port, { type: "phase", label: "强化失败，保留第一稿" });
        safePost(port, { type: "chunk", delta: output });
      }
    }
    notice = similarity > CORE.REWRITE_MAX_SIMILARITY
      ? `提示：字面相似度 ${Math.round(similarity * 100)}%，仍高于 35%，可点「↻」再改一轮。`
      : `已完成，字面相似度 ${Math.round(similarity * 100)}%。`;
  }

  const cacheable = !notice.includes("仍高于 35%");
  if (cacheable) {
    resultCache.set(cacheKey, { result: { text: output, notice }, expiresAt: Date.now() + CACHE_TTL_MS });
    trimCache();
  }
  safePost(port, { type: "done", text: output, notice });
}

async function streamOrFallback(provider, streamRequest, fallbackRequest, onDelta, signal) {
  try {
    return await streamCall(provider, streamRequest, onDelta, signal);
  } catch (error) {
    if (!isEmptyOutputError(error) || (signal && signal.aborted)) {
      throw error;
    }
    // 有些接口/模型会返回非标准流式事件，导致没有 delta。此时同一请求退回非流式，
    // 能拿到正文就交付正文；拿不到时 callProvider 会给出更具体的空输出/拒绝/截断原因。
    return callProvider(provider, fallbackRequest);
  }
}

function isEmptyOutputError(error) {
  return Boolean(error && (error.message || String(error)).includes(EMPTY_OUTPUT_MESSAGE));
}

// 读取 SSE 流：逐行解析 "data: {...}"，每个文字增量回调 onDelta，返回完整文本
async function streamCall(provider, request, onDelta, signal) {
  const response = await fetch(request.url, Object.assign({}, request.options, { signal }));
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const message = payload && payload.error && (payload.error.message || payload.error.type);
    throw new Error(message || `API 请求失败：HTTP ${response.status}`);
  }

  if (!response.body || !response.body.getReader) {
    throw new Error(EMPTY_OUTPUT_MESSAGE);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  let streamError = null; // 流中收到的 error/incomplete 事件，先记下，结合已有正文再决定抛不抛

  const handleLine = (rawLine) => {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) {
      return false;
    }
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      return false;
    }
    let data;
    try {
      data = JSON.parse(payload);
    } catch (e) {
      return false; // 半截 JSON（跨包），极少见，跳过
    }
    const parsed = CORE.parseSseChunk(provider, data);
    if (parsed.error) {
      streamError = new Error(parsed.error);
      return true; // 停止继续读
    }
    if (parsed.delta) {
      full += parsed.delta;
      onDelta(parsed.delta);
    }
    return false;
  };

  outer:
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // 末尾可能是半行，留到下一轮
    for (const rawLine of lines) {
      if (handleLine(rawLine)) {
        await reader.cancel().catch(() => {});
        break outer;
      }
    }
  }

  // 流结束后冲掉残余：最后一行 data: 不带换行时会留在 buffer 里，不处理就丢最后一个增量/错误事件
  if (!streamError) {
    buffer += decoder.decode();
    if (buffer.trim()) {
      handleLine(buffer);
    }
  }

  // 内容必须交付：截断（max tokens）/过滤等事件到达前往往已经流出大半正文，
  // 有正文就交付正文，只有一个字都没拿到时才报错（空输出错误会触发上层非流式兜底）。
  if (streamError && !full.trim()) {
    throw streamError;
  }
  if (!full.trim()) {
    throw new Error(EMPTY_OUTPUT_MESSAGE);
  }
  return full.trim();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) {
    return false;
  }

  if (message.type === "SPOKEN_POLISH_SKILLS") {
    chrome.storage.local.get(null).then((settings) => {
      const skills = CORE.listSkills(settings).map((skill) => ({
        id: skill.id,
        name: skill.name,
        builtIn: skill.builtIn
      }));
      sendResponse({ ok: true, skills });
    });
    return true;
  }

  if (message.type === "SPOKEN_POLISH_PAGE_EDIT") {
    runPageEdit(sender, message.text, Boolean(message.replace), message.selectionMeta)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type !== "SPOKEN_POLISH_REQUEST") {
    return false;
  }

  polish(message.text, message.provider, message.skillId, message.tier)
    .then((result) => sendResponse({ ok: true, text: result.text, notice: result.notice }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

  return true;
});

async function runPageEdit(sender, text, replace, selectionMeta) {
  if (!sender || !sender.tab || typeof sender.tab.id !== "number") {
    return { ok: false, error: "无法定位当前页面。请刷新页面后重试。" };
  }
  if (!chrome.scripting || typeof chrome.scripting.executeScript !== "function") {
    return { ok: false, error: "当前浏览器不支持主页面写入。" };
  }
  const target = { tabId: sender.tab.id };
  if (typeof sender.frameId === "number") {
    target.frameIds = [sender.frameId];
  }
  const results = await chrome.scripting.executeScript({
    target,
    world: "MAIN",
    func: pageEditSelection,
    args: [String(text || ""), replace, selectionMeta || {}]
  });
  const result = results && results[0] && results[0].result;
  return result && typeof result === "object" ? result : { ok: false, error: "页面没有返回写入结果。" };
}

function pageEditSelection(text, replace, selectionMeta) {
  const value = String(text || "");
  const meta = selectionMeta && typeof selectionMeta === "object" ? selectionMeta : {};

  function compact(textValue) {
    return String(textValue || "").replace(/\s+/g, "");
  }

  function hasFullInsertedText(containerText) {
    const expected = compact(value);
    if (!expected) {
      return true;
    }
    return compact(containerText).includes(expected);
  }

  function closestEditable(element) {
    if (!element) {
      return null;
    }
    if (element.isContentEditable) {
      return element;
    }
    return element.closest && element.closest('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]');
  }

  function dispatchEditEvents(element, inputType, data) {
    const type = inputType || "insertText";
    try {
      element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: type, data: String(data || "") }));
    } catch (e) { /* ignore */ }
    try {
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: type, data: String(data || "") }));
    } catch (e) {
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setNativeControlValue(element, nextValue) {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && typeof descriptor.set === "function") {
      descriptor.set.call(element, nextValue);
    } else {
      element.value = nextValue;
    }
  }

  function insertTextNodeAtSelection(selection, insertedText) {
    if (!selection || selection.rangeCount === 0) {
      return false;
    }
    const range = selection.getRangeAt(0);
    if (replace) {
      range.deleteContents();
    } else {
      range.collapse(false);
    }
    const node = document.createTextNode(insertedText);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  function replaceEditablePlainText(editable) {
    if (!editable || typeof meta.startOffset !== "number" || typeof meta.endOffset !== "number") {
      return false;
    }
    const source = String(meta.editableText || editable.textContent || "");
    const start = Math.max(0, Math.min(meta.startOffset, source.length));
    const end = Math.max(start, Math.min(meta.endOffset, source.length));
    const next = source.slice(0, start) + value + source.slice(end);
    editable.textContent = next;
    dispatchEditEvents(editable, replace ? "insertReplacementText" : "insertText", value);
    return editable.textContent === next && hasFullInsertedText(editable.textContent);
  }

  const active = document.activeElement;
  if (active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT")) {
    const start = typeof active.selectionStart === "number" ? active.selectionStart : active.value.length;
    const end = replace && typeof active.selectionEnd === "number" ? active.selectionEnd : start;
    const source = String(active.value || "");
    const nextValue = source.slice(0, start) + value + source.slice(end);
    setNativeControlValue(active, nextValue);
    try {
      active.setSelectionRange(start + value.length, start + value.length);
    } catch (e) { /* ignore */ }
    dispatchEditEvents(active, replace ? "insertReplacementText" : "insertText", value);
    return { ok: active.value === nextValue && hasFullInsertedText(active.value), method: "main-text-control" };
  }

  const selection = window.getSelection && window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return { ok: false, error: "页面主世界没有可替换的选区。" };
  }
  const range = selection.getRangeAt(0);
  const parent = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  const editable = closestEditable(parent);
  if (!editable) {
    return { ok: false, error: "当前选区不在可编辑区域内。" };
  }
  if (typeof editable.focus === "function") {
    editable.focus();
  }

  const before = editable.textContent;
  if (replace && replaceEditablePlainText(editable)) {
    return { ok: true, method: "main-plain-offset" };
  }
  try {
    if (document.queryCommandSupported && document.queryCommandSupported("insertText")) {
      if (!replace) {
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      const ok = document.execCommand("insertText", false, value);
      if (ok && editable.textContent !== before && hasFullInsertedText(editable.textContent)) {
        dispatchEditEvents(editable, replace ? "insertReplacementText" : "insertText", value);
        return { ok: true, method: "main-insertText" };
      }
    }
  } catch (e) { /* fall through */ }

  const changed = insertTextNodeAtSelection(selection, value);
  if (changed) {
    dispatchEditEvents(editable, replace ? "insertReplacementText" : "insertText", value);
    if (hasFullInsertedText(editable.textContent)) {
      return { ok: editable.textContent !== before, method: "main-dom-range" };
    }
    if (replace && replaceEditablePlainText(editable)) {
      return { ok: true, method: "main-plain-offset-after-range" };
    }
  }
  return { ok: false, error: "页面主世界写入失败。" };
}

async function polish(text, providerOverride, skillId, tier) {
  const settings = await chrome.storage.local.get(null);
  // 按任务临时选档：tier === "strong" 时本次请求用最强模型预设，不改存储的设置
  const normalized = CORE.applyModelTier(CORE.normalizeSettings(settings), tier);
  const provider = providerOverride || normalized.provider;
  const cacheKey = buildCacheKey(text, provider, skillId, tier, normalized);
  const cached = getCached(cacheKey);
  if (cached) {
    return cached;
  }
  if (inFlight.has(cacheKey)) {
    return inFlight.get(cacheKey);
  }

  const task = runPolish(text, provider, skillId, normalized)
    .then((result) => {
      if (result.cacheable !== false) {
        resultCache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
        trimCache();
      }
      return result;
    })
    .finally(() => {
      inFlight.delete(cacheKey);
    });
  inFlight.set(cacheKey, task);
  return task;
}

async function runPolish(text, provider, skillId, normalized) {
  let output = await callProvider(provider, CORE.buildProviderRequest(provider, text, normalized, skillId));
  let notice = "";

  // 改写模式硬指标：字面相似度 ≤35%。超了先自动强化改写一次，仍超就在结果里提示实测值。
  if (skillId === CORE.REWRITE_SKILL.id) {
    let similarity = CORE.surfaceSimilarity(text, output);
    if (similarity > CORE.REWRITE_MAX_SIMILARITY) {
      // 「内容一定要生产出来」：强化重试失败（网络/接口错误）不许连累第一稿，兜底交付第一稿
      try {
        const improved = await callProvider(provider, CORE.buildRewriteRetryRequest(provider, output, text, normalized));
        output = improved;
        similarity = CORE.surfaceSimilarity(text, output);
      } catch (e) {
        // 保留第一稿和它的相似度，照常交付
      }
    }
    if (similarity > CORE.REWRITE_MAX_SIMILARITY) {
      notice = `提示：字面相似度 ${Math.round(similarity * 100)}%，仍高于 35%，可点「↻」再改一轮。`;
    } else {
      notice = `已完成，字面相似度 ${Math.round(similarity * 100)}%。`;
    }
  }

  // 2026-06-06 用户两条最终原则：
  // ① 超限就超限，不用管——不自动压缩、不报错、不提示（提示词里仍引导长度，但不强制），省一次往返更快；
  // ② 内容一定要生产出来——段落规则等校验一律不拦截结果，提示词引导即可，绝不因校验丢弃模型产出。
  // 相似度没达标的改写结果不进缓存，保证点「↻」是真重跑。
  const cacheable = !notice.includes("仍高于 35%");
  return { text: output, notice, cacheable };
}

function buildCacheKey(text, provider, skillId, tier, settings) {
  const model = settings.models && settings.models[provider];
  return JSON.stringify({
    text: String(text || "").trim(),
    provider,
    skillId: skillId || "",
    tier: tier || "",
    model: model || ""
  });
}

function getCached(cacheKey) {
  const item = resultCache.get(cacheKey);
  if (!item) {
    return null;
  }
  if (item.expiresAt <= Date.now()) {
    resultCache.delete(cacheKey);
    return null;
  }
  return item.result;
}

function trimCache() {
  const now = Date.now();
  for (const [key, item] of resultCache.entries()) {
    if (item.expiresAt <= now || resultCache.size > 30) {
      resultCache.delete(key);
    }
  }
}

async function callProvider(provider, request) {
  const response = await fetch(request.url, request.options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload && payload.error && (payload.error.message || payload.error.type);
    throw new Error(message || `API 请求失败：HTTP ${response.status}`);
  }
  const output = CORE.extractText(provider, payload);
  if (!output) {
    throw new Error(EMPTY_OUTPUT_MESSAGE);
  }
  return output;
}
