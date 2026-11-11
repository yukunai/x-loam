const CORE = require('../extension/polish-core');

// 改写原文模式（用户需求）：意思保持 ≥90% 一致，字面相似度 ≤35%，文风与润色一致。
describe('deep-rewrite skill', () => {
  const settings = { anthropicKey: 'sk-t' };

  test('REWRITE_SKILL is a built-in skill listed after the default one', () => {
    const skills = CORE.listSkills({});
    expect(skills[0].id).toBe(CORE.DEFAULT_SKILL.id);
    expect(skills[1].id).toBe('deep-rewrite');
    expect(skills[1].builtIn).toBe(true);
    expect(CORE.resolveSkill({}, 'deep-rewrite').name).toBe('改写原文');
  });

  test('custom skill cannot collide with the rewrite skill id', () => {
    const skills = CORE.listSkills({
      customSkills: [{ id: 'deep-rewrite', name: '冒名', instructions: 'x' }]
    });
    expect(skills.filter((s) => s.id === 'deep-rewrite')).toHaveLength(1);
    expect(skills.find((s) => s.id === 'deep-rewrite').name).toBe('改写原文');
  });

  test('rewrite request carries the 35%/90% targets and the spoken style', () => {
    const request = CORE.buildProviderRequest('anthropic', '字'.repeat(130), settings, 'deep-rewrite');
    const body = JSON.parse(request.options.body);
    expect(body.system).toContain('90% 一致');
    expect(body.system).toContain('不超过 35%');
    expect(body.system).toContain('文风要求与「润色」一致');
    expect(body.messages[0].content).toContain('字面相似度不能超过 35%');
  });

  test('surfaceSimilarity: identical text → 1, disjoint text → 0', () => {
    expect(CORE.surfaceSimilarity('平台算法让商家很难受', '平台算法让商家很难受')).toBe(1);
    expect(CORE.surfaceSimilarity('平台算法让商家很难受', '今天天气真不错呀')).toBe(0);
  });

  test('surfaceSimilarity: partial overlap lands strictly between 0 and 1', () => {
    const sim = CORE.surfaceSimilarity('平台算法让商家很难受', '商家被平台算法压得喘不过气');
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });

  test('REWRITE_MAX_SIMILARITY is 35%', () => {
    expect(CORE.REWRITE_MAX_SIMILARITY).toBe(0.35);
  });

  test('rewrite retry request contains both original and draft', () => {
    const original = '原'.repeat(130);
    const draft = '稿'.repeat(130);
    const request = CORE.buildRewriteRetryRequest('anthropic', draft, original, settings);
    const body = JSON.parse(request.options.body);
    expect(body.messages[0].content).toContain('【原文】');
    expect(body.messages[0].content).toContain('【改写稿】');
    expect(body.messages[0].content).toContain(original);
    expect(body.messages[0].content).toContain(draft);
    expect(body.system).toBe(CORE.REWRITE_SKILL.instructions);
  });
});
