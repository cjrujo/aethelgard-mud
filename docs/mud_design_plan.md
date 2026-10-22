# Phase 1 Architecture & World Design Specification
## Project: Aethelgard: Chronicles of the Shattered Rift (Browser Open-World MUD)
- **Run ID**: `mud-run-20261021-01`
- **Goal Version**: `1`
- **Revision Budget (`N`)**: `69`

---

## 1. System Architecture & Single-File Sandbox Design

The game is architected as a self-contained, zero-dependency browser application (`open_world_mud.html`) designed for immediate execution inside a sandboxed Canvas iframe (`system:web-app-generation` compliant).

### 1.1 Core Modules (In-Memory State + Persistence)
1. **`WorldGraph` Engine**:
   - 32 interconnected rooms across 5 biomes with bidirectional and vertical (`u`/`d`) links, hazard flags, harvestable resource nodes, crafting stations, and ambient flavor generators.
   - BFS pathfinding & reachability verifier ensuring 100% of rooms are reachable from `r_town_square` and providing shortest-path navigation hints.
2. **`GameState` & Persistence Manager**:
   - Deterministic central store holding `player`, `world`, `quests`, `bounties`, `achievements`, `combat`, `settings`, and `stats`.
   - `try/catch`-wrapped `localStorage` autosave (`aethelgard_mud_save_v1`) plus in-page modal **Export/Import Save JSON** so players can back up or transfer characters even in restricted iframes.
3. **`CommandParser` & Hybrid UI Controller**:
   - Full mud-style natural command parser supporting verb aliases (`n/north`, `s/south`, `e/east`, `w/west`, `u/up`, `d/down`, `l/look`, `x/examine`, `k/attack/kill`, `cast/skill`, `flee/run`, `get/take`, `drop`, `eq/equip`, `unequip`, `use/quaff/eat`, `mine/harvest/gather`, `craft/forge`, `buy`, `sell`, `talk/ask`, `quest/quests`, `bounty`, `rest/sleep`, `stance`, `alloc/stat`, `talent`, `rift`, `save`, `load`, `export`, `import`, `help/?`, `clear`).
   - Command history (`ArrowUp` / `ArrowDown`) and `Tab` auto-completion matching contextual targets (exits, room mobs, NPCs, items, skills).
   - Synchronized 1-click UI controls: every room exit, NPC, mob, ground item, and harvest node renders interactive chips directly below the narrative feed and in the side panels.
4. **`Heartbeat` & Tactical Combat Loop**:
   - 2.5-second world tick (with toggleable speed: `Normal 2.5s`, `Fast 1.2s`, or `Turn-Only`) driving HP/MP/Stamina regeneration, Day/Night & Weather cycles (`Dawn`, `Day`, `Dusk`, `Midnight`; `Clear`, `Mist`, `Arcane Storm`, `Blood Moon`), resource respawns, and ambient world events.
   - Real-time tactical round combat with active skill cooldowns, combat stances (`Balanced`, `Aggressive`, `Defensive`), status effects (`Stun`, `Bleed`, `Burn`, `Shield`, `Regen`), and boss phase mechanics.
5. **`SynthAudio` Engine**:
   - Pure Web Audio API procedural synthesizer (zero external audio files) generating distinct waveforms for footsteps, melee slashes, arcane blasts, critical hits, loot chimes, level-up fanfares, quest completion chords, and danger alerts.

---

## 2. World Graph Specification (32 Rooms Across 5 Biomes)

| Room ID | Room Title | Biome | Danger Lvl | Connected Exits | Key NPCs / Mobs / Nodes / Stations |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `r_town_square` | Oakhaven Town Square | Oakhaven Sanctuary | Safe (0) | N:`r_north_gate`, E:`r_blacksmith`, W:`r_alchemist`, S:`r_tavern`, U:`r_guild_hall` | Elder Thorne (Quest Giver), Well of Renewal |
| `r_blacksmith` | Ironheart Smithy | Oakhaven Sanctuary | Safe (0) | W:`r_town_square` | Forgemaster Brom (Merchant & Quest), Anvil Forge Station |
| `r_alchemist` | Moonpetal Apothecary | Oakhaven Sanctuary | Safe (0) | E:`r_town_square` | Alchemist Lyra (Merchant & Quest), Alchemy Lab Station |
| `r_guild_hall` | Adventurers' Guild Hall | Oakhaven Sanctuary | Safe (0) | D:`r_town_square` | Commander Vance (Bounties & Quests), War Table |
| `r_tavern` | The Gilded Griffin Tavern | Oakhaven Sanctuary | Safe (0) | N:`r_town_square` | Innkeeper Mara (Rest/Heal), Rumor Broker |
| `r_north_gate` | Oakhaven Northern Watchgate | Oakhaven Sanctuary | Safe (0) | S:`r_town_square`, N:`r_wilds_trail` | Watch Captain Sorin |
| `r_wilds_trail` | Mossy Forest Trail | Whispering Wilds | Lvl 1 | S:`r_north_gate`, N:`r_hunter_camp`, E:`r_old_mill`, W:`r_mushroom_grove` | Mob: Briar Wolf, Moss Goblin; Node: Moonpetal Herb |
| `r_old_mill` | Abandoned Watermill | Whispering Wilds | Lvl 1-2 | W:`r_wilds_trail`, E:`r_river_ford` | Mob: Rabid Gnoll, Mill Bandit; Node: Copper Vein |
| `r_mushroom_grove` | Bioluminescent Spore Grove | Whispering Wilds | Lvl 2 | E:`r_wilds_trail`, N:`r_ancient_menhir` | Mob: Sporeling Mystic, Venomfang Spider; Node: Luminous Cap |
| `r_hunter_camp` | Ranger's Outpost | Whispering Wilds | Lvl 2 | S:`r_wilds_trail`, N:`r_bandit_stronghold`, W:`r_ancient_menhir` | NPC: Scout Elara (Quest/Trader); Campfire Rest |
| `r_ancient_menhir` | Circle of Standing Stones | Whispering Wilds | Lvl 2-3 | S:`r_mushroom_grove`, E:`r_hunter_camp` | Mob: Corrupted Treant; Node: Leyline Rune-Stone |
| `r_river_ford` | Silverbrook Ford | Whispering Wilds | Lvl 3 | W:`r_old_mill`, E:`r_cinder_pass`, D:`r_catacomb_stairs` | Mob: River Lurker; Node: Silver-Sand Deposit |
| `r_bandit_stronghold` | Thornwood Bandit Palisade | Whispering Wilds | Lvl 3 (Mini-Boss) | S:`r_hunter_camp` | Mini-Boss: **Garrick the Bandit King**; Ironbound Chest |
| `r_catacomb_stairs` | Flooded Crypt Stairwell | Sunken Catacombs | Lvl 3-4 | U:`r_river_ford`, S:`r_ossuary` | Mob: Risen Skeleton, Crypt Bat; Node: Grave Moss |
| `r_ossuary` | Hall of Ten Thousand Bones | Sunken Catacombs | Lvl 4 | N:`r_catacomb_stairs`, E:`r_drowned_nave`, W:`r_scriptorium` | Mob: Bone Weaver, Ghoul Stalker; Node: Silver Vein |
| `r_drowned_nave` | Drowned Cathedral Nave | Sunken Catacombs | Lvl 4-5 | W:`r_ossuary`, S:`r_reliquary` | NPC: Echo of Sister Vesper; Mob: Drowned Templar |
| `r_scriptorium` | Forbidden Scriptorium | Sunken Catacombs | Lvl 5 | E:`r_ossuary`, S:`r_lich_sanctum` | Mob: Cursed Archivist; Runic Enchanting Station |
| `r_reliquary` | Sealed Reliquary Vault | Sunken Catacombs | Lvl 5 | N:`r_drowned_nave`, W:`r_lich_sanctum` | Mob: Reliquary Gargoyle; Node: Shadow Quartz |
| `r_lich_sanctum` | Sanctum of the Undying | Sunken Catacombs | Lvl 5 (Boss) | N:`r_scriptorium`, E:`r_reliquary` | Boss: **Malakor the Soul-Binder** |
| `r_cinder_pass` | Cinderwind Mountain Pass | Emberpeak Forge-Ruins | Lvl 5-6 | W:`r_river_ford`, E:`r_dwarven_gate` | Mob: Ash Hound, Magma Imp; Node: Firebloom Herb |
| `r_dwarven_gate` | Shattered Obsidian Gate | Emberpeak Forge-Ruins | Lvl 6 | W:`r_cinder_pass`, N:`r_slag_foundry`, S:`r_obsidian_barracks` | NPC: Dwarven Engineer Borin (Quest/Merchant) |
| `r_slag_foundry` | Great Slag Foundry | Emberpeak Forge-Ruins | Lvl 6-7 | S:`r_dwarven_gate`, E:`r_lava_bridge` | Mob: Clockwork Automaton, Cinder Golem; Master Runeforge |
| `r_obsidian_barracks` | Obsidian Watch Barracks | Emberpeak Forge-Ruins | Lvl 7 | N:`r_dwarven_gate`, E:`r_crystal_cavern` | Mob: Ashen Warlock, Charred Centurion; Node: Mythril Vein |
| `r_lava_bridge` | Span of Molten Chains | Emberpeak Forge-Ruins | Lvl 7-8 | W:`r_slag_foundry`, S:`r_crystal_cavern`, E:`r_caldera_throne` | Mob: Pyroclast Drake; Node: Molten Core |
| `r_crystal_cavern` | Starlight Geode Cavern | Emberpeak Forge-Ruins | Lvl 8 | W:`r_obsidian_barracks`, N:`r_lava_bridge`, U:`r_rift_breach` | Mob: Crystalline Watcher; Node: Aether Crystal |
| `r_caldera_throne` | The Molten Caldera Throne | Emberpeak Forge-Ruins | Lvl 8 (Boss) | W:`r_lava_bridge` | Boss: **Ignis-Vulcan, the Titan Forge-Lord** |
| `r_rift_breach` | The Shattered Horizon Breach | Astral Rift Citadel | Lvl 8-9 | D:`r_crystal_cavern`, N:`r_chrono_gallery` | NPC: Rift Researcher Kaelen; Mob: Void Stalker |
| `r_chrono_gallery` | Gallery of Fractured Time | Astral Rift Citadel | Lvl 9 | S:`r_rift_breach`, E:`r_void_conduit`, W:`r_celestial_observatory` | Mob: Chrono Wraith, Astral Sentinel |
| `r_celestial_observatory` | Ruined Celestial Observatory | Astral Rift Citadel | Lvl 9-10 | E:`r_chrono_gallery`, N:`r_throne_approach` | Mob: Star-Eater Seraph; Astral Astrolabe Shrine |
| `r_void_conduit` | Nexus of Bleeding Stars | Astral Rift Citadel | Lvl 10 | W:`r_chrono_gallery`, N:`r_throne_approach` | Mob: Rift Weaver; Node: Star-Metal Vein; Astral Altar |
| `r_throne_approach` | Stair of Eclipsed Suns | Astral Rift Citadel | Lvl 10-11 (Mini-Boss) | S:`r_chrono_gallery`, W:`r_celestial_observatory`, E:`r_void_conduit`, U:`r_astral_core` | Elite: **Vaelen, Herald of the Void** |
| `r_astral_core` | Heart of the Shattered Rift | Astral Rift Citadel | Lvl 12+ (World Boss & Endless Rift) | D:`r_throne_approach` | World Boss: **Xal'korath, Architect of the Void** + Endless Void Wave Portal |

---

## 3. Combat, Progression, Economy & Quest Formulas

### 3.1 Character Classes & Base Attributes
- **Vanguard**: Base HP `140`, MP `40`, STA `100`, STR `14`, INT `6`, AGI `8`, VIT `14`.
  - Skills: `Shield Bash` (15 STA, 8s CD, 135% STR dmg + 1-turn Stun), `Whirlwind Cleave` (25 STA, 12s CD, 160% STR AoE dmg), `Iron Will` (20 MP, 16s CD, heal 25% Max HP + 30% DEF buff for 3 rounds).
- **Arcanist**: Base HP `95`, MP `120`, STA `70`, STR `6`, INT `16`, AGI `9`, VIT `9`.
  - Skills: `Arcane Bolt` (18 MP, 6s CD, 175% INT magic dmg), `Supernova` (35 MP, 14s CD, 210% INT dmg + 3-turn Burn DoT), `Mana Barrier` (25 MP, 18s CD, shield 35% Max HP + restore 20 STA).
- **Shadowblade**: Base HP `110`, MP `65`, STA `120`, STR `10`, INT `8`, AGI `16`, VIT `10`.
  - Skills: `Viper Strike` (15 STA, 6s CD, 130% AGI dmg + 3-turn Poison DoT), `Shadowstep Ambush` (30 STA, 12s CD, guaranteed Critical Hit 220% AGI dmg), `Smoke Veil` (20 MP, 16s CD, +35% Evasion for 3 rounds + heal 18% HP).

### 3.2 Progression & Damage Equations
- **XP to Next Level**: `XP_req(L) = floor(100 * (L ^ 1.45))`
- **Physical/Weapon Attack Power**: `ATK = WeaponATK + STR * 2.2 + AGI * 1.1`
- **Spell/Skill Power**: `SP = WeaponMag + INT * 2.6 + STR * 0.8`
- **Defense Mitigation**: `DamageTaken = max(1, RawDamage * (100 / (100 + DEF * 1.8)))`
- **Stance Multipliers**:
  - `Balanced`: `1.0x` ATK, `1.0x` DEF, `+0%` Crit
  - `Aggressive`: `1.25x` ATK, `0.80x` DEF, `+10%` Crit
  - `Defensive`: `0.82x` ATK, `1.35x` DEF, `+15%` Block/Mitigation

### 3.3 Story Quest Chain & Procedural Bounties
1. **Q1 — Whispers in the Wilds** (Elder Thorne): Slay 2 Briar Wolves and 1 Moss Goblin, harvest 2 Moonpetal Herbs -> Reward: `120 XP`, `65 Gold`, *Ranger's Signet Ring (Uncommon)*.
2. **Q2 — The Bandit King's Toll** (Commander Vance): Defeat **Garrick the Bandit King** in Thornwood Palisade -> Reward: `260 XP`, `140 Gold`, *Crypt Key*, *Oakhaven Tabard (Rare)*.
3. **Q3 — Echoes of the Drowned Crypt** (Alchemist Lyra): Slay **Malakor the Soul-Binder** in Sanctum of the Undying -> Reward: `550 XP`, `300 Gold`, *Soulfire Lantern (Epic Relic)*.
4. **Q4 — Reigniting the Runeforge** (Engineer Borin): Harvest 2 Mythril Ore and defeat **Ignis-Vulcan, the Titan Forge-Lord** -> Reward: `1100 XP`, `650 Gold`, *Core of Vulcan (Epic Material)*.
5. **Q5 — Architect of the Shattered Rift** (Researcher Kaelen): Defeat **Xal'korath, Architect of the Void** in Heart of the Shattered Rift -> Reward: `2500 XP`, `1500 Gold`, *Crown of the Astral Sovereign (Mythic)*.
6. **Infinite Guild Bounties**: Dynamically generated target contracts scaling with player level.

---

## 4. Verification & Test Plan (Phase 3)

1. **Static Verification (`check_web_app.py`)**:
   - Verify 0 `ERROR` and 0 `WARNING` outputs (no dead buttons, no undefined handlers, no prohibited APIs, no broken IDs).
2. **Graph Integrity Test**:
   - Assert >= 30 rooms across 5 biomes, bidirectional consistency, and 100% BFS reachability from `r_town_square`.
3. **Headless Browser & Gameplay Simulation Suite (`verify_mud.py` via Selenium Chromium)**:
   - Boot `open_world_mud.html` in headless Chromium.
   - Verify zero console/JS runtime errors.
   - Test Character Creation (Class selection + custom name).
   - Test Movement via both text parser (`n`, `e`, `w`, `s`) and clickable compass/minimap controls.
   - Test Resource Harvesting & Crafting (`harvest`, `craft`).
   - Test Combat Engagement, Active Skill Execution, Mob Defeat, XP/Gold Gain, and Loot Equipping.
   - Test Shop Buy/Sell & Quest Acceptance/Completion.
   - Test Save/Load persistence (`localStorage` + JSON Export/Import round-trip).
   - Test Endless Rift Wave mode activation.


---

## 5. Goal Version 2 Delta (Cycle 2 Revision — User Feedback Integration)

- **Goal Version**: `2` (incremented from `1` upon human feedback)
- **Preserved Budget**: `N = 69`, `cycles_used = 1` prior to Cycle 2 dispatch (`cycles_used = 2`, `allowance_remaining = 67` after Cycle 2 dispatch)

### 5.1 New & Updated Acceptance Criteria (`C7`–`C9`)
1. **`C7_SINGLE_SCREEN_FIT` (Auto-Fit Single-Screen Viewport Without Scrolling)**:
   - `html, body` locked to `100vh` (`h-screen max-h-screen overflow-hidden flex flex-col`) so the entire 3-column game interface fits inside one visible browser viewport with zero outer page scrolling (`document.documentElement.scrollHeight <= window.innerHeight`).
   - Internal cards use flex-box containment (`min-h-0 flex-1 overflow-y-auto`) so logs and drawers scroll smoothly within their designated panels.
2. **`C8_BILINGUAL_EN_ZH` (Bilingual English-First, Next-Line Chinese Display)**:
   - Every interactive terminal message, room title/description, NPC dialogue, combat action, skill description, item entry, quest/bounty card, and UI control renders **English on Line 1** and **Chinese (`简体中文`) on Line 2**.
3. **`C9_CPU_LLM_TRIAL` (CPU-Friendly Small LLM Trial for Normal Laptops Without GPU)**:
   - Embeds a 3-Tier CPU-Friendly AI Dungeon Master & NPC Brain (`LocalTinyLM` Neuro-Symbolic Context Engine running in `<5ms` on any laptop CPU + optional WebAssembly `Transformers.js` q4 CPU model loader for `SmolLM2-135M-Instruct` / `Qwen2.5-0.5B-Instruct` + optional localhost CPU Ollama bridge).
   - Supports `ai <prompt>` command, 1-click **🎭 AI NPC Dialogue**, **🎲 AI Dynamic Encounter**, and **🧭 AI Tactical Advisor**, outputting bilingual (English line 1, Chinese line 2) responses.


---

## 6. Goal Version 3 Delta (Cycle 4 Revision — Screenshot Layout & Player-Centered World Map)

- **Goal Version**: `3` (incremented from `2` upon screenshot feedback)
- **Preserved Budget**: `N = 69`, `cycles_used = 3` prior to Cycle 4 dispatch (`cycles_used = 4`, `allowance_remaining = 65` after Cycle 4 dispatch)

### 6.1 Root-Cause Analysis from User Screenshot (`1366x640` Laptop Viewport)
1. **Center Column Terminal Log Squashed (`~24px` tall)**:
   - The top Room Card (tall banner + multi-row 2-line exit/action buttons) and bottom 2-row command/macro bar consumed ~95% of vertical height at `640px` viewport height.
   - **Fix**: Compact room header & inline bilingual chips with `max-h` guard on the room context area so `#terminal-log` always retains `>= 190px–260px` of visible height at `1366x640`.
2. **Left Column Attributes & Talents Pushed Below Fold**:
   - Tall Vitals and Stance/Skills cards left no vertical space for Attributes & Talents at `640px` height.
   - **Fix**: Integrate Attributes (`STR/INT/AGI/VIT +1`), Derived Stats (`ATK/MAG/DEF/CRIT`), and Talents (`Warlord/Mystic/Pathfinder`) into a compact, zero-clipping Left Column layout where all three sections remain simultaneously visible at `1366x640`.
3. **World Map Too Small & Not Centered on User (`C10_CENTERED_LARGE_MAP`)**:
   - The map container was only `h-36` (`144px`), shared width with the compass, had a static `viewBox="0 0 520 340"`, and had a legend overlay covering bottom nodes.
   - **Fix**: Expand the World Atlas container to full card width and `h-52` (`208px+` height), move the legend into the header bar, float a compact translucent Compass + Zoom (`+`/`-`/`1:1`) overlay in the corner, and dynamically compute the SVG `viewBox` centered on `(currentRoom.x, currentRoom.y)` with bilingual room labels on nodes.


---

## 7. Goal Version 4 Delta (Cycle 6 Revision — GitHub Repository Packaging & 10-Language Single-Locale Display)

- **Goal Version**: `4` (incremented from `3` upon user request for GitHub migration and 10-language single-language mode)
- **Preserved Budget**: `N = 69`, `cycles_used = 5` prior to Cycle 6 dispatch (`cycles_used = 6`, `allowance_remaining = 63` after Cycle 6 dispatch)

### 7.1 New & Updated Acceptance Criteria (`C11` & `C12`)
1. **`C11_SINGLE_LANG_10_LOCALES` (Single-Language Display Across 10 Mainstream Languages)**:
   - Replaces dual-language stacked rendering with a clean **Single-Language Mode** controlled by a top-bar language selector (`#lang-select`) and `lang <code>` command.
   - Supports **10 mainstream languages**:
     1. `en` — English
     2. `zh` — 简体中文 (Simplified Chinese)
     3. `es` — Español (Spanish)
     4. `ja` — 日本語 (Japanese)
     5. `ko` — 한국어 (Korean)
     6. `fr` — Français (French)
     7. `de` — Deutsch (German)
     8. `pt` — Português (Portuguese)
     9. `ru` — Русский (Russian)
     10. `ar` — العربية (Arabic, with automatic RTL text direction support)
   - Only the active language is displayed across UI headers, buttons, room titles/descriptions, minimap node labels, exits, NPCs, mobs, skills, inventory items, quests, achievements, terminal logs, and CPU TinyLM responses.
2. **`C12_GITHUB_REPO_PACKAGE` (GitHub-Ready Repository & CI/CD Bundle)**:
   - Initializes a complete Git repository (`aethelgard-mud`) containing `index.html` / `open_world_mud.html`, `src/build_mud_game.py`, `docs/mud_design_plan.md`, `tests/verify_mud.py`, `.github/workflows/deploy-pages.yml` (GitHub Pages auto-deployment), and `README.md`, packaged into `artifacts/file_generation/ttl=63d/output/aethelgard_mud_github_repo.zip` for 1-step GitHub upload/push.
