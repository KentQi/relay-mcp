#!/usr/bin/env node
// relay-mcp — src/index.mjs (W2)
// 入口:启动 MCP stdio server,把 contract.mjs 的定义表接到 rpc.mjs 的分派上。
// stdout 只允许出现协议响应;一切日志/诊断走 stderr。
import { startServer } from './rpc.mjs';
import { TOOLS, RESOURCES, PROMPTS, dispatch } from './contract.mjs';

const onInit = async () => ({
  protocolVersion: '2025-06-18',
  capabilities: { tools: {}, resources: {}, prompts: {} },
  serverInfo: { name: 'relay-mcp', version: '1.0.0' },
});

const onMethod = async (method, params) => {
  switch (method) {
    case 'tools/list':
      return { tools: TOOLS };

    case 'tools/call': {
      const name = params && params.name;
      const args =
        params && params.arguments && typeof params.arguments === 'object'
          ? params.arguments
          : {};
      return dispatch(name, args); // 未知工具/引擎失败均编码为 isError 结果
    }

    case 'resources/list':
      return {
        resources: RESOURCES.map(({ uri, name, description, mimeType }) => ({
          uri,
          name,
          description,
          mimeType,
        })),
      };

    case 'resources/read': {
      const uri = params && params.uri;
      const res = RESOURCES.find((r) => r.uri === uri);
      if (!res) {
        throw {
          code: -32602,
          message: `Unknown resource: ${uri} (available: ${RESOURCES.map((r) => r.uri).join(', ')})`,
        };
      }
      const text = await res.load();
      return { contents: [{ uri: res.uri, mimeType: res.mimeType, text }] };
    }

    case 'prompts/list':
      return {
        prompts: PROMPTS.map(({ name, description, arguments: argDefs }) => ({
          name,
          description,
          arguments: argDefs,
        })),
      };

    case 'prompts/get': {
      const name = params && params.name;
      const prompt = PROMPTS.find((p) => p.name === name);
      if (!prompt) {
        throw {
          code: -32602,
          message: `Unknown prompt: ${name} (available: ${PROMPTS.map((p) => p.name).join(', ')})`,
        };
      }
      const args =
        params && params.arguments && typeof params.arguments === 'object'
          ? params.arguments
          : {};
      return { messages: prompt.render(args) };
    }

    default:
      // rpc.mjs 已按已知方法表过滤;防御性兜底
      throw { code: -32601, message: `Method not found: ${method}` };
  }
};

try {
  console.error('[relay-mcp] stdio server starting (MCP subset, JSON-RPC 2.0 newline-delimited)');
  await startServer({ onInit, onMethod });
  console.error('[relay-mcp] stdin closed, server exiting');
} catch (err) {
  console.error('[relay-mcp] fatal:', err && err.stack ? err.stack : err);
  process.exit(1);
}
