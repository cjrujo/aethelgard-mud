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
