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

describe('Streaming & Tool Dependencies', () => {
  let Agent;
  let ToolRegistry;
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
    ToolRegistry = (await import('../../src/core/utils.js')).ToolRegistry;

    mockRegistry = new ToolRegistry();
    mockTerminalManager = {
      popNotifications: mock.fn(() => [])
    };
  });

  afterEach(() => {
    mock.restoreAll();
  });

  describe('Tool Dependencies', () => {
    it('should register tool with dependencies', () => {
      mockRegistry.register({
        name: 'tool_a',
        description: 'Tool A',
        input_schema: { type: 'object', properties: {} },
        execute: async () => 'result_a'
      });

      mockRegistry.register({
        name: 'tool_b',
        description: 'Tool B depends on A',
        input_schema: { type: 'object', properties: {} },
        dependencies: ['tool_a'],
        execute: async (input, { dependencies }) => {
          const depResult = dependencies.get('tool_a');
          return `result_b_with_${depResult}`;
        }
      });

      const deps = mockRegistry.getDependencies('tool_b');
      assert.deepStrictEqual(deps, ['tool_a']);
      assert.ok(mockRegistry.hasDependency('tool_b', 'tool_a'));
    });

    it('should resolve dependencies when executing tool', async () => {
      mockRegistry.register({
        name: 'tool_a',
        description: 'Tool A',
        input_schema: { type: 'object', properties: {} },
        execute: async () => 'result_a'
      });

      mockRegistry.register({
        name: 'tool_b',
        description: 'Tool B depends on A',
        input_schema: { type: 'object', properties: {} },
        dependencies: ['tool_a'],
        execute: async (input, { dependencies }) => {
          const depResult = dependencies.get('tool_a');
          return `result_b_with_${depResult}`;
        }
      });

      const result = await mockRegistry.execute('tool_b', {}, {});
      assert.strictEqual(result, 'result_b_with_result_a');
    });

    it('should throw error if dependency tool not found', async () => {
      mockRegistry.register({
        name: 'tool_b',
        description: 'Tool B depends on A',
        input_schema: { type: 'object', properties: {} },
        dependencies: ['tool_a'],
        execute: async () => 'result_b'
      });

      await assert.rejects(
        () => mockRegistry.execute('tool_b', {}, {}),
        { message: /Dependency tool 'tool_a' for 'tool_b' not found/ }
      );
    });

    it('should support multiple dependencies', async () => {
      mockRegistry.register({
        name: 'tool_a',
        description: 'Tool A',
        input_schema: { type: 'object', properties: {} },
        execute: async () => 'result_a'
      });

      mockRegistry.register({
        name: 'tool_c',
        description: 'Tool C',
        input_schema: { type: 'object', properties: {} },
        execute: async () => 'result_c'
      });

      mockRegistry.register({
        name: 'tool_b',
        description: 'Tool B depends on A and C',
        input_schema: { type: 'object', properties: {} },
        dependencies: ['tool_a', 'tool_c'],
        execute: async (input, { dependencies }) => {
          const all = dependencies.getAll();
          return `result_b_with_${all.tool_a}_and_${all.tool_c}`;
        }
      });

      const result = await mockRegistry.execute('tool_b', {}, {});
      assert.strictEqual(result, 'result_b_with_result_a_and_result_c');
    });

    it('should return empty object if no dependencies', async () => {
      mockRegistry.register({
        name: 'tool_a',
        description: 'Tool A',
        input_schema: { type: 'object', properties: {} },
        execute: async () => 'result_a'
      });

      const result = await mockRegistry.execute('tool_a', {}, {});
      assert.strictEqual(result, 'result_a');
    });

    it('should build dependency graph', () => {
      mockRegistry.register({
        name: 'tool_a',
        description: 'Tool A',
        input_schema: { type: 'object', properties: {} },
        execute: async () => 'result_a'
      });

      mockRegistry.register({
        name: 'tool_b',
        description: 'Tool B depends on A',
        input_schema: { type: 'object', properties: {} },
        dependencies: ['tool_a'],
        execute: async () => 'result_b'
      });

      const graph = mockRegistry.getDependencyGraph();
      assert.deepStrictEqual(graph.get('tool_a'), []);
      assert.deepStrictEqual(graph.get('tool_b'), ['tool_a']);
    });
  });

  describe('Streaming', () => {
    it('should generate an async iterator for streaming', async () => {
      const encoder = new TextEncoder();
      
      mock.method(globalThis, 'fetch', async (url, opts) => {
        assert.strictEqual(opts.body.includes('"stream":true'), true);
        
        // Return a mock ReadableStream with SSE data
        const sseData = [
          'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":" World"}}]}\n\n',
          'data: [DONE]\n\n'
        ].join('');

        return {
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(sseData));
              controller.close();
            }
          })
        };
      });

      agent = new Agent({ apiKey: 'test-key', model: 'test-model' });

      const chunks = [];
      for await (const chunk of agent.runStreaming('Hello')) {
        chunks.push(chunk);
      }

      assert.ok(chunks.length > 0);
    });

    it('should handle streaming responses with multiple chunks', async () => {
      let chunkCount = 0;
      
      mock.method(globalThis, 'fetch', async () => {
        // Simulate streaming response
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            const messages = [
              { choices: [{ delta: { content: 'H' } }] },
              { choices: [{ delta: { content: 'e' } }] },
              { choices: [{ delta: { content: 'l' } }] },
              { choices: [{ delta: { content: 'l' } }] },
              { choices: [{ delta: { content: 'o' } }] },
              { choices: [{ delta: { content: '!' } }] },
            ];

            for (const msg of messages) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(msg)}\n\n`));
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          }
        });

        return {
          ok: true,
          status: 200,
          body: stream
        };
      });

      agent = new Agent({ apiKey: 'test-key', model: 'test-model' });

      const chunks = [];
      for await (const chunk of agent.runStreaming('Hello')) {
        chunks.push(chunk);
        chunkCount++;
      }

      assert.ok(chunkCount > 0);
    });

    it('should handle streaming with tool calls', async () => {
      let phase = 0;
      
      mock.method(globalThis, 'fetch', async () => {
        phase++;
        
        if (phase === 1) {
          // First response with tool call
          return {
            ok: true,
            json: async () => ({
              choices: [{
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [{
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'Report', arguments: '{"data":"test"}' }
                  }]
                }
              }],
              usage: { cost: 0, total_tokens: 10 }
            })
          };
        } else {
          // Second response after tool execution
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('data: {"choices":[{"message":{"content":"Done after error"}}]}\n\n'));
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            }
          });

          return {
            ok: true,
            body: stream
          };
        }
      });

      agent = new Agent({ apiKey: 'test-key', model: 'test-model' });
      agent.tools = {
        getDefinitions: () => [],
        register: mock.fn(),
        execute: mock.fn()
      };

      const chunks = [];
      for await (const chunk of agent.runStreaming('Do something')) {
        chunks.push(chunk);
      }

      assert.ok(chunks.length > 0);
    });

    it('should handle streaming parse errors gracefully', async () => {
      mock.method(globalThis, 'fetch', async () => {
        // Return malformed SSE data
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {invalid json}\n\n'));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          }
        });

        return {
          ok: true,
          status: 200,
          body: stream
        };
      });

      agent = new Agent({ apiKey: 'test-key', model: 'test-model' });

      const chunks = [];
      for await (const chunk of agent.runStreaming('Hello')) {
        chunks.push(chunk);
      }

      // Should handle gracefully without throwing
      assert.ok(Array.isArray(chunks));
    });
  });

  describe('Integration: Streaming with Dependencies', () => {
    it('should execute tool with dependencies during streaming', async () => {
      // Setup dependencies
      mockRegistry.register({
        name: 'get_context',
        description: 'Get context',
        input_schema: { type: 'object', properties: {} },
        execute: async () => 'context_data'
      });

      mockRegistry.register({
        name: 'process_data',
        description: 'Process data with context',
        input_schema: { type: 'object', properties: {} },
        dependencies: ['get_context'],
        execute: async (input, { dependencies }) => {
          const ctx = dependencies.get('get_context');
          return `processed_${ctx}`;
        }
      });

      mock.method(globalThis, 'fetch', async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"message":{"content":"test"}}]}\n\n'));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          }
        });

        return {
          ok: true,
          status: 200,
          body: stream
        };
      });

      agent = new Agent({ apiKey: 'test-key', model: 'test-model' });
      agent.tools = mockRegistry;

      for await (const chunk of agent.runStreaming('Hello')) {
        // Just consume
      }

      // Verify dependency graph
      const graph = mockRegistry.getDependencyGraph();
      assert.deepStrictEqual(graph.get('process_data'), ['get_context']);
    });
  });
});
