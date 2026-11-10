# dsh-lean-ops

给 **本地小模型（Qwen3.5-9B @ 8GB）** 用的 dsh 插件骨架，只做三件事，目的都是把
"一次工具调用"压进输出预算、把"一次性大结果"挪出上下文窗口。

不隐藏官方工具、不装原生二进制、不依赖 `dsh-client-ui-primitives`（桌面宿主没有这个包）。

## 三条机制与它们的实测依据

| # | 机制 | 治什么 | 实测依据 |
| :--- | :--- | :--- | :--- |
| 1 | `edit_many`：一次调用对同一文件做 1-20 处小改，整批原子生效 | 输出截断死循环 | 官方 `write` 与 `edit_many` 同时在场时，模型 **3/3 选了 `edit_many`**，5 条 `oldText` 全部唯一命中真实文件；参数 349 字符 vs 整文件重写 2,700+ |
| 2 | 大结果外移：超过 token 阈值的结果落盘，上下文里只留头尾预览 + `ref://` | 65K 窗口被一条结果吃穿 | 工具结果占会话可见负载 **85.5% / 89.7%**；实机一条 `read` = **18,195 token**（引擎 `usage.prompt_tokens` 差值），外移后只剩 **1,490**（−91.8%），整轮稳在 26.7K 而没越过 40,960 的压缩触发点 |
| 3 | `result_read`：按 `ref` + `offset` 分页读回全文 | 让 #2 可恢复，而不是破坏性截断 | 给 `read` 加默认 200 行后，模型 **3/3 主动 `offset=201` 翻页**并答出只存在于第 254 行的内容 |

对照组同样重要：**提示词规则管不住这个 9B**——写进 AGENTS.md 的"单次 write 不超过 600 行"
被当场无视（照样一次发出 993 行的调用）。所以这里全部靠**工具形态**，不靠纪律。

## 宿主 API（已在桌面宿主 0.2.2-rc.1 上核实）

结构照抄宿主自带的 `@deepseek-ai/dsh-compaction-tool-result-pruner`：

- `ctx.tools.register({ name, description, parameters, execute })`，包在 `ctx.effect(() => ...)` 里
- `ctx.on('agent/created', ({ agent }) => ...)`、`agent.ctx.on('tools/result', (exec, result) => ...)`
- `session.surface.nodes` / `session.eventAt(seq)` / `session.deriveEventMessage(event)`
- `session.append('tool/result', data, { surfaceOp: { op: 'replace', startSeq, endSeq }, sourceEventSeqs })`
- `session.append('compaction/prune', { shadowedRange, shadowedSeqs, shadowedTokenCount })`
  —— 沿用同一个影子计价事件，`tokenMeter` 等消费者才不用自己记账
- `ctx.tokenMeter.estimateMessage(message)` / `ctx.tokenMeter.measure(session)`

**没用**的（查过，桌面宿主里找不到）：`tools.restrict({deny})`、`tools_addition`。
实验 1 证明共存即可，所以不需要它们。

## 实机状态

已确认（桌面宿主 0.2.2-rc.1，profile `desktop` + 真实会话 `session-0fb318a6`）：

1. **会话标识**：`dirFor()` 取 `session.id` 有效，落盘目录按会话分成 16-hex 子目录，互不串号。
2. **非压缩路径能 replace**：`read` 的整文件结果换成预览 + `ref://`，且没有重复外移
   （`MARKER` 判断挡住了自替换）。
3. **job 路径（pwsh）已被 `agent/pre-step` 治住**。事件序列是决定性的：
   `seq 29 tool/result`(49,930 字符) → `seq 30 step/end` → `seq 31 compaction/prune`
   (`shadowedTokenCount 12491`) → `seq 32 tool/result`(2,937 字符) → `seq 33 step/start`。
   重写落在下一步构造请求之前，`errors.log` 没有生成，孤儿文件不再出现。净效果 **−94 %**。
4. **`result_read` 执行路径已跑通**：模型主动调了 3 次（`offset=1480/1490/1500, limit=1`），
   ref 命中同一会话目录，游标 `还有内容，用 offset=1501 继续` 正常回报。

### 一个必须先说清楚的重叠

宿主**自己**就会截断 pwsh 结果：实测把 3000 行输出压成"头部 1375 行 + `[...]` + 尾部
1759..3000 行 + `(Omitted 7608 bytes. Full formatted result stored at: <临时路径>. Use read
with offset/limit, or grep this path...)`"，上限约 49,930 字符 = **12,491 token**。

所以本插件的外移是在**宿主已经截断过的文本**上再做一层：12,491 → 约 740 token。
两个后果：

- `result_read` 的行号指的是**我们存下来的那份**（宿主截断后的），不是原始输出的行号。
  实测 `offset=1500` 返回 `ROW1879`，而宿主自己那份 `dsh-spill-*` 里第 1500 行才是 `ROW1500`。
  预览保留了宿主的路径提示，模型随即 `grep` 那个路径拿到了正确行——链路是自洽的。
- `read` 工具**也**有 cap，但不是固定值：一次给 `Showing lines 1-956`（56,009 字符），
  一次给 `Showing lines 1-563`（41,750 字符）。更像按剩余窗口动态裁，机制没查。
  插件的价值恰恰在它漏掉的地方：**cap 按行不按字符**，长行文件照样能一次塞进几万字。

### 边界用例（needle 落在宿主 cap 之外）

同一会话接着问第 1242 行（>563，我们的 ref 里根本没有）。实测链路 4 步、答案逐字正确：

| step | 调用 | 负载 |
| ---: | :--- | ---: |
| 1 | `result_read(offset=1240)` | 26,733 |
| 2 | `read(offset=565, limit=5)` | 26,905 |
| 3 | `read(offset=1240, limit=5)` | 27,334 |
| 4 | 逐字引用答复 | 27,620 |

模型看到空页就自己换到宿主续读，没有绕死、没有重读整文件。但这一步花了 3 次调用里的 2 次去试探，
因为旧版空页文案是 `第 1240-1239 行 / 共 569 行`——自相矛盾。已修：`readRange` 增 `outOfRange`，
越界时直说"这个 ref 只有 N 行，是宿主截断后的那一份，往后要用官方 read 的 offset 续读"；
预览也按 `Output capped.` / `Use offset=` 判据分两种措辞，截断过的结果不再引导它去 ref 里翻。

## 配置（`cordis.patch.yml`，改完重启 dsh）

| 键 | 默认 | 说明 |
| :--- | ---: | :--- |
| `captureThresholdTokens` | 1200 | 超过才外移。设太低会让模型频繁翻页——一次翻页 = 一轮 = 实测 55 tok/s 下 40~80 秒 |
| `previewHeadChars` / `previewTailChars` | 2000 / 800 | 预览按**字符**封顶（行计数被实测否证：pwsh 长行只省下 9%） |
| `maxEditsPerCall` | 20 | 单次 `edit_many` 条数上限 |
| `resultReadLines` | 200 | `result_read` 默认行数，硬上限 500 |
| `resultReadMaxChars` | 6000 | 单页字符上限，超了就少给几行并回报 `trimmed` |
| `spillTtlDays` | 7 | 外移文件保留天数，加载插件时清扫一次过期副本与空目录 |
| `spillRoot` | 系统临时目录 | 外移全文的落盘根目录，按会话 id 分子目录 |

## 跑测试

```console
cd <本仓库目录>
npm test
```

29 个用例覆盖纯逻辑（CRLF 归一化、唯一性、区间重叠、原子写、ref 校验、预览形状、翻页游标与越界、
过期副本清扫）加一条假 ctx 冒烟，不依赖 dsh 运行时。

## 装进 dsh

```console
"<dsh 安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add <本地路径或包名>
```

CLI 的具体路径因安装位置而异。宿主**没有热重载**：装完要重启 dsh，且只影响新开的会话。
桌面版自带的 CLI **没有 headless 模式**，插件行为只能在 GUI 会话里验证。
本项目全部实测数据来自 **dsh 桌面宿主 0.2.2-rc.1 + Qwen3.5-9B（RTX 5060 Laptop 8GB）**，
换宿主版本或换模型请重新验证，别照抄结论。

### 装之前请先接受这一条

为了把大结果挪出上下文，本插件会**把它们原文写进你本机的临时目录**
（默认 `%TEMP%\dsh-lean-ops\`，按会话 id 分子目录，保留 `spillTtlDays` 天）。
工具结果里可能包含你项目的源码、命令输出、配置文件内容。这意味着：

- 这些副本**不随会话删除而清理**，直到 TTL 到期或你手动删；`spillRoot` 可指到别处。
- 全盘加密、备份软件、临时目录清理工具都会碰到它们，请自行评估。
- 插件**不联网、不上传**，除本地文件读写外没有任何外部请求。

### 已知重叠

宿主自己也会截断 `read` / `pwsh` 结果（`read` 按行截、`pwsh` 留头尾并把全文写到它自己的临时目录）。
本插件是在那份截断结果之上再收一层，差别在**时机**：宿主逼近压缩点才动手，插件在结果落地后的
下一个 `agent/pre-step` 就动手。收益与实测口径见 [docs/2026-11-09-全天总结.md](docs/2026-11-09-全天总结.md)。

## 许可

MIT，见 [LICENSE](LICENSE)。
