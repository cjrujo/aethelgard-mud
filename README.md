# Aethelgard · Living Chronicles（v11.0.0）

艾瑟尔加德是一款浏览器文字角色扮演游戏：在五个区域中探索、与人物建立关系、应对有预兆的敌人，并通过持续生效的选择决定裂隙的结局。

**v11 把故事、战斗和成长串成可以持续推进的旅程**：默认路线包含各章关键事件，自动狩猎有明确终点，碎片可兑换套装并培养伙伴，高阶采集需要区域准备。存档增加单标签写入、恢复快照和保存后更新；在线战斗使用协议 **11**，前端与 Cloudflare Worker 需要一起升级。

**智脑运行真实的本地模型，默认是 Qwen3 0.6B q8。** 浏览器通过独立 Web Worker 加载实际 ONNX 权重，在 CPU/WASM 上生成文字；也可连接本机 Ollama，无需云端 API Key。未加载模型时可以选择有明确来源标记的规则助手。v11 增加共享战斗事实、长期人物与承诺记录、取消后的“重新加载并继续”和本机回答反馈。[AI 实现与使用说明](docs/ai-dm.md)

**小模型仍可能说错。** 真实 Qwen3 0.6B 测试仍出现 NPC 关系原因幻觉等问题；有推理输出、逻辑回归通过和叙事准确是不同的验收。界面保留规则事实和模型原文，实际行动、金币、装备、任务与胜负由游戏规则结算。具体输出、测试范围和已知限制见 [AI 内容验收](docs/ai-dm.md#当前模型的实测范围与限制) 与 [验证记录](docs/verification.md)。

> **从 v9/v10 升级？** 先在原游戏地址导出 JSON 存档，再按 [v11 升级与发布指南](docs/v11-upgrade.md) 更新。更换本地端口会切换浏览器存档空间；更新静态网页不会自动更新 Cloudflare 服务端。本页的命令与工作流说明不代表你的线上服务已部署或远端 CI 已通过。

## 立即开始

Windows、macOS 与 Linux 均需要 **Python 3.10 或更新版本**和现代浏览器。日常游玩不需要 npm。本仓库提供两种本地交付形式：

| 包 | 包含什么 | 使用本地模型的准备 |
| --- | --- | --- |
| `aethelgard-v11.0.0-qwen-0.6b-offline.zip` · 完整离线包 | 已构建游戏、可维护源码、**实际 Qwen3 0.6B q8 权重**、运行库与校验清单 | 解压后可加载内置模型，游玩无需在线下载 |
| `aethelgard-v11.0.0-source.zip` · 轻量源码/游戏包 | 已构建游戏、源码、文档与工具；不含模型权重和运行库 | 规则玩法立即可用；真实模型需提前准备文件，或首次联网加载 |

### 从 GitHub 下载

打开仓库的 [Verify game and local AI 工作流](https://github.com/cjrujo/aethelgard-mud/actions/workflows/verify.yml)，选择与你要使用的提交对应的运行，在 **Artifacts** 中下载：

- **`aethelgard-source-game`**：内含 `aethelgard-v11.0.0-source.zip`，由游戏与工具验证任务生成。
- **`aethelgard-qwen-offline`**：内含 `aethelgard-v11.0.0-qwen-0.6b-offline.zip`，由实际浏览器模型任务在准备权重、完成验证后生成。

相应任务成功上传后才会出现 artifact。GitHub 的下载外层也可能是 ZIP，先解压到上述交付包，再完整解压交付包。**Code → Download ZIP 取得的是仓库源码，不包含模型权重**。若对应运行还未生成交付包，可按下文命令自行准备和打包；不要把某次旧运行的成功当作当前提交的验证结果。

取得 ZIP 后先完整解压，进入其中的 `aethelgard-mud` 文件夹。直接取得仓库源码也按轻量包的方式使用。

- **Windows**：双击 `start_Windows.cmd`。
- **macOS / Linux**：在项目目录运行 `sh start_unix.sh`，或：

```bash
python3 tools/serve.py --open
```

下文命令统一写作 `python`，请按系统改用 `python3` 或 Windows 的 `py -3`。启动器首次尝试 **http://127.0.0.1:8765/**；端口被占用或系统不允许绑定时，会在 **18865–18874** 中寻找可用端口并记住选择。以后优先使用记住的端口。以终端实际打印的地址为准，并保持终端开启；`--port 8767` 可要求使用一个指定端口，指定端口失败时不会自动改用其他端口。

**换端口前先导出 JSON，再在新地址导入。** 浏览器按协议、主机名和端口分别保存进度，`localhost` 与 `127.0.0.1` 也不同；新地址出现新英雄不表示旧进度被删除。详见 [本地更新与存档迁移](docs/v11-upgrade.md#3-更新本地游戏并保留进度)。

**完整离线包的 AI 启动步骤**：打开“智脑”→“浏览器 CPU”→选择 **Qwen3 0.6B**→勾选“使用已下载的离线模型包”→“加载离线模型”。这一模式从解压目录读取文件，无需互联网。等待实际就绪后再提问。

游戏页面、样式和规则已经构建，游玩不要求 Node.js。通过 localhost 打开可以正常加载 Worker、保存进度，并使用本机 Ollama 桥接；请不要通过双击 HTML 的 `file://` 地址加载模型。

### 第一段旅程

1. 在城镇广场打开“此地故事”，处理复苏之井的裂纹。
2. 跟随“你的旅程”中的“目标下一步”，认识每章人物、调查线索，再挑战首领。可以“暂缓此线索”，以后从“日志与抉择”回访；暂缓不会替你选择或发奖。
3. 调查地标、准备药品、装备战利品。高阶节点会显示所需主线进度或公会训练，地图仍可自由探索。
4. 战斗先看敌人意图：重击时防御，蓄力或吟唱时考虑打断。打断蓄力会让存活敌人下一回合露出破绽；打断施法只取消当前法术。喝药也占用一个回合。
5. 想自动战斗时打开“狩猎目标”。默认完成一场胜利即停；也可选择当前击杀契约，或主动设定连续狩猎的场数与生命下限。本轮成果和停止原因可在这里查看。
6. 返回安全据点休息，在“公会与伙伴”查看声望等级、套装兑换、伙伴培养和采集训练。实际办理服务需要到公会大厅，并结束当前战斗。

常用指令：

```text
n / s / e / w / u / d
look · harvest · rest · attack · skill 1 · guard · interrupt · flee
recover · journal · encounter · choose 1 · guild · hunt · skip
ai 酒馆在哪里？ · save · load
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

### 记忆、继续与纠错

“记住的人物与承诺”保存玩家明确声明的少量事实，例如“我的姐姐叫米拉”“我承诺寻找信使”。这些记录独立于短期聊天窗口、按 NPC 会话隔离；人物关系和已结算故事另从实际游戏状态读取。承诺只代表玩家声明，不会自动完成任务。当前提取支持有限的明确句式，不是任意对话都能形成长期记忆。

取消生成或尚未加载模型时，界面保留问题并提供“重新加载并继续”。继续前核对人物、地点和事件；场景已变时把问题放回输入框。重开游戏后需要重新加载模型，不会把旧的“已加载”状态当作实际驻留的模型。

完整回复下可标记“事实有误”“角色不一致”“场景不符”，并在“回答反馈”导出带当时上下文的 JSON。这些记录只留在本机，不自动上传，也不会自动改写模型回复。详见 [游戏事实与人物记忆](docs/ai-dm.md#游戏事实与人物记忆)。

## 游戏内容

| 系统 | 当前内容 |
| --- | --- |
| 世界与探索 | 32 个原创地点、5 个区域、地标线索与可扩展的程序生成边境 |
| 旅程与抉择 | 23 个原创事件、69 个选项、5 个阵营信任、三枚封印、3 种结局；关键故事进入默认路线，可暂缓、回访并查看结局条件 |
| 战斗与狩猎 | 手动回合、敌人预兆、多阶段首领、技能冷却、防御、打断与撤退；单场、契约或显式连续狩猎，保留低血低体力安全暂停 |
| 成长与装备 | 三职业、天赋、真实伙伴培养、随机词缀装备、三套装定向兑换、区域采集准备、锻造和精炼 |
| 公会与经济 | 普通声望对应五级公会权益与最高 20% 商店折扣；碎片可用于套装和伙伴；支付前核对地点、战斗状态与完整价格 |
| 失败与恢复 | 有限金币损失、可回收钱袋；不因战败直接删除角色等级或装备 |
| 存档与更新 | 本机自动保存、JSON 导出/导入、v9/v10 迁移、单标签写入与接管、恢复快照、保存成功后更新游戏 |

新增故事、AI 控制和联机面板完整提供简体中文与英文；旧版其他语言入口仍保留，新增内容以英文回退。玩法细节见 [旅程设计](docs/gameplay-design.md) 和 [战斗与经济审计](docs/combat-audit.md)。

## 保存、切换标签与更新

同一来源下的英雄同时只有一个标签页可以写入。第二个标签页可查看提示并“接管并载入最新进度”；接管会载入已保存的进度，原页面暂停后台游玩。浏览器支持时使用 Web Locks，其他环境使用带冲突检测的保存租约。

“存档 / JSON”提供当前英雄下载、上一位英雄与恢复快照的查看、下载和恢复。新旅程、导入和恢复会先写入并核对备份；备份失败时保留当前英雄，导入保存失败时恢复原英雄。存储空间不足或发生跨页冲突时，先导出本页 JSON，再处理提示。

v11 页面发现新构建时显示“保存并更新”，保存成功后才切换 Service Worker 并刷新；在线战斗中先结束对局。更新提示与联机的“连接与版本诊断”读取生成的构建信息，便于查明前端、服务端是否来自同一版本。首次从 v10 更新及缓存排查见 [升级指南](docs/v11-upgrade.md)。

## 联机的实际范围

- **地址留空**：BroadcastChannel 连接同一浏览器的同源标签页，只提供真实标签页在线名单与房间聊天。
- **填写已部署的 v11 Worker WebSocket 地址**：真实在线列表、房间聊天、2–4 人协作副本、1v1 和 3v3 队伍竞技。副本和竞技场由服务器计算回合与结果，加入或排队不发奖励。

v11 在加入、排队请求发出前锁定单人活动并暂停自动行走/狩猎；断线会结束当前在线战斗。服务器已结算但尚未确认的奖励有持久收据，同一英雄重连同一服务器、同一 `realm` 后可恢复领取。进行中的战斗本身不会断线续打。

**前端和 Cloudflare Worker 必须同步使用协议 11。** 更新时使用 `entry.js` 入口，并一并部署 `worker.js`、`receipts.js`、生成的 `build-info.js`。保留现有 `wrangler.toml` 中的 Worker 名称、Durable Object 绑定与迁移历史，将 `main` 更新为 `entry.js`。静态站点发布不替你部署 Worker。完整命令、健康检查和存档恢复身份说明见 [联机部署与玩法](docs/online.md)。

仓库提供 Cloudflare Workers / Durable Objects 服务器代码，跨设备联机需要部署并实测自己的端点。离线存档可编辑，当前定位是朋友协作与友谊竞技，没有账户排位或完整反作弊承诺。本发布说明不宣称你的生产端点已更新。

## 开发、构建与测试

源代码按 `core → gameplay → combat → ai-dm → online → bootstrap` 组合。修改模块后重新生成页面；不要直接维护两个生成的 HTML 副本。

```bash
npm ci
npm run build
python tests/verify_mud.py --report test-results/verification.json
```

验证脚本默认检查生成文件是否一致、实际游戏规则/AI 调度/存档/联机协议，以及 localhost 启动器边界；开发与测试需要 Node.js 22.8+（CI 使用 22）与 Python，不需要下载模型。测试运行器使用 `--experimental-test-isolation=none`，避免本运行环境中子进程隔离导致用例计数缺失。AI 单元测试中的网络与模型响应是明确标记的 Mock。

已有样式未变时也可直接运行 `python src/build_mud_game.py` 重建页面。浏览器与真实模型验证使用独立入口：

```bash
npx playwright install chromium
node tests/browser.mjs --report test-results/browser.json
node tests/browser-update.mjs
python tools/prepare_offline.py --model qwen-0.6b
node tests/browser.mjs --model --report test-results/browser-model.json
npm run test:model -- --model=qwen-0.6b --local
```

`browser.mjs --model` 在新浏览器环境中阻断全部外网请求、保留 localhost 文件服务，从已准备的离线包实际加载 WASM 模型并生成路线回复。普通浏览器测试包含故事选择保存、实际双标签页接管、手机宽度的公会/狩猎表单与诊断面板。独立的 `browser-update.mjs` 使用真实 Service Worker，验证安装、带查询参数的离线导航，以及已下载新版本在断网时保存并更新；它不验证模型缓存。Native ONNX CPU 命令使用实际游戏提示与事实；`--local` 从准备好的模型目录读取文件。两种真实推理的运行数据保存在 `test-results/`，必须分别解读；事实断言通过后仍需要人工阅读输出，避免漏掉额外的虚构效果。准备默认模型会下载数百 MB 文件。

`npm run build` 构建 CSS、两个 HTML、Service Worker、`build-info.json` 和 Worker 的 `build-info.js`；`python src/build_mud_game.py --check` 检查生成文件与源码是否一致。前后端构建 ID 由同一次构建产生。

GitHub Pages 自动发布等待 `main` 的 **Verify game and local AI** 成功，再对该提交构建和验证；手动触发也会先构建并验证。仓库未启用 Pages，或发布来源不是 GitHub Actions 时，部署任务跳过并在运行摘要说明原因，**不会自动更改仓库设置**。验证与下载包位于 Verify 工作流，与是否启用 Pages 分开。静态站点发布游戏壳和模型注册表，不把大模型权重作为 Git 文件上传，也不部署 Cloudflare Worker。本地验证、远端 CI、静态站点发布与公网联机验收应分别确认。

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

- [v11 升级、下载包、存档迁移与前后端发布](docs/v11-upgrade.md)
- [AI DM、离线包、运行证据与模型验收](docs/ai-dm.md)
- [探索、抉择、三种结局与实际通关](docs/gameplay-design.md)
- [战斗、装备、经济审计](docs/combat-audit.md)
- [联机协议、部署和服务器边界](docs/online.md)
- [当前架构索引与旧设计说明](docs/mud_design_plan.md)
- [实际验证记录与已知限制](docs/verification.md)
- [第三方组件、模型与许可原文](docs/third-party-notices.md)

## English quickstart

Install **Python 3.10+** on Windows, macOS or Linux. In the [Verify workflow](https://github.com/cjrujo/aethelgard-mud/actions/workflows/verify.yml), choose the intended revision and download `aethelgard-source-game` or `aethelgard-qwen-offline` after its corresponding job succeeds. These contain `aethelgard-v11.0.0-source.zip` and `aethelgard-v11.0.0-qwen-0.6b-offline.zip`, respectively; the repository's ordinary source ZIP does not contain model weights.

Extract the package and enter its `aethelgard-mud` folder. Double-click `start_Windows.cmd` on Windows; on macOS/Linux run `sh start_unix.sh` or `python3 tools/serve.py --open`. Keep the terminal open and use the printed HTTP address. The launcher initially tries port 8765, falls back within 18865–18874 if necessary, and remembers its choice. **Export/import save JSON when changing ports or hosts**: browser saves belong to their original origin. Start with **Journey → Story here**.

The **full offline ZIP** includes Qwen3 0.6B q8 and its runtime; playing requires neither npm nor internet downloads. Open **AI DM → Browser CPU**, select Qwen3 0.6B, enable **Use downloaded offline package**, and load it. The **source/game ZIP** contains no weights or runtime: play with the labeled rules assistant, load the model online, or first run `python tools/prepare_offline.py --model qwen-0.6b`. Verify prepared files offline with `python tools/prepare_offline.py --verify-only`. Ollama is an optional localhost backend through `/ollama`; its installation example remains `qwen2.5:0.5b`, matching the code default, not a quality recommendation. Real Ollama inference was not tested in this delivery.

v11 recommends each chapter's stories, supports deferring and revisiting leads, adds guild set exchange and companion training, and makes auto-hunt stop after one win by default. Contract and explicitly continuous hunts have their own limits and a run summary. Only one tab writes a hero at a time; use takeover to load its latest save. Recovery snapshots are available in Save, and updates require a successful save before refreshing.

Model facts and NPC narration still have known failures, including an invented reason for an NPC relationship. Successful inference is not a blanket quality approval. Explicit names/promises have persistent, scoped memory; interrupted requests offer **Reload and continue**, and local feedback can be exported. The rules engine owns world facts, actions and rewards. Qwen2.5 and SmolLM2 remain experimental alternatives. See [AI quality limits](docs/ai-dm.md#当前模型的实测范围与限制) and [verification](docs/verification.md) for actual results.

Build a lightweight ZIP with `python tools/package_release.py`, or a verified full ZIP with `python tools/package_release.py --model qwen-0.6b` after preparing the model. Run `python tests/verify_mud.py` for deterministic checks. After installing development dependencies and Chromium, `node tests/browser.mjs --model` performs a fresh browser load and real generation from local files with external requests blocked; it does not test browser-cache offline reload. These are local commands, not a claim of successful remote CI or publication.

Internet multiplayer requires **both the v11 frontend and a protocol-11 Worker**. Set Wrangler's `main` to `entry.js`, deploy `entry.js`, `worker.js`, `receipts.js` and generated `build-info.js` together, and preserve your existing Durable Object binding and migrations in `wrangler.toml`. An empty endpoint only enables same-browser tab chat. Pages deployment follows successful verification and skips repositories without the corresponding Pages setup; it neither changes repository settings nor deploys the Worker. See the [upgrade guide](docs/v11-upgrade.md) and [multiplayer deployment](docs/online.md).
