(function init(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SpokenPolisherCore = factory();
  }
})(typeof self !== "undefined" ? self : this, function factory() {
  const DEFAULTS = {
    provider: "openai",
    models: {
      // 2026-06-06 用户确认：本插件是润色/改写/翻译工具，默认优先响应速度，不用最强模型。
      // 最强模型仍保留在 STRONG_MODEL_PRESETS，设置页可手动填入。
      anthropic: "claude-haiku-4-5-20251001",
      deepseek: "deepseek-v4-flash",
      openai: "gpt-5.4-mini"
    },
    temperature: 0.72,
    maxTokens: 3072 // 输出预算上限。1000 字输入的 140% ≈ 1400 字 ≈ 2000+ token，1200 会截断长文
  };

  const PROVIDERS = {
    anthropic: {
      label: "Claude",
      endpoint: "https://api.anthropic.com/v1/messages",
      keyField: "anthropicKey"
    },
    deepseek: {
      label: "DeepSeek",
      endpoint: "https://api.deepseek.com/chat/completions",
      keyField: "deepseekKey"
    },
    openai: {
      label: "ChatGPT",
      endpoint: "https://api.openai.com/v1/responses",
      keyField: "openaiKey"
    }
  };

  const FAST_MODEL_PRESETS = {
    anthropic: "claude-haiku-4-5-20251001",
    deepseek: "deepseek-v4-flash",
    openai: "gpt-5.4-mini"
  };

  const STRONG_MODEL_PRESETS = {
    anthropic: "claude-opus-4-8",
    deepseek: "deepseek-v4-pro",
    openai: "gpt-5.5"
  };

  // 按任务临时选档（用户需求）：弹窗里每次润色/改写可现场选「快速(默认)/最强」，
  // 不动存储的设置。tier === "strong" 时本次请求用最强预设。
  function applyModelTier(settings, tier) {
    if (tier !== "strong") {
      return settings;
    }
    const merged = Object.assign({}, settings);
    merged.models = Object.assign({}, settings && settings.models, STRONG_MODEL_PRESETS);
    return merged;
  }

  // 把浏览器里存的「历史默认值/已废弃 id」迁移到现役模型。方向永远是 旧 → 新；
  // 现役模型（如 claude-sonnet-4-6）不做映射，用户主动选了就尊重。
  const MODEL_ALIASES = {
    anthropic: {
      "claude-sonnet-4-5-20250929": DEFAULTS.models.anthropic, // Legacy
      "claude-sonnet-4-20250514": DEFAULTS.models.anthropic    // 2026-06-15 退役
    },
    deepseek: {
      "deepseek-chat": DEFAULTS.models.deepseek,     // 2026-07-24 废弃
      "deepseek-reasoner": DEFAULTS.models.deepseek
      // deepseek-v4-flash 是现役模型，不映射——用户主动选便宜款就尊重
    },
    openai: {
      "gpt-4.1-mini": DEFAULTS.models.openai,
      "gpt-5.1": DEFAULTS.models.openai,
      "gpt-5.2": DEFAULTS.models.openai,     // GPT-5.2 全系已宣布退役
      "gpt-5.2-pro": DEFAULTS.models.openai
      // gpt-5.5 是最强预设，不映射；用户手动选择最强模型时要尊重。
    }
  };

  const STYLE_INSTRUCTIONS = [
    "你是中文社交媒体口语化润色助手。",
    "把用户给的文字改成自然、直接、有观察感的中文口语帖。",
    "保留事实，不要编造价格、配料、经历、效果、地点、政策或测试结论。",
    "字数尽量控制在120到1000字；尽量不超过原文有效字数的140%。如果原文在50字以内，要在不改变原意、不新增事实的前提下丰富表达，扩到50字以上。内容完整优先，不要为了控字数丢掉关键信息。",
    "段落独立原则：尽量让任何一个段落脱离全文也能被准确理解。避免使用“上述”“前文”“这里”“这样做”这类依赖上下文的表达，每段都把主语说清楚。",
    "尽量每个段落只讲一个信息点，单段控制在120字内。",
    "少用官话和营销腔。多用短段落、具体细节、轻微个人判断。",
    "可以用“我感觉”“目前看”“个人建议”“说白了”等口语连接。",
    "只输出润色后的正文，不要解释你做了什么。"
  ].join("\n");

  const FORBIDDEN_CONTEXT_PHRASES = ["上述", "前文", "这里", "这样做"];

  // 内置技能：口语化润色。用户可在 popup 里添加自定义技能（存 storage.local 的 customSkills）。
  const DEFAULT_SKILL = {
    id: "spoken-polisher",
    name: "口语化润色",
    instructions: STYLE_INSTRUCTIONS,
    builtIn: true
  };

  // 内置技能 2：改写原文（用户要求）——意思保持 ≥90% 一致，字面相似度 ≤35%（深度换说法）。
  const REWRITE_MAX_SIMILARITY = 0.35;
  const REWRITE_SKILL = {
    id: "deep-rewrite",
    name: "改写原文",
    builtIn: true,
    intro: "请把下面这段文字彻底改写：意思与原文保持 90% 以上一致，但字面相似度不能超过 35%。",
    instructions: [
      "你是中文改写助手。把用户给的文字彻底换一种说法重写，做到「意思不变、字面大改」。",
      "硬性目标一：核心内容与原文保持至少 90% 一致——事实、观点、数字、人名、品名、时间、因果，一个不能变、不能丢、不能加。",
      "硬性目标二：字面相似度不超过 35%——除数字和专有名词外，尽量不复用原文的词组和句式。手段：同义词替换、调整语序、长短句互换、主动被动互换、换比喻换说法。",
      "数字、专有名词、品牌、术语必须原样保留，它们不算字面重合。",
      "文风要求与「润色」一致：自然、直接、有观察感的中文口语；少官话和营销腔；多用短段落、具体细节、轻微个人判断；可以用“我感觉”“目前看”“个人建议”“说白了”等口语连接。",
      "段落独立原则：保留原文分段；尽量让每段脱离全文也能被准确理解；避免使用“上述”“前文”“这里”“这样做”；尽量每段只讲一个信息点，单段控制在120字内。",
      "输出字数尽量不超过原文有效字数的 140%，但内容完整优先。",
      "只输出改写后的正文，不要解释。"
    ].join("\n")
  };

  // 字面相似度：输出的字符二元组里，有多大比例在原文中出现过（去空白后计算）。
  // 0 = 完全不同，1 = 措辞完全来自原文。改写模式要求 ≤ REWRITE_MAX_SIMILARITY。
  function surfaceSimilarity(sourceText, outputText) {
    const bigramsOf = (text) => {
      const s = String(text || "").replace(/\s+/g, "");
      const grams = new Set();
      for (let i = 0; i < s.length - 1; i += 1) {
        grams.add(s.slice(i, i + 2));
      }
      return grams;
    };
    const source = bigramsOf(sourceText);
    const output = bigramsOf(outputText);
    if (!output.size) {
      return 0;
    }
    let hit = 0;
    output.forEach((gram) => {
      if (source.has(gram)) {
        hit += 1;
      }
    });
    return hit / output.size;
  }

  function countEffectiveChars(text) {
    return String(text || "").replace(/\s+/g, "").length;
  }

  function getLengthPolicy(text) {
    const originalChars = countEffectiveChars(text);
    const hardMax = Math.max(1, Math.ceil(originalChars * 1.4));
    const shortExpansionMin = originalChars > 0 && originalChars <= 50 ? 50 : null;
    const minTarget = shortExpansionMin || (originalChars >= 120 ? 120 : null);
    return {
      originalChars,
      shortExpansionMin,
      // 只有原文本身 ≥120 字才建议「120 字起步」。此前条件是 hardMax>=120（即原文 86 字就触发），
      // 会出现「建议 120-125 字」这种只给模型 5 字余量的自杀式区间，必然频繁超限。
      // 用户后续补充：50 字以内的短文本要扩到 50 字以上，但不能改变原意。这个短文本扩写规则优先于 140% 软目标。
      minTarget,
      maxTarget: Math.min(1000, Math.max(hardMax, minTarget || 0)),
      hardMax
    };
  }

  function getOutputTokenBudget(text, settings) {
    const normalized = normalizeSettings(settings);
    const policy = getLengthPolicy(text);
    // 中文 1 字 ≈ 1+ token，给 2.5 倍余量。底线 512：此前底线 128 是真机缺陷根源——
    // 短文本只批 128 token，GPT-5 系推理模型的"思考"就把额度吃光，正文为空，
    // 报「模型没有返回可用文本」；Claude/DeepSeek 则会被静默截断。内容必须生产出来，预算宁多勿少。
    return Math.min(normalized.maxTokens, Math.max(512, Math.ceil(policy.hardMax * 2.5)));
  }

  function normalizeText(text) {
    return String(text || "").replace(/\r\n/g, "\n").trim();
  }

  function normalizeCustomSkills(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const seen = new Set([DEFAULT_SKILL.id, REWRITE_SKILL.id]);
    const skills = [];
    list.forEach((item) => {
      if (!item || typeof item !== "object") {
        return;
      }
      const id = normalizeText(item.id);
      const name = normalizeText(item.name);
      const instructions = normalizeText(item.instructions);
      if (!id || !name || !instructions || seen.has(id)) {
        return;
      }
      seen.add(id);
      skills.push({ id, name, instructions, builtIn: false });
    });
    return skills;
  }

  function listSkills(settings) {
    return [DEFAULT_SKILL, REWRITE_SKILL].concat(normalizeCustomSkills(settings && settings.customSkills));
  }

  function resolveSkill(settings, skillId) {
    if (!skillId || skillId === DEFAULT_SKILL.id) {
      return DEFAULT_SKILL;
    }
    return listSkills(settings).find((skill) => skill.id === skillId) || DEFAULT_SKILL;
  }

  function buildPrompt(text, skill) {
    const input = normalizeText(text);
    if (!input) {
      throw new Error("没有可润色的文字。请先复制或选中一段中文内容。");
    }
    const policy = getLengthPolicy(input);
    const shouldExpandShortPolish = policy.shortExpansionMin && (!skill || skill.id === DEFAULT_SKILL.id);
    const promptMinTarget = shouldExpandShortPolish ? policy.shortExpansionMin : (policy.shortExpansionMin ? null : policy.minTarget);
    const promptMaxTarget = shouldExpandShortPolish ? policy.shortExpansionMin : policy.maxTarget;
    const range = shouldExpandShortPolish
      ? `至少 ${policy.shortExpansionMin} 字`
      : (promptMinTarget
        ? `建议 ${promptMinTarget}-${promptMaxTarget} 字`
        : `最多 ${policy.hardMax} 字`);
    const lengthNote = shouldExpandShortPolish
      ? `长度要求：原文有效字数 ${policy.originalChars} 字，属于50字以内短文本；请在不改变原意、不新增事实的前提下补足语境、细节和自然转折，扩到 ${policy.shortExpansionMin} 字以上。短文本扩写优先于 140% 软目标。内容完整优先，不要为了控字数丢掉关键信息。`
      : (promptMinTarget
        ? `长度要求：尽量 ${range}；目标是不超过原文有效字数 ${policy.originalChars} 字的 140%，也就是 ${policy.hardMax} 字。内容完整优先，不要为了控字数丢掉关键信息。`
        : `长度要求：最多 ${policy.hardMax} 字；目标是不超过原文有效字数 ${policy.originalChars} 字的 140%。内容完整优先，不要为了控字数丢掉关键信息。`);
    const intro = skill && skill.intro
      ? skill.intro
      : (skill && !skill.builtIn
        ? `请按「${skill.name}」技能的要求处理下面这段文字：`
        : "请把下面这段文字润色成口语化中文帖子：");
    return [
      intro,
      lengthNote,
      "段落要求：尽量让每段脱离全文后仍能被准确理解；避免使用“上述”“前文”“这里”“这样做”；尽量每段只包含一个信息点，每段控制在120字内。",
      "",
      input
    ].join("\n");
  }

  function splitParagraphs(text) {
    return normalizeText(text)
      .split(/\n+/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);
  }

  function validateOutputStructure(text) {
    const paragraphs = splitParagraphs(text);
    const errors = [];

    paragraphs.forEach((paragraph, index) => {
      const number = index + 1;
      const count = countEffectiveChars(paragraph);
      if (count > 120) {
        errors.push(`第 ${number} 段超过 120 字（${count} 字）`);
      }
      FORBIDDEN_CONTEXT_PHRASES.forEach((phrase) => {
        if (paragraph.includes(phrase)) {
          errors.push(`第 ${number} 段包含依赖上下文表达“${phrase}”`);
        }
      });
    });

    return {
      ok: errors.length === 0,
      errors,
      paragraphs
    };
  }

  function normalizeSettings(settings) {
    const merged = Object.assign({}, DEFAULTS, settings || {});
    merged.models = Object.assign({}, DEFAULTS.models, (settings && settings.models) || {});
    Object.keys(PROVIDERS).forEach((provider) => {
      const model = merged.models[provider];
      if (MODEL_ALIASES[provider] && MODEL_ALIASES[provider][model]) {
        merged.models[provider] = MODEL_ALIASES[provider][model];
      }
    });
    if (!PROVIDERS[merged.provider]) {
      merged.provider = DEFAULTS.provider;
    }
    return merged;
  }

  function getApiKey(settings, provider) {
    const config = PROVIDERS[provider];
    return normalizeText(settings[config.keyField]);
  }

  function resolveRequestContext(provider, settings, skillId) {
    const normalized = normalizeSettings(settings);
    const config = PROVIDERS[provider];
    if (!config) {
      throw new Error("不支持的模型服务。请选择 Claude、DeepSeek 或 ChatGPT。");
    }
    const apiKey = getApiKey(normalized, provider);
    if (!apiKey) {
      throw new Error(`还没有配置 ${config.label} API Key。`);
    }
    return { normalized, config, apiKey, skill: resolveSkill(normalized, skillId) };
  }

  function buildProviderRequest(provider, text, settings, skillId, stream) {
    const ctx = resolveRequestContext(provider, settings, skillId);
    return makeRequest(provider, ctx, buildPrompt(text, ctx.skill), text, stream);
  }

  // 改写模式的强化重试：第一稿字面相似度还超 35% 时，对照原文把残留的相同措辞继续换掉
  function buildRewriteRetryPrompt(draftText, originalText) {
    const policy = getLengthPolicy(originalText);
    return [
      "下面的【改写稿】和【原文】字面相似度还是太高（要求不超过 35%）。",
      "请逐句对照，把改写稿里仍与原文相同的词组和句式全部换成不同的说法。意思必须与原文保持 90% 以上一致，数字和专有名词原样保留。",
      `字数尽量不超过 ${policy.hardMax} 字。每段尽量独立可读，避免使用“上述”“前文”“这里”“这样做”，单段尽量不超过120字。只输出改写后的正文。`,
      "",
      "【原文】",
      normalizeText(originalText),
      "",
      "【改写稿】",
      normalizeText(draftText)
    ].join("\n");
  }

  function buildRewriteRetryRequest(provider, draftText, originalText, settings, stream) {
    const ctx = resolveRequestContext(provider, settings, REWRITE_SKILL.id);
    return makeRequest(provider, ctx, buildRewriteRetryPrompt(draftText, originalText), originalText, stream);
  }

  function makeRequest(provider, ctx, prompt, sourceText, stream) {
    const { normalized, config, apiKey, skill } = ctx;
    const model = normalized.models[provider] || DEFAULTS.models[provider];
    const outputBudget = getOutputTokenBudget(sourceText || prompt, normalized);

    if (provider === "anthropic") {
      const claudeBody = {
        // 注意：Claude Opus 4.7+ 不接受 temperature/top_p/top_k，带了直接 400
        model,
        max_tokens: outputBudget,
        system: skill.instructions,
        messages: [{ role: "user", content: prompt }]
      };
      if (stream) {
        claudeBody.stream = true; // 流式：SSE 逐字返回，弹窗边收边显示
      }
      // 快速档提速：Sonnet 4.6 的 effort 默认是 high，润色短任务降到 low 明显更快、质量无感知差异。
      // 只对 sonnet-4-6 加（Haiku 不支持 effort 会 400；Opus 走「最强档」要完整质量，不降档）。
      if (/^claude-sonnet-4-6/.test(model)) {
        claudeBody.output_config = { effort: "low" };
      }
      return {
        url: config.endpoint,
        options: {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify(claudeBody)
        }
      };
    }

    if (provider === "deepseek") {
      return {
        url: config.endpoint,
        options: {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "authorization": `Bearer ${apiKey}`
          },
          body: JSON.stringify(Object.assign({
            model,
            temperature: normalized.temperature,
            max_tokens: outputBudget,
            messages: [
              { role: "system", content: skill.instructions },
              { role: "user", content: prompt }
            ]
          }, stream ? { stream: true } : {}))
        }
      };
    }

    // GPT-5 系是推理模型：思考 token 也计入 max_output_tokens。必须额外加思考余量，
    // 否则预算被思考吃光、正文为空（真机已踩坑：「模型没有返回可用文本」）。
    const isReasoningModel = /^gpt-5/.test(model) && !model.includes("chat");
    const openaiBody = {
      // 注意：GPT-5 系列在 Responses API 下不支持 temperature，带了会报错
      model,
      max_output_tokens: isReasoningModel ? outputBudget + 1024 : outputBudget,
      instructions: skill.instructions,
      input: prompt
    };
    // 快速档提速：mini/nano 系是低延迟推理模型，把 reasoning 压到 low 进一步砍思考时间。
    // 最强档 gpt-5.5 不降，保完整质量。
    if (isReasoningModel && /(mini|nano)/.test(model)) {
      openaiBody.reasoning = { effort: "low" };
    }
    if (stream) {
      openaiBody.stream = true; // 流式：Responses API 的 SSE 事件流
    }
    return {
      url: config.endpoint,
      options: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify(openaiBody)
      }
    };
  }

  // 解析一条 SSE data 载荷（已 JSON.parse），统一三家格式 → {delta?, done?, error?}
  // - anthropic: content_block_delta(text_delta) / message_stop / error
  // - openai Responses: response.output_text.delta / response.completed / response.failed
  // - deepseek(OpenAI 兼容): choices[0].delta.content / finish_reason（[DONE] 哨兵由调用方先行处理）
  function parseSseChunk(provider, data) {
    if (!data || typeof data !== "object") {
      return {};
    }
    if (provider === "anthropic") {
      if (data.type === "content_block_delta" && data.delta && data.delta.type === "text_delta") {
        return { delta: data.delta.text || "" };
      }
      if (data.type === "message_stop") {
        return { done: true };
      }
      if (data.type === "error") {
        return { error: (data.error && data.error.message) || "Claude 流式接口报错" };
      }
      return {};
    }
    if (provider === "deepseek") {
      const choice = data.choices && data.choices[0];
      const result = {};
      if (choice && choice.delta && typeof choice.delta.content === "string") {
        result.delta = choice.delta.content;
      }
      if (choice && choice.finish_reason === "content_filter") {
        result.error = "DeepSeek 内容过滤：模型没有返回正文。可以换一种更客观的说法再试。";
      }
      if (choice && choice.finish_reason) {
        result.done = true;
      }
      if (data.error) {
        result.error = data.error.message || "DeepSeek 流式接口报错";
      }
      return result;
    }
    // openai Responses API
    if (data.type === "response.output_text.delta") {
      return { delta: data.delta || "" };
    }
    if (data.type === "response.refusal.delta") {
      return { error: `ChatGPT 拒绝返回正文：${data.delta || "触发安全策略"}` };
    }
    if (data.type === "response.incomplete") {
      const reason = data.response && data.response.incomplete_details && data.response.incomplete_details.reason;
      return { error: reason === "max_output_tokens"
        ? "ChatGPT 输出额度用完，正文没有生成出来。请换快速模型或再点一次重试。"
        : `ChatGPT 返回不完整：${reason || "未知原因"}` };
    }
    if (data.type === "response.completed") {
      return { done: true };
    }
    if (data.type === "response.failed" || data.type === "error") {
      const message = (data.response && data.response.error && data.response.error.message)
        || (data.error && data.error.message);
      return { error: message || "ChatGPT 流式接口报错" };
    }
    return {};
  }

  function extractText(provider, payload) {
    if (!payload || typeof payload !== "object") {
      throw new Error("模型返回为空。");
    }
    if (payload.error) {
      throw new Error(payload.error.message || payload.error.type || "模型接口返回错误。");
    }

    if (provider === "anthropic") {
      const block = Array.isArray(payload.content)
        ? payload.content.find((item) => item && item.type === "text" && item.text)
        : null;
      const text = normalizeText(block && block.text);
      if (text) {
        return text;
      }
      if (payload.stop_reason === "max_tokens") {
        throw new Error("Claude 输出额度用完，正文没有生成出来。请换快速模型或再点一次重试。");
      }
      if (payload.stop_reason) {
        throw new Error(`Claude 没有返回正文：${payload.stop_reason}`);
      }
      return "";
    }

    if (provider === "deepseek") {
      const choice = payload.choices && payload.choices[0];
      const message = choice && choice.message;
      const text = normalizeText(message && message.content);
      if (text) {
        return text;
      }
      if (choice && choice.finish_reason === "content_filter") {
        throw new Error("DeepSeek 内容过滤：模型没有返回正文。可以换一种更客观的说法再试。");
      }
      if (message && message.reasoning_content) {
        throw new Error("DeepSeek 只返回了推理内容，没有返回正文。请换快速模型或再点一次重试。");
      }
      return "";
    }

    if (payload.output_text) {
      return normalizeText(payload.output_text);
    }
    if (payload.status === "failed") {
      const message = payload.error && (payload.error.message || payload.error.code);
      throw new Error(message || "ChatGPT 生成失败。");
    }
    // 注意：status === "incomplete"（如 max_output_tokens 截断）不能在这里就 throw——
    // 截断响应的 output 数组里通常带着已生成的部分正文，「内容必须交付」，
    // 先走下面的正文提取，确实一个字都没有时才报截断原因。

    const output = Array.isArray(payload.output) ? payload.output : [];
    const parts = [];
    const refusals = [];
    let reasoningOnly = output.length > 0;
    output.forEach((item) => {
      (item.content || []).forEach((content) => {
        if (content && content.type === "output_text" && content.text) {
          parts.push(content.text);
          reasoningOnly = false;
        }
        if (content && content.type === "refusal") {
          refusals.push(content.refusal || content.text || "触发安全策略");
        }
      });
      if (item.type && item.type !== "reasoning") {
        reasoningOnly = false;
      }
    });
    const text = normalizeText(parts.join("\n"));
    if (text) {
      return text;
    }
    if (refusals.length) {
      throw new Error(`ChatGPT 拒绝返回正文：${refusals.join("；")}`);
    }
    if (payload.status === "incomplete") {
      const reason = payload.incomplete_details && payload.incomplete_details.reason;
      throw new Error(reason === "max_output_tokens"
        ? "ChatGPT 输出额度用完，正文没有生成出来。请换快速模型或再点一次重试。"
        : `ChatGPT 返回不完整：${reason || "未知原因"}`);
    }
    if (reasoningOnly) {
      throw new Error("ChatGPT 只返回了推理过程，没有返回正文。请换快速模型或再点一次重试。");
    }
    return "";
  }

  return {
    DEFAULTS,
    PROVIDERS,
    STYLE_INSTRUCTIONS,
    FORBIDDEN_CONTEXT_PHRASES,
    MODEL_ALIASES,
    FAST_MODEL_PRESETS,
    STRONG_MODEL_PRESETS,
    applyModelTier,
    DEFAULT_SKILL,
    REWRITE_SKILL,
    REWRITE_MAX_SIMILARITY,
    surfaceSimilarity,
    buildRewriteRetryPrompt,
    buildRewriteRetryRequest,
    normalizeCustomSkills,
    listSkills,
    resolveSkill,
    countEffectiveChars,
    getLengthPolicy,
    getOutputTokenBudget,
    buildPrompt,
    splitParagraphs,
    validateOutputStructure,
    normalizeSettings,
    buildProviderRequest,
    parseSseChunk,
    extractText
  };
});
