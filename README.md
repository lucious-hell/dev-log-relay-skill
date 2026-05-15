# Dev Log Relay Skill

[English](#english) | [中文](#中文)

## English

Dev Log Relay is a target-project verification harness for executing AI.

It helps an AI prove work against the real project before claiming completion: resolve the target workspace, start or attach to the real environment, run user-visible blackbox flows, collect auditable evidence, seed regressions when blocked, and return a release gate.

It is not a demo runner, a generic test framework, or an AI judge. Its job is narrower: prevent self-certified "done" by forcing completion claims through real runtime evidence.

### Why It Exists

AI coding agents can describe a fix confidently while never exercising the product as a user. Dev Log Relay adds an external verification layer between "I changed the code" and "the target project works."

The default proof path is:

```text
target project -> real environment -> blackbox user flow -> evidence store -> release gate
```

Only `HarnessGate.status === "pass"` should be treated as target-project verification passed.

### Supported Targets

- Browser Web projects
- WeChat Miniapp projects

Unsupported by design:

- Electron
- React Native
- Native iOS / Android
- Desktop GUI apps
- Server batch jobs
- Documentation-only or mechanical-only edits

### Core Guarantees

- Real target project only: production commands must use the invocation workspace, an explicit URL, or the target project's own start command.
- No production demo fallback: built-in demos and fixtures are test/benchmark assets only.
- User-visible blackbox assertions: pass/fail is based on visible UI evidence, not internal APIs, mocks, component state, or logs alone.
- Auditable evidence: reports, traces, screenshots, accessibility summaries, capsules, manifests, and exports are stored in the runtime artifact store.
- Unified release gate: traces, screenshots, runtime logs, visual/a11y signals, and locator repair can help diagnosis, but cannot independently ship.
- Miniapp requires a real driver: use a driver module or a valid Computer Use ledger; verify-only observations do not prove user-flow closure.

### Repository Layout

```text
dev-log-relay-skill/
├── SKILL.md                # natural-language skill contract
├── LICENSE                 # MIT license
├── agents/                 # skill metadata
├── references/             # workflow, target matrix, driver contract
├── scripts/                # skill-facing wrapper entrypoints
└── runtime/                # HTTP service, CLI, adapters, fixtures, tests
```

### Skill Installation

For end users, Dev Log Relay should be invisible. They should not start a server, run npm commands, or call the CLI directly. They ask the executing AI to test, retest, or verify closure; the AI triggers this skill and runs the harness.

For skill integrators, installation should be one action in the host agent environment:

```text
Install this repository as an agent skill.
```

The skill contract is [SKILL.md](./SKILL.md), and the OpenAI skill metadata is [agents/openai.yaml](./agents/openai.yaml). Once installed, the executing AI should use the wrapper scripts automatically.

Typical user request:

```text
Please test this flow and verify whether it is really complete.
```

Expected AI behavior:

```text
detect target -> run harness verify -> read HarnessGate -> report evidence
```

The primary wrapper is:

```bash
./scripts/harness-verify.sh \
  --target web \
  --url http://127.0.0.1:5173 \
  --goal "user can open the catalog" \
  --pretty
```

Report and evidence wrappers:

```bash
./scripts/harness-report.sh --harnessRunId <harnessRunId> --pretty
./scripts/harness-evidence.sh --harnessRunId <harnessRunId> --ref <artifactRef> --pretty
```

Manual runtime setup is only for maintainers and contributors; see [Development](#development).

### Web Verification

Web verification can use:

- `--url <targetUrl>`
- `DEV_LOG_RELAY_TARGET_URL`
- auto-start from the resolved target project package script

Typical command:

```bash
./scripts/harness-verify.sh \
  --target web \
  --url http://127.0.0.1:5173 \
  --goal "user can search products" \
  --visual \
  --a11y \
  --pretty
```

Authenticated targets can use Playwright storage state:

```bash
./scripts/harness-verify.sh \
  --target web \
  --url http://127.0.0.1:5173 \
  --storageState /abs/path/storage-state.json \
  --pretty
```

### Miniapp Verification

Miniapp completion proof requires real executable evidence. The default harness path now tries to prepare the managed WeChat DevTools profile, start/check the sidecar, connect the built-in `devtools-automator` driver, and run visible blackbox actions before asking for user help.

Default Miniapp harness path:

```bash
./scripts/harness-verify.sh \
  --target miniapp \
  --pretty
```

External driver module override:

```bash
./scripts/harness-verify.sh \
  --target miniapp \
  --driverModule /abs/path/driver.mjs \
  --pretty
```

Computer Use ledger bridge:

```bash
./scripts/harness-verify.sh \
  --target miniapp \
  --driver computer-use \
  --ledger /abs/path/computer-use-ledger.json \
  --pretty
```

Diagnose Miniapp driver setup:

```bash
./scripts/miniapp-doctor.sh --fix
```

Miniapp verification uses a Dev Log Relay managed WeChat DevTools profile by default. The bootstrap step writes the fixed service-port settings under the runtime artifact home, or under `DEV_LOG_RELAY_HOME` when configured; it does not rely on the user's daily DevTools window as closure evidence.

For persistent local lifecycle management, the executing AI can install the optional sidecar:

```bash
./scripts/miniapp-sidecar.sh install --start
```

For one-time UI pairing through Codex Computer Use, the executing AI can request a pairing contract:

```bash
./scripts/miniapp-bootstrap.sh --fix --driver computer-use
```

If automation reaches a hard system or account boundary, the report returns `forExecutingAI.userActionRequest` with the smallest user action, the reason code, and a replayable retry command. The sidecar, bootstrap, and Computer Use pairing only prepare the environment. Generic screenshot-captured messages are diagnostic only and do not count as visible proof. Miniapp release still requires real action ledger evidence, explicit visible UI evidence, emitted runtime events, verified/controlled profile isolation for the built-in driver, and a passing HarnessGate.

### Blackbox and Evidence Tools

Lower-level tools are available when you need to inspect, debug, or export the harness evidence chain:

```bash
cd runtime
npm run cli -- blackbox discover --target web --url http://127.0.0.1:5173 --pretty
npm run cli -- blackbox plan --target web --url http://127.0.0.1:5173 --goal "user can search" --pretty
npm run cli -- blackbox run --target web --url http://127.0.0.1:5173 --driver playwright --pretty
npm run cli -- blackbox report --runId <runId> --pretty
npm run cli -- blackbox capsule --runId <runId> --pretty
npm run cli -- blackbox trace --runId <runId> --format summary --pretty
npm run cli -- blackbox export --runId <runId> --format playwright --pretty
npm run cli -- store inspect --harnessRunId <harnessRunId> --pretty
```

Exports are written to the runtime artifact store by default. They are written into a target project only when `--out <path>` is explicitly provided.

### Runtime Store

The runtime store persists:

- runs and steps
- events
- scenario reports
- blackbox plans and reports
- evidence capsules
- action traces and Playwright traces
- screenshot and accessibility artifacts
- harness evidence indexes
- artifact manifests

Override the store directory:

```bash
export DEV_LOG_RELAY_RUNTIME_STORE_DIR=/abs/path/relay-store
```

Inspect or clean up artifacts:

```bash
cd runtime
npm run cli -- store inspect --runId <runId> --pretty
npm run cli -- store inspect --harnessRunId <harnessRunId> --pretty
npm run cli -- store cleanup --olderThanDays 30 --dryRun --pretty
npm run cli -- store cleanup --olderThanDays 30 --confirm --pretty
```

Cleanup is dry-run by default and deletes only runtime-store artifacts after explicit `--confirm`.

### Development

Build:

```bash
cd runtime
npm run build
```

Run tests:

```bash
cd runtime
npm test -- --runInBand
```

Check whitespace:

```bash
git diff --check
```

Benchmark fixtures:

```bash
cd runtime
npm run cli -- harness benchmark --fixture all --pretty
```

### Documentation

- [Runtime README](./runtime/README.md): detailed CLI, API, adapters, artifacts, and fixtures
- [Skill contract](./SKILL.md): natural-language behavior for skill execution
- [Workflow](./references/workflow.md): recommended verification workflow
- [Target matrix](./references/target-matrix.md): supported and unsupported targets
- [Driver contract](./references/driver-contract.md): external driver and ledger expectations

### Contributing

Contributions are welcome when they preserve the project boundary:

- Keep production paths target-project-only.
- Do not add demo fallback to normal CLI, wrapper, or skill paths.
- Keep release decisions tied to visible blackbox assertions and valid evidence refs.
- Add tests for new reason codes, gate behavior, driver behavior, and artifact access.
- Prefer local-first adapters over cloud or LLM-only dependencies.

### License

This project is released under the MIT License. See [LICENSE](./LICENSE).

## 中文

Dev Log Relay 是一个面向执行 AI 的目标项目验证 harness。

它帮助 AI 在声称“完成”之前，先对真实目标项目完成外部验证：解析调用目录里的目标项目，启动或连接真实环境，执行用户视角黑盒流程，采集可审计证据，失败时沉淀回归候选，最后由统一 release gate 判断是否允许交付。

它不是 demo 跑通器，不是通用测试框架，也不是 AI judge。它的边界更窄但更关键：防止执行 AI 只靠自述就宣称完成。

### 为什么需要它

AI 编码代理可能很自信地描述修复结果，但没有真正站在用户视角运行产品。Dev Log Relay 在“我改完了”和“目标项目真的可用”之间增加一层外部验证。

默认验证链路是：

```text
目标项目 -> 真实环境 -> 黑盒用户流 -> 证据存储 -> release gate
```

只有 `HarnessGate.status === "pass"` 才能被解释为目标项目验证通过。

### 支持目标

- 浏览器 Web 项目
- 微信小程序项目

明确不支持：

- Electron
- React Native
- 原生 iOS / Android
- 桌面 GUI
- 服务端批处理
- 纯文档修改或机械重命名

### 核心保证

- 只验证真实目标项目：生产命令必须指向调用目录、显式 URL，或目标项目自己的启动命令。
- 禁止生产 demo 回退：内置 demo 和 fixture 只用于测试和 benchmark。
- 黑盒断言基于用户可见 UI：通过与失败不能依赖内部 API、mock、组件内部状态或日志本身。
- 证据可审计：报告、trace、截图、accessibility 摘要、capsule、manifest、export 都写入 runtime artifact store。
- release gate 统一收口：trace、截图、runtime log、视觉/a11y 信号和 locator repair 只能辅助诊断，不能单独放行。
- Miniapp 必须有真实 driver：需要 driver module 或合法 Computer Use ledger；仅 verify 或 route/lifecycle observation 不能证明用户流闭环。

### 仓库结构

```text
dev-log-relay-skill/
├── SKILL.md                # 自然语言 skill 契约
├── LICENSE                 # MIT 协议
├── agents/                 # skill 元信息
├── references/             # workflow、target matrix、driver contract
├── scripts/                # 面向 skill 调用的包装入口
└── runtime/                # HTTP 服务、CLI、适配器、fixture、测试
```

### Skill 安装

对最终用户来说，Dev Log Relay 应该是不可感知的。用户不需要启动服务、不需要运行 npm 命令、也不需要直接调用 CLI。用户只需要要求执行 AI 测试、复测或验证闭环；执行 AI 自动触发这个 skill 并运行 harness。

对 skill 集成者来说，安装应该是宿主 agent 环境里的一步操作：

```text
将本仓库安装为 agent skill。
```

Skill 契约是 [SKILL.md](./SKILL.md)，OpenAI skill 元信息是 [agents/openai.yaml](./agents/openai.yaml)。安装完成后，执行 AI 应自动使用 wrapper 脚本。

典型用户请求：

```text
请测试这个流程，确认是否真的闭环。
```

预期 AI 行为：

```text
识别目标 -> 运行 harness verify -> 读取 HarnessGate -> 汇报证据
```

主要 wrapper：

```bash
./scripts/harness-verify.sh \
  --target web \
  --url http://127.0.0.1:5173 \
  --goal "用户能打开商品列表" \
  --pretty
```

报告和证据 wrapper：

```bash
./scripts/harness-report.sh --harnessRunId <harnessRunId> --pretty
./scripts/harness-evidence.sh --harnessRunId <harnessRunId> --ref <artifactRef> --pretty
```

手动 runtime 设置只面向维护者和贡献者；见 [开发](#开发)。

### Web 验证

Web 验证可以使用：

- `--url <targetUrl>`
- `DEV_LOG_RELAY_TARGET_URL`
- 自动启动已解析目标项目的 package script

常用命令：

```bash
./scripts/harness-verify.sh \
  --target web \
  --url http://127.0.0.1:5173 \
  --goal "用户能搜索商品" \
  --visual \
  --a11y \
  --pretty
```

登录态项目可以使用 Playwright storage state：

```bash
./scripts/harness-verify.sh \
  --target web \
  --url http://127.0.0.1:5173 \
  --storageState /abs/path/storage-state.json \
  --pretty
```

### Miniapp 验证

Miniapp 完工证明必须来自真实可执行证据。默认 harness 路径会尽最大努力准备受控微信开发者工具 profile、启动/检查 sidecar、连接内置 `devtools-automator` driver，并执行用户可见黑盒动作；只有遇到系统权限、微信登录、业务授权等硬边界时才请求用户配合。

默认 Miniapp harness 路径：

```bash
./scripts/harness-verify.sh \
  --target miniapp \
  --pretty
```

使用外部 driver module 覆盖内置 driver：

```bash
./scripts/harness-verify.sh \
  --target miniapp \
  --driverModule /abs/path/driver.mjs \
  --pretty
```

使用 Computer Use ledger 桥接：

```bash
./scripts/harness-verify.sh \
  --target miniapp \
  --driver computer-use \
  --ledger /abs/path/computer-use-ledger.json \
  --pretty
```

诊断 Miniapp driver 配置：

```bash
./scripts/miniapp-doctor.sh --fix
```

Miniapp 验证默认使用 Dev Log Relay 管理的微信开发者工具专用 profile。bootstrap 会把固定服务端口配置写入 runtime artifact home；如果配置了 `DEV_LOG_RELAY_HOME`，则写入该目录。闭环证据不依赖用户日常打开的微信开发者工具窗口。

需要持久管理本机 DevTools 生命周期时，执行 AI 可以安装可选 sidecar：

```bash
./scripts/miniapp-sidecar.sh install --start
```

需要通过 Codex Computer Use 做首次 UI 配对时，执行 AI 可以请求配对合约：

```bash
./scripts/miniapp-bootstrap.sh --fix --driver computer-use
```

如果自动化撞到系统或账号硬边界，报告会返回 `forExecutingAI.userActionRequest`，包含最少用户操作、原因码和可复现重试命令。sidecar、bootstrap 和 Computer Use 配对只负责准备环境；普通“已截图”描述只算诊断信息，不算可见证明。Miniapp release 仍然必须依赖真实 action ledger、明确的用户可见 UI 证据、runtime event、内置 driver 的受控 profile isolation，并通过 HarnessGate。

### 黑盒与证据工具

需要检查、调试或导出 harness 证据链时，可以使用低层命令：

```bash
cd runtime
npm run cli -- blackbox discover --target web --url http://127.0.0.1:5173 --pretty
npm run cli -- blackbox plan --target web --url http://127.0.0.1:5173 --goal "用户能搜索" --pretty
npm run cli -- blackbox run --target web --url http://127.0.0.1:5173 --driver playwright --pretty
npm run cli -- blackbox report --runId <runId> --pretty
npm run cli -- blackbox capsule --runId <runId> --pretty
npm run cli -- blackbox trace --runId <runId> --format summary --pretty
npm run cli -- blackbox export --runId <runId> --format playwright --pretty
npm run cli -- store inspect --harnessRunId <harnessRunId> --pretty
```

默认 export 写入 runtime artifact store。只有显式提供 `--out <path>` 时，才会写入用户指定位置。

### Runtime Store

Runtime store 会持久化：

- run 和 step
- event
- scenario report
- blackbox plan 和 report
- evidence capsule
- action trace 和 Playwright trace
- screenshot 和 accessibility artifact
- harness evidence index
- artifact manifest

覆盖存储目录：

```bash
export DEV_LOG_RELAY_RUNTIME_STORE_DIR=/abs/path/relay-store
```

查看或清理 artifact：

```bash
cd runtime
npm run cli -- store inspect --runId <runId> --pretty
npm run cli -- store inspect --harnessRunId <harnessRunId> --pretty
npm run cli -- store cleanup --olderThanDays 30 --dryRun --pretty
npm run cli -- store cleanup --olderThanDays 30 --confirm --pretty
```

清理默认只做 dry-run；只有显式传入 `--confirm` 才会删除 runtime store 内的过期 artifact。

### 开发

构建：

```bash
cd runtime
npm run build
```

运行测试：

```bash
cd runtime
npm test -- --runInBand
```

检查空白字符：

```bash
git diff --check
```

运行 fixture benchmark：

```bash
cd runtime
npm run cli -- harness benchmark --fixture all --pretty
```

### 文档

- [Runtime README](./runtime/README.md)：详细 CLI、API、适配器、artifact 和 fixture
- [Skill contract](./SKILL.md)：skill 执行时的自然语言行为契约
- [Workflow](./references/workflow.md)：推荐验证工作流
- [Target matrix](./references/target-matrix.md)：支持和不支持的目标
- [Driver contract](./references/driver-contract.md)：外部 driver 和 ledger 要求

### 贡献

欢迎贡献，但需要保持项目边界：

- 生产路径必须只指向真实目标项目。
- 不要给普通 CLI、wrapper 或 skill 路径增加 demo 回退。
- release decision 必须绑定用户可见黑盒断言和有效证据 ref。
- 新增 reason code、gate 行为、driver 行为和 artifact 访问时必须补测试。
- 优先保持 local-first adapter，不把云服务或 LLM-only 判断放进核心 gate。

### 协议

本项目采用 MIT License，详见 [LICENSE](./LICENSE)。
