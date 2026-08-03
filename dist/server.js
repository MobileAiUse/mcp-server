/**
 * phone-agent MCP Server（新 API）
 *
 * 使用 @modelcontextprotocol/sdk/server/mcp.js 的 McpServer + registerTool 高级 API。
 *
 * 架构：
 *   1. McpServer + StdioServerTransport 处理 MCP 协议（JSON-RPC 2.0 over stdio）
 *   2. 内嵌 WebSocket Server（默认 7788 端口），供浏览器页面连接
 *   3. 收到 tools/call → callBrowser() 转发给浏览器 → 等待响应 → 返回 CallToolResult
 *
 * 启动方式：
 *   pnpm run build && node dist/server.js
 *   开发模式：pnpm run dev
 *
 * 环境变量：
 *   PHONE_AGENT_WS_PORT  WebSocket 端口，默认 7788
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
// ==================== 配置 ====================
const WS_PORT = Number(process.env.PHONE_AGENT_WS_PORT ?? 7788);
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
        console.info(`[phone-agent-mcp] message: ${data.toString()}`);
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
        // 进度帧：转发给对应请求的进度处理器，不结束请求（也不重置超时）
        if (msg.type === 'progress') {
            entry.onProgress?.(msg.seq ?? 0, msg.message ?? '');
            return;
        }
        console.info(`[phone-agent-mcp] message: ${data.toString()}`);
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
// ==================== McpServer ====================
const server = new McpServer({ name: 'phone-agent', version: '1.0.0' }, { capabilities: { tools: {}, logging: {} } });
// ── run_agent_task ──────────────────────────────────────────────────────────
server.registerTool('run_agent_task', {
    description: 'Run an AI Agent task on the connected phone. ' +
        'The agent will plan and execute multiple steps to achieve the goal ' +
        'using screen vision and touch controls.',
    inputSchema: {
        goal: z.string().describe('Natural language task goal, e.g. "Open WeChat and send hello to John"'),
        timeoutMs: z.number().optional().describe('Max execution time in milliseconds (default: 120000)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
}, async ({ goal, timeoutMs = 1200_000 }, extra) => {
    // 客户端在 _meta.progressToken 中声明愿意接收进度时，才能发 notifications/progress；
    // 否则降级成 notifications/message（logging），保证过程在客户端仍可见。
    const progressToken = extra._meta?.progressToken;
    const onProgress = (seq, message) => {
        console.info(`[phone-agent-mcp] progress: ${seq} ${message}`);
        if (!message)
            return;
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
    return callBrowser('run_agent_task', { goal, timeoutMs }, timeoutMs + 5_000, onProgress);
});
// ── abort_task ──────────────────────────────────────────────────────────────
server.registerTool('abort_task', {
    description: 'Abort the currently running Agent task.',
    inputSchema: {},
}, async () => callBrowser('abort_task', {}, 10_000));
// ── get_task_result ─────────────────────────────────────────────────────────
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
// ── get_latest_task ─────────────────────────────────────────────────────────
server.registerTool('get_latest_task', {
    description: 'Get the most recent Agent task result from the current conversation.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
}, async () => callBrowser('get_latest_task', {}, 10_000));
// ── take_screenshot ─────────────────────────────────────────────────────────
server.registerTool('take_screenshot', {
    description: 'Take a screenshot of the connected phone screen. Returns a PNG image.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
}, async () => callBrowser('take_screenshot', {}, 30_000));
// ── get_device_status ───────────────────────────────────────────────────────
server.registerTool('get_device_status', {
    description: 'Get information about the connected phone device (model, brand, OS version, etc.).',
    inputSchema: {},
    annotations: { readOnlyHint: true },
}, async () => callBrowser('get_device_status', {}, 15_000));
// ── search_memory ───────────────────────────────────────────────────────────
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
// ── save_memory ─────────────────────────────────────────────────────────────
server.registerTool('save_memory', {
    description: "Save a semantic memory (reusable knowledge) into the phone agent's persistent memory.",
    inputSchema: {
        title: z.string().describe('One-line title of the memory'),
        content: z.string().describe('Memory content, under 200 chars recommended'),
        keywords: z.array(z.string()).optional().describe('Optional search keywords'),
    },
}, async ({ title, content, keywords }) => callBrowser('save_memory', { title, content, keywords }, 10_000));
// ── delete_memory ───────────────────────────────────────────────────────────
server.registerTool('delete_memory', {
    description: 'Delete one memory entry (semantic or episodic) by its id.',
    inputSchema: {
        id: z.string().describe('Memory id returned by search_memory / save_memory'),
    },
}, async ({ id }) => callBrowser('delete_memory', { id }, 10_000));
// ==================== 启动 ====================
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[phone-agent-mcp] MCP server ready (McpServer, stdio transport)');
