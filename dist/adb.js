import { ADB } from 'appium-adb';
import { parseConnectResult, } from './adb-parse.js';
export class AdbNotFoundError extends Error {
}
// ── appium-adb 单例（懒初始化） ──
let adbInstance;
let adbInitPromise;
/**
 * 获取 appium-adb 实例（单例，首次调用时初始化）。
 * 默认读取环境变量 PHONE_AGENT_ADB_SERVER_HOST / PORT，与 server.ts 保持一致。
 * 使用 PATH 上的 adb 二进制，不依赖 ANDROID_HOME。
 */
export function getAdb(addr) {
    if (adbInstance)
        return Promise.resolve(adbInstance);
    if (!adbInitPromise) {
        const host = addr?.host || process.env.PHONE_AGENT_ADB_SERVER_HOST || '127.0.0.1';
        const port = addr?.port || Number(process.env.PHONE_AGENT_ADB_SERVER_PORT || 5037);
        adbInitPromise = ADB.createADB({
            adbHost: host,
            adbPort: port,
            adbExecTimeout: 15_000,
            suppressKillServer: true,
        }).then((inst) => {
            adbInstance = inst;
            return inst;
        }).catch((err) => {
            adbInitPromise = undefined; // 允许重试
            const msg = String(err?.message || err);
            if (msg.includes('ENOENT') || msg.includes('not found') || msg.includes('Could not find')) {
                throw new AdbNotFoundError('adb not found on PATH');
            }
            throw err;
        });
    }
    return adbInitPromise;
}
export async function adbConnect(host, port, addr) {
    const adb = await getAdb(addr);
    const stdout = await adb.adbExec(['connect', `${host}:${port}`]);
    return parseConnectResult(stdout);
}
export async function adbDevices(addr) {
    const adb = await getAdb(addr);
    const devices = await adb.getConnectedDevices({ verbose: true });
    // appium-adb 返回 { udid, state, product?, model?, device? }，映射到我们的 AdbDevice
    return devices.map((d) => ({
        serial: d.udid,
        state: d.state,
        model: d.model || undefined,
        product: d.product || undefined,
        device: d.device || undefined,
    }));
}
export async function adbDisconnect(serial, addr) {
    const adb = await getAdb(addr);
    const stdout = await adb.adbExec(['disconnect', serial]);
    return { ok: true, message: stdout.trim() };
}
