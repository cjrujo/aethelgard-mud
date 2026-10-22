# Aethelgard: Chronicles of the Shattered Rift (v6 — 10-Language Edition)

An open-world browser MUD RPG with a **single-screen 100vh layout**, **player-centered dynamic SVG World Atlas**, **CPU-friendly local TinyLM AI Dungeon Master**, and **10-language single-locale mode** (`en`, `zh`, `es`, `ja`, `ko`, `fr`, `de`, `pt`, `ru`, `ar`).

## 🌍 10 Supported Mainstream Languages (Single-Language Display Mode)
Users can select their preferred language from the top bar (`#lang-select`) or via the terminal command `lang <code>` and **only the selected language** is displayed across the entire UI, rooms, map, items, quests, AI DM, and logs:
1. `en` — 🇺🇸 English
2. `zh` — 🇨🇳 简体中文
3. `es` — 🇪🇸 Español
4. `ja` — 🇯🇵 日本語
5. `ko` — 🇰🇷 한국어
6. `fr` — 🇫🇷 Français
7. `de` — 🇩🇪 Deutsch
8. `pt` — 🇧🇷 Português
9. `ru` — 🇷🇺 Русский
10. `ar` — 🇸🇦 العربية (with automatic RTL layout support)

## 🚀 Quick Push to Your GitHub Account

### Option A: Using GitHub CLI (`gh`) in 1 Command
```bash
unzip aethelgard_mud_github_repo.zip -d aethelgard-chronicles-mud
cd aethelgard-chronicles-mud
gh repo create aethelgard-chronicles-mud --public --source=. --remote=origin --push
```

### Option B: Push to an Existing GitHub Repository
```bash
unzip aethelgard_mud_github_repo.zip -d aethelgard-chronicles-mud
cd aethelgard-chronicles-mud
git remote add origin https://github.com/<YOUR_GITHUB_USERNAME>/<YOUR_REPO_NAME>.git
git branch -M main
git push -u origin main
```

## 📁 Repository Structure
- `index.html` / `open_world_mud.html`: Self-contained production release (`v6`) ready for GitHub Pages.
- `src/build_mud_game.py`: Deterministic Python builder for generating the single-file bundle.
- `docs/mud_design_plan.md`: Architecture, world graph, combat math, CPU AI DM, and 10-language localization spec.
- `tests/verify_mud.py`: Automated static + Selenium Headless Chromium test suite (`C1`–`C12`).
- `.github/workflows/deploy-pages.yml`: Automatic GitHub Pages deployment pipeline.
