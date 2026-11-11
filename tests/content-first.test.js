const CORE = require('../extension/polish-core');

// 「内容必须交付」回归：截断/不完整的响应里若已有部分正文，必须交付正文，
// 不能因为 status === "incomplete" 就把已生成的内容丢掉只报错。
// （extractText 曾经先查 status 再取正文，截断时整段丢弃——顺序不能再倒回去。）
describe('content-first delivery', () => {
  test('openai incomplete WITH partial output text → returns the text, no throw', () => {
    const payload = {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: '这是已经生成出来的部分正文。' }]
        }
      ]
    };
    expect(CORE.extractText('openai', payload)).toBe('这是已经生成出来的部分正文。');
  });

  test('openai incomplete WITHOUT any text → still throws with truncation reason', () => {
    const payload = {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'reasoning', content: [] }]
    };
    expect(() => CORE.extractText('openai', payload)).toThrow(/输出额度用完/);
  });

  test('anthropic partial text with max_tokens stop_reason → returns the text', () => {
    const payload = {
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: '部分正文也要交付。' }]
    };
    expect(CORE.extractText('anthropic', payload)).toBe('部分正文也要交付。');
  });
});
