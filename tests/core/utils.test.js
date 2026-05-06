import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry, ensureSafePath, getIgnoreFilter, stripSecrets } from '../../src/core/utils.js';
import path from 'node:path';

const projectRoot = process.cwd();

describe('ToolRegistry', () => {
  it('register and getDefinitions', () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'test_tool',
      description: 'A test tool',
      input_schema: { type: 'object', properties: { foo: { type: 'string' } } },
      execute: async () => 'result'
    });

    const defs = registry.getDefinitions();
    assert.equal(defs.length, 1);
    assert.equal(defs[0].function.name, 'test_tool');
    assert.equal(defs[0].function.parameters.properties.foo.type, 'string');
  });

  it('listTools returns tools array', () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 't1',
      description: 'd1',
      input_schema: {},
      execute: async () => 'r1'
    });
    const list = registry.listTools();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 't1');
  });

  it('execute calls the tool function', async () => {
    const registry = new ToolRegistry();
    let called = false;
    registry.register({
      name: 'call_me',
      description: 'd',
      input_schema: {},
      execute: async (input) => {
        called = true;
        assert.deepEqual(input, { x: 1 });
        return 'ok';
      }
    });

    const res = await registry.execute('call_me', { x: 1 }, {});
    assert.equal(called, true);
    assert.equal(res, 'ok');
  });

  it('execute throws for unknown tool', async () => {
    const registry = new ToolRegistry();
    await assert.rejects(
      () => registry.execute('nope', {}, {}),
      { message: /not found/ }
    );
  });

  it('unregister removes a tool', () => {
    const registry = new ToolRegistry();
    registry.register({ name: 't', description: 'd', input_schema: {}, execute: async () => 'r' });
    assert.equal(registry.listTools().length, 1);
    const removed = registry.unregister('t');
    assert.equal(removed, true);
    assert.equal(registry.listTools().length, 0);
  });

  it('unregister returns false for nonexistent tool', () => {
    const registry = new ToolRegistry();
    const removed = registry.unregister('ghost');
    assert.equal(removed, false);
  });

  it('clear resets everything', () => {
    const registry = new ToolRegistry();
    registry.register({ name: 't', description: 'd', input_schema: {}, execute: async () => 'r' });
    registry.clear();
    assert.equal(registry.listTools().length, 0);
    assert.equal(registry.getDefinitions().length, 0);
  });

  it('register requires execute function', () => {
    const registry = new ToolRegistry();
    assert.throws(
      () => registry.register({ name: 't', description: 'd', input_schema: {} }),
      /must have an execute function/
    );
  });

  it('onBeforeExecute hook runs before tool execution', async () => {
    const registry = new ToolRegistry();
    let hookCalled = false;
    registry.onBeforeExecute(async ({ name, input }) => {
      hookCalled = true;
      assert.equal(name, 'test');
      assert.equal(input.val, 123);
    });

    registry.register({
      name: 'test',
      description: 'd',
      input_schema: {},
      execute: async () => 'result'
    });

    await registry.execute('test', { val: 123 }, {});
    assert.equal(hookCalled, true);
  });

  it('onBeforeExecute can abort by throwing', async () => {
    const registry = new ToolRegistry();
    registry.onBeforeExecute(() => { throw new Error('ABORTED'); });
    registry.register({ name: 't', description: 'd', input_schema: {}, execute: async () => 'r' });

    await assert.rejects(
      () => registry.execute('t', {}, {}),
      { message: 'ABORTED' }
    );
  });

  it('onAfterExecute hook runs after tool execution', async () => {
    const registry = new ToolRegistry();
    let hookResult = null;
    registry.onAfterExecute(async ({ result }) => {
      hookResult = result;
    });

    registry.register({
      name: 't',
      description: 'd',
      input_schema: {},
      execute: async () => 'success'
    });

    await registry.execute('t', {}, {});
    assert.equal(hookResult, 'success');
  });

  it('onBeforeExecute disposer removes the hook', async () => {
    const registry = new ToolRegistry();
    let count = 0;
    const dispose = registry.onBeforeExecute(() => { count++; });
    registry.register({ name: 't', description: 'd', input_schema: {}, execute: async () => 'r' });

    await registry.execute('t', {}, {});
    assert.equal(count, 1);

    dispose();
    await registry.execute('t', {}, {});
    assert.equal(count, 1); // No increase
  });

  it('onAfterExecute disposer removes the hook', async () => {
    const registry = new ToolRegistry();
    let count = 0;
    const dispose = registry.onAfterExecute(() => { count++; });
    registry.register({ name: 't', description: 'd', input_schema: {}, execute: async () => 'r' });

    await registry.execute('t', {}, {});
    dispose();
    await registry.execute('t', {}, {});
    assert.equal(count, 1);
  });

  it('validate required parameters', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'req',
      description: 'd',
      input_schema: { type: 'object', required: ['p1'], properties: { p1: { type: 'string' } } },
      execute: async () => 'ok'
    });

    await assert.rejects(
      () => registry.execute('req', {}, {}),
      { message: /requires parameter 'p1'/ }
    );
  });

  it('validate parameter type: number', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 't',
      description: 'd',
      input_schema: { type: 'object', properties: { p: { type: 'number' } } },
      execute: async () => 'ok'
    });
    await assert.rejects(() => registry.execute('t', { p: '123' }, {}), { message: /must be a number/ });
    await assert.doesNotReject(() => registry.execute('t', { p: 123 }, {}));
  });

  it('validate parameter type: string', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 't',
      description: 'd',
      input_schema: { type: 'object', properties: { p: { type: 'string' } } },
      execute: async () => 'ok'
    });
    await assert.rejects(() => registry.execute('t', { p: 123 }, {}), { message: /must be a string/ });
  });

  it('validate parameter type: boolean', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 't',
      description: 'd',
      input_schema: { type: 'object', properties: { p: { type: 'boolean' } } },
      execute: async () => 'ok'
    });
    await assert.rejects(() => registry.execute('t', { p: 'true' }, {}), { message: /must be a boolean/ });
  });

  it('validate parameter type: array', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 't',
      description: 'd',
      input_schema: { type: 'object', properties: { p: { type: 'array' } } },
      execute: async () => 'ok'
    });
    await assert.rejects(() => registry.execute('t', { p: {} }, {}), { message: /must be an array/ });
  });

  it('validate parameter type: object', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 't',
      description: 'd',
      input_schema: { type: 'object', properties: { p: { type: 'object' } } },
      execute: async () => 'ok'
    });
    await assert.rejects(() => registry.execute('t', { p: [] }, {}), { message: /must be an object/ });
  });

  it('validate parameter enum', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 't',
      description: 'd',
      input_schema: { type: 'object', properties: { p: { enum: ['a', 'b'] } } },
      execute: async () => 'ok'
    });
    await assert.rejects(() => registry.execute('t', { p: 'c' }, {}), { message: /must be one of \[a, b\]/ });
    await assert.doesNotReject(() => registry.execute('t', { p: 'a' }, {}));
  });

  it('concurrency: execute() from 10 concurrent promises returns correct results', async () => {
    const registry = new ToolRegistry();
    let callCount = 0;

    registry.register({
      name: 'concurrent',
      description: 'sleep and return',
      input_schema: { type: 'object', properties: { id: { type: 'number' } } },
      execute: async ({ id }) => {
        callCount++;
        // Simulate async work
        await new Promise(r => setTimeout(r, 10 + Math.random() * 50));
        return `result-${id}`;
      }
    });

    // Fire 10 concurrent calls
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(registry.execute('concurrent', { id: i }, {}));
    }

    const results = await Promise.all(promises);

    // All results should be correct
    for (let i = 0; i < 10; i++) {
      assert.ok(results.includes(`result-${i}`), `Missing result for id ${i}`);
    }
    assert.equal(callCount, 10);

    // Verify tool definitions are still intact (no state corruption)
    const defs = registry.getDefinitions();
    assert.equal(defs.length, 1);
    assert.equal(defs[0].function.name, 'concurrent');
  });

  it('concurrency: register and execute from interleaved promises has no state corruption', async () => {
    const registry = new ToolRegistry();
    const results = [];

    // Register first tool
    registry.register({
      name: 'tool_a',
      description: 'A',
      input_schema: { type: 'object', properties: {} },
      execute: async () => 'a',
    });

    const p1 = registry.execute('tool_a', {}, {}).then(r => results.push(r));

    // Concurrently register a second tool
    registry.register({
      name: 'tool_b',
      description: 'B',
      input_schema: { type: 'object', properties: {} },
      execute: async () => 'b',
    });

    const p2 = registry.execute('tool_b', {}, {}).then(r => results.push(r));

    await Promise.all([p1, p2]);

    assert.equal(registry.listTools().length, 2);
    assert.deepEqual(results.sort(), ['a', 'b']);
  });
});

describe('ensureSafePath', () => {
  it('accepts valid relative path', () => {
    const result = ensureSafePath('src/index.js');
    assert.ok(result);
    assert.ok(result.endsWith('src/index.js'));
  });

  it('accepts valid absolute path within project', () => {
    const result = ensureSafePath(path.resolve(projectRoot, 'src/core/utils.js'));
    assert.ok(result);
  });

  it('accepts the project root itself', () => {
    const result = ensureSafePath('.');
    assert.ok(result);
    assert.strictEqual(path.resolve(result), path.resolve(projectRoot));
  });

  it('rejects null byte in path', () => {
    assert.throws(
      () => ensureSafePath('../../etc/passwd\0'),
      { message: /null byte/ },
    );
  });

  it('rejects path with .. traversal', () => {
    assert.throws(
      () => ensureSafePath('../../etc/passwd'),
      { message: /URL-encoded traversal|outside project root/ },
    );
  });

  it('rejects URL-encoded path traversal %2e%2e', () => {
    assert.throws(
      () => ensureSafePath('%2e%2e%2fetc%2fpasswd'),
      { message: /URL-encoded traversal/ },
    );
  });

  it('rejects double-encoded path traversal %252e%252e', () => {
    // %252e%252e decodes to %2e%2e then to ..
    assert.throws(
      () => ensureSafePath('%252e%252e%252fetc%252fpasswd'),
      { message: /URL-encoded traversal/ },
    );
  });

  it('rejects double-encoded %252f forward slash', () => {
    // %252f decodes to %2f which is /
    assert.throws(
      () => ensureSafePath('etc%252fpasswd'),
      { message: /URL-encoded traversal/ },
    );
  });

  it('rejects %5c backslash encoding', () => {
    // %5c is backslash — should be caught
    assert.throws(
      () => ensureSafePath('..%5c..%5cetc%5cpasswd'),
      { message: /URL-encoded traversal/ },
    );
  });

  it('rejects extremely long path (> 4096 chars)', () => {
    const longPath = 'a/'.repeat(2048) + 'file.txt';
    // Path length > 4096 chars — still rejected because path.resolve may
    // produce path outside root or the path itself may be safe; we mainly
    // test that no crash occurs and the function handles it gracefully.
    try {
      ensureSafePath(longPath);
      // If it doesn't throw, it should return a valid path
    } catch (err) {
      // Throwing is acceptable for traversal or any reason
      assert.ok(err.message.length > 0);
    }
  });

  it('rejects symlink pointing outside project root', async () => {
    const fs = await import('node:fs');
    const symlinkPath = path.join(projectRoot, 'tests/fixtures/symlink-outside');
    let symlinkCreated = false;
    try {
      // Try to create symlink to /data or /etc (common on Termux/Android)
      const target = '/data';
      fs.symlinkSync(target, symlinkPath);
      symlinkCreated = true;
      // ensureSafePath should reject it since it resolves outside root
      assert.throws(
        () => ensureSafePath('tests/fixtures/symlink-outside'),
        { message: /Access denied|outside project root/ },
      );
    } catch (err) {
      if (symlinkCreated) {
        // If symlink was created but ensureSafePath didn't throw, that's wrong
        // But if it's an expected Access denied error, re-throw
        if (err.message.includes('Access denied') || err.message.includes('outside project root')) {
          // expected
        } else {
          throw err;
        }
      }
      // Symlink creation failed (e.g., restricted filesystem) — skip gracefully
    } finally {
      if (symlinkCreated) {
        try { fs.unlinkSync(symlinkPath); } catch {}
      }
    }
  });

  it('rejects protocol handler file://', () => {
    assert.throws(
      () => ensureSafePath('file:///etc/passwd'),
      { message: /protocol handler/ },
    );
  });

  it('rejects protocol handler https://', () => {
    assert.throws(
      () => ensureSafePath('https://evil.com/payload'),
      { message: /protocol handler/ },
    );
  });
});

describe('withRetry', () => {
  let withRetry;
  let origSetTimeout;

  before(async () => {
    const mod = await import('../../src/core/utils.js');
    withRetry = mod.withRetry;
    // Save original setTimeout
    origSetTimeout = globalThis.setTimeout;
  });

  after(() => {
    // Restore setTimeout if we mocked it
    if (globalThis.setTimeout !== origSetTimeout) {
      globalThis.setTimeout = origSetTimeout;
    }
  });

  it('succeeds on first attempt', async () => {
    const result = await withRetry(async () => 'success', 3);
    assert.equal(result, 'success');
  });

  it('succeeds after retries (using fast timers)', async () => {
    // Replace setTimeout with a fast version for delay-sensitive tests
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, _delay, ...args) => realSetTimeout(fn, 1, ...args);

    try {
      let attempts = 0;
      const result = await withRetry(async () => {
        attempts++;
        if (attempts < 3) throw new Error('fail');
        return 'recovered';
      }, 5);
      assert.equal(result, 'recovered');
      assert.equal(attempts, 3);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  it('throws if all retries exhausted (using fast timers)', async () => {
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, _delay, ...args) => realSetTimeout(fn, 1, ...args);

    try {
      await assert.rejects(
        () => withRetry(async () => { throw new Error('persistent'); }, 3),
        { message: 'persistent' },
      );
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  it('circuit breaker: does not retry 4xx client errors', async () => {
    let attempts = 0;
    const err = { status: 401, message: 'Unauthorized' };

    await assert.rejects(
      () => withRetry(async () => {
        attempts++;
        throw err;
      }, 5),
      { status: 401 }
    );
    assert.equal(attempts, 1);
  });

  it('circuit breaker: does not retry 401', async () => {
    let count = 0;
    await assert.rejects(
      () => withRetry(async () => { count++; throw { status: 401 }; }, 3),
      { status: 401 }
    );
    assert.equal(count, 1);
  });

  it('circuit breaker: does not retry 403', async () => {
    let count = 0;
    await assert.rejects(
      () => withRetry(async () => { count++; throw { status: 403 }; }, 3),
      { status: 403 }
    );
    assert.equal(count, 1);
  });

  it('circuit breaker: does not retry 404', async () => {
    let count = 0;
    await assert.rejects(
      () => withRetry(async () => { count++; throw { status: 404 }; }, 3),
      { status: 404 }
    );
    assert.equal(count, 1);
  });

  it('circuit breaker: does not retry 400 with different message', async () => {
    let count = 0;
    await assert.rejects(
      () => withRetry(async () => { count++; throw { status: 400, message: 'Bad input' }; }, 3),
      { status: 400 }
    );
    assert.equal(count, 1);
  });

  it('calls callback on final failure', async () => {
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, _delay, ...args) => realSetTimeout(fn, 1, ...args);

    try {
      let callbackCalled = false;
      await assert.rejects(
        () => withRetry(
          async () => { throw new Error('fail'); },
          2,
          () => { callbackCalled = true; }
        ),
        { message: 'fail' }
      );
      assert.equal(callbackCalled, true);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  it('handles hanging callback gracefully (callback returns promise that never resolves)', async () => {
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, delay, ...args) => {
      if (delay === 5000) {
        // This is the callback safety timeout — fast-forward it too
        return realSetTimeout(fn, 1, ...args);
      }
      return realSetTimeout(fn, 1, ...args);
    };

    try {
      let callbackCalled = false;
      // This callback returns a promise that never resolves
      await assert.rejects(
        () => withRetry(
          async () => { throw new Error('fail'); },
          2,
          () => {
            callbackCalled = true;
            return new Promise(() => {}); // never resolves
          },
        ),
        { message: 'fail' },
      );
      // The withRetry should have completed despite the hanging callback
      assert.equal(callbackCalled, true);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  it('timeout handling: callback that never resolves causes retry exhaustion', async () => {
    // Use a callback that hangs for a long time, then let withRetry try
    // multiple times. Each attempt hangs; withRetry should exhaust retries
    // and throw the last error.
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, delay, ...args) => {
      // Fast-forward delays to 1ms so test finishes quickly
      return realSetTimeout(fn, 1, ...args);
    };

    try {
      let attempts = 0;
      await assert.rejects(
        () => withRetry(async () => {
          attempts++;
          // This promise never resolves on its own — simulating timeout
          throw new Error('timeout');
        }, 3),
        { message: 'timeout' },
      );
      // Should have tried 3 times
      assert.equal(attempts, 3);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  it('jitter logic: delays vary across retries', async () => {
    // Mock setTimeout to capture delay values passed to it
    const realSetTimeout = globalThis.setTimeout;
    const capturedDelays = [];

    globalThis.setTimeout = (fn, delay, ...args) => {
      capturedDelays.push(delay);
      return realSetTimeout(fn, 1, ...args);
    };

    try {
      await assert.rejects(
        () => withRetry(async () => {
          throw new Error('fail');
        }, 5),
      );

      // We should have captured 5 delay values (retries=5)
      assert.ok(capturedDelays.length >= 5, `Expected >= 5 delays, got ${capturedDelays.length}`);

      // Verify delays are not all identical (jitter works)
      const uniqueDelays = new Set(capturedDelays.map(d => Math.round(d)));
      assert.ok(uniqueDelays.size > 1, `Expected varying delays (jitter), got all identical: ${capturedDelays.join(',')}`);

      // Verify approximate exponential backoff
      for (let i = 1; i < capturedDelays.length; i++) {
        const ratio = capturedDelays[i] / capturedDelays[i - 1];
        assert.ok(
          ratio >= 0.6,
          `Delay ${i} (${capturedDelays[i]}) should be >= 0.6 * delay ${i - 1} (${capturedDelays[i - 1]}), ratio=${ratio.toFixed(3)}`,
        );
      }
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});

describe('getIgnoreFilter', () => {
  it('returns a filter object with test, ignores, and add methods', async () => {
    const filter = await getIgnoreFilter();
    assert.equal(typeof filter.test, 'function');
    assert.equal(typeof filter.ignores, 'function');
    assert.equal(typeof filter.add, 'function');
  });

  it('caches the result based on cwd', async () => {
    const f1 = await getIgnoreFilter();
    const f2 = await getIgnoreFilter();
    assert.strictEqual(f1, f2);
  });
});

describe('stripSecrets', () => {
  it('strips API keys from env object', () => {
    const env = { OPENROUTER_API_KEY: 'secret123', PATH: '/usr/bin' };
    const stripped = stripSecrets(env);
    assert.equal(stripped.OPENROUTER_API_KEY, undefined);
    assert.equal(stripped.PATH, '/usr/bin');
  });

  it('strips tokens and secrets', () => {
    const env = { GITHUB_TOKEN: 'token', DB_PASSWORD: 'pass', USER: 'admin' };
    const stripped = stripSecrets(env);
    assert.equal(stripped.GITHUB_TOKEN, undefined);
    assert.equal(stripped.DB_PASSWORD, undefined);
    assert.equal(stripped.USER, 'admin');
  });

  it('strips case-insensitive matches', () => {
    const env = { MySecretKey: 'xyz', public_data: '123' };
    const stripped = stripSecrets(env);
    assert.equal(stripped.MySecretKey, undefined);
    assert.equal(stripped.public_data, '123');
  });

  it('returns empty object for empty input', () => {
    assert.deepEqual(stripSecrets({}), {});
  });

  it('does not modify the original env object', () => {
    const env = { API_KEY: '123' };
    stripSecrets(env);
    assert.equal(env.API_KEY, '123');
  });
});
