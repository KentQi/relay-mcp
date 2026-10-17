// relay-mcp — src/rpc.mjs (W2)
// MCP stdio 子集:换行分隔 JSON-RPC 2.0。
// 铁律:stdout 只输出协议响应(每响应一行 JSON),任何日志走 stderr。
import { createInterface } from 'node:readline';

// 本 server 支持的全部 method;其余带 id 的请求 → -32601
const KNOWN_METHODS = new Set([
  'initialize',
  'ping',
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/read',
  'prompts/list',
  'prompts/get',
]);

const DEFAULT_INIT_RESULT = () => ({
  protocolVersion: '2025-06-18',
  capabilities: { tools: {}, resources: {}, prompts: {} },
  serverInfo: { name: 'relay-mcp', version: '1.0.0' },
});

/**
 * 启动 stdio JSON-RPC 循环。stdin 关闭时 resolve。
 * - 每行一个 JSON-RPC 2.0 消息;notification(无 id)直接忽略不回
 * - initialize → onInit(params);ping → {};其余已知 method → onMethod(method, params)
 * - onMethod 可返回 result,或抛 {code, message} → 错误响应
 * - 解析失败 → -32700;未知 method → -32601;实现异常 → -32603
 * stdout 绝不输出非协议内容。
 */
export const startServer = async ({ onInit, onMethod } = {}) => {
  const rl = createInterface({ input: process.stdin, terminal: false });

  const writeLine = (msg) => {
    process.stdout.write(JSON.stringify(msg) + '\n');
  };
  const sendResult = (id, result) =>
    writeLine({ jsonrpc: '2.0', id: id === undefined ? null : id, result: result ?? {} });
  const sendError = (id, code, message) =>
    writeLine({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });

  const handleLine = async (line) => {
    const raw = String(line).trim();
    if (raw === '') return; // 空行忽略

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return sendError(null, -32700, 'Parse error: line is not valid JSON');
    }
    if (Array.isArray(msg)) {
      return sendError(null, -32600, 'Invalid request: batch arrays are not supported');
    }
    if (msg === null || typeof msg !== 'object') {
      return sendError(null, -32600, 'Invalid request');
    }

    const id = msg.id;
    const isRequest = id !== undefined; // notification(无 id)一律不回
    const method = msg.method;

    if (typeof method !== 'string') {
      if (isRequest) return sendError(id, -32600, 'Invalid request: missing method');
      return;
    }
    if (!isRequest) return; // 忽略 notification

    if (!KNOWN_METHODS.has(method)) {
      return sendError(id, -32601, `Method not found: ${method}`);
    }

    const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
    try {
      let result;
      if (method === 'initialize') {
        result = onInit ? await onInit(params) : DEFAULT_INIT_RESULT();
      } else if (method === 'ping') {
        result = {};
      } else {
        result = onMethod ? await onMethod(method, params) : {};
      }
      sendResult(id, result);
    } catch (err) {
      const code = Number.isInteger(err && err.code) ? err.code : -32603;
      const message =
        err && err.message
          ? String(err.message)
          : `Internal error: ${err === undefined ? 'unknown' : String(err)}`;
      sendError(id, code, message);
    }
  };

  // 串行处理保证响应顺序;单条失败绝不拖垮 server
  let chain = Promise.resolve();
  return new Promise((resolve) => {
    rl.on('line', (line) => {
      chain = chain
        .then(() => handleLine(line))
        .catch((e) => console.error('[relay-rpc] handler crashed:', e));
    });
    rl.on('close', () => {
      chain.then(() => resolve());
    });
  });
};
