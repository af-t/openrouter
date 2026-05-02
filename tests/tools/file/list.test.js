import { describe, it, beforeEach, afterEach, after, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as ListTool from '../../../src/tools/file/list.js';

describe('ListTool', () => {
  let tmpDir;

  beforeEach(async () => {
    mock.restoreAll();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-list-test-'));
    mock.method(process, 'cwd', () => tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should have correct metadata', () => {
    assert.strictEqual(ListTool.name, 'List');
    assert.strictEqual(typeof ListTool.description, 'string');
    assert.ok(ListTool.input_schema);
  });

  it('should list files and directories', async () => {
    await fs.writeFile(path.join(tmpDir, 'file1.txt'), 'content');
    await fs.mkdir(path.join(tmpDir, 'dir1'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'dir1', 'file2.txt'), 'content');

    const res = await ListTool.execute({ path: tmpDir });
    assert.match(res, /\[FILE\] .*file1\.txt/);
    assert.match(res, /\[DIR\] .*dir1/);
    assert.doesNotMatch(res, /file2\.txt/);
  });

  it('should list recursively', async () => {
    await fs.writeFile(path.join(tmpDir, 'file1.txt'), 'content');
    await fs.mkdir(path.join(tmpDir, 'dir1'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'dir1', 'file2.txt'), 'content');

    const res = await ListTool.execute({ path: tmpDir, recursive: true, depth: 2 });
    assert.match(res, /\[FILE\] .*file1\.txt/);
    assert.match(res, /\[DIR\] .*dir1/);
    assert.match(res, /\[FILE\] .*file2\.txt/);
  });

  it('should return (Empty directory) for empty folders', async () => {
    const emptyDir = path.join(tmpDir, 'empty');
    await fs.mkdir(emptyDir);
    const res = await ListTool.execute({ path: emptyDir });
    assert.strictEqual(res, '(Empty directory)');
  });

  it('should return an error for a missing directory', async () => {
    const res = await ListTool.execute({ path: path.join(tmpDir, 'missing') });
    assert.match(res, /ERROR:/);
    assert.match(res, /ENOENT/);
  });
});
