# Third-party components in the downloadable package

The game repository does not claim ownership of these components. Their upstream license notices are included here; model weights and runtime binaries are distributed only in the optional offline ZIP.

| Component | Pinned source | License text |
| --- | --- | --- |
| Qwen3 0.6B ONNX q8 | [ONNX conversion](https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX/tree/58ca03a5e7b354b480b1a82b34bde8dc7b854cc0); [upstream model license](https://huggingface.co/Qwen/Qwen3-0.6B/blob/main/LICENSE) | [Apache 2.0](Qwen3-Apache-2.0.txt) |
| Transformers.js 3.8.1 | Locked npm package `@huggingface/transformers@3.8.1` | [Apache 2.0](Transformers-Apache-2.0.txt) |
| ONNX Runtime Web WASM | Runtime files bundled in that exact Transformers.js distribution, verified by SHA256; package dependency `1.22.0-dev.20250409-89f8206ba4` | [MIT](ONNX-Runtime-MIT.txt), from the [official 1.22 license](https://github.com/microsoft/onnxruntime/blob/v1.22.0/LICENSE) |
| Generated Tailwind CSS | Locked npm package `tailwindcss@3.4.17` | [MIT](Tailwind-MIT.txt) |

Alternative model entries link their own upstream license in `models/registry.json`. The default offline ZIP contains only its selected model. This notice does not change the license or ownership of the original game repository.
