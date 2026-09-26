# Pokémon battle "external brain" software ecosystem — verified 2026-09-18

**Method**: queried npm/PyPI/GitHub APIs live, then **actually installed and executed** the packages in `%TEMP%\psresearch` (Node v24.14.0). Battles were run end-to-end. Verification scripts left at `C:\Users\A\AppData\Local\Temp\psresearch\verify.mjs`, `dbg2.mjs`, `randai.mjs`, `dbg5.mjs`. System clock reads 2026-09-18, so "recent" below means 2026. Anything I could not execute or fetch is explicitly marked **UNVERIFIED**.

---

## 1. Pokémon Showdown as a library

### pokemon-showdown (npm) — canonical, and it ships a CLI
- **Install**: npm i pokemon-showdown
- **Version**: **0.11.11**, published **2026-07-28**. MIT. main: dist/sim/index.js, bin: ./pokemon-showdown, engines node>=16.
- **URL**: https://github.com/smogon/pokemon-showdown (5,899 stars, last commit **2026-09-17**, 327 open issues) · https://www.npmjs.com/package/pokemon-showdown (~3,723 dl/mo)
- **Verified exports** (ran it): Battle, BattleStream, Dex, PRNG, Pokemon, Side, TeamValidator, Teams, getPlayerStreams, toID, Dashycode, FS, Net, ProcessManager, Repl, SQL, Streams, Utils, crashlogger
- **CJS gotcha**: it is CommonJS. `import ps from 'pokemon-showdown'` works; `import {Teams} from 'pokemon-showdown'` **fails** in ESM. `import * as ps` yields only {default, module.exports}.
- **Offline**: 100%, ships raw data source **and** compiled data. Verified sizes in the installed package: data/pokedex.ts 525KB, data/moves.ts 473KB, **data/learnsets.ts 3,636KB**, data/abilities.ts 153KB, data/items.ts 160KB, data/typechart.ts 7KB, data/natures.ts 1KB. Also sim/battle.ts 114KB, sim/team-validator.ts 113KB.
- **Dex API verified**: `Dex.species.get('Pikachu')` → {types:['Electric'], baseStats:{hp:35,...spe:90}, tier:'ZU'}. `Dex.moves.get('Moonblast')` → {bp:95, type:'Fairy', cat:'Special', pp:15}. `Dex.species.all().length` = **1517**, `Dex.moves.all().length` = **954** (includes nonstandard/legacy). `Dex.formats.get('gen9ou')` works.
- **Learnset access — real gotcha**: `Dex.learnsets` is **undefined** and `Dex.species.getLearnset` is **not a function**. The working call is **`Dex.species.getLearnsetData('pikachu')`**, returning an object with a `.learnset` map keyed by move id (verified ~120 moves for Pikachu; values like '9M','9L36','8M' encode gen/method/level).

### pokemon-showdown CLI — verified working, an easy agent surface
Verified by running the installed binary. COMMANDLINE.md also ships offline at node_modules/pokemon-showdown/COMMANDLINE.md:
- `generate-team [FORMAT-ID] [SEED]` → packed team on stdout (**verified** with gen9randombattle)
- `validate-team [FORMAT-ID]` → reads stdin, **exit 0 valid / exit 1 invalid** (**verified both paths**; lv50 into gen9ou gave exactly "Pikachu is level 50, but this format allows level 100 Pokémon...")
- `simulate-battle` → stdin/stdout simulator (**verified**: fed >start/>player lines, got live protocol output)
- `pack-team` / `export-team` / `json-team` → conversions (**verified** both directions)
- `start [PORT]` → full PS server
- **Side effect**: first run prints "config.js does not exist. Creating one with default settings..." and writes a config file.

### The pkmn project (github.com/pkmn/ps — 150 stars, last commit 2026-06-18, MIT)
- **@pkmn/sim** — **0.10.11**, pub **2026-06-18**, ~7,322 dl/mo. "Automatically generated extraction of just the simulator portion of smogon/pokemon-showdown."
  - **Verified exports**: Battle, **BattleStreams**, Dex, PRNG, Pokemon, RandomPlayerAI, RuleTable, Side, State, Streams, Tags, TeamValidator, Teams, extractChannelMessages, toID
  - **Gotcha**: there is **no top-level BattleStream export**. It is `BattleStreams.BattleStream`; the BattleStreams namespace also bundles BattlePlayer, BattleTextStream, getPlayerStreams.
  - **RandomPlayerAI is built in** — I ran **40 complete gen9randombattle battles in 1,621 ms** (~40ms/battle). A ready-made Monte Carlo harness with no external bot code.
  - **Teams.parse is undefined.** Verified present instead: pack, unpack, import, validateSet, getTeam. (Matches your AGENTS.md 已知坑.)
  - `Teams.setGeneratorFactory(TeamGenerators)` (from @pkmn/randoms) enables `Teams.generate('gen9randombattle')` → verified, 6 mons.
  - `new TeamValidator('gen9ou').validateTeam(...)` verified: lv100 → 0 errors; lv50 → error. Note 'gen9vgc2025regg' threw "'gen9vgc2025regg' should be a 'Format', but was a 'Condition'" — that exact id is not a valid format string in this build.
  - Its own README says: "If you do not need typed and versioned module or do not require the ability to run the full blown simulator and/or validator code in the browser, **you will probably be better off vendoring smogon/pokemon-showdown**."
- **@pkmn/dex** — 0.10.11, pub 2026-06-18, ~12,293 dl/mo (most-downloaded pkmn package). Exports Ability, BasicEffect, Condition, Dex, Item, Learnset, ModdedDex, Move, Nature, Species, Type, toID. Data only, **no battle mechanics**.
- **@pkmn/data** — 0.10.11, pub 2026-06-18, ~6,803 dl/mo. Generation-scoped wrapper. `new Generations(pkmnDex.Dex)` then `gens.get(9)`.
  - **Verified**: `g9.species.get('Flutter Mane')` → {types:['Ghost','Fairy'], baseStats:{hp:55,spa:135,spd:135,spe:135}, abilities:{0:'Protosynthesis'}}; `g9.types.get('Fire').effectiveness` → full 19-type chart.
  - **Gotcha**: `g9.species.all()` is **not a function** — the generation-scoped collection's prototype only has get. Use pokemon-showdown's `Dex.species.all()` for enumeration.
  - **g9.learnsets.get('Pikachu') returned 0 entries** in my test — do not rely on it; use `Dex.species.getLearnsetData()`.
- **@pkmn/client** — 0.7.3, pub 2026-05-08, ~984 dl/mo (lowest usage). **Partially UNVERIFIED**: default-export keys are Battle, Field, NULL, Pokemon, Side — **no BattleStream**, so the documented import fails. I could not construct a client battle.
- **@pkmn/protocol** — 0.7.3, pub 2026-05-08, ~2,409 dl/mo. **UNVERIFIED / flag**: README documents `Protocol.parse(line)` returning typed objects, but in the installed CJS build `Protocol` exposed only {ARGS, ARGS_WITH_KWARGS} and `Protocol.parse('|move|...')` returned {}. Test before depending on it.
- **@pkmn/randoms** — 0.10.11, pub 2026-06-18, ~2,560 dl/mo. TeamGenerators verified working.
- Also: @pkmn/sets 5.2.0 (2025-07-28), @pkmn/img 0.3.4, @pkmn/view 0.7.3, @pkmn/types 4.0.0 (2023), @pkmn/mods 0.10.11, @pkmn/dex-types 0.10.11, @pkmn/streams 1.1.0 (2022).
- **@pkmn/engine** — **trap**: npm latest is 0.1.0-dev.207fa86a, published **2023-03-29** (stale dev tag, no stable release). The GitHub repo (github.com/pkmn/engine, 371 stars) was pushed **2026-09-02** and is active. Active repo, **no usable npm release**.

### Driving a battle headlessly — verified working recipe
```js
import ps from 'pokemon-showdown';                 // CJS default import
const {Teams, BattleStream} = ps;
const stream = new BattleStream();
const log = [];
(async () => { for await (const o of stream) log.push(o); })();

stream.write('>start {"formatid":"gen9customgame"}');
stream.write('>player p1 {"name":"Agent","team":"' + team1 + '"}');
stream.write('>player p2 {"name":"Foe","team":"'   + team2 + '"}');
await new Promise(r => setTimeout(r, 300));
stream.write('>p1 team 1');                        // REQUIRED: team preview
stream.write('>p2 team 1');
await new Promise(r => setTimeout(r, 300));
stream.write('>p1 move 1');                        // NOT "choose move 1"
stream.write('>p2 move 1');
```

**Two gotchas that cost several debugging rounds — worth adding to AGENTS.md 已知坑:**
1. **`>p1 choose move 1` FAILS** with `|error|[Invalid choice] Unrecognized choice: choose move 1`. The BattleStream wire format is **`>p1 move 1`** (no `choose`). `choose` belongs to the chat protocol, not the stream protocol.
2. **Team preview must be answered first.** Without `>p1 team 1` the battle sits at `|teampreview` forever and every later move command errors.

Verified full result (gen9customgame, Pikachu vs Charizard): 50 protocol lines ending |move|p2a: Charizard|Flamethrower|p1a: Pikachu → |-damage|p1a: Pikachu|0 fnt → |faint|p1a: Pikachu → |win|Foe. Zero errors.

**getPlayerStreams verified**: returns {omniscient, spectator, p1, p2}. Choices are written to the **player stream without the >p1 prefix** (`st.p1.write('move 1')`), and st.p1 receives that side's |request| JSON. All four streams verified producing a completed battle.

**Monte Carlo verified end-to-end** (@pkmn/sim + @pkmn/randoms):
```js
import {BattleStreams, RandomPlayerAI, Teams} from '@pkmn/sim';
import {TeamGenerators} from '@pkmn/randoms';
Teams.setGeneratorFactory(TeamGenerators);
const streams = BattleStreams.getPlayerStreams(new BattleStreams.BattleStream());
const p1 = new RandomPlayerAI(streams.p1), p2 = new RandomPlayerAI(streams.p2);
void p1.start(); void p2.start();
```
→ 40 battles with winners recorded, **1,621 ms total**.

---

## 2. Damage calculation: @smogon/calc

- **Install**: npm i @smogon/calc
- **Version**: **0.11.0**, published **2026-03-11**. MIT. ~7,738 dl/mo.
- **URL**: https://github.com/smogon/damage-calc (534 stars, last commit **2026-09-17** — the most actively maintained package in this report) · https://www.npmjs.com/package/@smogon/calc
- **Verified exports**: ABILITIES, Field, Generations, ITEMS, MEGA_STONES, MOVES, Move, NATURES, Pokemon, Result, SPECIES, STATS, Side, Stats, TYPE_CHART, calcStat, calculate, toID
- **Verified working programmatically**:
```js
import * as calc from '@smogon/calc';
const gen = calc.Generations.get(9);
const atk = new calc.Pokemon(gen, 'Pikachu', {item:'Light Ball', nature:'Timid', evs:{spa:252}, level:100});
const def = new calc.Pokemon(gen, 'Charizard', {nature:'Timid', level:100});
const res = calc.calculate(gen, atk, def, new calc.Move(gen, 'Thunderbolt'));
res.range();          // → [min, max] damage numbers
res.kochance().text;  // → e.g. "guaranteed OHKO"   (LOWERCASE method name)
```
- **Confirmed**: `kochance()` is lowercase (matches your AGENTS.md). Pokemon options also accept boosts, status, teraType; a Field object carries weather/terrain/screens.
- **Offline**: fully offline, bundles its own gen data.
- **Related**: @professorragna/pokemon-damage-calc-cli v0.2.2 (2026-06-19), bin **pkmn-calc**, "CLI for Pokémon damage calculations powered by @smogon/calc", repo github.com/jpbullalayao/pokemon-damage-calc-cli — **verified on npm, NOT executed**. Low maturity (0.x, single author).

---

## 3. Pokémon data sources

| Source | Verified status | Offline? |
|---|---|---|
| **PokeAPI REST v2** — https://pokeapi.co/api/v2/ | **HTTP 200**; /pokemon/pikachu = 290,912 bytes — verified live | No |
| **PokeAPI GraphQL** — **https://graphql.pokeapi.co/v1beta2** | **HTTP 200, verified live.** Query { pokemon(where:{name:{_eq:"pikachu"}}, limit:1){id name height weight} } → {"data":{"pokemon":[{"id":25,"name":"pikachu","height":4,"weight":60}]}} | No |
| **PokeAPI GraphQL docs** — https://pokeapi.co/docs/graphql | Page fetched, 8,934 bytes — reachable | No |
| **PokeAPI/api-data** — https://github.com/PokeAPI/api-data | "Static JSON data from the API, plus a JSON Schema" — confirmed via GitHub page title. **Direct raw fetch timed out on retry → partially verified.** | Yes (download once) |
| **Showdown data files** — data/pokedex.ts, moves.ts, **learnsets.ts**, abilities.ts, items.ts, typechart.ts | **Fully verified offline** in node_modules/pokemon-showdown/, exact sizes above | **Yes** |

**Recommendation**: for competitive battles Showdown's data beats PokeAPI. PokeAPI is a Pokédex — it has **no per-generation learnsets, no Showdown formats, no competitive tiers, no move priority/flag semantics**. Showdown's learnsets.ts (3.6 MB) plus Dex.formats is the only source that knows what is legal in gen9ou. Use PokeAPI only for lore/sprites.

---

## 4. MCP servers for Pokémon — thin, and mostly low-maturity

GitHub search returns 150–270 repos for "pokemon mcp", but the vast majority are ≤5-star student demos. **npm search for "showdown mcp" returns nothing relevant** (dominated by the unrelated `showdown` Markdown library). Everything that actually exists:

**Battle-advisor / battle-playing (the relevant ones):**

| Name | Install | What it does | Maturity |
|---|---|---|---|
| **nonz250/ai-rotom** | npx @nonz250/ai-rotom (npm **v1.3.1**, pub **2026-09-15**) | "**Pokemon Champions battle advisor** MCP server". TS, MIT. Repo has CLAUDE.md, vitest, monorepo layout. | **19 stars, created 2026-04-15, last commit 2026-09-15. Best-maintained battle MCP found.** |
| **shaumik/PokeArena** | build from source (Go) | "An MCP server that lets LLM agents play Pokémon battles." | 4 stars, created 2026-05-22, last commit **2026-09-06**. **License NOASSERTION — non-standard, check before use.** |
| **dtsong/smogon-vgc-mcp** | Python, from source | "MCP server providing VGC competitive Pokémon stats, damage calculations, and teambuilding tools to LLMs" | 2 stars, pushed **2026-04-23** |
| **ychen022/VGCHelper** | TS, from source | "**Local MCP tools for Pokémon Champions VGC doubles replay coaching and team evaluation**" | 1 star, pushed **2026-09-15** |
| **drewsungg/mcpkmn-showdown** | Python, from source (**not on npm**) | "Pokémon Showdown MCP Server — Pokémon data lookup tools for LLMs" | 5 stars, pushed **2026-02-23** |

**Damage-calc MCPs:**

| Name | Install | Maturity |
|---|---|---|
| **jpbullalayao/pokemon-vgc-calc-mcp** | npx pokemon-vgc-calc-mcp (npm **v0.1.0**, pub **2025-06-08**) | "Pokémon damage calculator MCP server using smogon/damage-calc". 1 star, pushed 2025-06-11. **Very early (0.1.0).** |

**PokéAPI-wrapping MCPs (data lookup only, no battle logic):**

| Name | Install | Maturity |
|---|---|---|
| **Asthanaji05/MCP_Pokemon** | npx pokeapi-mcp-server (**v1.12.0**, pub **2025-11-02**) | "47 Pokémon-related endpoints". 1 star |
| **cyanheads/pokeapi-mcp-server** | npx @cyanheads/pokeapi-mcp-server (**v0.1.8**, pub **2026-08-24**) | Apache-2.0, TS, STDIO or Streamable HTTP. 1 star. Cleanest packaging of the bunch. |
| **njayp/poke-mcp** | npx pokemon-mcp-server (**v1.0.0**, pub **2025-09-09**) | bin also pokemon-mcp |
| Astro2024/pokeapi-mcp-server, ShimaCoding/mcp-pokemon-server, ChiragAgg5k/poke-mcp, kaishin/poke-mcp, Zenith-Mind/pokemon-mcp, grovesjosephn/pokemcp, Sachin-crypto/Pokemon-MCP-Server | source | 2–30 stars, 2025–2026, mostly demos |

**Adjacent (not mainline battles):** lexfrei/pogo-pvp-mcp (Go, 1 star, pushed 2026-09-16, Pokémon GO PvP, 22 tools), GhostTypes/pokemon-go-mcp (8 stars), jlgrimes/ptcg-mcp (12 stars, TCG cards), skygazer42/pokemon-chat (408 stars but a LightRAG chat assistant, not competitive).

**Bottom line**: **there is no battle-tested, widely-adopted MCP server for competitive Pokémon.** The median is ~1–5 stars and single-author. ai-rotom is the only one with real momentum, and it targets "Pokémon Champions" (a new mobile game), not Showdown/VGC gen 9. **Building a thin MCP wrapper over @pkmn/sim + @smogon/calc is less risky than adopting any of these** — which is what your project already does.

---

## 5. Replay API + battle protocol

- **Replay search** — https://replay.pokemonshowdown.com/search.json?limit=3 → **verified, 51 results**. Fields: uploadtime, id, format, players[], rating. **`limit` appears ignored** (returned 51 for limit=3 and for format=gen9ou).
- **Replay log** — https://replay.pokemonshowdown.com/<id>.log → **verified**, 6,788 bytes of raw PS protocol for gen9ou-2683541140. Same line format the simulator emits, so one parser covers live and historical battles.
- **Replay JSON** — https://replay.pokemonshowdown.com/<id>.json — **UNVERIFIED** (script crashed on an unrelated PowerShell call before printing it).
- **PROTOCOL.md** — verified at **https://raw.githubusercontent.com/smogon/pokemon-showdown/master/PROTOCOL.md** (16,804 bytes) **and bundled offline** at node_modules/pokemon-showdown/PROTOCOL.md. Sections: Room initialization, Room messages, Global messages, Tournament messages, **Playing battles**, **Starting battles through challenges**, **Starting battles through laddering**, **Team format**.
- **SIM-PROTOCOL.md** — **UNVERIFIED**: referenced by @pkmn/sim's README and by simulate-battle help as sim/SIM-PROTOCOL.md, but my fetches for that path **404'd / timed out**. Not at repo root. Treat the exact URL as unconfirmed.
- **COMMANDLINE.md** — verified **offline** at node_modules/pokemon-showdown/COMMANDLINE.md (4KB). Also ARCHITECTURE.md (3KB), CONTRIBUTING.md (19KB).
- **Client Web API** — github.com/smogon/pokemon-showdown-client/blob/master/WEB-API.md (found via search, **not fetched**).
- **Verified live protocol line shapes** (for writing a parser): |gametype|singles, |player|p1|Agent||, |poke|p1|Pikachu, F|, |teampreview, |switch|p1a: Pikachu|Pikachu, F|211/211, |turn|1, |move|p2a: Charizard|Flamethrower|p1a: Pikachu, |-damage|p1a: Pikachu|0 fnt, |faint|p1a: Pikachu, |win|Foe, |request|{...json...} (delivered inside a sideupdate block), |error|[Invalid choice] ...

---

## 6. Battle-assistant / team-analysis CLIs (incl. Chinese)

**Mature bot frameworks:**

| Name | Install | Notes |
|---|---|---|
| **poke-env** (hsahovic) | pip install poke-env — **PyPI v0.16.1**, Python >=3.10 | "A python interface for training Reinforcement Learning bots to battle on pokemon showdown." **GitHub 515 stars, pushed 2026-09-11.** By far the most mature battle-bot framework. Drives a live PS server (or a local one). https://github.com/hsahovic/poke-env |
| **pmariglia/poke-engine** | Rust, from source | "A Pokémon battle engine that can search through Pokemon states." **51 stars, pushed 2026-09-12**, very active. Used by strong search-based Showdown bots. |

**Stale / deprecated:**
- dramamine/leftovers-again — JS, 77 stars, last push **2021-02-27**
- rameshvarun/showdownbot — JS, 71 stars, last push **2023-04-22**
- AgustinSRG/Pokemon-Showdown-Node-Bot — 36 stars, 2023-04-14, **author-marked "Deprecated"**
- pokeml/pokemon-env — NodeJS battle env, 7 stars, last push **2019**

**Team-analysis / UI tools:**
- **Showdex** — browser extension, Chrome Web Store id dabpnahpcemkfbgfbmegmncjllieilai. Damage calc + dex overlay inside Showdown. Listing verified; client-side, **not a scriptable library**.
- ridoy/pokemon-showdown-god-mode — "Automatic damage calculation plugin for Pokemon Showdown" (via search, **UNVERIFIED**)
- 1mht/poke-ai-combat-lab, akira399/poke-rag (RAG over PokeAPI/Showdown/Smogon data, unverified), Ricardouchub/pokemonshowdown-random-battle-ai-agent (LLM+classical hybrid agent, unverified)
- **PokéChamp** — ICML 2025 paper on an LLM minimax battle agent (Proceedings of the 42nd ICML). Academic; **repo/code UNVERIFIED**.

**Chinese-language tools (宝可梦对战助手 / 伤害计算器) — honest answer: I found essentially nothing usable.**
- I searched GitHub and the web in Chinese for battle assistants and damage calculators. Results were **NGA forum threads** (ngabbs.com) that surfaced but which I could not confirm as software, and **skygazer42/pokemon-chat** (408 stars) — "基于 LightRAG、LangGraph、MCP、RagFlow、微调LLMs宝可梦主题的智能聊天助手" — a **Pokémon-themed chat/RAG assistant, not a competitive battle or damage tool**.
- **No maintained, installable Chinese-language competitive battle CLI was verified.** Chinese players appear to use the upstream English tools (Showdown, @smogon/calc, Showdex). If a Chinese damage calculator exists, it lives behind WeChat/QQ mini-programs or forum spreadsheets, **not in any package registry I could query**.

---

## Recommended stack

For an AI coding agent acting as a **local, offline, verifiable** battle brain, the ecosystem already contains everything needed — no MCP server is required, and adopting one would add risk without adding capability.

**Core (all offline, all verified working):**
1. **@pkmn/sim** — headless engine + BattleStreams.getPlayerStreams + built-in RandomPlayerAI for Monte Carlo (~40ms/battle).
2. **@pkmn/randoms** — TeamGenerators for random-battle simulation.
3. **@pkmn/dex** (or pokemon-showdown's Dex) — data layer. Use `Dex.species.getLearnsetData()` for learnsets.
4. **@smogon/calc** — damage/KO/speed lines. Remember `res.kochance()` is lowercase.
5. **pokemon-showdown CLI** — free validation and team conversion for shell-level tooling (`validate-team` exit codes are ideal for agents).

**Add only if you need it:**
- **@pkmn/data** — clean generation-scoped lookups (`gens.get(9)`). Beware `.all()` and `.learnsets.get()`.
- **Replay API** — replay.pokemonshowdown.com/search.json + <id>.log for mining real games; same protocol format as the simulator, so one parser serves both.
- **poke-env** — only for laddering on the live Showdown server or RL training. The mature option there, but needs a running server and is Python.

**Deliberately skip:**
- **All existing Pokémon MCP servers.** Median ~1–5 stars, single-author, none targets gen-9 Showdown/VGC with real depth. Your own tools/pkmn.mjs already covers more ground than any of them.
- **@pkmn/engine** — active repo, but the only npm tag is a 2023 dev build. No stable release.
- **@pkmn/client / @pkmn/protocol** — low usage, and I could not confirm their documented APIs work in the installed build. Do not build a dependency without a spike.
- **PokeAPI** — a Pokédex, not a competitive ruleset. No learnsets, tiers, formats, or move flags.

**Suggested provenance rule** (consistent with your 核心原则): every number in an answer should trace to an @pkmn/dex lookup, an @smogon/calc call, or a @pkmn/sim battle result — never to model memory. The offline Showdown data files make that fully auditable without network access.

---

### Gaps / could not verify
- @pkmn/protocol `Protocol.parse` runtime shape (returned {})
- @pkmn/client battle construction (no BattleStream on default export)
- sim/SIM-PROTOCOL.md URL (404/timeout on every attempt)
- Replay <id>.json endpoint
- PokeAPI/api-data README (fetch timed out; existence confirmed only via GitHub page title)
- poke-env, poke-engine, and the VGC MCP repos were characterized from GitHub **search-result metadata only** — the GitHub REST API began returning 403 (rate limit) partway through, so I could not fetch their READMEs. Star counts and pushed_at dates above come from successful search calls.
- No Chinese competitive battle CLI found — a negative result from repeated searching, not a confirmed absence.