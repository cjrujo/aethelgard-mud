/* Optional arrival-based gathering. Only the preference is saved; a pending
 * pass belongs to this exact hero state and this stay in a room. */
const AutoGather = (() => {
  'use strict';
  const text = (en, zh) => getLang() === 'zh' ? zh : en;
  const canWrite = () => typeof window.AethelgardApp?.canWrite !== 'function' || window.AethelgardApp.canWrite();
  const onlineBusy = () => typeof OnlineRealm !== 'undefined' && typeof OnlineRealm.isBusy === 'function' && OnlineRealm.isBusy();
  let owner = state, pass = null, running = false;

  function resetSession() { owner = state; pass = null; }
  function ensure() {
    if (owner !== state) resetSession();
    if (state.autoGather !== true) {
      state.autoGather = false;
      pass = null;
    }
    if (pass && pass.roomId !== state.world.currentRoom) pass = null;
    return state.autoGather;
  }
  function synchronize() {
    ensure();
    if (!pass) return;
    const room = WORLD_ROOMS[pass.roomId];
    // A manual harvest, changed permission or removed node settles that part of
    // this pass. Never wait until its cooldown expires and collect it again.
    pass.pending = pass.pending.filter(id => {
      const node = room?.nodes?.find(n => n.id === id);
      return node && !state.world.harvestedCooldowns[`${pass.roomId}:${id}`] && CombatDirector.harvestAccess(node.item).allowed;
    });
  }
  function advance() {
    synchronize();
    if (running || !pass || !pass.pending.length || !state.autoGather) return false;
    if (!canWrite() || onlineBusy() || state.combat.inCombat) return false;
    const current = pass;
    running = true;
    try {
      const result = CombatDirector.harvest({ nodeIds: current.pending, partial: true, quiet: true });
      if (owner !== state || pass !== current) return false;
      if (result.ok) {
        const gathered = new Set(result.harvested);
        current.pending = current.pending.filter(id => !gathered.has(id));
        current.gathered += gathered.size;
      } else if (result.reason === 'invalid_node') {
        current.pending = [];
        current.invalid = true;
      }
      return result.ok;
    } finally { running = false; }
  }
  function arrive() {
    ensure();
    if (!state.autoGather || !canWrite()) return false;
    const room = WORLD_ROOMS[state.world.currentRoom];
    const nodes = room?.nodes || [];
    const ready = nodes.filter(node => !state.world.harvestedCooldowns[`${room.id}:${node.id}`]);
    const permitted = ready.filter(node => CombatDirector.harvestAccess(node.item).allowed);
    pass = { roomId: state.world.currentRoom, pending: [...new Set(permitted.map(node => node.id))], gathered: 0,
      nodes: nodes.length, cooling: nodes.length - ready.length, locked: ready.length - permitted.length, invalid: false };
    const changed = advance();
    render();
    return changed;
  }
  function setEnabled(value) {
    if (typeof value !== 'boolean' || !canWrite()) return false;
    ensure();
    if (state.autoGather === value) { render(); return true; }
    state.autoGather = value;
    if (value) arrive(); else resetSession();
    addLog(value ? '🌿 Auto-gather enabled: collect available nodes once on each arrival.' : '🌿 Auto-gather disabled.', 'world', 'text-emerald-300',
      value ? '🌿 自动采集已开启：到达地点后，采集当次可用的资源。' : '🌿 自动采集已关闭。');
    saveGameState(false); renderAll();
    return true;
  }
  function toggle() { return setEnabled(!ensure()); }
  function getStatus() {
    synchronize();
    const result = { enabled: state.autoGather === true, phase: 'off', pending: pass?.pending.length || 0, gathered: pass?.gathered || 0,
      locked: pass?.locked || 0, cooling: pass?.cooling || 0, roomId: pass?.roomId || null, message: '' };
    if (!result.enabled) result.message = text('Off · gather manually or enable collection on arrival.', '已关闭 · 可手动采集，或开启到达后自动采集。');
    else if (!canWrite()) {
      result.phase = 'read_only'; result.message = text('Paused · another tab owns this hero.', '已暂停 · 另一标签页正在使用此英雄。');
    } else if (onlineBusy()) {
      result.phase = 'online_battle'; result.message = text('Paused during online battles.', '在线战斗期间暂停采集。');
    } else if (state.combat.inCombat) {
      result.phase = 'combat'; result.message = text('Paused during combat.', '战斗期间暂停采集。');
    } else if (!pass) {
      result.phase = 'idle'; result.message = text('On · collect once on each arrival; no idle farming.', '已开启 · 每次到达采集一轮，停留时不反复采集。');
    } else if (pass.invalid) {
      result.phase = 'invalid_node'; result.message = text('Stopped · this resource has invalid data.', '已停止本轮 · 资源数据无效。');
    } else if (result.pending) {
      result.phase = 'stamina'; result.message = text(`Waiting for stamina · ${result.pending} node(s) left; ${CombatDirector.harvestCost()} STA each.`, `等待体力恢复 · 还剩 ${result.pending} 处，每处消耗 ${CombatDirector.harvestCost()} 体力。`);
    } else if (pass.gathered) {
      result.phase = 'complete'; result.message = text(`Collected ${pass.gathered} node(s) here.${pass.locked ? ` ${pass.locked} require gathering preparation.` : ''} Continue exploring for the next pass.`, `本地点已采集 ${pass.gathered} 处。${pass.locked ? `另有 ${pass.locked} 处尚未解锁采集准备。` : ''}前往下一地点继续。`);
    } else if (pass.locked) {
      result.phase = 'locked'; result.message = text('No available nodes · gathering preparation is required.', '暂无可采集资源 · 需先解锁区域采集准备。');
    } else if (pass.cooling) {
      result.phase = 'cooldown'; result.message = text('Resources were recovering on arrival. Revisit later.', '到达时资源正在恢复，稍后重新到访可采集。');
    } else {
      result.phase = pass.nodes ? 'complete' : 'empty'; result.message = text(pass.nodes ? 'This pass is complete. Continue exploring.' : 'No resources here. Auto-gather stays on for the next location.', pass.nodes ? '本轮采集已结束，可继续探索。' : '此处没有资源，到达下一地点后继续自动采集。');
    }
    return result;
  }
  function render() {
    const status = getStatus(), button = document.getElementById('btn-auto-gather'), label = document.getElementById('auto-gather-status');
    if (button) {
      button.textContent = text(`🌿 Auto-Gather: ${status.enabled ? 'ON' : 'OFF'}`, `🌿 自动采集：${status.enabled ? '开启' : '关闭'}`);
      button.setAttribute('aria-pressed', String(status.enabled));
      button.setAttribute('data-active', String(status.enabled));
      button.title = text('Collect currently available resources on arrival. Costs stamina; respects cooldowns and gathering preparation.', '到达地点后采集当前可用资源；消耗体力，并遵守冷却与采集准备要求。');
      button.disabled = status.phase === 'read_only';
    }
    if (label) { label.textContent = status.message; label.setAttribute('data-phase', status.phase); }
  }

  const previousMove = moveDirection;
  moveDirection = function() {
    const before = state.world.currentRoom;
    const result = previousMove.apply(this, arguments);
    if (state.world.currentRoom !== before) arrive();
    return result;
  };
  const previousTick = runWorldTick;
  runWorldTick = function() {
    synchronize();
    const result = previousTick.apply(this, arguments);
    advance(); render();
    return result;
  };
  const previousRender = renderAll;
  renderAll = function() { const result = previousRender.apply(this, arguments); render(); return result; };
  const previousCommand = executeCommand;
  executeCommand = function(raw) {
    const words = String(raw || '').trim().toLowerCase().split(/\s+/);
    if (!['autogather', 'auto-gather', '自动采集'].includes(words[0])) return previousCommand.apply(this, arguments);
    if (words.length === 1) return toggle();
    if (words.length === 2 && ['on', '开启', '开'].includes(words[1])) return setEnabled(true);
    if (words.length === 2 && ['off', '关闭', '关'].includes(words[1])) return setEnabled(false);
    addLog('Use autogather [on/off].', 'world', 'text-slate-400', '输入：自动采集 [开启/关闭]。');
    return false;
  };
  return { ensure, toggle, setEnabled, getStatus, render, resetSession };
})();
window.AutoGather = AutoGather;
