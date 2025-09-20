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
      const status = this.connectionPool.getStatus();
      console.log(`Initialized ${status.total} connections`);
    } catch (err) {
      console.error('Failed to initialize connections:', err);
    }
  }

  // 定期检查并维护连接池
  startMaintenance() {
    // 每30秒清理一次空闲连接
    setInterval(() => {
      this.connectionPool.cleanupIdleTunnels();
    }, 30000);

    // 每分钟检查连接池大小，如果小于最小值则补充连接
    setInterval(async () => {
      const status = this.connectionPool.getStatus();
      const currentSize = status.total;
      if (currentSize < this.config.connectionPool.minSize) {
        const connectionsToCreate = this.config.connectionPool.minSize - currentSize;
        console.log(`Connection pool size (${currentSize}) is below minimum (${this.config.connectionPool.minSize}), creating ${connectionsToCreate} new connections`);
        
        for (let i = 0; i < connectionsToCreate; i++) {
          try {
            const connection = new SSHTunnel(this.config.ssh);
            await connection.connect();
            this.connectionPool.pool.push({
              connection,
              lastUsed: Date.now()
            });
            console.log('Successfully created new connection for pool');
          } catch (err) {
            console.error('Failed to maintain connection pool:', err);
          }
        }
      }
      
      // 输出连接池状态信息
      console.log(`Connection pool status: ${status.available} available, ${status.used} used, ${status.total} total`);
    }, 60000);
  }
}

export default ConnectionInitializer;