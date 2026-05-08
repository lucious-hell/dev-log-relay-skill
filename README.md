# Dev Log Relay Skill

[中文](#中文) | [English](#english)

Dev Log Relay is a skill-oriented local middleware for AI-assisted development on browser Web projects and WeChat Miniapp projects.

It does not try to be a universal agent for every stack. Its job is narrower and more useful: help an AI actively trigger runtime verification, collect structured evidence, diagnose failures, decide closure, and produce handoff artifacts when closure is not justified.

## Highlights

- Skill-first: natural-language trigger rules live in `SKILL.md`
- Runtime-first: project inspection is not treated as runtime proof
- Evidence-first: runtime work should end with a structured report, not a vague summary
- Web closed loop: strong support for browser Web flows
- Miniapp verify-first: strong integration verification and half-automatic diagnostic loop
- Driver-agnostic: Playwright is a reference driver, but external IDE/browser agents can drive the target too

## Repository Layout

```text
dev-log-relay-skill/
├── SKILL.md                # natural-language skill contract
├── LICENSE                 # open-source license
├── agents/                 # skill metadata
├── references/             # workflow, target matrix, driver contract
├── scripts/                # wrapper entrypoints for skill execution
└── runtime/                # HTTP service, CLI, adapters, tests, examples
```

## What This Project Is For

Use this project when an AI is working on:

- browser Web projects
- WeChat Miniapp projects

Typical trigger requests include:

- "test this flow"
- "retest the fix"
- "run a regression check"
- "verify the closure"
- "measure whether the page still has runtime issues"

Chinese trigger examples:

- “测一下这个 Web 流程”
- “跑一下这个页面看看有没有报错”
- “自测一下刚改的功能”
- “复测一下这个 bug”
- “回归验证一下”
- “看看这个小程序还有没有问题”
- “排查一下为什么白屏”
- “修完之后再验证一轮”
- “确认这轮是不是已经闭环了”

## What This Project Is Not For

This skill is intentionally scoped. It is not a universal runtime framework for:

- Electron
- React Native
- native iOS / Android
- desktop GUI apps
- server batch jobs
- non-browser graphics apps
- documentation-only or purely mechanical refactors

## Default Skill Behavior

When runtime work is detected, the skill should not jump straight to "done".

The expected sequence is:

1. detect target suitability
2. verify project integration readiness
3. start or inspect a run
4. bind relay to the current run / step
5. collect runtime evidence
6. query diagnosis
7. query closure
8. produce handoff when unresolved or blocked

The default evidence-first report order is:

1. `target / support`
2. `trigger decision`
3. `project verify`
4. `runtime readiness`
5. `collection`
6. `diagnosis`
7. `closure`
8. `handoff`

## Main Entrypoints

The skill prefers the wrapper scripts in `scripts/` so the user or agent does not need to remember internal runtime details.

- `scripts/start-relay.sh`
- `scripts/doctor.sh`
- `scripts/project-verify.sh`
- `scripts/miniapp-verify.sh`
- `scripts/agent-contract.sh`
- `scripts/web-autoloop.sh`
- `scripts/handoff.sh`

These wrappers auto-start the local relay backend when needed.

## Runtime Boundary

The project keeps a strict distinction between project inspection and runtime proof:

- `project verify`: "Is the project structurally ready to be instrumented?"
- `web verify` without `runId`: "What can we infer from project inspection only?"
- `web verify --runId <runId>` or `/ai/run/:runId/readiness`: "What runtime signals were actually observed?"

That boundary is deliberate. Project structure helps preparation; it does not prove runtime closure.

## Quick Start

### 1. Start the runtime backend

```bash
cd runtime
npm install
npm run build
npm run start
```

Default relay address:

```text
http://127.0.0.1:5077
```

### 2. Run skill-facing commands

Examples:

```bash
./scripts/doctor.sh target --target web --pretty
./scripts/project-verify.sh --target web --pretty
./scripts/web-autoloop.sh --target web --pretty
./scripts/miniapp-verify.sh --pretty
```

### 3. Read the runtime docs

For APIs, CLI commands, adapters, artifacts, and examples, see [runtime/README.md](./runtime/README.md).

## Best Practice

- Prefer runtime relay instrumentation over scraping browser DevTools console UI
- Treat Web and Miniapp as separate supported surfaces with different closure rules
- Do not claim closure from project-only evidence
- Do not enter structural repair before `collection` / `integrity` is acceptable
- For Miniapp, verify-first is mandatory

## Open Source License

This project is released under the MIT License. See [LICENSE](./LICENSE).

## 中文

Dev Log Relay 是一个面向 AI 开发协作场景的本地 skill 中间件，专门服务于：

- 浏览器前端 Web 项目
- 微信小程序项目

它不追求“所有项目通吃”，而是把一件事做深：让 AI 在开发、测试、复测、回归验证和闭环确认时，能够主动拉起技能、收集运行时证据、看清日志顺序、定位故障链，并在无法闭环时留下稳定的交接工件。

### 项目定位

这个项目强调四件事：

- `skill-first`：自然语言触发规则写进 `SKILL.md`
- `runtime-first`：运行时证据优先，结构检查不是运行完成证明
- `evidence-first`：最终汇报优先输出结构化证据，而不是泛泛总结
- `boundary-first`：只服务 Web 和微信小程序，明确拒绝不适用目标

### 仓库结构

```text
dev-log-relay-skill/
├── SKILL.md                # 自然语言技能契约
├── LICENSE                 # 开源协议
├── agents/                 # 技能元信息
├── references/             # 工作流、目标矩阵、驱动契约
├── scripts/                # skill 对外执行入口
└── runtime/                # HTTP 服务、CLI、适配器、测试、示例
```

### 适用场景

适用于 AI 正在处理以下任务时：

- 修改了 Web 页面或前端运行时代码
- 修改了微信小程序页面、生命周期、路由、请求逻辑
- 用户要求“测一下 / 跑一下 / 自测 / 复测 / 回归验证 / 看看还有没有问题”
- 需要判断这轮修复是否真的闭环

典型中文触发语句包括：

- “测一下这个 Web 流程”
- “跑一下这个页面看看有没有报错”
- “自测一下刚改的功能”
- “复测一下这个 bug”
- “回归验证一下”
- “看看这个小程序还有没有问题”
- “排查一下为什么白屏”
- “修完之后再验证一轮”
- “确认这轮是不是已经闭环了”

### 不适用场景

本项目明确不把自己包装成全能方案。以下目标默认不适用：

- Electron
- React Native
- 原生 iOS / Android
- 桌面 GUI
- 服务端批处理
- 非浏览器图形应用
- 纯文档修改或纯机械重命名

### 技能默认流程

命中运行时任务后，默认不能直接宣称“已经修好”。

推荐执行顺序：

1. 识别目标是否适用
2. 验证项目接入准备度
3. 启动或检查一轮 run
4. 绑定当前 `runId / stepId`
5. 收集运行时证据
6. 拉取 diagnosis
7. 拉取 closure
8. 如无法闭环，则产出 handoff

默认证据汇报顺序：

1. `target / support`
2. `trigger decision`
3. `project verify`
4. `runtime readiness`
5. `collection`
6. `diagnosis`
7. `closure`
8. `handoff`

### Skill 执行入口

为了让 skill 更自然地工作，默认优先使用 `scripts/` 目录下的包装入口，而不是让用户记复杂命令：

- `scripts/start-relay.sh`
- `scripts/doctor.sh`
- `scripts/project-verify.sh`
- `scripts/miniapp-verify.sh`
- `scripts/agent-contract.sh`
- `scripts/web-autoloop.sh`
- `scripts/handoff.sh`

这些脚本会在需要时自动拉起本地 relay backend。

### 运行时证据边界

本项目严格区分“结构检查”和“运行时证明”：

- `project verify`：回答“项目结构上是否已经具备注入条件”
- 不带 `runId` 的 `web verify`：回答“仅从结构检查能看出什么”
- `web verify --runId <runId>` 或 `/ai/run/:runId/readiness`：回答“这轮真实运行到底收到了哪些信号”

这是有意设计的边界收敛：结构准备度不等于运行闭环完成。

### 快速开始

#### 1. 启动 runtime 服务

```bash
cd runtime
npm install
npm run build
npm run start
```

默认地址：

```text
http://127.0.0.1:5077
```

#### 2. 通过 skill 入口执行

例如：

```bash
./scripts/doctor.sh target --target web --pretty
./scripts/project-verify.sh --target web --pretty
./scripts/web-autoloop.sh --target web --pretty
./scripts/miniapp-verify.sh --pretty
```

#### 3. 查看 runtime 说明

API、CLI、适配器、artifact 和示例请看 [runtime/README.md](./runtime/README.md)。

### 最佳实践

- 优先做 runtime relay 注入，而不是抓浏览器 DevTools 控制台 UI
- 明确区分 Web 与 Miniapp，不混淆闭环标准
- 没有真实 run 证据时，不宣称已验证完成
- `collection / integrity` 不足时，先修接入，不直接修业务
- Miniapp 默认必须 `verify-first`

### 开源协议

本项目采用 MIT License，详见 [LICENSE](./LICENSE)。

## English

Dev Log Relay is a local skill middleware for AI-assisted work on:

- browser Web projects
- WeChat Miniapp projects

Its goal is not to be a universal agent. Its goal is to help an AI actively trigger runtime validation, collect ordered evidence, diagnose failures, decide closure responsibly, and leave a strong handoff artifact when closure is not justified.

### Positioning

This project is built around four principles:

- `skill-first`: natural-language trigger rules live in `SKILL.md`
- `runtime-first`: runtime evidence comes before narrative confidence
- `evidence-first`: structured evidence reports are preferred over free-form closure claims
- `boundary-first`: only Web and WeChat Miniapp are supported targets

### Suitable Tasks

Use it when the AI is:

- changing Web runtime code
- changing Miniapp lifecycle, route, or request logic
- asked to test, retest, regression-check, or verify closure
- trying to decide whether a fix really landed

### Unsuitable Tasks

This project intentionally does not claim support for:

- Electron
- React Native
- native iOS / Android
- desktop GUI apps
- server batch jobs
- non-browser graphics apps
- documentation-only or mechanical-only edits

### Default Flow

Once runtime work is detected, the skill should not jump straight to "done".

Recommended order:

1. detect whether the target is supported
2. verify project integration readiness
3. start or inspect a run
4. bind the current `runId / stepId`
5. collect runtime evidence
6. query diagnosis
7. query closure
8. emit handoff when closure is blocked or unresolved

Default report order:

1. `target / support`
2. `trigger decision`
3. `project verify`
4. `runtime readiness`
5. `collection`
6. `diagnosis`
7. `closure`
8. `handoff`

### Open Source License

This repository is released under the MIT License. See [LICENSE](./LICENSE).
