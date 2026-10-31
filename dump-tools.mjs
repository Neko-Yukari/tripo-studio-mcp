import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import readline from 'node:readline';

const child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
const rl = readline.createInterface({ input: child.stdout });
const pending = new Map();
let id = 1;
const call = (method, params) => new Promise((res) => { pending.set(id, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }) + '\n'); });
rl.on('line', (l) => { try { const m = JSON.parse(l); pending.get(m.id)?.(m); } catch {} });

await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
const list = await call('tools/list', {});
for (const t of list.result.tools) {
  console.log(`\n## ${t.name}\n${t.description.slice(0, 110)}`);
  console.log('  params:', Object.keys(t.inputSchema.properties).join(', '));
}
child.kill();
