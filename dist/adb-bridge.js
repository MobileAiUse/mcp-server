import net from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { parseHostPort } from './adb-parse.js';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
// 下行（socket→ws，scrcpy 视频高吞吐）背压水位：超过高水位暂停上游 socket，回落到低水位再恢复。
const WS_HIGH_WATER = 1 << 20; // 1 MiB
const WS_LOW_WATER = 1 << 18; // 256 KiB
const ADBD_CONNECT_TIMEOUT_MS = 10_000;
// 无线链路空闲时靠 TCP keepalive 及时发现 NAT/Wi-Fi 断链，而不是等到下一次写入才报错
const ADBD_KEEPALIVE_MS = 10_000;
/** 是否为回环绑定地址（回环下免 token，见安全默认 D6）。 */
export function isLoopbackHost(host) {
    return LOOPBACK.has((host || '').trim().toLowerCase());
}
/** 非回环绑定必须显式提供 token，否则拒绝启动，避免把裸 ADB 流暴露到外网。 */
export function assertBridgeAuth(host, token) {
    if (!isLoopbackHost(host) && !token) {
        throw new Error(`refusing to start ADB bridge on non-loopback host "${host}" without a token ` +
            `(set PHONE_AGENT_ADB_TOKEN)`);
    }
}
function toBuffer(data) {
    if (Buffer.isBuffer(data))
        return data;
    if (Array.isArray(data))
        return Buffer.concat(data);
    return Buffer.from(data);
}
/** 把 net 连接错误翻译成可读原因（会经 ws close reason 透传到浏览器 UI）。 */
function describeConnectError(host, port, e) {
    const addr = `${host}:${port}`;
    switch (e?.code) {
        case 'ECONNREFUSED': return `adbd refused ${addr} (run "adb tcpip ${port}" on the phone first?)`;
        case 'ETIMEDOUT':
        case 'EHOSTUNREACH':
        case 'ENETUNREACH': return `phone ${addr} unreachable (${e.code}), check Wi-Fi / same LAN`;
        case 'ENOTFOUND': return `cannot resolve host ${host}`;
        default: return `connect ${addr} failed: ${e?.message || 'unknown'}`;
    }
}
/**
 * 直连手机 adbd 的 TCP 端口（adb tcpip 模式，通常 5555）。
 * 连接建立后不收发任何字节，CNXN/AUTH 握手完全由浏览器侧 AdbDaemonTransport 完成。
 */
function connectAdbd(host, port) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const s = net.connect({ host, port });
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            s.destroy();
            reject(new Error(`connect ${host}:${port} timed out after ${ADBD_CONNECT_TIMEOUT_MS}ms`));
        }, ADBD_CONNECT_TIMEOUT_MS);
        // 交付后仍保留该监听（settled 后变 noop），兜住桥接层挂上自己的 error 监听前的错误，避免进程崩溃
        s.on('error', (e) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            s.destroy();
            reject(new Error(describeConnectError(host, port, e)));
        });
        s.once('connect', () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            s.setNoDelay(true);
            s.setKeepAlive(true, ADBD_KEEPALIVE_MS);
            resolve(s);
        });
    });
}
/**
 * 启动二进制 ADB over WebSocket 桥接服务。
 * 浏览器连 ws://host:port/?serial=<ip:port>&token=<t>，桥接端直连该手机 adbd 的 TCP 端口，
 * 随后仅做双向裸字节搬运（不讲 ADB 协议、不认证——CNXN/AUTH 握手在浏览器侧完成）。
 *
 * 注意：不能经本机 adb server（5037）的 host:transport 中转。adb server 在 OKAY 之后只接受
 * 「4 位十六进制长度 + 服务名」请求，收到浏览器的 CNXN 包会立即断开连接。
 * 因此只支持开启了 adb tcpip 的网络设备，USB 序列号会被拒绝（4400）。
 * 同一 serial 同时只允许一条桥接（重复连接 close 4409 device busy）。
 */
export function startAdbBridge(opts) {
    assertBridgeAuth(opts.host, opts.token);
    const wss = new WebSocketServer({ port: opts.port, host: opts.host });
    const active = new Map();
    wss.on('connection', (ws, req) => {
        const url = new URL(req.url || '', 'http://localhost');
        const serial = url.searchParams.get('serial') || '';
        const token = url.searchParams.get('token') || '';
        if (opts.token && token !== opts.token) {
            ws.close(4401, 'unauthorized');
            return;
        }
        if (!serial) {
            ws.close(4400, 'missing serial');
            return;
        }
        const target = parseHostPort(serial);
        if (!target) {
            ws.close(4400, `serial "${serial.slice(0, 40)}" is not ip:port; only adb tcpip devices are supported`);
            return;
        }
        if (active.has(serial)) {
            ws.close(4409, 'device busy');
            return;
        }
        active.set(serial, ws);
        let socket;
        let closed = false;
        let drainTimer;
        const pending = [];
        // ── 诊断计数器 ──
        let openedAt = 0; // adbd TCP 建连成功的时间戳
        let bytesToWs = 0; // adbd → 浏览器
        let bytesFromWs = 0; // 浏览器 → adbd
        // 按所有权释放名额：仅当 map 中登记的仍是本连接才删，避免迟到清理误删同 serial 的新连接
        const releaseSlot = () => { if (active.get(serial) === ws)
            active.delete(serial); };
        const clearDrain = () => { if (drainTimer) {
            clearInterval(drainTimer);
            drainTimer = undefined;
        } };
        /**
         * @param wsCode  可选，向浏览器发送的 WebSocket close code（4000-4999 自定义区间）
         * @param wsReason 可选，向浏览器发送的 close reason（浏览器端 onclose 可读取）
         */
        const teardown = (wsCode, wsReason) => {
            if (closed)
                return;
            closed = true;
            releaseSlot();
            clearDrain();
            try {
                socket?.destroy();
            }
            catch { /* already gone */ }
            try {
                if (ws.readyState === WebSocket.OPEN) {
                    if (wsCode)
                        ws.close(wsCode, (wsReason || '').slice(0, 120));
                    else
                        ws.close();
                }
            }
            catch { /* ignore */ }
        };
        ws.on('close', () => teardown());
        ws.on('error', (e) => { console.error('[adb-bridge] ws error:', e?.message); teardown(); });
        // 入站处理：连接即挂载，缓存 adbd 建连完成之前到达的二进制帧（浏览器的首个 CNXN），避免丢包
        ws.on('message', (data, isBinary) => {
            if (!isBinary)
                return;
            const buf = toBuffer(data);
            bytesFromWs += buf.length;
            if (socket && socket.writable)
                socket.write(buf);
            else
                pending.push(buf);
        });
        function setupSocket(s) {
            if (closed) {
                s.destroy();
                return;
            }
            socket = s;
            openedAt = Date.now();
            socket.on('error', (e) => {
                console.error('[adb-bridge] adbd socket error: serial=%s %s', serial, e?.message);
                teardown(4503, `adbd connection error: ${e?.message || 'unknown'}`);
            });
            socket.on('close', () => {
                const aliveMs = Date.now() - openedAt;
                console.warn('[adb-bridge] adbd socket closed: serial=%s alive=%dms toWs=%d fromWs=%d', serial, aliveMs, bytesToWs, bytesFromWs);
                teardown(4503, bytesToWs === 0
                    ? `adbd closed connection before replying (after ${aliveMs}ms)`
                    : `adbd closed connection after ${aliveMs}ms (phone offline or adbd restarted)`);
            });
            socket.on('data', (chunk) => {
                if (ws.readyState !== WebSocket.OPEN)
                    return;
                bytesToWs += chunk.length;
                ws.send(chunk, { binary: true });
                if (ws.bufferedAmount > WS_HIGH_WATER && !drainTimer) {
                    socket?.pause();
                    drainTimer = setInterval(() => {
                        if (closed || ws.bufferedAmount <= WS_LOW_WATER || ws.readyState !== WebSocket.OPEN) {
                            clearDrain();
                            if (!closed)
                                socket?.resume();
                        }
                    }, 16);
                }
            });
            for (const b of pending)
                socket.write(b); // flush 建连期缓存的入站帧
            pending.length = 0;
        }
        console.info('[adb-bridge] connecting adbd %s:%d for serial=%s', target.host, target.port, serial);
        connectAdbd(target.host, target.port).then(setupSocket).catch((err) => {
            const msg = String(err?.message || err).slice(0, 120);
            console.error('[adb-bridge] adbd connect failed for serial=%s: %s', serial, msg);
            teardown(4502, msg);
        });
    });
    return wss;
}
