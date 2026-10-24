# v11.0.0 验证记录

本页记录 **2026-10-24** 的 v11 实际验证，应用版本为 **11.0.0**，联机协议为 **11**。规则回归、真实浏览器运行、实际模型推理、模型内容复核和本地 Cloudflare 运行时分别取证，不将其中一项成功当作其他项目已完成。报告保留测试时的时间、源码摘要或构建 ID；历史 v10 报告继续留存，但不计入本页的当前结果。

## 结果与证据

| 验证层次 | 本轮结果 | 报告及范围 |
| --- | --- | --- |
| 生成文件与源码一致性 | **通过** | [verification-v11.json](validation/verification-v11.json)：包含生成文件检查、命令、退出码和源码摘要 |
| JavaScript 规则与集成回归 | **152 / 152 通过** | [最终统一报告](validation/verification-v11.json)：玩法、战斗、狩猎、合法战役、AI 调度与推理 Worker、存档、更新、联机及消息 ID 兼容；模型响应和部分平台依赖使用明确测试替身 |
| Python 工具回归 | **27/27 通过** | [最终统一报告](validation/verification-v11.json)：离线安装/校验、启动器端口与桥接、发布打包；下载上游使用 Mock，不计作真实模型推理 |
| 真实 Chromium 与本地 WASM 模型 | **13 / 13 检查通过** | [browser-v11.json](validation/browser-v11.json)：完整界面、故事存档、狩猎/公会表单、真实 Web Locks、诊断复制回退，以及外网阻断下的 Qwen3 q8 生成与反馈标记重载关联 |
| 中文字体与真实界面复核 | **11/11 检查通过** | [browser-v11-visual.json](validation/browser-v11-visual.json)：1440/980/390 像素宽度，中文界面、公会/狩猎/联机面板；本轮不加载模型 |
| 真实 Service Worker 与离线更新 | **6/6 检查通过** | [browser-update.json](validation/browser-update.json)：首装、带 query 的离线导航、更新等待、显式保存后离线激活、保留英雄进度 |
| 真实 Wrangler/workerd/SQLite 重启 | **7/7 检查通过** | [worker-runtime.json](validation/worker-runtime.json)：协议握手、真实决斗、持久收据、整个运行时重启后恢复、重复确认安全 |
| Native CPU 中文模型内容 | **6 个样本；4 个本例可接受，1 个记忆取回但人称受限，1 个关系原因编造** | [原始生成](validation/ai-v11-native.json)与[助手语义复核](validation/ai-v11-native-review.json)；不能解释为总体准确率，也不能解释为六例全部合格 |
| 合法旅程与战役 | **14/14 用例通过** | [campaign-v11.json](validation/campaign-v11.json)：三职业默认引导各完成 23 个事件、五章与修复世界结局；另有多种子开局和独立结局分支 |

各专项有重叠，不能把表内数字相加得到独立测试总数。例如中文界面复跑与加载模型的浏览器运行共享大部分界面检查，战役用例也包含在 JavaScript 统一回归中。

## 真实浏览器中的本地模型

本轮实际加载的模型是 `onnx-community/Qwen3-0.6B-ONNX`，revision 为 `58ca03a5e7b354b480b1a82b34bde8dc7b854cc0`，量化 **q8**，运行库为 Transformers.js **3.8.1**。浏览器使用独立 Web Worker、单线程 CPU/WASM，从已准备的本地文件读取权重和运行库，没有调用云端聊天服务。[原始记录](validation/browser-v11.json)同时保留来源、实际模型、token 指标、当时的路线事实与原始输出。

在新的 Chromium 上下文中，测试阻断全部外网 HTTP(S) 请求，只允许 localhost 文件服务，并禁用 Service Worker。实际问题是“从复苏之井去酒馆，第一步往哪个方向走？只回答方向。”；实际回复为 **“向南。”**。

| 观测项 | 本次值 |
| --- | ---: |
| 输入 token | 132 |
| 输出 token | 4 |
| 首 token | 7481 ms |
| 完整回复 | 8812 ms |
| 页面错误 | 0 |
| 外网请求 | 0 |
| 失败资源 | 0 |

这是当前设备的一次实际采样，不是其他电脑或手机的性能承诺。它证明完整本地文件包能在外网不可用时执行真实推理，并正确回答这条路线问题；不证明所有 NPC 对话或战术解释都正确，也不证明模型缓存被清理后仍能加载。

## 中文界面、表单与多标签

[中文界面运行](validation/browser-v11-visual.json)使用可显示中文的字体重新执行真实浏览器检查，并检查对应截图。1440、980 和 390 像素宽度下，文档宽度与视口一致。移动宽度下公会、狩猎和联机诊断面板均纳入检查；这些是本次视口的观察，不等于覆盖所有设备尺寸和字体组合。

实际交互还验证了：故事选择保存并重载后仍在；狩猎目标的设置经历世界心跳后保留；公会兑换的装备部位选择不会被心跳重建抹去；联机诊断可显示构建版本，剪贴板不可用时提供可复制文本。

双标签使用真实浏览器 **Web Locks** 验证写入权：接管页载入最新进度，旧标签关闭时不能把旧状态覆盖回去。这项证据独立于存档单元测试中的锁与存储替身。备份失败保留英雄、导入保存失败回滚、非法存档保护等边界由[统一回归](validation/verification-v11.json)记录；真实浏览器检查没有制造每一种磁盘或浏览器存储故障。

## Service Worker：离线壳与保存后更新

[更新测试](validation/browser-update.json)使用实际 Chromium Service Worker、临时游戏文件副本和真实 loopback 文件服务器。测试先等待首个 Service Worker 控制页面，再断网访问带 query 参数的已缓存游戏入口，核对地点与采集物资仍在。

随后，测试在临时副本中生成一个不同构建标识的替换游戏壳，实际下载到 waiting 状态。普通重载继续使用一致的当前游戏壳；再断网点击“保存并更新”，新壳被显式激活，页面只重载一次，英雄地点与物资保持，带 query 的根路径仍可离线访问。页面错误与外网请求为零。

这次验证覆盖的是**游戏壳的离线导航与更新**，替换构建只改变构建标识，用于验证真实更新机制；没有模拟两个任意历史版本之间的全部数据变化，也没有在此运行中加载模型。它与上节的本地模型文件推理测试共同提供两类证据，但不能合并为“所有浏览器模型缓存均可断网重载”。

## Native CPU：原始回答与助手语义复核

[六例 Native CPU 生成](validation/ai-v11-native.json)同样使用实际 Qwen3 0.6B q8 权重，选择中文场景，实际载入约 **3.46 秒**，六条回复生成合计约 **31.32 秒**。这些指标属于 Native ONNX CPU，与浏览器 WASM 的速度分别记录。

[语义复核报告](validation/ai-v11-native-review.json)由助手检查完整原始回复，没有替换答案、修补输出或将规则模板冒充模型回复。结果如下：

| 场景 | 原始结果的核心内容 | 本次判断 |
| --- | --- | --- |
| 混合“刚才”的零体力战术追问 | 推荐防御，说明减伤 65%、恢复 18 体力与 8 法力；没有虚构治疗或反击 | 本例可接受 |
| 施法状态打断 | 说明消耗 18 体力，并指出不保证下一回合出现破绽 | 本例可接受 |
| 离开短历史后的长期记忆 | 取回米拉和寻找信使的承诺，但回答为“我姐姐叫米拉。我承诺寻找信使。” | 事实取回，人称表现受限，不能算成熟的角色扮演 |
| 玛拉欢迎语 | 没有把玩家认作玛拉；采用给定路线传闻，没有发放物品 | 本例可接受；三句略超出偏好的一至两句风格 |
| NPC 关系原因 | 说“戒备”，却将原因写成“因为你对我的信任和忠诚”，未根据实际游侠钱袋事件解释 | **事实依据失败** |
| 酒馆氛围 | 描写炉火、空椅和汤的气味，没有把远处水车声搬到现场，也未结算未选的结果 | 本例可作为有限的气氛补充 |

六例主报告保留其当时自动结果：3 条 `passed`、3 条 `needs-human-review`。这些是自动检查器的历史状态标签，不表示已经通过完整语义复核。关系原因用例暴露了旧判据只检查“信任或选择”词语的漏判，因此当前检查器**收紧**了对真实事件依据的要求，未放松评分来把失败改为成功。

[初始失败](validation/ai-v11-native-initial.json)与[追加提示试验](validation/ai-v11-native-targeted-experiment.json)一并保留。后一试验增加第二人称和具体事件的约束，两个样本反而出现反问和复述指令，已撤回该提示改动。最终保留的六条提示与主生成报告中的提示逐条比较一致；随后消息 ID 兼容修复不改变这些提示、模型权重或生成参数，并另有回归覆盖。报告中的旧源码摘要仍代表测试当时的字节，不能改写成所有最终源码均与早期报告完全相同。

上述六个中文样本不能估算所有问题的总体准确率。长期事实能够取回，也不保证人物关系的原因、人称和语气可靠。游戏会保留模型原文、提问时事实与来源，允许本机纠错反馈；实际动作、金币、物品、任务与结局仍由规则引擎结算。AI 提供的信息和记忆机制见 [AI DM 文档](ai-dm.md#游戏事实与人物记忆)。

## 合法旅程与成长覆盖

[战役报告](validation/campaign-v11.json)使用真实生产规则，实际走地图、选择故事、采集、分配获得的属性与天赋、装备持有的物品，并走到安全据点休息。默认引导通过真实“目标下一步”以及战斗建议入口推进，没有注入等级、金币、装备、首领胜利或故事完成旗标。

| 默认路线职业 | 事件数 | 主线章节 | 结束等级 | 结局 | 加里克／马拉科尔／伊格尼斯／建筑师回合 |
| --- | ---: | ---: | ---: | --- | --- |
| 先锋 | 23 | 5 | 9 | 修复世界 | 7／6／9／11 |
| 奥术师 | 23 | 5 | 9 | 修复世界 | 7／5／6／9 |
| 刺客 | 23 | 5 | 9 | 修复世界 | 7／5／7／9 |

另外保留三职业、三个固定种子的开局路线，以及先锋的完整作者路线、独立维伦支线和三种结局分支。结局分支从同一合法状态恢复，不将上一条结局的奖励带入另一条。

专项回归还检查剧情暂缓与回访、旧已完成主线存档、高阶采集门槛、原子付款与奖励、伙伴等级、公会折扣、施法/蓄力打断的差异，以及有限狩猎与低血低体力暂停。失败边界有明确数值夹具，不把它们冒充从新档获得的自然进度。

这些战役测试的 DOM、存储和时钟由测试宿主提供，证明规则流程可达。它们没有穷举 69 个选择的组合、所有三职业结局与配装，也没有完成大规模长线经济仿真或玩家留存研究。玩法取舍详见 [gameplay-design.md](gameplay-design.md) 与 [combat-audit.md](combat-audit.md)。

## 真实 Cloudflare 本地运行时与持久奖励

[运行时报告](validation/worker-runtime.json)通过 **Wrangler 4.152.0** 启动实际本地 **workerd**，运行真实 Worker 入口、WebSocket 和 Durable Object SQLite，使用合成测试英雄。测试完成协议 11 的健康检查、版本握手与旧协议提示，以及一场 **15 回合决斗**。胜利奖励在确认前写入 SQLite。

测试随后停止整个运行时进程组，保留同一 SQLite 目录，再重新启动。在新会话中收到的是同一份未确认收据与奖励；重复 ACK 安全，确认后再次连接不再出现待领奖励。七项检查全部通过。它证明奖励收据跨真实进程重启持久化，不只是在内存测试替身中“重连”。

这次运行只使用 localhost，没有登录 Cloudflare、部署生产服务或连接用户的公网领域。正在进行的战斗仍不支持断线续打；本次恢复的是服务器已经结算的奖励。离线英雄可编辑，当前没有账户排位或完整反作弊保证。生产环境仍需用两台设备实测握手、聊天、完整战斗和断线奖励恢复；3v3 需要六位已连接英雄。[联机边界与部署步骤](online.md)

## 环境、覆盖限制与报告归属

本轮运行环境为 **Linux x64、Node.js 24.22.1、Python 3.12.14、Chromium**。开发入口要求 Node.js 22.8+ 和 Python 3.10+，CI 配置使用 Node.js 22；实际远端执行结果以对应提交的 Actions 为准。桌面和手机宽度是在本次 Chromium 环境中模拟，不代表实体手机验收。

真实 Ollama 推理未在本轮验收；本机桥接的路径、来源、大小、流式传输等测试使用 Mock 上游。Qwen3 ONNX 的结果不能替代 Ollama，也不能套用到注册表中的 Qwen2.5、SmolLM2 或其他量化。Windows/macOS 的完整安装、启动和推理未在对应操作系统重做。

各真实报告保留当时的构建标识，最终统一规则报告保留最终源码摘要。后续消息 ID 兼容修复通过独立回归补充；六条 Native 提示再次逐条比对一致。构建标识不同不能被描述为同一份完整源码，但也不能把仅标识兼容的修改说成重新完成了一轮模型内容验收。

本地报告不表示已合并、已通过远端 CI、已发布 GitHub Pages 或已更新 Cloudflare 生产 Worker。前后端更新与存档迁移应按 [v11 升级指南](v11-upgrade.md)执行，并在真实部署后核对协议与构建 ID。

## 重现命令

先安装开发依赖并构建，执行规则与工具回归：

```sh
npm ci
npm run build
python tests/verify_mud.py --report test-results/verification-v11.json
```

真实浏览器界面与 Service Worker 更新：

```sh
npx playwright install chromium
node tests/browser.mjs --report test-results/browser-v11-visual.json
node tests/browser-update.mjs
```

中文截图复核需要运行环境实际安装可显示中文的字体。浏览器脚本也接受 `BROWSER_EXECUTABLE` 指定已安装的 Chromium；测试报告应保留实际环境，不把不同运行的时间或截图混用。

准备并校验完整模型文件，再执行真实 WASM 与本次六个中文 Native 场景：

```sh
python tools/prepare_offline.py --model qwen-0.6b
python tools/prepare_offline.py --verify-only
node tests/browser.mjs --model --report test-results/browser-v11.json
node tests/real-model.mjs --model=qwen-0.6b --local --lang=zh --case=mixed-guard,cast-interrupt,long-memory,npc,npc-relationship,tavern
```

Native 入口自动在 `test-results/` 保存带时间的原始报告和最近一次结果；`--prompts-only` 可以仅导出提示，不能算真实推理。质量检查失败可能返回非零退出码，应保留失败和原始回答，再做语义复核，不能用忽略退出码或替换输出的方式标成通过。

真实 Worker 重启测试要求预先安装固定的 Wrangler 4.152.0，并提供其 CLI 文件的绝对路径：

```sh
WRANGLER_CLI=/absolute/path/node_modules/wrangler/wrangler-dist/cli.js node tests/worker-runtime.mjs
```

该入口不下载工具、不登录或部署，使用临时本地 SQLite 目录，输出 `test-results/worker-runtime.json`。自动停止进程组依赖 POSIX，本轮只在 Linux 运行；Windows 可按 [联机测试说明](online.md#本地验证)使用拆分入口，但没有本次 Windows 实测声明。

## 历史记录

2026-10-23 的 v10 恢复过程见 [recovery.md](recovery.md)。[旧规则与工具报告](validation/game-and-tools-recovery.json)、[旧浏览器报告](validation/browser-recovery.json)、[旧事实测试](validation/recovered-ai-facts-native.json)、[旧叙事样本](validation/recovered-ai-story-native.json)和[旧战役报告](validation/campaign-recovery.json)保持原文件，供追溯版本变化。它们的数字、提示和输出不作为 v11 当前源码的通过证明。
