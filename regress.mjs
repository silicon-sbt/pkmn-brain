import * as sim from '@pkmn/sim';
import { decide } from './serve.mjs';
const { Battle, Teams } = sim;
const mine = [
  'Landorus-Therian @ Choice Scarf','Ability: Intimidate','Level: 100','Tera Type: Steel',
  '- Earthquake','- U-turn','- Stealth Rock','- Stone Edge','',
  'Gholdengo @ Air Balloon','Ability: Good as Gold','Level: 100','Tera Type: Steel',
  '- Make It Rain','- Shadow Ball','- Focus Blast','- Recover','',
  'Great Tusk @ Leftovers','Ability: Protosynthesis','Level: 100','Tera Type: Ground',
  '- Swords Dance','- Headlong Rush','- Ice Spinner','- Knock Off',
].join('\n');
const theirs = 'Garganacl\nAbility: Purifying Salt\nLevel: 100\nItem: Leftovers\n- Salt Cure\n- Recover\n- Iron Defense\n- Body Press'
  + '\n\nCorviknight\nAbility: Pressure\nLevel: 100\nItem: Leftovers\n- Brave Bird\n- Body Press\n- Roost\n- Iron Defense';
const b = new Battle({formatid:'gen9ou', seed:[3,1,4,1]});
b.setPlayer('p1', {team: Teams.pack(Teams.import(mine))});
b.setPlayer('p2', {team: Teams.pack(Teams.import(theirs))});
const snap = () => b.sides[0].activeRequest ? JSON.parse(JSON.stringify(b.sides[0].activeRequest)) : null;

// ① 选人
let req = snap();
let out = await decide({ log: b.log.join('\n'), me: 'p1', request: req });
console.log('① 选人     → ' + out.phase + ' 先发=' + out.nameZh + ' 队伍来源=' + (out.teamSource||'').slice(0,40));

b.makeChoices('team 12','team 12');
// ② 普通出招（第 1 回合，还没锁招）
req = snap();
out = await decide({ log: b.log.join('\n'), me: 'p1', request: req });
console.log('② 出招     → 点 ' + (out.nameZh||out.name) + ' 候选=' + out.allOptions.length + ' 换人判断=' + JSON.stringify(out.oppSwitch) + ' 太晶=' + out.useTera);
b.makeChoices('move 1','move 1');
// ③ 锁招（用了地震之后）
req = snap();
if (req && req.active) {
  out = await decide({ log: b.log.join('\n'), me: 'p1', request: req });
  console.log('③ 锁招     → 点 ' + (out.nameZh||out.name) + ' locked=' + JSON.stringify(out.locked));
  b.makeChoices('move 1','move 1');
}
// ④ 强制换人
let guard = 0;
while (!b.ended && guard++ < 40) {
  req = snap(); if (!req) break;
  if (Array.isArray(req.forceSwitch) && req.forceSwitch.some(Boolean) && !req.active) {
    out = await decide({ log: b.log.join('\n'), me: 'p1', request: req });
    console.log('④ 强制换人 → ' + out.phase + ' 换=' + out.nameZh + ' | ' + (out.verdict||''));
    console.log('   候选: ' + out.allOptions.map(o=>o.id).join(', '));
    console.log('   ✅ 没有 move: 开头的非法选项 = ' + !out.allOptions.some(o=>o.id.startsWith('move:')));
    break;
  }
  b.makeChoices();
}
