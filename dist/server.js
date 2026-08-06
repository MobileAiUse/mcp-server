/**
 * phone-agent MCP Server（新 API）
 *
 * 使用 @modelcontextprotocol/sdk/server/mcp.js 的 McpServer + registerTool 高级 API。
 *
 * 架构：
 *   1. MCP 协议传输层（双通道并存）：
 *      - Streamable HTTP（默认 7789 端口，/mcp 端点）：SSE 流式输出结果与中间过程，
 *        支持多会话、tasks 轮询与断连恢复，是远程/浏览器类 MCP 客户端的首选通道
 *      - stdio：本地客户端（Qoder / OpenClaw 等）的传统接入方式，保持兼容
 *   2. 内嵌 WebSocket Server（默认 7788 端口），供浏览器页面连接
 *   3. 收到 tools/call → callBrowser() 转发给浏览器 → 等待响应 → 返回 CallToolResult
 *   4. MCP Tasks 扩展（io.modelcontextprotocol/tasks）：长耗时工具 run_agent_task
 *      注册为 task-based tool，客户端带 task 参数调用时立即获得 taskId，
 *      之后通过 tasks/get 轮询状态、tasks/result 取结果、tasks/cancel 取消；
 *      不带 task 参数的旧客户端自动降级为服务端内部轮询（同步等待结果）。
 *
 * 启动方式：
 *   pnpm run build && node dist/server.js
 *   开发模式：pnpm run dev
 *
 * 环境变量：
 *   PHONE_AGENT_WS_PORT    WebSocket 中继端口，默认 7788
 *   PHONE_AGENT_HTTP_PORT  Streamable HTTP 端口，默认 7789
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
// ==================== 配置 ====================
const WS_PORT = Number(process.env.PHONE_AGENT_WS_PORT ?? 7788);
const HTTP_PORT = Number(process.env.PHONE_AGENT_HTTP_PORT ?? 7789);
// ==================== WebSocket 中继层 ====================
/** 当前连接的浏览器 WebSocket（同一时刻只支持一个浏览器连接） */
let browserSocket = null;
/** 等待浏览器响应的挂起请求表 */
const pending = new Map();
const wss = new WebSocketServer({ port: WS_PORT });
wss.on('listening', () => {
    console.error(`[phone-agent-mcp] WebSocket relay on ws://localhost:${WS_PORT}`);
});
wss.on('connection', (ws) => {
    if (browserSocket?.readyState === WebSocket.OPEN) {
        console.error('[phone-agent-mcp] Replacing previous browser connection');
        browserSocket.close();
    }
    browserSocket = ws;
    console.error('[phone-agent-mcp] Browser connected');
    setTimeout(() => {
        console.info('call browser: get_device_status');
        callBrowser('get_device_status', {}, 15_000);
    }, 3000);
    ws.on('message', (data) => {
        let msg;
        try {
            msg = JSON.parse(data.toString());
        }
        catch {
            console.error('[phone-agent-mcp] Invalid JSON from browser');
            return;
        }
        const entry = pending.get(msg.id);
        if (!entry)
            return;
        console.info(`[phone-agent-mcp] message: ${data.toString()}`);
        // 进度帧：转发给对应请求的进度处理器，不结束请求（也不重置超时）
        if (msg.type === 'progress') {
            entry.onProgress?.(msg.seq ?? 0, msg.message ?? '');
            return;
        }
        clearTimeout(entry.timer);
        pending.delete(msg.id);
        entry.resolve(msg.result);
    });
    ws.on('close', () => {
        if (browserSocket === ws) {
            browserSocket = null;
            console.error('[phone-agent-mcp] Browser disconnected');
        }
    });
    ws.on('error', (err) => {
        console.error('[phone-agent-mcp] WS error:', err.message);
        if (browserSocket === ws)
            browserSocket = null;
    });
});
wss.on('error', (err) => {
    console.error(`[phone-agent-mcp] WS server error: ${err.message}`);
});
/**
 * 转发工具调用到浏览器并等待响应。
 * @param onProgress 可选：接收浏览器推送的中间过程（Agent 思考 / 工具调用 / 步骤结果）
 */
function callBrowser(tool, args, timeoutMs, onProgress) {
    if (!browserSocket || browserSocket.readyState !== WebSocket.OPEN) {
        return Promise.resolve({
            content: [{
                    type: 'text',
                    text: 'Browser not connected. Open the WebADB page (http://localhost:3089/webadb/) first.',
                }],
            isError: true,
        });
    }
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(id);
            resolve({
                content: [{ type: 'text', text: `Tool "${tool}" timed out after ${timeoutMs}ms` }],
                isError: true,
            });
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer, onProgress });
        browserSocket.send(JSON.stringify({ id, tool, args }));
    });
}
// ==================== McpServer 工厂 ====================
/**
 * 任务存储（内存实现，全局共享）：保存 task 状态与结果，按 TTL 自动清理。
 * 传入 McpServer 后，SDK 自动安装 tasks/get、tasks/result、tasks/list、tasks/cancel 处理器。
 * 跨会话共享，支持客户端断连重连后继续轮询任务。
 */
const taskStore = new InMemoryTaskStore();
/** 任务完成后结果保留时长（ms），供客户端通过 tasks/result 取结果 */
const TASK_RESULT_TTL_BUFFER = 10 * 60_000;
/** 建议客户端轮询间隔（ms） */
const TASK_POLL_INTERVAL = 2_000;
/** 推送任务状态变更通知 notifications/tasks/status；推送失败不中断任务 */
function notifyTaskStatus(extra, task) {
    extra
        .sendNotification({ method: 'notifications/tasks/status', params: task })
        .catch((e) => {
        console.error('[phone-agent-mcp] task status notify failed:', e instanceof Error ? e.message : e);
    });
}
/**
 * 后台执行 Agent 任务：转发到浏览器，将进度写入 task.statusMessage，
 * 完成/失败时写入最终结果。任务被 tasks/cancel 或 TTL 清理后安全跳过写入。
 */
async function runAgentTaskInBackground(taskId, goal, timeoutMs, store, extra) {
    /** 更新状态消息并推送状态通知（任务已终态/被清理时静默忽略） */
    const updateWorking = async (message) => {
        try {
            await store.updateTaskStatus(taskId, 'working', message);
            const task = await store.getTask(taskId);
            notifyTaskStatus(extra, task);
        }
        catch {
            // 任务已被取消或 TTL 清理，无需继续上报
        }
    };
    // 客户端在 _meta.progressToken 中声明愿意接收进度时，才能发 notifications/progress；
    // 否则降级成 notifications/message（logging），保证过程在客户端仍可见。
    const progressToken = extra._meta?.progressToken;
    const onProgress = (seq, message) => {
        console.info(`[phone-agent-mcp] progress: ${seq} ${message}`);
        if (!message)
            return;
        void updateWorking(message);
        const notify = progressToken
            ? extra.sendNotification({
                method: 'notifications/progress',
                params: { progressToken, progress: seq, message },
            })
            : extra.sendNotification({
                method: 'notifications/message',
                params: { level: 'info', logger: 'phone-agent', data: message },
            });
        // 进度推送失败不得中断任务
        notify.catch((e) => {
            console.error('[phone-agent-mcp] progress notify failed:', e instanceof Error ? e.message : e);
        });
    };
    /** 写入终态结果并推送最终状态通知 */
    const finish = async (status, result) => {
        try {
            await store.storeTaskResult(taskId, status, result);
            const task = await store.getTask(taskId);
            notifyTaskStatus(extra, task);
        }
        catch (e) {
            // 任务已被 tasks/cancel 取消或 TTL 清理，结果丢弃即可
            console.error('[phone-agent-mcp] store task result skipped:', e instanceof Error ? e.message : e);
        }
    };
    try {
        const result = await callBrowser('run_agent_task', { goal, timeoutMs }, timeoutMs + 5_000, onProgress);
        await finish(result.isError ? 'failed' : 'completed', result);
    }
    catch (err) {
        await finish('failed', {
            content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
            isError: true,
        });
    }
}
/**
 * 创建一个已注册全部工具的 McpServer 实例。
 * Streamable HTTP 模式下每个会话一个实例；工具 handler 闭包共享全局
 * callBrowser 与 taskStore，会话间工具行为一致。
 */
function createPhoneAgentServer() {
    const server = new McpServer({ name: 'phone-agent', version: '1.2.0' }, {
        capabilities: {
            tools: {},
            logging: {},
            // 声明 Tasks 扩展能力（io.modelcontextprotocol/tasks）：
            // list/cancel 对应 tasks/list、tasks/cancel 端点；
            // requests.tools.call 声明接受 task 化的 tools/call 请求
            tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
        },
        taskStore,
    });
    // ── run_agent_task（task-based · MCP Tasks 扩展）───────────────────────
    server.experimental.tasks.registerToolTask('run_agent_task', {
        description: 'Run an AI Agent task on the connected phone. ' +
            'The agent will plan and execute multiple steps to achieve the goal ' +
            'using screen vision and touch controls. ' +
            'Long-running: prefer calling with the task extension to get a taskId, ' +
            'then poll tasks/get and fetch tasks/result.',
        inputSchema: {
            goal: z.string().describe('Natural language task goal, e.g. "Open WeChat and send hello to John"'),
            timeoutMs: z.number().optional().describe('Max execution time in milliseconds (default: 1200000)'),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
        // optional：支持 task 扩展的客户端立即获得 taskId 轮询；
        // 旧客户端不带 task 参数时自动降级为服务端内部轮询（同步等待结果）
        execution: { taskSupport: 'optional' },
    }, {
        createTask: async ({ goal, timeoutMs = 1_200_000 }, extra) => {
            const task = await extra.taskStore.createTask({
                ttl: timeoutMs + TASK_RESULT_TTL_BUFFER,
                pollInterval: TASK_POLL_INTERVAL,
            });
            console.error(`[phone-agent-mcp] task created: ${task.taskId} goal=${goal}`);
            // 后台执行，不阻塞 tools/call 响应
            void runAgentTaskInBackground(task.taskId, goal, timeoutMs, extra.taskStore, extra);
            return { task };
        },
        getTask: async (_args, extra) => extra.taskStore.getTask(extra.taskId),
        getTaskResult: async (_args, extra) => (await extra.taskStore.getTaskResult(extra.taskId)),
    });
    // ── abort_task ──────────────────────────────────────────────────────────
    server.registerTool('abort_task', {
        description: 'Abort the currently running Agent task.',
        inputSchema: {},
    }, async () => callBrowser('abort_task', {}, 10_000));
    // ── get_task_result ─────────────────────────────────────────────────────
    server.registerTool('get_task_result', {
        description: 'Get the detailed result of a completed Agent task by its task ID.',
        inputSchema: {
            taskId: z.string().describe('Task ID returned by run_agent_task'),
            includeSteps: z.boolean().optional().describe('Include per-step details (default: true)'),
        },
        annotations: { readOnlyHint: true },
    }, async ({ taskId, includeSteps = true }) => {
        return callBrowser('get_task_result', { taskId, includeSteps }, 10_000);
    });
    // ── get_latest_task ─────────────────────────────────────────────────────
    server.registerTool('get_latest_task', {
        description: 'Get the most recent Agent task result from the current conversation.',
        inputSchema: {},
        annotations: { readOnlyHint: true },
    }, async () => callBrowser('get_latest_task', {}, 10_000));
    // ── take_screenshot ─────────────────────────────────────────────────────
    server.registerTool('take_screenshot', {
        description: 'Take a screenshot of the connected phone screen. Returns a PNG image.',
        inputSchema: {},
        annotations: { readOnlyHint: true },
    }, async () => callBrowser('take_screenshot', {}, 30_000));
    // ── get_device_status ───────────────────────────────────────────────────
    server.registerTool('get_device_status', {
        description: 'Get information about the connected phone device (model, brand, OS version, etc.).',
        inputSchema: {},
        annotations: { readOnlyHint: true },
    }, async () => callBrowser('get_device_status', {}, 15_000));
    // ── search_memory ───────────────────────────────────────────────────────
    server.registerTool('search_memory', {
        description: 'Search the persistent memory of the phone agent by keywords. ' +
            'Returns semantic memories (learned experience) and/or episodic records (task history).',
        inputSchema: {
            query: z.string().describe('Keyword query, Chinese or English'),
            type: z.enum(['semantic', 'episodic']).optional().describe('Restrict to one memory type (default: both)'),
            limit: z.number().optional().describe('Max results (default: 5)'),
        },
        annotations: { readOnlyHint: true },
    }, async ({ query, type, limit }) => callBrowser('search_memory', { query, type, limit }, 10_000));
    // ── save_memory ─────────────────────────────────────────────────────────
    server.registerTool('save_memory', {
        description: "Save a semantic memory (reusable knowledge) into the phone agent's persistent memory.",
        inputSchema: {
            title: z.string().describe('One-line title of the memory'),
            content: z.string().describe('Memory content, under 200 chars recommended'),
            keywords: z.array(z.string()).optional().describe('Optional search keywords'),
        },
    }, async ({ title, content, keywords }) => callBrowser('save_memory', { title, content, keywords }, 10_000));
    // ── delete_memory ───────────────────────────────────────────────────────
    server.registerTool('delete_memory', {
        description: 'Delete one memory entry (semantic or episodic) by its id.',
        inputSchema: {
            id: z.string().describe('Memory id returned by search_memory / save_memory'),
        },
    }, async ({ id }) => callBrowser('delete_memory', { id }, 10_000));
    return server;
}
// ==================== Streamable HTTP 传输层 ====================
/**
 * Streamable HTTP（MCP 标准传输）：POST /mcp 收客户端消息，响应为 SSE 流，
 * 在同一个响应流内依次输出中间通知（notifications/progress、
 * notifications/tasks/status、notifications/message）与最终结果，
 * 实现"结果 + 中间过程"的流式输出；GET /mcp 打开独立 SSE 流接收服务端
 * 主动推送；DELETE /mcp 关闭会话。每个会话一对 McpServer + Transport。
 */
/** 会话表：sessionId → 该会话的传输层 */
const sessions = new Map();
/** CORS：允许浏览器端 MCP 客户端直连（本地中继服务，放宽策略） */
function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id');
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
}
/** 读取并解析 POST 请求体 */
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (!raw.trim()) {
                resolve(undefined);
                return;
            }
            try {
                resolve(JSON.parse(raw));
            }
            catch (e) {
                reject(e instanceof Error ? e : new Error(String(e)));
            }
        });
        req.on('error', reject);
    });
}
/** 为新会话创建 Transport + McpServer 并完成绑定 */
async function createSession() {
    const transport = new StreamableHTTPServerTransport({
        // 有状态模式：sessionId 由服务端生成，随 initialize 响应头下发
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
            sessions.set(sessionId, transport);
            console.error(`[phone-agent-mcp] HTTP session opened: ${sessionId}`);
        },
        onsessionclosed: (sessionId) => {
            sessions.delete(sessionId);
            console.error(`[phone-agent-mcp] HTTP session closed: ${sessionId}`);
        },
    });
    transport.onclose = () => {
        if (transport.sessionId)
            sessions.delete(transport.sessionId);
    };
    const server = createPhoneAgentServer();
    await server.connect(transport);
    return transport;
}
const httpServer = http.createServer(async (req, res) => {
    setCorsHeaders(res);
    if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
    }
    const url = new URL(req.url ?? '/', `http://localhost:${HTTP_PORT}`);
    if (url.pathname !== '/mcp') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found. MCP endpoint is /mcp' }));
        return;
    }
    try {
        if (req.method === 'POST') {
            const sessionId = req.headers['mcp-session-id'];
            let transport = sessionId ? sessions.get(sessionId) : undefined;
            if (!transport) {
                // 新会话（initialize 请求）或会话已失效 → 新建
                transport = await createSession();
            }
            const body = await readBody(req);
            await transport.handleRequest(req, res, body);
        }
        else if (req.method === 'GET' || req.method === 'DELETE') {
            const sessionId = req.headers['mcp-session-id'];
            const transport = sessionId ? sessions.get(sessionId) : undefined;
            if (!transport) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing or expired mcp-session-id' }));
                return;
            }
            await transport.handleRequest(req, res);
        }
        else {
            res.writeHead(405, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Method not allowed' }));
        }
    }
    catch (e) {
        console.error('[phone-agent-mcp] HTTP request error:', e instanceof Error ? e.message : e);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
    }
});
// ==================== 启动 ====================
// stdio 通道：兼容本地 CLI 类客户端（Qoder / OpenClaw 等）
const stdioServer = createPhoneAgentServer();
await stdioServer.connect(new StdioServerTransport());
console.error('[phone-agent-mcp] MCP server ready (stdio transport)');
// Streamable HTTP 通道：SSE 流式输出结果与中间过程
httpServer.listen(HTTP_PORT, () => {
    console.error(`[phone-agent-mcp] Streamable HTTP on http://localhost:${HTTP_PORT}/mcp`);
});
