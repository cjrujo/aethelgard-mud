# v10 当前验证记录

本页记录 **2026-10-23 恢复版**源码的实际运行结果。历史工作目录和旧 ZIP 未能找回，本轮按保留副本恢复、补齐缺失文件并重新验证；不沿用旧版测试数量或旧包摘要。恢复经过见 [recovery.md](recovery.md)。

## 结果与证据

| 验证 | 本轮结果 | 可复核证据与边界 |
| --- | --- | --- |
| 生成文件一致性 | 通过 | `npm run build` 后，`python src/build_mud_game.py --check` 通过 |
| JavaScript 回归 | **77/77 通过** | [完整命令与原始输出](validation/game-and-tools-recovery.json)：AI 客户端 18、推理 Worker 5、战役 11、战斗 14、玩法/存档 17、联机 12 |
| Python 工具回归 | **24/24 通过** | 同一报告：离线安装/校验 10、本地启动器 7、发布打包 7；工具测试使用临时小文件和明确 Mock 的上游 |
| 真实 Chromium 浏览器 | **8/8 检查通过** | [浏览器报告](validation/browser-recovery.json)：六模块启动，1440/980/390 像素宽度，故事选择保存重载，离线设置，真实 WASM 生成，无页面错误和外网请求 |
| 真实本地模型事实测试 | **7/8 通过，进程退出 1** | [原始结果](validation/recovered-ai-facts-native.json)：中文 4/4，英文 3/4；真实 Native ONNX CPU，不是浏览器 WASM 质量测试 |
| 真实模型叙事样本 | **3 条保留原文；2 条语义未合格** | [样本和独立人工语义审阅](validation/recovered-ai-story-native.json)：NPC 身份倒置、酒馆场景添加了无依据的声音关系；井边一条可作气氛补充 |
| 完整默认离线文件 | **8 个文件校验通过** | `python tools/prepare_offline.py --verify-only`：5 个模型文件、3 个固定运行库文件；模型 revision、大小和 SHA256 均受校验 |

这些是不同层次的证据，不能合并成“AI 质量全部通过”。协议测试的模型返回值为明确 Mock；它们验证错误、取消、状态、上下文及回退行为。真实模型结果另行记录，保留失败和原文。

## 浏览器中实际运行的模型

默认模型为 `onnx-community/Qwen3-0.6B-ONNX`，revision `58ca03a5e7b354b480b1a82b34bde8dc7b854cc0`，q8。模型在独立 Worker 内通过 Transformers.js 3.8.1、单线程 CPU/WASM 运行，没有调用云端聊天服务。

本轮用新的 Chromium 上下文，从完整离线文件目录加载模型。测试拦截全部外网 HTTP(S) 请求，允许 localhost 文件服务，并禁用 Service Worker。问题为“从复苏之井去酒馆，第一步往哪个方向走？只回答方向。”，实际原文为 **“向南移动。”**。报告记录输入 119 token、输出 5 token、首 token 约 4.25 秒、整次生成约 4.97 秒；这些是本次环境的一次采样，不是其他设备的速度承诺。外网请求、页面错误和资源失败均为零。

这证明完整文件包在外网不可用时能够完成真实加载与生成。它**没有**验证浏览器缓存被清理后的恢复、Service Worker 缓存断网重载，或关闭 localhost 服务后生成。完整包仍需要启动本地文件服务器。

权重文件 `onnx/model_quantized.onnx` 为 617,687,575 字节，其 SHA256 为：

```text
ccf8734e59fdf7475b2dc0c117005e267a3a08342c1d951e0a79f0bce57bf62a
```

## 已知模型质量问题

英文零体力防御建议声称防御会增加生命值，违反真实规则；正确效果是恢复体力和法力、降低受到的伤害，不能治疗 HP。该用例保持失败，没有通过替换原文或模板伪装修正。

三条中文叙事样本中，NPC 样本把旅人称作玛拉，倒置了扮演身份；酒馆样本把信中水车的声音写成能从酒馆听到，添加了未给出的场景关系。两条均未被判为合格。详细原文、提示和 token 数据可在上表的 JSON 中查看。

因此 UI 显示实际模型来源、原文和当时的游戏事实；模型描述不能移动角色、完成任务、选择事件结果或发放奖励。故事主文与规则引擎负责事实和结算。模型补充描写仍应按有缺陷的小模型能力理解。

Native 事实测试先于随后进度条显示及存档容错修正，报告保留当时源文件摘要；后续修正没有改变事实提示、权重或生成参数。真实浏览器验收覆盖了进度条修正。当前完整规则回归对应最终源码，不能把早期 Native 报告的源文件摘要伪称为最终源码全部字节相同。

## 游戏完整性与战役覆盖

[战役运行记录](validation/campaign-recovery.json) 来自实际地图移动、事件选项、合法获得的属性和装备、可见敌人意图、技能与休息流程。没有注入任务完成、等级、首领胜利或奖励状态。界面环境使用 DOM/存储/时钟桩，因此它证明游戏规则和流程可达，不替代人类玩家体验评估。

- 三个职业各用三个固定种子，完成开局到前两章的路线。
- 一条先锋卫士完整路线完成五章、23 个事件以及终章三种结局的各分支验证；结局分支从同一合法状态恢复，不把一条结局奖励带入另一条。
- 四个主线首领和一个可选首领均经历阶段变化。主线路线的首领战分别为 7、6、9、11 回合；可选首领为 7 回合。
- 防御对照证明选择会改变结果：Garrick 同一回合的掉血由攻击时 17 降为防御时 6，Malakor 从 23 降为 8。
- 当前先锋路线没有使用药品，允许正常技能和大招回血；这也说明数值仍有偏宽松的部分。没有宣称三职业的全部结局、所有配装和长线经济均已平衡。

玩法与取舍详见 [gameplay-design.md](gameplay-design.md) 和 [combat-audit.md](combat-audit.md)。

## 联机、系统与尚未验收的范围

联机 12 项测试运行实际服务端和客户端协议，替换的是 WebSocket、时钟等平台依赖。涵盖人数、会话身份、实际回合、非法/过期行动、冷却、贡献门槛、断线和重复结果。**没有部署 Cloudflare 公网服务，也没有完成跨设备公网对局。** 当前服务端不提供账户认证、持久排名或完整反作弊，状态保存在内存中。

Ollama 桥接经过允许路径、请求大小、来源及流转发测试，上游使用 Mock。**没有本次真实 Ollama 推理结果。** 浏览器 Qwen3 的验收不能替代它。真实浏览器测试使用 Linux Chromium，Windows/macOS 的启动脚本与 Python 路径经过代码检查，没有在这两个操作系统上重做完整运行验收。

首次远端 CI 暴露了 Node.js 22 测试参数名称和 Ubuntu 26.04 与锁定版 Playwright 的兼容问题。测试入口改用 Node.js 22.8+ 支持的 `--experimental-test-isolation=none`，工作流固定 Ubuntu 24.04；没有删除或放宽检查。远端 CI 的实际状态以相应 GitHub PR 的 Checks 为准。本地报告不预先宣称远端成功；提交分支和 PR 也不等于合并 main、发布 GitHub Pages 或部署多人服务器。

## 重现命令

开发回归需要 Node.js 22.8+、Python 3.10+；本轮运行环境为 Node.js 24.19.0、Python 3.12.14 和 Linux。游玩已构建的完整包只需要 Python 与现代浏览器。

```sh
npm ci
npm run build
python tests/verify_mud.py --report test-results/verification.json
python tools/prepare_offline.py --model qwen-0.6b
python tools/prepare_offline.py --verify-only
npx playwright install chromium
node tests/browser.mjs --model --report test-results/browser.json
node tests/real-model.mjs --model=qwen-0.6b --local
node tests/real-model.mjs --model=qwen-0.6b --local --lang=zh --case=npc,encounter,tavern
```

最后两条是质量验收入口：已知失败会返回非零退出码，叙事样本需独立语义审阅。不要把返回非零改为忽略，或把“有输出”当作正确回答。
