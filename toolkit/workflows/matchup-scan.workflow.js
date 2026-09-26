// 工作流模板：对手队伍并行扫描
// 用法：把这个文件的内容作为 workflow 工具的 script 参数传入（meta 单独传）。
// 作用：对对手每一只宝可梦开一个子智能体，并行算出"我方谁能打它、它威胁我方谁"，
//       最后汇总成一张对位表。适合赛前准备。
//
// 依赖：子智能体在 E:\宝可梦 目录下运行，可调用 tools/pkmn.mjs 和 teams/ 里的队伍文件。

const MY_TEAM = 'teams/me.txt';
const OPP_TEAM = 'teams/opp.txt';

phase('读取双方队伍');
const oppList = await agent(
  `读取 ${OPP_TEAM}，用 node tools/pkmn.mjs set ${OPP_TEAM} 解析。
   只输出一个 JSON 数组，每项是宝可梦的英文官方物种名，例如 ["Garchomp","Flutter Mane"]。不要输出别的内容。`,
  { schema: { type: 'object', properties: { species: { type: 'array', items: { type: 'string' } } }, required: ['species'], additionalProperties: false } }
);

if (!oppList) return { error: '读取对手队伍失败' };

phase('逐只对位分析');
const rows = await pipeline(
  oppList.species,
  async (_prev, species) => agent(
    `你是宝可梦对战分析员，工作目录 E:\\宝可梦。
     目标：分析对手的 ${species} 对上我方队伍 ${MY_TEAM} 的情况。
     必须真的调用工具，不许凭记忆编造数字：
       1. node tools/pkmn.mjs dex "${species}" 拿它的属性和种族值
       2. 对它的每个本系招式，用 node tools/pkmn.mjs calc --attacker-file ${OPP_TEAM} --defender-file ${MY_TEAM} --move "<招式名>" ...
          注意 --attacker-file 只取文件里第一只，所以必要时把该只单独写成一个临时配置再算
       3. node tools/pkmn.mjs speed 确认关键速度对位
     输出 JSON：
       { "opponent": "${species}", "threatens": ["我方哪只、被什么招式、几确"],
         "answeredBy": ["我方哪只、用什么招式、几确"], "needsSetup": "需要什么条件才能处理",
         "assumptions": "你对对手配置的假设" }
     只写算过的数；没算的写"未验证"。`,
    { schema: { type: 'object', properties: {
        opponent: { type: 'string' },
        threatens: { type: 'array', items: { type: 'string' } },
        answeredBy: { type: 'array', items: { type: 'string' } },
        needsSetup: { type: 'string' },
        assumptions: { type: 'string' } },
      required: ['opponent', 'threatens', 'answeredBy'], additionalProperties: false } }
  )
);

phase('汇总');
const valid = rows.filter(Boolean);
const report = await agent(
  `下面是针对对手队伍逐只的对位分析结果（JSON）：\n${JSON.stringify(valid, null, 2)}\n\n
   请汇总成一份中文赛前报告，包含：
   1) 我方最该提防的 2-3 只，及原因（附具体伤害数字）
   2) 我方每只宝可梦的合理任务
   3) 建议首发与第一回合
   4) 所有不确定项与假设
   不要编造任何未出现在上面的数字。`
);
return { perOpponent: valid, report };
