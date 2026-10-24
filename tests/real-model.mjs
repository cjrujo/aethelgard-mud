/* Opt-in REAL native CPU inference, using current game modules and prompts.
 * No mock answers, template repair, or successful-count substitution is allowed.
 * --self-check and --prompts-only never load or evaluate model weights.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createHarness } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(await readFile(path.join(root, 'models/registry.json'), 'utf8'));
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const key = option('model') || registry.models[0].key;
const registeredModel = registry.models.find(model => model.key === key);
assert.ok(registeredModel, `Unknown model: ${key}`);
const model = { ...registeredModel, dtype: option('dtype') || registeredModel.dtype };
assert.ok(['q8', 'q4', 'q4f16', 'fp32', 'fp16', 'int8', 'uint8', 'bnb4'].includes(model.dtype), 'Unknown dtype');
const languages = option('lang')?.split(',') || model.languages || ['en'];
assert.ok(languages.every(lang => ['en', 'zh'].includes(lang)), 'Unknown test language');
const selectedCases = option('case')?.split(',');
const caseTypes = ['route', 'interrupt', 'cast-interrupt', 'guard', 'mixed-guard', 'memory', 'long-memory', 'npc', 'npc-relationship', 'encounter', 'tavern'];
assert.ok(!selectedCases || selectedCases.every(type => caseTypes.includes(type)), 'Unknown test case');
const repetitionPenalty = Number(option('repetition-penalty') || 1.0);
assert.ok(Number.isFinite(repetitionPenalty) && repetitionPenalty > 0, 'Invalid repetition penalty');
const modules = ['core', 'gameplay', 'combat', 'ai-dm', 'online', 'bootstrap'];

function fixtures() {
  const list = [];
  for (const lang of languages) for (const type of selectedCases || caseTypes) {
    const zh = lang === 'zh';
    const game = createHarness({ lang, modules, globals: { AETHELGARD_MODEL_REGISTRY: registry, DOMException } });
    game.run(`AethelgardApp.restore(createInitialState()); state.lang=${JSON.stringify(lang)}; state.ai.modelKey=${JSON.stringify(key)}; CombatDirector.setSeedForTests(7123);`);
    const ai = game.run('AethelgardAI');
    let question, kind = 'general', expected, introduction;
    if (type === 'route') {
      game.run("state.world.currentRoom='r_town_square';");
      question = zh ? '酒馆在哪里？请告诉我从这里出发的方向。' : 'Where is the tavern? Which direction should I go from here?';
      const route = game.json("AethelgardAI.findRoute('r_tavern')");
      assert.equal(route.length, 1, 'Revisit the route fixture if the actual map changes.');
      expected = { direction: route[0], from: 'r_town_square', destination: 'r_tavern' };
    } else if (['interrupt','guard','mixed-guard','cast-interrupt'].includes(type)) {
      game.run("state.world.currentRoom='r_wilds_trail'; CombatDirector.startEncounter(MOB_TEMPLATES.briar_wolf); state.combat.enemy.intent='charge'; state.player.hp=state.player.maxHp;");
      if(type==='cast-interrupt') game.run("state.combat.inCombat=false; CombatDirector.startEncounter(MOB_TEMPLATES.sporeling_mystic);");
      const interruptible=['interrupt','cast-interrupt'].includes(type);
      game.run(interruptible ? 'state.player.sta=state.player.maxSta;' : 'state.player.sta=0;');
      const combat = game.json('CombatDirector.getContext()');
      assert.equal(combat.decisions.interrupt.effectiveNow, true);
      assert.equal(combat.decisions.interrupt.canPay, interruptible);
      kind = 'tactics';
      question = zh ? '敌人正在蓄力，我现在应该怎么做？请解释推荐行动。' : 'The enemy is charging. What should I do now? Explain the recommended action.';
      if(type==='mixed-guard') question=zh?'刚才体力不够，敌人正在蓄力，下一步怎么打？':'Earlier I ran out of stamina. The enemy is charging. What should I do next?';
      if(type==='cast-interrupt') question=zh?'敌人正在施法，我现在应该怎么做？打断是否必定让它露出破绽？':'The enemy is casting. What should I do? Does interrupting this spell guarantee exposure?';
      expected = { action: interruptible?'interrupt':'guard', interruptAffordable: combat.decisions.interrupt.canPay, stamina: game.run('state.player.sta'), interruptCost: 18,
        effect:combat.decisions.interrupt.effect };
    } else if (type === 'memory') {
      introduction = zh ? '请记住，我失散的姐姐名字叫米拉。' : 'Please remember that my missing sister is named Mira.';
      question = zh ? '我刚才告诉你，我失散的姐姐叫什么名字？' : 'What did I tell you my missing sister is named?';
      expected = { rememberedName: zh ? '米拉' : 'Mira', origin: 'Previous user turn, not a fabricated assistant response or hero state.' };
    } else if (type === 'long-memory') {
      const statement=zh?'请记住，我失散的姐姐名字叫米拉。我承诺寻找信使。':'Please remember that my missing sister is named Mira. I promise to find the courier.';
      ai.rememberPlayerStatement(statement,'dm');
      // Fixture user turns, not simulated model replies. The original statement
      // has left the short conversation and must be retrieved from player facts.
      game.run(`state.ai.memory.dm=${JSON.stringify(Array.from({length:8},(_,i)=>({role:'user',content:zh?`我们谈了其他话题${i}。`:`We discussed another topic ${i}.`})))};`);
      question=zh?'我的姐姐叫什么名字？我承诺过什么？':'What is my sister named, and what did I promise?';
      expected={rememberedName:zh?'米拉':'Mira',promise:zh?'寻找信使':'find the courier',origin:'Explicit player statement stored outside eight intervening user turns; no invented assistant history.'};
    } else if (type === 'npc' || type === 'npc-relationship') {
      game.run("state.world.currentRoom='r_tavern';"); kind = 'npc';
      question = zh ? '玛拉，我刚来到这里。请以酒馆老板娘的口吻欢迎我，并告诉我一条你知道的传闻。' : 'Mara, I have just arrived. Welcome me in your voice as the innkeeper and tell me one rumor you know.';
      expected = { manualReview: ['Speaks as Mara rather than addressing the player as Mara.', 'Accurately uses the supplied Silverbrook Ford rumor.', 'Does not grant rewards or completed choices.'] };
      if(type==='npc-relationship') {
        game.run("GameDirector.ensureState().trust.town=-5; GameDirector.ensureState().flags.scout_abandoned=true;");
        question=zh?'玛拉，你为什么对我有所戒备？':'Mara, why are you wary of me?';
        expected={trust:-5,flag:'scout_abandoned',manualReview:['Speaks as Mara to the traveler, not to Mara.','Reflects actual distrust and taking the wounded ranger’s purse.','Does not invent a fine, denied access, combat, or a new reward.']};
      }
    } else {
      if (type === 'tavern') game.run("state.world.currentRoom='r_tavern';");
      game.run('GameDirector.startEncounter();'); kind = 'encounter';
      const event = game.json('GameDirector.getContext().encounter');
      assert.equal(event?.id, type === 'tavern' ? 'tavern_courier' : 'first_oath');
      question = zh ? `请为当前奇遇【${event.title}】补充一到两句感官氛围描写。` : `Add 1-2 sentences of sensory atmosphere to this encounter: ${event.title}.`;
      expected = { encounterId: event.id, opening: event.opening, manualReview: [
        'Preserves the people, their locations, presence or absence, and unresolved choices.',
        ...(type === 'tavern' ? ['The courier stays missing; the wounded ranger and waterwheel are mentioned in a note and are not currently perceived inside the tavern.'] : []),
        'Adds atmosphere without new actions, events, outcomes, or echoed instructions.'
      ] };
    }
    const scope=kind==='npc'?`npc:${game.run('WORLD_ROOMS[state.world.currentRoom].npcs[0].id')}`:'dm';
    list.push({ id: `${lang}-${type}`, lang, type, game, ai, question, kind, scope, expected, introduction });
  }
  return list;
}

const directions = { n: /\bnorth(?:wards?)?\b|北/, s: /\bsouth(?:wards?)?\b|南/, e: /\beast(?:wards?)?\b|东|東/, w: /\bwest(?:wards?)?\b|西/, u: /\bupstairs\b|向上|上楼/, d: /\bdownstairs\b|向下|下楼/ };
const affirmative = text => text.replace(/\b(?:cannot|can't|do not|don't|avoid|unable to)\b[^.;!?。！？\n]{0,60}?\b(?:interrupt|rest|sleep)(?:\s+(?:now|immediately))?/gi, '').replace(/(?:不能|无法|不要|不应).{0,15}?(?:打断|中断|休息|睡觉)/g, '');
function judge(test, text) {
  const checks = [];
  const check = (name, passed) => checks.push({ name, passed: Boolean(passed) });
  check('nonempty answer', typeof text === 'string' && text.trim().length > 2);
  check('not code in place of an answer', !/```|\bpackage main\b|\bfunc main\b|<script\b/i.test(text));
  if (test.lang === 'zh') check('Chinese answer', /[\u3400-\u9fff]/u.test(text));
  if (test.type === 'route') {
    check('actual map direction', directions[test.expected.direction].test(text.toLowerCase()));
    check('no conflicting direction', Object.entries(directions).every(([key, pattern]) => key === test.expected.direction || !pattern.test(text.toLowerCase())));
    check('no external-map referral', !/google\s*maps?|gps|百度地图|搜索引擎|导航软件/i.test(text));
  } else if (['interrupt','cast-interrupt'].includes(test.type)) {
    check('recommends legal interrupt', /\binterrupt(?:ing)?\b|打断|中断/i.test(text));
    check('explains cancellation or exposure', /cancel|stop|disrupt|prevent|expos|vulnerab|stun|取消|阻止|停止|破绽|虚弱|眩晕|晕眩|中止|终止/i.test(text));
    check('does not refuse an affordable interrupt', !/(?:cannot|can't|do not|don't|avoid|unable to|not enough)[^.\n]{0,25}\binterrupt|(?:不能|无法|不要|不应).{0,8}(?:打断|中断)/i.test(text));
    check('does not invent recovery from interrupt', !/(?:recover|restore|regain|heal|increase)[^.。\n]{0,30}\b(?:hp|mp|sta|health|mana|stamina)\b|(?:恢复|回复|增加).{0,15}(?:生命|法力|体力|血量|HP|MP|STA)/i.test(text));
    check('does not invent a fixed 100-damage result', !/(?:100[^.。\n]{0,15}(?:damage|伤害)|(?:damage|伤害|HP|生命)[^.。\n]{0,15}100|(?:减少|降低|扣除).{0,12}100)/i.test(text));
    if(test.type==='cast-interrupt') {
      check('does not promise guaranteed exposure after a cast', !/(?:and|will|always|guarantees?)\s+(?:will\s+)?(?:expose|make.{0,15}vulnerable)|(?:并使|会让|会使|必定|一定).{0,10}(?:破绽|虚弱)/i.test(text));
      check('does not conflate the interrupt action with skill or guard effects', !/shield bash|whirlwind|盾牌猛击|旋风顺劈|65%/i.test(text));
    }
  } else if (['guard','mixed-guard'].includes(test.type)) {
    check('recommends guard with zero stamina', /\bguard(?:ing)?\b|\bdefend\b|\bblock\b|防御|格挡|防守/i.test(text));
    check('explains damage reduction or stamina/mana recovery', /reduc.{0,30}damage|damage.{0,30}reduc|mitigat|(?:recover|restore|regain).{0,25}(?:stamina|mana|STA|MP)|减伤|(?:减少|降低).{0,12}伤害|伤害.{0,12}(?:减少|降低)|(?:恢复|回复).{0,12}(?:体力|法力)/i.test(text));
    const healingClaims=affirmative(text).replace(/(?:does not|do not|cannot|can't|won't|will not|never)\s+(?:heal|restore|recover|increase)[^.;!?\n]{0,35}\b(?:hp|health)\b/gi,'').replace(/(?:不|不会|不能)(?:恢复|回复|增加|提升).{0,8}(?:生命|血量)/g,'');
    check('does not invent healing from guard', !/(?:heal|recover|restore|regain|increase|raise|boost)[^.。\n]{0,25}\b(?:hp|health)\b|(?:恢复|回复|增加|提升).{0,8}(?:生命|血量)/i.test(healingClaims));
    check('does not recommend an unaffordable interrupt', !/(?:should|must|can|use|choose|recommend|try)\s+(?:an?\s+)?interrupt|interrupt\s+(?:now|immediately)|(?:现在|立即|应该|应当|可以|选择|使用|建议).{0,5}(?:打断|中断)/i.test(affirmative(text)));
  } else if (['memory','long-memory'].includes(test.type)) {
    check('remembers the supplied name', /\bMira\b|米拉/i.test(text));
    check('answers the remembered-person question', /\bsister\b|\b(?:named|called|name is|she)\b|姐姐|她|名字|(?:叫|名为).{0,5}米拉|^[\s"'“”]*米拉[。！!.,"'“”\s]*$|^[\s"'“”]*Mira[。！!.,"'“”\s]*$/i.test(text));
    check('does not deny supplied memory', !/(?:do not|don't|cannot|can't)\s+(?:know|remember|recall)|没有.{0,6}(?:告诉|提供)|不(?:知道|记得|清楚)/i.test(text));
    if(test.type==='long-memory') {
      check('remembers the explicit promise', /courier|信使/i.test(text)&&/promise|find|search|承诺|寻找|找到/i.test(text));
      check('does not mark the promise completed', !/(?:already|have|has)\s+(?:already\s+)?(?:found|rescued)|已经.{0,6}(?:找到|救回)/i.test(text));
    }
  } else if (['npc','npc-relationship'].includes(test.type)) {
    check('does not call the traveler Mara', !/^\s*["“]?\s*(?:Mara|玛拉)[,，!！]|(?:welcome|hello|你好|欢迎你)[^.!?。！？\n]{0,25}[,，]\s*(?:Mara|玛拉)/i.test(text));
    check('does not invent an item reward', !/(?:you (?:receive|gain)|I (?:give|grant) you).{0,35}(?:sword|gold|potion)|(?:你获得|送给你|给予你).{0,12}(?:金币|药剂|长剑)/i.test(text));
    if(test.type==='npc-relationship') {
      check('reflects the established trust or choice', /distrust|war[yi]|purse|ranger|不信任|戒备|钱袋|游侠/i.test(text));
      if(test.expected.flag==='scout_abandoned') check('grounds the attitude in the recorded ranger/purse deed', /ranger|wounded|游侠|伤者/i.test(text) && /purse|abandon|left|钱袋|遗弃|离开|丢下/i.test(text));
    }
  } else if (['encounter','tavern'].includes(test.type)) {
    check('does not settle an unchosen outcome', !/(?:you have|you've|you already).{0,25}(?:chosen|received|gained|rescued)|你已经.{0,8}(?:选择|获得|救回)|你获得.{0,6}(?:经验|金币|药剂)/i.test(text));
    if(test.type==='tavern') {
      check('courier is not brought into the tavern', !/(?:courier (?:sits|stands|walks|returns|enters))|信使.{0,6}(?:坐在|走进|回到|站在)/i.test(text));
      check('distant waterwheel does not become a local sound', !/(?:hear|audible|sound).{0,40}waterwheel|waterwheel.{0,30}(?:sound|echo)|(?:听见|听到|传来).{0,25}水车|水车.{0,15}(?:声|响)/i.test(text));
    }
  }
  if (['interrupt', 'cast-interrupt', 'guard', 'mixed-guard'].includes(test.type)) {
    check('does not allow rest or travel in combat', !/(?:should|must|can|recommend|need to|go and|try to)\s+(?:take a\s+)?(?:rest|sleep)|(?:allow|enable|permit)[^.;!?。！？\n]{0,45}\b(?:rest|travel)\b|(?:现在|应该|建议|可以|先).{0,5}(?:休息|睡觉|去酒馆|回酒馆)/i.test(affirmative(text)));
    check('does not settle the player turn', !/(?:you have|you've|I have|I've)\s+(?:already\s+)?(?:interrupted|guarded|blocked|defeated)|已经.{0,5}(?:打断|格挡|击败)/i.test(text));
  }
  return checks;
}

function selfCheck() {
  const tests = [
    [{type:'route',lang:'en',expected:{direction:'s'}}, 'Go south to the tavern.', ['Go north.', 'Google Maps can help.', 'It is in the square.', 'Go north or south.']],
    [{type:'interrupt',lang:'zh',expected:{}}, '现在打断，取消蓄力并使敌人露出破绽。', ['现在打断，取消蓄力并恢复生命和法力。', '打断后敌人HP减少100。', '无法打断蓄力。']],
    [{type:'guard',lang:'en',expected:{}}, 'You cannot interrupt now. Guard to reduce damage.', ['Guard increases health and MP.', 'Interrupt now, then guard to reduce damage.', 'Guard lets you rest and travel.']],
    [{type:'memory',lang:'zh',expected:{}}, '你的姐姐叫米拉。', ['你的姐姐叫玛拉。', 'Kaelen，米拉在哪儿呢？', '我不记得米拉。']],
    [{type:'cast-interrupt',lang:'en',expected:{}}, 'Interrupt to stop this spell; this does not guarantee exposure.', ['Interrupt and expose the enemy.', 'Interrupt will make it vulnerable.', 'Use Whirlwind to interrupt, spending 18 STA and reducing damage by 65%.']],
    [{type:'mixed-guard',lang:'zh',expected:{}}, '现在防御可减少伤害、恢复体力；防御不恢复生命。', ['现在打断敌人。', '防御恢复生命。']],
    [{type:'long-memory',lang:'en',expected:{}}, 'Your sister is named Mira. You promised to find the courier.', ['Your sister is Mira and you have already found the courier.', 'Your sister is called Lyra.']],
    [{type:'npc',lang:'zh',expected:{}}, '欢迎来到我的酒馆，旅人。', ['玛拉，欢迎来到酒馆！', '你获得了一把长剑。']],
    [{type:'npc-relationship',lang:'zh',expected:{flag:'scout_abandoned'}}, '你拿走受伤游侠的钱袋后离开，让我难以信任。', ['我对你有所戒备，因为你对我的信任和忠诚。']],
    [{type:'tavern',lang:'zh',expected:{}}, '炉火的暖光落在空着的椅子上。', ['远处传来水车缓缓转动的声音。', '信使坐在椅子上。', '你已经选择救回信使。']]
  ];
  for (const [test, good, bad] of tests) {
    assert.ok(judge(test, good).every(check => check.passed), good);
    for (const text of bad) assert.ok(judge(test, text).some(check => !check.passed), text);
  }
  const current = fixtures();
  for (const test of current) { assert.ok(test.ai.buildMessages(test.question, test.kind, test.scope).at(-1).content.includes(test.question)); test.game.dispose(); }
  console.log(`SELF-CHECK ONLY: semantic-check examples and ${current.length} actual game fixtures checked; no model loaded.`);
}

if (process.argv.includes('--self-check')) {
  selfCheck();
} else {
  const sourcePaths = [...modules.map(name => `src/${name}.js`), 'assets/ai-worker.js', 'tests/harness.mjs', 'tests/real-model.mjs'];
  const promptSource = Object.fromEntries(await Promise.all(sourcePaths.map(async name => [name, createHash('sha256').update(await readFile(path.join(root, name))).digest('hex')])));
  const timestamp = new Date().toISOString();
  const report = { timestamp, runtime: registry.runtime, model: model.id, revision: model.revision, dtype: model.dtype, registryDtype: registeredModel.dtype,
    environment: { platform:process.platform,arch:process.arch,node:process.version,hostLabel:option('environment') || 'unspecified',workingDirectory:root },
    backend:'native ONNX CPU, not browser WASM validation', promptSource, chatTemplateOptions:model.chatTemplateOptions || {},
    evaluation:'Required facts and selected contradictions are checked. Raw outputs still need semantic review; narrative samples never pass on nonempty output alone.',
    selectedLanguages:languages,selectedCases:selectedCases || null,completeSuite:!selectedCases && !option('lang'),
    generation:{max_new_tokens:model.maxNewTokens || 128,do_sample:false,repetition_penalty:repetitionPenalty,return_full_text:false,add_special_tokens:false},
    status:'pending',loadMs:null,results:[] };
  const outDir=path.join(root,'test-results'); await mkdir(outDir,{recursive:true});
  const runPath=path.join(outDir,`real-model-${key}-${model.dtype}-${timestamp.replace(/[:.]/g,'-')}.json`);
  const latest=path.join(outDir,`real-model-${key}${process.argv.includes('--prompts-only') ? '-prompts' : ''}.json`);
  const save=async()=>{const body=JSON.stringify(report,(_key,value)=>typeof value==='bigint'?value.toString():value,2)+'\n';await writeFile(runPath,body);await writeFile(latest,body);};
  let generator=null, runtime;
  const actual=fixtures();
  try {
    await save();
    if (!process.argv.includes('--prompts-only')) {
      runtime=await import('@huggingface/transformers');
      assert.equal(runtime.env.version,'3.8.1');
      const local=process.argv.includes('--local');
      runtime.env.allowRemoteModels=!local;runtime.env.allowLocalModels=local;
      runtime.env.localModelPath=path.join(root,'models/');runtime.env.cacheDir=path.join(root,'.cache/models');
      runtime.env.backends.onnx.wasm.numThreads=1;
      const started=performance.now();
      console.log(`Loading real ${model.id} @ ${model.revision} (${model.dtype}, CPU)…`);
      generator=await runtime.pipeline('text-generation',model.id,{dtype:model.dtype,device:'cpu',revision:model.revision,local_files_only:local,
        progress_callback:p=>{if(p.status==='done')console.log('Ready file:',p.file);}});
      report.loadMs=performance.now()-started;await save();
    }
    for(const test of actual) {
      const result={case:test.id,expected:test.expected,gameContext:test.game.json(`AethelgardAI.contextFor(${JSON.stringify(test.question)},${JSON.stringify(test.kind)})`),turns:[],status:'pending'};
      report.results.push(result);
      try {
        for(const question of [test.introduction,test.question].filter(Boolean)) {
          test.ai.rememberPlayerStatement(question,test.scope);
          const messages=JSON.parse(JSON.stringify(test.ai.buildMessages(question,test.kind,test.scope)));
          if(!generator) {result.turns.push({question,messages});continue;}
          const prompt=generator.tokenizer.apply_chat_template(messages,{tokenize:false,add_generation_prompt:true,...(model.chatTemplateOptions||{})});
          const encoded=generator.tokenizer(prompt,{add_special_tokens:false,truncation:false});
          const inputTokenIds=Array.from(encoded.input_ids.data,String),inputTokens=inputTokenIds.length;
          assert.ok(inputTokens<=model.contextBudget,`Prompt has ${inputTokens} tokens, exceeding ${model.contextBudget}. No facts will be silently truncated.`);
          let outputTokens=0,firstTokenMs=null;const started=performance.now();
          const streamer=new runtime.TextStreamer(generator.tokenizer,{skip_prompt:true,
            token_callback_function:tokens=>{outputTokens+=tokens.length;if(tokens.length)firstTokenMs??=performance.now()-started;},callback_function:()=>{}});
          const rawOutput=await generator(prompt,{...report.generation,streamer});
          const text=rawOutput[0]?.generated_text?.trim() || '',latencyMs=performance.now()-started;
          result.turns.push({question,messages,prompt,inputTokens,inputTokenIds,text,rawOutput,outputTokens,latencyMs,firstTokenMs,tokensPerSecond:outputTokens/(latencyMs/1000)});
          test.game.run(`state.ai.memory[${JSON.stringify(test.scope)}]=[...(state.ai.memory[${JSON.stringify(test.scope)}] || []),{role:'user',content:${JSON.stringify(question)}},{role:'assistant',content:${JSON.stringify(text)}}].slice(-12);`);
          await save();
        }
        if(!generator)result.status='prompts-only';
        else {
          const last=result.turns.at(-1);
          result.checks=judge(test,last.text);
          result.checks.push({name:'actual generated token callback',passed:last.outputTokens>0});
          result.status=result.checks.every(check=>check.passed)?(test.expected.manualReview?'needs-human-review':'passed'):'failed';
          console.log(JSON.stringify({case:test.id,status:result.status,text:last.text,failures:result.checks.filter(check=>!check.passed)},null,2));
        }
      } catch(error) {result.status='failed';result.error=String(error.stack||error);console.error(test.id,result.error);}
      await save();
    }
    report.passedCases=report.results.filter(result=>result.status==='passed').length;
    report.failedCases=report.results.filter(result=>result.status==='failed').length;
    report.manualReviewCases=report.results.filter(result=>result.status==='needs-human-review').length;
    report.status=!generator?'prompts-only':report.failedCases?'failed':report.manualReviewCases?'needs-human-review':'passed';
    if(report.failedCases)process.exitCode=1;else if(report.manualReviewCases)process.exitCode=2;
  } catch(error) {report.status='failed';report.error=String(error.stack||error);process.exitCode=1;console.error(report.error);}
  finally {if(generator)await generator.dispose();for(const test of actual)test.game.dispose();await save();}
  console.log(`${report.status.toUpperCase()}: ${report.passedCases||0}/${report.results.length} cases passed; ${report.manualReviewCases||0} narrative samples require semantic review.`);
  console.log('Evidence report:',runPath);
}
