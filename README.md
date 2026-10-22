# Aethelgard: Chronicles of the Shattered Rift (v9 — Diablo Loot & Hybrid Online Edition)

An open-world browser MUD RPG featuring:
- **Diablo-Style Randomized Loot Affixes & Equipment Sets (2pc & 4pc Bonuses)**:
  - Dynamic Prefixes (*Vampiric*, *Thunder-Forged*, *Godslayer's*, *Chrono-Warped*, *Savage*, *Celestial*) & Suffixes (*of the Void*, *of the Titan*, *of Chain-Lightning*, *of the Phoenix*, *of Execution*).
  - **3 Complete Equipment Sets**: *Stormcaller's Regalia*, *Crimson Warlord's Battlegear*, and *Astral Singularity Vestments* with real-time **2-Piece** and **4-Piece** combat multipliers and elemental procs.
- **Hybrid Offline / Online Multiplayer Architecture**:
  - **Play Offline Anytime**: Explore the 32 hand-crafted rooms + endless procedural frontier sectors, harvest resources, craft, and collect Diablo-style set gear with 100% local persistence (`localStorage` + portable JSON Character Passport).
  - **Bring Your Character Online**: Click `🌐 Online: OFF/LIVE` in the top bar to set your **Online Alias & Team/Alliance Tag**, sync your offline character into the multiplayer hub, meet friends in the same room, chat, run **Co-op Team Boss Raids**, and fight **3v3 Team Arena Skirmishes**.
- **3 Zero-Install / 1-Command Online Transports**:
  1. **Zero-Config WebRTC / BroadcastChannel Mesh** (works out of the box on static **GitHub Pages** or **Cloudflare Pages** with zero backend config).
  2. **Cloudflare Workers + Durable Objects WebSocket Realm** (`cloudflare-worker/worker.js` + `wrangler.toml` included).

## 🚀 Easy Deployment Guide

### Option A: Zero-Install Static Hosting on GitHub Pages or Cloudflare Pages
1. Push this repository to GitHub.
2. Enable **Settings → Pages → Deploy from `main` branch**.
3. Open your GitHub Pages URL — offline mode and local/mesh multiplayer work immediately!

### Option B: Global Real-Time WebSocket Server on Cloudflare Workers (1 Command)
1. Install Node.js and run:
   ```bash
   cd cloudflare-worker
   npx wrangler deploy
   ```
2. Copy the deployed `wss://aethelgard-mud-realm.<your-subdomain>.workers.dev` URL into the **Cloudflare Worker WS Endpoint** box inside the game's `🌐 Online Hub` modal.
