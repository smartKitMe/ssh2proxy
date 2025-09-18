import SSHTunnel from './ssh-tunnel.mjs';

class ConnectionInitializer {
  constructor(connectionPool, config) {
    this.connectionPool = connectionPool;
    this.config = config;
  }

  async initializeConnections() {
    console.log('Initializing connections...');
    try {
      await this.connectionPool.initialize();
      console.log(`Initialized ${this.connectionPool.pool.length} connections`);
    } catch (err) {
      console.error('Failed to initialize connections:', err);
    }
  }

  // 定期检查并维护连接池
  startMaintenance() {
    // 每30秒清理一次空闲连接
    setInterval(() => {
      this.connectionPool.cleanupIdleConnections();
    }, 30000);

    // 每分钟检查连接池大小，如果小于最小值则补充连接
    setInterval(async () => {
      if (this.connectionPool.pool.length + this.connectionPool.usedConnections.length < this.config.connectionPool.minSize) {
        try {
          const connection = new SSHTunnel(this.config.ssh);
          await connection.connect();
          this.connectionPool.pool.push({
            connection,
            lastUsed: Date.now()
          });
        } catch (err) {
          console.error('Failed to maintain connection pool:', err);
        }
      }
    }, 60000);
  }
}

export default ConnectionInitializer;