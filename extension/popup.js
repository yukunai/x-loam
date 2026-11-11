(function initPopup() {
  const CORE = window.SpokenPolisherCore;

  // 弹窗只做两件事：显示配置状态、跳设置页。具体配置都在 options.html（API 设置 / 技能管理两个分页）。

  function openOptions(tab) {
    chrome.tabs.create({ url: chrome.runtime.getURL(`options.html#${tab}`) });
    window.close();
  }

  document.getElementById("openApi").addEventListener("click", () => openOptions("api"));
  document.getElementById("openSkills").addEventListener("click", () => openOptions("skills"));

  chrome.storage.local.get(null, (settings) => {
    const normalized = CORE.normalizeSettings(settings);
    const skillCount = CORE.listSkills(settings).length;
    const list = document.getElementById("providerStatus");

    [
      { key: "anthropicKey", label: "Claude", provider: "anthropic" },
      { key: "openaiKey", label: "ChatGPT", provider: "openai" },
      { key: "deepseekKey", label: "DeepSeek", provider: "deepseek" }
    ].forEach((item) => {
      const li = document.createElement("li");
      const configured = Boolean((settings[item.key] || "").trim());
      const isDefault = normalized.provider === item.provider;
      li.className = configured ? "ok" : "missing";
      li.textContent = `${item.label}：${configured ? "已配置" : "未配置"}${isDefault ? "（默认）" : ""}`;
      list.appendChild(li);
    });

    const skillLi = document.createElement("li");
    skillLi.className = "ok";
    skillLi.textContent = `技能：${skillCount} 个可用`;
    list.appendChild(skillLi);
  });
})();
