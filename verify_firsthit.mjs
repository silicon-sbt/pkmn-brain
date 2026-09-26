import { buildQuestion } from './harness.mjs';
const GH = { ability:'Good as Gold', item:'Choice Specs', nature:'Timid', evs:{spa:252,spe:252,hp:4},
  moves:['Make It Rain','Shadow Ball','Focus Blast','Recover'] };
const BR = { ability:'Technician', item:'Life Orb', nature:'Jolly', evs:{atk:252,spe:252,hp:4},
  moves:['Bullet Seed','Mach Punch'] };
const st = (atkSp, atkSet, oppSet, oppHp, mv) => {
  const q = buildQuestion({ turn: 5,
    me:{ active:{ species: atkSp, hpPercent: 100, set: atkSet }, bench:[] },
    opp:{ active:{ species:'Garganacl', hpPercent: oppHp }, revealed:['Garganacl'],
      revealedMoves:{ Garganacl:['Salt Cure','Recover','Iron Defense','Body Press'] },
      sets:{ Garganacl: oppSet } } });
  return q.questions.action.criteria['move:' + mv] || '(无此选项)';
};
const GAR = (ability, item) => ({ ability, item, nature:'Impish', evs:{hp:252,def:252} });
console.log('【结实 / 气势披带】淘金潮 vs 盐石巨灵');
console.log('  无机制 满血     : ' + st('Gholdengo',GH,GAR('Clear Body','Leftovers'),100,'makeitrain').slice(0,150));
console.log('  结实 满血       : ' + st('Gholdengo',GH,GAR('Sturdy','Leftovers'),100,'makeitrain').slice(0,150));
console.log('  结实 60%血      : ' + st('Gholdengo',GH,GAR('Sturdy','Leftovers'),60,'makeitrain').slice(0,150));
console.log('  披带 满血       : ' + st('Gholdengo',GH,GAR('Clear Body','Focus Sash'),100,'makeitrain').slice(0,150));
console.log('  披带(已消耗) 满血: ' + st('Gholdengo',GH,GAR('Clear Body','(已消耗) Focus Sash'),100,'makeitrain').slice(0,150));
console.log('\n【多重鳞片不能被二次减半】');
const r1 = buildQuestion({ turn:5, me:{active:{species:'Gholdengo',hpPercent:100,set:GH},bench:[]},
  opp:{active:{species:'Dragonite',hpPercent:100},revealed:['Dragonite'],
    revealedMoves:{Dragonite:['Extreme Speed']},sets:{Dragonite:{ability:'Multiscale',item:'Heavy-Duty Boots',nature:'Adamant',evs:{hp:252,atk:252}}}}} );
const f = r1.actions.find(a=>a.id==='move:shadowball');
console.log('  快龙 多重鳞片 暗影球: ' + f.pctLo.toFixed(0) + '-' + f.pctHi.toFixed(0) + '%  ' + f.verdict);
const r2 = buildQuestion({ turn:5, me:{active:{species:'Gholdengo',hpPercent:100,set:GH},bench:[]},
  opp:{active:{species:'Dragonite',hpPercent:100},revealed:['Dragonite'],
    revealedMoves:{Dragonite:['Extreme Speed']},sets:{Dragonite:{ability:'Inner Focus',item:'Heavy-Duty Boots',nature:'Adamant',evs:{hp:252,atk:252}}}}} );
const f2 = r2.actions.find(a=>a.id==='move:shadowball');
console.log('  快龙 无特性   暗影球: ' + f2.pctLo.toFixed(0) + '-' + f2.pctHi.toFixed(0) + '%  ' + f2.verdict);
console.log('  → 比值 ' + (f2.pctHi / f.pctHi).toFixed(2) + '（应为 2.00，若不是就是双重减半了）');
console.log('\n【多段招不该被留 1 血】');
console.log('  斗笠菇 种子机关枪 vs 结实盐石: ' + st('Breloom',BR,GAR('Sturdy','Leftovers'),100,'bulletseed').slice(0,160));
console.log('\n【画皮已破就不该再挡】');
for (const intact of [true, false]) {
  const q = buildQuestion({ turn:5, me:{active:{species:'Gholdengo',hpPercent:100,set:GH},bench:[]},
    opp:{active:{species:'Mimikyu',hpPercent:100},revealed:['Mimikyu'],
      revealedMoves:{Mimikyu:['Play Rough']},sets:{Mimikyu:{ability:'Disguise',item:'Life Orb',intact,...(intact?{}:{})}}}});
  const a = q.actions.find(x=>x.id==='move:makeitrain');
  console.log('  intact=' + intact + ': ' + (a.blockedBy || '(不再挡下)') + '  ' + a.verdict.slice(0,60));
}
