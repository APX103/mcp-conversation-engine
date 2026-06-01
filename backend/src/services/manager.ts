import { fork, ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface ServiceInfo {
  id: string;
  name: string;
  port: number;
  status: "starting" | "running" | "stopped" | "error";
  pid?: number;
  startedAt?: string;
  error?: string;
  logs?: string[];
}

export class ServiceManager {
  private services = new Map<string, ServiceInfo>();
  private processes = new Map<string, ChildProcess>();
  private portPool: number[];
  private usedPorts = new Set<number>();
  private logBuffers = new Map<string, string[]>();

  constructor(
    private portStart: number = 9990,
    private portEnd: number = 9999,
  ) {
    this.portPool = [];
    for (let i = portStart; i <= portEnd; i++) {
      this.portPool.push(i);
    }
  }

  getAvailablePorts(): { start: number; end: number; available: number[] } {
    return {
      start: this.portStart,
      end: this.portEnd,
      available: this.portPool.filter((p) => !this.usedPorts.has(p)),
    };
  }

  listServices(): ServiceInfo[] {
    return Array.from(this.services.values());
  }

  getService(id: string): ServiceInfo | undefined {
    return this.services.get(id);
  }

  async createService(
    code: string,
    opts?: { name?: string; env?: Record<string, string> },
  ): Promise<ServiceInfo> {
    const port = this.allocatePort();
    if (port === null) throw new Error("No available ports in pool");

    const id = opts?.name || `svc-${Date.now()}`;
    if (this.services.has(id)) throw new Error(`Service "${id}" already exists`);

    const tmpDir = os.tmpdir();
    const filePath = path.join(tmpDir, `${id}-${Date.now()}.mjs`);
    const finalCode = code;
    fs.writeFileSync(filePath, finalCode);

    const logBuf: string[] = [];
    this.logBuffers.set(id, logBuf);

    const child = fork(filePath, [], {
      env: {
        ...process.env,
        SERVICE_PORT: String(port),
        SERVICE_ID: id,
        ...(opts?.env || {}),
      },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });

    const info: ServiceInfo = {
      id,
      name: id,
      port,
      status: "starting",
      pid: child.pid,
      startedAt: new Date().toISOString(),
      logs: logBuf,
    };
    this.services.set(id, info);
    this.processes.set(id, child);

    child.stdout?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      logBuf.push(line);
      if (logBuf.length > 200) logBuf.shift();
      if (info.status === "starting") info.status = "running";
    });

    child.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      logBuf.push(`[stderr] ${line}`);
      if (logBuf.length > 200) logBuf.shift();
    });

    child.on("exit", (code, signal) => {
      info.status = signal ? "error" : "stopped";
      info.logs?.push(`[exit] code=${code} signal=${signal}`);
      this.usedPorts.delete(port);
      this.processes.delete(id);
      try { fs.unlinkSync(filePath); } catch {}
    });

    child.on("error", (err) => {
      info.status = "error";
      info.error = err.message;
      info.logs?.push(`[error] ${err.message}`);
      this.usedPorts.delete(port);
      this.processes.delete(id);
    });

    // Wait briefly for startup
    await new Promise((r) => setTimeout(r, 200));
    return info;
  }

  stopService(id: string): boolean {
    const child = this.processes.get(id);
    const info = this.services.get(id);
    if (!child || !info) return false;

    child.kill("SIGTERM");
    setTimeout(() => {
      if (this.processes.has(id)) child.kill("SIGKILL");
    }, 3000);
    return true;
  }

  getServiceLogs(id: string, tail = 50): string[] {
    const info = this.services.get(id);
    if (!info?.logs) return [];
    return info.logs.slice(-tail);
  }

  stopAll(): void {
    for (const id of this.processes.keys()) {
      this.stopService(id);
    }
  }

  private allocatePort(): number | null {
    for (const p of this.portPool) {
      if (!this.usedPorts.has(p)) {
        this.usedPorts.add(p);
        return p;
      }
    }
    return null;
  }
}
