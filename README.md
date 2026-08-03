# phone-agent-mcp

> 本地 MCP Server — 将 WebADB 浏览器中的 AI Agent 能力暴露为 MCP Tools，供 OpenClaw / Qoder 等外部 AI 客户端通过标准协议调用。

## 架构概览

```
外部 AI 客户端（Qoder / OpenClaw）
        │
        │  stdio（JSON-RPC 2.0 / MCP 协议）
        ▼
┌───────────────────┐      WebSocket       ┌──────────────────────────────┐
│  phone-agent-mcp  │ ◄──────────────────► │  Mobile AI Agent 浏览器页面    │
│  (Node.js 进程)    │    ws://localhost    │  (https://mobile-ai-use.com) │
│                   │      :7788           │                              │
│  ┌──────────────┐ │                      │  ┌─────────────────┐         │
│  │ McpServer    │ │  callBrowser()       │  │ MCP Relay       │         │
│  │ (stdio)      │ │ ──── tool/args ────► │  │ (WS Client)     │         │
│  │              │ │ ◄─── result ──────── │  │                 │         │
│  │ 8 个 Tools   │ │                      │  │ Agent 调度       │         │
│  │              │ │  progress ◄───────── │  │ 工具执行         │         │
│  └──────────────┘ │                      │  └─────────────────┘         │
└───────────────────┘                      └──────────────────────────────┘
```

- **MCP 层**：基于 `@modelcontextprotocol/sdk` 的 `McpServer`，通过 `StdioServerTransport` 与外部客户端通信
- **中继层**：内嵌 `ws` WebSocket Server（默认 `7788` 端口），将工具调用请求转发给浏览器页面中的 MCP Relay
- **进度上报**：支持 MCP `notifications/progress` 协议，Agent 思考/执行过程实时推送至客户端

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
[phone-agent-mcp] MCP server ready (McpServer, stdio transport)
```

## 环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `PHONE_AGENT_WS_PORT` | `7788` | WebSocket 中继端口号 |

## 注册的工具（Tools）

| 工具名 | 权限 | 超时 | 说明 |
|--------|------|------|------|
| `run_agent_task` | 写入 | 可配置 | 在已连接的手机上运行 AI Agent 任务，传入自然语言目标 |
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

## 配置到 AI 客户端

### Qoder / Claude Desktop

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

配置完成后，AI 客户端中即可看到上述 8 个手机 Agent 工具，直接调用即可操控手机。

## 连接流程

1. **启动 mcp-server**：`pnpm start`，启动 stdio MCP 服务和 WS 中继
2. **打开浏览器页面**：访问 WebADB 页面，确保设备已连接
3. **确认 Relay 连接**：页面顶栏 Relay 状态指示器变绿，控制台输出 `Browser connected`
4. **调用工具**：外部 AI 客户端通过 MCP 调用工具，请求经 WS 转发至浏览器执行，结果原路返回

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

- **单浏览器连接**：同一时刻只接受一个浏览器 WS 连接，新连接替换旧连接
- **请求-响应匹配**：通过 `id` 字段将 WS 响应路由到对应的挂起 Promise
- **超时兜底**：每个工具调用有独立超时，超时返回错误信息而非挂死
- **进度双通道**：优先使用 `notifications/progress`（需客户端声明 `progressToken`），降级为 `notifications/message`（logging）
- **静默容错**：进度推送失败不中断任务执行
- **浏览器离线提示**：WS 未连接时返回友好错误 "Browser not connected"
