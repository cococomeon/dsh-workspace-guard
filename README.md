# dsh-workspace-guard

DSH 工作区守卫插件：判断工作区**是否被占用 / 是否干净**，为任务**分配**一个空闲且干净的工作区，并在任务开始前**校验**被指派的工作区（不干净或被占用就拒绝），同时记录「工作区 ↔ 会话」关联。

这是 DSH 插件，不是 AFA/CMC 任务。

## 能力

| 需求 | 实现 |
| --- | --- |
| 占用判定 | 复用平台原生的 `workspace/session-activity` waterfall（`turn` / `job` / `subagent` / `schedule` 四个 provider 已在维护），不另起一套活动探测 |
| 干净判定 | 只读 `git -C <path> status --porcelain`；**绝不**执行 `checkout` / `reset` / `clean` / `stash` |
| 工作区分配 | 候选池 = 目录存在 + 未占用 + 已知干净，按最久未变更优先排序；池空则拒绝并逐个列出失败判据，绝不静默降级 |
| 指派校验 + 关联记录 | `assert` 拒绝时点名「哪条判据失败、占用者是谁、哪些文件没提交」；「工作区 ↔ 会话」关系由 `ctx.workspaceRegistry` 自己存储（`attachSession` 会校验会话 header 的 canonical cwd），插件只另存自己的增量（分配租约） |

## 面向模型的工具

| 工具 | 作用 |
| --- | --- |
| `workspace_guard_list` | 列出全部工作区及四类判据：路径、目录状态、占用（及占用者）、干净度（及脏在哪） |
| `workspace_guard_register` | 把一个已存在目录登记为工作区（按 canonical path 幂等），使分配可用 |
| `workspace_guard_check` | 判定单个工作区，接受 workspace id 或目录路径 |
| `workspace_guard_assign` | 挑选并记录分配（租约） |
| `workspace_guard_assert` | 任务运行前的准入校验，失败即拒绝 |
| `workspace_guard_link` | 建立 / 解除 / 读取「工作区 ↔ 会话」关联（双向） |

前四个是判定与分配，第五个是准入，第六个是关联记录。

## 安装

```sh
mkdir -p ~/Documents/deepseek-harness/default-workspace
cd ~/Documents/deepseek-harness/default-workspace
git clone https://github.com/cococomeon/dsh-workspace-guard.git

cd ~/.dsh/profiles/web
dsh plugin --profile web add link:~/Documents/deepseek-harness/default-workspace/dsh-workspace-guard
```

`package.json` 里的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，由它把插件行插进 profile roster。仓库**已提交 `lib/`**，克隆后无需构建即可 `link:`。

**重启 DSH 才会加载新代码**：Node 的 ESM 模块缓存按 URL 生效，改完 `lib/index.js` 后运行中的 Host 不会热加载（`dsh plugin remove` + `add` 重挂行也不行，模块已被缓存）。

## 可配置项

全部 `.volatile()`，可在设置页热改、下一次判定即生效。

| 配置项 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `announceToAgent` | `true` | 是否在 system prompt 里宣告本插件 |
| `selfOwnership` | `true` | 请求者**自己**的活动算可继续（不算冲突）。关掉则任务重跑会被自己的残留 turn 挡住 |
| `requireGitRepo` | `false` | 非 git 目录是否算「不干净」 |
| `refuseOnProbeError` | `true` | git 探针失败是否 fail-closed（算不干净） |
| `gitDirtyImpliesBusy` | `false` | 未提交改动是否**同时**计入「被占用」 |
| `onBlocked` | `refuse` | `assert` 失败时拒绝还是只告警放行 |
| `leaseTtlMinutes` | `120` | 分配租约寿命；过期租约不再生效，崩溃的持有者不会永久占住工作区 |

## 架构

```
src/core/verdict.ts   纯函数判定核心：占用 / 干净 / 分配选择 / 准入。无 IO，全量单测覆盖
src/core/spec.ts      storage domain 声明（leases 表）
src/host/probe.ts     IO 边界：git 探针、activity waterfall、registry 读取、租约读写
src/host/tools.ts     六个 defineTool 工具
src/index.ts          inject / Config / apply + Host 实现
```

判定逻辑与 IO 分离，是为了让四项判定都能脱离真实环境单测。

## 验证

```sh
node --test test/*.test.mjs        # 26 个纯函数单测
node test/run-integration.mjs      # 45 项真实栈集成校验
node build.mjs                     # 打包 + 真实装载自检
```

集成校验挂的是**真实**依赖栈：真实 cordis `Context` + `dsh-storage` + `dsh-storage-json` + `dsh-storage-domain` + `dsh-session-persistence-jsonl` + `dsh-workspace`，跑在临时 `DSH_HOME` 上，插件是真实 `src/index.ts`，git 探针打的是真实仓库。两处替身在文件头写明（`tools` 捕获式 registry；activity provider 按平台契约由 harness 注册，因 shipped provider 属于本 harness 未挂的四个服务）。

## 边界

- 只读探测工作区：**从不修改**工作区内容或 git 状态。
- 「工作区 ↔ 会话」关系不在此插件自建第二份真相，复用 `workspaceRegistry`。
- 本插件不改 `dsh-task-board`：任务运行时的准入由 `workspace_guard_assert` 提供，供调用方在 `task_board_run` 之前显式调用。

## License

MIT
