import { SocksClient } from 'socks';
import { EventEmitter } from 'events';

// 池配置默认值（仅在调用方未提供对应键时生效）
const DEFAULT_POOL_CONFIG = {
  maxConnections: 10,
  idleTimeout: 30000,
  connectionTimeout: 10000,
  healthCheckInterval: 60000,
  waitTimeout: 0, // 0 → 回退为 connectionTimeout
  cleanupInterval: 10000,
  minConnections: 1,
  maxConnectionsLimit: 0, // 0 → maxConnections * 4
  retryAttempts: 0,
  retryDelay: 1000,
  retryBackoffFactor: 2,
  retryMaxDelay: 30000,
  prewarm: false,
  prewarmCount: 1,
  prewarmTargets: [],
  fallbackHost: '',
  fallbackPort: 0
};

/**
 * 解析 SOCKS5 连接池配置（C2-01 / D-038）。
 *
 * 优先级（高 → 低）：
 *   1. `config.socks5Pool`            —— 顶层兼容别名（README 使用的键）
 *   2. `config.upstreamSocks5.pool`   —— default.config.mjs 的规范位置
 *   3. `config.pool`                  —— 历史读取点，保留兼容
 *
 * 之所以别名优先：真实配置链里 `upstreamSocks5.pool` 永远存在（默认值），
 * 若规范键优先，别名将永远不可达 —— 正是本 chunk 要消灭的「有实现无消费者」。
 *
 * @param {Object} config 完整配置对象或扁平的隧道配置对象
 * @returns {Object} 合并后的池配置
 */
export function resolveSocks5PoolConfig(config = {}) {
  const sources = [];
  const push = (value) => {
    if (value && typeof value === 'object' && Object.keys(value).length > 0) {
      sources.push(value);
    }
  };

  push(config.socks5Pool);
  push(config.upstreamSocks5 && config.upstreamSocks5.pool);
  push(config.pool);

  const merged = {};
  for (let i = sources.length - 1; i >= 0; i--) {
    Object.assign(merged, sources[i]);
  }
  return merged;
}

/** 归一化预热目标：支持 'host:port'、'[ipv6]:port' 与 {host, port} */
function normalizePrewarmTargets(raw) {
  if (!Array.isArray(raw)) return [];
  const targets = [];
  for (const item of raw) {
    if (!item) continue;
    if (typeof item === 'string') {
      const parsed = parseHostPort(item);
      if (parsed) targets.push(parsed);
      continue;
    }
    if (typeof item === 'object' && item.host) {
      targets.push({ host: String(item.host), port: Number(item.port) });
    }
  }
  return targets;
}

/** 解析 'host:port' 与 '[ipv6]:port'（按最后一个冒号定界，IPv6 目标安全，C2-14/A15） */
function parseHostPort(value) {
  const text = String(value).trim();
  const bracketMatch = /^\[(.+)\]:(\d+)$/.exec(text);
  if (bracketMatch) {
    return { host: bracketMatch[1], port: Number(bracketMatch[2]) };
  }
  const index = text.lastIndexOf(':');
  if (index <= 0) return null;
  const host = text.slice(0, index);
  const port = Number(text.slice(index + 1));
  if (!host || !Number.isFinite(port)) return null;
  return { host, port };
}

/**
 * SOCKS5 连接池
 * 按目标（host:port）维护空闲/活跃连接，支持上限约束、排队、健康检查、
 * 指数退避重试、故障转移、预热与使用情况驱动的动态调整。
 */
export class Socks5ConnectionPool {
  constructor(config, poolConfig = {}) {
    this.config = config || {};
    this.poolConfig = { ...DEFAULT_POOL_CONFIG, ...(poolConfig || {}) };

    this.maxConnections = this.poolConfig.maxConnections;
    this.idleTimeout = this.poolConfig.idleTimeout;
    this.connectionTimeout = this.poolConfig.connectionTimeout;
    this.healthCheckInterval = this.poolConfig.healthCheckInterval;
    this.waitTimeout = this.poolConfig.waitTimeout || this.connectionTimeout;
    this.cleanupInterval = this.poolConfig.cleanupInterval;

    // 重试与退避（C2-09：原先传入即弃的死传参在这里被真实消费）
    this.retryAttempts = this.poolConfig.retryAttempts ?? 0;
    this.retryDelay = this.poolConfig.retryDelay ?? 1000;
    this.retryBackoffFactor = this.poolConfig.retryBackoffFactor ?? 2;
    this.retryMaxDelay = this.poolConfig.retryMaxDelay ?? 30000;

    // 预热（A11）
    this.prewarmEnabled = Boolean(this.poolConfig.prewarm);
    this.prewarmCount = this.poolConfig.prewarmCount ?? 1;
    this.prewarmTargets = normalizePrewarmTargets(this.poolConfig.prewarmTargets);

    // 动态调整边界（A13）
    this.minConnections = this.poolConfig.minConnections ?? 1;
    this.maxConnectionsLimit = this.poolConfig.maxConnectionsLimit
      || Math.max(this.maxConnections * 4, this.maxConnections + 1);

    // 故障转移备用上游（A12，可选）
    this.fallbackProxy = this.resolveFallbackProxy();

    // 建连入口：可注入（探针/测试用 stub，不改 node_modules）
    this.connectionFactory = typeof this.poolConfig.createConnection === 'function'
      ? this.poolConfig.createConnection
      : (options) => SocksClient.createConnection(options);

    // 连接池状态
    this.activeConnections = new Map(); // key -> Set<socket>
    this.idleConnections = new Map();   // key -> Array<{socket, lastUsed}>
    this.pendingRequests = new Map();   // key -> Array<waiter>
    this.creatingConnections = new Map(); // key -> 在建连预留数（避免并发突破 maxConnections）
    this.idleCursor = new Map();        // key -> 轮询游标（A14）

    // 统计信息
    this.stats = {
      connectionHits: 0,
      connectionMisses: 0,
      totalConnections: 0,
      waits: 0,
      waitedRequests: 0,
      totalWaitTime: 0,
      avgWaitTime: 0,
      prewarmed: 0,
      retries: 0,
      retryDelays: [],
      failovers: 0,
      failures: 0,
      healthChecks: 0,
      healthCheckRemovals: 0,
      dynamicAdjustments: 0,
      idleReaped: 0,
      releases: 0
    };

    this.closed = false;
    this.cleanupTimer = null;
    this.healthCheckTimer = null;
    // C2b（A1/A3）：在途的退避重试计时器集合 —— 既 unref（不阻止进程退出），
    // 也可由 close() 取消（真回收，唤醒等待中的重试循环）
    this.pendingBackoffs = new Set();

    // 启动空闲连接清理与健康检查
    this.startIdleCleanup();
    this.startHealthCheck();
  }

  resolveFallbackProxy() {
    const { fallbackHost, fallbackPort } = this.poolConfig;
    if (fallbackHost && fallbackPort) {
      return { host: fallbackHost, port: Number(fallbackPort) };
    }
    return null;
  }

  /** 目标键（IPv6 安全，C2-14/A15；三个 Map 共用同一键函数） */
  makeKey(host, port) {
    const h = String(host ?? '');
    const p = Number(port);
    return h.includes(':') ? `[${h}]:${p}` : `${h}:${p}`;
  }

  /** 目标参数校验与归一化（端口一律为 number） */
  validateDestination(dstIP, dstPort) {
    const host = String(dstIP ?? '');
    const port = Number(dstPort);
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
      const error = new Error(`Invalid SOCKS5 destination: ${dstIP}:${dstPort}`);
      error.code = 'INVALID_DESTINATION';
      throw error;
    }
    return { host, port };
  }

  /**
   * 获取连接（复用或创建；达上限则排队等待）
   * @param {string} dstIP - 目标IP
   * @param {number} dstPort - 目标端口
   * @returns {Promise<Object>} - SOCKS5连接socket
   */
  async getConnection(dstIP, dstPort) {
    const { host, port } = this.validateDestination(dstIP, dstPort);
    const key = this.makeKey(host, port);
    const startedAt = Date.now();

    if (this.closed) {
      const error = new Error('SOCKS5 connection pool is closed');
      error.code = 'POOL_CLOSED';
      throw error;
    }

    // 1. 复用空闲连接（轮询游标，C2-11/A14）
    const reused = this.takeIdleConnection(key);
    if (reused) {
      this.addToActive(key, reused);
      this.stats.connectionHits++;
      this.recordWait(startedAt);
      console.log(`SOCKS5 connection reused for ${key} (hit)`);
      return reused;
    }

    // 2. 未达上限 → 预留名额并建连（预留保证并发请求不会同时越过 maxConnections，A3）
    if (this.countInUse(key) < this.maxConnections) {
      return this.createWithReservation(host, port, key, startedAt);
    }

    // 3. 达上限 → 排队等待其他连接释放
    console.log(`SOCKS5 connection pool full for ${key}, waiting...`);
    return this.waitForConnection(key, host, port, startedAt);
  }

  async createWithReservation(host, port, key, startedAt) {
    this.reserveSlot(key);
    this.stats.connectionMisses++;
    console.log(`Creating new SOCKS5 connection for ${key} (miss)`);
    try {
      const socket = await this.createNewConnection(host, port, key);
      this.recordWait(startedAt);
      return socket;
    } finally {
      this.releaseSlot(key);
    }
  }

  /**
   * 预热：建立一个连接并直接放入空闲池（A11）
   * @returns {Promise<Object|null>} 预热出的 socket，达上限时为 null
   */
  async warmConnection(dstIP, dstPort) {
    const { host, port } = this.validateDestination(dstIP, dstPort);
    const key = this.makeKey(host, port);
    if (this.closed || this.countInUse(key) >= this.maxConnections) return null;

    this.reserveSlot(key);
    try {
      const socket = await this.createNewConnection(host, port, key);
      this.removeFromActive(key, socket);
      this.addToIdle(key, socket);
      this.stats.prewarmed++;
      console.log(`SOCKS5 pool prewarmed for ${key}`);
      return socket;
    } finally {
      this.releaseSlot(key);
    }
  }

  /**
   * 释放连接回连接池
   * @param {Object} socket - 要释放的socket
   * @param {string} dstIP - 目标IP
   * @param {number} dstPort - 目标端口
   */
  releaseConnection(socket, dstIP, dstPort) {
    const key = this.makeKey(dstIP, dstPort);
    this.stats.releases++;

    // 从活跃连接中移除
    this.removeFromActive(key, socket);

    if (socket && !socket.destroyed && socket.writable) {
      this.addToIdle(key, socket);
      console.log(`SOCKS5 connection released to idle pool for ${key}`);
    } else {
      console.log(`SOCKS5 connection invalid for ${key}, destroying`);
      this.destroySocket(socket);
    }

    // 无论如何都检查是否有等待的请求（A5：排队语义）
    this.checkPendingRequests(key);
  }

  /**
   * 创建新的SOCKS5连接（含指数退避重试与备用上游故障转移，C2-03/C2-09/C2-10）
   */
  async createNewConnection(dstIP, dstPort, key = this.makeKey(dstIP, dstPort), proxyOverride = null) {
    const attempts = Math.max(1, (this.retryAttempts ?? 0) + 1);
    let lastError = null;

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        const delay = this.computeBackoffDelay(attempt - 1);
        this.stats.retries++;
        this.stats.retryDelays.push(delay);
        console.warn(`SOCKS5 connection retry ${attempt}/${attempts - 1} for ${key} in ${delay}ms`);
        // C2b：退避等待 unref + 可被 close() 取消
        await this.backoffSleep(delay);
        if (this.closed) {
          const closedError = new Error('SOCKS5 connection pool closed during retry backoff');
          closedError.code = 'POOL_CLOSED';
          throw closedError;
        }
      }

      try {
        const socket = await this.createConnectionOnce(dstIP, dstPort, proxyOverride);
        this.addToActive(key, socket);
        this.stats.totalConnections++;
        console.log(`New SOCKS5 connection created for ${key}`);
        return socket;
      } catch (error) {
        lastError = error;
        console.error(`SOCKS5 connection attempt ${attempt + 1}/${attempts} failed for ${key}: ${error.message}`);
      }
    }

    // 主上游重试耗尽 → 备用路径（故障转移）
    if (this.fallbackProxy && !proxyOverride) {
      try {
        const socket = await this.createConnectionOnce(dstIP, dstPort, this.fallbackProxy);
        this.addToActive(key, socket);
        this.stats.totalConnections++;
        this.stats.failovers++;
        console.warn(`SOCKS5 connection created via fallback proxy for ${key}`);
        return socket;
      } catch (fallbackError) {
        lastError = fallbackError;
      }
    }

    this.stats.failures++;
    const error = new Error(`SOCKS5 connection failed after ${attempts} attempt(s): ${lastError ? lastError.message : 'unknown error'}`);
    error.code = 'SOCKS5_CONNECT_FAILED';
    error.attempts = attempts;
    error.cause = lastError;
    throw error;
  }

  /** 单次建连（可注入 connectionFactory 以便 stub） */
  async createConnectionOnce(dstIP, dstPort, proxyOverride = null) {
    const proxy = proxyOverride || { host: this.config.host, port: this.config.port };
    const options = {
      proxy: {
        host: proxy.host,
        port: proxy.port,
        type: 5
      },
      command: 'connect',
      destination: {
        host: dstIP,
        port: dstPort
      },
      timeout: this.connectionTimeout
    };

    // 添加认证信息（仅主上游）
    if (!proxyOverride && this.config.username && this.config.password) {
      options.proxy.userId = this.config.username;
      options.proxy.password = this.config.password;
    }

    const info = await this.connectionFactory(options);
    return info && info.socket ? info.socket : info;
  }

  /** 指数退避：retryDelay * factor^n，上限 retryMaxDelay（C2-10/A10） */
  computeBackoffDelay(retryIndex) {
    const base = Number(this.retryDelay) || 0;
    const factor = Number(this.retryBackoffFactor) || 1;
    const delay = Math.round(base * Math.pow(factor, retryIndex));
    return Math.min(delay, this.retryMaxDelay);
  }

  /**
   * 退避等待（C2b/A1/A3）：
   * - 计时器 `unref()`：隧道对象不再阻止进程自然退出；
   * - 登记进 `pendingBackoffs`：`close()` 可取消并立即唤醒（显式关闭时真回收，不留悬挂等待）。
   */
  backoffSleep(ms) {
    return new Promise((resolve) => {
      const entry = { timer: null, resolve: null };
      const finish = () => {
        if (entry.timer) clearTimeout(entry.timer);
        this.pendingBackoffs.delete(entry);
        resolve();
      };
      entry.resolve = finish;
      entry.timer = setTimeout(finish, ms);
      this.unrefTimer(entry.timer);
      this.pendingBackoffs.add(entry);
    });
  }

  /** 取消所有在途退避等待（close() 调用；立即唤醒，避免重试循环被悬挂） */
  cancelPendingBackoffs() {
    const cancelled = this.pendingBackoffs.size;
    for (const entry of [...this.pendingBackoffs]) {
      entry.resolve();
    }
    return cancelled;
  }

  /**
   * 等待连接释放（排队语义，A3/A5）
   */
  waitForConnection(key, host, port, startedAt) {
    return new Promise((resolve, reject) => {
      if (!this.pendingRequests.has(key)) {
        this.pendingRequests.set(key, []);
      }

      const entry = {
        host,
        port,
        startedAt,
        settled: false,
        resolve: null,
        reject: null
      };

      const timer = setTimeout(() => {
        const queue = this.pendingRequests.get(key);
        if (queue) {
          const index = queue.indexOf(entry);
          if (index !== -1) queue.splice(index, 1);
          if (queue.length === 0) this.pendingRequests.delete(key);
        }
        entry.settled = true;
        const error = new Error('SOCKS5 connection wait timeout');
        error.code = 'SOCKS5_WAIT_TIMEOUT';
        reject(error);
      }, this.waitTimeout);
      // C2b/A1：排队等待计时器同样 unref —— 隧道不得阻止进程自然退出；
      // 真回收路径：entry.resolve/reject 均 clearTimeout，close() 会 reject 所有在途 waiter 从而清理计时器
      this.unrefTimer(timer);

      entry.resolve = (socket) => {
        if (entry.settled) return;
        entry.settled = true;
        clearTimeout(timer);
        resolve(socket);
      };
      entry.reject = (error) => {
        if (entry.settled) return;
        entry.settled = true;
        clearTimeout(timer);
        reject(error);
      };

      this.pendingRequests.get(key).push(entry);
      this.stats.waits++;
    });
  }

  /**
   * 检查并处理等待的请求（键与目标参数均来自 waiter，不再从键串反解，C2-14/A15）
   */
  checkPendingRequests(key) {
    const queue = this.pendingRequests.get(key);
    if (!queue || queue.length === 0) return false;

    // 上限被动态放宽（A13）时可能一次唤醒多个等待者
    while (queue.length > 0 && this.countInUse(key) < this.maxConnections) {
      const entry = queue.shift();
      this.getConnection(entry.host, entry.port)
        .then((socket) => {
          this.recordWait(entry.startedAt);
          entry.resolve(socket);
        })
        .catch((error) => entry.reject(error));
    }

    if (queue.length === 0) this.pendingRequests.delete(key);
    return true;
  }

  /** 唤醒所有因池达上限而排队的 acquire 调用（释放 / 扩容 / 上限放宽后调用） */
  dispatchPending() {
    if (this._dispatching) return;
    this._dispatching = true;
    try {
      for (const key of [...this.pendingRequests.keys()]) {
        this.checkPendingRequests(key);
      }
    } finally {
      this._dispatching = false;
    }
  }

  /** 记录等待时长并聚合 avgWaitTime（C2-12/A5） */
  recordWait(startedAt) {
    const waited = Math.max(0, Date.now() - startedAt);
    this.stats.waitedRequests++;
    this.stats.totalWaitTime += waited;
    this.stats.avgWaitTime = this.stats.totalWaitTime / this.stats.waitedRequests;
  }

  /**
   * 动态调整：由使用情况驱动 maxConnections 变化（C2-03/A13）
   * 入口名与调用方式见 handoff/known_issues.md
   */
  adjustPoolSize() {
    const before = this.maxConnections;
    const inUse = this.totalInUse();
    const pending = this.totalPending();
    let next = before;

    if (pending > 0 || inUse >= before) {
      next = Math.min(this.maxConnectionsLimit, before + 1);
    } else if (inUse === 0 && before > this.minConnections) {
      next = Math.max(this.minConnections, before - 1);
    }

    if (next !== before) {
      this.maxConnections = next;
      this.stats.dynamicAdjustments++;
      console.log(`SOCKS5 pool maxConnections adjusted: ${before} -> ${next} (inUse=${inUse}, pending=${pending})`);
      if (next > before) this.dispatchPending();
    }
    return this.maxConnections;
  }

  /** 兼容别名（同一入口） */
  maybeAdjustPoolSize() {
    return this.adjustPoolSize();
  }

  totalInUse() {
    let total = 0;
    for (const sockets of this.activeConnections.values()) total += sockets.size;
    for (const count of this.creatingConnections.values()) total += count;
    return total;
  }

  totalPending() {
    let total = 0;
    for (const queue of this.pendingRequests.values()) total += queue.length;
    return total;
  }

  countInUse(key) {
    const active = this.activeConnections.get(key)?.size || 0;
    const creating = this.creatingConnections.get(key) || 0;
    return active + creating;
  }

  reserveSlot(key) {
    this.creatingConnections.set(key, (this.creatingConnections.get(key) || 0) + 1);
  }

  releaseSlot(key) {
    const current = this.creatingConnections.get(key) || 0;
    if (current <= 1) this.creatingConnections.delete(key);
    else this.creatingConnections.set(key, current - 1);
  }

  /** 轮询取出一个空闲连接（A14：不再恒取数组尾，C2-11） */
  takeIdleConnection(key) {
    const idlePool = this.idleConnections.get(key);
    if (!idlePool || idlePool.length === 0) return null;

    let cursor = this.idleCursor.get(key) || 0;
    while (idlePool.length > 0) {
      const index = cursor % idlePool.length;
      const [candidate] = idlePool.splice(index, 1);
      this.idleCursor.set(key, idlePool.length > 0 ? index % idlePool.length : 0);

      if (this.isHealthy(candidate.socket)) {
        if (idlePool.length === 0) this.idleConnections.delete(key);
        return candidate.socket;
      }

      console.log(`SOCKS5 connection invalid for ${key}, removing from pool`);
      this.destroySocket(candidate.socket);
      cursor = this.idleCursor.get(key) || 0;
    }

    this.idleConnections.delete(key);
    return null;
  }

  /** 连接可用性判据（复用与健康检查共用） */
  isHealthy(socket) {
    if (!socket) return false;
    if (socket.destroyed) return false;
    if (socket.writable === false) return false;
    if (socket.readable === false) return false;
    if (typeof socket.readyState === 'string' && socket.readyState !== 'open' && socket.readyState !== 'opening') {
      return false;
    }
    return true;
  }

  destroySocket(socket) {
    if (!socket) return;
    try {
      if (typeof socket.destroy === 'function') socket.destroy();
    } catch (error) {
      console.warn(`SOCKS5 pool: failed to destroy socket: ${error.message}`);
    }
  }

  /**
   * 启动空闲连接清理（定时器 unref，且 close() 时清除，C2-15/A16）
   */
  startIdleCleanup() {
    this.cleanupTimer = setInterval(() => {
      if (this.closed) return;
      this.reapIdleConnections();
    }, this.cleanupInterval);
    this.unrefTimer(this.cleanupTimer);
  }

  unrefTimer(timer) {
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  /** 回收超过 idleTimeout 的空闲连接 */
  reapIdleConnections() {
    const now = Date.now();
    let totalCleaned = 0;

    for (const [key, connections] of [...this.idleConnections.entries()]) {
      const alive = [];
      for (const conn of connections) {
        if (now - conn.lastUsed < this.idleTimeout && this.isHealthy(conn.socket)) {
          alive.push(conn);
        } else {
          this.destroySocket(conn.socket);
          totalCleaned++;
        }
      }
      if (alive.length > 0) this.idleConnections.set(key, alive);
      else this.idleConnections.delete(key);
    }

    this.stats.idleReaped += totalCleaned;
    if (totalCleaned > 0) {
      console.log(`SOCKS5 pool: cleaned ${totalCleaned} expired connections`);
    }

    // 使用情况驱动的动态调整（A13）
    this.adjustPoolSize();
    return totalCleaned;
  }

  /**
   * 启动周期健康检查（C2-02/A4；healthCheckInterval 的真实消费者）
   */
  startHealthCheck() {
    if (!this.healthCheckInterval || this.healthCheckInterval <= 0) return null;
    this.healthCheckTimer = setInterval(() => {
      if (this.closed) return;
      this.runHealthCheck();
    }, this.healthCheckInterval);
    this.unrefTimer(this.healthCheckTimer);
    return this.healthCheckTimer;
  }

  /** 探测池内连接：剔除不可用的空闲连接与已销毁的活跃连接 */
  runHealthCheck() {
    let removed = 0;

    for (const [key, connections] of [...this.idleConnections.entries()]) {
      const healthy = [];
      for (const conn of connections) {
        if (this.isHealthy(conn.socket)) healthy.push(conn);
        else {
          this.destroySocket(conn.socket);
          removed++;
        }
      }
      if (healthy.length > 0) this.idleConnections.set(key, healthy);
      else this.idleConnections.delete(key);
    }

    for (const [key, sockets] of [...this.activeConnections.entries()]) {
      for (const socket of [...sockets]) {
        if (!socket || socket.destroyed) {
          sockets.delete(socket);
          removed++;
        }
      }
      if (sockets.size === 0) this.activeConnections.delete(key);
    }

    this.stats.healthChecks++;
    this.stats.healthCheckRemovals += removed;
    if (removed > 0) {
      console.log(`SOCKS5 pool health check removed ${removed} unhealthy connection(s)`);
      this.dispatchPending();
    }
    return removed;
  }

  /**
   * 获取连接池统计信息（C2-12：新增 avgWaitTime 等聚合指标）
   */
  getStats() {
    const stats = { ...this.stats, retryDelays: [...this.stats.retryDelays] };
    stats.activeConnections = 0;
    stats.idleConnections = 0;
    stats.pendingRequests = 0;

    for (const connections of this.activeConnections.values()) {
      stats.activeConnections += connections.size;
    }

    for (const connections of this.idleConnections.values()) {
      stats.idleConnections += connections.length;
    }

    for (const requests of this.pendingRequests.values()) {
      stats.pendingRequests += requests.length;
    }

    stats.maxConnections = this.maxConnections;
    stats.minConnections = this.minConnections;
    stats.maxConnectionsLimit = this.maxConnectionsLimit;
    stats.idleTimeout = this.idleTimeout;
    stats.connectionTimeout = this.connectionTimeout;
    stats.healthCheckInterval = this.healthCheckInterval;
    stats.retryAttempts = this.retryAttempts;
    stats.retryDelay = this.retryDelay;
    stats.closed = this.closed;

    return stats;
  }

  /**
   * 关闭连接池（幂等；清除全部定时器与句柄，C2-15/A16）
   */
  close() {
    if (this.closed) return;
    this.closed = true;

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    for (const queue of this.pendingRequests.values()) {
      for (const entry of queue) {
        const error = new Error('SOCKS5 connection pool closed');
        error.code = 'POOL_CLOSED';
        entry.reject(error);
      }
    }
    this.pendingRequests.clear();

    // C2b/A3：取消在途退避等待并立即唤醒重试循环（真回收，不留悬挂计时器）
    const cancelledBackoffs = this.cancelPendingBackoffs();
    if (cancelledBackoffs > 0) {
      console.log(`SOCKS5 pool: cancelled ${cancelledBackoffs} pending retry backoff(s)`);
    }

    for (const connections of this.activeConnections.values()) {
      connections.forEach(socket => this.destroySocket(socket));
    }

    for (const connections of this.idleConnections.values()) {
      connections.forEach(conn => this.destroySocket(conn.socket));
    }

    this.activeConnections.clear();
    this.idleConnections.clear();
    this.creatingConnections.clear();
    this.idleCursor.clear();

    console.log('SOCKS5 connection pool closed');
  }

  // 辅助方法
  addToActive(key, socket) {
    if (!this.activeConnections.has(key)) {
      this.activeConnections.set(key, new Set());
    }
    this.activeConnections.get(key).add(socket);
  }

  removeFromActive(key, socket) {
    if (this.activeConnections.has(key)) {
      this.activeConnections.get(key).delete(socket);
      if (this.activeConnections.get(key).size === 0) {
        this.activeConnections.delete(key);
      }
    }
  }

  addToIdle(key, socket) {
    if (!this.idleConnections.has(key)) {
      this.idleConnections.set(key, []);
    }
    this.idleConnections.get(key).push({
      socket,
      lastUsed: Date.now()
    });
  }
}

class Socks5Tunnel extends EventEmitter {
  /**
   * @param {Object} config 隧道配置（扁平的上游配置，也可传完整配置对象）
   * @param {Object} [options] 可选扩展；options.pool 覆盖池配置
   */
  constructor(config = {}, options = {}) {
    super();
    this.config = config;
    this.client = null;
    // 连接语义：未调用 connect() 前不处于已连接状态（S5 H5-02）
    this.isConnected = false;
    this.retryCount = 0;

    // 初始化连接池（C2-01：显式解析池配置，支持 upstreamSocks5.pool 与顶层 socks5Pool 别名）
    this.poolConfig = resolveSocks5PoolConfig(config);
    if (options && options.pool && typeof options.pool === 'object') {
      Object.assign(this.poolConfig, options.pool);
    }

    // M-A（C2-09）：扁平 retry 链必须在池实例化**之前**回填进池配置。
    // 链路：load-balanced-connection-pool.mjs / connection-initializer.mjs 把
    // connectionPool.retryAttempts/retryDelay 扁平传入 → 此处回填 → 池真实消费。
    // 优先级：pool 显式键（upstreamSocks5.pool.retry* / socks5Pool.retry*）> 扁平键 > 内置默认。
    if (this.poolConfig.retryAttempts === undefined && config.retryAttempts !== undefined) {
      this.poolConfig.retryAttempts = config.retryAttempts;
    }
    if (this.poolConfig.retryDelay === undefined && config.retryDelay !== undefined) {
      this.poolConfig.retryDelay = config.retryDelay;
    }
    if (this.poolConfig.retryBackoffFactor === undefined && config.retryBackoffFactor !== undefined) {
      this.poolConfig.retryBackoffFactor = config.retryBackoffFactor;
    }

    this.connectionPool = new Socks5ConnectionPool(config, this.poolConfig);

    // 重试配置（与池实例同源：池配置为准，保证池行为与隧道回显一致，C2-09）
    this.retryAttempts = this.connectionPool.retryAttempts;
    this.retryDelay = this.connectionPool.retryDelay;

    // 默认错误监听器：错误路径真实 emit('error')（C2-08/D-034），此处兜底避免无监听者抛错
    this.on('error', (err) => {
      console.warn('SOCKS5 tunnel error (handled):', err && err.message ? err.message : err);
    });
  }

  /**
   * 初始化隧道：执行池预热并广播 connect 事件
   * @returns {Promise<number>} 预热的连接数
   */
  async connect() {
    const prewarmed = await this.prewarmPool();
    this.isConnected = true;
    this.retryCount = 0;
    console.log(`SOCKS5 tunnel initialized (connectionless mode)${prewarmed > 0 ? `, prewarmed ${prewarmed} connection(s)` : ''}`);
    this.emit('connect');
    return prewarmed;
  }

  /**
   * 连接预热（C2-03/A11）：为 pool.prewarmTargets 建立 prewarmCount 条空闲连接
   */
  async prewarmPool() {
    const pool = this.connectionPool;
    if (!pool.prewarmEnabled) return 0;
    if (pool.prewarmTargets.length === 0) {
      console.warn('SOCKS5 prewarm enabled but no prewarmTargets configured; skipping prewarm');
      return 0;
    }

    let created = 0;
    for (const target of pool.prewarmTargets) {
      const count = Math.max(1, Math.min(pool.prewarmCount, pool.maxConnections));
      for (let i = 0; i < count; i++) {
        try {
          const socket = await pool.warmConnection(target.host, target.port);
          if (socket) created++;
        } catch (error) {
          const wrapped = new Error(`SOCKS5 prewarm failed for ${target.host}:${target.port}: ${error.message}`);
          wrapped.code = 'SOCKS5_PREWARM_FAILED';
          wrapped.cause = error;
          this.emit('error', wrapped);
        }
      }
    }
    return created;
  }

  async forwardOut(srcIP, srcPort, dstIP, dstPort) {
    console.log(`SOCKS5 forwardOut called: ${srcIP}:${srcPort} -> ${dstIP}:${dstPort}`);
    console.log(`SOCKS5 connection status: isConnected=${this.isConnected}`);

    // 检查隧道是否配置正确
    if (!this.config || !this.config.host || !this.config.port) {
      const error = new Error('SOCKS5 tunnel not properly configured');
      error.code = 'SOCKS5_NOT_CONFIGURED';
      console.error('SOCKS5 forwardOut error:', error.message);
      this.emit('error', error);
      throw error;
    }

    try {
      // 从连接池获取连接
      const socket = await this.connectionPool.getConnection(dstIP, dstPort);

      // 监听连接关闭事件，自动释放
      const releaseConnection = () => {
        this.connectionPool.releaseConnection(socket, dstIP, dstPort);
      };

      socket.once('close', releaseConnection);
      socket.once('error', releaseConnection);

      console.log('SOCKS5 connection obtained from pool for forwarding');
      return socket;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('SOCKS5 forwardOut error:', err.message);
      // 错误语义统一走事件（C2-08/D-034：事件有真实消费者），再由 Promise 拒绝回给调用方
      this.emit('error', err);
      throw err;
    }
  }

  close() {
    // 关闭连接池
    if (this.connectionPool) this.connectionPool.close();
    this.isConnected = false;
    console.log('SOCKS5 tunnel and connection pool closed');
    // 生命周期通知（C2-06/A9）
    this.emit('close');
  }

  /**
   * 获取连接池统计信息
   */
  getPoolStats() {
    return this.connectionPool.getStats();
  }

  /**
   * 动态调整入口（A13）：按当前使用情况调整每目标连接上限
   */
  adjustPoolSize() {
    return this.connectionPool.adjustPoolSize();
  }
}

export default Socks5Tunnel;
