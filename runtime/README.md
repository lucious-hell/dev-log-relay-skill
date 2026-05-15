# Dev Log Relay Runtime v5

这是 Dev Log Relay skill 的 runtime 实现层，负责 HTTP 服务、CLI、适配器、artifact、diagnosis、closure 与 handoff。

它提供三层验证入口：

- HTTP 服务：负责 `run / step / timeline / diagnosis / closure / artifact`
- Node CLI：负责把闭环动作串起来，减少 AI 自己拼接调用
- Project Verify：负责真实项目入口检查、接入准备度评估和项目记忆
- Autoloop：负责 `collection -> diagnosis -> repair -> retest -> decision -> handoff`
- Scenario / Baseline：负责场景级验证、状态转移验证与回归基线对比

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
4. `GET /ai/targets/detect` / `GET /ai/project/compatibility` 先确认目标和工程结构
5. `GET /ai/run/:runId/collection` 先确认采证闭环是否完整
6. `POST /scenarios/validate` 进行场景级验证
7. `GET /ai/run/:runId/diagnosis` 获取诊断摘要
8. `GET /ai/run/:runId/repair-brief` 生成机器优先修复简报
9. `GET /ai/run/:runId/closure` 获取闭环判断
10. `GET /ai/run/:runId/report` 获取证据优先的统一闭环报告
11. `GET /ai/run/:runId/artifact` 生成 JSON 工件
12. `GET /ai/diff/scenario` / `GET /ai/diff/state` 做回归基线对比
13. `GET /ai/autoloop/:id/decision` 执行 stop gate 决策

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
npm run cli -- harness verify --target web --url http://127.0.0.1:5173 --goal "user can complete the target flow" --pretty
npm run cli -- harness verify --target miniapp --pretty
npm run cli -- harness verify --target miniapp --driverModule <driver-module.mjs> --pretty
npm run cli -- harness report --harnessRunId <harnessRunId> --pretty
npm run cli -- harness evidence --harnessRunId <harnessRunId> --ref <artifactRef> --pretty
npm run cli -- loop web --url http://127.0.0.1:5173 --pretty
npm run cli -- loop compare --baselineRunId <a> --currentRunId <b> --pretty
npm run cli -- autoloop run --target web --url http://127.0.0.1:5173 --pretty
npm run cli -- web verify --pretty
npm run cli -- miniapp verify --pretty
npm run cli -- miniapp run --template miniapp_home_entry --driver devtools-automator --pretty
npm run cli -- miniapp run --template miniapp_home_entry --driver devtools-automator --driverModule <driver-module.mjs> --pretty
DEV_LOG_RELAY_COMPUTER_USE_LEDGER=/abs/path/computer-use-ledger.json npm run cli -- miniapp run --template miniapp_home_entry --driver computer-use --driverModule driver-modules/computer-use-miniapp-driver.mjs --pretty
npm run cli -- project verify --target auto --pretty
npm run cli -- project scenarios --target miniapp --pretty
npm run cli -- project baselines --target miniapp --pretty
npm run cli -- scenario list --target miniapp --pretty
npm run cli -- scenario inspect --templateName miniapp_home_entry --target miniapp --pretty
npm run cli -- doctor detect --target auto --pretty
npm run cli -- scenario validate --runId <runId> --templateName request_to_ui_continuity --pretty
npm run cli -- baseline compare --baselineRunId <a> --currentRunId <b> --pretty
npm run cli -- ci regression --runId <runId> --baselineRunId <baselineRunId> --pretty
npm run cli -- doctor readiness --target auto --pretty
npm run cli -- doctor enforcement --target web --phase self_test --runtimeImpact true --runId <runId> --closureClaim true --pretty
npm run cli -- agent contract --target web --driver computer-use --pretty
npm run cli -- ai handoff --runId <runId> --pretty
```

支持命令：

- `relay doctor target`
- `relay doctor detect`
- `relay doctor trigger`
- `relay doctor enforcement`
- `relay doctor readiness`
- `relay harness verify`
- `relay harness report`
- `relay harness evidence`
- `relay harness benchmark`
- `relay project identify`
- `relay project compatibility`
- `relay project verify`
- `relay project advise`
- `relay project memory`
- `relay project history`
- `relay project scenarios`
- `relay project baselines`
- `relay agent contract`
- `relay web verify`
- `relay miniapp run`
- `relay run start`
- `relay run step start`
- `relay run step end`
- `relay run end`
- `relay ai timeline`
- `relay ai diagnosis`
- `relay ai report`
- `relay ai summary`
- `relay ai failure-report`
- `relay ai pr-comment`
- `relay ai closure`
- `relay ai diff`
- `relay ci readiness`
- `relay ci scenario-smoke`
- `relay ci closure`
- `relay ci report`
- `relay ci regression`
- `relay scenario list`
- `relay scenario inspect`
- `relay scenario validate`
- `relay scenario baseline`
- `relay scenario diff`
- `relay baseline capture`
- `relay baseline compare`
- `relay template list`
- `relay template validate`
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

## 四层证据链

运行时能力统一分为四层：

1. `project_structure`
2. `instrumentation_attached`
3. `runtime_events_observed`
4. `user_flow_closed`

只有走到第 4 层，才允许把某个用户流程当作“真的闭环”。

Miniapp 的 project verify 也会优先解析真实工程信号，而不只是假设目录模板固定。它会结合 `project.config.json`、`miniprogramRoot`、主包/分包页面声明、wrapper/patch 痕迹和页面文件解析结果，尽量输出 `partial` 或 `unknown_but_observable`，而不是轻易把真实项目打成 `unsupported`。

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
- `GET /ai/targets/detect?target=...`
- `GET /ai/driver/contract?target=...&driver=...`
- `POST /ai/trigger/decision`
- `POST /ai/task/enforcement`
- `POST /ai/project/identify`
- `GET /ai/project/profile`
- `GET /ai/project/memory`
- `GET /ai/project/history`
- `GET /ai/project/compatibility`
- `GET /ai/runs`
- `GET /ai/web/project-check`
- `GET /ai/miniapp/project-check`
- `GET /ai/run/:runId/timeline`
- `GET /ai/run/:runId/summary`
- `GET /ai/run/:runId/incidents`
- `GET /ai/run/:runId/context`
- `GET /ai/run/:runId/flow`
- `GET /ai/run/:runId/scenario`
- `GET /ai/run/:runId/state-report`
- `GET /ai/run/:runId/baseline`
- `GET /ai/run/:runId/diagnosis`
- `GET /ai/run/:runId/closure`
- `GET /ai/run/:runId/report`
- `GET /ai/run/:runId/integrity`
- `GET /ai/run/:runId/readiness`
- `GET /ai/run/:runId/failure-chain`
- `GET /ai/run/:runId/root-cause-map`
- `GET /ai/run/:runId/repair-strategy`
- `GET /ai/run/:runId/handoff`
- `GET /ai/run/:runId/miniapp-signals`
- `GET /ai/run/:runId/collection`
- `GET /ai/run/:runId/hotspots`
- `GET /ai/run/:runId/repair-brief`
- `GET /ai/run/:runId/artifact`
- `GET /ai/run/:runId/summary-view`
- `GET /ai/run/:runId/failure-report`
- `GET /ai/run/:runId/pr-comment`
- `GET /ai/web/integration-guide`
- `GET /ai/miniapp/integration-guide`
- `GET /ai/autoloop/:id`
- `GET /ai/autoloop/:id/decision`
- `GET /ai/diff?baselineRunId=...&currentRunId=...`
- `GET /ai/diff/scenario?baselineRunId=...&currentRunId=...`
- `GET /ai/diff/state?baselineRunId=...&currentRunId=...`
- `GET /ai/templates`
- `POST /scenarios/validate`

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

## Codex Computer Use Miniapp Driver

`driver-modules/computer-use-miniapp-driver.mjs` is a bridge driver module for Codex Computer Use. It does not click by itself from Node. Codex uses Computer Use to operate WeChat DevTools or the target Miniapp environment, writes the observed action ledger to `DEV_LOG_RELAY_COMPUTER_USE_LEDGER`, and then `miniapp run` imports this module to feed the real action results and evidence into the relay.

Required ledger shape:

```json
{
  "targetProjectRoot": "/abs/path/to/target-project",
  "app": "WeChat DevTools",
  "actions": [
    {
      "actionId": "enter-home",
      "type": "enter_page",
      "pagePath": "/pages/home/index",
      "success": true,
      "reason": "codex_computer_use_observed_home",
      "emittedEvents": [
        { "source": "miniapp", "level": "info", "message": "HomePage.onLoad", "phase": "lifecycle", "route": "/pages/home/index" }
      ]
    }
  ]
}
```

The module fails with `computer_use_ledger_required`, `computer_use_ledger_unreadable`, `computer_use_ledger_empty`, or `computer_use_ledger_target_project_mismatch` when it cannot prove the ledger belongs to the invocation target project. This keeps Computer Use as a real driver bridge, not a built-in demo or closure shortcut.

## Playwright 示例

Playwright 在本仓库里的角色是：

Web 生产闭环只能指向真实目标项目。`loop web` / `autoloop run --target web` 会优先使用 `--url` 或 `DEV_LOG_RELAY_TARGET_URL`，否则尝试在 `DEV_LOG_RELAY_WORKSPACE_ROOT` 解析出的 Web 项目内启动 `dev/start/serve/preview` 脚本并发现 localhost URL。无法定位真实目标 URL 时会返回 `target_project_url_required` 或 `target_project_start_failed`，不会回退到内置 demo。

内置 Web demo 资产只允许作为测试夹具保留，不属于 skill-facing 命令路径。旧的 `loop web --mode baseline|broken|fixed` 会返回 `demo_runner_forbidden`。

## Blackbox Scenario Loop

黑盒测试用于回答“真实用户是否能在目标项目 UI 上完成或观察到目标流程”。它不读取组件内部状态、不调用业务内部 API、不 mock 结果，也不把 console/network/render 事件当作通过依据。

CLI:

```bash
relay harness verify --target web --url http://127.0.0.1:5173 --goal "用户搜索商品" --pretty
relay harness verify --target miniapp --driverModule ./driver.mjs --pretty
relay harness report --harnessRunId <harnessRunId> --pretty
relay harness evidence --harnessRunId <harnessRunId> --ref <artifactRef> --pretty
relay harness benchmark --fixture all --pretty
relay blackbox discover --target web --url http://127.0.0.1:5173 --pretty
relay blackbox plan --target web --url http://127.0.0.1:5173 --goal "用户搜索商品" --pretty
relay blackbox run --target web --url http://127.0.0.1:5173 --driver playwright --pretty
relay blackbox run --target web --driver computer-use --ledger ./blackbox-ledger.json --pretty
relay blackbox report --runId <runId> --pretty
relay blackbox capsule --runId <runId> --pretty
relay blackbox trace --runId <runId> --format summary --pretty
relay blackbox trace --runId <runId> --format playwright --pretty
relay blackbox export --runId <runId> --format playwright --pretty
relay blackbox seed-regression --runId <runId> --pretty
relay benchmark blackbox --fixture all --pretty
relay miniapp driver check --pretty
relay store inspect --runId <runId> --pretty
relay store inspect --harnessRunId <harnessRunId> --pretty
relay store cleanup --olderThanDays 30 --dryRun --pretty
relay store cleanup --olderThanDays 30 --confirm --pretty
```

API:

- `POST /ai/harness/from-blackbox-run`
- `POST /ai/harness/verify`（兼容别名；server 端用于已存 blackbox run 的 harness finalization，本地 driver 编排请使用 `relay harness verify`）
- `GET /ai/harness/:harnessRunId/report`
- `GET /ai/harness/:harnessRunId/evidence?ref=<artifactRef>`
- `POST /ai/blackbox/discover`
- `POST /ai/blackbox/plan`
- `GET /ai/blackbox/plan/:planId`
- `POST /blackbox/run`
- `GET /ai/run/:runId/blackbox-report`
- `GET /ai/run/:runId/evidence-refs`
- `GET /ai/run/:runId/evidence-capsule`
- `GET /ai/run/:runId/evidence-artifact?ref=<artifactRef>`
- `GET /ai/run/:runId/blackbox-trace`
- `POST /ai/run/:runId/blackbox-export`
- `POST /ai/run/:runId/seed-regression`
- `POST /ai/benchmark/blackbox`
- `GET /ai/store/inspect?runId=<runId>`
- `GET /ai/store/inspect?harnessRunId=<harnessRunId>`
- `POST /ai/store/cleanup`

`relay harness verify` 是执行 AI 的默认完工验证入口。它编排真实目标解析、Web 启动/URL 附着、Miniapp bootstrap/verify/driver check、黑盒 plan/run、evidence capsule/trace、失败回归沉淀和 release gate。Server API 的 `/ai/harness/from-blackbox-run` 负责把已经存储的 blackbox report 收口成 harness report；它不会在 server 内替本地执行 AI 点击浏览器或启动目标项目。Harness 报告包含 `HarnessGate`、`harnessRunId`、`evidenceIndexRef`、`artifactManifestRef`、`regressionSeedRef` 和短 `forExecutingAI`；只有 `HarnessGate.status === "pass"` 才能被解释为目标项目验证通过。`harness evidence` 只能读取 harness evidence index 和 artifact manifest 中登记的 ref，不能任意读 runtime store 文件。

Web 默认由 Playwright 访问真实目标 URL，先 discover 可见 UI observe inventory，再采集 `visible_evidence` / `blackbox_assertion`、screenshot 和 accessibility evidence refs。Observe inventory 包含 action candidates、locator candidates、mutation risk flags 和 coverage hints；生成 case 时优先使用 `data-testid`、ARIA role/name、label/placeholder、文本，最后才使用 CSS/nth fallback。若当前环境无法启动 Playwright，`blackbox discover` 会退到真实目标 URL 的轻量 HTML inventory，而不会改用 demo。

每个 Web Playwright blackbox case 会同时写入 Dev Log Relay action trace artifact 和 Playwright trace zip ref，记录 locator、URL before/after、可见文本 before/after、断言结果、截图和 accessibility refs。Trace 只用于审计和诊断，不替代 visible assertion。`blackbox capsule` 返回短摘要、失败分类和关键 refs；`evidence-artifact` 只能读取 runtime store 内的 ref，路径穿越会返回 `evidence_artifact_ref_invalid`。`blackbox export` 默认把通过的 Web case 导出为 Playwright spec artifact；只有显式 `--out <path>` 才写到用户指定位置。失败 case 不会被伪装成可执行成功测试；locator repair 后通过的 case 只能是 `manual_review_required`，release gate 仍保持 hold。

登录态项目可通过 `--storageState <path>` 或 `DEV_LOG_RELAY_WEB_STORAGE_STATE` 提供 Playwright storage state。`--saveAuthProfile <name>` 会把 storage state 存进 runtime store，`--authProfile <name>` / `DEV_LOG_RELAY_AUTH_PROFILE` 可复用；profile 绑定 `targetProject.workspaceRoot + targetUrl origin`，不匹配会返回 `auth_profile_target_mismatch`。`--visual` 会记录截图尺寸、可见元素与空白屏信号；`--a11y` 会记录 accessibility 摘要并标记无可访问名称的关键控件；`--viewport desktop|mobile|both` 控制采集视口。

`blackbox seed-regression` 会从失败 case、runtime failure、locator repair candidate 生成 regression candidate artifact，供后续回归资产化。`benchmark blackbox` 只跑 `runtime/fixtures/targets/` 下的真实 fixture target，用于衡量 discover/run/report 能力，不触达生产 demo runner。

Computer Use 不在 Node 内自动点击；它只通过真实 target-project ledger 回灌。Ledger 必须匹配 `planId`、`planNonce`、`caseNonce`、target project、target URL，并包含 `visibleEvidence` 与 `actionLedger`。Miniapp 仍然必须 verify-first；`devtools-automator` 默认使用内置 `miniprogram-automator` driver，并可被真实 `--driverModule` 覆盖；`computer-use` 需要 ledger，没有真实 action ledger 时不得进入闭环。

`relay harness verify --target miniapp` 默认启用 auto-prepare：创建 Dev Log Relay 专用微信开发者工具 profile、检查/启动 sidecar、固定服务端口、解析内置或外部 driver，并执行可见 UI 黑盒动作。`relay miniapp bootstrap --fix --pretty` 会创建专用 profile，默认写入 runtime artifact home，也可用 `DEV_LOG_RELAY_HOME` 指定全局持久目录，并写入固定服务端口配置，默认端口 `9420`。`relay miniapp doctor --fix --pretty` 会同时执行 bootstrap 与 driver resolver，用于首次配对或环境修复。`relay miniapp driver check --pretty` 用来收敛 Miniapp driver 接入失败原因，包括内置 driver、`driverModule`、`DEV_LOG_RELAY_MINIAPP_DRIVER_MODULE`、微信开发者工具 CLI、服务端口、`miniprogram-automator` 版本、launch/connect 模式、profile isolation 和真实 projectPath。它只是 resolver/诊断入口，不绕过 action ledger、visible evidence 和 runtime event 要求。内置 driver 的 HarnessGate 还会检查 profile isolation；未验证受控 profile 时不得自动 pass。

`relay miniapp sidecar install --start --pretty` 会生成用户级 LaunchAgent 并启动本地 Miniapp sidecar。sidecar 暴露 `127.0.0.1:5078/health`，用于检查受控 profile、服务端口、DevTools CLI 和项目路径，并可通过受控 HOME 拉起微信开发者工具。`relay miniapp bootstrap --driver computer-use --pretty` 会输出 Codex Computer Use 配对计划和 ledger 模板，供执行 AI 在已有 Computer Use 权限时完成首次 UI 配对。sidecar 和 Computer Use pairing 都只属于环境准备层，不进入 release gate，也不能替代 visible blackbox assertion、内置/外部 driver action result 或 Computer Use action ledger。普通 screenshot captured 文案只作为诊断，不计入 visible evidence。无法自动完成的系统/账号边界会统一进入 `forExecutingAI.userActionRequest`，执行 AI 只应转述其中的最少用户步骤并在完成后重试 `retryCommand`。

`DEV_LOG_RELAY_RUNTIME_STORE_DIR` 可覆盖运行时证据存储目录，默认在 artifact 目录下的 `relay-store/`。每个 run / harness run 会写入 `artifact-manifest.json`，登记证据 ref、类型、大小、hash、创建时间和 owner。`relay store inspect` 用于审计这些 refs；`relay store cleanup` 默认只做 dry-run，只有显式 `--confirm` 才会删除 runtime store 内的过期 artifact。`forExecutingAI` 会汇总已验证用户目标、失败 case、用户实际看到的内容、trace refs、export ref、coverage gaps、failure taxonomy、runtime 诊断线索和下一步建议。Release decision 不能只因 trace/export 完整或 runtime 事件充足而 ship；必须至少有阻塞黑盒 case 通过，且没有阻塞 runtime failure。

## AI 使用准则

- 改了运行时代码后，必须先经过 target / trigger gate
- Web 命中测试、复测、报错、回归场景后，默认跑 `relay harness verify --target web`，必要时再用 `project verify` / `autoloop run` 做低层诊断
- 需要站在真实用户视角验证时，优先使用 `relay harness verify`；只有调试或补证据时才下钻到 `relay blackbox plan/run/report`
- Miniapp 命中同类场景后，必须先经过 `relay harness verify --target miniapp`；默认会自动执行 bootstrap、sidecar check/start、内置 driver resolution 和黑盒动作。低层诊断才单独跑 `relay miniapp bootstrap --fix`、`relay miniapp doctor --fix` 或 `relay project verify --target miniapp`
- Web 未通过 `project verify` 或 readiness 不足时，不应进入完整 autoloop
- Miniapp `run` 默认使用内置 `devtools-automator` driver；真实 `--driverModule` 或 `DEV_LOG_RELAY_MINIAPP_DRIVER_MODULE` 可覆盖内置 driver；`external-agent` 只用于 contract 查看
- Codex Computer Use 驱动 Miniapp 时，使用 `--driver computer-use --driverModule driver-modules/computer-use-miniapp-driver.mjs` 并提供 `DEV_LOG_RELAY_COMPUTER_USE_LEDGER`
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
