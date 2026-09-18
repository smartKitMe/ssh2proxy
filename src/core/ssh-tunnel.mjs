import { Client } from 'ssh2';
import { EventEmitter } from 'events';

// SSH 重试的内置默认（`retryAttempts`/`retryDelay` 亦由 default.config.mjs 的 ssh.* 提供）。
// 注意（已知缺口）：`retryBackoffFactor` / `retryMaxDelay` **未在 `src/config/default.config.mjs` 的 `ssh` 段定义**，
// 也未出现在任何示例配置中（该缺口已在 `CLAUDE.md` 的「易漏键」表补记），只能靠这里的声明默认生效；
// 同名键在 `upstreamSocks5.pool` 下有定义。
// 补默认键属改行为，已登记为跨 chunk 申请（见 `tasks/D4-docs/handoff/cross_chunk_request.md` 的 CC-D4-1）。
const DEFAULT_RETRY = {
  retryAttempts: 3,
  retryDelay: 5000,
  retryBackoffFactor: 2,
  retryMaxDelay: 30000
};

class SSHTunnel extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = config;
    this.client = new Client();
    this.isConnected = false;
    this.retryCount = 0;
    this.lastRetryDelay = 0;
    this.retryTimer = null;
  }

  get retryAttempts() {
    return this.config?.retryAttempts ?? DEFAULT_RETRY.retryAttempts;
  }

  get retryDelay() {
    return this.config?.retryDelay ?? DEFAULT_RETRY.retryDelay;
  }

  /**
   * 指数退避延迟（C2-10）：retryDelay * factor^n，上限 retryMaxDelay
   * @param {number} retryIndex 第几次重试（从 0 开始）
   */
  computeBackoffDelay(retryIndex) {
    const base = Number(this.retryDelay) || 0;
    const factor = Number(this.config?.retryBackoffFactor ?? DEFAULT_RETRY.retryBackoffFactor);
    const max = Number(this.config?.retryMaxDelay ?? DEFAULT_RETRY.retryMaxDelay);
    return Math.min(Math.round(base * Math.pow(factor, retryIndex)), max);
  }

  async connect() {
    // 新的一轮连接序列：重试计数从 0 开始，序列内累计递增（不退避归零）
    this.retryCount = 0;
    return this.attemptConnect(0);
  }

  /**
   * 单次连接尝试；失败且未耗尽重试次数时按指数退避重新尝试（C2-10/C2-13）
   * @param {number} attempt 已失败次数
   */
  attemptConnect(attempt) {
    return new Promise((resolve, reject) => {
      // C2-13：每次尝试重建 Client，避免对同一实例重复注册 ready/error/close/end 监听器
      this.disposeClient();
      const client = new Client();
      this.client = client;
      let settled = false;

      client.on('ready', () => {
        if (settled) return;
        settled = true;
        this.isConnected = true;
        this.emit('connect');
        resolve();
      });

      client.on('error', (err) => {
        if (settled) return;
        this.isConnected = false;
        this.emitTunnelError(err);

        // 实现重试机制（指数退避，退避状态在序列内累计，不因 ready 归零而丢失）
        if (attempt < this.retryAttempts) {
          const delay = this.computeBackoffDelay(attempt);
          this.retryCount = attempt + 1;
          this.lastRetryDelay = delay;
          this.emit('retry', { attempt: this.retryCount, delay });
          settled = true;
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.attemptConnect(attempt + 1).then(resolve).catch(reject);
          }, delay);
        } else {
          settled = true;
          reject(err);
        }
      });

      client.on('close', () => {
        this.isConnected = false;
        this.emit('close');
      });

      client.on('end', () => {
        this.isConnected = false;
        this.emit('end');
      });

      try {
        client.connect({
          host: this.config.host,
          port: this.config.port,
          username: this.config.username,
          password: this.config.password || undefined,
          privateKey: this.config.privateKey || undefined,
          passphrase: this.config.passphrase || undefined,
          keepaliveInterval: this.config.keepaliveInterval
        });
      } catch (err) {
        // 同步抛出与异步失败走同一退避路径
        client.emit('error', err);
      }
    });
  }

  /**
   * 错误事件必须有消费者；无监听者时 emit('error') 会抛出并终止进程，
   * 因此无监听者时降级为 console.error（错误仍通过 reject 回传调用方）
   */
  emitTunnelError(err) {
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
      return;
    }
    console.error('SSH tunnel error (no listener):', err && err.message ? err.message : err);
  }

  disposeClient() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (!this.client) return;
    try {
      this.client.removeAllListeners();
    } catch (err) {
      console.warn('Failed to detach SSH client listeners:', err && err.message ? err.message : err);
    }
    try {
      this.client.end();
    } catch (err) {
      console.warn('Failed to end SSH client:', err && err.message ? err.message : err);
    }
  }

  forwardOut(srcIP, srcPort, dstIP, dstPort) {
    return new Promise((resolve, reject) => {
      if (!this.isConnected) {
        reject(new Error('SSH connection is not established'));
        return;
      }

      this.client.forwardOut(srcIP, srcPort, dstIP, dstPort, (err, stream) => {
        if (err) {
          reject(err);
        } else {
          resolve(stream);
        }
      });
    });
  }

  close() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.client) {
      this.client.end();
    }
    this.isConnected = false;
    // 生命周期通知（C2-06/A9）
    this.emit('close');
  }
}

export default SSHTunnel;
