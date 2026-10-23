# 第三方组件与模型

本仓库游戏代码与第三方模型、推理运行库分别保留原有归属。以下许可索引不改变游戏仓库本身的许可，也不代表本项目拥有模型权重。

| 组件 | 本次固定来源 | 许可原文 |
| --- | --- | --- |
| Qwen3 0.6B，ONNX q8 | [onnx-community 转换，固定 revision](https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX/tree/58ca03a5e7b354b480b1a82b34bde8dc7b854cc0)，[Qwen 上游许可](https://huggingface.co/Qwen/Qwen3-0.6B/blob/main/LICENSE) | [Apache 2.0](licenses/Qwen3-Apache-2.0.txt) |
| Transformers.js 3.8.1 | `package-lock.json` 固定的 `@huggingface/transformers`；完整包携带其浏览器构建 | [Apache 2.0](licenses/Transformers-Apache-2.0.txt) |
| ONNX Runtime Web | 上述 Transformers.js 发行版中的 `.mjs` 与 `.wasm`，按 SHA256 校验；包依赖版本 `1.22.0-dev.20250409-89f8206ba4` | [MIT](licenses/ONNX-Runtime-MIT.txt)，来自[官方 v1.22.0 许可](https://github.com/microsoft/onnxruntime/blob/v1.22.0/LICENSE) |
| Tailwind CSS 3.4.17 | 锁定的 npm 包生成 `assets/game.css` | [MIT](licenses/Tailwind-MIT.txt) |

完整离线 ZIP 只携带选定的 Qwen3 q8 权重、对应配置/分词器与固定推理运行库。轻量源码 ZIP 不含这些权重或运行库。模型 revision、文件名、权重摘要和上游许可入口集中在 [models/registry.json](../models/registry.json)；实验备选 Qwen2.5、SmolLM2 未包含在默认完整包中。

重新打包时保留 `docs/licenses/` 中的原文。开发依赖的其他许可随各自 npm 包提供；交付包不分发 `node_modules`。更多英文来源说明见 [licenses/README.md](licenses/README.md)。
