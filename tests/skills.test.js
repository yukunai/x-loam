const CORE = require('../extension/polish-core');

describe('custom skills', () => {
  const settings = {
    anthropicKey: 'sk-ant-123',
    deepseekKey: 'sk-ds-123',
    openaiKey: 'sk-oa-123',
    customSkills: [
      { id: 'formal-email', name: '转正式邮件', instructions: '把文字改写成礼貌、简洁的正式商务邮件，保留全部事实。' },
      { id: '', name: '缺id应被过滤', instructions: 'x' },
      { id: 'formal-email', name: '重复id应被过滤', instructions: 'y' },
      { id: 'no-instructions', name: '缺指令应被过滤', instructions: '' }
    ]
  };

  test('listSkills puts built-in skills first and filters invalid entries', () => {
    const skills = CORE.listSkills(settings);
    expect(skills).toHaveLength(3); // 内置：口语化润色 + 改写原文；自定义：formal-email
    expect(skills[0].id).toBe(CORE.DEFAULT_SKILL.id);
    expect(skills[0].builtIn).toBe(true);
    expect(skills[1].id).toBe(CORE.REWRITE_SKILL.id);
    expect(skills[1].builtIn).toBe(true);
    expect(skills[2].id).toBe('formal-email');
    expect(skills[2].builtIn).toBe(false);
  });

  test('resolveSkill returns custom skill by id and falls back to default', () => {
    expect(CORE.resolveSkill(settings, 'formal-email').name).toBe('转正式邮件');
    expect(CORE.resolveSkill(settings, 'unknown-id').id).toBe(CORE.DEFAULT_SKILL.id);
    expect(CORE.resolveSkill(settings, undefined).id).toBe(CORE.DEFAULT_SKILL.id);
    expect(CORE.resolveSkill({}, 'formal-email').id).toBe(CORE.DEFAULT_SKILL.id);
  });

  test('buildProviderRequest uses custom skill instructions as system prompt (anthropic)', () => {
    const request = CORE.buildProviderRequest('anthropic', '请大家明天上午十点参加部门会议。', settings, 'formal-email');
    const body = JSON.parse(request.options.body);
    expect(body.system).toBe('把文字改写成礼貌、简洁的正式商务邮件，保留全部事实。');
    expect(body.messages[0].content).toContain('转正式邮件');
  });

  test('buildProviderRequest uses custom skill instructions for deepseek and openai', () => {
    const ds = JSON.parse(CORE.buildProviderRequest('deepseek', 'Hello', settings, 'formal-email').options.body);
    expect(ds.messages[0].content).toBe('把文字改写成礼貌、简洁的正式商务邮件，保留全部事实。');
    const oa = JSON.parse(CORE.buildProviderRequest('openai', 'Hello', settings, 'formal-email').options.body);
    expect(oa.instructions).toBe('把文字改写成礼貌、简洁的正式商务邮件，保留全部事实。');
  });

  test('buildProviderRequest without skillId keeps existing default behavior', () => {
    const body = JSON.parse(CORE.buildProviderRequest('anthropic', 'Hello', settings).options.body);
    expect(body.system).toBe(CORE.STYLE_INSTRUCTIONS);
    expect(body.messages[0].content).toContain('润色成口语化中文帖子');
  });

  test('length and paragraph requirements stay in prompt for custom skills', () => {
    const body = JSON.parse(CORE.buildProviderRequest('anthropic', 'Hello', settings, 'formal-email').options.body);
    expect(body.messages[0].content).toContain('140%');
    expect(body.messages[0].content).toContain('段落要求');
  });
});
