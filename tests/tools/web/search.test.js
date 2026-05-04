import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';

describe('WebSearchTool', () => {
  let origKey;

  beforeEach(() => {
    mock.restoreAll();
    origKey = process.env.TAVILY_API_KEY;
  });

  afterEach(() => {
    if (origKey === undefined) {
      delete process.env.TAVILY_API_KEY;
    } else {
      process.env.TAVILY_API_KEY = origKey;
    }
  });

  it('should have correct metadata', async () => {
    const mod = await import('../../../src/tools/web/search.js');
    assert.strictEqual(mod.name, 'WebSearch');
    assert.strictEqual(typeof mod.description, 'string');
    assert.ok(mod.input_schema);
  });

  it('should return error when TAVILY_API_KEY is not set', async () => {
    delete process.env.TAVILY_API_KEY;
    // Config is frozen, so mock the env var path instead
    const mod = await import('../../../src/tools/web/search.js');
    const result = await mod.execute({ query: 'test' });
    assert.match(result, /TAVILY_API_KEY is not configured/);
  });

  it('should return formatted search results on success', async () => {
    process.env.TAVILY_API_KEY = 'test-key';

    const expectedUrl = 'https://api.tavily.com/search';
    let requestBody = null;

    mock.method(globalThis, 'fetch', async (url, opts) => {
      requestBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          answer: 'AI generated answer here',
          results: [
            { title: 'Result 1', url: 'https://example.com/1', content: 'Content snippet 1', score: 0.95 },
            { title: 'Result 2', url: 'https://example.com/2', content: 'Content snippet 2', score: 0.80 }
          ],
          response_time: 1.23
        })
      };
    });

    const mod = await import('../../../src/tools/web/search.js');
    const result = await mod.execute({ query: 'test query', includeAnswer: true });

    assert.strictEqual(requestBody.query, 'test query');
    assert.strictEqual(requestBody.include_answer, true);
    assert.match(result, /AI generated answer here/);
    assert.match(result, /Result 1/);
    assert.match(result, /example\.com\/1/);
    assert.match(result, /Content snippet 1/);
    assert.match(result, /95%/);
    assert.match(result, /Response time: 1.23s/);
  });

  it('should pass options to Tavily API correctly', async () => {
    process.env.TAVILY_API_KEY = 'test-key';

    let requestBody = null;
    mock.method(globalThis, 'fetch', async (url, opts) => {
      requestBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ results: [{ title: 'R', url: 'https://x.com', content: 'C' }] }) };
    });

    const mod = await import('../../../src/tools/web/search.js');
    await mod.execute({
      query: 'advanced search',
      depth: 'advanced',
      maxResults: 10,
      includeDomains: ['example.com'],
      excludeDomains: ['spam.com']
    });

    assert.strictEqual(requestBody.search_depth, 'advanced');
    assert.strictEqual(requestBody.max_results, 10);
    assert.deepStrictEqual(requestBody.include_domains, ['example.com']);
    assert.deepStrictEqual(requestBody.exclude_domains, ['spam.com']);
  });

  it('should handle no results gracefully', async () => {
    process.env.TAVILY_API_KEY = 'test-key';

    mock.method(globalThis, 'fetch', async () => ({
      ok: true, json: async () => ({ results: [], response_time: 0.5 })
    }));

    const mod = await import('../../../src/tools/web/search.js');
    const result = await mod.execute({ query: 'asdfghjkl' });
    assert.match(result, /No results found/);
  });

  it('should handle API errors gracefully', async () => {
    process.env.TAVILY_API_KEY = 'test-key';

    mock.method(globalThis, 'fetch', async () => ({
      ok: false, status: 401, text: async () => 'Invalid API key'
    }));

    const mod = await import('../../../src/tools/web/search.js');
    const result = await mod.execute({ query: 'test' });
    assert.match(result, /Tavily search failed \(401\)/);
    assert.match(result, /Invalid API key/);
  });

  it('should handle network errors gracefully', async () => {
    process.env.TAVILY_API_KEY = 'test-key';

    mock.method(globalThis, 'fetch', async () => { throw new Error('Network failure'); });

    const mod = await import('../../../src/tools/web/search.js');
    const result = await mod.execute({ query: 'test' });
    assert.match(result, /Search failed: Network failure/);
  });

  it('should handle timeout errors gracefully', async () => {
    process.env.TAVILY_API_KEY = 'test-key';

    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    mock.method(globalThis, 'fetch', async () => { throw abortError; });

    const mod = await import('../../../src/tools/web/search.js');
    const result = await mod.execute({ query: 'test' });
    assert.match(result, /timed out/);
  });
});
