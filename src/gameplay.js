/* Aethelgard campaign director. Authored outcomes own the rules; AI may add prose only. */
const GameDirector = (() => {
  'use strict';
  const bi = (en, zh) => ({en, zh});
  const text = value => typeof value === 'string' ? value : (value && value[getLang() === 'zh' ? 'zh' : 'en']) || '';
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const factions = {
    town: bi('Oakhaven', '橡木港'), rangers: bi('The Rangers', '荒野游侠'),
    echoes: bi('The Unbound', '自由亡魂'), forge: bi('The Forgekin', '熔炉族裔'), astral: bi('Rift Scholars', '裂隙学者')
  };
  const outcome = (en, zh, effects = {}) => ({text: bi(en, zh), effects});
  const choice = (id, en, zh, result, extra = {}) => ({id, label: bi(en, zh), result, ...extra});
  const encounter = (id, room, en, zh, openingEn, openingZh, choices, extra = {}) => ({id, room, title: bi(en, zh), opening: bi(openingEn, openingZh), choices, ...extra});

  const encounters = [
    encounter('first_oath', 'r_town_square', 'A crack in the well', '复苏之井的裂纹',
      'Elder Thorne holds a broken bronze seal. The well has begun to whisper names of people who have not died. He needs a traveler, not another promise. How will you begin?',
      '索恩长老托着一枚断裂的铜印。复苏之井开始低语尚在人世者的名字。他需要一位真正出发的旅人，而非又一个承诺。你将如何开始？', [
        choice('guardian', 'Swear to protect the missing', '承诺守护失踪者', outcome('Thorne entrusts you with a field remedy. Elara at the northern ranger camp is waiting for news. Your first promise is written in the journal.', '长老把一瓶野外药剂交给你。北方营地的艾拉拉正在等消息。你的第一个承诺已写入日志。', {items:{'Minor Healing Draught':1}, trust:{town:2}, flags:{oath_guardian:true}, xp:10})),
        choice('scholar', 'Study the broken seal', '研究铜印的裂口', outcome('Three marks survive: ROOT, MEMORY, and FIRE. They are instructions for repairing the Rift, not a spell to conquer it.', '铜印残留三个印记：根、记忆、火焰。它们是修复裂隙的方法，不是征服它的咒语。', {trust:{astral:1}, flags:{seal_lore:true}, xp:18}), {cost:{sta:6}}),
        choice('contract', 'Ask for a paid commission', '要求签订报酬契约', outcome('Thorne advances a modest purse. He expects results. You may still earn his trust by the choices you make beyond the gate.', '长老预付了一小袋钱。他期待成果。走出城门后的选择，仍能为你赢得信任。', {gold:18, flags:{oath_contract:true}}))
      ]),
    encounter('tavern_courier', 'r_tavern', 'The empty chair', '空着的椅子',
      'Mara keeps a bowl of stew warm for a courier who never returned. His last note mentions a wounded ranger beside the forest trail and a wheel turning against the stream.',
      '玛拉给一位未归的信使温着炖汤。他最后的字条提到林间小径旁受伤的游侠，以及一架逆着水流转动的水车。', [
        choice('help', 'Leave a healing draught for the search party', '为搜救队留下一瓶药剂', outcome('Mara tells the rangers that you can be trusted. She marks the old mill on your journal map.', '玛拉会告诉游侠，你值得信任。她在你的日志地图上标出了旧磨坊。', {trust:{town:1,rangers:1}, flags:{courier_route:true}, xp:15}), {cost:{items:{'Minor Healing Draught':1}}}),
        choice('buy', 'Buy the courier’s route notes', '买下信使的路线笔记', outcome('The route passes the mill, then Silverbrook Ford. A penciled note reads: “The menhir answers the roots, never the crown.”', '路线经过磨坊和银溪浅滩。铅笔注记写着：“立石回应根，不回应冠。”', {flags:{courier_route:true,menhir_hint:true}, xp:10}), {cost:{gold:12}}),
        choice('listen', 'Listen, and promise to look for him', '倾听，并承诺寻找他', outcome('You record his trail. Mara asks for no grand oath—only that you notice the people who need help along it.', '你记下了路线。玛拉不要宏大的誓言，只希望你留意路上真正需要帮助的人。', {flags:{courier_route:true}, trust:{town:1}}))
      ]),
    encounter('brom_apprentice', 'r_blacksmith', 'A blade for the apprentice', '学徒的第一把剑',
      'Brom’s youngest apprentice has ruined the guard patrol’s last copper fittings. Brom can mend them, or finish the shield he promised you. There is metal for only one job.',
      '布罗姆最年轻的学徒毁掉了巡逻队最后一批铜配件。大师可以修好它们，也可以完成答应给你的圆盾。现有金属只能完成一项工作。', [
        choice('donate', 'Supply two copper ore and save both jobs', '提供两块铜矿，两件事都完成', outcome('The apprentice remembers your kindness. Brom gives you his oakheart buckler and sends word to Borin in Emberpeak.', '学徒记住了你的善意。布罗姆把橡心圆盾交给你，并向烬峰的博林捎去口信。', {items:{'Oakheart Buckler':1}, trust:{forge:2,town:1}, flags:{brom_letter:true}, xp:15}), {cost:{items:{'Copper Ore':2}}}),
        choice('patrol', 'Let the patrol have the metal', '优先修复巡逻队的装备', outcome('Brom cannot spare a shield, but he lends you a spare remedy. “Borin will hear of this.”', '布罗姆拿不出盾牌，但给你一瓶备用药剂。“博林会知道这件事。”', {items:{'Minor Healing Draught':1}, trust:{forge:1,town:1}, flags:{brom_letter:true}})),
        choice('shield', 'Take the promised shield', '领取约定的圆盾', outcome('A promise is a promise. You leave with the shield, while the patrol waits another night.', '约定就是约定。你带着圆盾离开，巡逻队还得再等一晚。', {items:{'Oakheart Buckler':1}, trust:{town:-1}, flags:{shield_first:true}}))
      ]),
    encounter('wounded_scout', 'r_wilds_trail', 'A whistle in the bracken', '蕨丛中的哨声',
      'A ranger lies beneath a snapped branch. A blue courier ribbon is tied around her wrist. Her pack contains a sealed message—and the medicine she can no longer reach.',
      '一位游侠倒在折断的树枝下，手腕系着蓝色信使缎带。背包里有一封密信，还有她已经够不到的药。', [
        choice('medicine', 'Use your healing draught', '用自己的药剂救她', outcome('The ranger breathes again. “Tell Elara: Garrick hides behind borrowed courage. When he lifts his cleaver, defend.” She will meet you at the camp.', '游侠重新喘过气。“告诉艾拉拉：加里克靠虚张声势。他举起重刀时，先防御。”她会在营地与你会合。', {trust:{rangers:3}, flags:{scout_saved:true,bandit_hint:true}, xp:25}), {cost:{items:{'Minor Healing Draught':1}}}),
        choice('lift', 'Lift the branch and bind the wound', '抬起树枝并包扎伤口', outcome('You free her and fashion a splint. The sealed message survives. Elara now has a reason to trust you.', '你救出她，并做了简易夹板。密信完好无损，艾拉拉会因此信任你。', {trust:{rangers:2}, flags:{scout_saved:true}, xp:30}), {cost:{sta:10}, check:{stat:'str',dc:12}, failure:outcome('The branch slips. You are bruised, but you leave her a safe shelter and signal the camp. The rescue takes longer.', '树枝滑落，你被擦伤。你为她搭好遮蔽处并向营地发出信号，救援需要更久。', {damagePct:0.12, trust:{rangers:1}, flags:{scout_signalled:true}, xp:8})}),
        choice('purse', 'Take the loose purse and leave', '拿走散落的钱袋，转身离开', outcome('There are coins in the purse and a child’s drawing beneath them. Someone at the camp will recognize the ribbon you left behind.', '钱袋里有硬币，下面压着孩子的画。营地里会有人认出你遗落的缎带。', {gold:35, trust:{rangers:-3}, flags:{scout_abandoned:true}}))
      ]),
    encounter('mill_wheel', 'r_old_mill', 'The backward waterwheel', '逆转的水车',
      'The wheel turns upstream. A split copper pin jams an old rune under the axle. You can repair the flow, force open the strongbox, or study the unnatural motion.',
      '水车逆流而转。轴下断裂的铜销卡住了一枚古老符文。你可以修好水流、撬开钱箱，或研究这种反常的运动。', [
        choice('repair', 'Replace the copper pin', '更换铜销', outcome('The mill turns with the river again. Flour reaches Oakhaven, and the mechanism yields a silver fragment marked ROOT.', '水车重新顺流转动。面粉得以送回橡木港，机关中掉出刻着“根”的银片。', {items:{'Silver Ore':1}, trust:{town:2}, flags:{mill_repaired:true,menhir_hint:true}, xp:30}), {cost:{items:{'Copper Ore':1},sta:8}}),
        choice('force', 'Pry open the strongbox', '用力撬开钱箱', outcome('The lid breaks. You recover the miller’s emergency purse, but the copper mechanism sinks beneath the water.', '箱盖裂开，你拿到磨坊主的应急钱袋，铜机关却沉入水下。', {gold:45, trust:{town:-1}, xp:10}), {cost:{sta:10},check:{stat:'str',dc:14},failure:outcome('A splintered gear catches your hand. The rotting strongbox collapses into the stream.', '破裂的齿轮夹伤了你的手，腐朽的钱箱坠入水流。', {damagePct:0.15,xp:6})}),
        choice('study', 'Sketch the counterflow rune', '描摹逆流符文', outcome('The diagram repeats the shape of the menhir’s roots. Knowledge travels more easily than this broken machine.', '图样重复着立石根部的形状。知识比这架损坏的机器更容易带走。', {flags:{menhir_hint:true},trust:{astral:1},xp:22}),{cost:{mp:6}})
      ]),
    encounter('menhir_root', 'r_ancient_menhir', 'The first seal: root', '第一道封印：根',
      'Three hollows surround the oldest stone: a crown above, a branch at eye level, and a root near the soil. The inscription reads: “What holds the forest when its kings have fallen?”',
      '最古老的石柱上有三个凹槽：上方的王冠、齐眼的树枝，以及近地的树根。铭文写着：“林中诸王倒下之后，是什么仍托住森林？”', [
        choice('root', 'Place your hand on the root', '把手放在树根印记上', outcome('The stones answer with a heartbeat. A ROOT sigil forms in your palm. You have learned the first part of the Rift’s repair.', '巨石回应以心跳。一枚“根”印记在掌心成形。你得到了修复裂隙的第一部分。', {flags:{sigil_root:true},shards:1,xp:45,trust:{rangers:1}})),
        choice('crown', 'Claim the crown', '选择王冠', outcome('A cold spark throws you back. The stone keeps its silence. The forest does not recognize another ruler.', '冰冷的火花将你击退。巨石归于沉默，森林不需要另一个统治者。', {damagePct:0.18,flags:{menhir_scorn:true},xp:8})),
        choice('branch', 'Take a rubbing without touching the seal', '不碰封印，只拓印图样', outcome('You preserve the inscription for the scholars. Its power remains in the ground.', '你为学者保存了铭文，力量仍留在大地之中。', {items:{'Aether Crystal':1},trust:{astral:2},xp:20}))
      ]),
    encounter('elara_plan', 'r_hunter_camp', 'Two routes into Thornwood', '攻入荆棘木的两条路',
      'Elara scratches two routes into the ash. A frontal assault is direct; the drainage ditch is quieter. She will risk her people only for someone who has earned their trust.',
      '艾拉拉在炉灰中划出两条路线。正面进攻直接，排水沟则更隐蔽。她只愿意为赢得信任的人冒险派出同伴。', [
        choice('allies', 'Ask the rangers to guide you', '请求游侠协助侦察', outcome('The scouts return with Garrick’s watch schedule and emergency supplies. Their trust will matter again at the Rift.', '侦察队带回加里克的巡逻时刻和应急物资。他们的信任还会在裂隙前发挥作用。', {items:{'Minor Healing Draught':2},flags:{ranger_alliance:true,bandit_hint:true},trust:{rangers:1},xp:20}),{require:{trust:{rangers:2}}}),
        choice('scout', 'Scout the ditch yourself', '亲自侦察排水沟', outcome('You map the blind corner beneath the palisade. Garrick winds up his heavy strikes before committing; keep a defense ready.', '你标记了木寨下的视线死角。加里克的重击有明显蓄力，预留一次防御。', {flags:{bandit_hint:true},xp:25}),{cost:{sta:8},check:{stat:'agi',dc:11},failure:outcome('A sentry spots you and sends an arrow through your cloak. You escape with the patrol pattern, at a price.', '哨兵发现你，一箭穿过斗篷。你付出代价，仍带回巡逻规律。', {flags:{bandit_hint:true},damagePct:0.1,xp:12})}),
        choice('stand', 'Promise to face him openly', '决定堂堂正正迎战', outcome('Elara respects the answer. She gives you a small field ration, but warns that courage still needs preparation.', '艾拉拉尊重你的选择。她给你少量补给，也提醒你勇气仍需要准备。', {items:{'Moonpetal Herb':2},trust:{rangers:1},xp:12}))
      ]),
    encounter('river_cart', 'r_river_ford', 'The cart in the current', '急流中的货车',
      'A merchant’s cart hangs between two stepping stones. Medicine is washing downstream; a locked coin chest is still within reach. You have time to save one load.',
      '商人的货车悬在两块踏脚石之间。药物正被冲向下游，上锁的钱箱仍在手边。你只来得及救下一份货物。', [
        choice('medicine', 'Rescue the medicine', '抢救药物', outcome('The merchant shares a vial with you. Refugees in Oakhaven will remember where the rest came from.', '商人分给你一瓶药。橡木港的难民会记得其余药物是如何送来的。', {items:{'Arcane Mana Vial':1},trust:{town:2},flags:{medicine_caravan:true},xp:30}),{cost:{sta:12}}),
        choice('chest', 'Secure the coin chest for a fee', '约定报酬后救起钱箱', outcome('The merchant pays what he promised. The medicines are lost, but his caravan can afford to travel again.', '商人如约付款。药物已经流失，但他的车队还能重新出发。', {gold:45,flags:{merchant_contract:true},xp:12}),{cost:{sta:8}}),
        choice('both', 'Try a rope maneuver to save both', '用绳索尝试同时救下两份货物', outcome('Your knot holds. The merchant saves his livelihood and sends the medicine ahead under your name.', '绳结牢牢撑住。商人保住生计，并以你的名义送出药物。', {gold:25,items:{'Minor Healing Draught':1},trust:{town:3},flags:{medicine_caravan:true},xp:35}),{cost:{sta:14},check:{stat:'agi',dc:16},failure:outcome('The rope snaps. You reach shore exhausted; neither load survives.', '绳索绷断，你筋疲力尽地爬上岸，两份货物都没能保住。', {damagePct:0.16,xp:10})})
      ]),
    encounter('bandit_ledger', 'r_bandit_stronghold', 'Names in Garrick’s ledger', '加里克账册里的名字',
      'With Garrick defeated, his quartermaster surrenders a ledger. Some bandits were debtors. The stolen funds can rebuild the road, buy their freedom, or fill your purse.',
      '加里克败落后，军需官交出一本账册。有些匪徒只是债务缠身。赃款可以修路、赎回他们的自由，也可以装进你的钱袋。', [
        choice('rebuild', 'Return the funds to the villages', '把赃款归还村庄', outcome('The road belongs to travelers again. Oakhaven recognizes you as a protector rather than the next toll collector.', '道路重新属于旅人。橡木港把你视为守护者，而非下一位收过路费的人。', {trust:{town:3,rangers:1},flags:{road_rebuilt:true},xp:55})),
        choice('amnesty', 'Offer the debtors a ranger probation', '给欠债者一次加入巡防的机会', outcome('Elara accepts them under watch. Mercy has a cost, but it also leaves people alive to repay it.', '艾拉拉答应监督他们服役。仁慈有代价，也给人留下报答的机会。', {trust:{rangers:2},flags:{bandit_amnesty:true},items:{'Silver Ore':2},xp:40})),
        choice('keep', 'Keep the treasury as your reward', '把库款作为自己的战利品', outcome('You carry away the treasury. The ledger remains on the throne, with the villagers’ names still unpaid.', '你带走了库款。账册留在王座上，村民名字旁的欠款仍未归还。', {gold:110,trust:{town:-2},flags:{bandit_treasury:true},xp:15}))
      ], {require:{boss:'boss_garrick'}}),
    encounter('bone_ferry', 'r_ossuary', 'A ferryman with no face', '无面摆渡人',
      'A boat assembled from old doors drifts between the tombs. The faceless ferryman asks for a silver coin or a true memory. Behind him glimmers a dry passage.',
      '一艘由旧门板拼成的小船漂在坟墓之间。无面摆渡人索要一枚银币，或一段真实的记忆。船后闪着一条干燥通道。', [
        choice('silver', 'Pay with a silver ore', '以一块银矿支付渡资', outcome('He takes the silver without a word. A lantern on the far bank restores your breathing and strength.', '他无言收下银矿。对岸的灯火让你的呼吸与体力逐渐恢复。', {healPct:0.4,sta:20,flags:{ferry_pass:true},xp:30}),{cost:{items:{'Silver Ore':1}}}),
        choice('memory', 'Tell him whom you hope to bring home', '告诉他你希望带谁回家', outcome('A face briefly appears beneath the hood. “Then remember our names as well.” You learn the first line of the bell prayer.', '兜帽下短暂显出一张脸。“那么，也记住我们的名字。”你学会了钟祷的第一句。', {trust:{echoes:2},flags:{bell_hint:true,ferry_pass:true},xp:35}),{cost:{mp:8}}),
        choice('walk', 'Take the flooded passage instead', '选择涉水走过去', outcome('You cross by the wall, shivering but unbound by any bargain.', '你贴着石墙涉水而过，浑身发抖，却未许下任何交易。', {damagePct:0.08,flags:{ferry_refused:true},xp:18}),{cost:{sta:8}})
      ]),
    encounter('vesper_names', 'r_drowned_nave', 'The choir that forgot its names', '忘记名字的唱诗班',
      'Sister Vesper holds a book whose ink vanishes as she reads. Malakor kept the voices but erased their names. Three surviving bells are labeled MERCY, GLORY, and SILENCE.',
      '维斯珀修女捧着一本边读边消失的名册。马拉科尔留下声音，却抹去名字。幸存的三口钟分别标着“慈悲”“荣耀”“沉默”。', [
        choice('remember', 'Copy every remaining name', '抄下所有尚存的名字', outcome('You finish before the last line fades. Vesper whispers: “Ring mercy first. A memory freely given can never be chained.”', '最后一行消失前，你抄完了名册。修女低语：“先敲响慈悲。自由赠予的记忆永远不会被锁住。”', {trust:{echoes:3},flags:{names_saved:true,bell_hint:true},xp:45}),{cost:{sta:10}}),
        choice('power', 'Read the binding formula instead', '研究束缚灵魂的公式', outcome('The spell is elegant and terrible. You gain knowledge, while more names vanish from the book.', '法术精妙而可怕。你获得知识时，名册上的名字继续消失。', {items:{'Aether Crystal':1},trust:{astral:1,echoes:-2},flags:{binding_formula:true},xp:35}),{cost:{mp:10}}),
        choice('comfort', 'Stay beside the choir until the song ends', '陪伴唱诗班唱完最后一曲', outcome('You cannot save every name, but no one sings alone. Vesper points you toward the reliquary’s bell of mercy.', '你无法救下每一个名字，但没有人独自歌唱。修女为你指出圣物宝库中的慈悲之钟。', {trust:{echoes:2},flags:{bell_hint:true},healPct:0.2,xp:25}))
      ]),
    encounter('forbidden_page', 'r_scriptorium', 'The page that reads you', '阅读你的书页',
      'A loose page spells your name before you touch it. It offers the secret of the Lich’s tether. A warning underneath says the reader must leave something behind.',
      '一张散页在你触碰前便写出你的名字。它愿意揭示巫妖魂链的秘密，下方警告则说：读者必须留下些什么。', [
        choice('decode', 'Decode the tether without touching the page', '不碰书页，解读魂链结构', outcome('The tether links Malakor to stolen memories. You map a weak point and preserve the page for the liberated choir.', '魂链把马拉科尔与被盗记忆相连。你找到弱点，并为重获自由的唱诗班保留了书页。', {flags:{lich_hint:true,page_saved:true},trust:{astral:2},xp:55}),{cost:{mp:10},check:{stat:'int',dc:15},failure:outcome('The letters flare. You learn the weak point, but a pulse of cold magic burns through your guard.', '文字突然灼亮。你看清了弱点，也被冰冷的魔法穿透防护。', {flags:{lich_hint:true},damagePct:0.15,xp:25})}),
        choice('burn', 'Burn the page and free its captive voice', '烧毁书页，释放囚禁的声音', outcome('The ash forms a name before scattering. The choir grows clearer, and the reliquary responds to your presence.', '灰烬短暂组成一个名字，然后散开。唱诗声变得清晰，圣物宝库回应着你的到来。', {trust:{echoes:2},flags:{page_freed:true,bell_hint:true},xp:35})),
        choice('bargain', 'Trade twenty coins for the knowledge', '以二十枚金币换取知识', outcome('The page consumes the coins and reveals the tether’s rhythm. Nothing says it will honor another bargain.', '书页吞下金币，揭示魂链的节律。没有任何承诺保证它会遵守下一笔交易。', {flags:{lich_hint:true},xp:28}),{cost:{gold:20}})
      ]),
    encounter('memory_bell', 'r_reliquary', 'The second seal: memory', '第二道封印：记忆',
      'Three bells hang above a sealed reliquary. One remembers kindness, one victories, and one only endings. “What should outlive a kingdom?” asks the lock.',
      '三口钟悬在封印圣物匣上方。一口记得善意，一口记得胜利，另一口只记得终结。“什么应该比王国活得更久？”锁孔问道。', [
        choice('mercy', 'Ring the bell of mercy', '敲响慈悲之钟', outcome('The smallest bell carries the farthest. The MEMORY sigil joins your journey, keeping the lost names alive.', '最小的钟声传得最远。“记忆”印记加入旅程，让逝去者的名字继续存在。', {flags:{sigil_memory:true},trust:{echoes:1},shards:2,xp:65})),
        choice('glory', 'Ring the bell of glory', '敲响荣耀之钟', outcome('The vault releases an old war treasury. Its power fades with the names of the kings who filled it.', '宝库吐出古老的战争库金，它的力量随那些国王的名字一同褪去。', {gold:85,flags:{relic_glory:true},xp:20})),
        choice('silence', 'Silence all three bells', '让三口钟一同沉默', outcome('The restless echoes fall quiet. The seal remains closed, but a gentle warmth mends your wounds.', '不安的残响归于平静。封印仍然紧闭，柔和的暖意却愈合了你的伤口。', {healPct:0.5,trust:{echoes:1},flags:{relic_silence:true},xp:25}))
      ]),
    encounter('freed_souls', 'r_lich_sanctum', 'What remains of the soul-chain', '魂链留下了什么',
      'Malakor has fallen. A last knot of bound souls hovers above the brazier. You can untie it patiently, break it now, or keep the energy for the war ahead.',
      '马拉科尔已经倒下。最后一团被缚灵魂悬在火盆上方。你可以耐心解开结，立刻击碎它，或把能量留给下一场战争。', [
        choice('release', 'Untie the chain one name at a time', '逐一念出名字，解开魂链', outcome('The choir departs toward a dawn you cannot see. Their gratitude will stand beside you when the Rift asks its final question.', '唱诗班走向你看不见的黎明。裂隙问出最后一个问题时，他们的感激会站在你身边。', {trust:{echoes:3},flags:{souls_freed:true},shards:2,xp:70}),{cost:{mp:12}}),
        choice('break', 'Break the chain before it can reform', '立即击碎魂链，防止重聚', outcome('One bright flash ends the curse. The names are lost, but no new soul will be taken by this brazier.', '耀眼闪光终结了诅咒。名字已经遗失，但这只火盆不会再囚禁新的灵魂。', {trust:{town:1},flags:{chain_broken:true},items:{'Greater Healing Elixir':1},xp:45})),
        choice('keep', 'Bind the residue to an aether crystal', '把残余能量束入以太水晶', outcome('The crystal is warm with borrowed lives. It grants power and leaves the sanctum very, very quiet.', '水晶因借来的生命而温暖。你得到力量，圣所却变得异常寂静。', {items:{'Aether Crystal':3},trust:{echoes:-3},flags:{souls_bound:true},xp:55}))
      ],{require:{boss:'boss_malakor'}}),
    encounter('borin_valves', 'r_dwarven_gate', 'Pressure behind the gate', '城门后的压力',
      'Borin’s relief valve is failing. Beyond it, trapped forge workers hammer a rescue signal through the pipe. Silver can seal the valve, or a precise bypass can divert the pressure.',
      '博林的泄压阀即将失效。被困的熔炉工人隔着管道敲出求救信号。银料能封住阀门，精准的旁路也能导走压力。', [
        choice('silver', 'Seal the valve with two silver ore', '用两块银矿修复阀门', outcome('The gate opens. The workers recognize Brom’s craftsmanship in your repair and offer a forge supply cache.', '城门开启。工人在修复处认出布罗姆的工艺，把一份熔炉补给交给你。', {items:{'Mythril Ore':1},trust:{forge:3},flags:{workers_saved:true,forge_hint:true},xp:65}),{cost:{items:{'Silver Ore':2}}}),
        choice('bypass', 'Design a pressure bypass', '计算并打开旁路', outcome('The gauge falls into the green. Every worker walks out. Borin repeats the furnace sequence: vent, feed, then ignite.', '压力表回到绿色区域，所有工人都走了出来。博林重复炉子操作顺序：泄压、进料、再点火。', {trust:{forge:3},flags:{workers_saved:true,forge_hint:true},xp:70}),{cost:{sta:10},check:{stat:'int',dc:18,boostFlag:'brom_letter'},failure:outcome('The bypass leaks scalding steam. Borin pulls you clear and completes the repair himself; the workers survive, but the supplies are lost.', '旁路喷出灼热蒸汽。博林拉开你并完成修复。工人幸存，补给却毁了。', {damagePct:0.18,trust:{forge:1},flags:{forge_hint:true},xp:20})}),
        choice('brace', 'Hold the failing wheel while Borin works', '撑住阀轮，让博林修理', outcome('Your arms shake, but the wheel holds. Borin gets everyone out and shows you the furnace’s safe ignition order.', '你的双臂颤抖，阀轮却稳住了。博林救出所有人，并告诉你熔炉的安全点火顺序。', {trust:{forge:2},flags:{workers_saved:true,forge_hint:true},xp:45}),{cost:{sta:20},require:{stat:{str:12}}})
      ]),
    encounter('furnace_fire', 'r_slag_foundry', 'The third seal: fire', '第三道封印：火',
      'A dormant furnace bears the last bronze mark. Its gauge is in the red; three levers read VENT, FEED, and IGNITE. The inscription says: “Power without a path consumes its keeper.”',
      '休眠的熔炉上刻着最后一道铜印。压力表停在红区，三根拉杆写着“泄压”“进料”“点火”。铭文提醒：“没有通路的力量会吞噬掌握它的人。”', [
        choice('vent', 'Vent the chamber, then feed and ignite', '先泄压，再进料与点火', outcome('Heat flows through the intended channels. The FIRE sigil cools into a mark you can carry. The furnace belongs to its workers again.', '热量沿正确通道流动。“火”印记冷却成可携带的符号，熔炉重新属于工人。', {flags:{sigil_fire:true,furnace_restored:true},trust:{forge:2},shards:2,xp:85}),{cost:{sta:8}}),
        choice('ignite', 'Ignite at full pressure for maximum output', '在满压下点火，追求最大产出', outcome('A violent surge yields precious metal, then ruptures the ancient channels. The bronze seal melts beyond recovery.', '猛烈脉冲喷出珍贵金属，随后冲破古老通道。铜印融化，无法复原。', {items:{'Mythril Ore':2},damagePct:0.22,trust:{forge:-2},flags:{furnace_ruptured:true},xp:30})),
        choice('cold', 'Shut the furnace down and salvage its stock', '关闭熔炉，回收现有物料', outcome('The hall becomes safe and cold. Its stored supplies will help you, although the old fire will never return.', '大厅变得安全而冰冷。储备物料能帮助你，古老炉火却不会再回来。', {items:{'Silver Ore':2,'Firebloom':1},flags:{furnace_closed:true},xp:35}))
      ]),
    encounter('bridge_rescue', 'r_lava_bridge', 'The last lift', '最后一架升降台',
      'A lift clings to one chain above the lava. On it wait a smith and a crate of royal mythril. Your rope can carry the smith; the crate needs a dangerous second crossing.',
      '一架升降台靠最后一根锁链悬在岩浆上方。铁匠和一箱皇家秘银困在上面。绳索足以救人，救箱子则需要危险的第二趟穿越。', [
        choice('smith', 'Rescue the smith and leave the crate', '救下铁匠，放弃箱子', outcome('The smith reaches solid ground. She promises that Emberpeak will remember who valued a life above an ingot.', '铁匠终于踩上实地。她保证，烬峰会记得是谁把生命看得比金属更重。', {trust:{forge:3},flags:{smith_saved:true},items:{'Greater Healing Elixir':1},xp:70}),{cost:{sta:12}}),
        choice('both', 'Attempt both crossings', '尝试把人与货物都救下来', outcome('You return through the heat with the smith and the royal cache. Borin has a new story to tell.', '你穿过热浪，带回铁匠和皇家物资。博林又多了一个可讲的故事。', {trust:{forge:3},flags:{smith_saved:true},items:{'Mythril Ore':2},xp:90}),{cost:{sta:18},check:{stat:'agi',dc:20},failure:outcome('You save the smith, but the second chain parts. The crate vanishes; your cloak catches fire before you roll it out.', '你救下铁匠，第二根锁链却断了。箱子消失，斗篷也被点燃，直到你翻滚扑灭。', {trust:{forge:2},flags:{smith_saved:true},damagePct:0.2,xp:35})}),
        choice('signal', 'Signal Borin and secure the near anchor', '向博林示警，并固定近端锚点', outcome('The rescue takes longer, but the smith survives. You leave without a reward, knowing the anchor will hold.', '救援花了更久，铁匠仍然幸存。你没有领取报酬，但知道锚点已经稳固。', {trust:{forge:1},flags:{smith_saved:true},xp:30}),{cost:{sta:8}})
      ]),
    encounter('geode_echo', 'r_crystal_cavern', 'A future in the crystal', '水晶里的未来',
      'A pillar shows three possible futures: a sealed sky, a city ruled from the Rift, and bridges of living light. None is inevitable. The crystal will answer one question.',
      '晶柱显出三个未来：封闭的天空、由裂隙统治的城市，以及活光构成的桥。没有一个是注定的。水晶只能回答一个问题。', [
        choice('bridges', 'Ask how the bridges are made', '询问光桥如何建成', outcome('ROOT gives shape, MEMORY gives purpose, FIRE gives motion. Allies must hold the anchors while the Architect falls. You record the possibility of a restored sky.', '根赋予形状，记忆赋予目的，火赋予运动。盟友须在建筑师倒下时守住锚点。你记录下修复天空的可能。', {flags:{restoration_lore:true},trust:{astral:2},xp:65}),{cost:{mp:12}}),
        choice('survive', 'Ask how to survive the final ascent', '询问如何活着登上终点', outcome('The crystal shows the Herald winding his glaives, then the Architect gathering a collapsing star. Their power has a rhythm. Watch before you strike.', '水晶显出先驱蓄势挥戟、建筑师凝聚坍缩星辰。力量有自己的节律，出手前先观察。', {flags:{astral_hint:true},items:{'Greater Healing Elixir':1},xp:45})),
        choice('shard', 'Take a crystal shard for your equipment', '取一块晶片用于装备', outcome('The futures fade as the shard breaks free. A practical gift can still carry you toward a choice you have not yet made.', '晶片脱落，未来的画面随之消失。务实的礼物仍能带你走向尚未做出的选择。', {items:{'Aether Crystal':2},xp:30}),{cost:{sta:10}})
      ]),
    encounter('rift_anchor', 'r_rift_breach', 'The anchor under strain', '承受重压的锚点',
      'Researcher Kaelen is holding a landing ward alone. He can keep the road home open, or record the Rift’s final transformation. He needs help deciding what must survive.',
      '研究员凯伦独自维持着登陆结界。他只能保住回家的路，或记录裂隙最后的变化。他需要帮助，决定什么必须留下。', [
        choice('road', 'Reinforce the way home', '加固回家的道路', outcome('The ward steadies. Survivors will have a path back, whatever happens above.', '结界稳定下来。无论上方发生什么，幸存者都会有路回家。', {trust:{astral:2,town:1},flags:{return_anchor:true},xp:70}),{cost:{items:{'Aether Crystal':1}}}),
        choice('record', 'Help record the transformation', '帮助记录裂隙变化', outcome('You secure the instruments. Kaelen identifies an old three-seal circuit within the observatory; knowledge may yet change the ending.', '你固定仪器。凯伦在观星台中识别出古老的三印回路，知识或许仍能改变结局。', {trust:{astral:3},flags:{restoration_lore:true},xp:75}),{cost:{mp:18}}),
        choice('watch', 'Take the watch while he rests', '替他守望，让他休息片刻', outcome('For a little while, someone else carries the burden. Kaelen gives you the last prepared mana vial.', '有一小会儿，终于有人替他承担重担。凯伦把最后一瓶备好的法力药剂交给你。', {trust:{astral:1},items:{'Arcane Mana Vial':1},flags:{kaelen_rested:true},xp:40}),{cost:{sta:15}})
      ]),
    encounter('chrono_self', 'r_chrono_gallery', 'The person you might have been', '你本可能成为的人',
      'Your reflection steps out of a broken hourglass. It carries every reward you left behind, and none of the people you helped. “Was it worth it?” it asks.',
      '你的倒影从破碎沙漏中走出。它带着你放弃的每一份财富，身边却没有任何你帮助过的人。“值得吗？”它问。', [
        choice('people', 'Name the people who are still alive', '说出那些仍然活着的人的名字', outcome('The reflection has no answer for a name. It leaves a clear hourglass behind: a reminder that time spent helping was not lost.', '倒影无法回答一个名字。它留下透明沙漏，提醒你帮助他人的时间并没有白费。', {trust:{echoes:1,astral:1},flags:{self_reconciled:true},shards:2,xp:75})),
        choice('power', 'Accept the reflection’s accumulated wealth', '接受倒影积攒的财富', outcome('The coins feel real. The reflection takes your place in the glass and watches you leave.', '硬币真实而沉重。倒影代替你留在玻璃中，注视着你离开。', {gold:140,flags:{echo_bargain:true},trust:{echoes:-1},xp:30})),
        choice('question', 'Ask which future the reflection fears', '询问倒影最害怕哪个未来', outcome('“The one with no one left to remember me.” You carry that answer toward the observatory.', '“再也没有任何人记得我的未来。”你带着这个答案走向观星台。', {flags:{restoration_lore:true},trust:{astral:2},xp:65}),{cost:{mp:10}})
      ]),
    encounter('observatory_lens', 'r_celestial_observatory', 'The sky’s true center', '天空真正的中心',
      'The brass armillary has a socket for a ruler’s crown and three smaller sockets for shared anchors. A diagram places the world below the stars, not beneath a throne.',
      '黄铜浑天仪留有一个王冠插槽，以及三个较小的共同锚点。图上，世界位于星空之下，而非王座之下。', [
        choice('anchors', 'Calibrate the three shared anchors', '校准三个共同锚点', outcome('The lens aligns ROOT, MEMORY, and FIRE. The restoration circuit is ready. Whether it can hold depends on the allies and seals you preserved.', '透镜对齐根、记忆与火。修复回路已就绪，能否稳住取决于你保留的封印与盟友。', {flags:{lens_aligned:true,restoration_lore:true},trust:{astral:1},xp:90}),{cost:{items:{'Aether Crystal':1},sta:10}}),
        choice('crown', 'Calibrate the crown socket', '校准王冠插槽', outcome('The lens focuses all power into one point. It is a way to command the Rift, if you decide the price is yours to pay.', '透镜把所有力量聚为一点。这是一种号令裂隙的方法，代价也必须由你承担。', {flags:{crown_aligned:true},shards:3,xp:65}),{cost:{mp:15}}),
        choice('map', 'Map a safe route through the stars', '绘出穿过群星的安全路线', outcome('You map the Herald’s platform and a retreat corridor. The work is useful even if no one ever wears a crown.', '你绘出先驱的平台和撤退通道。即使再没有人戴上王冠，这份工作仍有意义。', {flags:{astral_hint:true,return_anchor:true},items:{'Greater Healing Elixir':1},xp:55}),{cost:{sta:12}})
      ]),
    encounter('conduit_choice', 'r_void_conduit', 'Where the last stars flow', '最后的星辰流向何处',
      'A damaged conduit sends its energy toward the Architect. You can divert it to the refugees’ anchor, crystallize it for supplies, or burn through it to weaken the ritual.',
      '损坏的导管把能量送向建筑师。你可以把能量引向难民锚点、凝成补给，或烧毁导管来削弱仪式。', [
        choice('shelter', 'Feed the refugees’ anchor', '把能量送往难民锚点', outcome('Distant lights stop flickering. The road home is now more than a promise.', '远方的灯火不再闪烁。回家的道路不再只是一个承诺。', {trust:{town:2,astral:1},flags:{refugees_sheltered:true,return_anchor:true},xp:90}),{cost:{mp:15}}),
        choice('supplies', 'Crystallize the remaining energy', '把残余能量凝成物资', outcome('The stars leave two dense fragments and a final healing charge. You will enter the next battle prepared.', '星辰留下两块致密碎片和一次治愈能量，你将更充分地迎接下一战。', {items:{'Star-Metal':2},healPct:0.35,xp:50}),{cost:{sta:12}}),
        choice('sever', 'Sever the ritual channel', '切断仪式通道', outcome('The channel fractures. You learn the Architect’s gathering rhythm, though the backlash scorches your armor.', '通道断裂。你看清建筑师聚能的节律，反冲也灼伤了铠甲。', {flags:{astral_hint:true,ritual_severed:true},damagePct:0.12,shards:2,xp:85}))
      ]),
    encounter('final_choice', 'r_astral_core', 'What will you leave in the sky?', '你将把什么留在天空？',
      'The Architect is defeated. For the first time, the Rift is silent. The broken seal from Oakhaven warms in your hand. The ending belongs to your choices, and to everyone who carried you here.',
      '建筑师已被击败。裂隙第一次如此安静。橡木港那枚断裂铜印在掌心发热。结局属于你的选择，也属于一路托住你的人。', [
        choice('restore', 'Restore the bridges between worlds', '修复连接世界的光桥', outcome('ROOT holds the shape, MEMORY remembers the people, and FIRE gives the bridges life. Your allies hold the anchors. Aethelgard chooses connection without a conqueror. The sky opens, and the road home remains.', '根托住形状，记忆留住人们，火让光桥生长。盟友们守住锚点。艾瑟尔加德选择连结而非征服。天空敞开，归路仍在。', {flags:{ending_restoration:true},ending:'restoration',shards:5,xp:200}),{require:{flags:['sigil_root','sigil_memory','sigil_fire','lens_aligned'],alliance:6}}),
        choice('seal', 'Seal the Rift and bring everyone home', '封闭裂隙，带大家回家', outcome('You turn the seal outward. The Rift folds into a single quiet star. Magic will be rarer, but tonight the wells whisper no names. Aethelgard has another dawn, and you have a road back to it.', '你把铜印朝向外侧。裂隙收束为一颗安静的星。魔法将更稀少，但今夜水井不再低语名字。艾瑟尔加德迎来新的黎明，你仍有路回去。', {flags:{ending_guardian:true},ending:'guardian',shards:3,xp:150})),
        choice('rule', 'Take the empty throne', '坐上空缺的王座', outcome('The Rift bends to your will. The sky is brighter, and every road leads to your throne. Your journal closes on a question no courtier will ask: who will open it when your hand can no longer hold the seal?', '裂隙服从你的意志。天空更明亮，每条道路却都通向你的王座。日志以一个无人敢问的问题结束：当你再也握不住铜印时，谁来打开它？', {flags:{ending_sovereign:true},ending:'sovereign',gold:250,shards:4,xp:150}),{require:{anyFlags:['crown_aligned','souls_bound','binding_formula']}})
      ],{require:{boss:'boss_xalkorath'}})
  ];

  const discoveryRows = [
    ['r_town_square','A broken seal','断裂的铜印','The damaged seal bears three symbols: root, memory, fire. Thorne can explain why it matters.','铜印上有根、记忆、火三种符号。索恩长老知道它们的意义。','seal_lore'],
    ['r_tavern','A courier’s ribbon','信使的缎带','A blue ribbon on an empty chair points toward the forest trail.','空椅子上的蓝色缎带指向林间小径。','courier_route'],
    ['r_blacksmith','An old maker’s mark','旧工匠印记','Brom and Borin once shared this maker’s mark. A kind act here may travel farther than you.','布罗姆与博林曾共用这个工匠印记。在这里的一次善举，可能比你走得更远。',null],
    ['r_alchemist','Lyra’s field notes','莱拉的野外笔记','Moonpetal grows on the trail; copper lies at the mill. Remedies cost resources, so prepare before a boss fight.','月瓣草长在小径上，铜矿在磨坊。药物需要资源，挑战首领前先准备。',null],
    ['r_guild_hall','The three contracts','三份契约','Hunting, gathering, and elite contracts pay once each. Finishing one is better than endlessly replacing it.','狩猎、采集和精英契约每份只结算一次。完成契约才能获得报酬。',null],
    ['r_north_gate','Claw marks in the gate','城门上的爪痕','The first danger lies north. The ranger camp is a safe rest stop beyond the forest trail.','第一处危险在北方。穿过林间小径，游侠营地可供安全休整。',null],
    ['r_wilds_trail','A broken whistle','折断的哨子','A faint response comes from the bracken. Someone here needs help.','蕨丛中传来微弱回应，这里有人需要帮助。',null],
    ['r_old_mill','Marks under the axle','轮轴下的刻痕','The rune follows the shape of a root. The wheel was designed to guide a current, never to own it.','符文形似树根。水车原本用来引导水流，而非占有它。','menhir_hint'],
    ['r_mushroom_grove','A field of blue lights','蓝色微光的田野','The brightest caps are rich in mana. Luminous Cap is used in arcane supplies.','最明亮的菌伞富含法力，荧光菌伞是奥术补给的原料。',null],
    ['r_hunter_camp','Elara’s charcoal map','艾拉拉的炭笔地图','Garrick waits north. His biggest attack is announced by a raised cleaver.','加里克在北方等待。他举起重刀，意味着最沉重的打击即将落下。','bandit_hint'],
    ['r_ancient_menhir','Beneath the crown','王冠之下','The roots remain when the crown falls. The lowest mark is worn smooth by countless hands.','冠落之后，根仍然存在。最下方的印记被无数双手磨得光滑。','menhir_hint'],
    ['r_river_ford','The sunken stair','沉没的石阶','Down leads to the Catacombs; east leads to Emberpeak. The graves are the gentler next step.','向下通墓穴，向东通烬峰。相较之下，地宫是更适合下一步的区域。',null],
    ['r_bandit_stronghold','A debtor’s tally','欠债者的记号','The quartermaster’s ledger may explain why these people became bandits. Return after Garrick falls.','军需官的账册或许能解释他们为何落草。击败加里克后再来调查。',null],
    ['r_catacomb_stairs','Candle smoke beneath water','水下的烛烟','The voices are not all hostile. Sister Vesper waits beyond the ossuary to the east.','并非所有声音都怀有敌意。穿过万骨回廊向东，维斯珀修女在那里等待。',null],
    ['r_ossuary','A name scratched in silver','银上的名字','The ferryman accepts silver or memory. Not every passage must be won by a blade.','摆渡人接受银或记忆。并非每条路都必须用剑赢得。',null],
    ['r_drowned_nave','The shortest prayer','最短的祷词','“Mercy before glory.” It is repeated on every surviving choir stall.','“慈悲先于荣耀。”幸存的每个唱诗座上都重复着它。','bell_hint'],
    ['r_scriptorium','A diagram of the soul-chain','魂链结构图','Malakor draws strength in pulses. A disrupted ritual creates a chance to strike.','马拉科尔分次汲取力量。打断仪式，会创造出手时机。','lich_hint'],
    ['r_reliquary','The worn bell rope','磨损的钟绳','The smallest bell is marked MERCY. Its rope is the only one repaired by many different hands.','最小的钟标着慈悲，只有它的绳子被许多不同的人修补过。','bell_hint'],
    ['r_lich_sanctum','A knot after the battle','战后留下的结','When the Lich falls, the soul-chain still needs a decision. Victory alone does not free its captives.','巫妖倒下后，魂链仍等待一个决定。胜利本身不会释放囚徒。',null],
    ['r_cinder_pass','A rescue signal','求救信号','Hammer strikes echo from the eastern gate. Borin is holding back pressure for trapped workers.','东侧城门传来敲击声。博林正为被困工人撑住压力。',null],
    ['r_dwarven_gate','A relief-valve manual','泄压阀手册','Open the vent before feeding and igniting the furnace. A safe path comes before power.','进料和点火前先泄压。有安全通路，才能谈力量。','forge_hint'],
    ['r_slag_foundry','The red gauge','红色压力表','The chamber is already pressurized. Pulling IGNITE first will rupture it.','炉腔已经充满压力，先点火会把它冲破。','forge_hint'],
    ['r_obsidian_barracks','A worker’s evacuation chart','工人的疏散图','The geode cavern lies east; the lava bridge connects north. The dwarven gate is the nearest safe rest stop.','向东是晶洞，向北连吊桥。矮人城门是最近的安全休整处。',null],
    ['r_lava_bridge','A chain under load','承重的锁链','The lift cannot carry a person and its mythril cargo in one trip. Choose what matters before crossing.','升降台无法一趟带回人与秘银货物。跨越前先决定什么更重要。',null],
    ['r_crystal_cavern','Three futures','三种未来','Root, memory, fire—and willing allies—can rebuild what conquest tore apart.','根、记忆、火，加上自愿相助的盟友，能修复征服留下的裂痕。','restoration_lore'],
    ['r_caldera_throne','Cooling strike marks','正在冷却的锤痕','Ignis stores heat before an eruption. His posture tells you when to brace and when to answer.','伊格尼斯喷发前会积蓄热量。观察姿态，判断何时防守、何时反击。','forge_boss_hint'],
    ['r_rift_breach','A road held by one person','被一个人撑住的归路','Kaelen cannot hold every anchor alone. The help you choose here becomes part of the ending.','凯伦无法独自维持所有锚点。你在这里提供的帮助会成为结局的一部分。',null],
    ['r_chrono_gallery','An unspent hour','未耗尽的一小时','Your reflection can offer wealth, but it cannot recreate the people you helped.','倒影可以给你财富，却无法重现那些你帮助过的人。',null],
    ['r_celestial_observatory','The shared circuit','共同回路','Three seals fit the small sockets. A repaired sky also needs at least six points of trust across the factions.','三枚封印对应小插槽。修复天空还需要阵营间合计至少六点正向信任。','restoration_lore'],
    ['r_void_conduit','A path of escaping light','逸出之光的路径','Power can be carried home, hoarded, or severed. Every path has a cost written beside it.','力量可以被送回家、被储存，或被切断。每条路都有明确的代价。',null],
    ['r_throne_approach','The Herald’s footprint','先驱的脚印','The paired glaives leave a deliberate opening after their heavy arc. Read the next intent before acting.','双戟重扫后留有明确空隙。行动前先读清下一步意图。','astral_hint'],
    ['r_astral_core','An empty crown socket','空缺的王冠插槽','Defeating Xal’korath opens a final decision: seal, restore, or rule. Your journal keeps the consequences.','击败萨尔科拉斯后将迎来最后选择：封闭、修复或统治。日志会保留后果。',null]
  ];
  const discoveries = Object.fromEntries(discoveryRows.map(r => [r[0],{id:r[0],title:bi(r[1],r[2]),body:bi(r[3],r[4]),flag:r[5]}]));
  const byId = Object.fromEntries(encounters.map(e => [e.id,e]));
  let rendering = false;
  let resolving = false;
  let modalOpen = false;
  let modalTab = 'event';
  let returnFocus = null;
  let lastRenderKey = '';
  let narrationBusyToken = null;
  let narrationNotice = null;

  function ensureState() {
    if (!state.director || typeof state.director !== 'object' || Array.isArray(state.director)) state.director = {};
    const d = state.director;
    d.version = 1;
    if (!Number.isFinite(d.seed)) d.seed = Math.floor(Math.random()*0xFFFFFFFF) >>> 0;
    for (const k of ['completed','discoveries','flags','trust','milestones','actions','surveyCooldowns','skipped','guildTools']) {
      if (!d[k] || typeof d[k] !== 'object' || Array.isArray(d[k])) d[k] = {};
    }
    for (const k of Object.keys(factions)) d.trust[k] = Math.max(-9,Math.min(9,Number(d.trust[k])||0));
    if (!Array.isArray(d.journal)) d.journal = [];
    d.journal = d.journal.slice(-100);
    if (!Array.isArray(d.regions)) d.regions = [];
    if (!Array.isArray(d.bossesLogged)) d.bossesLogged = [];
    if (d.pending && (!byId[d.pending.id] || d.completed[d.pending.id])) d.pending = null;
    if (!byId[d.revisit] || d.completed[d.revisit]) d.revisit = null;
    for (const id of Object.keys(d.skipped)) if (!byId[id] || id === 'final_choice') delete d.skipped[id];
    for (const id of Object.keys(d.guildTools)) if (!['aether','forge','astral'].includes(id) || d.guildTools[id] !== true) delete d.guildTools[id];
    if (!d.ending || !['restoration','guardian','sovereign'].includes(d.ending)) d.ending = null;
    return d;
  }

  function record(id,title,body,kind='story',roomId=state.world.currentRoom) {
    const d=ensureState();
    if(d.journal.some(j=>j.id===id)) return;
    d.journal.push({id,title,body,kind,roomId,tick:state.tickCount||0});
    if(d.journal.length>100) d.journal.shift();
  }
  function notify(en,zh,color='text-sky-300') {
    if(typeof addLog==='function') addLog(en,'world',color,zh);
  }
  function persist() { if(typeof saveGameState==='function') saveGameState(false); }
  function canMutate() {
    if(typeof window.AethelgardApp?.canWrite==='function' && !window.AethelgardApp.canWrite()){notify('Another tab owns this save. Resume editing there or take control from the save notice.','另一标签页正在保存这份旅程，请在该页继续，或通过存档提示接管。');return false;}
    const busy=typeof OnlineRealm!=='undefined' && typeof OnlineRealm.isBusy==='function' && OnlineRealm.isBusy();
    if(busy)notify('Finish or leave the online battle before changing your solo journey.','请先完成或离开在线战斗，再推进单人旅程。');
    return !busy;
  }
  function hash(input) {
    let n=2166136261;
    for(let i=0;i<input.length;i++){n^=input.charCodeAt(i);n=Math.imul(n,16777619);}
    return n>>>0;
  }
  function allianceScore() { return Object.values(ensureState().trust).reduce((n,x)=>n+Math.max(0,x),0); }
  function requirementReason(req={}) {
    const d=ensureState(), p=state.player;
    if(req.boss && !(state.world.defeatedBosses||[]).includes(req.boss) && !STORY_QUESTS.some(q=>q.reqBoss===req.boss&&(state.quests.completed||[]).includes(q.id))) return bi('Defeat this region’s boss first.','先击败本区域首领。');
    if(req.flags && req.flags.some(f=>!d.flags[f])) return bi('Preserve all three seals and align the observatory’s shared anchors.','需要保留三枚封印，并校准观星台共同锚点。');
    if(req.anyFlags && !req.anyFlags.some(f=>d.flags[f])) return bi('Study a binding formula or align the crown socket first.','需要先研究束缚公式，或校准王冠插槽。');
    if(req.trust) for(const [key,min] of Object.entries(req.trust)) if((d.trust[key]||0)<min) return bi(`${factions[key].en} trust ${min} required.`,`需要${factions[key].zh}信任 ${min} 点。`);
    if(req.stat) for(const [key,min] of Object.entries(req.stat)) if((p.stats[key]||0)<min) return bi(`${key.toUpperCase()} ${min} required.`,`需要${statName(key).zh} ${min}。`);
    if(req.alliance && allianceScore()<req.alliance) return bi(`Positive faction trust ${req.alliance} required (now ${allianceScore()}).`,`需要合计 ${req.alliance} 点正向信任（当前 ${allianceScore()}）。`);
    return null;
  }
  function costReason(cost={}) {
    const p=state.player;
    for(const key of ['gold','sta','mp']) if((p[key]||0)<(cost[key]||0)) return bi(`Not enough ${key==='gold'?'gold':key.toUpperCase()}.`,`没有足够的${key==='gold'?'金币':key==='sta'?'体力':'法力'}。`);
    for(const [key,n] of Object.entries(cost.items||{})) if((p.inventory[key]||0)<n) return bi(`Need ${n} × ${key}.`,`需要 ${n} × ${(ITEM_CATALOG[key]||{}).nameZh||key}。`);
    return null;
  }
  function consume(cost={}) {
    for(const key of ['gold','sta','mp']) state.player[key]-=cost[key]||0;
    for(const [key,n] of Object.entries(cost.items||{})) {
      state.player.inventory[key]-=n;
      if(state.player.inventory[key]<=0) delete state.player.inventory[key];
    }
  }
  function statName(key) { return ({str:bi('STR','力量'),int:bi('INT','智力'),agi:bi('AGI','敏捷'),vit:bi('VIT','体质')})[key]||bi(key,key); }
  function chance(c) {
    if(!c.check) return 100;
    const d=ensureState(),boost=c.check.boostFlag && d.flags[c.check.boostFlag]?15:0;
    return Math.max(25,Math.min(90,55+((state.player.stats[c.check.stat]||0)-c.check.dc)*5+boost));
  }
  function effectsSummary(e={}) {
    const parts=[];
    for(const [key,label] of [['gold',bi('gold','金币')],['xp',bi('XP','经验')],['shards',bi('shards','碎片')],['sta',bi('STA','体力')]]) if(e[key]) parts.push(`${e[key]>0?'+':''}${e[key]} ${text(label)}`);
    if(e.healPct) parts.push(text(bi(`Restore ${Math.round(e.healPct*100)}% HP`,`恢复 ${Math.round(e.healPct*100)}% 生命`)));
    if(e.damagePct) parts.push(text(bi(`Lose ${Math.round(e.damagePct*100)}% max HP (nonfatal)`,`损失 ${Math.round(e.damagePct*100)}% 最大生命（不会致命）`)));
    for(const [key,n] of Object.entries(e.items||{})) parts.push(`+${n} ${getLang()==='zh'?((ITEM_CATALOG[key]||{}).nameZh||key):key}`);
    for(const [key,n] of Object.entries(e.trust||{})) parts.push(`${text(factions[key])} ${n>0?'+':''}${n}`);
    if(e.flags && Object.keys(e.flags).some(k=>k.startsWith('sigil_'))) parts.push(text(bi('A seal preserved','保留一枚封印')));
    if(e.ending) parts.push(text(bi('Defines your ending','决定故事结局')));
    return parts.join(' · ');
  }
  function costSummary(cost={}) {
    const arr=[];
    if(cost.gold) arr.push(`${cost.gold} ${text(bi('gold','金币'))}`);
    if(cost.sta) arr.push(`${cost.sta} ${text(bi('STA','体力'))}`);
    if(cost.mp) arr.push(`${cost.mp} ${text(bi('MP','法力'))}`);
    for(const [key,n] of Object.entries(cost.items||{})) arr.push(`${n} × ${getLang()==='zh'?((ITEM_CATALOG[key]||{}).nameZh||key):key}`);
    return arr.join(' · ')||text(bi('No resource cost','无需消耗资源'));
  }
  function applyEffects(e) {
    const d=ensureState(),p=state.player;
    p.gold=Math.max(0,(p.gold||0)+(e.gold||0));
    p.xp=Math.max(0,(p.xp||0)+(e.xp||0));
    p.shards=Math.max(0,(p.shards||0)+(e.shards||0));
    if(e.sta) p.sta=Math.min(p.maxSta,p.sta+e.sta);
    if(e.healPct) p.hp=Math.min(p.maxHp,p.hp+Math.round(p.maxHp*e.healPct));
    if(e.damagePct) p.hp=Math.max(1,p.hp-Math.round(p.maxHp*e.damagePct));
    for(const [key,n] of Object.entries(e.items||{})) if(ITEM_CATALOG[key]) addItemToInventory(key,n);
    for(const [key,n] of Object.entries(e.trust||{})) d.trust[key]=Math.max(-9,Math.min(9,(d.trust[key]||0)+n));
    Object.assign(d.flags,e.flags||{});
    if(e.ending) d.ending=e.ending;
  }
  function available(roomId=state.world.currentRoom) {
    const d=ensureState();
    return encounters.filter(e=>e.room===roomId&&!d.completed[e.id]&&!requirementReason(e.require));
  }
  function startEncounter(id) {
    if(!canMutate())return {ok:false,reason:'online_battle'};
    const d=ensureState();
    if(state.combat.inCombat) {notify('Finish or flee the battle before investigating.','先结束战斗或撤退，再进行调查。');return {ok:false,reason:'combat'};}
    const current=state.world.currentRoom;
    if(d.pending && d.pending.room===current && (!id||d.pending.id===id)) {open('event');return {ok:true,pending:d.pending};}
    const e=available(current).find(x=>!id||x.id===id);
    if(!e) {
      const locked=encounters.find(x=>x.room===current&&!d.completed[x.id]);
      if(locked) {const reason=requirementReason(locked.require);notify(reason.en,reason.zh);}
      else notify('This place has no unresolved story encounter. Investigate a landmark or follow your journey objective.','这里暂时没有未解决的故事事件。可以调查地标，或跟随旅程目标前进。');
      open('journal');return {ok:false,reason:locked?'locked':'complete'};
    }
    d.pending={id:e.id,room:current,token:`${d.seed}:${e.id}:${state.tickCount||0}`,startedTick:state.tickCount||0,narration:null};
    narrationNotice=null;
    d.lastOutcome=null;
    if(typeof CombatDirector!=='undefined')CombatDirector.stopHunt('story');
    else state.autoHunt=false;
    persist();open('event');render();
    if(typeof window.dispatchEvent==='function' && typeof CustomEvent==='function') window.dispatchEvent(new CustomEvent('aethelgard:encounter',{detail:{id:e.id,token:d.pending.token}}));
    return {ok:true,pending:d.pending};
  }
  function resolveChoice(index) {
    if(!canMutate())return {ok:false,reason:'online_battle'};
    const d=ensureState(),pending=d.pending;
    if(resolving||!pending||d.completed[pending.id]) return {ok:false,reason:'no_pending'};
    if(state.combat.inCombat||pending.room!==state.world.currentRoom) return {ok:false,reason:'location_or_combat'};
    const e=byId[pending.id],c=e.choices[index];
    if(!Number.isInteger(index)||!c) return {ok:false,reason:'invalid_choice'};
    const blocked=requirementReason(e.require)||requirementReason(c.require)||costReason(c.cost);
    if(blocked) {notify(blocked.en,blocked.zh);render();return {ok:false,reason:text(blocked)};}
    resolving=true;
    try {
      const roll=hash(`${d.seed}:${e.id}:${c.id}`)%100+1;
      const success=!c.check||roll<=chance(c);
      const result=success?c.result:c.failure;
      if(!result) throw new Error(`Missing authored outcome for ${e.id}/${c.id}`);
      consume(c.cost);
      // Consume the event before any reward can trigger rendering or an extra click.
      d.completed[e.id]={choice:c.id,success,roll:c.check?roll:null,tick:state.tickCount||0};
      delete d.skipped[e.id];if(d.revisit===e.id)d.revisit=null;
      d.pending=null;
      applyEffects(result.effects);
      d.lastOutcome={id:e.id,title:e.title,body:result.text,effects:result.effects,choice:c.label,success,roll:c.check?roll:null,chance:c.check?chance(c):null};
      record(`event:${e.id}`,e.title,result.text,'choice',e.room);
      notify(`◇ ${e.title.en}: ${result.text.en}`,`◇ ${e.title.zh}：${result.text.zh}`,'text-amber-200');
      if(typeof checkLevelUp==='function') checkLevelUp();
      if(typeof checkStoryQuests==='function') checkStoryQuests();
      if(typeof checkAchievements==='function') checkAchievements();
      sync();persist();
      if(typeof renderAll==='function') renderAll();
      modalTab='event';modalOpen=true;render();
      return {ok:true,id:e.id,choice:c.id,success,roll:c.check?roll:null,effects:result.effects};
    } finally {resolving=false;}
  }

  function discover() {
    if(!canMutate())return {ok:false,reason:'online_battle'};
    const d=ensureState(),room=state.world.currentRoom,def=discoveries[room];
    if(state.combat.inCombat){notify('Investigate after the battle.','战斗结束后才能调查。');return {ok:false,reason:'combat'};}
    if(!def){notify('You survey this frontier sector. Its rewards come from exploration and combat; no repeatable chest waits here.','你勘查了这片边境星区。这里的收益来自探索与战斗，没有可反复领取的宝箱。');return {ok:false,reason:'frontier'};}
    if(d.discoveries[room]){notify(def.body.en,def.body.zh);open('journal');return {ok:false,reason:'already_discovered'};}
    if(state.player.sta<5){notify('Investigating a landmark requires 5 STA. Rest or recover first.','调查地标需要 5 点体力。请先休息或恢复。');return {ok:false,reason:'stamina'};}
    state.player.sta-=5;
    d.discoveries[room]={tick:state.tickCount||0};
    if(def.flag)d.flags[def.flag]=true;
    const xp=5+Math.min(10,Number((WORLD_ROOMS[room]||{}).danger)||0)*2;
    state.player.xp+=xp;
    record(`discovery:${room}`,def.title,def.body,'discovery',room);
    notify(`⌖ ${def.title.en}: ${def.body.en} (+${xp} XP)`,`⌖ ${def.title.zh}：${def.body.zh}（+${xp} 经验）`,'text-emerald-200');
    if(typeof checkLevelUp==='function')checkLevelUp();
    persist();if(typeof renderAll==='function')renderAll();
    return {ok:true,roomId:room,xp};
  }

  function sync() {
    const d=ensureState(),room=WORLD_ROOMS[state.world.currentRoom];
    if(room && !d.regions.includes(room.biome)) {
      d.regions.push(room.biome);
      record(`region:${room.biome}`,bi(`Arrival: ${room.biome}`,`抵达：${(BIOME_META[room.biome]||{}).zh||room.biome}`),bi('A new region opens. Investigate its landmarks and speak with its people before you challenge its ruler.','新的区域展开了。挑战统治者前，先调查地标，了解住在这里的人。'),'region');
    }
    for(const q of STORY_QUESTS) if((state.quests.completed||[]).includes(q.id)&&!d.milestones[q.id]) {
      d.milestones[q.id]=true;
      record(`quest:${q.id}`,bi(q.title,q.titleZh),bi('A chapter objective is complete. Its rewards were granted by the campaign rules. Your next destination is in Journey.','本章目标已经完成，主线规则已结算奖励。新的目的地已显示在旅程中。'),'chapter');
    }
    for(const id of state.world.defeatedBosses||[]) if(!d.bossesLogged.includes(id)) {
      d.bossesLogged.push(id);
      const m=MOB_TEMPLATES[id]||{name:id,nameZh:id};
      record(`boss:${id}`,bi(`Defeated: ${m.name}`,`已击败：${m.nameZh}`),bi('Victory changes what can happen in this region. Check the Journey panel for unresolved consequences.','胜利改变了本区域可以发生的事。请在旅程中查看尚未解决的后续选择。'),'boss');
    }
    d.lastRoom=state.world.currentRoom;
  }
  function onAction(type,payload={}) {
    const d=ensureState();
    d.actions[type]=(d.actions[type]||0)+1;
    if(type==='combat_defeat')record(`defeat:${state.tickCount}:${d.actions[type]}`,bi('A costly return','付出代价的归来'),bi('You survived. Replenish supplies, read enemy intent, and return when prepared.','你活了下来。补充物资，读清敌人的意图，准备好再回来。'),'lesson');
    if(type==='move') {
      if(d.pending && d.pending.room!==state.world.currentRoom) close();
      if(typeof CombatDirector!=='undefined' && state.autoHunt)CombatDirector.stopHunt('moved');
    }
    sync();
    if(['combat_victory','combat_defeat','craft','equip','refine','move'].includes(type))persist();
    return d;
  }

  // Recommended story beats are guidance, not additional quest locks. Existing
  // saves continue their current chapter; every unresolved beat can be revisited.
  const chapterStories = {
    q1_wilds: ['tavern_courier','wounded_scout'],
    q2_bandit_king: ['brom_apprentice','mill_wheel','menhir_root','elara_plan'],
    q3_sunken_lich: ['bandit_ledger','river_cart','bone_ferry','vesper_names','forbidden_page','memory_bell'],
    q4_titan_forge: ['freed_souls','borin_valves','furnace_fire','bridge_rescue','geode_echo'],
    q5_astral_architect: ['rift_anchor','chrono_self','observatory_lens','conduit_choice']
  };
  function storyObjective(id, chapter, progress, extra={}) {
    const e=byId[id];
    return {chapter,target:e.room,event:id,label:bi(`Follow the lead: ${e.title.en}. Your choice prepares the next chapter.`, `跟随线索：${e.title.zh}。你的选择将为接下来的旅程做准备。`),progress,total:6,skippable:id!=='final_choice',...extra};
  }
  function objective() {
    const d=ensureState(),done=state.quests.completed||[],first=STORY_QUESTS.find(q=>!done.includes(q.id));
    if(d.revisit && !requirementReason(byId[d.revisit].require)) return storyObjective(d.revisit,bi('Return to an unfinished story','回访尚未处理的故事'),Math.min(5,done.length),{revisit:true});
    if(d.ending) return {chapter:bi('Epilogue · Your Aethelgard','终章余韵 · 你的艾瑟尔加德'),target:'r_town_square',label:bi('Return home, revisit unresolved stories, train companions or challenge the Endless Rift.','回家看看、回访尚未处理的故事、培养伙伴，或挑战无尽裂隙。'),progress:6,total:6};
    if(!d.completed.first_oath && !d.skipped.first_oath && !done.length)return storyObjective('first_oath',bi('Prologue · A promise at the well','序章 · 井边的承诺'),0,{label:bi('Speak with Thorne about the broken seal.','与索恩谈谈断裂的铜印。')});
    if(!first)return storyObjective('final_choice',bi('Epilogue · A sky of your choosing','终章 · 选择属于你的天空'),5,{label:bi('Choose the Rift’s future. Review unfinished leads in the journal before committing; sealing the Rift is always available.','决定裂隙的未来。做最后决定前，可在日志回访未完线索；封闭裂隙始终可选。')});
    const next=(chapterStories[first.id]||[]).find(id=>!d.completed[id]&&!d.skipped[id]&&!requirementReason(byId[id].require));
    if(next)return storyObjective(next,bi(first.title,first.titleZh),done.length,{quest:first.id});
    const map={q1_wilds:'r_wilds_trail',q2_bandit_king:'r_bandit_stronghold',q3_sunken_lich:'r_lich_sanctum',q4_titan_forge:'r_caldera_throne',q5_astral_architect:'r_astral_core'};
    return {chapter:bi(first.title,first.titleZh),target:map[first.id],label:bi(first.desc,first.descZh),quest:first.id,progress:done.length,total:6};
  }
  function skipObjective() {
    if(!canMutate()||state.combat.inCombat)return false;
    const d=ensureState(),o=objective();
    if(!o.skippable||!o.event)return false;
    d.skipped[o.event]=true;if(d.revisit===o.event)d.revisit=null;
    if(d.pending?.id===o.event)d.pending=null;
    const e=byId[o.event];
    record(`skip:${o.event}`,bi(`Lead postponed: ${e.title.en}`,`已暂缓线索：${e.title.zh}`),bi('No choice or reward was claimed. This story remains available from the journal, including before the ending.','没有替你做选择，也没有结算奖励。可随时从日志回访，包括最终结局之前。'),'lead',e.room);
    notify(`Skipped the recommendation for ${e.title.en}. Return from the journal whenever you wish.`,`已跳过「${e.title.zh}」的推荐步骤，故事仍可在日志回访。`);
    close();persist();renderAll();return true;
  }
  function revisit(id) {
    if(!canMutate()||state.combat.inCombat)return false;
    const d=ensureState(),e=byId[id];if(!e||d.completed[id])return false;
    const blocked=requirementReason(e.require);if(blocked){notify(blocked.en,blocked.zh);return false;}
    d.revisit=id;delete d.skipped[id];close();persist();renderAll();return true;
  }
  function unfinishedLeads() {
    const d=ensureState();
    return encounters.filter(e=>e.id!=='final_choice'&&!d.completed[e.id]).map(e=>({id:e.id,title:text(e.title),roomId:e.room,skipped:!!d.skipped[e.id],available:!requirementReason(e.require),reason:text(requirementReason(e.require))}));
  }
  function followObjective() {
    if(!canMutate())return false;
    const o=objective();
    if(state.combat.inCombat){notify('Finish the current battle before traveling.','请先结束当前战斗，再继续前进。');return false;}
    if(state.world.currentRoom===o.target){
      if(o.event)return startEncounter(o.event);
      const quest=STORY_QUESTS.find(q=>q.id===o.quest);
      if(quest){
        if(quest.reqItem&&(state.player.inventory[quest.reqItem]||0)<(quest.reqItemQty||1))return harvestRoomNodes();
        if(quest.reqBoss&&!state.world.defeatedBosses.includes(quest.reqBoss))return engageMob(quest.reqBoss);
        if(quest.reqKills&&state.telemetry.kills<quest.reqKills)return engageMob((WORLD_ROOMS[o.target].mobs||[])[0]);
        checkStoryQuests();
      }
      open('journal');return true;
    }
    const path=findShortestPath(state.world.currentRoom,o.target);
    if(path && path.length)return moveDirection(path[0]);
    return false;
  }
  function renderGuidance(o) {
    const badge=document.getElementById('smart-assistant-badge'),step=document.getElementById('smart-next-step-text'),button=document.getElementById('btn-proceed-next-step');
    let message=text(o.label),label=text(bi('Next journey step','旅程下一步')),act=followObjective;
    if(typeof OnlineRealm!=='undefined'&&OnlineRealm.isBusy()){
      message=text(bi('Your online battle is active. Use its battle panel to continue.','在线战斗正在进行，请通过在线战斗面板继续。'));
      label=text(bi('Open online battle','打开在线战斗'));act=()=>OnlineRealm.open();
    }else if(state.combat.inCombat&&state.combat.enemy&&typeof CombatDirector!=='undefined'){
      const context=CombatDirector.getContext(),recommendation=context.decisions?.recommendedAction;
      if(recommendation){
        const kind=recommendation.kind,skill=kind==='skill'?context.skills[recommendation.index]:null,item=kind==='potion'?ITEM_CATALOG[recommendation.itemId]:null;
        const names={attack:bi('Strike this turn','本回合攻击'),guard:bi('Guard this turn','本回合防御'),interrupt:bi('Interrupt · 18 STA','打断 · 18体力'),ultimate:bi('Use Overdrive','释放超载必杀'),flee:bi('Retreat · 10 STA','撤退 · 10体力')};
        message=text(bi(recommendation.reasonEn,recommendation.reasonZh));
        label=skill?text(bi(skill.name,skill.nameZh)):item?text(bi(`Use ${item.name}`,`使用${item.nameZh}`)):text(names[kind]||names.attack);
        act=()=>CombatDirector.action(kind,kind==='skill'?recommendation.index:recommendation.itemId);
      }
    }else if(state.world.currentRoom===o.target){
      const quest=STORY_QUESTS.find(q=>q.id===o.quest);
      if(o.event)label=text(bi('Make your choice','做出选择'));
      else if(quest?.reqItem&&(state.player.inventory[quest.reqItem]||0)<(quest.reqItemQty||1))label=text(bi('Gather supplies','采集任务物资'));
      else if(quest?.reqBoss&&!state.world.defeatedBosses.includes(quest.reqBoss))label=text(bi('Challenge the boss','挑战区域首领'));
      else if(quest?.reqKills&&state.telemetry.kills<quest.reqKills)label=text(bi('Hunt a local foe','挑战附近敌人'));
      else label=text(bi('Open journey journal','打开旅程日志'));
    }
    if(badge)badge.textContent=text(state.combat.inCombat?bi('⚔️ Combat turn','⚔️ 战斗回合'):bi('🧭 Your journey','🧭 你的旅程'));
    if(step){step.textContent=message;step.title=message;}
    if(button){button.textContent=label;button.title=message;button.onclick=act;}
  }
  function refreshContracts() {
    if(!canMutate())return {ok:false,reason:'online_battle'};
    if(state.combat.inCombat){notify('Contracts can wait until this battle ends.','本场战斗结束后再办理契约。');return {ok:false,reason:'combat'};}
    if(state.world.currentRoom!=='r_guild_hall'){notify('New contracts are issued at the Adventurers’ Guild Hall in Oakhaven.','新契约由橡木港冒险者公会大厅发放。');return {ok:false,reason:'guild_location'};}
    if((state.quests.bounties||[]).some(b=>!b.claimed)){notify('Finish and claim the current three contracts before taking a new board. Your existing progress is preserved.','请先完成并领取当前三份契约，再接下一批。当前进度已保留。');return {ok:false,reason:'unfinished_contracts'};}
    const d=ensureState();
    const tier=Math.max(1,Math.min(12,Math.floor(state.player.level)||1,1+(state.quests.completed||[]).length*2));
    const serial=(Number(d.contractSerial)||0)+1,minLevel=Math.max(1,tier-2),kills=3+Math.min(4,Math.floor(tier/3)),gathers=3+Math.min(3,Math.floor(tier/4));
    const prefix=`guild_${d.seed}_${serial}`;
    state.quests.bounties=[
      {id:`${prefix}_hunt`,desc:`Defeat ${kills} foes of level ${minLevel}+`,descZh:`击败 ${kills} 只 ${minLevel} 级以上敌人`,targetKills:kills,minEnemyLevel:minLevel,progress:0,rewardGold:25+tier*9,rewardXp:35+tier*15,claimed:false},
      {id:`${prefix}_supply`,desc:`Harvest ${gathers} resource nodes`,descZh:`采集 ${gathers} 处资源节点`,targetHarvests:gathers,progress:0,rewardGold:20+tier*5,rewardXp:25+tier*8,claimed:false},
      {id:`${prefix}_boss`,desc:`Defeat a level ${minLevel}+ region boss or Rift guardian`,descZh:`击败一名 ${minLevel} 级以上的区域首领或裂隙守护者`,targetBoss:1,minEnemyLevel:minLevel,progress:0,rewardGold:50+tier*13,rewardXp:65+tier*20,claimed:false}
    ];
    d.contractSerial=serial;
    record(`contracts:${serial}`,bi(`Guild board ${serial}`,`第 ${serial} 批公会契约`),bi('Three fresh contracts are issued. Their rewards reflect your campaign progress; complete the board before returning for another.','公会发下三份新契约。奖励依据你的主线进度制定，完成本批后再来领取下一批。'),'contract');
    notify('Three new guild contracts are ready. Enemy level requirements are listed on the board.','三份新公会契约已发布。敌人等级要求已写在任务板上。','text-purple-200');
    persist();if(typeof renderAll==='function')renderAll();return {ok:true,tier,serial};
  }
  function getContext() {
    sync();const d=ensureState(),o=objective(),e=d.pending&&byId[d.pending.id];
    return {
      chapter:text(o.chapter),objective:text(o.label),objectiveRoom:o.target,
      seals:{root:!!d.flags.sigil_root,memory:!!d.flags.sigil_memory,fire:!!d.flags.sigil_fire},
      trust:{...d.trust},allianceScore:allianceScore(),flags:{...d.flags},ending:d.ending,
      completedEncounters:Object.keys(d.completed),skippedRecommendations:Object.keys(d.skipped),unfinishedLeads:unfinishedLeads(),recommendedEvent:o.event||null,discoveryCount:Object.keys(d.discoveries).length,
      journal:d.journal.slice(-6).map(j=>({title:text(j.title),text:text(j.body),roomId:j.roomId})),
      encounter:e?{id:e.id,token:d.pending.token,title:text(e.title),opening:text(e.opening),roomId:e.room,
        choices:e.choices.map((c,index)=>({index,label:text(c.label),cost:costSummary(c.cost),check:c.check?{stat:c.check.stat,chance:chance(c)}:null,
          enabled:!(requirementReason(c.require)||costReason(c.cost)),reason:text(requirementReason(c.require)||costReason(c.cost)),effects:effectsSummary(c.result.effects)}))}:null,
      constraints:'Authored rules alone control rewards, costs, tests, trust and endings. Generated narrative must not claim additional items, completed choices or combat victories.'
    };
  }
  function setNarration(id,value,source='Local model',token) {
    const d=ensureState();
    if(!d.pending||d.pending.id!==id||(token&&d.pending.token!==token))return false;
    const content=String(value||'').trim().slice(0,1800);
    if(!content)return false;
    d.pending.narration={text:content,source:String(source).slice(0,80),lang:getLang()};
    persist();render();return true;
  }

  const style = `
    .gd-card{background:linear-gradient(135deg,#162329,#17202d 60%);border:1px solid #52695f;border-radius:10px;padding:12px;color:#e5edf2;font:13px/1.5 system-ui,sans-serif}.gd-card p{margin:6px 0}.gd-kicker{font-size:10px;letter-spacing:.13em;text-transform:uppercase;color:#afcdb9}.gd-title{font-family:Georgia,serif;font-size:18px;color:#f1dda8;line-height:1.25;margin:5px 0}.gd-row{display:flex;align-items:center;justify-content:space-between;gap:8px}.gd-small{font-size:11px;color:#afbdce}.gd-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.gd-btn{padding:7px 10px;border:1px solid #5e7b70;border-radius:7px;background:#243c38;color:#f3f5ed;cursor:pointer;font:600 12px/1.3 system-ui,sans-serif}.gd-btn:hover{background:#36564d}.gd-btn:focus-visible,.gd-choice:focus-visible{outline:2px solid #f6ce72;outline-offset:3px}.gd-btn.secondary{background:#1d2633;border-color:#475569}.gd-progress{height:4px;background:#0f1822;border-radius:3px;margin:9px 0;overflow:hidden}.gd-progress>i{height:100%;display:block;background:#bfa165}.gd-seals{display:flex;gap:5px;flex-wrap:wrap;margin-top:8px}.gd-tag{border:1px solid #526072;border-radius:20px;padding:2px 7px;color:#aab7c5;font-size:10px}.gd-tag.active{background:#25483d;border-color:#759e82;color:#d5edd3}.gd-mask{position:fixed;inset:0;background:#02070de3;backdrop-filter:blur(7px);z-index:95;display:flex;align-items:center;justify-content:center;padding:16px}.gd-mask[hidden]{display:none}.gd-dialog{background:#101b25;border:1px solid #63756e;border-radius:15px;box-shadow:0 20px 70px #0009;width:min(720px,96vw);max-height:90vh;display:flex;flex-direction:column;overflow:hidden;color:#e4ecf1;font:14px/1.65 system-ui,sans-serif}.gd-dialog-head{padding:17px 22px;border-bottom:1px solid #354451;flex-shrink:0}.gd-dialog-head h2{font:25px/1.25 Georgia,serif;color:#f4dfa9;margin:4px 0}.gd-tabs{display:flex;gap:8px;padding-top:10px}.gd-body{overflow:auto;padding:20px 22px;min-height:0}.gd-opening{font-size:16px;color:#e2ebee;line-height:1.8;margin:0 0 20px}.gd-choice{display:block;text-align:left;width:100%;margin:9px 0;padding:13px 15px;border-radius:9px;border:1px solid #526766;background:#1b3033;color:#f4ecd9;cursor:pointer}.gd-choice strong{font-size:15px;font-weight:650;display:block}.gd-choice small{display:block;font:12px/1.5 system-ui,sans-serif;color:#bfd0d1;margin-top:5px}.gd-choice:hover:not(:disabled){background:#2b4542;border-color:#b4c29a}.gd-choice:disabled{opacity:.53;cursor:not-allowed;background:#1c2731}.gd-risk{color:#f3ba84!important}.gd-journal-entry{border-left:2px solid #8c9a74;padding:0 0 0 12px;margin:0 0 20px}.gd-journal-entry h3{font-size:15px;color:#e9d7ad;margin:0}.gd-journal-entry p{font-size:13px;line-height:1.65;color:#bacad5;margin:5px 0}.gd-factions{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin:15px 0}.gd-faction{border:1px solid #364b50;border-radius:8px;padding:9px;color:#c5d5da}.gd-outcome{border:1px solid #6b805f;background:#20322c;border-radius:9px;padding:16px;margin-bottom:15px}.gd-narration{border-top:1px solid #354b55;padding-top:14px;margin-top:20px;white-space:pre-wrap;color:#b6d4e2;font-size:14px}.gd-notice{font-size:12px;color:#c5ad82}.gd-room-action{border:1px solid #7c9272;background:#1c3732;color:#e9d9a9;border-radius:6px;padding:3px 7px;font-size:11px;cursor:pointer}@media(max-width:600px){.gd-mask{padding:8px}.gd-dialog{max-height:94vh;width:100%}.gd-body{padding:16px}.gd-dialog-head{padding:14px 16px}.gd-dialog-head h2{font-size:22px}.gd-opening{font-size:15px}}`;

  function mount() {
    if(typeof document==='undefined'||!document.createElement)return;
    if(!document.getElementById('gd-styles')){const s=document.createElement('style');s.id='gd-styles';s.textContent=style;(document.head||document.body).appendChild(s);}
    const panel=document.getElementById('panel-quests');
    if(panel&&!document.getElementById('gd-journey')){const card=document.createElement('section');card.id='gd-journey';card.className='gd-card';panel.prepend(card);}
    if(!document.getElementById('gd-modal')&&document.body){
      const modal=document.createElement('div');modal.id='gd-modal';modal.className='gd-mask';modal.hidden=true;
      modal.innerHTML='<section class="gd-dialog" role="dialog" aria-modal="true" aria-labelledby="gd-modal-title"><div class="gd-dialog-head" id="gd-modal-head"></div><div class="gd-body" id="gd-modal-body"></div></section>';
      modal.addEventListener('click',e=>{if(e.target===modal)close();});document.body.appendChild(modal);
    }
  }
  function open(tab='journal') {
    mount();returnFocus=typeof document!=='undefined'?document.activeElement:null;
    modalTab=tab;modalOpen=true;lastRenderKey='';render();
    const modal=document.getElementById('gd-modal');if(modal)modal.querySelector('button')?.focus();
  }
  function close() {
    modalOpen=false;lastRenderKey='';
    const modal=document.getElementById('gd-modal');if(modal)modal.hidden=true;
    if(returnFocus&&typeof returnFocus.focus==='function')returnFocus.focus();
  }
  function changeTab(tab){modalTab=tab;lastRenderKey='';render();}
  function leadsHtml() {
    const leads=unfinishedLeads();if(!leads.length)return '';
    return `<h3 class="gd-title">${esc(text(bi('Unfinished leads · choose one to revisit','未完线索 · 选择一条回访')))}</h3><p class="gd-small">${esc(text(bi('Skipping a recommendation never consumes its choice or reward. Completed choices remain part of your story.','暂缓推荐不会消耗选择或奖励；已经做出的选择仍是故事的一部分。')))}</p>${leads.map(e=>`<button class="gd-choice" onclick="GameDirector.revisit('${e.id}')" ${e.available?'':'disabled'}><strong>${esc(e.title)}${e.skipped?' · '+esc(text(bi('postponed','已暂缓'))):''}</strong><small>${esc(getLang()==='zh'?WORLD_ROOMS[e.roomId].titleZh:WORLD_ROOMS[e.roomId].title)}${e.reason?' · '+esc(e.reason):''}</small></button>`).join('')}`;
  }
  function endingReadinessHtml() {
    const d=ensureState(),rows=byId.final_choice.choices.map(c=>({label:text(c.label),reason:text(requirementReason(c.require))}));
    const missing=[['sigil_root','menhir_root'],['sigil_memory','memory_bell'],['sigil_fire','furnace_fire'],['lens_aligned','observatory_lens']].filter(([flag])=>!d.flags[flag]);
    return `<div class="gd-notice"><strong>${esc(text(bi('Before your final choice','最终决定前')))}</strong>${rows.map(r=>`<p>${esc(r.label)}：${esc(r.reason||text(bi('Ready','已满足条件')))}</p>`).join('')}<p>${esc(text(bi('The guardian ending is always available. You may leave before deciding; completed choices cannot be rewritten.','守护结局始终可选。做决定前可以离开；已经做出的选择不会被重写。')))}</p>${missing.map(([,id])=>d.completed[id]?`<p class="gd-small">${esc(text(byId[id].title))} · ${esc(text(bi('Resolved differently in this journey','本次旅程已做出其他选择')))}</p>`:`<button class="gd-btn secondary" onclick="GameDirector.revisit('${id}')">${esc(text(bi('Revisit: ','回访：'))+text(byId[id].title))}</button>`).join('')}<button class="gd-btn secondary" onclick="GameDirector.changeTab('journal')">${esc(text(bi('Review every unfinished lead','查看全部未完线索')))}</button></div>`;
  }
  function travelToGuild() {
    if(!canMutate()||state.combat.inCombat)return false;
    const path=findShortestPath(state.world.currentRoom,'r_guild_hall');
    if(!path)return false;if(path.length)moveDirection(path[0]);open('guild');return true;
  }
  function redeemSelectedSet() {
    return CombatDirector.redeemSet(document.getElementById('guild-set-slot')?.value,document.getElementById('guild-set-id')?.value);
  }
  function guildHtml() {
    if(typeof CombatDirector==='undefined')return '';
    const g=CombatDirector.getGuildContext(),t=g.training,x=g.exchange,path=findShortestPath(state.world.currentRoom,'r_guild_hall');
    const disabled=!g.canUse?'disabled':'';
    return `<div class="gd-kicker">${esc(text(bi('ADVENTURERS’ GUILD','冒险者公会')))}</div><h3 class="gd-title">${esc(g.rank.name)} · ${g.reputation} ${esc(text(bi('reputation','声望')))}</h3><p>${esc(text(bi(`Merchant discount: ${g.discountPercent}%. ${g.nextRank?`Next rank at ${g.nextRank.at} reputation.`:'Highest rank reached.'}`,`商店折扣：${g.discountPercent}%。${g.nextRank?`下阶需要 ${g.nextRank.at} 声望。`:'已达最高阶。'}`)))}</p><p>${state.player.gold} ${esc(text(bi('gold','金币')))} · ${state.player.shards} ${esc(text(bi('Rift shards','裂隙碎片')))}</p>${!g.canUse?`<p class="gd-notice">${esc(text(bi('Services require the Guild Hall, outside solo and online battles.','服务需在公会大厅、单人及在线战斗之外办理。')))}</p>${!state.combat.inCombat&&path?.length?`<button class="gd-btn" onclick="GameDirector.travelToGuild()">${esc(text(bi(`One step toward the Guild · ${path.length} steps left`,`向公会走一步 · 还需 ${path.length} 步`)))}</button>`:''}`:''}<h3 class="gd-title">${esc(text(bi('Choose your set and slot','选择套装与部位')))}</h3><p class="gd-small">${esc(text(bi(`One level-${x.tier} set item: ${x.shards} shards + ${x.gold} gold. The set and slot are guaranteed; affixes roll normally. Requires 25 reputation.`,`兑换一件 ${x.tier} 阶套装：${x.shards} 碎片 + ${x.gold} 金币。保证所选套装与部位，词缀正常随机。需 25 声望。`)))}</p><div class="gd-actions"><label>${esc(text(bi('Set','套装')))} <select id="guild-set-id" class="gd-btn secondary" aria-label="${esc(text(bi('Choose a set','选择套装')))}">${g.sets.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label><label>${esc(text(bi('Slot','部位')))} <select id="guild-set-slot" class="gd-btn secondary" aria-label="${esc(text(bi('Choose a slot','选择部位')))}">${g.slots.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label><button class="gd-btn" onclick="GameDirector.redeemSelectedSet()" ${!g.canUse||!x.available?'disabled':''}>${esc(text(bi('Exchange shards','支付并兑换')))}</button></div><h3 class="gd-title">${esc(text(bi('Companion training','伙伴培养')))} · Lv.${t.level}</h3><p>${esc(text(bi(`All unlocked companions share training. Pet strikes gain +0.5 percentage points per level; current bonus +${t.bonusPercent} points.`,`已解锁伙伴共享培养等级。每级协战伤害系数增加 0.5 个百分点，当前额外 +${t.bonusPercent} 个百分点。`)))}</p><p class="gd-small">${esc(text(bi(`Current training cap: ${t.cap} (hero level + 2, maximum 13).`,`当前培养上限 ${t.cap} 级（角色等级 + 2，最高 13 级）。`)))}</p><button class="gd-btn" onclick="CombatDirector.trainCompanion(${t.level})" ${!g.canUse||!t.available?'disabled':''}>${esc(text(t.level>=t.cap?bi('Training cap reached','已达当前培养上限'):bi(`Train to Lv.${t.level+1} · ${t.shards} shards + ${t.gold} gold`,`培养至 Lv.${t.level+1} · ${t.shards} 碎片 + ${t.gold} 金币`)))}</button><h3 class="gd-title">${esc(text(bi('Gathering preparations','区域采集准备')))}</h3><p class="gd-small">${esc(text(bi('Regional victories unlock these preparations for free. Experienced explorers may buy the training earlier. Movement remains unrestricted.','击败对应区域首领可免费获得准备资格；有经验的探索者也可提前购买培训。移动始终自由。')))}</p>${g.tools.map(tool=>`<div class="gd-journal-entry"><strong>${esc(tool.name)}</strong><p class="gd-small">${esc(tool.description)}</p><button class="gd-btn secondary" onclick="CombatDirector.purchaseTool('${tool.id}')" ${!g.canUse||!tool.available?'disabled':''}>${esc(tool.unlocked?text(bi('Prepared','已具备资格')):text(bi(`${tool.gold} gold · Lv.${tool.level} + ${tool.rep} reputation`,`${tool.gold} 金币 · 需 Lv.${tool.level} 与 ${tool.rep} 声望`)))}</button></div>`).join('')}`;
  }
  function applyHuntSettings() {
    const mode=document.getElementById('hunt-mode')?.value;
    const maxBattles=Number(document.getElementById('hunt-limit')?.value);
    const healthFloor=Number(document.getElementById('hunt-health')?.value)/100;
    return CombatDirector.configureHunt({mode,maxBattles,healthFloor});
  }
  function startConfiguredHunt() {
    if(!applyHuntSettings())return false;
    return CombatDirector.startHunt();
  }
  function huntHtml() {
    if(typeof CombatDirector==='undefined')return '';
    const h=CombatDirector.getHuntContext(),s=h.session;
    return `<div class="gd-kicker">${esc(text(bi('AUTO-HUNT','自动狩猎')))}</div><h3 class="gd-title">${esc(text(bi('Give this expedition an ending','给本次狩猎一个终点')))}</h3><p>${esc(text(bi('A new game defaults to one battle. Contract mode stops when the current kill contract is ready; it only hunts eligible local foes. Continuous hunting is an explicit choice.','新旅程默认只打一场。契约模式完成当前击杀委托即停，只选择当前地点符合条件的敌人。连续模式需主动选择。')))}</p><div class="gd-actions"><label>${esc(text(bi('Goal','目标')))} <select id="hunt-mode" class="gd-btn secondary" onchange="document.getElementById('hunt-limit').value=this.value==='single'?1:this.value==='contract'?0:5" ${h.active?'disabled':''}>${[['single','One battle','一场即停'],['contract','Current kill contract','当前击杀契约'],['continuous','Continuous','连续狩猎']].map(([id,en,zh])=>`<option value="${id}" ${h.mode===id?'selected':''}>${esc(text(bi(en,zh)))}</option>`).join('')}</select></label><label>${esc(text(bi('Battle cap','场次上限')))} <input id="hunt-limit" type="number" min="0" max="100" value="${h.maxBattles}" class="gd-btn secondary" ${h.active?'disabled':''}></label><label>${esc(text(bi('Pause below HP %','生命低于此百分比时停下')))} <input id="hunt-health" type="number" min="22" max="90" value="${Math.round(h.healthFloor*100)}" class="gd-btn secondary" ${h.active?'disabled':''}></label></div><p class="gd-small">${esc(text(bi('Single mode always stops after one win. For contracts the cap is an additional limit; 0 means the contract target. For continuous mode 0 explicitly means unlimited. Range: 0–100 battles, 22–90% HP. Changing rooms stops the run.','单场模式固定一胜即停。契约模式的场次为额外上限，0 代表以契约目标为准；连续模式填 0 才表示不限场次。场次范围 0–100，生命下限 22–90%。离开当前房间会停止本轮。')))}</p><div class="gd-actions"><button class="gd-btn secondary" onclick="GameDirector.applyHuntSettings()" ${h.active?'disabled':''}>${esc(text(bi('Save hunting goals','保存狩猎目标')))}</button><button class="gd-btn" onclick="${h.active?'toggleAutoHunt()':'GameDirector.startConfiguredHunt()'}">${esc(text(h.active?bi('Pause this run','暂停本轮'):bi('Save and start','保存并开始')))}</button></div><p class="gd-notice">${esc(h.statusText)}</p>${h.contract?`<p>${esc(text(bi('Current contract: ','当前契约：'))+h.contract.description)} · ${h.contract.progress}/${h.contract.target}</p>`:''}${s?`<div class="gd-outcome"><strong>${esc(text(bi('This run’s combat rewards','本轮战斗收益')))}</strong><p>${s.wins} ${esc(text(bi('wins','胜')))} · +${s.xp} XP · +${s.gold} ${esc(text(bi('gold','金币')))} · ${s.loot} ${esc(text(bi('loot items','件掉落')))}</p><p class="gd-small">${esc(h.stopText)}</p></div>`:''}`;
  }

  function journalHtml() {
    const d=ensureState(),o=objective();
    let html=`<div class="gd-kicker">${esc(text(bi('CURRENT CHAPTER','当前篇章')))}</div><h3 class="gd-title">${esc(text(o.chapter))}</h3><p>${esc(text(o.label))}</p><div class="gd-actions"><button class="gd-btn" onclick="GameDirector.close();GameDirector.followObjective()">${esc(text(bi('Take the next step','沿目标前进一步')))}</button><button class="gd-btn secondary" onclick="GameDirector.close();switchRightTab('quests')">${esc(text(bi('Quest & contract details','查看主线与契约')))}</button></div>`;
    html+=`<div class="gd-factions">${Object.entries(factions).map(([k,v])=>`<div class="gd-faction"><div class="gd-small">${esc(text(v))}</div><strong>${d.trust[k]>0?'+':''}${d.trust[k]}</strong> ${esc(text(bi('trust','信任')))}</div>`).join('')}</div>`;
    html+=`<div class="gd-small" style="margin-bottom:18px">${esc(text(bi(`${Object.keys(d.completed).length}/${encounters.length} stories resolved · ${Object.keys(d.discoveries).length}/${discoveryRows.length} landmarks investigated`,`${Object.keys(d.completed).length}/${encounters.length} 个故事已处理 · ${Object.keys(d.discoveries).length}/${discoveryRows.length} 处地标已调查`)))}</div>`;
    const remainingHere=available();
    if(remainingHere.length) html+=`<button class="gd-choice" onclick="GameDirector.startEncounter('${remainingHere[0].id}')"><strong>◇ ${esc(text(remainingHere[0].title))}</strong><small>${esc(text(bi('An unresolved encounter is here.','这里还有一个等待处理的事件。')))}</small></button>`;
    html+=d.journal.slice().reverse().map(j=>`<article class="gd-journal-entry"><h3>${esc(text(j.title))}</h3><div class="gd-small">${esc(getLang()==='zh'?(WORLD_ROOMS[j.roomId]||{}).titleZh:(WORLD_ROOMS[j.roomId]||{}).title)}</div><p>${esc(text(j.body))}</p></article>`).join('');
    html+=leadsHtml();
    return html;
  }
  function eventHtml() {
    const d=ensureState(),e=d.pending&&byId[d.pending.id];
    if(!e) {
      if(d.lastOutcome){const r=d.lastOutcome;return `<div class="gd-kicker">${esc(text(bi('YOUR CHOICE IS RECORDED','选择已写入旅程')))}</div><h3 class="gd-title">${esc(text(r.title))}</h3><div class="gd-outcome"><p class="gd-opening">${esc(text(r.body))}</p><div class="gd-small">${esc(effectsSummary(r.effects))}</div>${r.roll?`<div class="gd-small">${esc(text(bi(`Check: ${r.roll}/100; needed ≤ ${r.chance}.`,`检定：${r.roll}/100；需要 ≤ ${r.chance}。`)))}</div>`:''}</div><div class="gd-actions"><button class="gd-btn" onclick="GameDirector.close()">${esc(text(bi('Continue the journey','继续旅程')))}</button><button class="gd-btn secondary" onclick="GameDirector.changeTab('journal')">${esc(text(bi('Read your journal','查看旅程日志')))}</button></div>`;}
      const found=available();return `<p class="gd-opening">${esc(text(bi('Every place has a story. Follow a lead or investigate the landmark beside you.','每个地方都有自己的故事。跟随线索，或调查身旁的地标。')))}</p><div class="gd-actions">${found.length?`<button class="gd-btn" onclick="GameDirector.startEncounter('${found[0].id}')">◇ ${esc(text(found[0].title))}</button>`:''}<button class="gd-btn secondary" onclick="GameDirector.close();GameDirector.discover()">${esc(text(bi('Investigate this landmark · 5 STA','调查此处地标 · 5 体力')))}</button></div>`;
    }
    const atRoom=state.world.currentRoom===e.room&&!state.combat.inCombat;
    let html=`<div class="gd-kicker">${esc(getLang()==='zh'?WORLD_ROOMS[e.room].titleZh:WORLD_ROOMS[e.room].title)}</div><h3 class="gd-title">${esc(text(e.title))}</h3><p class="gd-opening">${esc(text(e.opening))}</p>`;
    if(e.id==='final_choice')html+=endingReadinessHtml();
    if(!atRoom)html+=`<p class="gd-notice">${esc(text(bi('Return here outside combat to make your choice.','请返回此处，并在非战斗状态下做出选择。')))}</p>`;
    html+=e.choices.map((c,i)=>{const blocked=requirementReason(c.require)||costReason(c.cost);return `<button class="gd-choice" onclick="GameDirector.resolveChoice(${i})" ${blocked||!atRoom?'disabled':''}><strong>${i+1}. ${esc(text(c.label))}</strong><small>${esc(costSummary(c.cost))}${c.check?` · ${esc(text(statName(c.check.stat)))} ${chance(c)}% ${esc(text(bi('success chance','成功率')))}`:''}</small><small>${esc(effectsSummary(c.result.effects))}</small>${c.failure?`<small class="gd-risk">${esc(text(bi('On failure: ','失败后：'))+effectsSummary(c.failure.effects))}</small>`:''}${blocked?`<small class="gd-risk">${esc(text(blocked))}</small>`:''}</button>`;}).join('');
    html+=`<p class="gd-small">${esc(text(bi('Choices resolve once and are saved. Checks are fixed for this journey; reloading does not reroll them. You can leave and return before choosing.','每次选择只结算一次并写入存档。检定结果随旅程固定，读档不会重新掷骰。做决定前可以离开并返回。')))}</p>`;
    if(d.pending.narration&&d.pending.narration.lang===getLang())html+=`<div class="gd-narration"><div class="gd-kicker">${esc(text(bi('AI atmosphere · authored story above is authoritative','AI补充描写 · 剧情事实以上方原文为准')))} · ${esc(d.pending.narration.source)}</div>${esc(d.pending.narration.text)}</div>`;
    if(narrationNotice)html+=`<p class="gd-notice" role="status">${esc(text(narrationNotice))}</p>`;
    if(objective().event===e.id && objective().skippable)html+=`<button class="gd-btn secondary" onclick="GameDirector.skipObjective()">${esc(text(bi('Skip this recommendation · revisit later','跳过本条推荐 · 可稍后回访')))}</button>`;
    html+=`<div class="gd-actions"><button class="gd-btn secondary" onclick="GameDirector.requestNarration()" ${narrationBusyToken===d.pending.token?'disabled':''}>${esc(text(narrationBusyToken===d.pending.token?bi('The DM is writing…','DM 正在描写……'):bi('Ask the DM to describe the scene','请 DM 描写此场景')))}</button><button class="gd-btn secondary" onclick="GameDirector.close()">${esc(text(bi('Decide later','稍后决定')))}</button></div>`;
    return html;
  }
  async function requestNarration(){
    const d=ensureState();if(!d.pending)return false;
    if(typeof window.AethelgardAI?.narrateEncounter==='function'){
      const status=window.AethelgardAI.getStatus();
      if(!status.ready||status.backend==='rules'){
        notify('Choose and load a local model in the DM panel before requesting generated scene prose.','请先在智脑面板选择并加载本地模型，再请求生成场景描写。');
        close();switchRightTab('ai');return false;
      }
      if(status.busy){narrationNotice=bi('The DM is answering another request. Wait for it to finish.','DM 正在回答另一个问题，请等待完成。');render();return false;}
      const token=d.pending.token,id=d.pending.id;
      narrationBusyToken=token;narrationNotice=bi('Generating optional atmosphere. Your choices and their costs remain available.','正在生成补充描写，你仍可阅读选项与成本。');render();
      try{await window.AethelgardAI.narrateEncounter(id,token);}
      finally{
        narrationBusyToken=null;
        if(ensureState().pending?.token===token)narrationNotice=ensureState().pending.narration?null:bi('No generated scene was returned. The DM panel shows the connection or model error. The authored story remains playable.','未获得生成描写。智脑面板显示连接或模型错误，原创故事仍可继续。');
        render();
      }
      return true;
    }
    if(typeof window.AIDM?.narrateEncounter==='function')return window.AIDM.narrateEncounter(getContext());
    if(typeof window.dispatchEvent==='function'&&typeof CustomEvent==='function')window.dispatchEvent(new CustomEvent('aethelgard:narrate-encounter',{detail:{id:d.pending.id,token:d.pending.token,context:getContext()}}));
    return true;
  }
  function render() {
    if(rendering||typeof document==='undefined')return;
    rendering=true;
    try {
      mount();const d=ensureState(),o=objective(),here=available(),card=document.getElementById('gd-journey');
      if(card)card.innerHTML=`<div class="gd-row"><span class="gd-kicker">${esc(text(bi('YOUR JOURNEY','你的旅程')))}</span><span class="gd-small">${o.progress}/${o.total}</span></div><h3 class="gd-title">${esc(text(o.chapter))}</h3><div class="gd-progress"><i style="width:${Math.round(o.progress/o.total*100)}%"></i></div><p>${esc(text(o.label))}</p><div class="gd-seals">${[['root',bi('Root','根')],['memory',bi('Memory','记忆')],['fire',bi('Fire','火')]].map(([k,v])=>`<span class="gd-tag ${d.flags['sigil_'+k]?'active':''}">${d.flags['sigil_'+k]?'◆':'◇'} ${esc(text(v))}</span>`).join('')}<span class="gd-tag">${esc(text(bi('Trust','信任')))} ${allianceScore()}</span></div><div class="gd-actions"><button class="gd-btn" onclick="GameDirector.followObjective()">${esc(text(bi('Next step','目标下一步')))}</button><button class="gd-btn secondary" onclick="GameDirector.open('journal')">${esc(text(bi('Journal & choices','日志与抉择')))}</button><button class="gd-btn secondary" onclick="GameDirector.open('guild')">${esc(text(bi('Guild & companions','公会与伙伴')))}</button><button class="gd-btn secondary" onclick="GameDirector.open('hunt')">${esc(text(bi('Hunt goals','狩猎目标')))}</button>${o.skippable?`<button class="gd-btn secondary" onclick="GameDirector.skipObjective()">${esc(text(bi('Skip this lead','暂缓此线索')))}</button>`:''}${here.length?`<button class="gd-btn secondary" onclick="GameDirector.startEncounter()">◇ ${esc(text(bi('Story here','此地故事')))}</button>`:''}</div>`;
      const chips=document.getElementById('room-entities-chips');
      if(chips){
        const old=chips.querySelector('[onclick="openMysteryChestOrShrine()"]');
        if(old){old.textContent=d.discoveries[state.world.currentRoom]?text(bi('⌖ Landmark notes','⌖ 地标笔记')):text(bi('⌖ Investigate · 5 STA','⌖ 调查地标 · 5 体力'));old.className='gd-room-action';}
        if(here.length&&!chips.querySelector('[data-gd-story]')){const b=document.createElement('button');b.dataset.gdStory='1';b.className='gd-room-action';b.textContent=`◇ ${text(here[0].title)}`;b.onclick=()=>startEncounter();chips.appendChild(b);}
      }
      const macro=document.getElementById('macro-ai');if(macro)macro.textContent=text(bi('◇ Story encounter','◇ 故事奇遇'));
      const contractButton=document.getElementById('btn-refresh-bounties');
      if(contractButton){contractButton.title=text(bi('Guild Hall only. Complete and claim the current board before taking the next one.','仅公会大厅可领取。请先完成并领取本批全部契约。'));}
      renderGuidance(o);
      const modal=document.getElementById('gd-modal');if(!modal)return;modal.hidden=!modalOpen;if(!modalOpen)return;
      // Resource regeneration must not replace a form while a player is
      // choosing a set or editing an expedition. Each tab tracks only its view.
      const details=modalTab==='guild'?[CombatDirector.getGuildContext(),state.player.gold,state.player.shards]
        :modalTab==='hunt'?CombatDirector.getHuntContext()
        :[d.pending,d.lastOutcome,d.completed,d.skipped,d.revisit,d.flags,d.trust,d.journal.length,narrationBusyToken,narrationNotice,state.player.gold,state.player.sta,state.player.mp,state.player.inventory,state.player.stats];
      const key=JSON.stringify([getLang(),modalTab,state.world.currentRoom,state.combat.inCombat,details]);
      if(key===lastRenderKey)return;lastRenderKey=key;
      document.getElementById('gd-modal-head').innerHTML=`<div class="gd-row"><div><div class="gd-kicker">AETHELGARD · ${esc(text(bi('CHRONICLES','编年史')))}</div><h2 id="gd-modal-title">${esc(text(bi('The choices you carry','你带在身上的选择')))}</h2></div><button class="gd-btn secondary" onclick="GameDirector.close()" aria-label="${esc(text(bi('Close','关闭')))}">✕</button></div><div class="gd-tabs"><button class="gd-btn ${modalTab==='event'?'':'secondary'}" onclick="GameDirector.changeTab('event')">${esc(text(bi('Encounter','当前事件')))}</button><button class="gd-btn ${modalTab==='journal'?'':'secondary'}" onclick="GameDirector.changeTab('journal')">${esc(text(bi('Journey journal','旅程日志')))}</button><button class="gd-btn ${modalTab==='guild'?'':'secondary'}" onclick="GameDirector.changeTab('guild')">${esc(text(bi('Guild services','公会服务')))}</button><button class="gd-btn ${modalTab==='hunt'?'':'secondary'}" onclick="GameDirector.changeTab('hunt')">${esc(text(bi('Hunt goals','狩猎目标')))}</button></div>`;
      const selectedGuild=modalTab==='guild'?{slot:document.getElementById('guild-set-slot')?.value,setId:document.getElementById('guild-set-id')?.value}:null;
      document.getElementById('gd-modal-body').innerHTML=modalTab==='journal'?journalHtml():modalTab==='guild'?guildHtml():modalTab==='hunt'?huntHtml():eventHtml();
      if(selectedGuild){
        if(['weapon','armor','helm','ring','relic'].includes(selectedGuild.slot))document.getElementById('guild-set-slot').value=selectedGuild.slot;
        if(Object.hasOwn(DIABLO_SETS,selectedGuild.setId))document.getElementById('guild-set-id').value=selectedGuild.setId;
      }
    } finally{rendering=false;}
  }

  return {ensureState,getContext,onAction,skipObjective,revisit,unfinishedLeads,applyHuntSettings,startConfiguredHunt,redeemSelectedSet,travelToGuild,startEncounter,resolveChoice,setNarration,discover,available,open,close,changeTab,render,sync,objective,followObjective,requestNarration,refreshContracts,canMutate,
    catalog:()=>({encounters:encounters.map(e=>({id:e.id,room:e.room,title:e.title,choices:e.choices.length})),discoveryCount:discoveryRows.length}),
    isModalOpen:()=>modalOpen};
})();
window.GameDirector=GameDirector;
window.triggerAiEncounter=()=>GameDirector.startEncounter();
window.openMysteryChestOrShrine=()=>GameDirector.discover();
window.refreshBounties=()=>GameDirector.refreshContracts();

// Compose with later modules instead of taking ownership of their mechanics.
{
  const previousRender=renderAll;
  renderAll=function(){GameDirector.ensureState();previousRender.apply(this,arguments);GameDirector.sync();GameDirector.render();};
  const previousMove=moveDirection;
  moveDirection=function(){if(!GameDirector.canMutate())return false;const before=state.world.currentRoom;const result=previousMove.apply(this,arguments);if(state.world.currentRoom!==before){GameDirector.onAction('move',{from:before,roomId:state.world.currentRoom});GameDirector.render();}return result;};
  const previousClaim=claimBounty;
  claimBounty=function(){if(!GameDirector.canMutate()||state.combat.inCombat)return false;const result=previousClaim.apply(this,arguments);GameDirector.sync();saveGameState(false);return result;};
  const previousCommand=executeCommand;
  executeCommand=function(raw){const parts=String(raw||'').trim().split(/\s+/),cmd=(parts[0]||'').toLowerCase();
    if(['journal','journey','日志','旅程'].includes(cmd))return GameDirector.open('journal');
    if(['guild','公会'].includes(cmd))return GameDirector.open('guild');
    if(['skip','暂缓'].includes(cmd))return GameDirector.skipObjective();
    if(['hunt','狩猎'].includes(cmd))return GameDirector.open('hunt');
    if(['encounter','event','奇遇','事件'].includes(cmd))return GameDirector.startEncounter();
    if(['inspect','调查'].includes(cmd))return GameDirector.discover();
    if(['choose','选择'].includes(cmd))return GameDirector.resolveChoice(Number(parts[1])-1);
    return previousCommand.apply(this,arguments);
  };
}
window.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&GameDirector.isModalOpen()){event.preventDefault();GameDirector.close();return;}
  if(GameDirector.isModalOpen()&&event.key==='Tab'){
    const list=Array.from(document.querySelectorAll('#gd-modal button:not(:disabled)'));
    if(list.length){const first=list[0],last=list[list.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
  }
  const tag=(event.target&&event.target.tagName||'').toLowerCase();
  if(event.key.toLowerCase()==='j'&&!['input','textarea','select'].includes(tag)&&!event.ctrlKey&&!event.metaKey&&!event.altKey){event.preventDefault();GameDirector.open('journal');}
});
