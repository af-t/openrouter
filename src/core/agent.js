import { withRetry, ToolRegistry } from './utils.js';
import { randomUUID } from 'node:crypto';
import terminalManager from './terminal.js';
import logger from './logger.js';
import config from '../config.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
function loadInstruction() {
  const agentMdPath = path.resolve(import.meta.dirname, '../../AGENT.md');
  let base = '';
  try {
    base = fs.readFileSync(agentMdPath, 'utf8').trim();
  } catch {
    base = 'You are an interactive agent that helps users with software engineering tasks.';
  }

  const envInfo = [
    '',
    '',
    '# Environment',
    'You have been invoked in the following environment: ',
    ` - Primary working directory: ${process.cwd()}`,
    ` - Is a git repository: ${fs.existsSync('.git')}`,
    ` - Platform: ${os.platform()}`,
    ` - Shell: ${process.env.SHELL || 'unknown'}`,
    ` - OS Version: ${os.release()}`,
    ''
  ].join('\n');

  return base + envInfo.slice(0, -1);
}

const INSTRUCTION = loadInstruction();

class Agent {
  constructor (options = {}) {
    const {
      apiKey,
      model,
      tools,
      order,
      only,
      isSubagent = false,
      maxTokens,
      // Inject managers if provided (for subagents)
      tManager = terminalManager
    } = options;

    this.apiKey = apiKey;
    this.model = model;
    this.provider = {
      order: order,
      only: only
    };
    this.messages = [];
    this.tools = tools || new ToolRegistry();
    this.terminalManager = tManager;
    this.isSubagent = isSubagent;
    this.effort = 'high';
    this.max_tokens = parseInt(maxTokens || config.MAX_TOKENS || 0) || undefined;
    this.usage = { cost: 0, tokens: 0 };
    this.finalReport = null; // Store subagent result
    this.context = new Map();

    // register builtin tools
    this.use([
      {
        name: 'Report',
        description: 'Signal the completion of an assigned task. Call this tool to return a final summary and data to the requester.',
        input_schema: {
          type: 'object',
          properties: {
            data: { type: 'string', description: 'The final JSON data to return' },
            summary: { type: 'string', description: 'Executive summary of work performed' }
          },
          required: ['data']
        },
        execute: async() => 'Report sent'
      },
      {
        name: 'StoreSet',
        description: 'Store a value in the short-term context.',
        input_schema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'The key to store' },
            value: { type: 'string', description: 'The value to store' }
          },
          required: ['key', 'value']
        },
        execute: async({ key, value }) => {
          this.context.set(key, value);
          return 'Success';
        }
      },
      {
        name: 'StoreGet',
        description: 'Read a value from the short-term context.',
        input_schema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'The key to retrieve' }
          },
          required: ['key']
        },
        execute: async({ key }) => this.context.has(key) ? this.context.get(key) : '(Empty)'
      },
      {
        name: 'StoreList',
        description: 'Get a list of keys that are currently active in the short-term context.',
        input_schema: {
          type: 'object',
          properties: {}
        },
        execute: async() => Array.from(this.context.keys())
      },
      {
        name: 'StoreRm',
        description: 'Remove a value from the short-term context.',
        input_schema: {
          type: 'object',
          properties: {
            keys: {
              type: 'array',
              items: { type: 'string' },
              description: 'The keys to remove'
            }
          },
          required: ['keys']
        },
        execute: async({ keys }) => {
          const keyList = Array.isArray(keys) ? keys : [keys];
          for (const key of keyList) this.context.delete(key);
          return 'Success';
        }
      }
    ]);
  }

  use(tools) {
    if (Array.isArray(tools)) {
      for (const tool of tools) {
        this.tools.register(tool);
      }
      return;
    }
    this.tools.register(tools);
  }

  async run(prompt, callback = () => null) {
    if (prompt) {
      const contents = Array.isArray(prompt) ? prompt : [{ type: 'text', text: prompt }];
      const lastIdx = this.messages.length - 1;

      if (this.messages[lastIdx]?.role === 'user' && Array.isArray(this.messages[lastIdx].content)) {
        this.messages[lastIdx].content.push(...contents);
      } else {
        this.messages.push({ role: 'user', content: contents });
      }
    }

    while (true) {
      const response = await withRetry(() => this._send(), 5, () => {
        const lastMsg = this.messages.pop();
        if (lastMsg.role !== 'user') {
          this.messages.push(lastMsg);
        }
      });
      const choice = response.choices?.[0]?.message;
      if (!choice) break;

      callback(choice.content, choice.tool_calls);
      this.messages.push(choice);

      if (!choice.tool_calls || choice.tool_calls.length === 0) break;

      for (const tc of choice.tool_calls) {
        const name = tc.function.name;
        let input;
        try {
          input = JSON.parse(tc.function.arguments);
        } catch (e) {
          logger.debug(`Failed to parse tool arguments for ${name}: ${e.message}`);
          this.messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: `Error: Failed to parse tool arguments as JSON: ${e.message}`
          });
          continue;
        }

        logger.debug(`Executing tool: ${name}`);
        const result = await this.tools.execute(name, input, { agent: this });

        this.messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: (typeof result === 'string') ? result : JSON.stringify(result)
        });

        if (name === 'Report') {
          this.finalReport = input;
          return this.finalReport;
        }
      }

      // Inject background terminal notifications
      const notifications = this.terminalManager.popNotifications();
      if (notifications.length) {
        this.messages.push({
          role: 'user',
          content: [{
            type: 'text',
            text: `<system-reminder>\n${notifications.join('\n')}\n</system-reminder>`
          }]
        });
      }
    }

    return this.messages[this.messages.length - 1].content;
  }

  async *runStreaming(prompt, callback = () => null) {
    if (prompt) {
      const contents = Array.isArray(prompt) ? prompt : [{ type: 'text', text: prompt }];
      const lastIdx = this.messages.length - 1;

      if (this.messages[lastIdx]?.role === 'user' && Array.isArray(this.messages[lastIdx].content)) {
        this.messages[lastIdx].content.push(...contents);
      } else {
        this.messages.push({ role: 'user', content: contents });
      }
    }

    while (true) {
      const stream = await withRetry(() => this._sendStreaming(), 5, () => {
        const lastMsg = this.messages.pop();
        if (lastMsg.role !== 'user') {
          this.messages.push(lastMsg);
        }
      });

      if (stream && typeof stream.getReader === 'function') {
        let fullContent = '';
        let collectedToolCalls = [];

        for await (const parsed of this._handleStreamingResponse(stream)) {
          const choice = parsed.choices?.[0];
          if (choice?.delta?.content) {
            fullContent += choice.delta.content;
          }
          if (choice?.message?.tool_calls) {
            collectedToolCalls = choice.message.tool_calls;
          }
          yield parsed;
        }

        this.usage.tokens += Math.ceil(fullContent.length / 4);

        // Process collected tool calls
        if (collectedToolCalls.length > 0) {
          const choice = {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: collectedToolCalls
            }
          };
          callback(choice.content, collectedToolCalls);
          this.messages.push(choice);

          for (const tc of collectedToolCalls) {
            const name = tc.function.name;
            let input;
            try {
              input = JSON.parse(tc.function.arguments);
            } catch (e) {
              logger.debug(`Failed to parse tool arguments for ${name}: ${e.message}`);
              this.messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: `Error: Failed to parse tool arguments as JSON: ${e.message}`
              });
              continue;
            }

            logger.debug(`Executing tool: ${name}`);
            const result = await this.tools.execute(name, input, { agent: this });

            this.messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: (typeof result === 'string') ? result : JSON.stringify(result)
            });

            if (name === 'Report') {
              this.finalReport = input;
              yield* this._streamResponse(
                JSON.stringify({ type: 'report', data: this.finalReport }),
                true
              );
              return;
            }
          }

          const notifications = this.terminalManager.popNotifications();
          if (notifications.length) {
            this.messages.push({
              role: 'user',
              content: [{
                type: 'text',
                text: `<system-reminder>\n${notifications.join('\n')}\n</system-reminder>`
              }]
            });
          }
        } else if (fullContent) {
          // Update messages with streamed content
          const choice = { message: { role: 'assistant', content: fullContent } };
          callback(fullContent, null);
          this.messages.push(choice);
        }

        break; // Exit while loop after processing stream
      } else {
        // Non-streaming fallback - not expected in normal streaming flow
        logger.debug('Non-streaming response received in streaming call');
        break;
      }
    }

    const lastContent = this.messages[this.messages.length - 1].content;
    yield* this._streamResponse(
      typeof lastContent === 'string' ? lastContent : JSON.stringify(lastContent),
      true
    );
  }

  async _sendStreaming() {
    const lastMsg = this.messages[this.messages.length - 1];
    let hasCacheControl = false;

    if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content) && lastMsg.content.length > 0) {
      lastMsg.content[lastMsg.content.length - 1].cache_control = { type: 'ephemeral' };
      hasCacheControl = true;
    }

    const payload = {
      model: this.model,
      messages: [
        {
          role: 'system',
          content: [{
            type: 'text',
            text: INSTRUCTION,
            cache_control: { type: 'ephemeral' }
          }]
        },
        ...this.messages
      ],
      tools: this.tools.getDefinitions(),
      provider: this.provider,
      max_tokens: this.max_tokens,
      reasoning_effort: this.effort,
      stream: true,
    };

    if (payload.tools.length === 0) delete payload.tools;

    logger.debug(`Sending streaming request to LLM (${this.model})...`);
    const stream = await this._requestStreaming(payload);
    logger.debug(`Received streaming response from LLM.`);

    if (hasCacheControl) {
      delete lastMsg.content[lastMsg.content.length - 1].cache_control;
    }

    return stream;
  }

  async _send(passPayload) {
    const lastMsg = this.messages[this.messages.length - 1];
    let hasCacheControl = false;

    if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content) && lastMsg.content.length > 0) {
      lastMsg.content[lastMsg.content.length - 1].cache_control = { type: 'ephemeral' };
      hasCacheControl = true;
    }

    const payload = passPayload || {
      model: this.model,
      messages: [
        {
          role: 'system',
          content: [{
            type: 'text',
            text: INSTRUCTION,
            cache_control: { type: 'ephemeral' }
          }]
        },
        ...this.messages
      ],
      tools: this.tools.getDefinitions(),
      provider: this.provider,
      max_tokens: this.max_tokens,
      reasoning_effort: this.effort,
    };

    if (payload.tools.length === 0) delete payload.tools;

    logger.debug(`Sending request to LLM (${this.model})...`);
    const response = await this._request(payload);
    logger.debug(`Received response from LLM.`);

    if (hasCacheControl) {
      delete lastMsg.content[lastMsg.content.length - 1].cache_control;
    }

    this.usage.cost += (response.usage?.cost || 0);
    this.usage.tokens += (response.usage?.total_tokens || 0);

    return response;
  }

  async _request(payload) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ...payload, stream: false })
    });

    let responseBody;
    try {
      responseBody = await res.json();
    } catch {
      try {
        responseBody = await res.arrayBuffer();
        responseBody = Buffer.from(responseBody).toString();
      } catch {}
    }

    return res.ok ?
      Promise.resolve(responseBody) :
      Promise.reject(responseBody);
  }

  async _requestStreaming(payload) {
    const url = 'https://openrouter.ai/api/v1/chat/completions';
    const body = JSON.stringify({ ...payload, stream: true });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: body
    });

    if (!response.ok) {
      let errorBody;
      try {
        errorBody = await response.json();
      } catch {
        throw Error(`Request failed with status ${response.status}`);
      }
      throw errorBody;
    }

    return response.body;
  }

  async *_handleStreamingResponse(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === ':') continue;
          if (trimmed.startsWith('data: ')) {
            const data = trimmed.slice(6);
            if (data === '[DONE]') {
              return;
            }
            try {
              const parsed = JSON.parse(data);
              yield parsed;
            } catch (e) {
              logger.debug(`Failed to parse streaming chunk: ${e.message}`);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async *_streamResponse(content, done = false) {
    yield {
      choices: [{
        message: {
          content: content,
          role: 'assistant'
        }
      }]
    };
    if (done) {
      yield { done: true };
    }
  }
}

export default Agent;
