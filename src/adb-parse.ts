/** adb 输出与桥接地址的纯解析逻辑（零 Node 依赖，便于单测）。 */

export interface AdbDevice {
    serial: string;
    state: string;
    model?: string;
    device?: string;
    product?: string;
}

/** 解析 `adb devices -l` 输出为设备数组。 */
export function parseDevicesOutput(stdout: string): AdbDevice[] {
    const lines = stdout.split('\n');
    const out: AdbDevice[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        if (line.startsWith('List of devices')) continue;
        if (line.startsWith('*')) continue; // daemon 启动信息
        const parts = line.split(/\s+/);
        if (parts.length < 2) continue;
        const [serial, state] = parts;
        const dev: AdbDevice = { serial, state };
        for (const kv of parts.slice(2)) {
            const idx = kv.indexOf(':');
            if (idx < 0) continue;
            const k = kv.slice(0, idx);
            const v = kv.slice(idx + 1);
            if (k === 'model') dev.model = v;
            else if (k === 'device') dev.device = v;
            else if (k === 'product') dev.product = v;
        }
        out.push(dev);
    }
    return out;
}

/** 判定 `adb connect` 输出是否成功。 */
export function parseConnectResult(stdout: string): { ok: boolean; message: string } {
    const s = stdout.trim();
    if (/unable to connect|failed to connect|cannot connect/i.test(s)) return { ok: false, message: s };
    if (/already connected|connected to/i.test(s)) return { ok: true, message: s };
    return { ok: false, message: s || 'adb connect returned no output' };
}

/**
 * 把桥接 serial 解析为手机 adbd 的 TCP 地址（`ip:port` / `host:port` / `[ipv6]:port`）。
 * USB 序列号、模拟器名等非网络地址返回 null——直连模式只能连开启了 adb tcpip 的设备。
 */
export function parseHostPort(serial: string): { host: string; port: number } | null {
    const m = /^(?:\[([^\]]+)\]|([^:\s]+)):(\d{1,5})$/.exec((serial || '').trim());
    if (!m) return null;
    const port = Number(m[3]);
    if (port < 1 || port > 65535) return null;
    return { host: m[1] ?? m[2], port };
}
