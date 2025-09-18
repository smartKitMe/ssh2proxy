import SSHTunnel from './ssh-tunnel.mjs';

class ConnectionPool {
  constructor(config) {
    this.config = config;
    this.pool = [];
    this.usedConnections = [];
    this.maxSize = config.connectionPool.maxSize;
    this.minSize = config.connectionPool.minSize;
    this.acquireTimeout = config.connectionPool.acquireTimeout;
    this.idleTimeout = config.connectionPool.idleTimeout;
  }

  async initialize() {
    // 预初始化连接
    for (let i = 0; i < this.minSize; i++) {
      try {
        const connection = new SSHTunnel(this.config.ssh);
        await connection.connect();
        this.pool.push({
          connection,
          lastUsed: Date.now()
        });
      } catch (err) {
        console.error('Failed to initialize connection:', err);
      }
    }
  }

  async acquire() {
    // 首先检查池中是否有可用连接
    if (this.pool.length > 0) {
      const pooled = this.pool.pop();
      this.usedConnections.push(pooled);
      return pooled.connection;
    }

    // 如果池中没有可用连接且未达到最大连接数，则创建新连接
    if (this.usedConnections.length + this.pool.length < this.maxSize) {
      const connection = new SSHTunnel(this.config.ssh);
      await connection.connect();
      const pooled = {
        connection,
        lastUsed: Date.now()
      };
      this.usedConnections.push(pooled);
      return connection;
    }

    // 如果达到最大连接数，则等待可用连接
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection acquire timeout'));
      }, this.acquireTimeout);

      const check = () => {
        if (this.pool.length > 0) {
          clearTimeout(timeout);
          const pooled = this.pool.pop();
          this.usedConnections.push(pooled);
          resolve(pooled.connection);
        } else if (this.usedConnections.length + this.pool.length < this.maxSize) {
          clearTimeout(timeout);
          this.acquire().then(resolve).catch(reject);
        } else {
          setTimeout(check, 100);
        }
      };

      check();
    });
  }

  release(connection) {
    const index = this.usedConnections.findIndex(pooled => pooled.connection === connection);
    if (index !== -1) {
      const pooled = this.usedConnections.splice(index, 1)[0];
      pooled.lastUsed = Date.now();
      this.pool.push(pooled);
    }
  }

  async close() {
    // 关闭所有连接
    for (const pooled of this.pool) {
      pooled.connection.close();
    }
    for (const pooled of this.usedConnections) {
      pooled.connection.close();
    }
    this.pool = [];
    this.usedConnections = [];
  }

  // 清理空闲连接
  cleanupIdleConnections() {
    const now = Date.now();
    this.pool = this.pool.filter(pooled => {
      if (now - pooled.lastUsed > this.idleTimeout) {
        pooled.connection.close();
        return false;
      }
      return true;
    });
  }
}

export default ConnectionPool;