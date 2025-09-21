import SSHTunnel from './ssh-tunnel.mjs';
import Socks5Tunnel from './socks-tunnel.mjs';

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
            let connection;
            // 根据配置选择隧道类型
            if (this.config.tunnel?.type === 'socks5') {
              connection = new Socks5Tunnel({
                host: this.config.upstreamSocks5.host,
                port: this.config.upstreamSocks5.port,
                username: this.config.upstreamSocks5.username,
                password: this.config.upstreamSocks5.password,
                retryAttempts: this.config.connectionPool.retryAttempts,
                retryDelay: this.config.connectionPool.retryDelay
              });
            } else {
              connection = new SSHTunnel(this.config.ssh);
            }
            
            // 添加错误监听器，防止未捕获异常
            connection.on('error', (err) => {
              console.warn('Connection error during maintenance:', err.message);
            });
            await connection.connect();
            this.connectionPool.pool.push({
              tunnel: connection,
              connectionCount: 0,
              lastUsed: Date.now(),
              isActive: true
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