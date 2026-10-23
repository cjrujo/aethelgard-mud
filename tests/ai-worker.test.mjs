/* MOCK runtime tests: protocol and configuration, not model output quality. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const source=await fs.readFile(new URL('../assets/ai-worker.js',import.meta.url),'utf8');
const {createWorkerController}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const registry=JSON.parse(await fs.readFile(new URL('../models/registry.json',import.meta.url),'utf8'));
function setup(options={}) {
  const messages=[],loads=[],generations=[],templates=[];let clock=0,disposed=0;
  const env={version:options.version || '3.8.1',backends:{onnx:{wasm:{}}}};
  const tokenizer=prompt=>({input_ids:{data:Array.from({length:prompt.length},(_,i)=>BigInt(i))}});
  tokenizer.apply_chat_template=(messages,opts)=>{templates.push({messages,opts});return messages.map(message=>message.content).join('\n');};
  const generator=async(prompt,config)=>{
    generations.push({prompt,config});
    const text=options.text ?? 'MOCK model output';
    config.streamer.options.token_callback_function(options.noTokens?[]:[1n,2n,3n]);
    config.streamer.options.callback_function(text);
    return [{generated_text:text}];
  };
  generator.tokenizer=tokenizer;generator.dispose=async()=>{disposed++;};
  const runtime={env,TextStreamer:class {constructor(_tokenizer,options){this.options=options;}},pipeline:async(task,id,config)=>{
    loads.push({task,id,config});if(options.failLoad)throw new Error('MOCK failed weight load');return generator;
  }};
  const controller=createWorkerController({postMessage:message=>messages.push(message),now:()=>clock+=10,cacheApi:options.cacheApi || null,importModule:async()=>runtime});
  const config={model:{...registry.models[0],contextBudget:256},localOnly:true,baseUrl:'http://localhost:8000/game/',runtimeVersion:registry.runtime,runtimeUrl:'http://localhost:8000/game/vendor/transformers.min.js'};
  return {controller,config,messages,loads,generations,templates,env,get disposed(){return disposed;}};
}
test('MOCK offline load uses pinned revision, local-only paths and single-thread WASM without relying on CacheStorage',async()=>{
  const f=setup();await f.controller.handle({id:1,type:'load',config:f.config});
  assert.equal(f.messages.at(-1).type,'ready');assert.equal(f.env.allowRemoteModels,false);assert.equal(f.env.allowLocalModels,true);
  assert.equal(f.env.localModelPath,'http://localhost:8000/game/models/');assert.equal(f.env.backends.onnx.wasm.numThreads,1);
  assert.equal(f.env.backends.onnx.wasm.proxy,false);assert.equal(f.env.backends.onnx.wasm.wasmPaths,'http://localhost:8000/game/vendor/');
  assert.equal(f.env.useBrowserCache,false);assert.equal(f.loads[0].config.device,'wasm');assert.equal(f.loads[0].config.local_files_only,true);
  assert.equal(f.loads[0].config.revision,registry.models[0].revision);
});
test('MOCK generated counts come from token callbacks; Qwen no-thinking and 1.0 repetition penalty reach the runtime',async()=>{
  const f=setup();await f.controller.handle({id:1,type:'load',config:f.config});
  await f.controller.handle({id:2,type:'generate',messages:[{role:'system',content:'MOCK system'},{role:'user',content:'MOCK question'}]});
  const result=f.messages.at(-1);assert.equal(result.type,'complete');assert.equal(result.outputTokens,3);assert.equal(result.text,'MOCK model output');
  assert.equal(f.templates[0].opts.enable_thinking,false);assert.equal(f.generations[0].config.repetition_penalty,1);
  assert.equal(f.generations[0].config.add_special_tokens,false);assert.equal(f.generations[0].config.return_full_text,false);
  assert.ok(result.firstTokenMs>0);assert.ok(result.latencyMs>0);
});
test('context budgeting removes old dialogue while preserving latest game facts and rejects oversized current questions',async()=>{
  const f=setup();await f.controller.handle({id:1,type:'load',config:f.config});
  await f.controller.handle({id:2,type:'generate',messages:[{role:'system',content:'role'},{role:'user',content:'old'.repeat(200)},{role:'assistant',content:'old answer'},{role:'user',content:'Current facts: south.'}]});
  assert.equal(f.messages.at(-1).droppedMessages,2);assert.equal(f.generations[0].prompt,'role\nCurrent facts: south.');
  await f.controller.handle({id:3,type:'generate',messages:[{role:'system',content:'role'},{role:'user',content:'current'.repeat(100)}]});
  assert.equal(f.messages.at(-1).type,'error');assert.equal(f.generations.length,1);
});
test('load failures, wrong runtime versions and empty/no-token outputs never emit a false completion',async()=>{
  for(const options of [{failLoad:true},{version:'0.0.0'}]){
    const f=setup(options);await f.controller.handle({id:1,type:'load',config:f.config});assert.equal(f.messages.at(-1).type,'error');
    assert.ok(!f.messages.some(message=>message.type==='ready'));
  }
  for(const options of [{text:''},{noTokens:true}]){
    const f=setup(options);await f.controller.handle({id:1,type:'load',config:f.config});
    await f.controller.handle({id:2,type:'generate',messages:[{role:'system',content:'role'},{role:'user',content:'question'}]});
    assert.equal(f.messages.at(-1).type,'error');assert.ok(!f.messages.some(message=>message.type==='complete'));
  }
});
test('unloaded, malformed and unpinned requests fail without generating a scripted answer',async()=>{
  const f=setup();await f.controller.handle({id:1,type:'generate',messages:[]});assert.equal(f.messages.at(-1).type,'error');
  await f.controller.handle({id:2,type:'load',config:{...f.config,model:{...f.config.model,revision:'main'}}});assert.equal(f.loads.length,0);
  await f.controller.handle({id:3,type:'load',config:{...f.config,runtimeUrl:'https://example.com/runtime.js'}});assert.equal(f.loads.length,0);
});
