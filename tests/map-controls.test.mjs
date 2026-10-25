import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';

const view = h => h.json('WorldMap.getView()');
function assertWholeMapVisible(h) {
  const camera = view(h);
  for (const room of h.json('Object.values(WORLD_ROOMS)')) {
    assert.ok(room.x - 63.99 >= camera.x && room.x + 63.99 <= camera.x + camera.width, `${room.id} horizontal label extent`);
    assert.ok(room.y - 31.99 >= camera.y && room.y + 31.99 <= camera.y + camera.height, `${room.id} vertical marker extent`);
  }
}

test('Atlas panning persists through world ticks and hero movement without changing game resources', () => {
  const h = createHarness();
  try {
    h.run('renderAll()');
    const original = h.json('({player:state.player,room:state.world.currentRoom,visited:state.world.visitedRooms,mapZoom:state.mapZoom})');
    h.run('WorldMap.panBy(80, -40); WorldMap.zoom(.25)');
    const panned = view(h);
    assert.equal(panned.mode, 'free');
    assert.deepEqual(h.json('({player:state.player,room:state.world.currentRoom,visited:state.world.visitedRooms,mapZoom:state.mapZoom})'), original);
    h.run('runWorldTick(); renderAll(); moveDirection("n"); runWorldTick()');
    assert.equal(h.state.world.currentRoom, 'r_north_gate');
    assert.deepEqual(view(h), panned, 'heartbeat and room redraw must not snap the camera back');
    h.run('WorldMap.centerOnHero()');
    const reset = view(h), room = h.json('WORLD_ROOMS[state.world.currentRoom]');
    assert.equal(reset.mode, 'follow');
    assert.equal(reset.zoom, 1);
    assert.equal(reset.centerX, room.x); assert.equal(reset.centerY, room.y);
  } finally { h.dispose(); }
});

test('Fit all includes procedural frontier and remains complete after responsive resize', () => {
  const h = createHarness();
  try {
    h.run('renderAll(); WorldMap.fitAll()');
    assert.equal(view(h).mode, 'fit'); assertWholeMapVisible(h);
    const originalCount = h.run('Object.keys(WORLD_ROOMS).length');
    h.run('expandProceduralFrontier(9, true); renderAll()');
    assert.ok(h.run('Object.keys(WORLD_ROOMS).length') > originalCount);
    assertWholeMapVisible(h);
    h.run('document.getElementById("world-minimap").getBoundingClientRect = () => ({left:0,top:0,right:350,bottom:192,width:350,height:192}); renderWorldMinimap()');
    assertWholeMapVisible(h);
    assert.ok(Math.abs(view(h).width / view(h).height - 350 / 192) < 1e-8);
  } finally { h.dispose(); }
});

test('Free camera stays bounded and resets safely when a different save replaces state', () => {
  const h = createHarness();
  try {
    h.run('renderAll(); WorldMap.panBy(1e9, -1e9)');
    const panned = view(h), points = h.json('Object.values(WORLD_ROOMS).map(r => ({x:r.x,y:r.y}))');
    assert.ok(panned.x < Math.max(...points.map(r => r.x)) + 64);
    assert.ok(panned.y + panned.height > Math.min(...points.map(r => r.y)) - 32);
    h.run('state = structuredClone(state); state.world.currentRoom = "r_wilds_trail"; renderAll()');
    const reset = view(h), room = h.json('WORLD_ROOMS.r_wilds_trail');
    assert.equal(reset.mode, 'follow');
    assert.equal(reset.centerX, room.x); assert.equal(reset.centerY, room.y);
    assert.equal(h.run('WorldMap.panBy(NaN, Infinity)'), false);
    assert.deepEqual(view(h), reset);
  } finally { h.dispose(); }
});
