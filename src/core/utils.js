import { McpClientWrapper } from './mcp.js';
import config from '../config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import ignore from 'ignore';
import logger from './logger.js';


export async function getIgnoreFilter() {
  const ig = ignore();
  try {
    const gitignorePath = path.join(process.cwd(), '.gitignore');
    const content = await fs.readFile(gitignorePath, 'utf8');
    ig.add(content);
  } catch {
    // ignore if .gitignore not found
  }

  return {
    test: (filePath) => {
      const relPath = path.relative(process.cwd(), ensureSafePath(filePath));
      return ig.test(relPath);
    },
    ignores: (filePath) => {
      const relPath = path.relative(process.cwd(), ensureSafePath(filePath));
      return ig.ignores(relPath);
    },
    add: (content) => ig.add(content)
  };
}

export function ensureSafePath(filePath) {
  const root = process.cwd();
  const resolvedPath = path.resolve(filePath);
  const relative = path.relative(root, resolvedPath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Access denied: Path '${filePath}' is outside project root`);
  }
  return resolvedPath;
}

export function formatSize(bytes) {
  if (bytes === 0) return '0B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + sizes[i];
}

export async function withRetry(func, count = config.MAX_RETRIES, callback) {
  let delay = 5000;
  let lastError;

  for (let i = 0; i < count; i++) {
    try {
      const res = await func();
      return res;
    } catch (err) {
      await new Promise(resolve => setTimeout(resolve, delay));
      lastError = err;
      delay *= 1.3;
    }
  }

  callback?.();
  throw lastError;
}

export class ToolRegistry {
  _tools = new Map();
  _mcpClients = [];

  getDefinitions() {
    const res = [];
    for (const [name, val] of this._tools) {
      res.push({
        type: 'function',
        function: {
          name,
          description: val.description,
          parameters: val.input_schema
        }
      });
    }
    return res;
  }

  register({ name, description, input_schema, execute, dependencies = [] }) {
    if (typeof execute !== 'function') throw Error('tools cannot be executed');
    this._tools.set(name, { name, description, input_schema, execute, dependencies });
  }

  async execute(name, input, context) {
    const tool = this._tools.get(name);
    if (!tool) throw Error(`Tool ${name} not found`);
    
    // Resolve dependencies first
    const resolvedDeps = await this._resolveDependencies(tool, context);
    
    // Execute tool with resolved dependencies available
    return await tool.execute(input, { ...context, dependencies: resolvedDeps });
  }

  async _resolveDependencies(tool, context) {
    if (!tool.dependencies || tool.dependencies.length === 0) {
      return { get: () => null, getAll: () => ({}) };
    }

    const results = {};
    for (const depName of tool.dependencies) {
      if (!this._tools.has(depName)) {
        throw Error(`Dependency tool '${depName}' for '${tool.name || 'unknown'}' not found`);
      }
      // Execute dependency with minimal/default input
      // Dependencies can be configured with their own default inputs
      const depTool = this._tools.get(depName);
      const depInput = depTool.defaultInput || {};
      try {
        results[depName] = await this.execute(depName, depInput, context);
      } catch (e) {
        logger.error(`Error executing dependency ${depName}:`, e.message);
        throw e;
      }
    }
    
    return {
      get: (name) => results[name],
      getAll: () => results
    };
  }

  setDefaultInput(name, input) {
    const tool = this._tools.get(name);
    if (!tool) throw Error(`Tool ${name} not found`);
    tool.defaultInput = input;
  }

  getDependencies(name) {
    const tool = this._tools.get(name);
    if (!tool) throw Error(`Tool ${name} not found`);
    return tool.dependencies || [];
  }

  hasDependency(name, dependencyName) {
    const deps = this.getDependencies(name);
    return deps.includes(dependencyName);
  }

  getDependencyGraph() {
    const graph = new Map();
    for (const [name, tool] of this._tools) {
      graph.set(name, tool.dependencies || []);
    }
    return graph;
  }

  async connectMcpServer({ name, command, args, env }) {
    const client = new McpClientWrapper({ command, args, env });
    const remoteTools = await client.connectAndGetTools();

    for (const remoteTool of remoteTools) {
      const toolName = `${name}_${remoteTool.name}`;

      this.register({
        name: toolName,
        description: remoteTool.description || `Tool ${remoteTool.name} from ${name}`,
        input_schema: remoteTool.inputSchema || { type: 'object', properties: {} },
        execute: async (input) => {
          const result = await client.executeTool(remoteTool.name, input);
          if (result.isError) {
            throw new Error(result.content.map(c => c.text).join('\n'));
          }
          return result.content.map(c => {
             if (c.type === 'text') return c.text;
             if (c.type === 'resource') return `[Resource: ${c.resource.uri}]`;
             return JSON.stringify(c);
          }).join('\n');
        }
      });
    }
    this._mcpClients.push(client);
  }

  async cleanup() {
    for (const client of this._mcpClients) {
      try {
        await client.close();
      } catch (err) {
      }
    }
    this._mcpClients = [];
  }
}

async function isDirectory(dirPath) {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export async function* loadTools(dirPath) {
  if (!(await isDirectory(dirPath))) return;

  logger.debug(`Loading tools from: ${dirPath}`);
  const entries = (await fs.readdir(dirPath, { recursive: true, withFileTypes: true })).filter(x => x.isFile());
  for (const entry of entries) {
    const fullPath = path.resolve(path.join(entry.parentPath, entry.name));
    try {
      const mod = await import(fullPath);
      const tool = {
        name: mod.name || mod.default?.name,
        description: mod.description || mod.default?.description,
        input_schema: mod.input_schema || mod.default?.input_schema,
        execute: mod.execute || mod.default?.execute
      };

      if (!tool.name || !tool.input_schema || !tool.execute) {
        throw Error(`File '${entry.name}' does not have mandatory properties`);
      }

      logger.debug(`Tool loaded: ${tool.name}`);
      yield tool;
    } catch (err) {
      logger.error(`Failed to load tool from ${entry.name}: ${err.message}`);
    }
  }
}
