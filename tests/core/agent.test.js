import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';

// Set env vars before config module is imported
process.env.OPENROUTER_API_KEY = 'test-key';
process.env.OPENROUTER_MODEL = 'test-model';
process.env.OPENROUTER_MAX_TOKENS = '2000';

function simpleResponse(content = 'Hello') {
  return {
    choices: [{ message: { role: 'assistant', content } }],
    usage: { cost: 0, total_tokens: 10 }
  };
}

describe('Agent', () => {
  let Agent;
  let agent;
  let mockRegistry;
  let mockTerminalManager;

  beforeEach(async () => {
    mock.restoreAll();

    // Re-import by deleting the cached module
    delete process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'test-key';
    delete process.env.OPENROUTER_MODEL;
    process.env.OPENROUTER_MODEL = 'test-model';

    Agent = (await import('../../src/core/agent.js')).default;

    mockRegistry = {
      register: mock.fn(),
      getDefinitions: mock.fn(() => []),
      execute: mock.fn(async () => 'result')
    };

    mockTerminalManager = {
      popNotifications: mock.fn(() => [])
    };
  });

  afterEach(() => {
    mock.restoreAll();
  });

  describe('constructor', () => {
    it('should set default values when only required options provided', () => {
      agent = new Agent({ apiKey: 'key', model: 'model' });
      assert.strictEqual(agent.apiKey, 'key');
      assert.strictEqual(agent.model, 'model');
      assert.strictEqual(agent.isSubagent, false);
      assert.strictEqual(agent.effort, 'high');
      assert.ok(agent.tools);
      assert.ok(agent.terminalManager);
      assert.strictEqual(agent.usage.cost, 0);
      assert.strictEqual(agent.usage.tokens, 0);
      assert.ok(agent.context instanceof Map);
    });

    it('should register built-in tools (Report, StoreSet, StoreGet, StoreList, StoreRm)', () => {
      agent = new Agent({ apiKey: 'key', model: 'model' });
      const defs = agent.tools.getDefinitions();
      const names = defs.map(d => d.function.name);
      assert.ok(names.includes('Report'));
      assert.ok(names.includes('StoreSet'));
      assert.ok(names.includes('StoreGet'));
      assert.ok(names.includes('StoreList'));
      assert.ok(names.includes('StoreRm'));
    });

    it('should set isSubagent when provided', () => {
      agent = new Agent({ apiKey: 'key', model: 'model', isSubagent: true });
      assert.strictEqual(agent.isSubagent, true);
    });

    it('should use external ToolRegistry when provided', () => {
      agent = new Agent({ apiKey: 'key', model: 'model', tools: mockRegistry });
      assert.strictEqual(agent.tools, mockRegistry);
    });

    it('should use external terminalManager when provided', () => {
      agent = new Agent({ apiKey: 'key', model: 'model', tManager: mockTerminalManager });
      assert.strictEqual(agent.terminalManager, mockTerminalManager);
    });

    it('should parse provider.order and provider.only', () => {
      agent = new Agent({ apiKey: 'key', model: 'model', order: ['openai'], only: ['anthropic'] });
      assert.deepStrictEqual(agent.provider.order, ['openai']);
      assert.deepStrictEqual(agent.provider.only, ['anthropic']);
    });

    it('should parse maxTokens from maxTokens option', () => {
      agent = new Agent({ apiKey: 'key', model: 'model', maxTokens: '4000' });
      assert.strictEqual(agent.max_tokens, 4000);
    });
  });

  describe('use', () => {
    it('should register a single tool', () => {
      agent = new Agent({ apiKey: 'key', model: 'model', tools: mockRegistry });
      const prevCount = mockRegistry.register.mock.calls.length;
      const tool = { name: 'my_tool', description: 'does stuff', input_schema: {}, execute: async () => {} };
      agent.use(tool);
      assert.strictEqual(mockRegistry.register.mock.calls.length, prevCount + 1);
    });

    it('should register an array of tools', () => {
      agent = new Agent({ apiKey: 'key', model: 'model', tools: mockRegistry });
      const prevCount = mockRegistry.register.mock.calls.length;
      const tools = [
        { name: 'tool_a', description: 'a', input_schema: {}, execute: async () => {} },
        { name: 'tool_b', description: 'b', input_schema: {}, execute: async () => {} }
      ];
      agent.use(tools);
      assert.strictEqual(mockRegistry.register.mock.calls.length, prevCount + 2);
    });
  });

  describe('_request', () => {
    it('should make a POST request to OpenRouter API', async () => {
      mock.method(globalThis, 'fetch', async (url, opts) => {
        assert.strictEqual(url, 'https://openrouter.ai/api/v1/chat/completions');
        assert.strictEqual(opts.method, 'POST');
        assert.strictEqual(opts.headers['Authorization'], 'Bearer test-key');
        assert.strictEqual(opts.headers['Content-Type'], 'application/json');
        assert.strictEqual(JSON.parse(opts.body).stream, false);
        return { ok: true, json: async () => ({ choices: [] }) };
      });

      agent = new Agent({ apiKey: 'test-key', model: 'test-model' });
      const result = await agent._request({ model: 'test-model', messages: [] });
      assert.deepStrictEqual(result, { choices: [] });
    });

    it('should reject on API error', async () => {
      mock.method(globalThis, 'fetch', async () => ({
        ok: false,
        json: async () => ({ error: { message: 'Invalid API key' } })
      }));

      agent = new Agent({ apiKey: 'bad-key', model: 'model' });
      await assert.rejects(
        agent._request({ model: 'model', messages: [] }),
        (err) => err?.error?.message === 'Invalid API key'
      );
    });

    it('should handle non-JSON response body gracefully', async () => {
      mock.method(globalThis, 'fetch', async () => ({
        ok: true,
        json: async () => { throw new Error('not json'); },
        arrayBuffer: async () => Buffer.from('plain text')
      }));

      agent = new Agent({ apiKey: 'key', model: 'model' });
      const result = await agent._request({});
      assert.strictEqual(typeof result, 'string');
    });
  });

  describe('_send', () => {
    it('should build proper payload structure', async () => {
      let capturedPayload;

      mock.method(globalThis, 'fetch', async (url, opts) => {
        capturedPayload = JSON.parse(opts.body);
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { role: 'assistant', content: 'Hi' } }],
            usage: { cost: 0.001, total_tokens: 100 }
          })
        };
      });

      agent = new Agent({ apiKey: 'test-key', model: 'test-model' });
      agent.messages = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];
      agent.tools = {
        getDefinitions: () => [{ type: 'function', function: { name: 'test_tool' } }]
      };

      await agent._send();

      assert.ok(capturedPayload);
      assert.strictEqual(capturedPayload.model, 'test-model');
      assert.strictEqual(capturedPayload.messages[0].role, 'system');
      assert.ok(capturedPayload.messages[0].content[0].cache_control);
      assert.strictEqual(capturedPayload.messages[1].role, 'user');
      assert.strictEqual(capturedPayload.tools.length, 1);
    });

    it('should add and remove cache_control on last user message', async () => {
      let capturedPayload;

      mock.method(globalThis, 'fetch', async (url, opts) => {
        capturedPayload = JSON.parse(opts.body);
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { role: 'assistant', content: 'ok' } }],
            usage: { cost: 0, total_tokens: 10 }
          })
        };
      });

      agent = new Agent({ apiKey: 'key', model: 'model' });
      agent.messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];

      await agent._send();

      // Verify cache_control was set on the last user content in the payload
      const userMsg = capturedPayload.messages[1];
      assert.strictEqual(userMsg.role, 'user');
      assert.deepStrictEqual(
        userMsg.content[0].cache_control,
        { type: 'ephemeral' }
      );

      // Verify cache_control is removed from agent.messages after request
      assert.strictEqual(agent.messages[0].content[0].cache_control, undefined);
    });

    it('should track usage cost and tokens', async () => {
      mock.method(globalThis, 'fetch', async () => ({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { cost: 0.05, total_tokens: 250 }
        })
      }));

      agent = new Agent({ apiKey: 'key', model: 'model' });
      agent.messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];

      await agent._send();
      assert.strictEqual(agent.usage.cost, 0.05);
      assert.strictEqual(agent.usage.tokens, 250);

      await agent._send();
      assert.strictEqual(agent.usage.cost, 0.10);
      assert.strictEqual(agent.usage.tokens, 500);
    });

    it('should delete tools from payload when no tools registered', async () => {
      let capturedPayload;

      mock.method(globalThis, 'fetch', async (url, opts) => {
        capturedPayload = JSON.parse(opts.body);
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { role: 'assistant', content: 'ok' } }],
            usage: { cost: 0, total_tokens: 10 }
          })
        };
      });

      agent = new Agent({ apiKey: 'key', model: 'model' });
      agent.tools = { getDefinitions: () => [] };
      agent.messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];

      await agent._send();
      assert.strictEqual(capturedPayload.tools, undefined);
    });
  });

  describe('run', () => {
    it('should add prompt to messages and return response', async () => {
      mock.method(globalThis, 'fetch', async () => ({
        ok: true,
        json: async () => simpleResponse('Hello there!')
      }));

      agent = new Agent({ apiKey: 'key', model: 'model' });
      const result = await agent.run('Hi!');

      assert.strictEqual(agent.messages.length, 2);
      assert.strictEqual(agent.messages[0].role, 'user');
      assert.strictEqual(agent.messages[1].role, 'assistant');
      assert.strictEqual(result, 'Hello there!');
    });

    it('should call callback with content and tool_calls', async () => {
      let callCount = 0;

      mock.method(globalThis, 'fetch', async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true,
            json: async () => ({
              choices: [{
                message: {
                  role: 'assistant',
                  content: 'Let me search',
                  tool_calls: [{
                    id: 'call_search',
                    type: 'function',
                    function: { name: 'search', arguments: '{"q":"test"}' }
                  }]
                }
              }],
              usage: { cost: 0, total_tokens: 15 }
            })
          };
        }
        return {
          ok: true,
          json: async () => simpleResponse('Done')
        };
      });

      agent = new Agent({ apiKey: 'key', model: 'model' });
      agent.tools = {
        getDefinitions: () => [{ type: 'function', function: { name: 'search' } }],
        execute: mock.fn(async (name, input) => `Result for ${name}`),
        register: mock.fn()
      };

      const callbackArgs = [];
      await agent.run('Search something', (content, toolCalls) => {
        callbackArgs.push({ content, toolCalls });
      });

      assert.strictEqual(callbackArgs.length, 2);
      assert.strictEqual(callbackArgs[0].content, 'Let me search');
      assert.ok(Array.isArray(callbackArgs[0].toolCalls));
      assert.strictEqual(callbackArgs[0].toolCalls.length, 1);
      assert.strictEqual(callbackArgs[1].content, 'Done');
    });

    it('should stop loop and return report when Report tool is called', async () => {
      mock.method(globalThis, 'fetch', async () => ({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: 'assistant',
              content: 'Reporting...',
              tool_calls: [{
                id: 'call_report',
                type: 'function',
                function: { name: 'Report', arguments: '{"summary":"Task done","data":"{}"}' }
              }]
            }
          }],
          usage: { cost: 0, total_tokens: 20 }
        })
      }));

      agent = new Agent({ apiKey: 'key', model: 'model' });
      agent.tools = {
        getDefinitions: () => [],
        register: mock.fn(),
        execute: mock.fn(async (name, input) => 'Report sent')
      };

      const result = await agent.run('Do task');
      assert.deepStrictEqual(result, { summary: 'Task done', data: '{}' });
      assert.deepStrictEqual(agent.finalReport, { summary: 'Task done', data: '{}' });
    });

    it('should inject terminal notifications into the conversation', async () => {
      let callCount = 0;

      mock.method(globalThis, 'fetch', async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true,
            json: async () => ({
              choices: [{
                message: {
                  role: 'assistant',
                  content: 'Processing...',
                  tool_calls: [{
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'bash', arguments: '{}' }
                  }]
                }
              }],
              usage: { cost: 0, total_tokens: 20 }
            })
          };
        }
        return {
          ok: true,
          json: async () => simpleResponse('Done')
        };
      });

      agent = new Agent({ apiKey: 'key', model: 'model', tManager: mockTerminalManager });
      mockTerminalManager.popNotifications = mock.fn(() => ['Session term_1 has terminated.']);

      agent.tools = {
        getDefinitions: () => [],
        register: mock.fn(),
        execute: mock.fn(async () => 'ok')
      };

      await agent.run('Run command');

      // Check that notification was injected as a user message
      const notificationMsg = agent.messages.find(m =>
        m.role === 'user' &&
        m.content?.some?.(c => c.text?.includes('Session term_1'))
      );
      assert.ok(notificationMsg, 'Should have injected terminal notification');
    });

    it('should handle tool argument parse errors gracefully', async () => {
      let callCount = 0;

      mock.method(globalThis, 'fetch', async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true,
            json: async () => ({
              choices: [{
                message: {
                  role: 'assistant',
                  content: 'Running...',
                  tool_calls: [{
                    id: 'call_bad',
                    type: 'function',
                    function: { name: 'bash', arguments: 'not valid json{' }
                  }]
                }
              }],
              usage: { cost: 0, total_tokens: 15 }
            })
          };
        }
        return {
          ok: true,
          json: async () => simpleResponse('Done after error')
        };
      });

      agent = new Agent({ apiKey: 'key', model: 'model' });
      agent.tools = {
        getDefinitions: () => [],
        register: mock.fn(),
        execute: mock.fn()
      };

      await agent.run('Do something');
      const toolMsg = agent.messages.find(m => m.role === 'tool');
      assert.ok(toolMsg, 'Should have tool result message');
      assert.match(toolMsg.content, /Error: Failed to parse tool arguments/);
    });

    it('should append to existing user message when last msg is user', async () => {
      mock.method(globalThis, 'fetch', async () => ({
        ok: true,
        json: async () => simpleResponse('Ok')
      }));

      agent = new Agent({ apiKey: 'key', model: 'model' });
      agent.messages = [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }];

      await agent.run('Second message');
      // Agent appends to the existing user message, then assistant responds
      const userMsg = agent.messages.find(m => m.role === 'user');
      assert.ok(userMsg, 'Should have a user message');
      assert.strictEqual(userMsg.content.length, 2);
      assert.strictEqual(userMsg.content[0].text, 'Hi');
      assert.strictEqual(userMsg.content[1].text, 'Second message');
    });

    it('should return last message content when response has no choices', async () => {
      mock.method(globalThis, 'fetch', async () => ({
        ok: true,
        json: async () => ({
          choices: [],
          usage: { cost: 0, total_tokens: 5 }
        })
      }));

      agent = new Agent({ apiKey: 'key', model: 'model' });
      const result = await agent.run('Say something');
      // Returns last message content (the user prompt) when no response
      assert.deepStrictEqual(result, [{ type: 'text', text: 'Say something' }]);
    });
  });
});
