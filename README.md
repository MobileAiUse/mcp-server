# phone-agent-mcp

> 本地 MCP Server — 将 WebADB 浏览器中的 AI Agent 能力暴露为 MCP Tools，供 OpenClaw / Qoder 等外部 AI 客户端通过标准协议调用。

## 架构概览

```
外部 AI 客户端（Qoder / OpenClaw / 浏览器端 MCP 客户端）
        │
        │  Streamable HTTP（SSE 流，首选） 或 stdio（JSON-RPC 2.0）
        ▼
┌───────────────────┐      WebSocket       ┌──────────────────────────────┐
│  phone-agent-mcp  │ ◄──────────────────► │  Mobile AI Agent 浏览器页面    │
│  (Node.js 进程)    │    ws://localhost    │  (https://mobile-ai-use.com) │
│                   │      :7788           │                              │
│  ┌──────────────┐ │                      │  ┌─────────────────┐         │
│  │ McpServer    │ │  callBrowser()       │  │ MCP Relay       │         │
│  │ (HTTP+stdio) │ │ ──── tool/args ────► │  │ (WS Client)     │         │
│  │              │ │ ◄─── result ──────── │  │                 │         │
│  │ 9 个 Tools   │ │                      │  │ Agent 调度       │         │
│  │              │ │  progress ◄───────── │  │ 工具执行         │         │
│  └──────────────┘ │                      │  └─────────────────┘         │
└───────────────────┘                      └──────────────────────────────┘
```

- **MCP 层**：基于 `@modelcontextprotocol/sdk` 的 `McpServer`，提供两种传输通道：
  - **Streamable HTTP**（默认 `7789` 端口，`/mcp` 端点）：SSE 流式输出结果与中间过程，支持多会话，首选通道
  - **stdio**：兼容 Qoder / OpenClaw 等本地 CLI 类客户端的传统接入方式
- **中继层**：内嵌 `ws` WebSocket Server（默认 `7788` 端口），将工具调用请求转发给浏览器页面中的 MCP Relay
- **进度上报**：支持 MCP `notifications/progress` 协议，Agent 思考/执行过程实时推送至客户端
- **Tasks 扩展**：支持 MCP Tasks 扩展（`io.modelcontextprotocol/tasks`），长耗时任务异步化，客户端可轮询状态、获取进度、断连后恢复

## 前置条件

- **Node.js** ≥ 18
- **pnpm**（推荐，项目统一包管理器）
- **Mobile AI Use 浏览器页面**已打开并运行（`https://mobile-ai-use.com`），页面顶栏 MCP Relay 状态指示器绿色亮起即表示已连接

## 快速开始

```bash
# 1. 进入 mcp-server 目录
cd mcp-server

# 2. 安装依赖
pnpm install

# 3. 构建（生成 dist/server.js）
pnpm run build

# 4. 启动服务
pnpm start
```

开发模式（无需构建，直接运行 TypeScript）：

```bash
pnpm run dev
```

启动成功后，控制台输出：

```
[phone-agent-mcp] WebSocket relay on ws://localhost:7788
[phone-agent-mcp] MCP server ready (stdio transport)
[phone-agent-mcp] Streamable HTTP on http://localhost:7789/mcp
```

## 环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `PHONE_AGENT_WS_PORT` | `7788` | WebSocket 中继端口号 |
| `PHONE_AGENT_HTTP_PORT` | `7789` | Streamable HTTP 端口号 |

## 注册的工具（Tools）

| 工具名 | 权限 | 超时 | 说明 |
|--------|------|------|------|
| `run_agent_task` | 写入 | 可配置 | 在已连接的手机上运行 AI Agent 任务，传入自然语言目标（支持 Tasks 扩展异步执行） |
| `abort_task` | 写入 | 10s | 中止当前正在运行的 Agent 任务 |
| `get_task_result` | 只读 | 10s | 按任务 ID 获取已完成任务的详细结果（含步骤） |
| `get_latest_task` | 只读 | 10s | 获取当前对话中最近一次 Agent 任务的结果 |
| `take_screenshot` | 只读 | 30s | 对已连接的手机屏幕截图，返回 PNG 图片 |
| `get_device_status` | 只读 | 15s | 获取设备信息（型号、品牌、系统版本等） |
| `search_memory` | 只读 | 10s | 按关键词搜索 Agent 的持久化记忆库 |
| `save_memory` | 写入 | 10s | 保存一条语义记忆到记忆库 |
| `delete_memory` | 写入 | 10s | 按 ID 删除一条记忆 |

### `run_agent_task` 详解

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `goal` | `string` | 是 | 自然语言任务目标，如 "打开微信，向张三发送你好" |
| `timeoutMs` | `number` | 否 | 最大执行时间（毫秒），默认 1,200,000（20 分钟） |

Agent 将自动规划执行步骤，通过屏幕视觉识别和触摸控制完成目标。执行期间的思考/工具调用/步骤结果会通过 MCP `notifications/progress` 实时推送。

## MCP Tasks 扩展（异步长耗时任务）

`run_agent_task` 注册为 **task-based 工具**（`taskSupport: 'optional'`），支持 MCP Tasks 扩展（`io.modelcontextprotocol/tasks`），解决长耗时操作的阻塞与连接中断问题。

### 工作流程

```
客户端                                     服务端
  │  tools/call run_agent_task              │
  │  params: { arguments, task: { ttl } }   │
  ├──────────────────────────────────────►│  createTask → 立即返回
  │  CreateTaskResult { task: { taskId,    │  后台继续执行
  │    status: 'working', pollInterval } } │
  │◄──────────────────────────────────────┤
  │  tasks/get { taskId }   ◄── 轮询 ───►  │  notifications/tasks/status 主动推送
  │  … 状态：working（statusMessage=进度）…  │
  │  tasks/result { taskId }                │  任务完成后
  │◄────────────── CallToolResult ─────────┤
```

### 任务状态

| 状态 | 含义 |
|------|------|
| `working` | 任务执行中，`statusMessage` 携带最新进度（Agent 思考/步骤） |
| `completed` | 任务成功完成，可通过 `tasks/result` 获取最终结果 |
| `failed` | 任务失败（含浏览器未连接、超时等），结果中包含错误信息 |
| `cancelled` | 客户端通过 `tasks/cancel` 取消 |

### 服务端能力声明

```json
"capabilities": {
  "tasks": {
    "list": {},
    "cancel": {},
    "requests": { "tools": { "call": {} } }
  }
}
```

支持的端点：`tasks/get`（查状态）、`tasks/result`（取结果）、`tasks/list`（列任务）、`tasks/cancel`（取消）。

### 关键参数

| 参数 | 取值 | 说明 |
|------|------|------|
| TTL | `timeoutMs + 10min` | 任务完成后结果保留时长，过期自动清理 |
| pollInterval | `2000ms` | 建议客户端轮询间隔 |

### 向后兼容

- **新客户端**（声明 tasks 能力）：带 `task` 参数调用 → 立即获得 `taskId`，轮询 `tasks/get` / 取结果 `tasks/result`
- **旧客户端**（不带 `task` 参数）：服务端自动降级为内部轮询，同步等待并直接返回 `CallToolResult`，行为与旧版一致

> 注：`tasks/cancel` 仅标记任务取消并停止结果写入；如需真正中断手机端执行，请另行调用 `abort_task` 工具。

## 配置到 AI 客户端

### Streamable HTTP（推荐）

支持远程/HTTP 接入的客户端（含浏览器端 MCP 客户端）直接指向 URL：

```json
{
  "mcpServers": {
    "phone-agent": {
      "url": "http://localhost:7789/mcp"
    }
  }
}
```

验证连通性：

```bash
curl -N -X POST http://localhost:7789/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

响应头 `mcp-session-id` 即会话 ID，后续请求需携带；响应体为 SSE 流（`text/event-stream`）。

### stdio（Qoder / Claude Desktop / OpenClaw 本地接入）

在客户端的 MCP 配置文件中添加：

```json
{
  "mcpServers": {
    "phone-agent": {
      "command": "node",
      "args": ["/path/to/mcp-server/dist/server.js"],
      "env": {
        "PHONE_AGENT_WS_PORT": "7788"
      }
    }
  }
}
```

### OpenClaw

```yaml
mcp_servers:
  phone-agent:
    command: node
    args:
      - /path/to/mcp-server/dist/server.js
    env:
      PHONE_AGENT_WS_PORT: "7788"
```

配置完成后，AI 客户端中即可看到上述 9 个手机 Agent 工具，直接调用即可操控手机。

## Streamable HTTP 传输详解

Streamable HTTP 是 MCP 标准传输协议，服务端通过 **SSE 流**在同一个 HTTP 响应内依次输出**中间过程通知**与**最终结果**，无需客户端额外轮询：

| 端点 | 方法 | 作用 |
|------|------|------|
| `/mcp` | POST | 客户端消息入口（initialize / tools/call / tasks/* 等），响应为 SSE 流 |
| `/mcp` | GET | 打开独立 SSE 流，接收服务端主动推送（如 `notifications/tasks/status`） |
| `/mcp` | DELETE | 关闭会话 |

### 流式输出内容

长耗时工具（如 `run_agent_task`）执行期间，响应流内会实时推送：

- `notifications/progress`：Agent 思考/执行进度（客户端声明 `progressToken` 时）
- `notifications/message`：进度日志降级通道
- `notifications/tasks/status`：任务状态变更（working/completed/failed）

流末尾为最终 `CallToolResult` 或 `CreateTaskResult`（task 模式）。

### 会话管理

- **有状态模式**：服务端生成 sessionId，随 `initialize` 响应头 `mcp-session-id` 下发，后续请求必须携带
- **每会话一个 McpServer 实例**；工具 handler 共享全局浏览器中继与任务存储（`taskStore` 跨会话，断连重连后可继续轮询任务）
- **CORS 已放开**：浏览器端 MCP 客户端可直接访问

## 连接流程

1. **启动 mcp-server**：`pnpm start`，启动 stdio / Streamable HTTP 双通道和 WS 中继
2. **打开浏览器页面**：访问 WebADB 页面，确保设备已连接
3. **确认 Relay 连接**：页面顶栏 Relay 状态指示器变绿，控制台输出 `Browser connected`
4. **接入 MCP 客户端**：
   - HTTP 客户端指向 `http://localhost:7789/mcp`（initialize 后携带 `mcp-session-id`）
   - 本地 CLI 客户端通过 stdio 启动 `node dist/server.js`
5. **调用工具**：请求经 WS 转发至浏览器执行，结果与中间过程经 SSE / stdio 流式返回

## 项目结构

```
mcp-server/
├── src/
│   └── server.ts          # 主服务：McpServer + WS + 8 个工具注册
├── dist/
│   └── server.js          # 编译产物
├── package.json
├── tsconfig.json           # TypeScript 配置（ES2022 / NodeNext）
└── pnpm-lock.yaml
```

## 技术栈

| 组件 | 版本 | 用途 |
|------|------|------|
| `@modelcontextprotocol/sdk` | ^1.12.0 | MCP 服务端框架（McpServer + StdioServerTransport） |
| `ws` | ^8.18.0 | WebSocket 服务端，中继浏览器连接 |
| `zod` | ^4.4.3 | 工具参数校验与 Schema 声明 |
| `typescript` | ~5.8.3 | 类型安全 |
| `tsx` | ^4.19.0 | 开发模式直接运行 TS |

## 设计要点

- **双传输通道**：Streamable HTTP（SSE 流式输出结果与中间过程，多会话）与 stdio（本地 CLI 兼容）并存，工具注册逻辑由 `createPhoneAgentServer()` 工厂函数统一提供
- **任务存储跨会话共享**：`InMemoryTaskStore` 全局单例，客户端断连重连（新会话）后仍可通过 `tasks/get` / `tasks/result` 继续轮询未过期任务
- **单浏览器连接**：同一时刻只接受一个浏览器 WS 连接，新连接替换旧连接
- **请求-响应匹配**：通过 `id` 字段将 WS 响应路由到对应的挂起 Promise
- **超时兜底**：每个工具调用有独立超时，超时返回错误信息而非挂死
- **进度双通道**：优先使用 `notifications/progress`（需客户端声明 `progressToken`），降级为 `notifications/message`（logging）；task 模式下同步写入 `task.statusMessage` 并推送 `notifications/tasks/status`
- **静默容错**：进度推送失败不中断任务执行；任务被取消/TTL 清理后后台写入安全跳过
- **浏览器离线提示**：WS 未连接时返回友好错误 "Browser not connected"
