const CORE = require('../extension/polish-core');

describe('SpokenPolisherCore', () => {
  const settings = {
    anthropicKey: 'sk-ant-123',
    deepseekKey: 'sk-ds-123',
    openaiKey: 'sk-oa-123',
    provider: 'anthropic'
  };

  test('buildProviderRequest for Claude (Anthropic)', () => {
    const request = CORE.buildProviderRequest('anthropic', 'Hello', settings);
    expect(request.url).toBe(CORE.PROVIDERS.anthropic.endpoint);
    expect(request.options.headers['x-api-key']).toBe('sk-ant-123');
    const body = JSON.parse(request.options.body);
    expect(body.system).toContain('口语化润色助手');
    expect(body.messages[0].content).toContain('Hello');
  });

  test('buildProviderRequest for DeepSeek', () => {
    const request = CORE.buildProviderRequest('deepseek', 'Hello', settings);
    expect(request.url).toBe(CORE.PROVIDERS.deepseek.endpoint);
    expect(request.options.headers['authorization']).toBe('Bearer sk-ds-123');
    const body = JSON.parse(request.options.body);
    expect(body.messages[0].content).toContain('口语化润色助手');
  });

  test('buildProviderRequest for ChatGPT (OpenAI)', () => {
    const request = CORE.buildProviderRequest('openai', 'Hello', settings);
    expect(request.url).toBe(CORE.PROVIDERS.openai.endpoint);
    expect(request.options.headers['authorization']).toBe('Bearer sk-oa-123');
  });

  test('extractText should handle Anthropic response', () => {
    const payload = {
      content: [{ type: 'text', text: 'Polished text' }]
    };
    const result = CORE.extractText('anthropic', payload);
    expect(result).toBe('Polished text');
  });

  test('extractText should handle DeepSeek response', () => {
    const payload = {
      choices: [{ message: { content: 'DeepSeek result' } }]
    };
    const result = CORE.extractText('deepseek', payload);
    expect(result).toBe('DeepSeek result');
  });

  test('extractText should explain DeepSeek content filtering', () => {
    const payload = {
      choices: [{ message: { content: '' }, finish_reason: 'content_filter' }]
    };
    expect(() => CORE.extractText('deepseek', payload)).toThrow('内容过滤');
  });

  test('extractText should explain OpenAI refusals and incomplete output', () => {
    expect(() => CORE.extractText('openai', {
      output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'cannot help' }] }]
    })).toThrow('拒绝返回正文');

    expect(() => CORE.extractText('openai', {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' }
    })).toThrow('输出额度用完');
  });

  test('extractText should explain reasoning-only OpenAI output', () => {
    expect(() => CORE.extractText('openai', {
      output: [{ type: 'reasoning', content: [] }]
    })).toThrow('只返回了推理过程');
  });

  test('normalizeSettings should merge defaults', () => {
    const s = CORE.normalizeSettings({ provider: 'deepseek' });
    expect(s.provider).toBe('deepseek');
    expect(s.temperature).toBe(0.72); // Default
  });

  // 2026-06-06 用户确认：本插件是润色/改写/翻译工具，默认优先响应速度，不用最强模型。
  test('default models should use fast model ids', () => {
    expect(CORE.DEFAULTS.models.anthropic).toBe('claude-haiku-4-5-20251001');
    expect(CORE.DEFAULTS.models.deepseek).toBe('deepseek-v4-flash');
    expect(CORE.DEFAULTS.models.openai).toBe('gpt-5.4-mini');
  });

  test('strong model presets should remain available without being defaults', () => {
    expect(CORE.STRONG_MODEL_PRESETS.anthropic).toBe('claude-opus-4-8');
    expect(CORE.STRONG_MODEL_PRESETS.deepseek).toBe('deepseek-v4-pro');
    expect(CORE.STRONG_MODEL_PRESETS.openai).toBe('gpt-5.5');
    expect(CORE.STRONG_MODEL_PRESETS.openai).not.toBe(CORE.DEFAULTS.models.openai);
  });

  test('normalizeSettings should upgrade stored legacy/deprecated model names', () => {
    const s = CORE.normalizeSettings({
      models: {
        anthropic: 'claude-sonnet-4-5-20250929',
        deepseek: 'deepseek-chat',
        openai: 'gpt-5.2-pro'
      }
    });
    expect(s.models.anthropic).toBe(CORE.DEFAULTS.models.anthropic);
    expect(s.models.deepseek).toBe(CORE.DEFAULTS.models.deepseek);
    expect(s.models.openai).toBe(CORE.DEFAULTS.models.openai);
  });

  test('normalizeSettings should respect user-chosen active models (no remap)', () => {
    const s = CORE.normalizeSettings({
      models: { anthropic: 'claude-sonnet-4-6', deepseek: 'deepseek-v4-pro' }
    });
    expect(s.models.anthropic).toBe('claude-sonnet-4-6');
    expect(s.models.deepseek).toBe('deepseek-v4-pro'); // 用户手动选更强模型时尊重
  });

  test('buildPrompt should throw on empty text', () => {
    expect(() => CORE.buildPrompt('')).toThrow('没有可润色的文字');
  });

  test('buildPrompt should include length limits', () => {
    const prompt = CORE.buildPrompt('平台算法让商家很难受');
    expect(prompt).toContain('140%');
    expect(prompt).toContain('长度要求');
  });

  test('buildPrompt should include paragraph independence limits', () => {
    const prompt = CORE.buildPrompt('平台算法让商家很难受');
    expect(prompt).toContain('段落要求');
    expect(prompt).toContain('每段控制在120字内');
    expect(prompt).toContain('这样做');
  });

  test('getLengthPolicy should expand very short input to 50 chars', () => {
    const policy = CORE.getLengthPolicy('一二三四五');
    expect(policy.originalChars).toBe(5);
    expect(policy.hardMax).toBe(7);
    expect(policy.shortExpansionMin).toBe(50);
    expect(policy.maxTarget).toBe(50);
    expect(policy.minTarget).toBe(50);
  });

  // 底线 512：此前 128 是真机缺陷根源——GPT-5 推理把额度吃光导致「模型没有返回可用文本」，
  // Claude/DeepSeek 中文输出被静默截断。默认上限 3072：1200 会截断长文（1400 字 ≈ 2000+ token）。
  test('getOutputTokenBudget should floor at 512 and cap by maxTokens', () => {
    expect(CORE.getOutputTokenBudget('短文本', {})).toBe(512);
    expect(CORE.getOutputTokenBudget('字'.repeat(1000), { maxTokens: 1200 })).toBe(1200);
    expect(CORE.getOutputTokenBudget('字'.repeat(1000), {})).toBe(3072);
  });

  test('provider requests should include dynamic output token limits', () => {
    const source = '平台算法让商家很难受';
    const anthropic = JSON.parse(CORE.buildProviderRequest('anthropic', source, settings).options.body);
    const deepseek = JSON.parse(CORE.buildProviderRequest('deepseek', source, settings).options.body);
    const openai = JSON.parse(CORE.buildProviderRequest('openai', source, settings).options.body);

    expect(anthropic.max_tokens).toBe(512);
    expect(deepseek.max_tokens).toBe(512);
    // GPT-5 系推理模型：思考 token 计入 max_output_tokens，额外 +1024 思考余量防止正文为空
    expect(openai.max_output_tokens).toBe(512 + 1024);
  });

  test('validateOutputStructure should reject dependent references and long paragraphs', () => {
    expect(CORE.validateOutputStructure('商家利润下降会影响产品投入。').ok).toBe(true);
    expect(CORE.validateOutputStructure('上述问题会影响商家利润。').ok).toBe(false);
    expect(CORE.validateOutputStructure('字'.repeat(121)).ok).toBe(false);
  });
});
