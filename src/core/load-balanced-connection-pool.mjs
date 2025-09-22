import SSHTunnel from './ssh-tunnel.mjs';
import Socks5Tunnel from './socks-tunnel.mjs';

/**
 * 负载均衡连接池类
 * 允许多个连接共享同一个SSH隧道，提高资源利用率
 */
class LoadBalancedConnectionPool {
  /**
   * 构造函数
   * @param {Object} config 连接池配置
   */
  constructor(config) {
    this.config = config;
    this.pool = []; // 可用隧道池
    this.usedTunnels = []; // 正在使用的隧道列表
    this.maxSize = config.connectionPool.maxSize;
    this.minSize = config.connectionPool.minSize;
    this.acquireTimeout = config.connectionPool.acquireTimeout;
    this.idleTimeout = config.connectionPool.idleTimeout;
    this.maxConnectionsPerTunnel = config.connectionPool.maxConnectionsPerTunnel || 10;
    this.loadBalancingStrategy = config.connectionPool.loadBalancingStrategy || 'least-connections';
    // 确定隧道类型，默认为ssh
    this.tunnelType = config.tunnel?.type || 'ssh';

    // 维护隧道使用率排序列表，避免每次遍历所有隧道
    this.sortedTunnelList = [];
  }

  /**
   * 初始化连接池，创建最小数量的隧道连接
   */
  async initialize() {
    console.log(`Initializing load balanced connection pool with ${this.tunnelType} tunnels...`);
    // 预初始化连接
    for (let i = 0; i < this.minSize; i++) {
      try {
        const tunnelObject = await this.createTunnel();
        this.pool.push(tunnelObject);
        console.log(`Initialized tunnel ${i + 1}/${this.minSize}`);
      } catch (err) {
        console.error('Failed to initialize tunnel:', err);
      }
    }
    // 初始化排序列表
    this.updateSortedTunnelList();
  }

  /**
   * 创建新的隧道（根据配置选择SSH或SOCKS5）
   * @returns {Promise<Object>} 隧道对象
   */
  async createTunnel() {
    let tunnel;
    console.log(`Creating tunnel of type: ${this.tunnelType}`);
    if (this.tunnelType === 'socks5') {
      // 使用SOCKS5隧道配置
      console.log('Using SOCKS5 configuration:', {
        host: this.config.upstreamSocks5.host,
        port: this.config.upstreamSocks5.port,
        username: this.config.upstreamSocks5.username ? '***' : 'none'
      });
      tunnel = new Socks5Tunnel({
        host: this.config.upstreamSocks5.host,
        port: this.config.upstreamSocks5.port,
        username: this.config.upstreamSocks5.username,
        password: this.config.upstreamSocks5.password,
        retryAttempts: this.config.connectionPool.retryAttempts,
        retryDelay: this.config.connectionPool.retryDelay
      });
    } else {
      // 默认使用SSH隧道
      console.log('Using SSH configuration');
      tunnel = new SSHTunnel(this.config.ssh);
      tunnel.on('error', (err) => {
        console.error('SSH tunnel error:', err);
      });
    }
    
    console.log('Connecting to tunnel...');
    await tunnel.connect();
    console.log('Tunnel connected successfully');

    const tunnelObject = {
      tunnel,
      connectionCount: 0,
      lastUsed: Date.now(),
      isActive: true
    };

    return tunnelObject;
  }

  /**
   * 更新隧道使用率排序列表
   */
  updateSortedTunnelList() {
    const allTunnels = [...this.usedTunnels];
    this.sortedTunnelList = allTunnels.sort((a, b) => {
      return a.connectionCount - b.connectionCount;
    });
  }

  /**
   * 获取使用率最低的隧道
   * @returns {Object|null} 隧道对象或null
   */
  getLeastUsedTunnel() {
    if (this.sortedTunnelList.length === 0) {
      return null;
    }
    return this.sortedTunnelList[0];
  }

  /**
   * 获取一个SSH隧道实例用于连接
   * @returns {Promise<SSHTunnel>}
   */
  async acquire() {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const timeout = setTimeout(() => {
        reject(new Error('Connection acquire timeout'));
      }, this.acquireTimeout);

      const doAcquire = async () => {
        try {
          // 根据负载均衡策略选择隧道
          let tunnelObject = null;

          switch (this.loadBalancingStrategy) {
          case 'least-connections':
            tunnelObject = await this.acquireWithLeastConnectionsStrategy();
            break;
          default:
            tunnelObject = await this.acquireWithLeastConnectionsStrategy();
          }

          if (!tunnelObject) {
            throw new Error('Failed to acquire tunnel from pool');
          }

          tunnelObject.connectionCount++;
          if (tunnelObject.connectionCount >= this.maxConnectionsPerTunnel && !this.createTunnelTime) {
            this.createTunnelTime = setImmediate(async() => {
              const newTunnelObject = await this.createTunnel();
              this.pool.push(newTunnelObject);
              console.log(`Created new tunnel, total pool size: ${this.pool.length}, tunnelObject count: ${tunnelObject.connectionCount}`);
              clearImmediate(this.createTunnelTime);
            });
          }
          clearTimeout(timeout);

          // 记录分配时间，用于性能监控
          const acquireTime = Date.now() - startTime;
          if (acquireTime > 100) {
            console.warn(`Tunnel acquisition took ${acquireTime}ms, which is longer than expected`);
          }

          resolve(tunnelObject.tunnel);
        } catch (err) {
          clearTimeout(timeout);
          reject(err);
        }
      };

      doAcquire();
    });
  }

  /**
   * 使用最少连接数策略获取隧道
   * @returns {Promise<Object>} 隧道对象
   */
  async acquireWithLeastConnectionsStrategy() {
    // 首先检查池中是否有可用隧道且未达连接阈值
    if (this.pool.length > 0) {
      const tunnelObj = this.pool.pop();
      this.usedTunnels.push(tunnelObj);
      return tunnelObj;
    }

    if (this.usedTunnels.length > 0) {
      this.updateSortedTunnelList();
      return this.sortedTunnelList[0];
    }

    const tunnelObject = await this.createTunnel();
    this.usedTunnels.push(tunnelObject);
    return tunnelObject;
  }

  /**
   * 释放隧道连接
   * @param {SSHTunnel} tunnel 要释放的隧道实例
   */
  release(tunnel) {
    // 查找隧道对象
    let tunnelObject = null;

    // 先在使用中列表查找
    const usedIndex = this.usedTunnels.findIndex(t => t.tunnel === tunnel);
    if (usedIndex !== -1) {
      tunnelObject = this.usedTunnels[usedIndex];
      if (!tunnel.isConnected) {
        this.usedTunnels.splice(usedIndex, 1);
        tunnel.close();
        return;
      }
    } else {
      // 在可用池中查找
      const poolIndex = this.pool.findIndex(t => t.tunnel === tunnel);
      if (poolIndex !== -1) {
        tunnelObject = this.pool[poolIndex];
        if (!tunnel.isConnected) {
          this.pool.splice(poolIndex, 1);
          tunnel.close();
          return;
        }
      }
    }

    if (!tunnelObject) {
      console.warn('Tried to release a tunnel that is not managed by this pool:' + JSON.stringify(tunnel));
      return;
    }

    if (tunnelObject.connectionCount <= 0) {
      tunnelObject.connectionCount = 0;
    } else {
      tunnelObject.connectionCount--;
    }

    // 更新排序列表
    this.updateSortedTunnelList();
  }

  /**
   * 关闭所有隧道连接
   */
  async close() {
    // 关闭所有连接
    for (const tunnelObject of this.pool) {
      tunnelObject.tunnel.close();
    }
    for (const tunnelObject of this.usedTunnels) {
      tunnelObject.tunnel.close();
    }
    this.pool = [];
    this.usedTunnels = [];
    this.sortedTunnelList = [];
  }

  /**
   * 清理空闲隧道
   */
  cleanupIdleTunnels() {
    const now = Date.now();
    this.pool = this.pool.filter(tunnelObject => {
      if (now - tunnelObject.lastUsed > this.idleTimeout) {
        tunnelObject.tunnel.close();
        return false;
      }
      return true;
    });

    // 更新排序列表
    this.updateSortedTunnelList();
  }

  /**
   * 获取连接池状态信息
   * @returns {Object} 状态信息
   */
  getStatus() {
    return {
      available: this.pool.length,
      used: this.usedTunnels.length,
      total: this.pool.length + this.usedTunnels.length,
      maxSize: this.maxSize,
      minSize: this.minSize,
      maxConnectionsPerTunnel: this.maxConnectionsPerTunnel,
      loadBalancingStrategy: this.loadBalancingStrategy,
      usedDetails: this.usedTunnels.map(tunnelObject => ({
        connectionCount: tunnelObject.connectionCount
      }))
    };
  }
}

export default LoadBalancedConnectionPool;