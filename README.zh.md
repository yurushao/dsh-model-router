---
created: 2026-09-24
updated: 2026-09-24
---

# DSH Model Router

[English](README.md) | [简体中文](README.zh.md)

通过 Jev Decisions API 为 DeepSeek Harness 自动选择模型。插件读取 Harness 中已注册的模型，将模型名称和 ID 提交给 Jev，再使用 Jev 选中的模型处理当前用户轮次。同一轮次中的工具续接和重试沿用该模型；手动选择具体模型时跳过 Jev。

包名为 `@yurushao/dsh-model-router`。这是独立的社区插件，与 DeepSeek、Jev 或 OpenRouter 没有隶属关系。

## 兼容性

当前开发版本面向未经修改的 Harness `0.1.7-alpha.1`，对应提交 `c36a83ff6bb95e3f82cf79f9be7c724270a8aa61`。插件使用公开扩展接口，无需修改宿主源码或为依赖打补丁。宿主需要提供标准的模型、系统提示词和存储域服务。

构建环境使用 Node 24.15.0、Bun 1.3.3、Git 和原生构建工具。Harness 和 Vitest 在 Node 上运行；Bun 用于安装依赖和调用脚本。

## 安装与启动

```sh
git clone https://github.com/yurushao/dsh-model-router.git
cd dsh-model-router
bun install --frozen-lockfile
bun run check
node scripts/prepare-harness.mjs --dir .cache/harness-stock --build
bun pm pack
```

将生成的安装包添加到 Harness 配置环境（profile）。以下示例创建独立的 Web 环境并启动：

```sh
export DSH_HOME="$PWD/.cache/demo-home"
export DSH_ROUTER_ROOT="$PWD"
cd .cache/harness-stock
npx --yes pnpm@11.7.0 dsh plugin --profile web add "$DSH_ROUTER_ROOT/yurushao-dsh-model-router-0.5.0.tgz"
npx --yes pnpm@11.7.0 dsh --profile web
```

插件默认禁用。在侧边栏打开 **插件**，选择 **@yurushao/dsh-model-router**，启用 `jev-router` 组件，再点击 **配置** 编辑 Jev 设置。在 **设置 → 模型** 中添加或移除用于回答的模型。插件不提供单独的经济型或旗舰模型配置字段。

Jev API Key 输入框将密钥写入 Harness 凭据存储，引用名由 `apiKeyEnv` 指定，默认为 `OPENROUTER_API_KEY`；页面不会读取并显示密钥。也可以使用启动环境中已有的凭据。旧配置中直接填写的 `apiKey` 仍受支持，但 Harness 凭据优先。页面还提供 Decisions 接口地址、Jev 模型、超时、输入上限、最近历史消息数和子代理路由开关。

需要同时配置模型提供方时，参见 [OpenRouter 示例](examples/openrouter.patch.yml)。模型已在 Harness 中配置好的情况下，使用 [仅配置路由器的示例](examples/router.patch.yml)。将这些条目放入当前 profile 的 `cordis.patch.yml`，即可继续通过界面编辑；命令行 `--patch` 覆盖层优先级更高，会阻止保存被覆盖的字段。合并提供方配置时需注意：profile 覆盖可能替换其他提供方。Jev 请求和最终回答模型都可能产生费用。

## 工作方式

- 每个 Auto 轮次开始时，插件列出 Harness 已注册的提供方及其公布的模型。Jev 接收候选模型的名称、ID、提供方和描述，返回一个候选项标识。插件核对该标识确实属于本次候选列表后再执行路由。
- 当输入包含图片时，插件会排除被 Harness 明确标记为不支持图片输入的模型。若没有剩余候选模型，本轮在调用 Jev 前失败。Harness 模型目录不是完整的模型访问限制，因此可直接调用但未列入目录的模型 ID 不参与候选。
- 如果 Jev 调用失败，或输入包含无法分类的二进制内容、超出大小限制，插件优先保留仍符合条件的当前模型；否则使用宿主目录中第一个符合条件的模型。取消操作不会触发回退。最终选中的适配器仍会自行验证模型能力。
- 当前请求、当前任务的起始请求，以及配置允许的最近历史消息，会通过 OpenRouter 发送给 Jev。隐藏推理和二进制附件内容不会发送。最终回答模型接收正常的 Harness 对话历史。
- Auto 对应可选模型 `jev-router/auto`，使用标准的 `model/selection` 事件。路由诊断和任务起点保存在插件自己的 `jev_router` 存储域中。旧的、标记为可忽略的 `jev-router/routing` 记录仍可读取；新轮次不再写入这种自定义事件。插件通过公开 UI 插槽，在会话顶部显示 Auto 状态和实际模型。

Jev 的决策具有概率性。模型名称和 ID 为其提供判断依据，但不能保证回答质量，也不能证明模型能力。请检查每轮实际使用的模型，并针对自己的任务验证候选模型。

## 配置项

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `apiKeyEnv` | `OPENROUTER_API_KEY` | Jev 使用的 Harness 凭据引用名 |
| `apiKey` | 未设置 | 兼容旧配置的内联密钥，凭据引用未解析到值时使用 |
| `endpoint` | OpenRouter Decisions 接口 | 接受 Decisions 格式的 HTTPS 接口 |
| `jevModel` | `typesafe/jev-1.13` | Jev 分类模型 |
| `timeoutMs` | 3000 | Jev 请求超时，单位为毫秒 |
| `maxRoutingBytes` | 16000 | Jev 状态与模型候选描述的 UTF-8 字节数上限 |
| `historyMessages` | 0 | 发送给 Jev 的最近对话消息数；0 表示不发送 |
| `includeSubagents` | true | 对子代理应用 Auto 路由 |
| `enabled` | true | 启用 Auto 路由 |

旧 profile 覆盖配置中的 `models.economy`、`models.frontier` 和模型档位策略字段会被忽略。维护配置时可移除这些字段；用于回答的模型应在 Harness 的 **设置 → 模型** 中配置。

## 验证

```sh
bun run check
bun run test:install
```

`test:install` 会打包插件、安装到临时环境，并通过本地模拟 Decisions 服务验证具体模型选择、手动模式绕过和会话恢复，不产生付费模型请求。可选的真实 Jev 验证脚本为 `node scripts/smoke-jev.mjs` 和 `node scripts/eval-jev.mjs`；它们需要 `OPENROUTER_API_KEY`，可能产生费用。

更多信息见 [兼容性说明](docs/compatibility.md)、[发布流程](docs/releasing.md)、[安全政策](SECURITY.md) 和 [许可证](LICENSE)。上游署名信息保留在 [NOTICE](NOTICE) 和 [HARNESS-LICENSE](compatibility/HARNESS-LICENSE) 中。
