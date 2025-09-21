/**
 * SOCKS5隧道使用示例
 * 
 * 此示例演示如何使用SOCKS5隧道替代SSH隧道
 */

import { ProxyServer } from './src/index.mjs';

// 配置使用SOCKS5隧道的代理服务器
const config = {
  // 隧道类型配置
  tunnel: {
    type: 'socks5' // 使用SOCKS5隧道
  },
  
  // 上游SOCKS5代理配置
  upstreamSocks5: {
    host: 'res.proxy-seller.com', // 替换为实际的SOCKS5代理地址
    port: 10000,        // 替换为实际的SOCKS5代理端口
    username: '',      // 如果需要认证，请填写用户名
    password: ''       // 如果需要认证，请填写密码
  },
  
  // SSH连接配置（当tunnel.type为'ssh'时使用）
  ssh: {
    host: 'localhost',
    port: 22,
    username: 'user',
    password: '',
    privateKey: '',
    passphrase: '',
    keepaliveInterval: 30000,
    retryAttempts: 3,
    retryDelay: 5000
  },
  
  // 连接池配置
  connectionPool: {
    maxSize: 10,
    minSize: 5,
    acquireTimeout: 30000,
    idleTimeout: 60000,
    retryAttempts: 3,
    retryDelay: 5000,
    maxConnectionsPerTunnel: 10,
    loadBalancingStrategy: 'least-connections'
  },
  
  // 代理服务配置
  proxy: {
    httpPort: 8081,
    socksPort: 1080,
    pacPort: 8014
  },
  
  // PAC配置
  pac: {
    enabled: false,
    filePath: '',
    content: '',
    defaultProxy: 'SOCKS5 127.0.0.1:1080; SOCKS 127.0.0.1:1080; DIRECT'
  },
  
  // 认证配置
  auth: {
    enabled: false,
    username: '',
    password: ''
  },
  
  // 管理端点配置
  admin: {
    enabled: false,
    username: '',
    password: ''
  }
};

// 创建并启动代理服务器
const server = new ProxyServer(config);

server.start()
  .then(() => {
    console.log('SSH2Proxy server started successfully with SOCKS5 tunnel');
  })
  .catch((err) => {
    console.error('Failed to start SSH2Proxy server:', err);
  });

// 优雅关闭
process.on('SIGINT', async () => {
  console.log('Shutting down SSH2Proxy server...');
  await server.stop();
  process.exit(0);
});