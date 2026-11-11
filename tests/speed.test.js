const CORE = require('../extension/polish-core');

// 速度优化（用户指令「要求快速的模型」+「最好可以按任务选择」）：
// 默认 = 各家快速档；STRONG_MODEL_PRESETS = 最强档，弹窗里按任务临时选（tier=strong）。
describe('fast defaults and per-task tier', () => {
  const settings = { anthropicKey: 'sk-a', deepseekKey: 'sk-d', openaiKey: 'sk-o' };
  const source = '平台算法让商家很难受，大家都在想办法突围。';

  test('strong presets use verified flagship model ids', () => {
    expect(CORE.STRONG_MODEL_PRESETS.anthropic).toBe('claude-opus-4-8');
    expect(CORE.STRONG_MODEL_PRESETS.deepseek).toBe('deepseek-v4-pro');
    expect(CORE.STRONG_MODEL_PRESETS.openai).toBe('gpt-5.5');
  });

  test('applyModelTier("strong") swaps models for this request only', () => {
    const base = CORE.normalizeSettings(settings);
    const strong = CORE.applyModelTier(base, 'strong');
    expect(strong.models.anthropic).toBe('claude-opus-4-8');
    expect(strong.models.deepseek).toBe('deepseek-v4-pro');
    expect(strong.models.openai).toBe('gpt-5.5');
    // 原 settings 不被改写
    expect(base.models.anthropic).not.toBe('claude-opus-4-8');
  });

  test('applyModelTier with no tier returns settings unchanged', () => {
    const base = CORE.normalizeSettings(settings);
    expect(CORE.applyModelTier(base, undefined)).toBe(base);
  });

  test('sonnet-4-6 requests carry effort low; haiku and opus do not', () => {
    const sonnet = JSON.parse(CORE.buildProviderRequest('anthropic', source,
      Object.assign({}, settings, { models: { anthropic: 'claude-sonnet-4-6' } })).options.body);
    expect(sonnet.output_config).toEqual({ effort: 'low' });

    const haiku = JSON.parse(CORE.buildProviderRequest('anthropic', source,
      Object.assign({}, settings, { models: { anthropic: 'claude-haiku-4-5-20251001' } })).options.body);
    expect(haiku.output_config).toBeUndefined(); // Haiku 不支持 effort，带了会 400

    const opus = JSON.parse(CORE.buildProviderRequest('anthropic', source,
      Object.assign({}, settings, { models: { anthropic: 'claude-opus-4-8' } })).options.body);
    expect(opus.output_config).toBeUndefined(); // 最强档保完整质量
  });

  test('gpt mini models carry reasoning low; flagship gpt-5.5 does not', () => {
    const mini = JSON.parse(CORE.buildProviderRequest('openai', source,
      Object.assign({}, settings, { models: { openai: 'gpt-5.4-mini' } })).options.body);
    expect(mini.reasoning).toEqual({ effort: 'low' });

    const flagship = JSON.parse(CORE.buildProviderRequest('openai', source,
      Object.assign({}, settings, { models: { openai: 'gpt-5.5' } })).options.body);
    expect(flagship.reasoning).toBeUndefined();
  });
});
