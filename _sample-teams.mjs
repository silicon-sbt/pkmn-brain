// 自检脚本用的内置样板队伍。
//
// 为什么内联：队伍文件（toolkit/teams/*.txt）**不进公开仓库**（那边 .gitignore 掉了），
// 所以别人克隆下来跑自检会找不到队伍文件。这里放两份样板兜底 —— 克隆下来即可直接跑自检。
// 有真的队伍文件时优先用真的（`loadTeamOr` 会自己判断）。
//
// 这些配置不是随便写的：ou-c 与 Smogon 使用率最高配置逐字段一致，ou-a 同理。
import { existsSync, readFileSync } from 'node:fs';
import { parseImportable } from './toolkit/tools/lib.mjs';

export const SAMPLE = {
  'ou-a': [
    'Glimmora @ Focus Sash', 'Ability: Toxic Debris', 'Level: 100', 'Tera Type: Ghost',
    'EVs: 252 SpA / 4 SpD / 252 Spe', 'Timid Nature',
    '- Stealth Rock', '- Mortal Spin', '- Power Gem', '- Earth Power', '',
    'Gholdengo @ Air Balloon', 'Ability: Good as Gold', 'Level: 100', 'Tera Type: Flying',
    'EVs: 252 SpA / 4 SpD / 252 Spe', 'Timid Nature',
    '- Make It Rain', '- Shadow Ball', '- Nasty Plot', '- Recover', '',
    'Great Tusk @ Leftovers', 'Ability: Protosynthesis', 'Level: 100', 'Tera Type: Steel',
    'EVs: 252 HP / 252 Def / 4 Spe', 'Impish Nature',
    '- Headlong Rush', '- Rapid Spin', '- Ice Spinner', '- Knock Off', '',
    'Kingambit @ Black Glasses', 'Ability: Supreme Overlord', 'Level: 100', 'Tera Type: Flying',
    'EVs: 252 Atk / 4 Def / 252 Spe', 'Adamant Nature',
    '- Sucker Punch', '- Kowtow Cleave', '- Swords Dance', '- Iron Head', '',
    'Dragapult @ Choice Specs', 'Ability: Infiltrator', 'Level: 100', 'Tera Type: Ghost',
    'EVs: 252 SpA / 4 SpD / 252 Spe', 'Timid Nature',
    '- Shadow Ball', '- Draco Meteor', '- U-turn', '- Fire Blast', '',
    'Slowking-Galar @ Assault Vest', 'Ability: Regenerator', 'Level: 100', 'Tera Type: Water',
    'EVs: 252 HP / 4 Def / 252 SpD', 'Calm Nature',
    '- Future Sight', '- Sludge Bomb', '- Ice Beam', '- Flamethrower',
  ].join('\n'),
  'ou-c': [
    'Landorus-Therian @ Rocky Helmet', 'Ability: Intimidate', 'Level: 100',
    'EVs: 252 Atk / 4 SpD / 252 Spe', 'Jolly Nature',
    '- U-turn', '- Earthquake', '- Stealth Rock', '- Taunt', '',
    'Iron Treads @ Booster Energy', 'Ability: Quark Drive', 'Level: 100',
    'EVs: 252 Atk / 4 SpD / 252 Spe', 'Jolly Nature',
    '- Rapid Spin', '- Earthquake', '- Stealth Rock', '- Knock Off', '',
    'Ogerpon-Wellspring @ Wellspring Mask', 'Ability: Water Absorb', 'Level: 100',
    'EVs: 252 Atk / 4 SpD / 252 Spe', 'Jolly Nature',
    '- Ivy Cudgel', '- Swords Dance', '- Knock Off', '- Horn Leech', '',
    'Zamazenta @ Leftovers', 'Ability: Dauntless Shield', 'Level: 100',
    'EVs: 252 Atk / 4 SpD / 252 Spe', 'Jolly Nature',
    '- Crunch', '- Body Press', '- Iron Defense', '- Close Combat', '',
    'Kyurem @ Choice Specs', 'Ability: Pressure', 'Level: 100',
    'EVs: 252 SpA / 4 SpD / 252 Spe', 'Timid Nature',
    '- Earth Power', '- Freeze-Dry', '- Ice Beam', '- Draco Meteor', '',
    'Hatterene @ Leftovers', 'Ability: Magic Bounce', 'Level: 100',
    'EVs: 252 HP / 204 Def / 52 Spe', 'Bold Nature',
    '- Draining Kiss', '- Psychic Noise', '- Nuzzle', '- Mystical Fire',
  ].join('\n'),
  // 伤害/乱数对拍要一个「第 6 位是吃吼霸」的对手（脚本里用的是 switch 6）
  'dondozo-6': [
    'Garganacl @ Leftovers', 'Ability: Purifying Salt', 'Level: 100', 'Tera Type: Water',
    'EVs: 252 HP / 4 Def / 252 SpD', 'Careful Nature',
    '- Salt Cure', '- Recover', '- Iron Defense', '- Body Press', '',
    'Corviknight @ Leftovers', 'Ability: Pressure', 'Level: 100',
    'EVs: 248 HP / 252 Def / 8 SpD', 'Impish Nature',
    '- Brave Bird', '- Body Press', '- Roost', '- Iron Defense', '',
    'Great Tusk @ Leftovers', 'Ability: Protosynthesis', 'Level: 100',
    'EVs: 252 HP / 252 Def / 4 Spe', 'Impish Nature',
    '- Headlong Rush', '- Rapid Spin', '- Ice Spinner', '- Knock Off', '',
    'Ting-Lu @ Leftovers', 'Ability: Vessel of Ruin', 'Level: 100',
    'EVs: 252 HP / 4 Def / 252 SpD', 'Careful Nature',
    '- Earthquake', '- Ruination', '- Stealth Rock', '- Whirlwind', '',
    'Clodsire @ Leftovers', 'Ability: Unaware', 'Level: 100',
    'EVs: 248 HP / 8 Def / 252 SpD', 'Careful Nature',
    '- Earthquake', '- Recover', '- Toxic', '- Stealth Rock', '',
    'Dondozo @ Leftovers', 'Ability: Unaware', 'Level: 100',
    'EVs: 252 HP / 252 Def / 4 SpD', 'Impish Nature',
    '- Wave Crash', '- Rest', '- Sleep Talk', '- Curse',
  ].join('\n'),
};

// 有真文件就用真文件；没有就用内置样板，并【明说】用了样板。
export function loadTeamOr(file, which) {
  if (existsSync(file)) return parseImportable(readFileSync(file, 'utf8'));
  if (!SAMPLE[which]) throw new Error('没有内置样板: ' + which);
  console.log('[提示] 找不到 ' + file + '（队伍文件不进公开仓库）—— 改用内置样板 ' + which);
  return parseImportable(SAMPLE[which]);
}
