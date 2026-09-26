// 最小 MCP stdio 握手测试：initialize -> tools/list -> tools/call
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// ★ 服务器路径按【本文件位置】解析，不依赖 cwd —— 目录重组后写死的 'mcp/pokemon-server.mjs' 会找不到。
const SRV = fileURLToPath(new URL('./pokemon-server.mjs', import.meta.url));
const srv = spawn(process.execPath, [SRV], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const pending = new Map();
srv.stdout.on('data', d => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { const msg = JSON.parse(line); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } } catch {}
  }
});
srv.stderr.on('data', d => console.error('[server stderr]', d.toString().trim()));
let id = 0;
const call = (method, params) => new Promise((res, rej) => {
  const myId = ++id; pending.set(myId, res);
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error('timeout ' + method)); } }, 30000);
});
const notify = (method, params) => srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
console.log('INIT:', JSON.stringify(init.result && init.result.serverInfo));
notify('notifications/initialized', {});

const list = await call('tools/list', {});
console.log('TOOLS:', list.result.tools.map(t => t.name).join(', '));

const r1 = await call('tools/call', { name: 'calc', arguments: {
  attacker: 'Garchomp @ Life Orb\nAbility: Rough Skin\nLevel: 50\nEVs: 252 Atk / 4 SpD / 252 Spe\nJolly Nature\n- Earthquake',
  defender: 'Flutter Mane',
  move: 'Earthquake' } });
console.log('CALC:', r1.result.content[0].text.replace(/\s+/g, ' ').slice(0, 300));

const r2 = await call('tools/call', { name: 'dex', arguments: { species: 'Flutter Mane' } });
console.log('DEX:', r2.result.content[0].text.replace(/\s+/g, ' ').slice(0, 200));

const r3 = await call('tools/call', { name: 'sim', arguments: {
  team1: 'Garchomp @ Life Orb\nAbility: Rough Skin\nLevel: 100\nEVs: 252 Atk / 252 Spe\nJolly Nature\n- Earthquake',
  team2: 'Heatran @ Leftovers\nAbility: Flash Fire\nLevel: 100\nEVs: 252 HP / 252 SpD\nCalm Nature\n- Lava Plume',
  n: 20 } });
console.log('SIM:', r3.result.content[0].text.replace(/\s+/g, ' ').slice(0, 300));

const r4 = await call('tools/call', { name: 'speed', arguments: { p1: 'Garchomp', p2: 'Flutter Mane', scarf: ['p1'] } });
console.log('SPEED:', r4.result.content[0].text.replace(/\s+/g, ' ').slice(0, 250));

const r5 = await call('tools/call', { name: 'ability', arguments: { ability: '威吓' } });
console.log('ABILITY:', r5.result.content[0].text.replace(/\s+/g, ' ').slice(0, 260));

const r6 = await call('tools/call', { name: 'item', arguments: { item: '剩饭' } });
console.log('ITEM:', r6.result.content[0].text.replace(/\s+/g, ' ').slice(0, 220));

srv.kill();
process.exit(0);
