import SSHTunnel from './ssh-tunnel.mjs';
import Socks5Tunnel, { resolveSocks5PoolConfig } from './socks-tunnel.mjs';

class ConnectionInitializer {
  constructor(connectionPool, config) {
    this.connectionPool = connectionPool;
    this.config = config;
    this.maintenanceTimers = [];
  }

  async initializeConnections() {
    console.log('Initializing connections...');
    try {
      await this.connectionPool.initialize();
      const status = this.connectionPool.getStatus();
      console.log(`Initialized ${status.total} connections`);
      return status;
    } catch (err) {
      console.error('Failed to initialize connections:', err);
      return null;
    }
  }

  // 定期检查并维护连接池
  startMaintenance() {
    // 每30秒清理一次空闲连接
    const cleanupTimer = setInterval(() => {
      this.maintainIdleConnections();
    }, 30000);

    // 每分钟检查连接池大小，如果小于最小值则补充连接
    const refillTimer = setInterval(() => {
      this.maintainConnectionPool().catch(err => {
        console.error('Failed to run pool maintenance:', err && err.message ? err.message : err);
      });
    }, 60000);

    // 维护定时器不得单独拖住进程退出（A16 同源治理）
    this.maintenanceTimers = [cleanupTimer, refillTimer];
    for (const timer of this.maintenanceTimers) {
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
    return this.maintenanceTimers;
  }

  stopMaintenance() {
    for (const timer of this.maintenanceTimers) {
      clearInterval(timer);
    }
    this.maintenanceTimers = [];
  }

  maintainIdleConnections() {
    try {
      return this.connectionPool.cleanupIdleTunnels();
    } catch (err) {
      console.error('Failed to cleanup idle tunnels:', err && err.message ? err.message : err);
      return 0;
    }
  }

  /**
   * 补建连接至 minSize，并在补建完成后重新取状态打印（C2-17/A15 STATUS_AFTER_FILL）
   * @returns {Promise<{before: Object, after: Object, created: number}>}
   */
  async maintainConnectionPool() {
    const before = this.connectionPool.getStatus();
    const minSize = this.config.connectionPool?.minSize ?? 0;
    let created = 0;

    if (before.total < minSize) {
      const connectionsToCreate = minSize - before.total;
      console.log(`Connection pool size (${before.total}) is below minimum (${minSize}), creating ${connectionsToCreate} new connections`);

      for (let i = 0; i < connectionsToCreate; i++) {
        try {
          const connection = this.createTunnelInstance();

          // 添加错误监听器，防止未捕获异常
          if (typeof connection.on === 'function') {
            connection.on('error', (err) => {
              console.warn('Connection error during maintenance:', err && err.message ? err.message : err);
            });
          }
          await connection.connect();
          this.connectionPool.pool.push({
            tunnel: connection,
            connectionCount: 0,
            lastUsed: Date.now(),
            isActive: true
          });
          created++;
          console.log('Successfully created new connection for pool');
        } catch (err) {
          console.error('Failed to maintain connection pool:', err);
        }
      }
    }

    // 状态快照必须在补建之后重新获取，否则日志数量与实际不符（C2-17）
    const after = this.connectionPool.getStatus();
    console.log(`Connection pool status: ${after.available} available, ${after.used} used, ${after.total} total`);
    return { before, after, created };
  }

  /** 按配置创建隧道实例（两个构造点之一，C2-01 池配置同样在这里贯通） */
  createTunnelInstance() {
    if (this.config.tunnel?.type === 'socks5') {
      const socks5Config = this.config.upstreamSocks5 || {};
      return new Socks5Tunnel({
        host: socks5Config.host,
        port: socks5Config.port,
        username: socks5Config.username,
        password: socks5Config.password,
        // C2-09：重试配置真实消费
        retryAttempts: this.config.connectionPool?.retryAttempts,
        retryDelay: this.config.connectionPool?.retryDelay,
        // C2-01：池参数真实贯通（含 upstreamSocks5.pool 与顶层 socks5Pool 别名）
        pool: resolveSocks5PoolConfig(this.config)
      });
    }
    return new SSHTunnel(this.config.ssh);
  }
}

export default ConnectionInitializer;
