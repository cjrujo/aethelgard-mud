# Local AI recovery and fresh verification — 2026-10-23

## What was recovered

The original cloud working directory was no longer present on 2026-10-23. A read-only copy of `D:\CoS\Aethelgard_v10_QA_20261022` provided two text-source packages, dated 2026-10-22 15:42 and 16:07 UTC. Their nine source modules and Tailwind configuration were recovered exactly from base64/zlib/JSON payloads and matched the current PC files. The later AI fixes, model Worker, final model registry, quality tests and full validation reports were absent from this PC staging directory.

This is a recovered and revalidated release candidate, not a claim that the lost final ZIP was found. `src/ai-dm.js` was restored from the PC module plus preserved final prompt/behavior changes. `assets/ai-worker.js` was reconstructed against the actual interfaces in the installed, pinned Transformers.js 3.8.1 package. The recovered PC files and readback metadata remain separate from the working repository so their earlier provenance is not obscured.

## Actual inference and limits

The browser Worker imports Transformers.js, loads a pinned ONNX model, applies that model's chat template and calls the real text-generation pipeline. It uses CPU/WASM, one thread, deterministic generation, repetition penalty 1.0 and Qwen3's `enable_thinking: false`. Input token counts come from the tokenizer; output token counts and first-token latency come from `TextStreamer` callbacks. A timeout, failed download, empty answer or missing token callback is an error, never a simulated successful inference.

The default model is `onnx-community/Qwen3-0.6B-ONNX`, q8, revision `58ca03a5e7b354b480b1a82b34bde8dc7b854cc0`. The registry pins its weight SHA256 and size. Qwen2.5 0.5B q4 and SmolLM2 135M q4 remain explicitly experimental alternatives. None is a hosted chat API. Optional Ollama integration accepts loopback/local-proxy endpoints and refuses cloud-marked model identifiers.

Offline mode loads the runtime and model files from the same-origin package and disables remote model loading. Before making a Worker, the page checks the offline manifest's runtime, selected model identity, revision, dtype, required file coverage and registered weight digest. The installer verifies all file bytes against SHA256; the page does not read another 600 MB copy solely to repeat that check. HTTP origins without CacheStorage can still infer; the UI explicitly reports the absence of persistent browser caching. Loading the supplied offline files does not require a new model download.

Current game facts are built from the real map, player resources, combat decisions and authored encounters. Navigation and combat facts are visible by default beside the model's unchanged original text. Past answers keep the facts captured when their question was asked. The model cannot move the player, choose an encounter outcome, award loot, change stats or settle a battle. Encounter narration excludes previous chat and unchosen outcomes, and is supplementary to the authored opening and choices.

## New verification results

All results below were run after this recovery. Earlier passing counts are not reused.

| Check | Fresh result | What it establishes |
|---|---:|---|
| `node tests/ai.test.mjs` | 18 passed | Actual prompt/UI/lifecycle code with explicitly mocked model/network transports; includes cancellation, scoped memory, stale responses, offline manifest rejection, factual cards and non-finite progress events. |
| `node tests/ai-worker.test.mjs` | 5 passed | Worker protocol, immutable revision, offline environment, one-thread WASM, token-callback metrics, context budgeting and honest failure behavior with a mocked runtime. |
| `node tests/real-model.mjs --self-check` | 8 game fixtures plus contradiction examples checked | No model loaded; validates actual map/combat fixtures and the evaluator itself. |
| Real default-model native CPU suite | 7 of 8 required-fact cases passed; exit 1 | Actual local weights, current game prompts, original raw outputs and token metrics. Chinese 4/4, English 3/4. |
| Real Chinese NPC/well/tavern samples | 3 raw samples; exit 2 | No automatic narrative pass. Semantic review below identifies two failures. |

The native quality suite is recorded in `docs/validation/recovered-ai-facts-native.json`. The English zero-stamina guard answer incorrectly claims that guarding increases health. Actual rules restore 18 stamina and 8 mana and reduce incoming damage by 65%; they do not heal HP. The evaluator rejects that output. Both route answers state the actual southward map direction. Both interrupt answers select the affordable interrupt. The two-turn memory cases remember Mira, though the English answer's first-person phrasing remains awkward. These small fixed cases do not establish reliable open-ended reasoning.

`docs/validation/recovered-ai-story-native.json` preserves all three original narrative outputs, prompts, token IDs and a separate semantic review:

- **NPC:** the model uses the correct Silverbrook Ford rumor but addresses the visitor as Mara, reversing the requested persona. Not fully qualified.
- **Well:** adds light, sound and smell while preserving the whispering well and unresolved choice. Acceptable as supplementary atmosphere in this one sample.
- **Tavern:** keeps the courier absent but makes the waterwheel mentioned in his note audible from the tavern. That acoustic relation is unsupported. Not fully qualified.

No output was repaired, replaced with a template, or rerun with case-specific prompt tuning to force a pass. The short generation prompts remain the known final prompt design. The later progress-bar fix only accepts finite percentages and was verified separately; it does not change model input. Browser WASM acceptance is a separate test and should be reported from `tests/browser.mjs`, not inferred from native CPU success.

## Reproduction

```sh
node tests/ai.test.mjs
node tests/ai-worker.test.mjs
node tests/real-model.mjs --self-check
node tests/real-model.mjs --model=qwen-0.6b --local --environment=your-machine
node tests/real-model.mjs --model=qwen-0.6b --local --lang=zh --case=npc,encounter,tavern --environment=your-machine
```

`--local` forbids remote model downloads. Without it, the explicit real-model test may download the pinned model. Failed checks still write immutable timestamped reports to `test-results/` and return nonzero exit codes. Story samples use exit 2 until their raw text has been reviewed. Protocol mocks are never reported as generated model answers.
