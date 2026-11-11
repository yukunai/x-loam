const CORE = require('../extension/polish-core');

// Mock chrome API
const mockChrome = {
  runtime: {
    onInstalled: { addListener: jest.fn() },
    onConnect: { addListener: jest.fn() },
    onMessage: { addListener: jest.fn() },
    connect: jest.fn(),
    sendMessage: jest.fn()
  },
  contextMenus: {
    create: jest.fn(),
    removeAll: jest.fn(cb => cb && cb()),
    onClicked: { addListener: jest.fn() }
  },
  storage: {
    local: {
      get: jest.fn(),
      set: jest.fn()
    }
  },
  tabs: {
    sendMessage: jest.fn()
  }
};
global.chrome = mockChrome;

// Mock fetch
global.fetch = jest.fn();

// Mock importScripts
global.importScripts = jest.fn();

// We need SpokenPolisherCore to be available globally for background.js
global.self = global;
global.SpokenPolisherCore = CORE;

// To test background.js, we need to handle the fact that it's a script, not a module.
const fs = require('fs');
const path = require('path');
const backgroundJs = fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8')
  .replace(/importScripts\(['"][^'"]+['"]\);?/g, '');

const vm = require('vm');
const context = vm.createContext({
  chrome: mockChrome,
  SpokenPolisherCore: CORE,
  self: { SpokenPolisherCore: CORE },
  console: console,
  fetch: global.fetch,
  setTimeout: global.setTimeout,
  clearTimeout: global.clearTimeout,
  Promise: global.Promise,
  AbortController: global.AbortController,
  TextDecoder: global.TextDecoder,
  Map: global.Map,
  Date: global.Date,
  JSON: global.JSON,
  String: global.String,
  Math: global.Math
});

try {
  vm.runInContext(backgroundJs, context);
} catch (e) {
  console.error('VM error in background.js:', e);
}

describe('Background Script', () => {
  test('onInstalled creates context menu', () => {
    const onInstalledListener = mockChrome.runtime.onInstalled.addListener.mock.calls[0][0];
    onInstalledListener();
    expect(mockChrome.contextMenus.removeAll).toHaveBeenCalled();
    expect(mockChrome.contextMenus.create).toHaveBeenCalledWith(expect.objectContaining({
      id: 'spoken-polisher-polish'
    }));
  });

  test('onMessage SPOKEN_POLISH_SKILLS returns list of skills', async () => {
    const onMessageListener = mockChrome.runtime.onMessage.addListener.mock.calls[0][0];
    const sendResponse = jest.fn();
    mockChrome.storage.local.get.mockResolvedValue({
      customSkills: [
        { id: 'formal-email', name: '转正式邮件', instructions: '把文字改写成正式邮件。' }
      ]
    });

    const result = onMessageListener({ type: 'SPOKEN_POLISH_SKILLS' }, {}, sendResponse);
    expect(result).toBe(true);

    await new Promise(resolve => setTimeout(resolve, 10));
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      skills: expect.arrayContaining([
        expect.objectContaining({ id: 'spoken-polisher' }),
        expect.objectContaining({ id: 'deep-rewrite' }),
        expect.objectContaining({ id: 'formal-email', name: '转正式邮件', builtIn: false })
      ])
    }));
  });

  test('polish function coalesces in-flight requests', async () => {
    const onMessageListener = mockChrome.runtime.onMessage.addListener.mock.calls[0][0];
    const sendResponse1 = jest.fn();
    const sendResponse2 = jest.fn();
    
    mockChrome.storage.local.get.mockResolvedValue({ 
      openaiKey: 'sk-123',
      provider: 'openai'
    });

    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ output_text: 'Polished Result' })
    });

    onMessageListener({ type: 'SPOKEN_POLISH_REQUEST', text: 'Hello' }, {}, sendResponse1);
    onMessageListener({ type: 'SPOKEN_POLISH_REQUEST', text: 'Hello' }, {}, sendResponse2);

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(fetch).toHaveBeenCalledTimes(1); 
    expect(sendResponse1).toHaveBeenCalledWith(expect.objectContaining({ ok: true, text: 'Polished Result' }));
    expect(sendResponse2).toHaveBeenCalledWith(expect.objectContaining({ ok: true, text: 'Polished Result' }));
  });

  test('runPolish triggers retry for rewrite mode when similarity is too high', async () => {
    const onMessageListener = mockChrome.runtime.onMessage.addListener.mock.calls[0][0];
    const sendResponse = jest.fn();
    
    mockChrome.storage.local.get.mockResolvedValue({ 
      anthropicKey: 'sk-123',
      provider: 'anthropic'
    });

    fetch.mockClear();
    // First call returns text very similar to source
    const source = '这是一个非常书面化的句子。';
    fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ content: [{ type: 'text', text: source }] })
    });
    // Second call (retry) returns improved text
    fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ content: [{ type: 'text', text: '这句是大改后的口语。' }] })
    });

    onMessageListener({ type: 'SPOKEN_POLISH_REQUEST', text: source, skillId: 'deep-rewrite' }, {}, sendResponse);

    await new Promise(resolve => setTimeout(resolve, 100));

    const retryCalls = fetch.mock.calls.filter(([url, options]) => {
      const body = options && options.body ? JSON.parse(options.body) : {};
      return String(url).includes('anthropic.com') && body.messages && body.messages[0] && body.messages[0].content.includes(source);
    });
    expect(retryCalls).toHaveLength(2); // Initial + Retry for this rewrite request
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ 
      ok: true, 
      text: '这句是大改后的口语。',
      notice: expect.stringContaining('字面相似度')
    }));
  });
});
