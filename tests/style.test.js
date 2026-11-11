const CORE = require('../extension/polish-core');

describe('Style Guide Compliance', () => {
  test('STYLE_INSTRUCTIONS should contain core oral principles', () => {
    const instr = CORE.STYLE_INSTRUCTIONS;
    expect(instr).toContain('口语化润色助手');
    expect(instr).toContain('自然、直接、有观察感');
    expect(instr).toContain('少用官话和营销腔');
    expect(instr).toContain('我感觉');
    expect(instr).toContain('目前看');
    expect(instr).toContain('个人建议');
    expect(instr).toContain('说白了');
  });

  test('STYLE_INSTRUCTIONS should enforce paragraph independence', () => {
    const instr = CORE.STYLE_INSTRUCTIONS;
    expect(instr).toContain('段落独立原则');
    expect(instr).toContain('避免使用“上述”“前文”“这里”“这样做”');
    expect(instr).toContain('每段都把主语说清楚');
  });

  test('REWRITE_SKILL should contain target metrics', () => {
    const instr = CORE.REWRITE_SKILL.instructions;
    expect(instr).toContain('至少 90% 一致');
    expect(instr).toContain('不超过 35%');
    expect(instr).toContain('意思不变、字面大改');
  });

  test('Prompt building includes the user stylistic examples implicitly via style guidelines', () => {
    const prompt = CORE.buildPrompt('这是一段书面文字。', CORE.DEFAULT_SKILL);
    expect(prompt).toContain('口语化中文帖子');
    expect(prompt).toContain('140%');
    expect(prompt).toContain('段落要求');
  });
});
