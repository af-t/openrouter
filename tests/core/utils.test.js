import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import * as utils from '../../src/core/utils.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('Utility functions', () => {
  let tmpDir;
  let oldPwd;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-utils-'));
    oldPwd = process.cwd();
    mock.restoreAll();
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    process.chdir(oldPwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('ensureSafePath', () => {
    it('should allow paths inside root', () => {
      const res = utils.ensureSafePath('test.txt');
      assert.strictEqual(res, path.join(tmpDir, 'test.txt'));
    });

    it('should allow current directory', () => {
      const res = utils.ensureSafePath('.');
      assert.strictEqual(res, tmpDir);
    });

    it('should block paths outside root (..)', () => {
      assert.throws(() => utils.ensureSafePath('..'), /Access denied/);
    });

    it('should block absolute paths outside root', () => {
      const outsidePath = path.resolve(tmpDir, '..', 'outside.txt');
      assert.throws(() => utils.ensureSafePath(outsidePath), /Access denied/);
    });

    it('should block sibling directories with similar names', async () => {
      // Create a sibling directory
      const siblingDir = tmpDir + '-sibling';
      await fs.mkdir(siblingDir, { recursive: true });
      try {
        assert.throws(() => utils.ensureSafePath(siblingDir), /Access denied/);
      } finally {
        await fs.rm(siblingDir, { recursive: true, force: true });
      }
    });
  });

  describe('getIgnoreFilter', () => {
    it('should normalize paths starting with ./', async () => {
      const filter = await utils.getIgnoreFilter();
      await fs.writeFile('.gitignore', 'node_modules\n');
      filter.add('node_modules\n'); // Refresh filter rules since we can't easily reload file in same instance without helper

      const res = filter.test('./node_modules');
      assert.ok(res.ignored);
    });

    it('should handle absolute paths within root', async () => {
      const filter = await utils.getIgnoreFilter();
      filter.add('secret.key\n');
      const absPath = path.join(tmpDir, 'secret.key');

      const res = filter.test(absPath);
      assert.ok(res.ignored);
    });

    it('should respect .gitignore file on creation', async () => {
      await fs.writeFile('.gitignore', 'ignored.txt');
      const filter = await utils.getIgnoreFilter();

      const res = filter.test('ignored.txt');
      assert.ok(res.ignored);

      const res2 = filter.test('allowed.txt');
      assert.ok(!res2.ignored);
    });
  });

  describe('formatSize', () => {
    it('should format bytes correctly', () => {
      assert.strictEqual(utils.formatSize(0), '0B');
      assert.strictEqual(utils.formatSize(1024), '1KB');
      assert.strictEqual(utils.formatSize(1024 * 1024), '1MB');
      assert.strictEqual(utils.formatSize(1024 * 1024 * 1024), '1GB');
      assert.strictEqual(utils.formatSize(1500), '1.5KB');
    });
  });

  describe('withRetry', () => {
    it('should succeed if first call succeeds', async () => {
      let calls = 0;
      const task = async () => {
        calls++;
        return 'success';
      };

      const res = await utils.withRetry(task, 3);
      assert.strictEqual(res, 'success');
      assert.strictEqual(calls, 1);
    });

    it('should retry on failure and eventually succeed', async () => {
      let calls = 0;
      const task = async () => {
        calls++;
        if (calls < 2) throw new Error('fail');
        return 'success';
      };

      // Mocking setTimeout to speed up test
      mock.method(global, 'setTimeout', (fn) => fn());

      const res = await utils.withRetry(task, 3);
      assert.strictEqual(res, 'success');
      assert.strictEqual(calls, 2);
    });

    it('should throw after max retries', async () => {
      let calls = 0;
      const task = async () => {
        calls++;
        throw new Error('permanent failure');
      };

      mock.method(global, 'setTimeout', (fn) => fn());

      await assert.rejects(utils.withRetry(task, 2), /permanent failure/);
      assert.strictEqual(calls, 2);
    });
  });

  describe('ToolRegistry', () => {
    it('should register and execute tools', async () => {
      const registry = new utils.ToolRegistry();
      let executed = false;

      registry.register({
        name: 'test_tool',
        description: 'A test tool',
        input_schema: { type: 'object' },
        execute: async (input) => {
          executed = true;
          return `input was ${JSON.stringify(input)}`;
        }
      });

      const defs = registry.getDefinitions();
      assert.strictEqual(defs.length, 1);
      assert.strictEqual(defs[0].function.name, 'test_tool');

      const result = await registry.execute('test_tool', { foo: 'bar' });
      assert.ok(executed);
      assert.strictEqual(result, 'input was {"foo":"bar"}');
    });

    it('should throw when executing non-existent tool', async () => {
      const registry = new utils.ToolRegistry();
      await assert.rejects(registry.execute('nope', {}), /Tool nope not found/);
    });

    it('should connect to MCP server and register tools using npx', async () => {
      const registry = new utils.ToolRegistry();
      try {
        // Use a longer timeout for npx and network
        await registry.connectMcpServer({
          name: 'context7',
          command: 'npx',
          args: ['-y', '@upstash/context7-mcp@latest']
        });

        const defs = registry.getDefinitions();

        assert.ok(defs.length > 0, 'Should have registered some tools');
        const toolNames = defs.map(d => d.function.name);
        const hasResolve = toolNames.some(name => name.includes('resolve'));
        const hasQuery = toolNames.some(name => name.includes('query'));
        assert.ok(hasResolve || hasQuery, `Should have resolve or query tool, found: ${toolNames.join(', ')}`);
      } catch (err) {
        // If it's a network error or npx failure, we might want to skip or log
        // but for this task we want it to work.
        throw err;
      } finally {
        await registry.cleanup();
      }
    });
  });

  describe('loadTools', () => {
    it('should yield tools from a directory', async () => {
      const toolsDir = path.join(tmpDir, 'tools');
      await fs.mkdir(toolsDir);

      const toolFile = path.join(toolsDir, 'hello.js');
      await fs.writeFile(toolFile, `
        export const name = 'hello';
        export const description = 'says hello';
        export const input_schema = { type: 'object' };
        export const execute = async () => 'hello';
      `);

      const loadedTools = [];
      for await (const tool of utils.loadTools(toolsDir)) {
        loadedTools.push(tool);
      }

      assert.strictEqual(loadedTools.length, 1);
      assert.strictEqual(loadedTools[0].name, 'hello');
      assert.strictEqual(await loadedTools[0].execute(), 'hello');
    });

    it('should return empty if directory does not exist', async () => {
      const loadedTools = [];
      for await (const tool of utils.loadTools(path.join(tmpDir, 'missing'))) {
        loadedTools.push(tool);
      }
      assert.strictEqual(loadedTools.length, 0);
    });
  });
});
