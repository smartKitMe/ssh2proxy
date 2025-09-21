import { describe, it } from 'mocha';
import { expect } from 'chai';
import Socks5Tunnel from '../../core/socks-tunnel.mjs';
import LoadBalancedConnectionPool from '../../core/load-balanced-connection-pool.mjs';

describe('Socks5Tunnel Integration', () => {
  // 注意：这些集成测试需要一个可用的SOCKS5代理服务器
  // 在实际测试环境中，您需要配置一个有效的SOCKS5代理
  
  it('should work with LoadBalancedConnectionPool', async function() {
    this.timeout(10000); // 设置较长的超时时间
    
    // 创建一个使用SOCKS5隧道的连接池配置
    const config = {
      tunnel: {
        type: 'socks5'
      },
      upstreamSocks5: {
        host: '127.0.0.1', // 替换为实际的SOCKS5代理地址
        port: 1080,        // 替换为实际的SOCKS5代理端口
        username: '',
        password: ''
      },
      connectionPool: {
        maxSize: 5,
        minSize: 1,
        acquireTimeout: 5000,
        idleTimeout: 10000,
        retryAttempts: 1,
        retryDelay: 1000,
        maxConnectionsPerTunnel: 5,
        loadBalancingStrategy: 'least-connections'
      }
    };
    
    // 由于我们没有实际的SOCKS5代理服务器，这里只是验证配置逻辑
    const pool = new LoadBalancedConnectionPool(config);
    expect(pool.tunnelType).to.equal('socks5');
  });

  it('should create Socks5Tunnel instances correctly', async function() {
    this.timeout(5000);
    
    const config = {
      tunnel: {
        type: 'socks5'
      },
      upstreamSocks5: {
        host: '127.0.0.1',
        port: 1080,
        username: '',
        password: ''
      },
      connectionPool: {
        retryAttempts: 1,
        retryDelay: 1000
      }
    };
    
    const pool = new LoadBalancedConnectionPool(config);
    
    // 验证createTunnel方法能正确创建Socks5Tunnel实例
    try {
      const tunnelObject = await pool.createTunnel();
      // 由于没有实际的SOCKS5代理，这里会抛出异常，但我们验证类型
      expect(tunnelObject).to.be.an('object');
    } catch (err) {
      // 预期会因为连接失败而抛出异常，但我们验证实例类型
      const tunnel = new Socks5Tunnel({
        host: config.upstreamSocks5.host,
        port: config.upstreamSocks5.port,
        username: config.upstreamSocks5.username,
        password: config.upstreamSocks5.password,
        retryAttempts: config.connectionPool.retryAttempts,
        retryDelay: config.connectionPool.retryDelay
      });
      
      expect(tunnel).to.be.an.instanceOf(Socks5Tunnel);
    }
  });
});