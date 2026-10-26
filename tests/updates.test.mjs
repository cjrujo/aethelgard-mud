/** Actual bootstrap/save/update logic in the existing game VM.
 * ServiceWorker registration, transport, DOM, and timers are explicit doubles.
 * These tests do not prove a real browser installed or activated an offline shell.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';

async function fixture(options={}) {
  const messages=[],listeners=new Map();
  let updateCalls=0,reloads=0,postFailure=options.postFailure===true;
  let announced=options.announced || {id:'next-build',version:'11.1.0'};
  const waiting={postMessage(message){
    if(postFailure)throw new DOMException('Service worker became redundant.','InvalidStateError');
    messages.push(message);
  }};
  const registration={
    waiting:options.waiting===false?null:waiting,
    update:async()=>{updateCalls++;if(options.offline)throw new TypeError('NetworkError: offline');return registration;},
    addEventListener(){}
  };
  const serviceWorker={controller:{},register:async()=>registration,
    addEventListener(name,fn){listeners.set(name,fn);}};
  const h=createHarness({modules:['core','gameplay','combat','auto-gather','map-controls','bootstrap'],boot:true,globals:{
    navigator:{language:'en',onLine:!options.offline,serviceWorker},
    location:{protocol:'http:',origin:'http://localhost:8000',href:'http://localhost:8000/index.html',hostname:'localhost',reload(){reloads++;}},
    fetch:async()=>{if(options.offline)throw new TypeError('NetworkError: offline');return Response.json(announced);}
  }});
  // register() and the boot-time build-info check both settle without running
  // fake game timers or pretending a SW install occurred.
  for(let i=0;i<8;i++)await Promise.resolve();
  return {h,api:h.run('AethelgardApp'),registration,messages,
    setAnnouncement(value){announced=value;},setPostFailure(value){postFailure=value;},
    controllerChanged(){listeners.get('controllerchange')?.();},
    get updateCalls(){return updateCalls;},get reloads(){return reloads;}};
}

test('an already-waiting offline shell activates without making another network update request',async t=>{
  const f=await fixture({offline:true});t.after(()=>f.h.dispose());
  assert.equal(f.api.canWrite(),true);
  f.h.run("state.player.name='Saved before activating';");
  assert.equal(await f.api.saveAndUpdate(),true);
  assert.equal(f.updateCalls,0,'The complete waiting shell must not require connectivity again.');
  assert.deepEqual(f.messages.map(message=>message.type),['ACTIVATE_UPDATE']);
  assert.equal(JSON.parse(f.h.storage.getItem(f.h.run('STORAGE_KEY'))).player.name,'Saved before activating');
  assert.equal(f.h.document.getElementById('app-update-now').disabled,true);
  assert.equal(f.reloads,0,'Wait for controllerchange before reloading.');
  f.controllerChanged();assert.equal(f.reloads,1);
});

test('a failed activation message restores a usable update button and the game heartbeat',async t=>{
  const f=await fixture({postFailure:true});t.after(()=>f.h.dispose());
  const before=f.h.run('tickIntervalHandle');assert.notEqual(before,null);
  assert.equal(await f.api.saveAndUpdate(),false);
  assert.equal(f.api.canWrite(),true);
  assert.equal(f.h.document.getElementById('app-update-now').disabled,false,'A failed attempt must not leave refreshRequested latched.');
  const after=f.h.run('tickIntervalHandle');
  assert.notEqual(after,null);assert.ok(f.h.timers.get(after)?.repeat,'Restore the real heartbeat scheduling, not only the button.');
  assert.equal(f.reloads,0);assert.equal(f.messages.length,0);
  f.setPostFailure(false);
  assert.equal(await f.api.saveAndUpdate(),true,'The same page can retry successfully.');
  assert.equal(f.messages.length,1);
});

test('a server rollback to the loaded build clears a stale update banner when nothing is waiting',async t=>{
  const f=await fixture({waiting:false});t.after(()=>f.h.dispose());
  assert.equal(await f.api.checkForUpdate(),true);
  assert.equal(f.h.document.getElementById('app-update-banner').hidden,false);
  f.setAnnouncement(f.api.getBuild());
  assert.equal(await f.api.checkForUpdate(),false);
  assert.equal(f.h.document.getElementById('app-update-banner').hidden,true);
});

test('a matching server build does not hide an already-downloaded waiting update',async t=>{
  const f=await fixture();t.after(()=>f.h.dispose());
  f.setAnnouncement(f.api.getBuild());
  await f.api.checkForUpdate();
  assert.ok(f.registration.waiting);
  assert.equal(f.h.document.getElementById('app-update-banner').hidden,false);
});
