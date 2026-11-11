const CORE = require('../extension/polish-core');

// 真机缺陷回归测试：原文约 89 字时（hardMax=125），旧逻辑会在 prompt 里写「建议 120-125 字」，
// 只给模型 5 字余量，几乎必超限。修复后：原文 <120 字不再建议 120 起步。
describe('length policy regression (用户截图缺陷)', () => {
  const text89 = '字'.repeat(89);

  test('short input (<120 chars) must NOT suggest a 120-char floor', () => {
    const policy = CORE.getLengthPolicy(text89);
    expect(policy.originalChars).toBe(89);
    expect(policy.hardMax).toBe(125);
    expect(policy.minTarget).toBeNull(); // 旧逻辑这里是 120，是缺陷根源
    expect(policy.shortExpansionMin).toBeNull();
  });

  test('prompt for short input says 最多 N 字, not 建议 120-N 字', () => {
    const prompt = CORE.buildPrompt(text89);
    expect(prompt).toContain('最多 125 字');
    expect(prompt).not.toContain('建议 120');
  });

  test('very short input (<=50 chars) should be expanded to at least 50 chars without changing meaning', () => {
    const policy = CORE.getLengthPolicy('平台算法让商家很难受');
    expect(policy.originalChars).toBe(10);
    expect(policy.shortExpansionMin).toBe(50);
    expect(policy.minTarget).toBe(50);
    expect(policy.maxTarget).toBe(50);

    const prompt = CORE.buildPrompt('平台算法让商家很难受');
    expect(prompt).toContain('50字以内短文本');
    expect(prompt).toContain('扩到 50 字以上');
    expect(prompt).toContain('不改变原意');
    expect(prompt).toContain('不新增事实');
  });

  test('very short expansion applies to polish, not deep rewrite', () => {
    const rewritePrompt = CORE.buildPrompt('平台算法让商家很难受', CORE.REWRITE_SKILL);
    expect(rewritePrompt).not.toContain('50字以内短文本');
    expect(rewritePrompt).not.toContain('扩到 50 字以上');
    expect(rewritePrompt).toContain('最多 14 字');
  });

  test('long input (>=120 chars) keeps the 120-1000 suggestion', () => {
    const policy = CORE.getLengthPolicy('字'.repeat(300));
    expect(policy.minTarget).toBe(120);
    expect(policy.maxTarget).toBe(420);
  });

  test('core no longer exposes automatic compress retry builders', () => {
    expect(CORE.buildCompressRequest).toBeUndefined();
    expect(CORE.buildCompressPrompt).toBeUndefined();
  });
});
