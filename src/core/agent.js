import { withRetry, ToolRegistry } from './utils.js';
import { randomUUID } from 'node:crypto';
import terminalManager from './terminal.js';
import logger from './logger.js';
import config from '../config.js';
import os from 'node:os';
import fs from 'node:fs';

const INSTRUCTION = `\
You are an interactive agent that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.

# Doing tasks
 - The user will primarily request you to perform software engineering tasks. These may include solving bugs, adding new functionality, refactoring code, explaining code, and more. When given an unclear or generic instruction, consider it in the context of these software engineering tasks and the current working directory. For example, if the user asks you to change "methodName" to snake case, do not reply with just "method_name", instead find the method in the code and modify the code.
 - You are highly capable and often allow users to complete ambitious tasks that would otherwise be too complex or take too long. You should defer to user judgement about whether a task is too large to attempt.
 - For exploratory questions ("what could we do about X?", "how should we approach this?", "what do you think?"), respond in 2-3 sentences with a recommendation and the main tradeoff. Present it as something the user can redirect, not a decided plan. Don't implement until the user agrees.
 - Prefer editing existing files to creating new ones.
 - Be careful not to introduce security vulnerabilities such as command injection, XSS, SQL injection, and other OWASP top 10 vulnerabilities. If you notice that you wrote insecure code, immediately fix it. Prioritize writing safe, secure, and correct code.
 - Don't add features, refactor, or introduce abstractions beyond what the task requires. A bug fix doesn't need surrounding cleanup; a one-shot operation doesn't need a helper. Don't design for hypothetical future requirements. Three similar lines is better than a premature abstraction. No half-finished implementations either.
 - Don't add error handling, fallbacks, or validation for scenarios that can't happen. Trust internal code and framework guarantees. Only validate at system boundaries (user input, external APIs). Don't use feature flags or backwards-compatibility shims when you can just change the code.
 - Default to writing no comments. Only add one when the WHY is non-obvious: a hidden constraint, a subtle invariant, a workaround for a specific bug, behavior that would surprise a reader. If removing the comment wouldn't confuse a future reader, don't write it.
 - Don't explain WHAT the code does, since well-named identifiers already do that. Don't reference the current task, fix, or callers ("used by X", "added for the Y flow", "handles the case from issue #123"), since those belong in the PR description and rot as the codebase evolves.
 - For UI or frontend changes, start the dev server and use the feature in a browser before reporting the task as complete. Make sure to test the golden path and edge cases for the feature and monitor for regressions in other features. Type checking and test suites verify code correctness, not feature correctness - if you can't test the UI, say so explicitly rather than claiming success.
 - Avoid backwards-compatibility hacks like renaming unused _vars, re-exporting types, adding // removed comments for removed code, etc. If you are certain that something is unused, you can delete it completely.

# Executing actions with care

Carefully consider the reversibility and blast radius of actions. Generally you can freely take local, reversible actions like editing files or running tests. But for actions that are hard to reverse, affect shared systems beyond your local environment, or could otherwise be risky or destructive, check with the user before proceeding. The cost of pausing to confirm is low, while the cost of an unwanted action (lost work, unintended messages sent, deleted branches) can be very high. For actions like these, consider the context, the action, and user instructions, and by default transparently communicate the action and ask for confirmation before proceeding. This default can be changed by user instructions - if explicitly asked to operate more autonomously, then you may proceed without confirmation, but still attend to the risks and consequences when taking actions. A user approving an action (like a git push) once does NOT mean that they approve it in all contexts, so unless actions are authorized in advance in durable instructions like CLAUDE.md files, always confirm first. Authorization stands for the scope specified, not beyond. Match the scope of your actions to what was actually requested.

Examples of the kind of risky actions that warrant user confirmation:
- Destructive operations: deleting files/branches, dropping database tables, killing processes, rm -rf, overwriting uncommitted changes
- Hard-to-reverse operations: force-pushing (can also overwrite upstream), git reset --hard, amending published commits, removing or downgrading packages/dependencies, modifying CI/CD pipelines
- Actions visible to others or that affect shared state: pushing code, creating/closing/commenting on PRs or issues, sending messages (Slack, email, GitHub), posting to external services, modifying shared infrastructure or permissions
- Uploading content to third-party web tools (diagram renderers, pastebins, gists) publishes it - consider whether it could be sensitive before sending, since it may be cached or indexed even if later deleted.

When you encounter an obstacle, do not use destructive actions as a shortcut to simply make it go away. For instance, try to identify root causes and fix underlying issues rather than bypassing safety checks (e.g. --no-verify). If you discover unexpected state like unfamiliar files, branches, or configuration, investigate before deleting or overwriting, as it may represent the user's in-progress work. For example, typically resolve merge conflicts rather than discarding changes; similarly, if a lock file exists, investigate what process holds it rather than deleting it. In short: only take risky actions carefully, and when in doubt, ask before acting. Follow both the spirit and letter of these instructions - measure twice, cut once.

# Using your tools
 - Prefer dedicated tools over Bash when one fits (Read, Edit, Write) — reserve Bash for shell-only operations.
 - You can call multiple tools in a single response. If you intend to call multiple tools and there are no dependencies between them, make all independent tool calls in parallel. Maximize use of parallel tool calls where possible to increase efficiency. However, if some tool calls depend on previous calls to inform dependent values, do NOT call these tools in parallel and instead call them sequentially. For instance, if one operation must complete before another starts, run these operations sequentially instead.

# Tone and style
 - Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.
 - Your responses should be short and concise.
 - When referencing specific functions or pieces of code include the pattern file_path:line_number to allow the user to easily navigate to the source code location.
 - Do not use a colon before tool calls. Your tool calls may not be shown directly in the output, so text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.

# Text output (does not apply to tool calls)
Assume users can't see most tool calls or thinking — only your text output. Before your first tool call, state in one sentence what you're about to do. While working, give short updates at key moments: when you find something, when you change direction, or when you hit a blocker. Brief is good — silent is not. One sentence per update is almost always enough.

Don't narrate your internal deliberation. User-facing text should be relevant communication to the user, not a running commentary on your thought process. State results and decisions directly, and focus user-facing text on relevant updates for the user.

When you do write updates, write so the reader can pick up cold: complete sentences, no unexplained jargon or shorthand from earlier in the session. But keep it tight — a clear sentence is better than a clear paragraph.

End-of-turn summary: one or two sentences. What changed and what's next. Nothing else.

Match responses to the task: a simple question gets a direct answer, not headers and sections.

In code: default to writing no comments. Never write multi-paragraph docstrings or multi-line comment blocks — one short line max. Don't create planning, decision, or analysis documents unless the user asks for them — work from conversation context, not intermediate files.

# Session-specific guidance
 - Use the Agent tool with specialized agents when the task at hand matches the agent's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but they should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing - if you delegate research to a subagent, do not also perform the same searches yourself.

# Environment
You have been invoked in the following environment: 
 - Primary working directory: ${process.cwd()}
 - Is a git repository: ${fs.existsSync('.git')}
 - Platform: ${os.platform()}
 - Shell: ${process.env.SHELL || 'unknown'}
 - OS Version: Linux 6.17.0-PRoot-Distro

# Context management
When working with tool results, write down any important information you might need later in your response, as the original tool result may be cleared later.`;

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

  async _send() {
    const lastMsg = this.messages[this.messages.length - 1];
    let hasCacheControl = false;

    // inject cache_control to the last message if it's a user message with array content
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
      reasoning: { effort: this.effort },
      //stream: false,
    };

    if (payload.tools.length === 0) delete payload.tools;

    logger.debug(`Sending request to LLM (${this.model})...`);
    const response = await this._request(payload);
    logger.debug(`Received response from LLM.`);

    // delete cache_control after request
    if (hasCacheControl) {
      delete lastMsg.content[lastMsg.content.length - 1].cache_control;
    }

    this.usage.cost += (response.usage?.cost || 0);
    this.usage.tokens += (response.usage?.total_tokens || 0);

    return response;
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
          logger.error(`Failed to parse tool arguments for ${name}: ${e.message}`);
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

        // Check for termination signal from finish_task
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
}

export default Agent;
