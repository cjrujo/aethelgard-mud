/* These tests use MOCK worker/network transports. They verify the actual UI,
 * prompt and lifecycle code, never model quality. See real-model.mjs for that. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHarness, projectRoot } from './harness.mjs';

const registry = JSON.parse(fs.readFileSync(`${projectRoot}/models/registry.json`, 'utf8'));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve=yes; reject=no; }); return {promise,resolve,reject}; };
const reply = (text='MOCK local service output') => new Response(JSON.stringify({model:'test-model',message:{content:text},done:true,prompt_eval_count:3,eval_count:4,eval_duration:1000000000})+'\n');
function fixture(options={}) {
  const workers=[],requests=[];
  class MockWorker {
    constructor(url, config) { this.url=String(url);this.config=config;this.messages=[];this.terminated=false;workers.push(this); }
    postMessage(message) {
      this.messages.push(message);
      if(message.type==='load' && options.autoLoad!==false) queueMicrotask(()=>this.deliver({id:message.id,type:'ready',model:message.config.model.id,loadMs:20,cacheEnabled:true}));
    }
    deliver(data) { this.onmessage?.({data}); }
    terminate() { this.terminated=true; }
  }
  const f=createHarness({modules:['core','gameplay','combat','ai-dm','bootstrap'],lang:options.lang || 'en',storage:options.storage,
    globals:{AETHELGARD_MODEL_REGISTRY:registry,Worker:MockWorker,DOMException,
      fetch:(url,init)=>{requests.push({url:String(url),init});if(options.fetch)return options.fetch(url,init);throw new Error('Unexpected MOCK network request');},...options.globals}});
  f.run('AethelgardApp.restore(createInitialState()); AethelgardAI.ensureState();');
  f.document.getElementById('ai-model-select').value=registry.models[0].key;
  const ai=f.run('AethelgardAI');
  return {...f,ai,workers,requests};
}
function manifest() {
  const model=registry.models[0],files={};
  for(const name of model.files)files[`models/${model.id}/${name}`]=model.sha256?.[name] || 'a'.repeat(64);
  for(const name of registry.runtimeFiles)files[`vendor/${name}`]='b'.repeat(64);
  return {runtime:registry.runtime,models:[model],files};
}

test('an unloaded model gives an honest error without inference counts or hidden fallback',async()=>{
  const f=fixture(),before=f.json('state.player');
  assert.equal(await f.ai.ask('Where is the tavern?',{kind:'general'}),null);
  assert.equal(f.ai.getStatus().inferenceCount,0);assert.equal(f.json('state.aiLogs.at(-1)').status,'error');
  assert.equal(f.json('state.aiLogs.at(-1)').text,'');assert.deepEqual(f.json('state.player'),before);
});

test('explicit rules advice uses actual map and zero-stamina facts, with no fabricated token metrics',async()=>{
  const f=fixture();f.ai.selectBackend('rules');
  const route=await f.ai.ask('Where is the tavern?',{kind:'general'});
  assert.equal(route.source,'rules');assert.equal(route.outputTokens,null);assert.match(route.text,/follow s/);
  f.run("state.world.currentRoom='r_wilds_trail'; CombatDirector.startEncounter(MOB_TEMPLATES.briar_wolf); state.combat.enemy.intent='charge'; state.player.sta=0;");
  const combat=await f.ai.ask('What should I do in this battle?',{kind:'tactics'});
  assert.match(combat.text,/Recommended action: Guard now/);assert.match(combat.text,/Interrupt is unavailable/);
  assert.equal(f.ai.getStatus().inferenceCount,0);
});

test('offline loading validates package identity, revision, runtime and required-file coverage before making a worker',async()=>{
  for(const corrupt of [m=>{m.runtime='wrong';},m=>{m.models=[{...m.models[0],revision:'0'.repeat(40)}];},m=>{delete m.files['vendor/transformers.min.js'];},m=>{m.files[`models/${registry.models[0].id}/onnx/model_quantized.onnx`]='c'.repeat(64);}]){
    const body=manifest();corrupt(body);
    const f=fixture({fetch:()=>Promise.resolve(Response.json(body))});
    f.document.getElementById('ai-local-files').checked=true;await f.ai.loadBrowserModel();
    assert.equal(f.workers.length,0);assert.equal(f.ai.getStatus().status,'error');assert.equal(f.ai.getStatus().loadCount,0);
  }
  const f=fixture({fetch:()=>Promise.resolve(Response.json(manifest()))});
  f.document.getElementById('ai-local-files').checked=true;await f.ai.loadBrowserModel();
  assert.equal(f.workers.length,1);const load=f.workers[0].messages[0];
  assert.equal(load.config.localOnly,true);assert.match(load.config.runtimeUrl,/localhost:8000\/vendor\/transformers.min.js$/);
  assert.equal(load.config.runtimeVersion,registry.runtime);assert.equal(f.ai.getStatus().loadCount,1);
});

test('MOCK local API failures remain errors; explicit fallback is visibly labeled',async()=>{
  const f=fixture({fetch:async()=>{throw new Error('MOCK service unavailable');}});f.ai.selectBackend('local_ollama');
  assert.equal(await f.ai.ask('Where is the tavern?',{kind:'general'}),null);
  assert.equal(f.json('state.aiLogs.at(-1)').status,'error');assert.equal(f.ai.getStatus().inferenceCount,0);
  f.run('state.ai.allowFallback=true;');
  const result=await f.ai.ask('Where is the tavern?',{kind:'general'});
  assert.equal(result.source,'rules-fallback');assert.match(result.fallbackReason,/MOCK service unavailable/);
  assert.equal(f.ai.getStatus().inferenceCount,0);
});

test('worker progress tolerates init/done packets without numeric progress and clamps finite percentages',async()=>{
  const f=fixture({autoLoad:false}),assignments=[];let indeterminate=0;
  f.elements.set('ai-download-progress',{hidden:false,set value(value){assert.ok(Number.isFinite(value),'HTMLProgressElement rejects a non-finite double');assignments.push(value);},removeAttribute(name){assert.equal(name,'value');indeterminate++;}});
  const pending=f.ai.loadBrowserModel(),worker=f.workers[0],request=worker.messages[0];
  for(const progress of [{status:'init'},{status:'done'},{progress:undefined},{progress:NaN},{progress:Infinity},{progress:-3},{progress:150},{progress:42}])worker.deliver({id:request.id,type:'progress',progress});
  assert.ok(indeterminate>=5);assert.deepEqual(assignments,[0,100,42]);
  worker.deliver({id:request.id,type:'ready',model:registry.models[0].id,loadMs:10});await pending;
  assert.equal(f.ai.getStatus().status,'ready');assert.equal(assignments.at(-1),100);
});

test('MOCK Ollama streaming preserves split UTF-8 and uses server token metrics',async()=>{
  const bytes=new TextEncoder().encode(JSON.stringify({message:{content:'MOCK 米拉'}})+'\n'+JSON.stringify({done:true,model:'test-model',eval_count:7,eval_duration:2000000000,prompt_eval_count:9})+'\n');
  const f=fixture({fetch:()=>new Response(new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=3)controller.enqueue(bytes.slice(i,i+3));controller.close();}}))});
  f.ai.selectBackend('local_ollama');const result=await f.ai.ask('MOCK question');
  assert.equal(result.text,'MOCK 米拉');assert.equal(result.outputTokens,7);assert.equal(result.tokensPerSecond,3.5);
  assert.equal(result.inputTokens,9);assert.equal(result.source,'ollama');assert.equal(f.ai.getStatus().inferenceCount,1);
});

test('an incomplete MOCK stream cannot count as a completed model answer',async()=>{
  const f=fixture({fetch:()=>new Response(JSON.stringify({message:{content:'MOCK unfinished'}})+'\n')});f.ai.selectBackend('local_ollama');
  assert.equal(await f.ai.ask('MOCK question'),null);assert.equal(f.ai.getStatus().inferenceCount,0);
  assert.equal(f.json('state.aiLogs.at(-1)').status,'error');assert.match(f.json('state.aiLogs.at(-1)').error,/without a completed answer/);
});

test('Ollama rejects remote endpoints and cloud-marked models before sending a request',async()=>{
  const f=fixture();f.ai.selectBackend('local_ollama');
  f.run("state.ai.ollamaUrl='https://example.com';");assert.equal(await f.ai.ask('MOCK'),null);assert.equal(f.requests.length,0);
  f.run("state.ai.ollamaUrl='http://127.0.0.1:11434'; state.ai.ollamaModel='qwen:cloud';");assert.equal(await f.ai.ask('MOCK'),null);assert.equal(f.requests.length,0);
});

test('NPC conversation memory stays scoped and survives save restoration',async()=>{
  const f=fixture({fetch:()=>reply('MOCK remembered Mira')});f.ai.selectBackend('local_ollama');
  f.run("state.world.currentRoom='r_tavern';");await f.ai.ask('My sister is Mira.',{kind:'npc'});
  const scopes=f.json('Object.keys(state.ai.memory)');assert.equal(scopes.length,1);assert.match(scopes[0],/^npc:/);
  const saved=f.json('state');f.run(`AethelgardApp.restore(${JSON.stringify(saved)});`);
  assert.match(JSON.stringify(f.json('state.ai.memory')),/Mira/);
  f.run("state.world.currentRoom='r_blacksmith';");await f.ai.ask('What do you know?',{kind:'npc'});
  const body=JSON.parse(f.requests.at(-1).init.body);assert.doesNotMatch(JSON.stringify(body.messages),/My sister is Mira/);
});

test('zero-stamina prompts use a neutral enemy intent and preserve real skill/supply details only when requested',()=>{
  const f=fixture();f.run("CombatDirector.startEncounter(MOB_TEMPLATES.briar_wolf); state.combat.enemy.intent='charge'; state.player.sta=0; state.player.cooldowns[0]=2;");
  const short=f.ai.buildMessages('The enemy is charging. What should I do?', 'tactics','dm').at(-1).content;
  assert.match(short,/Recommended action: Guard now/);assert.match(short,/Intent: Charging a heavy blow/);
  assert.match(short,/spends one player turn/);assert.doesNotMatch(short,/Interrupt now|Can afford interrupt: yes/);
  const details=f.ai.buildMessages('Which skills and potions can I use?', 'tactics','dm').at(-1).content;
  assert.match(details,/2 turn cooldown/);assert.match(details,/Supplies:/);assert.doesNotMatch(details,/To reach Moonpetal/);
});

test('Chinese combat and navigation questions receive actual facts and the travel restriction',()=>{
  const f=fixture({lang:'zh'});f.run("state.lang='zh'; CombatDirector.startEncounter(MOB_TEMPLATES.briar_wolf); state.combat.enemy.intent='charge'; state.player.sta=100;");
  assert.match(f.ai.buildMessages('敌人正在蓄力，我该怎么做？','general','dm').at(-1).content,/现在打断/);
  const route=f.ai.buildMessages('酒馆在哪里？请告诉我方向。','general','dm');
  assert.match(route[0].content,/游戏向导/);assert.match(route.at(-1).content,/向南/);assert.match(route.at(-1).content,/成功撤退/);
});

test('recall prompts include the actual scoped history and omit unrelated campaign goals',()=>{
  const f=fixture();f.run("state.ai.memory.dm=[{role:'user',content:'My sister is Mira.'},{role:'assistant',content:'MOCK acknowledgment'}];");
  const prompt=f.ai.buildMessages('What did I tell you my missing sister is named?','general','dm');
  assert.equal(prompt[1].content,'My sister is Mira.');assert.match(prompt[0].content,/earlier conversation/);
  assert.doesNotMatch(prompt.at(-1).content,/Current goal|Recent choice|GAME FACTS/);
});

test('encounter prompts preserve the actual missing-courier opening and isolate old dialogue and unchosen actions',()=>{
  const f=fixture({lang:'zh'});f.run("state.lang='zh'; state.world.currentRoom='r_tavern'; GameDirector.startEncounter(); state.ai.memory.dm=[{role:'user',content:'信使已经回来。'}];");
  const event=f.json('GameDirector.getContext().encounter');assert.equal(event.id,'tavern_courier');
  const prompt=f.ai.buildMessages('请描写这个场景，不必回忆旧对话。','encounter','dm');
  assert.equal(prompt.length,2);assert.match(prompt[0].content,/在场或缺席/);assert.ok(prompt[1].content.includes(event.opening));
  assert.match(prompt[1].content,/玩家尚未选择/);assert.doesNotMatch(JSON.stringify(prompt),/信使已经回来|可选行动：|当前目标：/);
  for(const choice of event.choices)assert.ok(!prompt[1].content.includes(choice.label));
});

test('fact cards default open for navigation/combat and preserve both saved facts and escaped original model text',async()=>{
  const f=fixture();f.ai.selectBackend('rules');await f.ai.ask('Where is the tavern?',{kind:'general'});
  f.run("state.aiLogs[0].source='wasm'; state.aiLogs[0].text='MOCK wrong: go north <script>x</script>'; state.world.currentRoom='r_tavern';");
  f.ai.render();const html=f.elements.get('ai-chat-log').innerHTML;
  assert.match(html,/data-authority="game-rules" open/);assert.match(html,/go south/);assert.match(html,/MOCK wrong: go north &lt;script&gt;x&lt;\/script&gt;/);
  assert.match(html,/Model response · original text/);assert.match(html,/actual state at the time of this question/);
  f.run("state.lang='zh'; state.ai.localOnly=true;");f.ai.render();
  assert.equal(f.elements.get('ai-load-model').textContent,'加载离线模型');assert.match(f.elements.get('ai-model-note').textContent,/不需下载/);
  f.run('state.ai.localOnly=false;');f.ai.render();assert.match(f.elements.get('ai-model-note').textContent,/首次下载/);
});

test('cancelling MOCK worker generation rejects late output and never changes player state',async()=>{
  const f=fixture();await f.ai.loadBrowserModel();const before=f.json('state.player');
  const answer=f.ai.ask('MOCK generation');const worker=f.workers[0],request=worker.messages.find(message=>message.type==='generate');
  worker.deliver({id:request.id,type:'chunk',text:'MOCK partial'});f.ai.cancel();
  worker.deliver({id:request.id,type:'complete',text:'MOCK late',source:'wasm',model:'test-model'});
  assert.equal(await answer,null);assert.equal(worker.terminated,true);assert.equal(f.ai.getStatus().inferenceCount,0);
  assert.equal(f.json('state.aiLogs.at(-1)').status,'cancelled');assert.deepEqual(f.json('state.player'),before);assert.deepEqual(f.json('state.ai.memory'),{});
});

test('backend switching and character restoration ignore stale MOCK service responses',async()=>{
  const first=deferred(),second=deferred();let calls=0;const f=fixture({fetch:()=>++calls===1?first.promise:second.promise});
  f.ai.selectBackend('local_ollama');const old=f.ai.ask('Old hero');f.ai.selectBackend('rules');
  assert.equal(f.requests[0].init.signal.aborted,true);const current=await f.ai.ask('Where is the tavern?',{kind:'general'});
  first.resolve(reply('MOCK stale old answer'));assert.equal(await old,null);assert.equal(current.source,'rules');
  f.ai.selectBackend('local_ollama');const importing=f.ai.ask('Old character');f.run("const replacement=createInitialState();replacement.player.name='New Hero';AethelgardApp.restore(replacement);");
  second.resolve(reply('MOCK another stale answer'));assert.equal(await importing,null);assert.equal(f.run('state.player.name'),'New Hero');assert.equal(f.run('state.aiLogs.length'),0);
});

test('cancel during offline-manifest checking prevents a delayed worker from loading',async()=>{
  const pending=deferred(),f=fixture({fetch:()=>pending.promise});f.document.getElementById('ai-local-files').checked=true;
  const loading=f.ai.loadBrowserModel();f.ai.cancel();pending.resolve(Response.json(manifest()));await loading;
  assert.equal(f.workers.length,0);assert.equal(f.ai.getStatus().loadCount,0);assert.equal(f.ai.getStatus().ready,false);
});

test('an old service finally block cannot detach the active request cancellation controller',async()=>{
  const old=deferred(),next=deferred();let count=0;const f=fixture({fetch:()=>++count===1?old.promise:next.promise});f.ai.selectBackend('local_ollama');
  const first=f.ai.ask('old');f.ai.cancel();const second=f.ai.ask('new');
  old.resolve(reply('MOCK old'));await first;f.ai.cancel();
  assert.equal(f.requests[1].init.signal.aborted,true);next.resolve(reply('MOCK new but cancelled'));assert.equal(await second,null);
});

test('mixed memory/combat questions share one intent and retain zero-stamina facts in all entry points',()=>{
  const f=fixture({lang:'zh'});f.run("state.lang='zh'; CombatDirector.startEncounter(MOB_TEMPLATES.briar_wolf); state.combat.enemy.intent='charge'; state.player.sta=0;");
  for(const kind of ['tactics','npc','general']) for(const question of ['刚才体力不够，敌人正在蓄力，下一步怎么打？','记得我刚才不能打断，现在该怎么做？']){
    const messages=f.ai.buildMessages(question,kind,'dm');
    assert.equal(f.ai.classifyIntent(question,kind).primary,'combat');assert.match(messages[0].content,/战术顾问/);
    assert.match(messages.at(-1).content,/STA 0\/100/);assert.match(messages.at(-1).content,/本回合无法使用打断/);
    assert.match(messages.at(-1).content,/现在防御/);assert.match(f.ai.rulesReply(question,kind).text,/STA 0\/100/);
  }
  const resources=f.ai.factsFor('刚才我有多少金币，现在还剩多少？','general');assert.match(resources,/金币/);assert.match(resources,/HP/);
  const route=f.ai.rulesReply('我记得酒馆在附近，应该怎么走？','general');assert.match(route.text,/南/);assert.match(route.text,/成功撤退/);
});

test('interrupt advice shares actual combat effects and does not promise exposure after a cast',()=>{
  const f=fixture();f.run("state.world.currentRoom='r_wilds_trail'; CombatDirector.startEncounter(MOB_TEMPLATES.sporeling_mystic);");
  const effect=f.json('CombatDirector.getContext().decisions.interrupt.effect');
  assert.equal(effect.cancelsCurrentAction,true);assert.equal(effect.exposesNextTurn,false);
  const facts=f.ai.factsFor('The enemy is casting. What should I do?', 'tactics');
  assert.ok(facts.includes(effect.descriptionEn));
  assert.doesNotMatch(facts,/Skills:|Supplies:|65%/);
  assert.doesNotMatch(facts,/and expose the enemy/);
  const hp=f.run('state.player.hp');assert.equal(f.run("CombatDirector.action('interrupt')"),true);
  assert.equal(f.run('state.player.hp'),hp);assert.equal(f.run('state.combat.enemy.intent'),'strike');
});

test('NPC cards identify both speakers and retrieve real trust, choices and durable flags',()=>{
  const f=fixture({lang:'zh'});f.run("state.lang='zh'; state.world.currentRoom='r_tavern';");
  const before=f.ai.buildMessages('玛拉，你对我有何看法？','npc','npc:innkeeper_mara');
  f.run("GameDirector.ensureState().trust.town=-5; GameDirector.ensureState().flags.scout_abandoned=true; GameDirector.ensureState().journal.push({id:'event:test-choice',kind:'choice',roomId:'r_tavern',title:{en:'Recorded kindness',zh:'真实善举'},body:{en:'You left medicine for the search party.',zh:'你为搜救队留下了药剂。'}});");
  const after=f.ai.buildMessages('玛拉，你对我有何看法？','npc','npc:innkeeper_mara');
  assert.notDeepEqual(after,before);assert.match(after[0].content,/酒馆老板娘玛拉.*Kaelen/);
  assert.match(after.at(-1).content,/说话者：酒馆老板娘玛拉。听话者：Kaelen/);
  assert.match(after.at(-1).content,/信任 -5.*不信任/);assert.match(after.at(-1).content,/真实善举/);assert.match(after.at(-1).content,/拿走受伤游侠的钱袋/);
  const remembered=f.ai.buildMessages('你还记得为什么对我戒备吗？','npc','npc:innkeeper_mara');
  assert.match(remembered.at(-1).content,/信任 -5/);assert.match(remembered.at(-1).content,/拿走受伤游侠的钱袋/);
});

test('explicit player names and promises survive a long dialogue, scoped save restore and correction',async()=>{
  const f=fixture({fetch:()=>reply('MOCK unsupported claim: Your sister is Lyra. I awarded a crown.')});f.ai.selectBackend('local_ollama');
  f.run("state.world.currentRoom='r_tavern';");
  await f.ai.ask('My sister is named Mira. I promise to find the courier.',{kind:'npc'});
  for(let i=0;i<8;i++)await f.ai.ask(`Tell me about ordinary topic ${i}.`,{kind:'npc'});
  const scope='npc:innkeeper_mara',saved=f.json('state');
  assert.doesNotMatch(JSON.stringify(saved.ai.memory[scope]),/named Mira/);
  f.run(`AethelgardApp.restore(${JSON.stringify(saved)});`);
  const prompt=JSON.stringify(f.ai.buildMessages('What is my sister named and what did I promise?','npc',scope));
  assert.match(prompt,/Mira/);assert.match(prompt,/find the courier/);assert.match(prompt,/not proof it was fulfilled/);
  assert.doesNotMatch(JSON.stringify(f.json('state.ai.knowledge')),/Lyra|awarded a crown/);
  assert.doesNotMatch(JSON.stringify(f.ai.buildMessages('What is my sister named?','npc','npc:forgemaster_brom')),/Mira/);
  f.ai.rememberPlayerStatement('My sister is named Elin.',scope);
  const corrected=f.ai.playerFactsFor('What is my sister named?',scope).join(' ');
  assert.match(corrected,/Elin/);assert.doesNotMatch(corrected,/Mira/);
});

test('legacy memory migration trusts only explicit user statements and bounds malformed new fields',()=>{
  const f=fixture();
  f.run("delete state.ai.knowledge; state.ai.memory={dm:[{role:'user',content:'My friend is named Nia.'},{role:'assistant',content:'My sister is named Fake. I promise to reward you.'}]}; state.ai.pendingQuestion='bad'; state.ai.feedback=[null,'bad',{prompt:'x'.repeat(5000),answer:'y'.repeat(30000)}];");
  f.ai.ensureState();
  assert.match(JSON.stringify(f.json('state.ai.knowledge')),/Nia/);assert.doesNotMatch(JSON.stringify(f.json('state.ai.knowledge')),/Fake|reward/);
  assert.equal(f.run('state.ai.pendingQuestion'),null);assert.equal(f.run('state.ai.feedback[0].prompt.length'),1200);assert.equal(f.run('state.ai.feedback[0].answer.length'),16000);
  f.ai.rememberPlayerStatement('My sister is not here. My brother is powerful. 我的姐姐是战士。我的妹妹叫什么名字？','dm');
  assert.equal(f.run('state.ai.knowledge.scopes.dm.length'),1);
  f.ai.rememberPlayerStatement('我承诺过什么？What did I promise to do? 你说我的姐姐叫玛拉，对吗？','dm');
  assert.equal(f.run('state.ai.knowledge.scopes.dm.length'),1);
});

test('stop keeps the question and explicit resume reloads the same model then generates once',async()=>{
  const f=fixture();await f.ai.loadBrowserModel();
  const pending=f.ai.ask('Where is the tavern?',{kind:'general'});f.ai.cancel();await pending;
  assert.equal(f.ai.getStatus().ready,false);assert.equal(f.json('state.ai.pendingQuestion').question,'Where is the tavern?');
  assert.equal(f.elements.get('ai-resume').hidden,false);
  const resumed=f.ai.resumeQuestion();
  for(let i=0;i<12&&!f.workers[1]?.messages.some(m=>m.type==='generate');i++)await Promise.resolve();
  const worker=f.workers[1],load=worker.messages.find(m=>m.type==='load'),request=worker.messages.find(m=>m.type==='generate');
  assert.equal(load.config.model.revision,registry.models[0].revision);assert.ok(request);
  worker.deliver({id:request.id,type:'complete',text:'MOCK go south.',source:'wasm',model:registry.models[0].id,inputTokens:10,outputTokens:4});
  assert.equal((await resumed).text,'MOCK go south.');assert.equal(f.ai.getStatus().inferenceCount,1);
  assert.equal(f.run('state.ai.pendingQuestion'),null);assert.equal(f.ai.getStatus().loadCount,2);
});

test('resume never replays an NPC question in a different room or a completed encounter',async()=>{
  const f=fixture();await f.ai.loadBrowserModel();f.run("state.world.currentRoom='r_tavern';");
  const pending=f.ai.ask('Who are you?',{kind:'npc'});f.ai.cancel();await pending;
  f.run("state.world.currentRoom='r_blacksmith';");
  assert.equal(await f.ai.resumeQuestion(),null);assert.equal(f.workers.length,1);assert.equal(f.run('state.ai.pendingQuestion'),null);
  assert.equal(f.elements.get('ai-prompt-input').value,'Who are you?');assert.match(f.ai.getStatus().detail,/scene changed/);
  const g=fixture();await g.ai.loadBrowserModel();g.run('GameDirector.startEncounter();');
  const narration=g.ai.ask('Describe the current opening.',{kind:'encounter'});g.ai.cancel();await narration;
  assert.equal(g.json('state.ai.pendingQuestion').eventId,'first_oath');
  g.run('GameDirector.resolveChoice(0);');
  assert.equal(await g.ai.resumeQuestion(),null);assert.equal(g.workers.length,1);assert.equal(g.run('state.ai.pendingQuestion'),null);
});

test('local feedback retains the original question-time evidence and exact answer without networking',async()=>{
  const f=fixture();f.ai.selectBackend('rules');await f.ai.ask('Where is the tavern?',{kind:'general'});
  f.run("state.aiLogs[0].source='wasm'; state.aiLogs[0].model='test-model'; state.aiLogs[0].revision='fixed-revision'; state.aiLogs[0].text='MOCK wrong answer <script>bad</script>'; state.world.currentRoom='r_tavern';");
  assert.equal(f.ai.recordFeedback(0,'facts'),true);assert.equal(f.ai.recordFeedback(0,'facts'),true);
  const data=f.ai.feedbackExport();assert.equal(data.feedback.length,1);assert.equal(data.feedback[0].answer,'MOCK wrong answer <script>bad</script>');
  assert.match(data.feedback[0].facts,/go south/);assert.equal(data.feedback[0].room,'r_town_square');assert.equal(data.feedback[0].revision,'fixed-revision');
  assert.equal(f.requests.length,0);assert.match(f.elements.get('ai-chat-log').innerHTML,/&lt;script&gt;bad&lt;\/script&gt;/);
  data.feedback[0].answer='changed outside';assert.notEqual(f.ai.feedbackExport().feedback[0].answer,'changed outside');
});

test('read-only save ownership blocks AI state mutations while feedback export remains readable',async()=>{
  const f=fixture();const before=f.json('state.ai'),logs=f.json('state.aiLogs');
  f.run('window.AethelgardApp={canWrite:()=>false};');
  assert.equal(await f.ai.ask('My sister is named Mira.'),null);f.ai.selectBackend('rules');f.ai.updateSettings();f.ai.clearMemory();f.ai.clearFeedback();
  assert.equal(f.ai.rememberPlayerStatement('My sister is named Mira.','dm'),false);assert.equal(f.ai.recordFeedback(0),false);
  assert.deepEqual(f.json('state.ai'),before);assert.deepEqual(f.json('state.aiLogs'),logs);assert.match(f.ai.getStatus().detail,/read-only/);
  assert.equal(f.ai.feedbackExport().feedback.length,0);assert.equal(f.requests.length,0);
});

test('a numeric Worker response id cannot replace the stable dialogue id or break feedback controls',async()=>{
  const f=fixture();await f.ai.loadBrowserModel();
  const pending=f.ai.ask('Where is the tavern?',{kind:'general'});
  const originalId=f.run('state.aiLogs.at(-1).id'),worker=f.workers[0],job=worker.messages.find(m=>m.type==='generate');
  assert.equal(typeof originalId,'string');assert.equal(typeof job.id,'number');
  worker.deliver({id:job.id,type:'complete',text:'MOCK south.',source:'wasm',model:registry.models[0].id,outputTokens:3});await pending;
  assert.equal(f.run('state.aiLogs.at(-1).id'),originalId);
  assert.equal(f.ai.recordFeedback(0,'facts'),true);f.ai.ensureState();f.ai.render();
  assert.equal(f.json('state.ai.feedback')[0].entryId,originalId);
  assert.match(f.elements.get('ai-chat-log').innerHTML,/disabled>✓ Fact error/);
  assert.equal(f.ai.recordFeedback(0,'facts'),true);assert.equal(f.run('state.ai.feedback.length'),1);
});

test('legacy numeric log, pending and feedback ids remain linked through normalization, memory and save restore',async()=>{
  const f=fixture();
  f.run(`state.aiLogs=[
    {id:5,prompt:'Where is the tavern?',text:'MOCK south.',source:'wasm',status:'complete',room:'r_town_square',kind:'general'},
    {id:9,prompt:'What is my sister named?',text:'',source:'wasm',status:'cancelled',room:'r_town_square',kind:'general'}
  ]; state.ai.pendingQuestion={id:9,question:'What is my sister named?',room:'r_town_square',kind:'general'};
  state.ai.feedback=[{id:1,entryId:5,prompt:'Where is the tavern?',answer:'MOCK south.',room:'r_town_square',category:'facts'}];
  state.ai.memory.dm=[{role:'user',content:'My sister is named Mira.'}]; delete state.ai.knowledge;`);
  f.ai.ensureState();
  assert.deepEqual(f.json('state.aiLogs.map(e=>e.id)'),['5','9']);
  assert.equal(f.run('state.ai.pendingQuestion.id'),'9');assert.equal(f.run('state.ai.feedback[0].entryId'),'5');
  for(let i=0;i<2;i++){
    const saved=f.json('state');f.run(`AethelgardApp.restore(${JSON.stringify(saved)});`);
    assert.equal(f.run('state.ai.pendingQuestion.id'),'9');assert.equal(f.run('state.ai.feedback[0].entryId'),'5');
    assert.match(f.ai.playerFactsFor('What is my sister named?','dm').join(' '),/Mira/);
  }
  f.ai.render();assert.match(f.elements.get('ai-chat-log').innerHTML,/disabled>✓ Fact error/);
  const resumed=f.ai.resumeQuestion();
  for(let i=0;i<12&&!f.workers[0]?.messages.some(m=>m.type==='generate');i++)await Promise.resolve();
  const worker=f.workers[0],job=worker.messages.find(m=>m.type==='generate');assert.ok(job);
  assert.match(JSON.stringify(job.messages),/Mira/);
  worker.deliver({id:job.id,type:'complete',text:'MOCK your sister is Mira.',source:'wasm',model:registry.models[0].id,outputTokens:5});
  assert.equal((await resumed).text,'MOCK your sister is Mira.');assert.equal(f.run('state.ai.pendingQuestion'),null);
  assert.equal(typeof f.run('state.aiLogs.at(-1).id'),'string');assert.equal(f.run('state.ai.feedback[0].entryId'),'5');
});

test('repeated legacy numeric ids and older index-based feedback migrate to distinct persistent log ids',()=>{
  const f=fixture();
  f.run(`state.aiLogs=[
    {id:5,prompt:'First question',text:'First answer',source:'wasm',status:'complete',room:'r_town_square'},
    {id:5,prompt:'Second question',text:'Second answer',source:'wasm',status:'complete',room:'r_town_square'},
    {prompt:'Third question',text:'Third answer',source:'wasm',status:'complete',room:'r_town_square'}
  ];state.ai.feedback=[
    {id:1,entryId:5,prompt:'Second question',answer:'Second answer',room:'r_town_square',category:'facts'},
    {id:2,entryId:'legacy:0:First question',prompt:'First question',answer:'First answer',room:'r_town_square',category:'persona'}
  ];`);
  f.ai.ensureState();const ids=f.json('state.aiLogs.map(e=>e.id)');
  assert.equal(new Set(ids).size,3);assert.ok(ids.every(id=>typeof id==='string'&&id.length>0));
  assert.equal(f.run('state.ai.feedback[0].entryId'),ids[1]);assert.equal(f.run('state.ai.feedback[1].entryId'),ids[0]);
  f.ai.ensureState();assert.deepEqual(f.json('state.aiLogs.map(e=>e.id)'),ids);
  f.run("state.aiLogs.unshift({id:'new-entry',prompt:'New question',text:'New answer',status:'complete',source:'rules'});");
  f.ai.render();assert.equal(f.run('state.ai.feedback[0].entryId'),ids[1]);assert.match(f.elements.get('ai-chat-log').innerHTML,/disabled>✓ Fact error/);
});

test('cancelled numeric pending resumes cannot overtake a newer resume even when a legacy id is reused',async()=>{
  for(const newId of [6,5]){
    const f=fixture({autoLoad:false});
    f.run("state.ai.pendingQuestion={id:5,question:'Old saved question',kind:'general',room:'r_town_square'};");
    const oldResume=f.ai.resumeQuestion(),oldWorker=f.workers[0];
    assert.ok(oldWorker);f.ai.cancel();
    f.run(`state.ai.pendingQuestion={id:${newId},question:'New saved question',kind:'general',room:'r_town_square'};`);
    const newResume=f.ai.resumeQuestion(),newWorker=f.workers[1];assert.ok(newWorker);
    const load=newWorker.messages.find(m=>m.type==='load');
    newWorker.deliver({id:load.id,type:'ready',model:registry.models[0].id,loadMs:1,cacheEnabled:true});
    for(let i=0;i<16&&!newWorker.messages.some(m=>m.type==='generate');i++)await Promise.resolve();
    assert.equal(await oldResume,null);
    const generations=newWorker.messages.filter(m=>m.type==='generate');assert.equal(generations.length,1);
    assert.match(generations[0].messages.at(-1).content,/New saved question/);assert.doesNotMatch(generations[0].messages.at(-1).content,/Old saved question/);
    newWorker.deliver({id:generations[0].id,type:'complete',text:'MOCK newest answer',source:'wasm',model:registry.models[0].id,outputTokens:3});
    assert.equal((await newResume).text,'MOCK newest answer');assert.equal(f.run('state.ai.pendingQuestion'),null);assert.equal(f.ai.getStatus().inferenceCount,1);
  }
});
