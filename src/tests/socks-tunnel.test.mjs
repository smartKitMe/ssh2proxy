import { describe, it } from 'mocha';
import { expect } from 'chai';
import Socks5Tunnel from '../core/socks-tunnel.mjs';

describe('Socks5Tunnel', () => {
  // 注意：这些测试需要一个可用的SOCKS5代理服务器
  // 在实际测试环境中，您需要配置一个有效的SOCKS5代理
  
  it('should create a Socks5Tunnel instance', () => {
    const config = {
      host: '127.0.0.1',
      port: 1080,
      retryAttempts: 3,
      retryDelay: 1000
    };
    
    const tunnel = new Socks5Tunnel(config);
    expect(tunnel).to.be.an.instanceOf(Socks5Tunnel);
    expect(tunnel.config).to.equal(config);
    expect(tunnel.isConnected).to.be.false;
    expect(tunnel.retryCount).to.equal(0);
  });

  it('should have the same interface as SSHTunnel', () => {
    const config = {
      host: '127.0.0.1',
      port: 1080,
      retryAttempts: 3,
      retryDelay: 1000
    };
    
    const tunnel = new Socks5Tunnel(config);
    
    // 检查是否存在必要的方法
    expect(tunnel).to.respondTo('connect');
    expect(tunnel).to.respondTo('forwardOut');
    expect(tunnel).to.respondTo('close');
    
    // 检查是否存在必要的属性
    expect(tunnel).to.have.property('isConnected');
    expect(tunnel).to.have.property('retryCount');
  });

  // 以下测试需要实际的SOCKS5代理服务器，因此被注释掉
  /*
  it('should connect to a SOCKS5 proxy', async function() {
    this.timeout(10000); // 设置较长的超时时间
    
    const config = {
      host: '127.0.0.1', // 替换为实际的SOCKS5代理地址
      port: 1080,        // 替换为实际的SOCKS5代理端口
      retryAttempts: 3,
      retryDelay: 1000
    };
    
    const tunnel = new Socks5Tunnel(config);
    
    try {
      await tunnel.connect();
      expect(tunnel.isConnected).to.be.true;
    } finally {
      tunnel.close();
    }
  });

  it('should forward connections through SOCKS5 proxy', async function() {
    this.timeout(10000);
    
    const config = {
      host: '127.0.0.1', // 替换为实际的SOCKS5代理地址
      port: 1080,        // 替换为实际的SOCKS5代理端口
      retryAttempts: 3,
      retryDelay: 1000
    };
    
    const tunnel = new Socks5Tunnel(config);
    
    try {
      await tunnel.connect();
      expect(tunnel.isConnected).to.be.true;
      
      // 尝试创建转发连接
      const stream = await tunnel.forwardOut('127.0.0.1', 0, '8.8.8.8', 53);
      expect(stream).to.not.be.null;
      
      // 关闭流
      stream.end();
    } finally {
      tunnel.close();
    }
  });
  */
});