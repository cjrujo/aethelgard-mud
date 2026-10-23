# Aethelgard · Living Chronicles（v10）

> **验收记录（2026-10-23）**：本次源码已重新执行规则回归和真实本地模型验证。测试命令、实际输出、失败案例与尚未覆盖的范围统一记录在 [验证记录](docs/verification.md)；本地通过不代表远端 CI 或公共服务已上线。

艾瑟尔加德是一款浏览器文字角色扮演游戏：在五个区域中探索、与人物建立关系、应对有预兆的敌人，并通过持续生效的选择决定裂隙的结局。

**v10 加入了真正的本地语言模型调用链，默认模型为 Qwen3 0.6B q8。** 浏览器模式通过独立 Web Worker 加载实际 ONNX 权重，在 CPU/WASM 上生成文字；也可以连接本机 Ollama。无需云端 API Key。没有加载模型时，可以明确选择规则助手；界面会区分模型回复、规则回复和失败后的显式回退。[AI 实现与使用说明](docs/ai-dm.md)

**模型内容仍有明确限制。** 当前 Qwen3 q8 已完成真实浏览器 CPU/WASM 加载与路线回复；Native CPU 事实测试仍发现虚构战斗效果，NPC 身份和叙事边界也未全部通过。成功生成文字不能代表整体准确率；叙事事实、行动效果和奖励始终由游戏规则负责。具体输出与限制见 [验证记录](docs/verification.md) 和 [AI 内容验收](docs/ai-dm.md#当前模型的实测范围与限制)。

## 立即开始

Windows、macOS 与 Linux 均需要 **Python 3.10 或更新版本**和现代浏览器。本仓库的打包工具提供两种本地交付形式：

| 包 | 包含什么 | 使用本地模型的准备 |
| --- | --- | --- |
| `aethelgard-v10-qwen-0.6b-offline.zip` · 完整离线包 | 已构建游戏、可维护源码、Qwen3 0.6B q8 权重、运行库与校验清单 | 解压后即可加载内置模型；游玩不用 npm，也不用在线下载 |
| `aethelgard-v10-source.zip` · 轻量源码/游戏包 | 已构建游戏、源码、文档与工具；不含模型权重和运行库 | 规则玩法立即可用；真实模型需提前准备文件，或首次联网加载 |

取得 ZIP 后先完整解压，进入其中的 `aethelgard-mud` 文件夹。直接取得仓库源码也按轻量包的方式使用。

- **Windows**：双击 `start_Windows.cmd`。
- **macOS / Linux**：在项目目录运行 `sh start_unix.sh`，或：

```bash
python3 tools/serve.py --open
```

下文命令统一写作 `python`，请按系统改用 `python3` 或 Windows 的 `py -3`。默认地址是 **http://127.0.0.1:8765/**；保持启动器终端开启。端口被占用时可使用 `--port 8767`。

**完整离线包的 AI 启动步骤**：打开“智脑”→“浏览器 CPU”→选择 **Qwen3 0.6B**→勾选“使用已下载的离线模型包”→“加载离线模型”。这一模式从解压目录读取文件，无需互联网。等待实际就绪后再提问。

游戏页面、样式和规则已经构建，游玩不要求 Node.js。通过 localhost 打开可以正常加载 Worker、保存进度，并使用本机 Ollama 桥接；请不要通过双击 HTML 的 `file://` 地址加载模型。

### 第一段旅程

1. 在城镇广场打开“此地故事”，处理复苏之井的裂纹。
2. 查看“你的旅程”卡片，按当前目标前进。输入 `journal` 或在输入框外按 `J` 查看日志。
3. 调查地标、准备药品、装备战利品，然后进入荒野。
4. 战斗先看敌人意图：重击时防御，蓄力或吟唱时考虑打断，破绽时进攻。喝药也占用一个回合。
5. 返回安全据点休息；锻造、精炼和交易需要合适的地点与资源。

常用指令：

```text
n / s / e / w / u / d
look · harvest · rest · attack · skill 1 · guard · interrupt · flee
recover · journal · encounter · choose 1 · ai 酒馆在哪里？ · save · load
```

## 本地 AI DM

### 浏览器 CPU 模式

打开“智脑”→“浏览器 CPU”→选择模型→“下载并加载模型”。完整离线包按上面的步骤启用本地文件模式；轻量包若未提前准备文件，保持该选项关闭，首次联网下载权重、分词器和推理运行库。等待实际加载完成后再提问。浏览器缓存能否在断网后复用，取决于缓存是否完整且仍被浏览器保留。

模型清单、精确 revision、量化方式、所需文件与许可集中在 [models/registry.json](models/registry.json)。当前配置为：

| 清单 key | 模型与量化 | 当前定位 |
| --- | --- | --- |
| `qwen-0.6b` | **Qwen3 0.6B · q8** | 默认中文模型，也提供英文；已知质量限制见上文 |
| `qwen-0.5b` | Qwen2.5 0.5B Instruct · q4 | 实验备选，不作为推荐配置 |
| `smol-135m` | SmolLM2 135M Instruct · q4 | 实验英文轻量模型，不作为推荐配置 |

默认模型的预计下载量在注册表中标为约 635 MB，运行库另计；以实际文件为准。下载大小不等于峰值内存占用，响应速度也随设备变化。当前交付使用 Qwen3 q8；不要仅替换文件名或量化参数来混用两套权重。

### 准备可复制的离线模型包

轻量包或源码用户在仍有网络时运行：

```bash
python tools/prepare_offline.py --model qwen-0.6b
```

脚本下载固定 revision 的权重与固定版本运行库，写入 `models/`、`vendor/` 和校验记录；不需要 npm。完整离线包已经包含这些文件，无需重复运行下载命令。完成后启动游戏，在浏览器 CPU 设置中勾选“使用已下载的离线模型包”，选择同一模型，再加载。不传 `--model` 时只准备默认型号；需要多个型号时，在同一次命令中重复 `--model KEY`。清单只记录本次选定的型号，加入型号时应同时列出希望保留在清单中的型号。

准备完成或复制到另一台电脑后，可以不联网检查整个离线包：

```bash
python tools/prepare_offline.py --verify-only
```

该命令不联网、不改文件，校验清单中所有模型与运行库的实际 SHA-256 和固定版本；不只检查默认型号。重复准备时会复用能够通过固定摘要或下载回执核对的现有文件；已安装的正确版本 npm 运行库也会自动尝试复用。详细条件见 [本地 AI 文档](docs/ai-dm.md#方式-b提前下载完整文件包)。

模型权重按需下载，不作为普通 Git 文件提交。要复制到另一台电脑，可使用下文的打包工具生成完整离线 ZIP，再完整解压。单独复制 HTML 不包含推理模型。详细步骤及断网验收见 [本地 AI 文档](docs/ai-dm.md#离线运行的两种方式)。

### Ollama

安装并运行本机 Ollama。下面的安装示例与源码中的默认型号一致，**不是模型质量推荐；本次没有完成真实 Ollama 推理验收**：

```bash
ollama pull qwen2.5:0.5b
```

通过本地启动器打开游戏，在智脑中选择 Ollama，保留 `/ollama` 服务地址，点击“连接并检测模型”，再选择实际安装的本地型号，也可以选择其他已安装型号。本地桥接只把模型列表与聊天请求发往 `127.0.0.1:11434`，不提供模型删除、拉取或任意代理接口；模型标识中的 cloud/URL 形式会被拒绝。

当前 Ollama 请求没有设置思考开关，输出预算也较短；Qwen3 等思考模型可能在产生最终答案前耗尽预算，相关兼容性尚未实测。因此，这里的 Ollama 示例保留源码默认值；浏览器默认的 Qwen3 ONNX q8 及其验收结果不等于 Ollama 配置的验收结果。接口差异与测试范围见 [Ollama 说明](docs/ai-dm.md#ollama保持模型服务在本机)。

### 如何辨认回复来源

每条对话显示来源、实际模型、耗时和可用的 token 指标。未加载、网络错误、取消和流未完成都会显示对应状态。规则助手不计作模型推理；默认不在模型失败时偷偷切回模板。只有勾选“允许明确标记的规则回复”才会回退，并保留失败原因。

AI 可以解释局势、扮演 NPC、补充奇遇气氛。**金币、装备、技能消耗、检定、任务与胜负由游戏规则结算**，模型生成的文字不会自行发奖。

## 游戏内容

| 系统 | 当前内容 |
| --- | --- |
| 世界与探索 | 32 个原创地点、5 个区域、地标线索与可扩展的程序生成边境 |
| 旅程与抉择 | 23 个原创事件、69 个选项、5 个阵营信任、三枚封印、3 种结局 |
| 战斗 | 手动回合、敌人预兆、具有不同阶段的首领、技能冷却、防御、打断、撤退与可选自动狩猎 |
| 成长与装备 | 三职业、天赋、伙伴、随机词缀装备、套装效果、受资源与地点约束的锻造和精炼 |
| 失败与恢复 | 有限金币损失、可回收钱袋；不因战败直接删除角色等级或装备 |
| 存档 | 本机自动保存、JSON 导出/导入、v9 迁移、新人物的上一位英雄备份、损坏存档保护 |

新增故事、AI 控制和联机面板完整提供简体中文与英文；旧版其他语言入口仍保留，新增内容以英文回退。玩法细节见 [旅程设计](docs/gameplay-design.md) 和 [战斗与经济审计](docs/combat-audit.md)。

## 联机的实际范围

- **地址留空**：BroadcastChannel 连接同一浏览器的同源标签页，只提供真实标签页在线名单与房间聊天。
- **填写已部署的 v10 Worker WebSocket 地址**：真实在线列表、房间聊天、2–4 人协作副本、1v1 和 3v3 队伍竞技。副本和竞技场由服务器计算回合与结果，加入或排队不发奖励。

仓库提供 Cloudflare Workers / Durable Objects 服务器代码，**本次改动没有部署公共多人服务器**。跨设备联机需要自行部署并实测端点。离线存档可编辑，当前定位是朋友协作与友谊竞技；没有账户排位或完整反作弊承诺。[部署与玩法说明](docs/online.md)

## 开发、构建与测试

源代码按 `core → gameplay → combat → ai-dm → online → bootstrap` 组合。修改模块后重新生成页面；不要直接维护两个生成的 HTML 副本。

```bash
npm ci
npm run build
python tests/verify_mud.py --report test-results/verification.json
```

验证脚本默认检查生成文件是否一致、实际游戏规则/AI 调度/存档/联机协议，以及 localhost 启动器边界；开发与测试需要 Node.js 22.8+（CI 使用 22）与 Python，不需要下载模型。测试运行器使用 `--test-isolation=none`，避免本运行环境中子进程隔离导致用例计数缺失。AI 单元测试中的网络与模型响应是明确标记的 Mock。

已有样式未变时也可直接运行 `python src/build_mud_game.py` 重建页面。浏览器与真实模型验证使用独立入口：

```bash
npx playwright install chromium
node tests/browser.mjs --report test-results/browser.json
python tools/prepare_offline.py --model qwen-0.6b
node tests/browser.mjs --model --report test-results/browser-model.json
npm run test:model -- --model=qwen-0.6b --local
```

`browser.mjs --model` 在新浏览器环境中阻断全部外网请求、保留 localhost 文件服务，从已准备的离线包实际加载 WASM 模型并生成路线回复；这不等于验收 Service Worker/浏览器缓存的断网重载。普通浏览器测试包含故事选择的保存和页面重载，不加载模型。Native ONNX CPU 命令使用实际游戏提示与事实；`--local` 从准备好的模型目录读取文件。两种真实推理的运行数据保存在 `test-results/`，必须分别解读；事实断言通过后仍需要人工阅读输出，避免漏掉额外的虚构效果。准备默认模型会下载数百 MB 文件。

`npm run build` 同时构建 CSS、两个 HTML 与 Service Worker；`python src/build_mud_game.py --check` 检查生成页面是否与源码一致。仓库包含验证与 GitHub Pages 工作流；静态站点仅发布游戏壳和注册表，不把本机已下载的大模型作为 Git 文件上传。本地测试与打包不等于已推送、已通过远端 CI 或已发布。

### 制作可解压运行的交付包

在源码目录先构建，再生成轻量包：

```bash
python src/build_mud_game.py
python tools/package_release.py
```

加入默认模型的完整离线包：

```bash
python tools/prepare_offline.py --model qwen-0.6b
python tools/prepare_offline.py --verify-only
python tools/package_release.py --model qwen-0.6b
```

输出默认放在 `dist-release/`，文件名对应上面的两种包；可用 `--output 路径.zip` 指定位置。打包工具检查生成页面是否与源码一致，并在带模型时严格校验源离线清单。它只加入所选型号当前 revision/dtype 必需的文件和三份运行库文件，裁剪离线清单，避免把实验 q4/q8 权重一起装入；模型与 WASM 直接存储，文本压缩。

两种包都带源码、测试、服务器代码和文档；不带 `node_modules`、开发缓存、Git 历史或本机存档。模型包包含现有第三方许可原文。打包过程只写本地 ZIP，不下载、不推送、不部署。更多细节见 [离线交付打包](docs/ai-dm.md#制作轻量包与完整离线包)。

## 文档索引

- [AI DM、离线包、运行证据与模型验收](docs/ai-dm.md)
- [探索、抉择、三种结局与实际通关](docs/gameplay-design.md)
- [战斗、装备、经济审计](docs/combat-audit.md)
- [联机协议、部署和服务器边界](docs/online.md)
- [当前架构索引与旧设计说明](docs/mud_design_plan.md)
- [实际验证记录与已知限制](docs/verification.md)
- [第三方组件、模型与许可原文](docs/third-party-notices.md)

## English quickstart

Install **Python 3.10+** on Windows, macOS or Linux. Extract the ZIP and enter its `aethelgard-mud` folder. Double-click `start_Windows.cmd` on Windows; on macOS/Linux run `sh start_unix.sh` or `python3 tools/serve.py --open`. Keep the terminal open and use http://127.0.0.1:8765/, not `file://`. Start with **Journey → Story here**.

The **full offline ZIP** includes Qwen3 0.6B q8 and its runtime; playing requires neither npm nor internet downloads. Open **AI DM → Browser CPU**, select Qwen3 0.6B, enable **Use downloaded offline package**, and load it. The **source/game ZIP** contains no weights or runtime: play with the labeled rules assistant, load the model online, or first run `python tools/prepare_offline.py --model qwen-0.6b`. Verify prepared files offline with `python tools/prepare_offline.py --verify-only`. Ollama is an optional localhost backend through `/ollama`; its installation example remains `qwen2.5:0.5b`, matching the code default, not a quality recommendation. Real Ollama inference was not tested in this delivery.

The current source has fresh rule regressions and real Qwen3 CPU/WASM generation evidence. Model facts and NPC narration still have known failures; successful inference is not a blanket quality approval. The rules engine owns world facts, actions and rewards. Qwen2.5 and SmolLM2 remain experimental alternatives. See [verification](docs/verification.md) for actual results and limitations.

Build a lightweight ZIP with `python tools/package_release.py`, or a verified full ZIP with `python tools/package_release.py --model qwen-0.6b` after preparing the model. Run `python tests/verify_mud.py` for deterministic checks. After installing development dependencies and Chromium, `node tests/browser.mjs --model` performs a fresh browser load and real generation from local files with external requests blocked; it does not test browser-cache offline reload. These are local commands, not a claim of successful remote CI or publication. Internet multiplayer requires your own deployed v10 Worker; an empty endpoint only enables same-browser tab chat.
