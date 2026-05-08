# Dev Log Relay Runtime v4

这是 Dev Log Relay skill 的 runtime 实现层，负责 HTTP 服务、CLI、适配器、artifact、diagnosis、closure 与 handoff。

它提供两层入口：

- HTTP 服务：负责 `run / step / timeline / diagnosis / closure / artifact`
- Node CLI：负责把闭环动作串起来，减少 AI 自己拼接调用
- Project Verify：负责真实项目入口检查、接入准备度评估和项目记忆
- Autoloop：负责 `collection -> diagnosis -> repair -> retest -> decision -> handoff`

## 适用范围

本项目从 v3.1 开始明确只面向两类目标：

- 浏览器前端 Web 项目
- 微信小程序项目

不把自己定位成“所有项目通吃”的通用运行时 agent。原因很直接：

- Web 闭环依赖浏览器运行时与可驱动的页面执行环境
- Miniapp 闭环依赖微信小程序生命周期、路由和请求接入能力
- Backend relay 只提供辅助信号，不构成独立完整闭环

因此下列场景默认不适用：

- Electron
- React Native
- 原生移动端
- 桌面 GUI
- 非浏览器图形应用
- 服务端批处理 / 非交互式任务

## 核心闭环

1. `POST /orchestrations/start` 创建一轮带策略的测试 run
2. `POST /runs/:runId/steps/start` / `.../end` 标记步骤
3. SDK 自动上报日志、网络、路由、生命周期
4. `GET /ai/run/:runId/collection` 先确认采证闭环是否完整
5. `GET /ai/run/:runId/diagnosis` 获取诊断摘要
6. `GET /ai/run/:runId/repair-brief` 生成机器优先修复简报
7. `GET /ai/run/:runId/closure` 获取闭环判断
8. `GET /ai/run/:runId/report` 获取证据优先的统一闭环报告
9. `GET /ai/run/:runId/artifact` 生成 JSON 工件
10. `GET /ai/diff?baselineRunId=...&currentRunId=...` 对比修复前后
11. `GET /ai/autoloop/:id/decision` 执行 stop gate 决策

## 启动

```bash
npm install
npm run build
npm run start
```

默认服务地址：`http://127.0.0.1:5077`

## CLI

```bash
npm run cli -- run start --label smoke --target web
npm run cli -- ai diagnosis --runId <runId> --pretty
npm run cli -- ai report --runId <runId> --pretty
npm run cli -- loop web --mode baseline --pretty
npm run cli -- loop compare --baselineRunId <a> --currentRunId <b> --pretty
npm run cli -- autoloop run --target web --pretty
npm run cli -- web verify --pretty
npm run cli -- miniapp verify --pretty
npm run cli -- project verify --target auto --pretty
npm run cli -- doctor readiness --target auto --pretty
npm run cli -- doctor enforcement --target web --phase self_test --runtimeImpact true --runId <runId> --closureClaim true --pretty
npm run cli -- agent contract --target web --driver computer-use --pretty
npm run cli -- ai handoff --runId <runId> --pretty
```

支持命令：

- `relay doctor target`
- `relay doctor trigger`
- `relay doctor enforcement`
- `relay doctor readiness`
- `relay project identify`
- `relay project verify`
- `relay project advise`
- `relay project memory`
- `relay project history`
- `relay agent contract`
- `relay web verify`
- `relay run start`
- `relay run step start`
- `relay run step end`
- `relay run end`
- `relay ai timeline`
- `relay ai diagnosis`
- `relay ai report`
- `relay ai closure`
- `relay ai diff`
- `relay loop web`
- `relay loop compare`
- `relay autoloop start`
- `relay autoloop collect`
- `relay autoloop diagnose`
- `relay autoloop repair`
- `relay autoloop retest`
- `relay autoloop decide`
- `relay autoloop run`
- `relay autoloop handoff`
- `relay miniapp verify`
- `relay ai handoff`

常用参数：

- `--relay <url>`：服务地址
- `--pretty`：更适合人读的输出
- `--artifact <path>`：指定 JSON 工件路径

## 能力矩阵

| Target | 状态 | 参考驱动 | 适用说明 | 推荐入口 |
|---|---|---|---|---|
| Web | supported | Playwright（内建参考驱动） | 完整 run/step/timeline/closure/autoloop 闭环；也允许外部 agent 自己驱动 | `relay project verify --target web` -> `relay autoloop run --target web` |
| Miniapp | partial | 不支持完整自动驱动 | 强接入验证 + 收集 + 诊断前置闭环 | `relay project verify --target miniapp` |
| Backend | inapplicable | 无 | 仅辅助 relay 信号源 | 作为 web/miniapp 附属信号 |
| Other | unsupported | 无 | 超出技术栈边界 | 不建议使用本 skill |

## 服务接口

### 编排

- `POST /runs/start`
- `POST /runs/:runId/steps/start`
- `POST /runs/:runId/steps/:stepId/end`
- `POST /runs/:runId/end`
- `POST /orchestrations/start`
- `POST /orchestrations/:runId/checkpoint`
- `POST /autoloops/start`
- `POST /autoloops/:id/attempts/start`
- `POST /autoloops/:id/attempts/:attemptId/complete`
- `POST /autoloops/:id/attempts/:attemptId/repair-outcome`

### AI 查询

- `GET /ai/targets/support?target=...`
- `GET /ai/driver/contract?target=...&driver=...`
- `POST /ai/trigger/decision`
- `POST /ai/task/enforcement`
- `POST /ai/project/identify`
- `GET /ai/project/profile`
- `GET /ai/project/memory`
- `GET /ai/project/history`
- `GET /ai/runs`
- `GET /ai/web/project-check`
- `GET /ai/miniapp/project-check`
- `GET /ai/run/:runId/timeline`
- `GET /ai/run/:runId/summary`
- `GET /ai/run/:runId/incidents`
- `GET /ai/run/:runId/context`
- `GET /ai/run/:runId/flow`
- `GET /ai/run/:runId/diagnosis`
- `GET /ai/run/:runId/closure`
- `GET /ai/run/:runId/report`
- `GET /ai/run/:runId/integrity`
- `GET /ai/run/:runId/readiness`
- `GET /ai/run/:runId/failure-chain`
- `GET /ai/run/:runId/repair-strategy`
- `GET /ai/run/:runId/handoff`
- `GET /ai/run/:runId/miniapp-signals`
- `GET /ai/run/:runId/collection`
- `GET /ai/run/:runId/hotspots`
- `GET /ai/run/:runId/repair-brief`
- `GET /ai/run/:runId/artifact`
- `GET /ai/web/integration-guide`
- `GET /ai/miniapp/integration-guide`
- `GET /ai/autoloop/:id`
- `GET /ai/autoloop/:id/decision`
- `GET /ai/diff?baselineRunId=...&currentRunId=...`

### 兼容接口

- `GET /healthz`
- `GET /ai/incidents`
- `GET /ai/context`
- `GET /ai/diff?baseline=...&current=...`

## 工件

默认输出到 `runtime/artifacts/`。
项目级记忆默认输出到 `runtime/project-memory/`。

每个 artifact 至少包含：

- `run`
- `summary`
- `flow`
- `timelineExcerpt`
- `topIncidents`
- `collection`
- `hotSpots`
- `diagnosis`
- `repairBrief`
- `readiness`
- `evidenceSource`
- `closure`
- `integrity`
- `checkpoints`
- `project`
- `projectMemoryRef`
- `failureChain`
- `repairStrategy`
- `handoff`

Autoloop artifact 还会附带：

- `autoloop.session`
- `autoloop.attempts`
- `autoloop.decision`
- 每次 attempt 的 `repairOutcome`
- `targetSupport`
- `triggerDecision`
- `closureEligibility`

## SDK

### Web

`createWebRelay(options)` 返回：

- `startAutoCapture()`
- `stopAutoCapture()`
- `send()`
- `bindRun()`
- `bindStep()`
- `clearBinding()`
- `getBindingState()`
- `selfCheck()`

自动采集：

- `console.*`
- `window.onerror`
- `unhandledrejection`
- `fetch`
- `XMLHttpRequest`
- `history.pushState / replaceState / popstate`
- 资源加载失败
- render / blank-screen guard

### Miniapp

`createMiniappRelay(options)` 返回：

- `startAutoCapture()`
- `stopAutoCapture()`
- `send()`
- `bindRun()`
- `bindStep()`
- `clearBinding()`
- `capturePageLifecycle()`
- `wrapApp()`
- `wrapPage()`
- `wrapComponent()`
- `enableMiniappRuntimePatch()`
- `disableMiniappRuntimePatch()`
- `getBindingState()`
- `selfCheck()`

默认推荐：包装器模式。  
增强模式：运行时 patch，失败时必须安全回退。

新增：

- `validateMiniappIntegration()`
- `collectMiniappBaselineSignals()`

CLI 可用：

```bash
npm run cli -- miniapp verify --pretty
```

### Backend

- `send()`
- `bindRun()`
- `bindStep()`
- `clearBinding()`
- `getBindingState()`
- `selfCheck()`

## Autoloop

Autoloop 是 v3 的主闭环入口：

1. 建 baseline
2. 建 broken run
3. 拉 collection / diagnosis / repair brief
4. 记录 repair outcome
5. 跑 fixed retest
6. 拉 closure / diff
7. 走 stop gate

默认 stop gate：

- `resolved` 立即停止
- `collection/integrity` 不足则先修接入
- 连续两轮无改善停止
- 出现回归停止
- 达到最大尝试次数停止

## Trigger Gate

在进入 `loop` 或 `autoloop` 前，CLI 和服务端都会先做两层判定：

1. `doctor target`
   - 当前目标是不是 web / miniapp
   - 当前能力是不是 supported / partial / unsupported / inapplicable
2. `doctor trigger`
   - 当前任务是否已经进入必须触发 skill 的阶段

示例：

```bash
npm run cli -- doctor target --target web --pretty
npm run cli -- doctor trigger --target web --phase self_test --reason "测试整体流程" --runtimeImpact true --pretty
npm run cli -- web verify --pretty
```

标准降级结构：

```json
{
  "ok": false,
  "status": "unsupported",
  "reasonCode": "unsupported_target",
  "reason": "This target is outside the supported scope of the skill.",
  "recommendedAction": "Use the skill only for browser web projects or WeChat miniapp projects.",
  "supportedTargets": ["web", "miniapp"],
  "currentCapabilities": []
}
```

## Project Verify

真实项目进入闭环前，先跑项目级检查：

```bash
npm run cli -- project verify --target web --pretty
npm run cli -- project verify --target miniapp --pretty
```

Web 会检查：

- 框架识别：React/Vite、Vue/Vite、Next.js、Taro H5、uni-app H5、generic web
- bootstrap 入口
- 路由层候选
- 网络封装候选
- 错误边界候选
- relay insertion readiness

Miniapp 会检查：

- `app.ts/js`
- 页面注册
- wrapper / patch 覆盖
- route / lifecycle / network 信号准备度

verify 未达标时，系统只输出接入修复建议，不直接推进业务 bug 自动修复。

## 驱动契约

这个项目真正关心的不是“必须由谁来点页面”，而是**驱动无关的闭环协议**。

也就是说，外部执行器可以是：

- Codex 的 `computer use`
- IDE 自带浏览器 agent
- Playwright
- 其他能驱动浏览器页面流程的 agent

只要它满足下面这套契约，就能挂进这套中间件：

1. 创建 `run`
2. 在关键动作前后创建 `step`
3. 驱动目标页面或小程序执行
4. 让 SDK 自动上报 route / network / lifecycle / render / error
5. 回拉 `collection / diagnosis / closure / artifact`

所以：

- **Playwright 不是唯一驱动**
- **Playwright 只是仓库内建的参考驱动和演示驱动**
- **中间件核心是 driver-agnostic 的运行时证据闭环**

如果外部 agent 需要一份机器可读契约，可以直接拿：

```bash
npm run cli -- agent contract --target web --driver computer-use --pretty
```

或：

```bash
GET /ai/driver/contract?target=web&driver=computer-use
```

## Playwright 示例

Playwright 在本仓库里的角色是：

- 内建参考驱动
- 演示闭环夹具
- 可重复执行的测试样例

它的作用是证明这条闭环链能稳定跑通，不是要求所有 AI agent 都必须用它。

- `runtime/examples/web-playwright/runner.mjs`

手动运行：

1. 启动 relay 服务
2. 执行：

```bash
npm run cli -- loop web --mode baseline --pretty
npm run cli -- loop web --mode broken --baselineRunId <baselineRunId> --pretty
npm run cli -- loop web --mode fixed --baselineRunId <baselineRunId> --pretty
npm run cli -- loop compare --baselineRunId <baselineRunId> --currentRunId <currentRunId> --pretty
npm run cli -- autoloop run --target web --artifact artifacts/autoloop-demo.json --pretty
```

示例模式：

- `baseline`: 正常流程
- `broken`: 故意触发网络与 UI 错误
- `fixed`: 修复后流程

生成的 `artifacts/autoloop-demo.json` 会包含 broken -> fixed 的完整证据链。

## AI 使用准则

- 改了运行时代码后，必须先经过 target / trigger gate
- Web 命中测试、复测、报错、回归场景后，必须先跑 `relay project verify --target web`，再进入 `relay autoloop run`
- Miniapp 命中同类场景后，必须先跑 `relay project verify --target miniapp`
- Web 未通过 `project verify` 或 readiness 不足时，不应进入完整 autoloop
- 若只是文档、纯重命名、无运行时影响改动，不需要触发 autoloop
- 若 `collection.status=incomplete` 或 `integrity` 明显不足，先补采集再修业务
- `timeline` 只能说明顺序，不能单独说明“修好了”
- 只有 `closure` 与 `diff` 一起稳定，才算真正收敛
- 停止自动修复时，必须产出 `handoff`
- 不适用目标必须明确返回 unsupported / inapplicable，不能伪装成“已验证”

## 运行时中继最佳实践

- `evidenceSource` 当前统一为 `runtime_relay`
- Chrome 或微信开发者工具控制台 UI 不进入 `closure / compare / autoloop` 事实链
- Web 推荐接入模式：
  - `browser-injected`
  - `bootstrap`
  - `manual`
- Miniapp 推荐接入模式：
  - `wrapper-first`
  - `patch-enhanced`
  - `manual-fallback`

## 错误码与降级

- `unsupported_target`
- `backend_auxiliary_only`
- `miniapp_verify_required`
- `insufficient_collection`
- `collection_incomplete`
- `web_autoloop_required`

## 环境变量

- `DEV_LOG_RELAY_PORT`
- `DEV_LOG_RELAY_HOST`
- `DEV_LOG_RELAY_MAX_EVENTS`
- `DEV_LOG_RELAY_MAX_PENDING`
- `DEV_LOG_RELAY_CONTEXT_WINDOW`
- `DEV_LOG_RELAY_INCLUDE_DEBUG`
- `DEV_LOG_RELAY_ARTIFACT_DIR`

## 验证

```bash
npm test
npm run build
```
