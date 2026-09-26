import { loadTeam, tpath } from './lib.mjs';
import * as sim from '@pkmn/sim';
const file = process.argv[2] || tpath('teams', 'ou-a.txt');
const fmt = process.argv[3] || 'gen9ou';
const team = loadTeam(file);
const v = sim.TeamValidator.get(fmt);
const probs = v ? v.validateTeam(team) : null;
console.log('格式:', fmt, '| 只数:', team.length);
if (!probs || !probs.length) console.log('✅ 校验通过');
else { console.log('❌ 问题 ' + probs.length + ' 条:'); probs.forEach(p => console.log('  - ' + p)); }
process.exit(0);
