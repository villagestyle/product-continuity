# Product Continuity Skill / 产品连续性技能

Keep a traceable relationship between human product intent, implementation
behaviour, and validation evidence while implementation changes. The package is
project-agnostic: project-specific product rules belong in that project's state
file, not in this skill.

本技能把三件事分开记录：人明确表达的意图、现有实现能支持的证据、实际验证过的
结果。代码存在本身不等于产品意图已经获得批准。当前数据契约为
`schemaVersion: "0.2"`；静态工具和评审服务显式双读冻结的 0.1 与当前 0.2。

## 中文使用说明

### 边界

- 单人、本地、单项目、前台手动启动。默认只使用项目内的
  `.product-continuity/project-state.json`，具体位置以用户确认为准。
- 代理可以整理候选、提出修改、打开评审页；代理不得冒充真人在页面上点击确认，
  也不得用自己的工具调用代替人的产品决定。
- 静态地图/回执（`render-map.mjs`、`render-check.mjs`）只读：不写状态、不写备份、
  不扫描新项目、不运行产品测试。
- 实时评审服务只写指定的状态文件、其版本化备份和它自己的派生视图
  `product-map.review.html`。它不修改业务实现、测试或产品后端，不扫描仓库，
  不执行产品命令，也不批准合并。
- 0.1 状态可由静态工具和服务只读打开；服务不会自动迁移。迁移是单独的持久化
  操作，需要另行授权。
- MCP 服务默认是本地只读 stdio 进程，只提供 `project_get`、`context_get`、
  `map_query`；每次请求重读状态并返回版本与完整摘要。默认不写状态、不确认决定、
  不运行测试、不接受任意路径或命令，也不是 watcher 或自动语义索引。维护写模式
  默认关闭，必须同时显式传入 `--maintenance-write` 和固定的
  `--maintenance-authorization` 文件；它只允许新增/补注实现、验证、unknown 注解与
  追加关系/证据/检查，并经另行创建的一次性人工授权文件确认，绝不等同于产品决定。
- 规划写入只有离线、显式授权的 `scripts/plan-roadmap.mjs`：默认预览，`--apply`
  单独授权；在线共享写入仍未实现。
- 首次接入允许“部分基线”：未覆盖的内容应标为未知或排除，而不是补全猜测。

### 图谱何时更新

- **手动发起为主**：例如“按上次检查到本次提交的变更更新图谱”，也可在一项任务
  完成后合并检查多次提交，不必每次保存文件都更新。
- **Skill 内的提交/任务收尾检查**：在已有图谱的项目中使用本技能处理已授权工作时，
  到提交准备、提交完成或任务结束的检查点，只评估一次是否需要更新。没有相关的用户
  行为、证据或关系变化就跳过；源码移动可能只需调整证据位置，不产生新产品决定。
- **只更新受影响部分**：复用已有节点与已确认意图，保留旧检查和决定；新增理解仍是
  候选。测试代码变化不等于测试执行通过，提交也不等于确认产品需求。
- **不是自动化监听**：不监听文件、不安装 Git hook、不拦截提交，也不会捕获其它
  工具或会话里的每一次 commit。Skill 规则只有在被使用时执行；漏掉的范围可手动补查。
- **授权与写入边界不变**：允许 commit 不等于允许写项目状态、运行测试或启动服务。
  写入须沿用当前契约并回读核验；服务运行时不能直接改它锁定的 JSON。当前九动作
  不提供通用的源码重扫/证据更新接口，不能安全落地时只列拟议差异并报告“待更新”。
- 收尾只报告一种结果：**无需更新 / 已更新并核验 / 待更新（原因）**，不为无关提交
  强行新增状态版本。**“仅重生成视图”只重画已有状态，不会重新分析代码。**

检查点的详细步骤见 [`references/change-review.md`](references/change-review.md)。

### 功能规划与路线图（0.2）

- **Feature 复用 capability 节点**。`roadmapItems` 只是挂在稳定 capability 上的
  规划投影，不复制第二套功能树；一个 capability 最多一个规划项，关闭项仍占该位置，
  只能按 ID 替换而不是再建一个。
- **规划位置、工作状态、产品意图确认、实现/验证分开记录**。`horizon` 的
  `now` / `next` 不是开发授权、排期承诺或产品批准；`status` 的 `in_progress`
  只表示规划在进行，`closed` 只表示规划关闭，都不等于实现、测试通过或线上观察。
- **验收标准是规划目标**，不是断言、检查结果或测试执行记录。测试定义与执行结果
  仍由 `evidence` / `checks` 表达。
- `dependsOn` 只引用其他规划项，禁止自环、循环和悬空；依赖是规划顺序，不是开发权限。
  `closed` 可能是取消，不自动表示依赖已满足。不强迫填写日期、估算、负责人或完成率。
- 图谱可以只读展示已保存的规划位置并按 horizon 定位；首版没有在线规划编辑。
  时间轴只展示完整快照中当时保存的规划，不补造未来快照或未来位置。规划记录在
  时间模型中明确标为「规划记录，非评审」。
- 规划写入使用离线命令，默认只读预览，`--apply` 必须单独授权：

  ```sh
  node scripts/plan-roadmap.mjs <state.json> <plan.json>
  node scripts/plan-roadmap.mjs <state.json> <plan.json> --apply
  ```

  计划只能完整替换/新增指定 ID 的条目，保留未涉及条目；不能删除条目，取消规划
  用 `closed` + `closedReason`。`capabilities` 只允许新增 candidate capability
  节点，不能新增 claim、decision、review、evidence 或 check。写入沿用合作锁、
  精确版本/摘要、幂等、`commitStateBytes`、原字节备份与完整回读；服务持锁时拒绝。
  它追加 `source: "local_roadmap_planning"` 的 `mapUpdates`，绝不伪造人工 review
  或产品决定。

详见 [`references/roadmap.md`](references/roadmap.md) 与数据契约 §7.2。

### Feature 进度与断点续接（0.2 可选）

- 进度记录是挂在既有 `kind: "capability"` 节点上的可选、追加式
  `featureCheckpoints` 链；不是第四套产品审批、完成率、任务系统或执行授权。
  它记录保存时的工作说明、停点、剩余缺口、建议下一步和依据引用。
- 无记录显示 `尚无续接记录`，不能写成“未开发”；`remaining: []` 是
  “剩余事项未记录”，不是“无剩余”；`nextActionsStatus` 区分已整理、明确无后续、
  尚未整理三态。规划 `closed` 只表示规划关闭，不代表交付或测试通过。
- 读取进度只读保存态：不读源码、不运行测试、不联网、不启动服务。MCP 的
  `project_get` 给出有界 Feature 索引，`context_get` 对每个所选 Feature 返回完整
  上下文与有界依据闭包；超限明确拒绝，不静默截断。0.1 或旧 0.2 缺字段返回可解释
  空态。
- `context.changed` 只表示保存态续接依据有变化，需要复核；`unchanged` 只表示保存态
  相关上下文未变，不代表源码或运行状态已核验。其它 Feature 的更新不会自动让本
  Feature 失效。未保存规划时显示 `规划未记录`，不猜 Now/Next。
- 收尾时最多准备一次草稿，不监听文件、不装 hook、不承诺捕获崩溃。保存是单独的
  离线、显式授权写入；无法保存时报告 `pending`，并说明新会话读不到未保存草案。
- 只读 MCP 不执行 `nextActions`；任何下一步、测试、状态写入、服务停启或分发都需
  各自的授权。已知入口、适用版本和可观察预期可由保存记录支持一次条件性人工体验，
  不因缺少正式确认而全部阻塞；缺失记录属于代理补查，不推给用户对账。

```sh
# 默认只读预览；--apply 是单独授权的状态写入
node scripts/record-feature-checkpoint.mjs <state.json> <checkpoint-plan.json>
node scripts/record-feature-checkpoint.mjs <state.json> <checkpoint-plan.json> --apply
```

完整问答与收尾协议见
[`references/progress-resume.md`](references/progress-resume.md)，字段与校验见
[`references/data-contract.md`](references/data-contract.md#73-feature-progress-checkpoints-non-review)。

### 只读 MCP（本地 stdio）

```sh
node scripts/mcp-server.mjs \
  --project-root <项目根目录> \
  --state <项目根目录>/.product-continuity/project-state.json \
  --project-id <项目 ID>
```

- 三个参数都必填并校验；`--project-id` 必须等于状态中的 `project.id`。服务只走
  stdio，不监听端口，不读取浏览器 Cookie，也不放宽评审服务的保护。
- 工具只有 `project_get`、`context_get`、`map_query`。每次请求重新读取并校验状态，
  返回实际读到的 `stateVersion` 与完整摘要；读取时间不是保存时间。它不是 watcher，
  不做自动语义检索，不静默截断，不跨项目读取。
- `context_get` 用显式 `nodeIds` / `roadmapItemIds`，或用与已有证据路径精确匹配的
  项目相对文件来选择上下文；可带任务描述，但不会因此假装理解了代码。它返回完整
  四字段意图、生命周期/决定、候选、证据（定义与执行分开）、unknown，以及规划的
  「只读、非授权」说明。所选 capability 还会每个返回一条完整 `featureProgress`
  条目（不是只取第一个），包含续接链、依据闭包和授权警告；总数/字节超限明确拒绝。
- 选择范围会确定性扩展祖先、约束来源、实现/验证关联；其他邻居只作引用，不能把
  邻居标题当作完整意图。超出数量/字节上限会明确拒绝，需收窄选择，不静默漏掉意图。
  挂载 MCP 只代表工具可用，不保证代理自动调用或持续理解源码变化。
- MCP 默认没有写入、确认、提议、检查追加、规划编辑、源码修改、命令执行或测试运行
  工具。代理不能把一次 MCP 读取、自己的工具调用、预览摘要或自己写出的授权文件当作
  真人决定；产品决定仍只能在评审页由真人做出。可选的维护写模式见下节。
- 技能不会自动改宿主配置，也不附带凭据或真实自用绝对路径。下面的 OpenCode V2 示例
  只是可复制的配置形状；请替换占位符，并用 `opencode mcp list` 核实连接后再声称已接通。

  ```jsonc
  {
    "$schema": "https://opencode.ai/config.json",
    "mcp": {
      "servers": {
        "product-continuity": {
          "type": "local",
          "command": [
            "node",
            "<解压后的技能目录>/scripts/mcp-server.mjs",
            "--project-root",
            "<项目根目录>",
            "--state",
            "<项目根目录>/.product-continuity/project-state.json",
            "--project-id",
            "<项目 ID>"
          ],
          "cwd": "<项目根目录>"
        }
      }
    }
  }
  ```

  这里使用已核验的 `mcp.servers` + `type: "local"` + `command` 数组形状；V2 不把
  服务器名直接放在 `mcp` 下。详见 [`references/mcp-contract.md`](references/mcp-contract.md)。
  本实现走默认 `legacy` 初始化，支持 `2024-11-05` / `2025-03-26` / `2025-06-18`，
  不要强制选择 `2026-07-28`。配置示例不代表已在真实宿主连接。

#### 可选 MCP 维护写模式（默认关闭）

只在用户明确授权“受限维护回写”时才启用；默认挂载行为完全不变。服务启动必须**同时**
给出写开关和固定授权文件路径（相对项目根，且父目录已存在）：

```sh
node scripts/mcp-server.mjs \
  --project-root <项目根目录> \
  --state <项目根目录>/.product-continuity/project-state.json \
  --project-id <项目 ID> \
  --maintenance-write \
  --maintenance-authorization <项目相对的一次性授权文件>
```

写模式新增两个工具：

- `maintenance_preview`：只读。无锁、无备份、无落盘、不读取授权内容或消费授权。返回基准
  `stateVersion` 与完整原始字节摘要、规范化计划摘要、精确 before/after 差异、
  受保护集合未变化证明和权限边界；不返回整份状态，也不签发 token。
- `maintenance_apply`：必须存在一份未消费的一次性授权文件。授权绑定 projectId、
  operationId、完整计划摘要、预期版本/摘要、批准来源与到期；MCP 工具不能签发或修改
  授权，也不接受任意授权路径。应用在状态锁内重新核验路径、版本、摘要与授权，先认领
  授权再走维护事务（原字节备份、提交、完整回读）。活锁（如评审服务持锁）直接拒绝，
  不停止服务、不删锁；锁失败不消耗授权，可正常关闭服务后重试。

人工确认流程（没有宿主确认 API，这是**本地合作式人审桥接**，不是密码学签名，也不能
防止能写同一文件的恶意本地进程）：

1. 代理调用 `maintenance_preview`，把差异给人看；
2. 人确认后，由宿主 shell/专用 CLI 写一次性授权（不是 MCP 工具）：
   `node scripts/authorize-maintenance.mjs ... --plan <plan.json> ...`。
   `plan.json` 就是 `maintenance_preview`/`maintenance_apply` 的同一份计划对象
   （含 projectId、operationId、expectedStateVersion、expectedDigest、summary、
   changes），不含 `authorizationRef`、`authorized` 等字段；CLI 会先打印差异，默认
   要求输入 `APPROVE` 才写授权；
3. 代理调用 `maintenance_apply`；成功后授权文件被重命名为 consumed 标记，重试必须
   重新授权。`grantId` 必须是 UUID；consumed 标记以原子 link 创建，重复 grantId
   或把原授权字节放回都不会覆盖已有一次性历史，会失败关闭。

权限边界（比离线 `maintain-map.mjs` 更窄）：只新增 implementation/verification/
unknown 注解；既有 implementation/verification 只能改 label/description/evidenceIds
且 status 不变；既有 unknown 只能补 description/evidenceIds，不能关闭、改 label 或
status、丢旧证据；任一 intent-bearing 节点不可改；不能新增 capability；边只允许
`implemented_by` / `verified_by` / `depends_on` 并做端点检查；evidence 只允许
implementation/test_definition/test_execution/runtime_observation；edges/evidence/
checks 只追加；decisions/reviews/claims/proposals/roadmapItems/baselines/project/
migration 一律不可改。工具不执行测试，不把 evidence 自动当成产品确认，授权文件也
不是用户决定记录。详见
[`references/mcp-contract.md`](references/mcp-contract.md#opt-in-maintenance-tools)。

### 环境与安装

- Node.js **>= 22**。本轮主验收目标是本机 Windows NTFS 文件系统；其它平台、
  映射网络盘和同步盘未证明支持，不声称跨平台已支持。
- 完整 Schema 校验、迁移和评审服务需要精确依赖
  `ajv@8.20.0`、`ajv-formats@3.0.1` 与 `package-lock.json`。在**解压后的技能目录内**
  执行：

  ```sh
  npm ci
  ```

  只做本地安装，不安装到全局，不修改 lockfile 中的精确版本。
- 静态工具 `validate-state.mjs`、`render-map.mjs`、`render-check.mjs` 零第三方
  运行时依赖；没有 `node_modules` 也能读取 0.1/0.2。
- 依赖缺失时，服务和迁移应在获取状态锁之前退出，并提示在解压目录运行
  `npm ci`；不残留 `.review.lock`。静态工具不受影响。

### 常用命令

在技能目录内运行：

```sh
# 只读检查引用与 0.2 不变量（JSON Schema 另行校验）
node scripts/validate-state.mjs <project-state.json>

# 渲染只读产品地图 / 单条变更回执
node scripts/render-map.mjs <project-state.json> [output.html] [--language zh-CN|en]
node scripts/render-check.mjs <project-state.json> <check-id> [output.md]

# 显式迁移 0.1 -> 0.2
node scripts/migrate-state.mjs <state-0.1.json> [output-0.2.json]
node scripts/migrate-state.mjs <state-0.1.json> --in-place

# 离线功能规划：默认预览；--apply 是单独授权的写入
node scripts/plan-roadmap.mjs <state.json> <plan.json>
node scripts/plan-roadmap.mjs <state.json> <plan.json> --apply

# 离线续接记录：默认只读预览；--apply 是单独授权的状态写入
node scripts/record-feature-checkpoint.mjs <state.json> <checkpoint-plan.json>
node scripts/record-feature-checkpoint.mjs <state.json> <checkpoint-plan.json> --apply

# 只读 MCP（本地 stdio，通常由宿主启动）
node scripts/mcp-server.mjs --project-root <dir> --state <state.json> --project-id <id>

# 可选 MCP 维护写模式（默认关闭；两个参数必须同时给出）
node scripts/mcp-server.mjs --project-root <dir> --state <state.json> --project-id <id> \
  --maintenance-write --maintenance-authorization <grant.json>

# 人审后写一次性维护授权（不是 MCP 工具；默认交互确认，--yes 供非交互宿主）
node scripts/authorize-maintenance.mjs --project-root <dir> --state <state.json> \
  --project-id <id> --authorization <grant.json> --plan <plan.json> \
  --approved-by "<human label>" --expires-at <ISO date-time>

# 本地实时评审服务
node scripts/review-service.mjs <state.json> [--port 8768] [--max-state-bytes N] [--conversation-authorization <file>]

# 项目首次启用会话采集：创建长期候选/备注授权，不覆盖已有文件
node scripts/authorize-conversation.mjs <project-root> <state.json> <http://127.0.0.1:port> [output.json]

# 构建可分发归档（默认 dist/product-continuity.skill）
node scripts/build-dist.mjs [--output <file>] [--manifest <file>] [--check] [--force]
```

迁移默认写 `<input>.v0.2.json`；目标已存在就拒绝，没有含义含糊的 `--force`。
`--in-place` 必须显式指定，并且需要已核验的原字节备份。0.2 输入只返回“无需迁移”，
不会生成第二份 claim 或增加版本；未知版本拒绝。**评审服务从不自动迁移**；遇到
0.1 状态时仅展示只读摘要和显式迁移提示，不加载 0.2 评审表单；须先关闭服务，再经
单独授权执行迁移。需要查看完整旧版关系时，可使用只读静态地图。

### 画布操作与全屏

- 从空白或节点文字按住拖动可平移；移动达到 5 CSS px 才起拖，轻点仍查看节点。
- 图谱右上角的 **全屏** 按钮放大当前工作区；静态地图保留节点详情，实时评审页保留
  右侧非模态评审面板，暂时隐藏下方目录。点 **退出全屏** 或按 **Esc** 返回。
- 优先使用浏览器 Fullscreen API；嵌入页、权限策略或浏览器不支持时，退回铺满当前窗口，
  状态提示会说明区别。这不是浏览器 F11，也不会自动申请无手势全屏权限。
- 进入和退出不重置当前缩放、平移、选中节点或折叠；全屏期间的后续导航继续保留。
  不重建评审表单或丢弃未保存草稿，不写产品状态。Esc 退出全屏时不会顺带关闭评审面板。
- 工具栏、方向键、缩放、小地图和文本列表仍有原来的作用；静态文本列表在脚本禁用或
  Canvas 不可用时继续作为后备。已有生成的静态页需重新渲染，运行中的服务需重启才能
  加载新页面代码；单纯刷新旧静态文件不会升级交互。

### 图谱时间回溯与记录（0.2 实时评审页）

- **图谱时间轴常驻画布底部**。拖动、点按刻度，或用方向键、Home / End，画布即
  切换到对应完整快照的树：节点、关系、名称、意图及状态均来自该版本，不只是筛选事件。
  也可点击 **上一版 / 下一版**；**回到现在** 恢复当前树、进入历史前的视角／折叠，
  以及原来的评审编辑器与未保存草稿。切换不改 URL，不提交评审，不把旧快照写回主状态。
- 时间轴逐个选择可核验的版本，并非连续时间插值：刻度按版本顺序等距排列，旁边显示
  对应 review／授权维护／规划记录时间，维护和规划明确标「非评审」。未知保存时间、当前读取时间和版本缺口分别标注；缺失树不补造。
  尚无历史时只有「现在」，滑块禁用；不会为了演示往真实状态添加假版本。
- 历史模式只读：右侧显示所选版本的节点、四字段意图、关系与材料，不提供确认／保存。
  当前意图目录、记录／进度面板和原编辑器暂时隐藏但不销毁，避免混用当前操作与历史数据。
  回到现在后原样恢复。历史读取中或失败时画布不显示旧的其它树冒充；快速拖动会取消前一
  次读取，迟到响应不能覆盖新选择。全屏内同样可回溯，并保留平移、缩放、折叠与小地图。
- **版本差异** 默认比较所选版本与前一个可核验版本；最早版本与后一个比较。方向始终为
  **较早版 → 较晚版**，不随前进／后退颠倒。缺口只展示两端净变化，不补造中间过程。
  时间轴下方常驻摘要；卡片以文字、边框和颜色标注新增／修改，变化关系以线型和文字区分。
  不在所选快照中的卡片以明确标注的**对比叠影**显示，不计入所选版本真实节点数。
- 点击有变化的卡片或摘要，在右侧只读区域查看完整变更清单和逐字段前后值；支持搜索、
  类型筛选、每页 20 项、**上一处／下一处**、相关卡片定位及**查看所选版本卡片**。
  折叠分支显示含变化卡片数，定位会展开路径；**仅看变化**保留必要关联上下文。
  关闭**图上标注**会去掉徽标、差异线和叠影，恢复所选完整快照的图形。
  意图正文、状态、说明、证据链接、关系、规划和续接分别展示；证据增加不表示意图确认
  或完成，停止／替代不是删除，折叠、筛选和本地布局移动也不算内容删除。
  对比不覆盖评审草稿、不提交写请求；端点不可核验时清除差异，不展示旧结果冒充。

- 画布标题栏的 **时间线** 按钮另外展开图谱内部的记录／进度底部面板，不是回溯开关。
  默认折叠，和画布共享固定工作区高度；展开不改变画布缩放、位置、选择或折叠，面板
  内部滚动，最多占工作区 36%，不遮挡工具栏、平移或小地图。全屏内也可用，草稿始终保留。
  **记录排查 / 整体进度** 分页签显示，搜索、筛选和刷新共用紧凑工具栏；更多筛选默认
  收起。页签支持左右方向键、Home / End，切换不会清除筛选或已选记录。
- **整体进度** 内的三项指标分别展示 **现行意图确认**、**任务实现关联**、
  **任务有通过／观察记录**，
  不合并成“项目已完成百分比”。意图分母是候选 + 已确认，任务分母是未停止的用户任务；
  范围变化会改变分母，停止／替代历史单独保留。
- 实现关联沿任务的 `contains` / `enables` 子图查找 `implemented_by`；验证沿同一子图的
  `verified_by` 查找验证节点或关系上的证据。只有 `test_execution: passed` 或
  `runtime_observation: observed` 才计入第三项；测试定义不算通过，失败记录另列。
  这些只是已关联材料清单，不承诺证据适用于当前代码版本；通过与失败可以同时存在。
- 记录区支持 UTC 日期、类型、关联节点、文字或 ID 筛选，顺序切换和每页 30 条。
  选择事件只读显示原始记录及时间来源；点击关联位置才导航到意图、提案或节点，
  此记录面板仅在「现在」可见，关联入口只评审当前状态。筛选不改变整体进度分母。
- 进度历史只读检查同一状态的已完成备份：必须由当前 review 或非评审 `mapUpdates` 的精确
  `observedDigest` / 版本锚定、完整校验通过且两类记录前缀一致。不用事件倒推旧图，
  不读取 `.pending` / `.failed`，不扫描源码、不运行测试、不监听文件。
- 时间来自记录字段；历史版本没有对应 review／维护／规划时间就标为 **保存时间未知**。
  无对应记录的当前版本标 **本次读取，非保存时间**，不拿文件修改时间、基线时间或
  证据时间代替。至少四个不同且不倒退的可信记录时间点才绘趋势；缺版本不连线，
  其余情况保留逐版本表格。没有历史时只显示真实起点。
- 每次最多读取 4096 个目录项、检查最近 64 个备份、读取约 32 MiB 备份字节；每个文件
  还受服务的状态大小上限约束。达到上限或历史不可核验会提示，不补算遗漏部分。
   原始备份路径不进入 HTTP 响应；受保护的 `GET /api/state` 携带指标投影，
   `GET /api/snapshot?version=<整数>&digest=<完整 SHA-256>` 按精确身份重新核验并返回一份
   只读完整快照，不接受路径、额外参数或模糊版本；没有新增写动作或持久化文件。
- **刷新记录** 只读当前已保存材料，保留右侧编辑器与草稿；并非源码分析或图谱同步。
  关联定位会先暂存当前标签草稿；不自动确认意图。现有静态地图及 0.1 只读摘要不含本时间线，
  运行中的评审服务仍需经授权重启才能加载本轮代码。

### 离线局部图谱维护（非人工评审）

`node scripts/maintain-map.mjs <state.json> <plan.json>` 只读预览；仅在获得本次写入
授权后加 `--apply`。使用精确预期版本／完整摘要，复用合作锁、原字节备份与核验保存，
追加 `mapUpdates` 而不是伪造人工 review。运行中的服务持锁会被拒绝，应另获授权正常
停服并检查未保存草稿；不能绕锁改 JSON。维护只覆盖限定节点注解、追加关系／证据／检查，
不改候选四字段、确认、决定、提案和旧证据，不重扫源码、不运行测试、不监听、不重发包。
计划形状、重试及历史锚定见 [数据契约 §7.1](references/data-contract.md#71-offline-map-maintenance-non-review)。

### 实时评审服务

- 默认监听 `http://127.0.0.1:8768`，只绑定回环地址。`--port 0` 仅用于测试。
- 默认状态上限 10 MiB（`--max-state-bytes N` 可显式调整）；单个请求体上限
  64 KiB；进程内评审队列最多 16 个。
- 服务会校验精确 Host、Origin、会话 Cookie 和 `X-Review-Action`，页面使用带
  nonce 的 CSP。Cookie 不是身份认证、端口隔离或授权证明；不要把它当作安全边界。
- 每次成功动作追加一条 review，并按动作创建零个或一个决定/提案，同时让
  `stateVersion + 1`：`edit_candidate`、`split_candidate`、`discard_candidate`、
  `defer` 等不创建决定，确认/接受/停止等才创建决定，提案动作另按契约处理。
  提交分阶段报告 `commitStatus`（`not_committed`、`verified`、
  `replaced_unverified`、`unknown`），派生视图失败时为 `saved_view_pending`。
  不会自动回滚、不会删除状态文件强行成功，也不承诺跨手工恢复的 exactly-once。
- review 的 `payloadDigest` 对完整 `normalizeCommand` 计算：包含所有最终为 `true`
  的 attestation（含嵌套 `legacyResolution.fullRestatementAttested`）和
  `previewDigest`，只排除 `expectedStateVersion`、`expectedDigest`、
  `idempotencyKey`、Cookie 与 HTTP 头；command 不含 `payloadDigest` 自身，因此
  无自引用。`previewDigest` 仍排除自身和最终勾选布尔值。
- 派生视图固定为状态目录下的 `product-map.review.html`，开头有由规范状态路径
  生成的 ownership marker。服务只替换属于同一状态身份的视图；拒绝覆盖无 marker、
  他人状态、符号链接、硬链接、目录或任意未知现有文件，也不会自动清理它们。
  不同状态文件同目录时不会互相覆盖视图。启动诊断会按精确名称报告本状态自己的
  `.pending`/`.failed` 残留，但不把它们当作事实源或自动清理。
- 0.1 状态以只读方式打开时仍持有状态锁，直到服务关闭；因此不能同时迁移或替换该
  状态文件。迁移必须显式执行并另行授权。
- 备份、临时文件和锁用于本机保存／恢复；时间线仅只读核验已完成备份的进度投影。
  锁 token 和备份路径不会写入公共 HTTP
  响应或普通日志。
- 不要把状态放在同步盘、网络卷或映射网络盘上；UNC/设备路径和硬链接事实源会被
  拒绝。Windows 继承 ACL，不能声称 POSIX `0600` 在 Windows 上提供同等保密性。

运行、安全、恢复和 UI 的完整契约见
[`references/review-service.md`](references/review-service.md)。

### 会话采集（P0）

安装 OpenCode 插件并首次为项目创建授权后，模型可显式调用
`conversation_sources` 读取当前真实消息，再用 `conversation_capture` 保存相关候选或备注。
每次采集无需逐条审批；普通聊天不会自动落库。宿主核对当前项目、消息 ID、角色和原文片段，
分别标记用户陈述、助手建议、助手报告。助手报告只能作为备注，不能形成测试通过记录。
冲突候选与已确认意图并存；确认或替换决定仍由真人在评审页操作。

V2 原生入口为 `integrations/opencode-v2`，另提供旧版
`integrations/opencode-plugin.ts`。分发文件存在不代表宿主已安装或启用。完整项目级安装、
授权、撤销、请求示例和来源限制见
[`references/conversation-capture.md`](references/conversation-capture.md)。

### 授权清单

以下操作必须分别获得用户授权，不能用“已经读过项目”或“已经生成地图”代替：

1. 读取真实项目的材料（包括启动只读 MCP 读取真实状态）；
2. 写入或更新真实项目状态（包括 `plan-roadmap.mjs --apply` 的规划写入，以及 MCP
   `maintenance_apply` 所需的另行人工一次性授权）；
3. 对真实项目执行迁移（副本或 `--in-place`）；
4. 由真人在评审页做出产品决定；
5. 运行产品应用、测试、后端或任何会改变产品环境的命令；
6. 发布/替换 `dist/` 中的分发产物；
7. 把 MCP 配置写入宿主或让宿主自动连接（技能不会代做，也不附带真实路径/凭据）。

会话采集的首次项目授权只允许之后显式工具调用追加候选/备注；它不替代上述产品决定、
迁移、测试、发布或宿主安装授权。授权文件是本机凭据，不进入分发归档。

首次接入可以先给出不完整但诚实的候选基线；未检查或未执行的内容必须标明。

### 分发与自检

打包使用显式清单 `scripts/dist-files.json`，不按整目录 glob。归档根为
`product-continuity/`，邻接 manifest 逐文件记录 `path`、`size`、`sha256`；manifest
不摘要自身。脚本逐文件校验归档字节，拒绝绝对路径、`..`、反斜杠、大小写重复和
符号链接。它不承诺 ZIP 容器与其它工具逐字节一致。

```sh
# 在解压目录中做干净分发测试（不联网、不 npm ci）
node --test tests/distribution.test.mjs

# 可选：显式开启网络安装 + 完整测试 + 临时状态确认
# PowerShell:
$env:PC_DIST_FULL='1'; node --test tests/distribution.test.mjs
# POSIX:
PC_DIST_FULL=1 node --test tests/distribution.test.mjs
# 直接运行测试文件时也可传 --full：
node tests/distribution.test.mjs --full
```

普通测试不会执行 `npm ci`，也不会递归运行 `npm test`。完整模式在临时解压目录内
本地安装依赖，先对两个完整示例做 Schema/引用硬校验，再以显式文件列表运行非递归
测试，并运行 host HTTP acceptance（真实本地服务、临时状态、动作、备份与恢复检查）。
它只写自己的精确临时目录，不修改本仓库的 `dist/`。

## English quick reference

- Current write contract: `schemaVersion: "0.2"`. Readers explicitly dispatch
  between frozen 0.1 and current 0.2; unknown versions are rejected.
- Node.js >= 22. Primary tested target: local Windows NTFS. Other platforms,
  mapped network drives and sync folders are not claimed as supported.
- Install exact dependencies locally with `npm ci` inside the unpacked skill
  directory. Do not install globally and do not change the lockfile.
- Static tools (`validate-state.mjs`, `render-map.mjs`, `render-check.mjs`) need
  no third-party runtime dependency and work without `node_modules`.
- Service:
  `node scripts/review-service.mjs <state.json> [--port 8768] [--max-state-bytes N]`.
  It binds `127.0.0.1` only. The service writes the fixed authorized state, its
  backups and its own `product-map.review.html`; it never edits product source,
  tests or the product backend. It never migrates automatically.
- A review's `payloadDigest` covers the complete normalized command, including
  every final `true` attestation and `previewDigest`; only
  `expectedStateVersion`, `expectedDigest`, `idempotencyKey`, Cookie and HTTP
  headers are excluded. `previewDigest` still excludes its own value and final
  checkbox booleans, so neither digest self-references.
- The derived view has a state-path ownership marker. The service refuses to
  overwrite an unowned/unknown file, another state's view, a symlink, hardlink
  or directory, and does not auto-clean leftover `.pending`/`.failed` files.
  A 0.1 state shows a read-only summary and explicit migration notice, not the
  0.2 review forms. It still holds the state lock until close; stop the service
  before a separately authorized migration. Use the static map for full legacy
  relationship browsing.
- Migration:
  `node scripts/migrate-state.mjs <0.1-state> [output]` writes
  `<input>.v0.2.json` by default, refuses an existing target, and supports
  `--in-place` only explicitly.
- Authorization is separate for real-project reading, writing, migration,
  human product decisions, product/test execution and distribution publication.
  A first onboarding may be a partial baseline.
- Features reuse `kind: "capability"` nodes. The optional 0.2 `roadmapItems`
  collection is a planning projection, not a second feature tree, product
  decision or test result. `now`/`next` is not development permission;
  `in_progress` is not implementation; `closed` is not a passed test. Planning
  writes are offline and explicitly authorized with
  `node scripts/plan-roadmap.mjs <state> <plan>` (preview by default; `--apply`
  separate). The command preserves untouched items, cannot delete, closes via
  `closed` + reason, records `local_roadmap_planning` (non-review) and refuses a
  live service lock.
- Progress checkpoints are optional append-only `featureCheckpoints` on existing
  capability nodes. They record saved work, a stop point, remaining gaps and
  suggested next actions; they are not reviews, completion percentages or
  execution permission. Read them only from saved state: no source scan, test
  run, network or service start. `project_get` gives a bounded Feature index;
  `context_get` returns a complete context per selected capability and an
  explicitly bounded basis closure. A changed fingerprint means re-check the
  saved basis, not a regression; unchanged means only that the saved context did
  not change. Saving is a separate offline, explicitly authorized write via
  `node scripts/record-feature-checkpoint.mjs <state> <plan>` (`--apply`
  separate). If it cannot be saved, report pending; another session cannot read
  the draft.
- The MCP server is implemented as a local stdio process. Its default mode is
  read-only: `node scripts/mcp-server.mjs --project-root <dir> --state <state> --project-id <id>`
  exposes only `project_get`, `context_get` and `map_query`; every request
  re-reads and fully validates the state and returns the actual version and full
  digest. It is not a watcher or semantic index, accepts no arbitrary paths or
  commands, and has no write/confirm/propose/planning/test tool in that mode. A
  read is not a human decision; the review UI stays the decision surface. When
  capability nodes are selected, `context_get` returns one complete
  `featureProgress` item per selected capability (not just the first), with the
  saved checkpoint chain and bounded basis records; over-limit requests fail
  explicitly rather than truncating a chain.
- Maintenance write tools are opt-in only: the server must be started with both
  `--maintenance-write` and a fixed project-contained
  `--maintenance-authorization` file. `maintenance_preview` is read-only and
  returns an exact bounded diff; `maintenance_apply` requires an unconsumed
  one-time grant created out of band by a human after reviewing that diff. The
  narrow policy allows only implementation/verification/unknown annotations and
  append-only edges/evidence/checks; it never edits intent, claims, decisions,
  reviews, proposals, roadmap items, baselines or project identity. The grant is
  a cooperative local human-review bridge, not a cryptographic signature or a
  decision record. A future online shared writer is not implemented.
- The copyable host example uses the verified OpenCode V2 `mcp.servers` shape,
  `type: "local"` and a `command` array. It contains placeholders, not real
  paths or credentials. The skill does not edit host configuration; verify the
  connection in the host before claiming it is connected.
- Map maintenance is manual or assessed once at a commit/task checkpoint while
  the skill is in use for a project with an existing map. Skip irrelevant changes
  and update only affected behavior/evidence links; no watcher, hook or commit
  gate is installed. Commit authorization does not authorize state writes or
  tests, and the nine review actions are not a general source/evidence updater.
- The graph header's **Fullscreen** button expands the existing workspace, including
  the static inspector or live non-modal review panel. **Exit fullscreen** / **Esc**
  returns without resetting pan, zoom, selection, folding or the current editor.
  Fullscreen API denial/absence uses a reversible window-fill fallback. This is a
  view-only action; regenerate existing static pages or restart a running service
  to load new interaction code.
- The live 0.2 page has an always-visible **graph time axis**: dragging, clicking or
  keyboard-stepping selects a verified whole-state snapshot and replaces the tree,
  including its nodes, relationships, names and intent status. History is read-only;
  returning **Now** restores the current tree, prior view/folding and exact editor
  draft. Unknown save times and missing versions are explicit, not interpolated or
  reconstructed from current records. The axis is version-ordered, not time-scaled.
  Current-only state disables historical scrubbing. Current directories and event/
  progress controls are hidden during historical inspection, not rebuilt or mixed
  with the old tree. Snapshot reads use the guarded exact-version/digest GET endpoint;
  no state restoration, review write, watcher or persistence is introduced.
- The live 0.2 page's **Timeline** button opens a read-only bottom dock inside the
  bounded graph workspace, without page scrolling, canvas overlays or view resets.
  Event and progress tabs share the same dock; Left/Right and Home/End switch tabs
  without clearing filters, selection or the current review draft. The dock has
  separate intent-confirmation, task-implementation-link and passed/observed-record counters.
  Filters and history selection never confirm intent or replace the editor. Historical
  counters use only fully validated, digest-anchored backups with matching review
  and non-review update prefixes; unknown save times stay unknown. A current version
  without a producing review/maintenance/planning record uses its read time,
  explicitly not a save time. Trends require four distinct trusted record times,
  never bridge missing versions, and are suppressed on clock regression. The bounded
  history inspection is not source synchronization, a watcher or state replay.
- Packaging uses the explicit `scripts/dist-files.json` list and an adjacent
  per-file manifest. The archive has root `product-continuity/`. A clean
  `npm ci` / full-test run is opt-in (`PC_DIST_FULL=1`) and never part of the
  ordinary test command.

## Package contents

- `SKILL.md` - agent workflow, evidence discipline and runtime boundaries.
- `references/onboarding-protocol.md` - first-use discovery and candidate map.
- `references/change-review.md` - diff-to-product-behaviour findings.
- `references/data-contract.md` - 0.1/0.2 records, claims, decisions,
  proposals, reviews, actions, digests and migration.
- `references/review-service.md` - local service runtime, security, commit and
  recovery contract.
- `references/roadmap.md` - Feature planning projection, horizons/status,
  non-authorization rules and the offline planning command.
- `references/progress-resume.md` - project/Feature progress questions,
  resumption, checkpoint closeout, pending handoff and status language.
- `references/mcp-contract.md` - implemented read-only-by-default stdio MCP
  boundary, opt-in one-time maintenance write flow, tools, freshness,
  human-review separation and host configuration examples.
- `schemas/project-state.schema.json` - 0.1/0.2 dispatch.
- `schemas/project-state-0.1.schema.json` - frozen old contract.
- `schemas/project-state-0.2.schema.json` - current complete contract.
- `schemas/review-command.schema.json` - strict nine-action/preview requests.
- `examples/minimal-project-state.json` - valid empty 0.1 skeleton.
- `examples/demo-project-state.json` - illustrative 0.1 state used by tests.
- `examples/demo-project-state-0.2.json` - illustrative 0.2 state with legacy
  and current records. All examples are fabricated fixtures.
- `examples/roadmap-project-state-0.2.json` - Example 0.2 planning fixture
  with capabilities and roadmap items at different horizons/statuses. It is not
  a real product roadmap or decision record.
- `examples/feature-progress-state-0.2.json` - Synthetic 0.2 state with a
  candidate capability, planning item, implementation, test definition, unknown
  and a saved progress checkpoint. It is not a real project fact or approval.
- `examples/feature-checkpoint-plan.json` - Synthetic checkpoint plan for
  preview/apply tests; not a real authorization.
- `scripts/feature-progress.mjs` - pure Feature progress validation, selection,
  fingerprint and derivation model; no IO, clock or network.
- `scripts/record-feature-checkpoint.mjs` - offline preview/apply writer for
  append-only progress checkpoints, using the shared cooperative store.
- `scripts/validate-state.mjs` - dependency-free cross-reference/invariant
  checker for 0.1 and 0.2.
- `scripts/validate-schema-runner.mjs` - AJV 2020 validation entry point.
- `scripts/render-map.mjs`, `scripts/graph-layout.mjs`,
  `scripts/graph-view.mjs` - static offline map and Canvas/text view.
- `scripts/render-review.mjs`, `scripts/review-ui.mjs` - live review page and
  interaction helpers.
- `scripts/render-check.mjs` - saved change receipt renderer.
- `scripts/intent-model.mjs` - shared claim digests, derivation, applicability
  and invariants.
- `scripts/review-actions.mjs` - pure preview/apply action model.
- `scripts/state-store.mjs` - canonical path, cooperative lock, backups,
  staged replacement and commit status.
- `scripts/timeline-model.mjs`, `scripts/timeline-history.mjs`,
  `scripts/timeline-ui.mjs` - read-only event/progress projections, bounded backup
  verification, and the live page's timeline disclosure.
- `scripts/snapshot-diff.mjs`, `scripts/version-diff-ui.mjs` - stable-ID saved-state
  comparison and linked read-only graph/list/field-diff controls.
- `scripts/migrate-state.mjs` - explicit migration CLI.
- `scripts/review-service.mjs` - single local HTTP entry point.
- `scripts/build-dist.mjs`, `scripts/dist-files.json` - auditable packaging.
- `tests/*.test.mjs`, `tests/acceptance-*.mjs`, `tests/browser-*.mjs`,
  `tests/fixtures/` - contract, action, storage, HTTP, renderer, browser,
  host acceptance and distribution checks.
- `evals/evals.json` - original cross-domain qualitative evaluation scenarios.
  They remain in the workspace but are excluded from the distribution package.

The static tools (`validate-state.mjs`, `render-map.mjs`, `render-check.mjs`) are
dependency-free. The full `tests/*.test.mjs` suite is not: it needs the local
`npm ci` dependencies (AJV and ajv-formats). Run `npm ci` before the suite, or
use the explicit distribution test above for the clean-extraction checks. Use
`node scripts/validate-state.mjs <state>` for references; it complements, but
does not replace, JSON Schema validation.

## Current maturity

This is a local 0.2 workflow: claim-level actions, the cooperative state store,
static 0.1/0.2 readers and the local review service/UI are implemented for
single-user local use. Feature progress checkpoints are an optional append-only
saved summary with an offline writer and read-only MCP consumption; they are not
a review, completion metric or execution authorization. Apart from the
documented local stdio MCP boundary (read-only by default, with an opt-in
cooperative maintenance write), it has no watcher, background daemon, database,
cloud sync, multi-user sign-off, merge gate, automatic rollback or claim of
cross-platform filesystem support. The original cross-domain eval
scenarios are kept as qualitative prompts; they are not a claim that the full
acceptance matrix or product-specific tests passed. The distribution and
full-mode checks in this repository cover packaging, a host HTTP acceptance
subset and explicitly listed tests only. A separate final QA report is required
before release claims are made.
