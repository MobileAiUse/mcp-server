# phone-agent-mcp

> Local MCP Server — Exposes the AI Agent capabilities from the WebADB browser page as MCP Tools, allowing external AI clients such as OpenClaw / Qoder to invoke them via the standard MCP protocol.

## Architecture Overview

```
External AI Client (Qoder / OpenClaw / Browser-side MCP Client)
        │
        │  Streamable HTTP (SSE stream, preferred) or stdio (JSON-RPC 2.0)
        ▼
┌───────────────────┐      WebSocket       ┌──────────────────────────────┐
│  phone-agent-mcp  │ ◄──────────────────► │  Mobile AI Agent Browser Page│
│  (Node.js Process)│    ws://localhost    │  (https://mobile-ai-use.xyz) │
│                   │      :7788           │                              │
│  ┌──────────────┐ │                      │  ┌─────────────────┐         │
│  │ McpServer    │ │  callBrowser()       │  │ MCP Relay       │         │
│  │ (HTTP+stdio) │ │ ──── tool/args ────► │  │ (WS Client)     │         │
│  │              │ │ ◄─── result ──────── │  │                 │         │
│  │ 9 Tools      │ │                      │  │ Agent Scheduler │         │
│  │              │ │  progress ◄───────── │  │ Tool Executor   │         │
│  └──────────────┘ │                      │  └─────────────────┘         │
└───────────────────┘                      └──────────────────────────────┘
```

- **MCP Layer**: Built on `@modelcontextprotocol/sdk`'s `McpServer`, providing two transport channels:
  - **Streamable HTTP** (default port `7789`, `/mcp` endpoint): SSE streaming output for results and intermediate progress, supports multiple sessions — the preferred channel
  - **stdio**: Traditional transport compatible with local CLI clients such as Qoder / OpenClaw
- **Relay Layer**: Embedded `ws` WebSocket Server (default port `7788`), forwarding tool call requests to the MCP Relay in the browser page
- **Progress Reporting**: Supports the MCP `notifications/progress` protocol, pushing Agent thinking/execution progress to clients in real time
- **Tasks Extension**: Supports the MCP Tasks extension (`io.modelcontextprotocol/tasks`), making long-running tasks asynchronous — clients can poll status, receive progress, and recover after disconnection

## Prerequisites

- **Node.js** ≥ 18
- **pnpm** (recommended, the project's unified package manager)
- **Mobile AI Use browser page** open and running (`https://mobile-ai-use.xyz`), with the MCP Relay status indicator in the top bar showing green (connected)

## Quick Start

```bash
# 1. Enter the mcp-server directory
cd mcp-server

# 2. Install dependencies
pnpm install

# 3. Build (generates dist/server.js)
pnpm run build

# 4. Start the server
pnpm start
```

Development mode (runs TypeScript directly without building):

```bash
pnpm run dev
```

After successful startup, the console outputs:

```
[phone-agent-mcp] WebSocket relay on ws://localhost:7788
[phone-agent-mcp] MCP server ready (stdio transport)
[phone-agent-mcp] Streamable HTTP on http://localhost:7789/mcp
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PHONE_AGENT_WS_PORT` | `7788` | WebSocket relay port |
| `PHONE_AGENT_HTTP_PORT` | `7789` | Streamable HTTP port (also serves the `/adb/*` control plane) |
| `PHONE_AGENT_ADB_WS_PORT` | `7790` | ADB over WebSocket binary bridge port |
| `PHONE_AGENT_ADB_SERVER_HOST` | `127.0.0.1` | Local adb server host (control plane `/adb/*` only) |
| `PHONE_AGENT_ADB_SERVER_PORT` | `5037` | Local adb server port (control plane `/adb/*` only) |
| `PHONE_AGENT_BIND_HOST` | `127.0.0.1` | Bridge/control-plane bind address; a token is required when non-loopback |
| `PHONE_AGENT_ADB_TOKEN` | (empty) | Shared token enforced on non-loopback binds (used by both bridge and control plane) |

## ADB over WebSocket Bridge

Besides direct WebUSB, the web page can also treat a **remote/networked phone** as a first-class device: the host running `phone-agent-mcp` connects directly to the phone's adbd (`ip:port`, i.e. `adb tcpip` mode) and bridges the raw ADB stream to the browser over a WebSocket. The browser reuses `AdbDaemonWebSocketDevice` to produce a standard `Adb` instance, so screen mirroring / AI Agent / workflows all work with zero downstream changes.

```
Remote phone adbd (adb tcpip 5555)
        ▲  direct TCP to <ip:port>, raw ADB bytes relayed both ways
        │
phone-agent-mcp  ──  binary bridge WS (:7790)  ──►  Browser AdbDaemonWebSocketDevice
```

### Control-plane endpoints (reuse the `7789` httpServer)

| Endpoint | Method | Body | Success response | Description |
|----------|--------|------|------------------|-------------|
| `/adb/devices` | GET | — | `{ "devices": [ { serial, state, model?, device?, product? } ] }` | List devices currently known to the local adb server |
| `/adb/connect` | POST | `{ "host": "192.168.1.5", "port": 5555 }` | `{ "ok": true, "message": "..." }` | Make the host `adb connect` to the remote phone; failure returns `502` + `{ ok:false, message }` |
| `/adb/disconnect` | POST | `{ "serial": "192.168.1.5:5555" }` | `{ "ok": true, "message": "..." }` | `adb disconnect` the given device |

Error conventions: unauthorized `401`; missing param / malformed JSON `400`; wrong method `405` (with `Allow` header); unknown path `404`; no local adb (not on PATH) `503`; any other failure `500`.

### Bridge endpoint (`7790`)

The browser connects via `ws://<host>:7790/?serial=<serial>[&token=<token>]`; the bridge parses `serial` as `ip:port`, opens a direct TCP connection to the phone's adbd and relays bytes bidirectionally (the browser performs the CNXN/AUTH handshake itself). `serial` must be `ip:port`; USB serials are not supported (use WebUSB instead). Only one active bridge per `serial` is allowed; duplicate connections are rejected. Close codes: `4401` invalid token / `4400` missing serial or serial is not `ip:port` / `4409` device busy / `4502` failed to connect to adbd (refused / timeout / unreachable) / `4503` adbd connection errored or closed.

### Prerequisites

- adb is on the host `PATH` (`adb version` works).
- The remote phone has been switched with `adb tcpip 5555` and is reachable at its `ip:port`. The random TLS port of Android 11+ "Wireless debugging" is not supported by the bridge yet.
- The browser uses its own ADB key, so the phone shows an "Allow USB debugging" prompt on the first bridge; confirm it on the phone.

### Security

- **localhost needs no token**: when `PHONE_AGENT_BIND_HOST` is loopback (default), the control plane only accepts requests whose peer is a loopback address, and the bridge needs no token.
- **Non-loopback enforces a token**: binding to a non-loopback address requires `PHONE_AGENT_ADB_TOKEN`; otherwise the startup guard `assertBridgeAuth` throws and aborts startup. Afterwards the control plane requires `Authorization: Bearer <token>` or `?token=<token>`, and the bridge requires `?token=<token>`.
- **Mixed content**: if the page is served over `https`, the browser blocks `ws://`; configure `wss://` for the bridge (TLS terminated by a reverse proxy).

## Registered Tools

| Tool | Permission | Timeout | Description |
|------|------------|---------|-------------|
| `run_agent_task` | Write | Configurable | Run an AI Agent task on the connected phone with a natural language goal (supports async execution via the Tasks extension) |
| `abort_task` | Write | 10s | Abort the currently running Agent task |
| `get_task_result` | Read | 10s | Get detailed results (including steps) of a completed task by task ID |
| `get_latest_task` | Read | 10s | Get the result of the most recent Agent task in the current conversation |
| `take_screenshot` | Read | 30s | Take a screenshot of the connected phone screen, returns a PNG image |
| `get_device_status` | Read | 15s | Get device information (model, brand, OS version, etc.) |
| `search_memory` | Read | 10s | Search the Agent's persistent memory store by keyword |
| `save_memory` | Write | 10s | Save a semantic memory entry to the memory store |
| `delete_memory` | Write | 10s | Delete a memory entry by ID |

### `run_agent_task` in Detail

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `goal` | `string` | Yes | Natural language task goal, e.g. "Open WeChat and send 'Hello' to Zhang San" |
| `timeoutMs` | `number` | No | Maximum execution time in milliseconds, default 1,200,000 (20 minutes) |

The Agent will automatically plan execution steps and achieve the goal through screen visual recognition and touch control. During execution, thinking/tool calls/step results are pushed in real time via MCP `notifications/progress`.

## MCP Tasks Extension (Async Long-Running Tasks)

`run_agent_task` is registered as a **task-based tool** (`taskSupport: 'optional'`), supporting the MCP Tasks extension (`io.modelcontextprotocol/tasks`) to address blocking and connection interruption issues with long-running operations.

### Workflow

```
Client                                          Server
  │  tools/call run_agent_task                    │
  │  params: { arguments, task: { ttl } }         │
  ├──────────────────────────────────────────────►│  createTask → returns immediately
  │  CreateTaskResult { task: { taskId,           │  continues executing in background
  │    status: 'working', pollInterval } }        │
  │◄──────────────────────────────────────────────┤
  │  tasks/get { taskId }   ◄── poll ───►         │  notifications/tasks/status proactive push
  │  … status: working (statusMessage=progress) … │
  │  tasks/result { taskId }                      │  after task completes
  │◄────────────── CallToolResult ────────────────┤
```

### Task States

| State | Meaning |
|-------|---------|
| `working` | Task is executing; `statusMessage` carries the latest progress (Agent thinking/steps) |
| `completed` | Task completed successfully; final result available via `tasks/result` |
| `failed` | Task failed (including browser not connected, timeout, etc.); result contains error details |
| `cancelled` | Client cancelled via `tasks/cancel` |

### Server Capability Declaration

```json
"capabilities": {
  "tasks": {
    "list": {},
    "cancel": {},
    "requests": { "tools": { "call": {} } }
  }
}
```

Supported endpoints: `tasks/get` (check status), `tasks/result` (get result), `tasks/list` (list tasks), `tasks/cancel` (cancel).

### Key Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| TTL | `timeoutMs + 10min` | How long results are retained after task completion; auto-cleaned after expiry |
| pollInterval | `2000ms` | Recommended client polling interval |

### Backward Compatibility

- **New clients** (declare tasks capability): Call with `task` parameter → immediately receive `taskId`, poll `tasks/get` / fetch result via `tasks/result`
- **Legacy clients** (no `task` parameter): Server automatically falls back to internal polling, synchronously waits and returns `CallToolResult` directly — behavior identical to the previous version

> Note: `tasks/cancel` only marks the task as cancelled and stops result writing; to actually interrupt execution on the phone, call the `abort_task` tool separately.

## Configuration for AI Clients

### Streamable HTTP (Recommended)

Clients supporting remote/HTTP connections (including browser-side MCP clients) can point directly to the URL:

```json
{
  "mcpServers": {
    "phone-agent": {
      "url": "http://localhost:7789/mcp"
    }
  }
}
```

Verify connectivity:

```bash
curl -N -X POST http://localhost:7789/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

The `mcp-session-id` response header is the session ID, which must be included in subsequent requests; the response body is an SSE stream (`text/event-stream`).

### stdio (Qoder / Claude Desktop / OpenClaw Local Integration)

Add the following to the client's MCP configuration file:

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

After configuration, all 9 phone Agent tools listed above will be available in the AI client — invoke them directly to control the phone.

## Streamable HTTP Transport Details

Streamable HTTP is the standard MCP transport protocol. The server outputs **intermediate progress notifications** and **final results** sequentially within the same HTTP response via an **SSE stream**, eliminating the need for additional client polling:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/mcp` | POST | Client message entry point (initialize / tools/call / tasks/* etc.), response is an SSE stream |
| `/mcp` | GET | Opens a dedicated SSE stream to receive server-initiated pushes (e.g. `notifications/tasks/status`) |
| `/mcp` | DELETE | Close the session |

### Streaming Output Content

During execution of long-running tools (e.g. `run_agent_task`), the response stream pushes in real time:

- `notifications/progress`: Agent thinking/execution progress (when client declares `progressToken`)
- `notifications/message`: Fallback channel for progress log downgrades
- `notifications/tasks/status`: Task state changes (working/completed/failed)

The end of the stream contains the final `CallToolResult` or `CreateTaskResult` (task mode).

### Session Management

- **Stateful mode**: Server generates a sessionId, delivered via the `mcp-session-id` response header with `initialize`; subsequent requests must include it
- **One McpServer instance per session**; tool handlers share a global browser relay and task store (`taskStore` is cross-session — tasks can continue to be polled after disconnect/reconnect)
- **CORS is open**: Browser-side MCP clients can access directly

## Connection Flow

1. **Start mcp-server**: `pnpm start` — launches stdio / Streamable HTTP dual channels and the WS relay
2. **Open the browser page**: Navigate to the WebADB page, ensuring the device is connected
3. **Confirm Relay connection**: The Relay status indicator in the top bar turns green; console outputs `Browser connected`
4. **Connect MCP client**:
   - HTTP clients point to `http://localhost:7789/mcp` (include `mcp-session-id` after initialize)
   - Local CLI clients launch via stdio: `node dist/server.js`
5. **Invoke tools**: Requests are forwarded via WebSocket to the browser for execution; results and intermediate progress are streamed back via SSE / stdio

## Project Structure

```
mcp-server/
├── src/
│   └── server.ts          # Main server: McpServer + WS + 9 tool registrations
├── dist/
│   └── server.js          # Build output
├── package.json
├── tsconfig.json           # TypeScript config (ES2022 / NodeNext)
└── pnpm-lock.yaml
```

## Tech Stack

| Component | Version | Purpose |
|-----------|---------|---------|
| `@modelcontextprotocol/sdk` | ^1.12.0 | MCP server framework (McpServer + StdioServerTransport) |
| `ws` | ^8.18.0 | WebSocket server, relays browser connection |
| `zod` | ^4.4.3 | Tool parameter validation and schema declarations |
| `typescript` | ~5.8.3 | Type safety |
| `tsx` | ^4.19.0 | Run TS directly in development mode |

## Design Highlights

- **Dual transport channels**: Streamable HTTP (SSE streaming for results and intermediate progress, multi-session) and stdio (local CLI compatible) coexist; tool registration logic is unified by the `createPhoneAgentServer()` factory function
- **Cross-session task store sharing**: `InMemoryTaskStore` is a global singleton — clients can continue polling non-expired tasks via `tasks/get` / `tasks/result` after reconnecting (new session)
- **Single browser connection**: Only one browser WS connection is accepted at a time; new connections replace old ones
- **Request-response matching**: WS responses are routed to the corresponding pending Promise via the `id` field
- **Timeout fallback**: Each tool call has an independent timeout; returns an error message on timeout instead of hanging
- **Dual-channel progress**: Prefers `notifications/progress` (requires client to declare `progressToken`), falls back to `notifications/message` (logging); in task mode, also writes `task.statusMessage` and pushes `notifications/tasks/status` simultaneously
- **Silent fault tolerance**: Progress push failures do not interrupt task execution; background writes are safely skipped after task cancellation/TTL cleanup
- **Browser offline hint**: Returns a friendly error "Browser not connected" when the WS is not connected
