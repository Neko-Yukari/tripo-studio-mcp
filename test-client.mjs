// 最小 MCP 客户端：拉起 server.mjs，握手、列工具、可选调用一个工具
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import readline from 'node:readline';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs');
const [toolName, argsJson] = process.argv.slice(2);

const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
const rl = readline.createInterface({ input: child.stdout });

const pending = new Map();
let nextId = 1;
function call(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});

(async () => {
  const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  console.log('initialize:', JSON.stringify(init.result?.serverInfo));
  const list = await call('tools/list', {});
  console.log('tools:', list.result.tools.map((t) => t.name).join(', '));
  if (toolName) {
    const t0 = Date.now();
    const res = await call('tools/call', { name: toolName, arguments: argsJson ? JSON.parse(argsJson) : {} });
    console.log(`\n[${toolName}] ${(Date.now() - t0) / 1000}s ->`, res.result?.content?.[0]?.text || JSON.stringify(res).slice(0, 500));
  }
  child.kill();
  process.exit(0);
})();
