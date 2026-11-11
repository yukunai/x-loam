(function initOptions() {
  const CORE = window.SpokenPolisherCore;

  // ===== 分页切换（支持 options.html#skills 直达技能页）=====

  const tabs = Array.prototype.slice.call(document.querySelectorAll(".tab"));
  const panels = {
    api: document.getElementById("tab-api"),
    skills: document.getElementById("tab-skills")
  };

  function activateTab(name) {
    const target = panels[name] ? name : "api";
    tabs.forEach((tab) => {
      tab.classList.toggle("is-active", tab.dataset.tab === target);
    });
    Object.keys(panels).forEach((key) => {
      panels[key].hidden = key !== target;
    });
  }

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      activateTab(tab.dataset.tab);
      window.location.hash = tab.dataset.tab;
    });
  });

  activateTab(window.location.hash.replace("#", ""));

  // ===== API 设置页 =====

  const apiFields = {
    anthropicKey: document.getElementById("anthropicKey"),
    anthropicModel: document.getElementById("anthropicModel"),
    openaiKey: document.getElementById("openaiKey"),
    openaiModel: document.getElementById("openaiModel"),
    deepseekKey: document.getElementById("deepseekKey"),
    deepseekModel: document.getElementById("deepseekModel"),
    useFastModels: document.getElementById("useFastModels"),
    useStrongModels: document.getElementById("useStrongModels"),
    save: document.getElementById("saveApi"),
    status: document.getElementById("apiStatus")
  };

  function getProviderRadio() {
    return document.querySelector('input[name="provider"]:checked');
  }

  function setProviderRadio(value) {
    const radio = document.querySelector(`input[name="provider"][value="${value}"]`);
    if (radio) {
      radio.checked = true;
    }
  }

  let customSkills = [];

  chrome.storage.local.get(null, (settings) => {
    const normalized = CORE.normalizeSettings(settings);
    apiFields.anthropicKey.value = settings.anthropicKey || "";
    apiFields.openaiKey.value = settings.openaiKey || "";
    apiFields.deepseekKey.value = settings.deepseekKey || "";
    apiFields.anthropicModel.value = normalized.models.anthropic;
    apiFields.openaiModel.value = normalized.models.openai;
    apiFields.deepseekModel.value = normalized.models.deepseek;
    setProviderRadio(normalized.provider);
    customSkills = CORE.normalizeCustomSkills(settings.customSkills);
    renderSkills();
  });

  apiFields.useFastModels.addEventListener("click", () => {
    apiFields.anthropicModel.value = CORE.FAST_MODEL_PRESETS.anthropic;
    apiFields.openaiModel.value = CORE.FAST_MODEL_PRESETS.openai;
    apiFields.deepseekModel.value = CORE.FAST_MODEL_PRESETS.deepseek;
    flash(apiFields.status, "已填入快速模型，点「保存 API 设置」后生效。");
  });

  apiFields.useStrongModels.addEventListener("click", () => {
    apiFields.anthropicModel.value = CORE.STRONG_MODEL_PRESETS.anthropic;
    apiFields.openaiModel.value = CORE.STRONG_MODEL_PRESETS.openai;
    apiFields.deepseekModel.value = CORE.STRONG_MODEL_PRESETS.deepseek;
    flash(apiFields.status, "已填入最强模型，点「保存 API 设置」后生效。");
  });

  apiFields.save.addEventListener("click", () => {
    const radio = getProviderRadio();
    const settings = {
      provider: radio ? radio.value : CORE.DEFAULTS.provider,
      anthropicKey: apiFields.anthropicKey.value.trim(),
      openaiKey: apiFields.openaiKey.value.trim(),
      deepseekKey: apiFields.deepseekKey.value.trim(),
      models: {
        anthropic: apiFields.anthropicModel.value.trim() || CORE.DEFAULTS.models.anthropic,
        openai: apiFields.openaiModel.value.trim() || CORE.DEFAULTS.models.openai,
        deepseek: apiFields.deepseekModel.value.trim() || CORE.DEFAULTS.models.deepseek
      }
    };
    chrome.storage.local.set(settings, () => {
      flash(apiFields.status, "已保存。去网页选中一段文字试试。");
    });
  });

  // ===== 技能管理页 =====

  const skillFields = {
    cards: document.getElementById("skillCards"),
    name: document.getElementById("skillName"),
    instructions: document.getElementById("skillInstructions"),
    add: document.getElementById("addSkill"),
    status: document.getElementById("skillStatus")
  };

  function renderSkills() {
    skillFields.cards.textContent = "";
    // 内置技能有两个：口语化润色 + 改写原文，都要展示，否则页面与弹窗里的技能列表对不上
    skillFields.cards.appendChild(buildSkillCard(CORE.DEFAULT_SKILL));
    skillFields.cards.appendChild(buildSkillCard(CORE.REWRITE_SKILL));
    customSkills.forEach((skill) => {
      skillFields.cards.appendChild(buildSkillCard(skill));
    });
  }

  function buildSkillCard(skill) {
    const card = document.createElement("article");
    card.className = "card";

    const head = document.createElement("div");
    head.className = "card-head";
    const title = document.createElement("h2");
    title.textContent = skill.name;
    const badge = document.createElement("span");
    badge.className = skill.builtIn ? "badge builtin" : "badge";
    badge.textContent = skill.builtIn ? "内置 · 不可删" : "自定义";
    head.appendChild(title);
    head.appendChild(badge);
    card.appendChild(head);

    const instructions = document.createElement("pre");
    instructions.className = "skill-instructions";
    instructions.textContent = skill.instructions;
    card.appendChild(instructions);

    if (!skill.builtIn) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "skill-remove";
      remove.textContent = "删除技能";
      remove.addEventListener("click", () => {
        customSkills = customSkills.filter((item) => item.id !== skill.id);
        persistSkills("技能已删除。");
      });
      card.appendChild(remove);
    }

    return card;
  }

  function persistSkills(message) {
    chrome.storage.local.set({ customSkills }, () => {
      renderSkills();
      flash(skillFields.status, message);
    });
  }

  skillFields.add.addEventListener("click", () => {
    const name = skillFields.name.value.trim();
    const instructions = skillFields.instructions.value.trim();
    if (!name || !instructions) {
      flash(skillFields.status, "技能名称和技能指令都要填。");
      return;
    }
    if (name === CORE.DEFAULT_SKILL.name || name === CORE.REWRITE_SKILL.name || customSkills.some((skill) => skill.name === name)) {
      flash(skillFields.status, "已有同名技能，换个名称。");
      return;
    }
    customSkills.push({
      id: `skill-${Date.now().toString(36)}`,
      name,
      instructions
    });
    skillFields.name.value = "";
    skillFields.instructions.value = "";
    persistSkills("技能已添加，网页选中文字后可在面板里选用。");
  });

  // ===== 公共 =====

  let statusTimer = null;

  function flash(el, message) {
    el.textContent = message;
    window.clearTimeout(statusTimer);
    statusTimer = window.setTimeout(() => {
      el.textContent = "";
    }, 2600);
  }
})();
