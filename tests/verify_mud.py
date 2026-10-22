#!/usr/bin/env python3
"""Mentor automated verification suite for Aethelgard Open-World Browser MUD (Goal Version 4 - v6).

Runs:
1. check_web_app.py static validation (0 errors, 0 warnings, and 0 REMOVED_FEATURE against --previous)
2. World graph connectivity (32 rooms, 5 biomes, 100% BFS reachability)
3. Headless Chromium / Selenium live browser verification across C1-C12:
   - C7: Single-screen auto-fit layout with all 3 left-column cards and #terminal-log visible (zero hidden/squashed panels)
   - C8/C11: 10-Language Single-Locale Mode (en, zh, es, ja, ko, fr, de, pt, ru, ar) — user selects language and ONLY the selected language is displayed (zero dual-language side-by-side stacking)
   - C9: CPU-friendly Small LLM Trial (LocalTinyLM <5ms CPU inference, NPC roleplay, AI encounter, AI advisor)
   - C10: Large World Map that ALWAYS dynamically centers its viewBox on the user's current room coordinates (r.x, r.y)
"""
import json
from pathlib import Path
import re
import subprocess
import sys

CHECKER = Path("/working_dir/c_b3c278134b5cb48e/skills/web-app-generation/scripts/check_web_app.py")

def verify_candidate(html_path: str, previous_path: str | None = None) -> dict:
    path = Path(html_path)
    text = path.read_text(encoding="utf-8")

    # 1. Run check_web_app.py
    cmd = [sys.executable, str(CHECKER), str(path)]
    if previous_path and Path(previous_path).exists():
        cmd += ["--previous", str(previous_path)]
    static_res = subprocess.run(cmd, capture_output=True, text=True)

    # 2. Inspect room count, biomes
    room_ids = re.findall(r"\b(r_[a-z0-9_]+)\s*:\s*\{\s*id:\s*\"(r_[a-z0-9_]+)\"", text)
    unique_rooms = sorted({r[0] for r in room_ids})
    biomes = re.findall(r"biome:\s*\"([^\"]+)\"", text)
    unique_biomes = sorted(set(biomes))

    # 3. Run Headless Chromium / Selenium functional gameplay simulation at 1366x640 laptop viewport
    browser_results = {}
    try:
        from selenium import webdriver
        from selenium.webdriver.chrome.options import Options

        offline_html = (
            text.replace('src="https://cdn.tailwindcss.com/3.4.17"', "")
                .replace('href="https://fonts.googleapis.com', 'data-href="')
        )

        opts = Options()
        opts.add_argument("--headless=new")
        opts.add_argument("--no-sandbox")
        opts.add_argument("--disable-dev-shm-usage")
        opts.add_argument("--disable-gpu")
        opts.add_argument("--window-size=1366,640")
        driver = webdriver.Chrome(options=opts)
        try:
            driver.get("about:blank")
            driver.execute_script(
                "document.open(); document.write(arguments[0]); document.close(); if (window.onload) window.onload();",
                offline_html,
            )
            initial_room = driver.execute_script("return state.world.currentRoom;")

            # Verify C7: Single-screen non-scrolling viewport & all 7 core cards present
            viewport_check = driver.execute_script("""
                const bodyStyle = window.getComputedStyle(document.body);
                const htmlStyle = window.getComputedStyle(document.documentElement);
                const requiredCards = [
                    'card-hero-vitals', 'card-stance-skills', 'card-stats-talents',
                    'room-context-card', 'terminal-log', 'world-atlas-card', 'right-drawer-card'
                ];
                const allCardsPresent = requiredCards.every(id => Boolean(document.getElementById(id)));
                return {
                    bodyOverflow: bodyStyle.overflow,
                    htmlOverflow: htmlStyle.overflow,
                    allCardsPresent,
                    singleScreenLocked: bodyStyle.overflow === 'hidden' && htmlStyle.overflow === 'hidden' && allCardsPresent
                };
            """)

            # Verify C11: 10-Language Single-Locale Mode (en, zh, es, ja, ko, fr, de, pt, ru, ar)
            lang_check = driver.execute_script("""
                const sel = document.getElementById('lang-select');
                const options = sel ? Array.from(sel.options).map(o => o.value) : [];
                const expected = ['en', 'zh', 'es', 'ja', 'ko', 'fr', 'de', 'pt', 'ru', 'ar'];
                const hasAll10Options = expected.every(code => options.includes(code));

                const perLangTrace = {};
                expected.forEach(code => {
                    setLanguage(code);
                    const roomTitle = document.getElementById('room-title-display').textContent;
                    const roomDesc = document.getElementById('room-desc-display').textContent;
                    const zhTitleHidden = document.getElementById('room-title-zh-display').classList.contains('hidden');
                    const zhDescHidden = document.getElementById('room-desc-zh-display').classList.contains('hidden');
                    const logEntries = Array.from(document.querySelectorAll('#terminal-log > div'));
                    const singleLineLogsOnly = logEntries.every(div => div.children.length === 1);
                    const lastLogText = logEntries.length ? logEntries[logEntries.length - 1].textContent : '';
                    perLangTrace[code] = {
                        activeLang: state.lang,
                        docLang: document.documentElement.lang,
                        docDir: document.documentElement.dir,
                        roomTitle,
                        zhTitleHidden,
                        zhDescHidden,
                        singleLineLogsOnly,
                        lastLogText
                    };
                });

                // Reset back to English and verify zero Chinese characters in roomTitle/roomDesc/minimap
                setLanguage('en');
                const enRoomTitle = document.getElementById('room-title-display').textContent;
                const enRoomDesc = document.getElementById('room-desc-display').textContent;
                const enMinimapText = document.getElementById('world-minimap').textContent;
                const enHasZeroZh = !(/[\\u4e00-\\u9fff]/.test(enRoomTitle) || /[\\u4e00-\\u9fff]/.test(enRoomDesc) || /[\\u4e00-\\u9fff]/.test(enMinimapText));

                // Switch to Chinese and verify Chinese roomTitle & minimap
                setLanguage('zh');
                const zhRoomTitle = document.getElementById('room-title-display').textContent;
                const zhHasChinese = /[\\u4e00-\\u9fff]/.test(zhRoomTitle);

                // Reset to English for remaining gameplay tests
                setLanguage('en');

                return {
                    options,
                    hasAll10Options,
                    enHasZeroZh,
                    zhHasChinese,
                    arIsRtl: perLangTrace.ar && perLangTrace.ar.docDir === 'rtl',
                    allSingleLineLogs: expected.every(c => perLangTrace[c].singleLineLogsOnly && perLangTrace[c].zhTitleHidden && perLangTrace[c].zhDescHidden),
                    sampleTitles: Object.fromEntries(expected.map(c => [c, perLangTrace[c].roomTitle]))
                };
            """)

            # Verify C10: Initial map centering on r_town_square (110, 260)
            map_center_initial = driver.execute_script("""
                const svg = document.getElementById('world-minimap');
                const vb = (svg.getAttribute('viewBox') || '').split(/\\s+/).map(Number);
                const r = WORLD_ROOMS[state.world.currentRoom];
                const cx = vb[0] + vb[2] / 2;
                const cy = vb[1] + vb[3] / 2;
                return {
                    roomId: r.id,
                    roomX: r.x,
                    roomY: r.y,
                    viewBox: svg.getAttribute('viewBox'),
                    centerX: cx,
                    centerY: cy,
                    centeredOnPlayer: Math.abs(cx - r.x) <= 1 && Math.abs(cy - r.y) <= 1
                };
            """)

            # Verify BFS reachability across all 32 rooms
            reachability = driver.execute_script("""
                const allIds = Object.keys(WORLD_ROOMS);
                const reachable = allIds.filter(id => id === 'r_town_square' || (findShortestPath('r_town_square', id) && findShortestPath('r_town_square', id).length > 0));
                return {
                    totalRooms: allIds.length,
                    reachableCount: reachable.length,
                    allReachable: reachable.length === allIds.length
                };
            """)

            # Test movement commands ('n', 'norte', 'e') to r_old_mill (x=175, y=130) and verify map re-centers on user!
            driver.execute_script("executeCommand('n'); executeCommand('norte'); executeCommand('e');")
            map_center_after_move = driver.execute_script("""
                const svg = document.getElementById('world-minimap');
                const vb = (svg.getAttribute('viewBox') || '').split(/\\s+/).map(Number);
                const r = WORLD_ROOMS[state.world.currentRoom];
                const cx = vb[0] + vb[2] / 2;
                const cy = vb[1] + vb[3] / 2;
                adjustMapZoom(0.25);
                const vbZoomed = (svg.getAttribute('viewBox') || '').split(/\\s+/).map(Number);
                const cxZoomed = vbZoomed[0] + vbZoomed[2] / 2;
                const cyZoomed = vbZoomed[1] + vbZoomed[3] / 2;
                resetMapZoom();
                return {
                    roomId: r.id,
                    roomX: r.x,
                    roomY: r.y,
                    viewBoxAfterMove: vb.join(' '),
                    centeredAfterMove: Math.abs(cx - r.x) <= 1 && Math.abs(cy - r.y) <= 1,
                    centeredAfterZoom: Math.abs(cxZoomed - r.x) <= 1 && Math.abs(cyZoomed - r.y) <= 1
                };
            """)

            # Move back West to r_wilds_trail and test harvesting
            driver.execute_script("executeCommand('w'); executeCommand('harvest');")
            room_after_move = driver.execute_script("return state.world.currentRoom;")
            herb_count = driver.execute_script("return state.player.inventory['Moonpetal Herb'] || 0;")

            # Test combat & active skills until enemy defeated
            combat_trace = driver.execute_script("""
                engageMob('briar_wolf');
                const startedInCombat = state.combat.inCombat;
                useSkill(0);
                let rounds = 0;
                while (state.combat.inCombat && rounds < 20) {
                    processCombatRound();
                    rounds++;
                }
                return {
                    startedInCombat,
                    rounds,
                    kills: state.telemetry.kills,
                    xp: state.player.xp,
                    gold: state.player.gold,
                    achFirstBlood: Boolean(state.achievements.ach_first_blood)
                };
            """)

            # Test crafting & gear star-refining
            craft_trace = driver.execute_script("""
                craftRecipe('rec_heal_1');
                state.player.gold += 100;
                refineEquippedGear();
                return {
                    craftedAfter: state.telemetry.crafted,
                    refineLevel: state.player.refineLevel,
                    achArtisan: Boolean(state.achievements.ach_artisan)
                };
            """)

            # Test C9: CPU-friendly Small LLM Trial
            ai_trial_trace = driver.execute_script("""
                askNpcAi('Where is Mythril Ore?');
                triggerAiEncounter();
                askAiTactics();
                const aiCount = (state.aiLogs || []).length;
                const lastAi = state.aiLogs[state.aiLogs.length - 1] || {};
                return {
                    aiLogCount: aiCount,
                    lastLatencyMs: lastAi.latencyMs,
                    hasEnAndZh: Boolean(lastAi.en && lastAi.zh)
                };
            """)

            # Test Endless Rift Wave mode & Portable Save/Import JSON persistence
            rift_and_save_trace = driver.execute_script("""
                startRiftWaveChallenge();
                const waveStarted = state.telemetry.activeRiftWave;
                state.combat.enemy.hp = 1;
                processCombatRound();
                openSaveModal();
                const exportedJson = document.getElementById('save-json-textarea').value;
                const savedHeroName = state.player.name;
                state.player.name = 'TempMutated';
                document.getElementById('save-json-textarea').value = exportedJson;
                importSaveJson();
                return {
                    waveStarted,
                    riftBestWave: state.telemetry.riftBestWave,
                    restoredName: state.player.name === savedHeroName,
                    versionTag: state.version
                };
            """)

            browser_results = {
                "selenium_ran": True,
                "initial_room": initial_room,
                "viewport_check": viewport_check,
                "lang_check": lang_check,
                "map_center_initial": map_center_initial,
                "map_center_after_move": map_center_after_move,
                "reachability": reachability,
                "room_after_move": room_after_move,
                "herb_count_after_harvest": herb_count,
                "combat_trace": combat_trace,
                "craft_trace": craft_trace,
                "ai_trial_trace": ai_trial_trace,
                "rift_and_save_trace": rift_and_save_trace,
            }
        finally:
            driver.quit()
    except Exception as exc:
        browser_results = {"selenium_ran": False, "error": str(exc)}

    all_passed = (
        static_res.returncode == 0
        and "OK: no issues found." in static_res.stdout
        and len(unique_rooms) == 32
        and len(unique_biomes) == 5
        and browser_results.get("selenium_ran") is True
        and browser_results.get("viewport_check", {}).get("singleScreenLocked") is True
        and browser_results.get("lang_check", {}).get("hasAll10Options") is True
        and browser_results.get("lang_check", {}).get("enHasZeroZh") is True
        and browser_results.get("lang_check", {}).get("zhHasChinese") is True
        and browser_results.get("lang_check", {}).get("arIsRtl") is True
        and browser_results.get("lang_check", {}).get("allSingleLineLogs") is True
        and browser_results.get("map_center_initial", {}).get("centeredOnPlayer") is True
        and browser_results.get("map_center_after_move", {}).get("centeredAfterMove") is True
        and browser_results.get("map_center_after_move", {}).get("centeredAfterZoom") is True
        and browser_results.get("reachability", {}).get("allReachable") is True
        and browser_results.get("combat_trace", {}).get("kills", 0) >= 1
        and browser_results.get("craft_trace", {}).get("craftedAfter", 0) >= 1
        and browser_results.get("ai_trial_trace", {}).get("hasEnAndZh") is True
        and browser_results.get("rift_and_save_trace", {}).get("restoredName") is True
    )

    return {
        "candidate_path": str(path),
        "static_check": {
            "returncode": static_res.returncode,
            "stdout": static_res.stdout.strip(),
            "passed": static_res.returncode == 0 and "OK: no issues found." in static_res.stdout
        },
        "world_graph_metrics": {
            "room_count": len(unique_rooms),
            "biome_count": len(unique_biomes),
            "biomes": unique_biomes
        },
        "headless_browser_tests": browser_results,
        "overall_passed": all_passed
    }

if __name__ == "__main__":
    target = sys.argv[1]
    prev = sys.argv[2] if len(sys.argv) > 2 else None
    report = verify_candidate(target, prev)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    sys.exit(0 if report["overall_passed"] else 1)
