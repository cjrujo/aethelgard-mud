/* Aethelgard v10: deterministic turn combat, truthful item effects and bounded economy.
 * Loaded after core.js and gameplay.js. All rules run without any LLM dependency.
 */
const CombatDirector = (() => {
  "use strict";
  const legacy = {
    derived: computeDerivedStats, harvest: harvestRoomNodes, command: executeCommand,
    render: renderAll, level: checkLevelUp, create: createInitialState,
    buy: buyShopItem, sell: sellInventoryItem, craft: craftRecipe,
    equip: equipOrUseItem, save: saveGameState, load: loadGameState,
    import: importSaveJson, funRender: renderFunPackUI
  };
  const slots = ["weapon", "armor", "helm", "ring", "relic"];
  const intentNames = {
    strike: ["Quick strike", "快速攻击"], charge: ["Charging a heavy blow — interrupt now", "正在蓄力重击——现在可以打断"],
    heavy: ["Heavy blow — guard!", "重击即将落下——建议防御"], cast: ["Casting a spell — interrupt!", "正在吟唱——建议打断"],
    recover: ["Exposed — deal +35% damage", "破绽——受到伤害增加35%"], guard: ["Guarding — use a skill", "格挡——技能可穿透部分护甲"]
  };
  // Authored bosses keep fixed identities and do not scale to the player's gear.
  // A phase starts only after the current, already announced action resolves.
  const bossProfiles = {
    boss_garrick: { hp: 5.5, atk: 1.22, threshold: .50, phasePower: 1.10,
      phases: [["Palisade Captain", "木寨之王"], ["Cornered Bandit", "困兽之斗"]],
      patterns: [["strike","strike","charge","heavy","recover"], ["strike","charge","heavy","recover","strike","guard"]],
      hint: ["Interrupt the raised cleaver; save a skill for his guard.", "举刀蓄力时打断，格挡时保留一个技能穿甲。"] },
    boss_malakor: { hp: 3.6, atk: 1.25, threshold: .55, phasePower: 1.15,
      phases: [["Stolen Choir", "被盗的唱诗班"], ["Soul Tether Unbound", "失控的魂链"]],
      patterns: [["cast","strike","strike","guard","recover"], ["cast","strike","charge","heavy","recover","cast"]],
      hint: ["Save stamina to break his chants; recover resources when the choir falls silent.", "留体力打断吟唱，唱诗沉寂、露出破绽时补充资源。"] },
    boss_ignis_vulcan: { hp: 4.6, atk: 1.22, threshold: .50, phasePower: 1.20,
      phases: [["Sealed Furnace", "封闭熔炉"], ["Heart of the Caldera", "火山之心"]],
      patterns: [["guard","charge","heavy","strike","recover"], ["charge","heavy","strike","guard","heavy","recover"]],
      hint: ["Skills pierce the furnace guard. Interrupt the wind-up or brace for the hammer.", "技能可穿透熔炉格挡。蓄力时打断，否则准备防御重锤。"] },
    boss_vaelen: { hp: 3.4, atk: 1.18, threshold: .45, phasePower: 1.12,
      phases: [["Twin Glaives", "双刃之舞"], ["The Herald's Last Watch", "先驱的最后守望"]],
      patterns: [["strike","strike","charge","heavy","recover"], ["strike","charge","heavy","strike","recover"]],
      hint: ["His quick strikes test your defenses; the glaive wind-up is your safe retreat window.", "连续快击考验防护，双刃蓄力时可打断或安全撤退。"] },
    boss_xalkorath: { hp: 3.8, atk: 1.20, threshold: .50, phasePower: 1.18,
      phases: [["The Architect's Design", "建筑师的蓝图"], ["A Collapsing Star", "正在坍缩的恒星"]],
      patterns: [["guard","cast","strike","charge","heavy","recover"], ["cast","heavy","strike","guard","cast","heavy","recover"]],
      hint: ["Balance interrupts with recovery. His second phase alternates spell and heavy-blow threats.", "平衡打断与资源恢复。第二阶段交替施法与重击威胁。"] }
  };
  const say = (en, zh, category = "combat", color = "text-sky-300") => addLog(en, category, color, zh);
  const text = (en, zh) => typeof getLang === "function" && getLang() === "zh" ? zh : en;
  const room = () => WORLD_ROOMS[state.world.currentRoom];
  const emit = (type, payload = {}) => {
    if (typeof GameDirector !== "undefined" && typeof GameDirector.onAction === "function")
      GameDirector.onAction(type, { roomId: state.world.currentRoom, ...payload });
  };
  const onlineBusy = () => typeof OnlineRealm !== "undefined" && typeof OnlineRealm.isBusy === "function" && OnlineRealm.isBusy();
  function ensure() {
    const p = state.player;
    p.buffs = Array.isArray(p.buffs) ? p.buffs : [];
    p.buffTurns = p.buffTurns || {};
    p.cooldowns = Array.isArray(p.cooldowns) ? p.cooldowns : [0, 0, 0];
    p.talents = { warlord: 0, mystic: 0, pathfinder: 0, ...p.talents };
    p.equipment = p.equipment || {};
    p.inventory = p.inventory || {};
    state.combatLedger = state.combatLedger || {};
    const l = state.combatLedger;
    if (!l.rng) {
      const a = new Uint32Array(1);
      if (globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(a);
      l.rng = a[0] || ((Date.now() ^ 0x9e3779b9) >>> 0) || 1;
    }
    l.serial = Number.isSafeInteger(l.serial) ? l.serial : 0;
    l.claimed = l.claimed || {};
    l.bossRespawn = l.bossRespawn || {};
    l.dropPity = l.dropPity || 0;
    ensureFunState();
    state.fun.comboCount = Math.min(8, Math.max(0, state.fun.comboCount || 0));
    return l;
  }
  function random() {
    const l = ensure();
    let x = l.rng >>> 0;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    l.rng = x >>> 0;
    return l.rng / 4294967296;
  }
  function uid(prefix) { const l = ensure(); return prefix + "_" + (++l.serial).toString(36) + "_" + Math.floor(random() * 0x100000000).toString(36); }
  function reportBlocked(en, zh) { say(en, zh, "world", "text-amber-300"); return false; }
  function peaceful() {
    if (onlineBusy()) return reportBlocked("Finish or leave the online battle before changing your offline character.", "请先完成或离开在线战斗，再修改离线角色。");
    return !state.combat.inCombat || reportBlocked("Finish or flee the battle first.", "请先结束战斗或撤退。");
  }
  function atFacility(kind) {
    if (!peaceful()) return false;
    const r = room();
    const station = String(r && r.station || "");
    const allowed = kind === "forge" ? (r && (r.id === "r_blacksmith" || /forge|anvil|熔炉|铁砧/i.test(station)))
      : kind === "alchemy" ? (r && (r.safe || /alchem|炼金/i.test(station))) : (r && r.safe);
    return allowed || reportBlocked(kind === "forge" ? "Visit Ironheart Smithy or a runeforge to craft or refine equipment." : "Visit a safe settlement to trade or brew potions.",
      kind === "forge" ? "请前往铁心铁匠铺或符文熔炉锻造、精炼装备。" : "请前往安全据点交易或炼制药剂。");
  }
  function equipped() { return slots.map(s => ITEM_CATALOG[state.player.equipment[s]]).filter(Boolean); }
  function hasProc(proc) { return equipped().some(i => i.proc === proc || (i.procs || []).includes(proc)); }
  function sets() {
    const counts = { stormcaller: 0, warlord: 0, singularity: 0 };
    slots.forEach(s => { const i = ITEM_CATALOG[state.player.equipment[s]]; if (i && i.slot === s && Object.hasOwn(counts, i.setId)) counts[i.setId]++; });
    return {
      counts, atkMult: counts.stormcaller >= 2 ? 1.25 : 1, magMult: counts.stormcaller >= 2 ? 1.25 : 1,
      defMult: counts.warlord >= 2 ? 1.30 : 1, critBonus: counts.singularity >= 2 ? 15 : 0,
      lifestealBonus: counts.warlord >= 2 ? 12 : 0, skillMult: counts.stormcaller >= 4 ? 1.50 : 1,
      chainProc: counts.stormcaller >= 2, critMult: counts.warlord >= 4 ? 2.10 : 1.65,
      chargeMult: counts.singularity >= 2 ? 1.30 : 1, statMult: counts.singularity >= 4 ? 1.40 : 1
    };
  }
  function derived() {
    ensure();
    const p = state.player, m = sets(), vitals = { hp: p.hp, mp: p.mp, sta: p.sta }, base = legacy.derived();
    const attr = Math.max(1, m.statMult);
    if (attr > 1) {
      base.atk = Math.round(base.atk * attr); base.mag = Math.round(base.mag * attr); base.def = Math.round(base.def * attr);
      ["str", "intStat", "agi", "vit"].forEach(k => { base[k] = Math.round(base[k] * attr); });
      p.maxHp = Math.round(p.maxHp * attr); p.maxMp = Math.round(p.maxMp * attr); p.maxSta = Math.round(p.maxSta * attr);
    }
    p.hp = Math.min(p.maxHp, vitals.hp); p.mp = Math.min(p.maxMp, vitals.mp); p.sta = Math.min(p.maxSta, vitals.sta);
    if (m.counts.warlord >= 4 && p.hp < p.maxHp / 2) { base.atk = Math.round(base.atk * 1.20); base.mag = Math.round(base.mag * 1.20); }
    base.lifesteal = Math.min(35, m.lifestealBonus + Math.min(5, p.talents.warlord) * 3 + equipped().reduce((s, i) => s + (i.lifesteal || 0), 0));
    base.critMult = m.critMult; base.skillMult = m.skillMult;
    return base;
  }
  function setIntent(e) {
    const profile = bossProfiles[e.id];
    if (profile) {
      const phase = e.hp <= e.maxHp * profile.threshold ? 2 : 1;
      if (!e.phase) { e.phase = phase; e.phaseStartedRound = e.round || 0; }
      else if (e.phase !== phase) {
        e.phase = phase; e.phaseStartedRound = e.round || 0; e.skipHeavy = false;
        say(`⚠️ ${e.name}: ${profile.phases[phase - 1][0]}. Its rhythm changes; read the new intent.`,
          `⚠️ ${e.nameZh}进入「${profile.phases[phase - 1][1]}」。行动节律改变，请观察新的意图。`, "combat", "text-amber-200");
      }
      const pattern = profile.patterns[phase - 1];
      e.intent = pattern[Math.max(0, (e.round || 0) - (e.phaseStartedRound || 0)) % pattern.length];
      return e.intent;
    }
    const caster = /mystic|warlock|weaver|wraith|archivist|malakor|xalkorath/i.test(e.id);
    const pattern = e.boss ? ["strike", "charge", "heavy", "recover", "cast"] : caster ? ["cast", "strike", "recover"] : ["strike", "charge", "heavy", "recover"];
    e.intent = pattern[(e.round || 0) % pattern.length];
    return e.intent;
  }
  function normalizeEnemy(e) {
    e.statuses = Array.isArray(e.statuses) ? e.statuses : [];
    e.effects = e.effects || {};
    e.statuses.forEach(s => { if (!e.effects[s]) e.effects[s] = { turns: s === "Stunned" ? 1 : 3, power: 5 }; });
    e.battleId = e.battleId || uid("battle");
    e.round = e.round || 0;
    e.intent = e.intent || setIntent(e);
    e.hits = e.hits || 0;
    return e;
  }
  function startEncounter(template, options = {}) {
    ensure();
    if (onlineBusy()) return reportBlocked("An online battle is active. Finish it before starting a solo encounter.", "在线战斗进行中，请先结束再开启单人战斗。");
    if (state.combat.inCombat) return reportBlocked("A battle is already in progress.", "当前战斗尚未结束，不能替换敌人。");
    if (!template || !(Number(template.hp) > 0)) return false;
    const e = { ...template, ...options, hp: Math.round(template.hp), maxHp: Math.round(template.hp), statuses: [], effects: {}, round: 0, hits: 0, battleId: uid("battle"), phoenixUsed: false };
    e.nameZh = e.nameZh || e.name;
    e.originRoom = state.world.currentRoom;
    state.combat = { inCombat: true, enemy: e };
    state.fun.comboCount = 0;
    state.player.buffs = []; state.player.buffTurns = {};
    setIntent(e);
    say(`⚔️ ${e.name} — Lv.${e.level}, ${e.hp} HP. Read its intent and choose your turn.`, `⚔️ ${e.nameZh}——${e.level}级，${e.hp}生命。先观察敌人意图，再选择行动。`);
    emit("combat_start", { enemyId: e.id, enemyName: e.name, boss: !!e.boss });
    renderAll();
    return true;
  }
  function engage(query) {
    ensure();
    if (state.combat.inCombat) return action("attack");
    const r = room(), q = String(query || "").trim().toLowerCase();
    const ids = (r && r.mobs) || [];
    const id = ids.find(id => { const m = MOB_TEMPLATES[id]; return m && (!q || id === q || m.name.toLowerCase().includes(q) || (m.nameZh || "").includes(q)); });
    if (!id) return reportBlocked("No matching hostile is present here.", "此处没有对应的敌人。");
    const t = MOB_TEMPLATES[id];
    if (ensure().bossRespawn[id] > state.tickCount) return reportBlocked("That boss is recovering. Explore for a few world ticks.", "该首领尚未重生，请先探索，等待几个世界回合。");
    const profile = bossProfiles[id];
    const mult = profile ? profile.hp : t.boss ? 1.35 : 1.60;
    return startEncounter({ ...t, hp: Math.round(t.hp * mult), atk: Math.round(t.atk * (profile?.atk || 1.25)) });
  }
  function addEffect(e, name, turns, power) { e.effects[name] = { turns, power }; e.statuses = Object.keys(e.effects); }
  function hit(e, damage, label, labelZh) {
    const actual = Math.min(e.hp, Math.max(0, Math.round(damage)));
    e.hp -= actual;
    if (actual > 0) say(`${label}: ${actual} damage to ${e.name}.`, `${labelZh}：对${e.nameZh}造成${actual}点伤害。`);
    return actual;
  }
  function afterDamage(e, damage, d, kind) {
    const p = state.player, m = sets();
    e.hits++;
    state.fun.comboCount = Math.min(8, state.fun.comboCount + 1);
    state.fun.overdrive = Math.min(100, state.fun.overdrive + Math.round((kind === "skill" ? 14 : 10) * m.chargeMult));
    if (d.lifesteal > 0) p.hp = Math.min(p.maxHp, p.hp + Math.floor(damage * d.lifesteal / 100));
    if (e.hp <= 0) return;
    const pet = getActiveCompanion();
    const petMult = Math.min(.32, pet.dmgMult * .50 + Math.min(12, state.fun.companionLevel - 1) * .005);
    hit(e, damage * petMult, pet.name, pet.nameZh);
    if (e.hits % 3 === 0 && e.hp > 0 && (pet.id === "wolf" || pet.id === "drake")) addEffect(e, pet.id === "wolf" ? "Bleeding" : "Burning", 2, Math.max(3, Math.round(damage * .10)));
    if (m.chainProc && e.hits % 3 === 0 && e.hp > 0) hit(e, d.mag * .22, "Stormcaller lightning", "雷霆套装闪电");
    if (m.counts.stormcaller >= 4 && kind === "skill" && e.hp > 0) hit(e, d.mag * .30, "Twin storm nova", "双重风暴新星");
    for (const proc of ["Chain-Lightning", "Void-Rend", "Time-Surge", "Starfall"]) {
      if (!hasProc(proc) || e.hp <= 0 || random() >= .20) continue;
      if (proc === "Time-Surge") {
        p.cooldowns = p.cooldowns.map(c => Math.max(0, c - 1));
        say("⌛ Time surge reduces skill cooldowns by 1 turn.", "⌛ 时空涌动：技能冷却减少1回合。");
      } else hit(e, Math.max(3, (proc === "Starfall" ? d.mag : d.atk) * .20), proc, { "Chain-Lightning": "闪电词缀", "Void-Rend": "虚空撕裂", Starfall: "星陨" }[proc]);
    }
  }
  function enemyTurn(e, guarding, interrupted) {
    const p = state.player, d = derived();
    if (e.hp <= 0) return;
    if (interrupted || e.effects.Stunned) {
      delete e.effects.Stunned; e.statuses = Object.keys(e.effects);
      say("⚡ The enemy's action is interrupted.", "⚡ 敌人的行动被打断。");
      return;
    }
    if (e.intent === "charge" || e.intent === "recover" || e.intent === "guard") {
      say(e.intent === "charge" ? "⚠️ The enemy winds up a crushing blow for next turn." : "The enemy regroups and leaves an opening.", e.intent === "charge" ? "⚠️ 敌人完成蓄力，下一回合将发动重击。" : "敌人正在调整，露出了进攻机会。");
      return;
    }
    if (p.buffs.includes("EvasionVeil") && random() < .50) { say("💨 Your veil turns the strike aside.", "💨 烟幕使敌人的攻击落空。"); return; }
    const profile = bossProfiles[e.id];
    const enraged = profile ? (e.phase === 2 ? profile.phasePower : 1) : e.boss && e.hp < e.maxHp * .35 ? 1.22 : 1;
    const power = e.intent === "heavy" ? 2.25 : e.intent === "cast" ? 1.5 : 1;
    const armorFactor = e.intent === "cast" ? .65 : 1.45;
    const petGuard = getActiveCompanion().id === "golem" ? .82 : 1;
    const damage = Math.max(1, Math.round(e.atk * power * enraged * (.95 + random() * .10) * 100 / (100 + d.def * armorFactor) * (guarding ? .35 : 1) * petGuard));
    p.hp = Math.max(0, p.hp - damage);
    say(`💥 ${e.name}: ${damage} damage${guarding ? " (guarded)" : ""}.`, `💥 ${e.nameZh}造成${damage}点伤害${guarding ? "（已防御减伤）" : ""}。`, "combat", "text-rose-300");
    if (p.hp <= 0 && hasProc("Phoenix") && !e.phoenixUsed) {
      e.phoenixUsed = true; p.hp = Math.max(1, Math.round(p.maxHp * .25));
      say("🔥 Phoenix saves you once this battle: 25% HP restored.", "🔥 凤凰词缀本场战斗首次救命，恢复25%生命。");
    }
  }
  function action(kind = "attack", arg) {
    ensure();
    if (onlineBusy()) return reportBlocked("Use the online battle controls while your online battle is active.", "在线战斗进行中，请使用在线战斗面板操作。");
    const p = state.player, e = state.combat.enemy;
    if (!state.combat.inCombat || !e) return reportBlocked("Choose an enemy before taking a combat action.", "请先选择敌人，再执行战斗行动。");
    normalizeEnemy(e);
    if (e.resolved) return false;
    if (!["attack", "guard", "interrupt", "skill", "potion", "ultimate", "flee"].includes(kind)) return false;
    let skill = null, usedCd = -1, interrupted = false, guarding = kind === "guard";
    if (kind === "skill") {
      skill = (CLASS_CONFIG[p.classId] || CLASS_CONFIG.vanguard).skills[Number(arg)];
      if (!skill) return false;
      if ((p.cooldowns[arg] || 0) > 0) return reportBlocked(`Skill cooldown: ${p.cooldowns[arg]} turns.`, `该技能还需冷却${p.cooldowns[arg]}回合。`);
      if (p[skill.costType] < skill.cost) return reportBlocked("Not enough mana or stamina for that skill.", "释放该技能所需的法力或体力不足。");
      p[skill.costType] -= skill.cost; p.cooldowns[arg] = skill.cd; usedCd = Number(arg);
    }
    if (kind === "interrupt") {
      if (p.sta < 18) return reportBlocked("Interrupt costs 18 stamina.", "打断需要18点体力。");
      p.sta -= 18; interrupted = ["cast", "charge"].includes(e.intent);
      if (interrupted && e.intent === "charge") e.skipHeavy = true;
    }
    if (kind === "ultimate") {
      if (state.fun.overdrive < 50) return reportBlocked("Overdrive needs at least 50 charge.", "超载必杀至少需要50点能量。");
    }
    if (kind === "potion") {
      const i = ITEM_CATALOG[arg];
      if (!i || i.type !== "consumable" || !(p.inventory[arg] > 0)) return false;
      if (p.hp >= p.maxHp && p.mp >= p.maxMp && p.sta >= p.maxSta) return reportBlocked("Your vitals are already full; potion preserved.", "生命、法力、体力均已满，不消耗药剂。");
      removeItemFromInventory(arg, 1);
      p.hp = Math.min(p.maxHp, p.hp + (i.healHp || 0)); p.mp = Math.min(p.maxMp, p.mp + (i.healMp || 0)); p.sta = Math.min(p.maxSta, p.sta + (i.healSta || 0));
      say(`🧪 Used ${i.name}; the enemy also takes its turn.`, `🧪 使用${i.nameZh}；敌人也将行动。`);
    }
    if (kind === "flee") {
      const cost = 10;
      if (p.sta < cost) return reportBlocked("Retreat needs 10 stamina. Guard to recover stamina.", "撤退需要10点体力，可先防御恢复体力。");
      p.sta -= cost;
      const success = !e.boss || ["charge", "recover"].includes(e.intent) || random() < .70;
      if (success) {
        const savedId = e.id; state.combat = { inCombat: false, enemy: null }; state.autoHunt = false;
        p.buffs = []; p.buffTurns = {}; state.fun.comboCount = 0; state.telemetry.activeRiftWave = 0;
        say("🏃 Retreated safely. No victory reward was granted.", "🏃 成功撤退。本次战斗没有胜利奖励。");
        emit("combat_flee", { enemyId: savedId }); renderAll(); return true;
      }
      say("The boss blocks your retreat; you brace for impact.", "首领封锁退路，你及时架起防御。"); guarding = true;
    }
    const d = derived();
    if (kind === "guard") {
      p.sta = Math.min(p.maxSta, p.sta + 18); p.mp = Math.min(p.maxMp, p.mp + 8);
      say("🛡️ Guard: 65% incoming damage reduction, +18 stamina, +8 mana.", "🛡️ 防御：本回合减伤65%，恢复18体力与8法力。");
      state.fun.comboCount = Math.max(0, state.fun.comboCount - 1);
    } else if (kind === "skill" && skill.mult === 0) {
      const healing = Math.round(p.maxHp * .32);
      p.hp = Math.min(p.maxHp, p.hp + healing);
      const b = skill.effect === "heal_guard" ? "Guard" : skill.effect === "shield_heal" ? "ArcaneShield" : "EvasionVeil";
      if (!p.buffs.includes(b)) p.buffs.push(b); p.buffTurns[b] = 3;
      say(`${skill.name}: +${healing} HP and protection for 3 turns.`, `${skill.nameZh}：恢复${healing}生命，获得3回合防护。`);
    } else if (["attack", "skill", "interrupt", "ultimate"].includes(kind)) {
      const primary = p.classId === "arcanist" ? d.mag : d.atk;
      const crit = (skill && skill.effect === "crit") || random() * 100 < d.crit;
      const charge = state.fun.overdrive;
      const mult = kind === "ultimate" ? 2.0 + charge / 100 : kind === "interrupt" ? .55 : skill ? skill.mult * d.skillMult : 1;
      const basePower = skill && skill.stat === "int" ? d.mag : primary;
      const weak = e.intent === "recover" ? 1.35 : 1;
      const guarded = e.intent === "guard" && kind === "attack" ? .60 : 1;
      const execution = hasProc("Execution") && e.hp / e.maxHp < .25 ? 1.20 : 1;
      const amount = Math.max(2, Math.round(basePower * mult * (crit ? d.critMult : 1) * weak * guarded * execution * 100 / (100 + e.def * (skill ? 1.15 : 1.45))));
      const actual = hit(e, amount, (skill ? skill.name : kind === "ultimate" ? "Overdrive" : "Strike") + (crit ? " ★" : ""), (skill ? skill.nameZh : kind === "ultimate" ? "超载必杀" : "攻击") + (crit ? " ★暴击" : ""));
      if (skill && e.hp > 0) {
        const effect = { stun: "Stunned", bleed: "Bleeding", burn: "Burning", poison: "Poisoned" }[skill.effect];
        if (effect) addEffect(e, effect, effect === "Stunned" ? 1 : 3, Math.max(3, Math.round(basePower * .12)));
        if (skill.effect === "stun" && e.intent === "charge") e.skipHeavy = true;
      }
      if (kind === "ultimate") {
        state.fun.overdrive = 0; p.hp = Math.min(p.maxHp, p.hp + Math.round(p.maxHp * .20)); interrupted = true;
        if (e.intent === "charge") e.skipHeavy = true;
        if (sets().counts.singularity >= 4 && e.hp > 0) hit(e, (d.mag + d.atk) * .75, "Void nova", "虚空奇点爆发");
      }
      afterDamage(e, actual, d, kind === "skill" ? "skill" : "attack");
      if (kind === "ultimate") state.fun.overdrive = 0;
    }
    for (const [name, effect] of Object.entries(e.effects)) {
      if (name !== "Stunned" && e.hp > 0) {
        hit(e, effect.power, name, { Burning: "灼烧", Poisoned: "中毒", Bleeding: "流血" }[name] || name);
        if (--effect.turns <= 0) delete e.effects[name];
      }
    }
    e.statuses = Object.keys(e.effects);
    if (e.hp <= 0) { victory(e); return true; }
    enemyTurn(e, guarding, interrupted);
    p.cooldowns = p.cooldowns.map((cd, i) => i === usedCd ? cd : Math.max(0, cd - 1));
    for (const b of Object.keys(p.buffTurns)) if (--p.buffTurns[b] <= 0) { delete p.buffTurns[b]; p.buffs = p.buffs.filter(x => x !== b); }
    p.mp = Math.min(p.maxMp, p.mp + 2 + Math.min(5, p.talents.mystic) + (getActiveCompanion().id === "owl" ? 2 : 0));
    p.sta = Math.min(p.maxSta, p.sta + 5);
    e.round++;
    setIntent(e);
    if (e.skipHeavy && e.intent === "heavy") { e.intent = "recover"; e.skipHeavy = false; }
    emit("combat_turn", { enemyId: e.id, action: kind, turn: e.round, hp: p.hp, enemyHp: e.hp });
    if (p.hp <= 0) defeat();
    renderAll();
    return true;
  }
  function victory(e) {
    const l = ensure();
    if (e) normalizeEnemy(e);
    if (!state.combat.inCombat || state.combat.enemy !== e || e.hp > 0 || e.resolved || l.claimed[e.battleId]) return false;
    e.resolved = true; l.claimed[e.battleId] = true;
    const p = state.player, repeat = !!e.boss && state.world.defeatedBosses.includes(e.id);
    const petReward = getActiveCompanion().id === "owl" ? 1.20 : 1;
    const multiplier = (repeat ? .50 : 1) * (1 + Math.min(5, p.talents.pathfinder) * .15) * petReward;
    const xp = Math.max(0, Math.round(e.xp * multiplier)), gold = Math.max(0, Math.round(e.gold * multiplier * (state.achievements.ach_forager ? 1.10 : 1)));
    p.xp += xp; p.gold += gold; p.rep += e.boss ? (repeat ? 2 : 15) : 2;
    state.telemetry.kills++;
    if (e.boss) {
      state.telemetry.bossesKilled++; p.shards += repeat ? 1 : 3;
      if (!repeat) state.world.defeatedBosses.push(e.id);
      if (!e.isRiftWave) l.bossRespawn[e.id] = state.tickCount + 6;
    }
    if (e.isRiftWave) {
      const wave = e.wave || state.telemetry.activeRiftWave;
      state.telemetry.riftBestWave = Math.max(state.telemetry.riftBestWave, wave); state.telemetry.activeRiftWave = 0;
      p.shards += 2;
    }
    state.combat = { inCombat: false, enemy: null }; p.buffs = []; p.buffTurns = {};
    say(`🏆 ${e.name} defeated: +${xp} XP, +${gold} gold${repeat ? " (rematch rewards)" : ""}.`, `🏆 击败${e.nameZh}：获得${xp}经验、${gold}金币${repeat ? "（重复挑战奖励）" : ""}。`, "loot", "text-emerald-300");
    const dropPool = (e.drops || []).filter(k => ITEM_CATALOG[k]);
    if (dropPool.length) addItemToInventory(dropPool[Math.floor(random() * dropPool.length)], 1);
    if (e.id === "boss_garrick" && !(p.inventory["Crypt Key"] > 0)) addItemToInventory("Crypt Key", 1);
    l.dropPity++;
    if (e.boss || l.dropPity >= 5 || random() < .22) { grantLoot({ source: "victory", level: Math.min(p.level + 1, e.level), token: "drop:" + e.battleId }); l.dropPity = 0; }
    for (const b of state.quests.bounties) if (!b.claimed) {
      const eligibleLevel = !b.minEnemyLevel || e.level >= b.minEnemyLevel;
      if (b.targetKills && eligibleLevel && (!/Whispering Wilds/i.test(b.desc) || (room() && room().biome === "Whispering Wilds"))) b.progress = Math.min(b.targetKills, b.progress + 1);
      if (b.targetBoss && e.boss && eligibleLevel) b.progress = Math.min(b.targetBoss, b.progress + 1);
    }
    emit("combat_victory", { enemyId: e.id, enemyName: e.name, boss: !!e.boss, xp, gold, battleId: e.battleId, roomId: e.originRoom });
    checkLevelUp(); checkStoryQuests(); checkAchievements(); saveGameState(false); renderAll();
    return true;
  }
  function defeat() {
    const p = state.player, e = state.combat.enemy, l = ensure();
    if (!state.combat.inCombat) return false;
    const lost = Math.min(150, Math.floor(p.gold * .05));
    p.gold -= lost;
    if (lost > 0) l.recovery = { roomId: state.world.currentRoom, gold: lost };
    state.combat = { inCombat: false, enemy: null }; state.autoHunt = false; state.telemetry.activeRiftWave = 0;
    p.buffs = []; p.buffTurns = {}; p.cooldowns = [0, 0, 0]; state.fun.comboCount = 0;
    p.hp = Math.round(p.maxHp * .60); p.mp = Math.round(p.maxMp * .60); p.sta = p.maxSta;
    const oldRoom = state.world.currentRoom; state.world.currentRoom = "r_town_square";
    say(`💀 Rescued at Oakhaven. ${lost} gold remains at your defeat location; recover it with 'recover'. Equipment and levels are safe.`, `💀 已被救回橡木港。${lost}金币遗留在倒下地点，可返回后输入 recover 取回。装备与等级保留。`, "combat", "text-rose-300");
    emit("combat_defeat", { enemyId: e && e.id, roomId: oldRoom, lostGold: lost });
    saveGameState(false); renderAll(); return true;
  }
  function recover() {
    const l = ensure();
    if (!peaceful()) return false;
    if (!l.recovery || l.recovery.roomId !== state.world.currentRoom) return reportBlocked("No lost purse is here.", "此处没有遗失的钱袋。");
    const value = l.recovery.gold; state.player.gold += value; l.recovery = null;
    say(`Recovered ${value} gold.`, `取回了${value}金币。`, "loot"); renderAll(); return true;
  }
  function grantLoot({ source, level, token, slot, setId } = {}) {
    const l = ensure();
    if (!source || !token || l.claimed[token]) return null;
    if (slot && !slots.includes(slot)) return null;
    if (setId && !Object.hasOwn(DIABLO_SETS, setId)) return null;
    l.claimed[token] = true;
    const tier = Math.max(1, Math.min(60, Math.floor(Number(level) || state.player.level)));
    const pfx = DIABLO_PREFIXES[Math.floor(random() * DIABLO_PREFIXES.length)];
    const sfx = DIABLO_SUFFIXES[Math.floor(random() * DIABLO_SUFFIXES.length)];
    const sid = setId || Object.keys(DIABLO_SETS)[Math.floor(random() * 3)], set = DIABLO_SETS[sid];
    const part = SET_BASE_SLOTS.find(s => s.slot === slot) || SET_BASE_SLOTS[Math.floor(random() * SET_BASE_SLOTS.length)];
    const quality = .85 + random() * .30, tierScale = (.35 + tier * .075) * quality;
    const roll = random(), rarity = roll < .04 && tier >= 8 ? "mythic" : roll < .28 && tier >= 4 ? "epic" : "rare";
    const id = uid("gear"), display = `${pfx.en} ${part.en} ${sfx.en}`;
    const atk = Math.round((pfx.atk + sfx.atk) * tierScale * (part.slot === "weapon" ? 1.1 : .52));
    const mag = Math.round((pfx.mag + sfx.mag) * tierScale * (part.slot === "weapon" ? 1.1 : .60));
    const def = Math.round((pfx.def + sfx.def) * tierScale * (part.slot === "armor" ? 1.8 : .75));
    const crit = Math.min(12, Math.max(1, Math.round((pfx.crit + sfx.crit) * .35)));
    const procs = [pfx.proc, sfx.en === "of the Phoenix" ? "Phoenix" : sfx.en === "of Execution" ? "Execution" : sfx.en === "of Chain-Lightning" ? "Chain-Lightning" : null].filter(Boolean);
    const item = {
      id, name: `${display} [${id.slice(-5)}]`, nameZh: `${pfx.zh}${part.zh}${sfx.zh} [${id.slice(-5)}]`, type: "equipment", slot: part.slot,
      rarity, setId: sid, itemLevel: tier, requiredLevel: Math.max(1, tier - 2), lifesteal: pfx.lifesteal || 0, procs, proc: pfx.proc || null,
      value: 18 + tier * 9, atk, mag, def, crit,
      desc: `[${set.name}] +${atk} ATK / +${mag} MAG / +${def} DEF / +${crit}% crit; ${procs.join(", ") || "no proc"}${pfx.lifesteal ? "; " + pfx.lifesteal + "% lifesteal" : ""}`,
      descZh: `【${set.nameZh}】+${atk}物攻 / +${mag}法强 / +${def}防御 / +${crit}%暴击；${procs.map(p => ({ Phoenix: "凤凰救命", Execution: "残血处决", "Chain-Lightning": "闪电", "Time-Surge": "冷却缩短", "Void-Rend": "虚空撕裂", Starfall: "星陨" }[p])).join("、") || "无触发词缀"}${pfx.lifesteal ? "；" + pfx.lifesteal + "%吸血" : ""}`
    };
    state.world.proceduralItems = state.world.proceduralItems || {};
    ITEM_CATALOG[id] = item; state.world.proceduralItems[id] = item; addItemToInventory(id, 1);
    say(`🎁 ${item.name} (${set.name}).`, `🎁 获得${item.nameZh}（${set.nameZh}）。`, "loot", "text-amber-300");
    return id;
  }
  function forgeLoot(_legacyPaid, slot, setId) {
    if (!atFacility("forge")) return null;
    if ((slot && !slots.includes(slot)) || (setId && !Object.hasOwn(DIABLO_SETS, setId))) return null;
    const p = state.player, cost = 90 + p.level * 25, mat = p.level >= 7 ? "Mythril Ore" : p.level >= 4 ? "Silver Ore" : "Copper Ore";
    if (p.gold < cost || !(p.inventory[mat] >= 1)) return reportBlocked(`Forge a random set item: ${cost} gold + 1 ${mat}.`, `随机锻造套装需要${cost}金币与1份${ITEM_CATALOG[mat].nameZh}。`);
    p.gold -= cost; removeItemFromInventory(mat, 1);
    const id = grantLoot({ source: "forge", level: p.level, token: uid("forge"), slot, setId });
    state.telemetry.crafted++; emit("craft", { itemId: id, cost, random: true }); checkAchievements(); saveGameState(false); renderAll(); return id;
  }
  function rest() {
    if (!peaceful()) return false;
    const p = state.player, r = room();
    if (!r || !r.safe) return reportBlocked("Full rest is available in safe settlements. Use supplies or retreat from the wilds.", "安全据点可以完全休息。野外请使用补给，或返回据点。");
    p.hp = p.maxHp; p.mp = p.maxMp; p.sta = p.maxSta; p.cooldowns = [0, 0, 0]; p.buffs = []; p.buffTurns = {};
    say("💤 Rested safely; all vitals restored.", "💤 安全休息，生命、法力、体力全部恢复。", "world"); emit("rest"); renderAll(); return true;
  }
  function tick() {
    ensure(); state.tickCount++;
    state.timeOfDay = ["Dawn", "Day", "Dusk", "Midnight"][Math.floor(state.tickCount / 12) % 4];
    state.weather = ["Clear Skies", "Emerald Mist", "Arcane Storm", "Blood Moon"][Math.floor(state.tickCount / 18) % 4];
    for (const k of Object.keys(state.world.harvestedCooldowns)) if (--state.world.harvestedCooldowns[k] <= 0) delete state.world.harvestedCooldowns[k];
    const p = state.player, r = room();
    if (onlineBusy()) { renderAll(); return; }
    if (state.combat.inCombat) {
      if (state.autoHunt) {
        const e = normalizeEnemy(state.combat.enemy);
        if (p.hp < p.maxHp * .22) action("flee");
        else if (["cast", "charge"].includes(e.intent) && p.sta >= 18) action("interrupt");
        else if (e.intent === "heavy") action("guard");
        else action("attack");
      }
    } else {
      p.cooldowns = p.cooldowns.map(c => Math.max(0, c - 1));
      p.mp = Math.min(p.maxMp, p.mp + (r && r.safe ? 8 : 2)); p.sta = Math.min(p.maxSta, p.sta + (r && r.safe ? 12 : 4));
      if (r && r.safe) p.hp = Math.min(p.maxHp, p.hp + Math.max(3, Math.round(p.maxHp * .04)));
      if (state.autoHunt && r && !r.safe && r.mobs && r.mobs.length) engage(r.mobs[0]);
    }
    renderAll();
  }
  function render() {
    ensure();
    let panel = document.getElementById("combat-director-panel");
    if (!panel) {
      const anchor = document.getElementById("combat-state-pill");
      if (anchor && anchor.parentElement) {
        panel = document.createElement("section"); panel.id = "combat-director-panel";
        panel.className = "rounded-lg border border-rose-700/40 bg-slate-950/70 p-2 mt-1 text-[10px] space-y-1";
        anchor.parentElement.insertAdjacentElement("afterend", panel);
      }
    }
    const e = state.combat.enemy;
    if (panel) {
      if (!state.combat.inCombat || !e) {
        const recovery = ensure().recovery;
        panel.innerHTML = `<div class="text-slate-400">${escapeHtml(text("Manual turns · Read intent, attack, guard or interrupt. Auto-hunt is optional.", "手动回合 · 观察意图，选择攻击、防御或打断。可另开自动狩猎。"))}</div>${recovery ? `<div class="text-amber-300">${escapeHtml(text(`Lost purse: ${recovery.gold}g at ${WORLD_ROOMS[recovery.roomId]?.title || recovery.roomId}`, `遗失钱袋：${recovery.gold}金币，位于${WORLD_ROOMS[recovery.roomId]?.titleZh || recovery.roomId}`))}</div>` : ""}`;
      } else {
        normalizeEnemy(e);
        const intent = intentNames[e.intent] || intentNames.strike;
        const profile = bossProfiles[e.id], phase = profile && profile.phases[(e.phase || 1) - 1];
        panel.innerHTML = `<div class="flex justify-between font-semibold text-rose-200"><span>${escapeHtml(text(e.name, e.nameZh))}</span><span>${e.hp}/${e.maxHp} HP · ${text("Turn", "回合")} ${e.round + 1}</span></div><div class="bg-slate-800 rounded h-1"><div class="bg-rose-500 rounded h-1" style="width:${Math.max(0, e.hp / e.maxHp * 100)}%"></div></div>${phase ? `<div class="text-purple-200">${text("Phase", "阶段")} ${e.phase || 1}: ${escapeHtml(text(phase[0], phase[1]))}</div><div class="text-slate-400">${escapeHtml(text(profile.hint[0], profile.hint[1]))}</div>` : ""}<div class="text-amber-200">${escapeHtml(text(intent[0], intent[1]))}</div><div class="flex flex-wrap gap-1">${[["attack", "⚔️ Strike", "⚔️ 攻击"], ["guard", "🛡️ Guard", "🛡️ 防御"], ["interrupt", "⚡ Interrupt 18 STA", "⚡ 打断18体力"], ["flee", "🏃 Flee 10 STA", "🏃 撤退10体力"]].map(a => `<button type="button" onclick="CombatDirector.action('${a[0]}')" class="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-600">${text(a[1], a[2])}</button>`).join("")}</div>`;
      }
    }
    const forge = document.getElementById("btn-roll-affix");
    if (forge) forge.textContent = text(`🎲 Forge set gear · ${90 + state.player.level * 25}g + ore`, `🎲 锻造套装 · ${90 + state.player.level * 25}金币+矿石`);
    const refine = document.getElementById("btn-refine-weapon");
    if (refine) refine.title = text("Requires a forge, gold and ore. Maximum +12, gated by hero level.", "需要熔炉、金币与矿石。最高+12，并受角色等级限制。");
  }
  function install() {
    computeSetMultipliers = sets;
    getEquippedSetCounts = () => sets().counts;
    computeDerivedStats = derived;
    engageMob = engage; processCombatRound = () => action("attack"); useSkill = idx => action("skill", idx);
    handleEnemyDefeated = victory; handlePlayerDefeated = defeat; castOverdriveUltimate = () => action("ultimate");
    runWorldTick = tick; rollDiabloAffixLoot = forgeLoot;
    const oldAdd = addItemToInventory;
    addItemToInventory = function(id, qty = 1) { if (!ITEM_CATALOG[id] || !Number.isSafeInteger(qty) || qty <= 0 || qty > 9999) return false; oldAdd(id, qty); return true; };
    const oldRemove = removeItemFromInventory;
    removeItemFromInventory = function(id, qty = 1) { if (!Number.isSafeInteger(qty) || qty <= 0) return false; return oldRemove(id, qty); };
    equipOrUseItem = function(id) {
      ensure(); const p = state.player, i = ITEM_CATALOG[id];
      if (onlineBusy()) return reportBlocked("Equipment and supplies are locked during an online battle.", "在线战斗期间不能更换装备或使用离线补给。");
      if (!i || !(p.inventory[id] > 0)) return false;
      if (i.type === "consumable" && state.combat.inCombat) return action("potion", id);
      if (i.type === "equipment" && !peaceful()) return false;
      if (i.requiredLevel > p.level) return reportBlocked(`Requires level ${i.requiredLevel}.`, `需要角色达到${i.requiredLevel}级。`);
      if (i.type === "consumable" && p.hp === p.maxHp && p.mp === p.maxMp && p.sta === p.maxSta) return reportBlocked("Vitals are full; potion preserved.", "状态已满，保留药剂。");
      legacy.equip(id); emit(i.type === "equipment" ? "equip" : "use_item", { itemId: id }); return true;
    };
    useQuickPotion = function() {
      const p = state.player;
      const names = Object.keys(p.inventory).filter(k => p.inventory[k] > 0 && ITEM_CATALOG[k]?.type === "consumable");
      names.sort((a, b) => {
        const score = k => { const i = ITEM_CATALOG[k]; return Math.min(i.healHp || 0, p.maxHp - p.hp) * 2 + Math.min(i.healMp || 0, p.maxMp - p.mp) + Math.min(i.healSta || 0, p.maxSta - p.sta) - i.value * .05; };
        return score(b) - score(a);
      });
      if (names.length) return equipOrUseItem(names[0]);
      return reportBlocked("No usable potion in the pack.", "背包中没有可用药剂。");
    };
    buyShopItem = function(id) { if (!atFacility("shop") || !SHOP_ITEMS.includes(id)) return false; const gold = state.player.gold; legacy.buy(id); if (state.player.gold < gold) emit("buy", { itemId: id }); };
    sellInventoryItem = function(id) { if (!atFacility("shop") || ITEM_CATALOG[id]?.type === "key") return false; const gold = state.player.gold; legacy.sell(id); if (state.player.gold > gold) emit("sell", { itemId: id }); };
    const oldSellAll = sellAllCommonLoot;
    sellAllCommonLoot = function() { if (!atFacility("shop")) return false; oldSellAll(); emit("sell", { bulk: true }); };
    craftRecipe = function(id) {
      if (!id) return false;
      const query = String(id).toLowerCase();
      const rec = CRAFTING_RECIPES.find(r => r.id === id || r.output.toLowerCase().includes(query) || (ITEM_CATALOG[r.output]?.nameZh || "").includes(query));
      if (!rec) return false;
      const i = ITEM_CATALOG[rec.output];
      if (!atFacility(i.type === "equipment" ? "forge" : "alchemy")) return false;
      const required = ({ common: 1, uncommon: 1, rare: 3, epic: 6, mythic: 9 })[i.rarity] || 1;
      if (state.player.level < required) return reportBlocked(`This recipe requires level ${required}.`, `该配方需要${required}级。`);
      const before = state.telemetry.crafted; legacy.craft(rec.id);
      if (state.telemetry.crafted > before) { emit("craft", { itemId: rec.output }); saveGameState(false); }
    };
    refineEquippedGear = function() {
      if (!atFacility("forge")) return false;
      const p = state.player, next = p.refineLevel + 1, cap = Math.min(12, 2 + Math.floor(p.level / 2));
      if (next > cap) return reportBlocked(`Refinement cap at your level: +${cap}.`, `当前等级的精炼上限为+${cap}。`);
      const mat = next <= 3 ? "Copper Ore" : next <= 6 ? "Silver Ore" : next <= 9 ? "Mythril Ore" : "Star-Metal", gold = next * 60;
      if (p.gold < gold || !(p.inventory[mat] >= 1)) return reportBlocked(`Refine +${next}: ${gold}g + 1 ${mat}.`, `精炼+${next}需要${gold}金币与1份${ITEM_CATALOG[mat].nameZh}。`);
      p.gold -= gold; removeItemFromInventory(mat, 1); p.refineLevel = next; derived();
      say(`✨ Equipment refined to +${next} (+${next * 12}% equipment stats).`, `✨ 全身装备精炼至+${next}（装备属性+${next * 12}%）。`, "loot"); emit("refine", { rank: next }); saveGameState(false); renderAll(); return true;
    };
    harvestRoomNodes = function() {
      if (!peaceful()) return false;
      const p = state.player, r = room(), ready = (r?.nodes || []).filter(n => !state.world.harvestedCooldowns[`${r.id}:${n.id}`]);
      if (!ready.length) return legacy.harvest();
      const cost = Math.max(2, 6 - Math.min(4, p.talents.pathfinder));
      if (p.sta < cost) return reportBlocked(`Harvesting needs ${cost} stamina.`, `采集需要${cost}点体力。`);
      p.sta -= cost;
      const before = state.telemetry.harvests; legacy.harvest();
      if (state.telemetry.harvests > before) {
        if (getActiveCompanion().id === "golem") {
          const oreNode = ready.find(n => /Ore|Metal/.test(n.item)); if (oreNode) addItemToInventory(oreNode.item, 1);
        }
        for (const b of state.quests.bounties) if (!b.claimed && b.targetHarvests && ready.length > 1) b.progress = Math.min(b.targetHarvests, b.progress + ready.length - 1);
        emit("harvest", { nodes: ready.length });
      }
      renderAll();
    };
    startRiftWaveChallenge = function() {
      if (!peaceful()) return false;
      const p = state.player;
      if (p.level < 3) return reportBlocked("The Endless Rift opens at level 3.", "无尽裂隙需要达到3级。");
      if (!room()?.riftPortal && state.world.currentRoom !== "r_guild_hall") return reportBlocked("Enter a rift portal or visit the Guild Hall to challenge the Rift.", "请在裂隙传送门或公会大厅开启挑战。");
      const wave = (state.telemetry.riftBestWave || 0) + 1, scale = 1 + wave * .40;
      state.telemetry.activeRiftWave = wave;
      return startEncounter({ id: "rift_archon_" + wave, name: `Rift Archon (Wave ${wave})`, nameZh: `裂隙执政官（第${wave}波）`, level: wave + 2, boss: true, isRiftWave: true, wave, hp: Math.round(180 * scale), atk: Math.round(28 * scale), def: Math.round(12 * scale), xp: Math.round(140 * scale), gold: Math.round(65 * scale), drops: ["Aether Crystal", "Greater Healing Elixir"] });
    };
    setStance = function(value) { if (onlineBusy()) return reportBlocked("Finish the online battle before changing your offline stance.", "请先结束在线战斗，再修改离线战斗姿态。"); if (!["balanced", "aggressive", "defensive"].includes(value)) return false; state.player.stance = value; derived(); emit("stance", { stance: value }); renderAll(); return true; };
    allocateStat = function(key) { if (!["str", "int", "agi", "vit"].includes(key) || state.player.statPoints < 1 || !peaceful()) return false; state.player.statPoints--; state.player.stats[key]++; derived(); emit("stat", { stat: key }); renderAll(); return true; };
    learnTalent = function(key) {
      if (!["warlord", "mystic", "pathfinder"].includes(key) || state.player.talentPoints < 1 || !peaceful()) return false;
      if (state.player.talents[key] >= 5) return reportBlocked("Talent rank is capped at 5.", "该天赋最高为5阶。");
      state.player.talentPoints--; state.player.talents[key]++; derived(); emit("talent", { talent: key, rank: state.player.talents[key] }); renderAll(); return true;
    };
    cycleCompanion = function() {
      if (!peaceful()) return false;
      ensure();
      const unlocked = [true, state.world.visitedRooms.length >= 4, state.world.defeatedBosses.includes("boss_garrick"), state.telemetry.crafted >= 3];
      let next = state.fun.companionIdx;
      for (let step = 1; step <= 4; step++) { const n = (state.fun.companionIdx + step) % 4; if (unlocked[n]) { next = n; break; } }
      state.fun.companionIdx = next;
      const pet = getActiveCompanion();
      say(`Companion: ${pet.name}. Owl: explore 4 rooms; drake: defeat Garrick; golem: craft 3 times.`, `伙伴：${pet.nameZh}。灵鸮：探索4个房间；幼龙：击败加里克；魔像：完成3次合成。`, "world"); renderAll();
    };
    executeCommand = function(raw) {
      const cmd = String(raw || "").trim(), parts = cmd.split(/\s+/), verb = parts[0].toLowerCase(), query = parts.slice(1).join(" ").toLowerCase();
      if (["defend", "guard", "block", "防御", "格挡"].includes(verb)) return action("guard");
      if (["interrupt", "打断"].includes(verb)) return action("interrupt");
      if (["flee", "run", "retreat", "逃跑", "撤退"].includes(verb)) return action("flee");
      if (["rest", "sleep", "heal", "休息"].includes(verb)) return rest();
      if (["recover", "取回"].includes(verb)) return recover();
      const matchItem = ids => ids.find(id => id.toLowerCase() === query) || ids.find(id => { const item = ITEM_CATALOG[id]; return item && (id.toLowerCase().includes(query) || item.name.toLowerCase().includes(query) || (item.nameZh || "").toLowerCase().includes(query)); });
      if (["use", "quaff", "drink", "equip", "eq", "使用", "装备"].includes(verb)) {
        if (!query) return useQuickPotion();
        const id = matchItem(Object.keys(state.player.inventory));
        return id ? equipOrUseItem(id) : reportBlocked("That item is not in your pack.", "背包里没有对应物品。");
      }
      if (["sell", "出售"].includes(verb)) {
        if (!query || query === "all" || query === "全部") return sellAllCommonLoot();
        const id = matchItem(Object.keys(state.player.inventory));
        return id ? sellInventoryItem(id) : reportBlocked("That item is not in your pack.", "背包里没有对应物品。");
      }
      if (["buy", "购买"].includes(verb)) {
        if (!query) { switchRightTab("crafting"); return; }
        const id = matchItem(SHOP_ITEMS);
        return id ? buyShopItem(id) : reportBlocked("The merchant does not stock that item.", "商店没有出售该物品。");
      }
      return legacy.command(raw);
    };
    applyCharacterConfig = function() {
      const p = state.player, input = document.getElementById("input-hero-name"), newName = input?.value?.trim() || p.name;
      if (!peaceful()) return false;
      if (p.classId !== selectedClassOption) {
        if (!CLASS_CONFIG[selectedClassOption] || !room()?.safe) return reportBlocked("Change class at a safe settlement.", "请在安全据点变更职业。");
        const cost = p.level > 1 ? p.level * 30 : 0;
        if (p.gold < cost) return reportBlocked(`Class respecialization costs ${cost} gold.`, `重新选择职业需要${cost}金币。`);
        const old = CLASS_CONFIG[p.classId].baseStats, refunded = ["str", "int", "agi", "vit"].reduce((n, k) => n + Math.max(0, p.stats[k] - old[k]), 0);
        p.gold -= cost; p.statPoints += refunded; p.classId = selectedClassOption;
        const b = CLASS_CONFIG[p.classId].baseStats; p.stats = { str: b.str, int: b.int, agi: b.agi, vit: b.vit };
        p.cooldowns = [0, 0, 0]; p.buffs = []; p.buffTurns = {}; derived();
        say(`Class changed. ${refunded} allocated attribute points refunded; cost ${cost}g.`, `职业已变更，退还${refunded}个已分配属性点，花费${cost}金币。`, "world");
      }
      p.name = newName.slice(0, 40); closeModal("char-modal"); saveGameState(false); renderAll();
    };
    renderAll = function() { ensure(); legacy.render(); render(); };
    COMPANION_ROSTER[0].bonusEn = "Pet strike; bleed every 3 hits"; COMPANION_ROSTER[0].bonusZh = "协战；每3次攻击施加流血";
    COMPANION_ROSTER[1].bonusEn = "+20% combat XP/gold; +2 mana per turn"; COMPANION_ROSTER[1].bonusZh = "战斗经验金币+20%；每回合法力+2";
    COMPANION_ROSTER[2].bonusEn = "Strong pet strike; burn every 3 hits"; COMPANION_ROSTER[2].bonusZh = "较强协战；每3次攻击施加灼烧";
    COMPANION_ROSTER[3].bonusEn = "18% less incoming damage; +1 ore per harvest"; COMPANION_ROSTER[3].bonusZh = "受到伤害-18%；采矿额外获得1份矿石";
    DIABLO_SETS.stormcaller.bonus2En = "(2pc) +25% ATK/MAG; lightning every third hit";
    DIABLO_SETS.stormcaller.bonus2Zh = "(2件)攻魔+25%；每第3次命中追加闪电";
    DIABLO_SETS.stormcaller.bonus4En = "(4pc) +50% skill damage; bonus storm nova on skills";
    DIABLO_SETS.stormcaller.bonus4Zh = "(4件)技能伤害+50%；技能追加风暴新星";
    DIABLO_SETS.warlord.bonus4En = "(4pc) Critical multiplier 2.10x; +20% ATK/MAG below half HP";
    DIABLO_SETS.warlord.bonus4Zh = "(4件)暴击倍率2.10；半血以下攻魔+20%";
    DIABLO_SETS.singularity.bonus4En = "(4pc) +40% attributes/combat stats/vitals; Void Nova on ultimate";
    DIABLO_SETS.singularity.bonus4Zh = "(4件)属性、战斗数值及生命法力体力上限+40%；必杀追加虚空爆发";
    UI_I18N.en.warlordDesc = "+8% ATK / +3% leech"; UI_I18N.zh.warlordDesc = "+8%物攻 / +3%吸血";
  }
  install();
  return { ensure, action, startEncounter, grantLoot, rest, recover, render, getIntent: () => state.combat.enemy?.intent || null,
    setSeedForTests(seed) { ensure().rng = (Number(seed) >>> 0) || 1; },
    getContext() {
      ensure();
      const p = state.player, e = state.combat.enemy, d = derived(), cfg = CLASS_CONFIG[p.classId] || CLASS_CONFIG.vanguard;
      const intent = e && (intentNames[e.intent] || intentNames.strike), profile = e && bossProfiles[e.id];
      return {
        rules: "manual_turns_v10", control: state.autoHunt ? "auto_hunt" : "manual", inCombat: !!state.combat.inCombat, onlineBattleActive: onlineBusy(),
        player: { hp: p.hp, maxHp: p.maxHp, mp: p.mp, maxMp: p.maxMp, stamina: p.sta, maxStamina: p.maxSta, stance: p.stance, attack: d.atk, magic: d.mag, defense: d.def, critPercent: d.crit, lifestealPercent: d.lifesteal, overdrive: state.fun.overdrive, buffs: { ...p.buffTurns } },
        enemy: e ? { id: e.id, name: e.name, nameZh: e.nameZh, level: e.level, boss: !!e.boss, hp: e.hp, maxHp: e.maxHp, intent: e.intent, intentEn: intent[0], intentZh: intent[1], turn: (e.round || 0) + 1, phase: profile ? (e.phase || 1) : null, phaseName: profile ? text(...profile.phases[(e.phase || 1) - 1]) : null, tacticalHint: profile ? text(...profile.hint) : null, effects: Object.entries(e.effects || {}).map(([name, value]) => ({ name, turns: value.turns, damagePerTurn: value.power })) } : null,
        skills: cfg.skills.map((s, i) => ({ index: i, name: s.name, nameZh: s.nameZh, cooldown: p.cooldowns[i] || 0, cost: s.cost, pool: s.costType, effect: s.effect, available: !!state.combat.inCombat && !onlineBusy() && !(p.cooldowns[i] > 0) && p[s.costType] >= s.cost })),
        equipment: slots.map(slot => { const id = p.equipment[slot], item = ITEM_CATALOG[id]; return item ? { slot, id, name: item.name, nameZh: item.nameZh, setId: item.setId || null, procs: item.procs || (item.proc ? [item.proc] : []), lifesteal: item.lifesteal || 0 } : { slot, id: null }; }),
        equippedSets: sets().counts, companion: { id: getActiveCompanion().id, name: getActiveCompanion().name, nameZh: getActiveCompanion().nameZh },
        decisions: e ? { guard: "reduces incoming damage by 65% this turn; restores 18 STA and 8 MP", interrupt: { staminaCost: 18, canPay: p.sta >= 18, effectiveNow: ["cast", "charge"].includes(e.intent) }, flee: { staminaCost: 10, canPay: p.sta >= 10, guaranteed: !e.boss || ["charge", "recover"].includes(e.intent) }, ultimate: { minimumCharge: 50, available: state.fun.overdrive >= 50 }, potionConsumesTurn: true } : null,
        economy: { safeSettlement: !!room()?.safe, randomForgeGold: 90 + p.level * 25, refineCap: Math.min(12, 2 + Math.floor(p.level / 2)), currentRefine: p.refineLevel },
        recovery: ensure().recovery || null
      };
    }
  };
})();
