import Deferred from './Deferred';

const MAX_CONNECTIONS = 3;
const MAX_ACTIVE_BYTES = 9 * 1024 * 1024;
const managers = new Map<number, DcBandwidthManager>();

export function getDcBandwidthManager(dcId: number, _isPremium: boolean) {
  let manager = managers.get(dcId);
  if (!manager) {
    manager = new DcBandwidthManager();
    managers.set(dcId, manager);
  }
  return manager;
}

class DcBandwidthManager {
  private activeBytes = 0;
  private activeConnections = 0;
  private readonly queue: Array<{ bytes: number; deferred: Deferred }> = [];

  async requestWorker(_priority: boolean, bytes: number) {
    if (this.activeConnections >= MAX_CONNECTIONS || this.activeBytes + bytes > MAX_ACTIVE_BYTES) {
      const deferred = new Deferred();
      this.queue.push({ bytes, deferred });
      await deferred.promise;
    }
    this.activeConnections += 1;
    this.activeBytes += bytes;
    return 0;
  }

  releaseWorker(_worker: number, bytes: number) {
    this.activeConnections = Math.max(0, this.activeConnections - 1);
    this.activeBytes = Math.max(0, this.activeBytes - bytes);
    const next = this.queue.shift();
    next?.deferred.resolve();
  }

  getForeman(_index: number) {
    return {
      requestWorker: async (_bytes: number) => undefined,
      releaseWorker: (_bytes: number) => undefined,
    };
  }
}
