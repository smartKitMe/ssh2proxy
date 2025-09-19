// 使用示例
import { ProxyServer } from './src/index.mjs';

// 配置SSH隧道代理
const config = {
  // SSH连接配置
  ssh: {
    host: '1.2.3.4',
    port: 22,
    username: '',
    password: '' // 或使用privateKey
  },
  // 连接池配置
  connectionPool: {
    maxSize: 10,
    minSize: 2,
    acquireTimeout: 30000,
    idleTimeout: 60000,
    retryAttempts: 3,
    retryDelay: 5000
  },
  // 代理服务配置
  proxy: {
    httpPort: 8080,
    httpsPort: 8443,
    socksPort: 1080,
    pacPort: 8090
  },
  // PAC配置
  pac: {
    enabled: false,
    defaultProxy: 'SOCKS5 127.0.0.1:1080; SOCKS 127.0.0.1:1080; DIRECT'
  },
  // 认证配置（可选）
  auth: {
    enabled: false,
    username: '',
    password: ''
  },
  // 管理端点配置（可选）
  admin: {
    enabled: false
  }
};

// 创建并启动代理服务器
const server = new ProxyServer(config);

server.start()
  .then(() => {
    console.log('SSH2Proxy server started successfully');
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