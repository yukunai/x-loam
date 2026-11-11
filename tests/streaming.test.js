const CORE = require('../extension/polish-core');

// 流式输出（用户反馈"不够流畅"）：三家 SSE 事件格式统一解析 + 请求体带 stream 标记。
describe('streaming support', () => {
  const settings = { anthropicKey: 'sk-a', deepseekKey: 'sk-d', openaiKey: 'sk-o' };
  const source = '平台算法让商家很难受，大家都在想办法。';

  test('stream flag adds stream:true to all three provider bodies', () => {
    const claude = JSON.parse(CORE.buildProviderRequest('anthropic', source, settings, undefined, true).options.body);
    const deepseek = JSON.parse(CORE.buildProviderRequest('deepseek', source, settings, undefined, true).options.body);
    const openai = JSON.parse(CORE.buildProviderRequest('openai', source, settings, undefined, true).options.body);
    expect(claude.stream).toBe(true);
    expect(deepseek.stream).toBe(true);
    expect(openai.stream).toBe(true);
  });

  test('without stream flag, bodies stay non-streaming (backward compatible)', () => {
    const claude = JSON.parse(CORE.buildProviderRequest('anthropic', source, settings).options.body);
    expect(claude.stream).toBeUndefined();
  });

  test('parseSseChunk: anthropic delta / stop / error', () => {
    expect(CORE.parseSseChunk('anthropic', { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } }))
      .toEqual({ delta: '你好' });
    expect(CORE.parseSseChunk('anthropic', { type: 'message_stop' })).toEqual({ done: true });
    expect(CORE.parseSseChunk('anthropic', { type: 'error', error: { message: 'boom' } }).error).toBe('boom');
    expect(CORE.parseSseChunk('anthropic', { type: 'message_start' })).toEqual({});
  });

  test('parseSseChunk: openai responses delta / completed / failed', () => {
    expect(CORE.parseSseChunk('openai', { type: 'response.output_text.delta', delta: '世界' }))
      .toEqual({ delta: '世界' });
    expect(CORE.parseSseChunk('openai', { type: 'response.completed' })).toEqual({ done: true });
    expect(CORE.parseSseChunk('openai', { type: 'response.failed', response: { error: { message: 'oops' } } }).error).toBe('oops');
    expect(CORE.parseSseChunk('openai', { type: 'response.refusal.delta', delta: 'blocked' }).error).toContain('拒绝返回正文');
    expect(CORE.parseSseChunk('openai', {
      type: 'response.incomplete',
      response: { incomplete_details: { reason: 'max_output_tokens' } }
    }).error).toContain('输出额度用完');
  });

  test('parseSseChunk: deepseek delta / finish', () => {
    expect(CORE.parseSseChunk('deepseek', { choices: [{ delta: { content: '试试' } }] }))
      .toEqual({ delta: '试试' });
    expect(CORE.parseSseChunk('deepseek', { choices: [{ delta: {}, finish_reason: 'stop' }] }).done).toBe(true);
    expect(CORE.parseSseChunk('deepseek', { choices: [{ delta: {}, finish_reason: 'content_filter' }] }).error)
      .toContain('内容过滤');
  });
});
