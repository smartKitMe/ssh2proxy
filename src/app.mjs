import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import http from 'http';
import net from 'net';
import ConnectionInitializer from './core/connection-initializer.mjs';
import LoadBalancedConnectionPool from './core/load-balanced-connection-pool.mjs';
import PacService from './core/pac-service.mjs';
import Socks5Proxy from './core/socks-proxy.mjs';
import AuthMiddleware from './middleware/auth.mjs';
import LoggerMiddleware from './middleware/logger.mjs';
import RateLimitMiddleware from './middleware/rate-limit.mjs';

class ProxyServer {
  constructor(config) {
    this.config = config;
    // 仅在需要隧道连接时才初始化连接池
    if (!config.testingMode) {
      this.connectionPool = new LoadBalancedConnectionPool(config);
      this.connectionInitializer = new ConnectionInitializer(this.connectionPool, config);
    } else {
      // 在测试模式下创建一个简单的连接池占位符
      this.connectionPool = {
        getStatus: () => ({ available: 0, used: 0, total: 0 }),
        acquire: async () => null,
        release: () => {}
      };
    }
    this.authMiddleware = new AuthMiddleware(config);
    this.loggerMiddleware = new LoggerMiddleware();
    this.rateLimitMiddleware = new RateLimitMiddleware();

    // 初始化各代理组件
    this.pacService = new PacService(config);

    // 初始化Express应用（用于PAC服务和管理端点）
    this.app = express();
    this.app.use(helmet());
    this.app.use(cors());
    this.app.use(this.loggerMiddleware.logHttpRequest.bind(this.loggerMiddleware));
  }

  async start() {
    try {
      // 仅在非测试模式下初始化连接池
      if (!this.config.testingMode) {
        // 初始化连接池
        await this.connectionInitializer.initializeConnections();
        this.connectionInitializer.startMaintenance();
      }

      // 启动HTTP代理服务器
      this.startHttpProxy();

      // 启动SOCKS5代理服务器
      this.startSocksProxy();

      // 启动PAC服务
      if (this.config.pac.enabled) {
        this.startPacService();
      }

      // 启动管理端点
      if (this.config.admin.enabled) {
        this.startAdminService();
      }

      console.log(`HTTP Proxy listening on port ${this.config.proxy.httpPort}`);
      console.log(`SOCKS5 Proxy listening on port ${this.config.proxy.socksPort}`);

      if (this.config.pac.enabled) {
        console.log(`PAC Service listening on port ${this.config.proxy.pacPort}`);
      }

      if (this.config.admin.enabled) {
        const credentials = this.authMiddleware.generateAdminCredentials();
        console.log(`Admin Service listening on port ${this.config.proxy.adminPort || 8081}`);
        console.log(`Admin credentials: ${credentials.username}/${credentials.password}`);
      }
    } catch (err) {
      this.loggerMiddleware.logError(err, 'Failed to start proxy server');
      throw err;
    }
  }

  startHttpProxy() {
    this.httpServer = http.createServer();
    
    // 处理HTTPS CONNECT请求
    this.httpServer.on('connect', async (req, clientSocket, head) => {
      // 检查是否需要认证
      if (this.config.auth.enabled) {
        // 验证认证信息
        const authResult = this.validateAuth(req);
        if (!authResult.authenticated) {
          clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\n');
          clientSocket.write('Proxy-Authenticate: Basic realm="Proxy Server"\r\n');
          clientSocket.write('\r\n');
          clientSocket.end();
          return;
        }
      }
      
      await this.handleHttpsConnect(req, clientSocket, head);
    });

    // 处理普通HTTP请求
    this.httpServer.on('request', async (req, res) => {
      // 检查是否需要认证
      if (this.config.auth.enabled) {
        // 验证认证信息
        const authResult = this.validateAuth(req);
        if (!authResult.authenticated) {
          res.setHeader('Proxy-Authenticate', 'Basic realm="Proxy Server"');
          res.statusCode = 407;
          res.end('Proxy Authentication Required');
          return;
        }
      }
      
      await this.handleHttpRequest(req, res);
    });

    this.httpServer.listen(this.config.proxy.httpPort);
  }

  /**
   * 处理HTTPS CONNECT请求
   * @param {http.IncomingMessage} req - 请求对象
   * @param {net.Socket} clientSocket - 客户端套接字
   * @param {Buffer} head - 头部数据
   */
  async handleHttpsConnect(req, clientSocket, head) {
    const [remoteHost, remotePort] = req.url.split(':');
    const port = parseInt(remotePort) || 443;
    
    console.log(`Handling HTTPS CONNECT request for ${remoteHost}:${port}`);

    // 记录连接池状态
    this.logPoolStatus('HTTPS CONNECT');

    // 获取SSH隧道连接
    const tunnel = await this.acquireTunnel();
    console.log('Acquired tunnel for HTTPS CONNECT');

    try {
      // 建立SSH隧道流
      const stream = await tunnel.forwardOut('127.0.0.1', 0, remoteHost, port);
      console.log('Successfully created forward stream');

      // 发送连接成功响应
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

      // 如果有头部数据，先写入SSH流
      if (head && head.length > 0) {
        stream.write(head);
      }

      // 建立双向数据流
      clientSocket.pipe(stream);
      stream.pipe(clientSocket);

      // 确保在所有情况下都能释放连接
      const releaseTunnel = () => {
        console.log('Releasing tunnel');
        if (tunnel) {
          this.connectionPool.release(tunnel);
        }
      };

      // 连接关闭时释放连接
      clientSocket.on('close', releaseTunnel);
      stream.on('close', releaseTunnel);

      // 添加错误处理
      clientSocket.on('error', releaseTunnel);
      stream.on('error', releaseTunnel);
    } catch (err) {
      // 确保在出现错误时释放连接
      console.error('Error in HTTPS CONNECT handler:', err);
      if (tunnel) {
        this.connectionPool.release(tunnel);
      }
      this.handleProxyError(err, clientSocket, 'HTTPS proxy error');
    }
  }

  /**
   * 处理普通HTTP请求
   * @param {http.IncomingMessage} req - 请求对象
   * @param {http.ServerResponse} res - 响应对象
   */
  async handleHttpRequest(req, res) {
    // 解析目标地址
    const urlObject = new URL(req.url, `http://${req.headers.host}`);
    const targetHost = urlObject.hostname;
    const targetPort = urlObject.port || (urlObject.protocol === 'https:' ? 443 : 80);

    // 记录连接池状态
    this.logPoolStatus('HTTP request');

    // 获取SSH隧道连接
    const tunnel = await this.acquireTunnel();

    try {
      // 建立SSH隧道流
      const stream = await tunnel.forwardOut('127.0.0.1', 0, targetHost, parseInt(targetPort));

      // 重新构建HTTP请求
      const requestLine = `${req.method} ${urlObject.path || '/'} HTTP/1.1\r\n`;
      let headers = '';

      // 添加必要的headers
      const reqHeaders = { ...req.headers };
      reqHeaders.host = targetHost + (targetPort !== 80 && targetPort !== 443 ? `:${targetPort}` : '');

      for (const [key, value] of Object.entries(reqHeaders)) {
        headers += `${key}: ${value}\r\n`;
      }
      headers += '\r\n';

      stream.write(requestLine + headers);

      req.pipe(stream, { end: false });
      req.on('end', () => {});

      // 双向管道传输数据
      stream.pipe(res);

      // 确保在所有情况下都能释放连接
      const releaseTunnel = () => {
        if (tunnel) {
          this.connectionPool.release(tunnel);
        }
      };

      // 连接关闭时释放连接
      res.socket.on('close', releaseTunnel);
      stream.on('close', releaseTunnel);

      // 添加错误处理
      res.socket.on('error', releaseTunnel);
      stream.on('error', releaseTunnel);
    } catch (err) {
      // 确保在出现错误时释放连接
      if (tunnel) {
        this.connectionPool.release(tunnel);
      }
      this.handleProxyError(err, res, 'HTTP proxy error');
    }
  }

  /**
   * 记录连接池状态
   * @param {string} context - 上下文信息
   */
  logPoolStatus(context) {
    if (this.connectionPool) {
      const poolStatus = this.connectionPool.getStatus();
      console.log(`Acquiring connection from pool for ${context}:`);
      console.log(`  Available tunnels: ${JSON.stringify(poolStatus)}`);
    } else {
      console.log('Using direct connection in testing mode');
    }
  }

  /**
   * 获取SSH隧道连接
   * @returns {Promise<Object|null>} 隧道连接对象
   */
  async acquireTunnel() {
    return this.connectionPool ? await this.connectionPool.acquire() : null;
  }

  /**
   * 处理代理错误
   * @param {Error} err - 错误对象
   * @param {http.ServerResponse|net.Socket} responseOrSocket - 响应或套接字对象
   * @param {string} message - 错误消息
   */
  handleProxyError(err, responseOrSocket, message) {
    console.error(message + ':', err);
    
    if (responseOrSocket instanceof http.ServerResponse) {
      // HTTP响应错误处理
      if (!responseOrSocket.headersSent) {
        responseOrSocket.writeHead(502, { 'Content-Type': 'text/plain' });
      }
      responseOrSocket.end('Proxy Error');
    } else {
      // Socket错误处理
      if (!responseOrSocket.headersSent) {
        responseOrSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      }
      responseOrSocket.end();
    }
  }

  startSocksProxy() {
    this.socksServer = net.createServer(async (socket) => {
      let tunnel = null;
      try {
        // 添加连接池状态日志（仅在非测试模式下）
        if (this.connectionPool) {
          const poolStatus = this.connectionPool.getStatus();
          console.log('Acquiring connection from pool for SOCKS:');
          console.log(`  Available tunnels: ${JSON.stringify(poolStatus)}`);
        } else {
          console.log('Using direct connection in testing mode');
        }

        tunnel = this.connectionPool ? await this.connectionPool.acquire() : null;
        const socksProxy = new Socks5Proxy(tunnel);

        // 处理SOCKS5握手
        socket.once('data', async (data) => {
          try {
            await socksProxy.handleRequest(socket, data);
          } catch (err) {
            this.loggerMiddleware.logError(err, 'SOCKS5 handshake error');
            // 如果握手失败，确保释放连接
            if (tunnel) {
              this.connectionPool.release(tunnel);
              tunnel = null;
            }
            socket.end();
          }
        });

        // 确保在所有情况下都能释放连接
        const releaseTunnel = () => {
          if (tunnel) {
            this.connectionPool.release(tunnel);
            tunnel = null;
          }
        };

        socket.on('close', releaseTunnel);
        socket.on('error', (err) => {
          this.loggerMiddleware.logError(err, 'SOCKS5 socket error');
          releaseTunnel();
        });

        // 添加超时处理，防止连接长时间占用
        socket.setTimeout(this.config.connectionPool.idleTimeout || 60000, () => {
          console.log('SOCKS5 socket timeout, releasing connection');
          releaseTunnel();
          socket.end();
        });
      } catch (err) {
        this.loggerMiddleware.logError(err, 'SOCKS5 proxy error');
        // 如果获取连接失败或出现其他错误，确保释放已获取的连接
        if (tunnel) {
          this.connectionPool.release(tunnel);
        }
        socket.end();
      }
    });

    this.socksServer.listen(this.config.proxy.socksPort);
  }

  startPacService() {
    this.app.get('/proxy.pac', this.pacService.handleRequest.bind(this.pacService));
    this.app.get('/pac/:name', this.pacService.handleRequest.bind(this.pacService));

    this.pacServer = this.app.listen(this.config.proxy.pacPort);
  }

  startAdminService() {
    // 生成管理凭证（如果未指定）
    const credentials = this.authMiddleware.generateAdminCredentials();

    // 添加认证中间件
    this.app.use('/api/*', (req, res, next) => {
      const authHeader = req.headers.authorization;

      if (!authHeader || !authHeader.startsWith('Basic ')) {
        res.writeHead(401, {
          'WWW-Authenticate': 'Basic realm="Admin Service"'
        });
        res.end('Unauthorized');
        return;
      }

      const base64Credentials = authHeader.split(' ')[1];
      const userCredentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
      const [username, password] = userCredentials.split(':');

      // 这里应该验证管理凭证
      if (username === credentials.username && password === credentials.password) {
        next();
      } else {
        res.writeHead(401, {
          'WWW-Authenticate': 'Basic realm="Admin Service"'
        });
        res.end('Unauthorized');
      }
    });

    // 管理端点
    this.app.post('/api/config', (req, res) => {
      // 更新配置的逻辑
      res.json({ message: 'Configuration updated' });
    });

    this.app.get('/api/status', (req, res) => {
      // 获取服务器状态的逻辑
      res.json({
        sshConnected: true,
        activeConnections: this.connectionPool.usedConnections.length,
        totalConnections: this.connectionPool.pool.length + this.connectionPool.usedConnections.length,
        poolStatus: this.connectionPool.getStatus(),
        uptime: process.uptime()
      });
    });

    this.adminServer = this.app.listen(this.config.proxy.adminPort || 8081);
  }

  async stop() {
    // 关闭所有服务器
    if (this.httpServer) {
      this.httpServer.close();
    }

    if (this.socksServer) {
      this.socksServer.close();
    }

    if (this.pacServer) {
      this.pacServer.close();
    }

    if (this.adminServer) {
      this.adminServer.close();
    }

    // 关闭连接池
    await this.connectionPool.close();
  }

  /**
   * 验证HTTP基本认证
   * @param {http.IncomingMessage} req - 请求对象
   * @returns {Object} 认证结果 { authenticated: boolean, username: string|null }
   */
  validateAuth(req) {
    const authHeader = req.headers['proxy-authorization'] || req.headers['authorization'];
    
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      return { authenticated: false, username: null };
    }

    try {
      const base64Credentials = authHeader.split(' ')[1];
      const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
      const [username, password] = credentials.split(':');

      if (username === this.config.auth.username && password === this.config.auth.password) {
        return { authenticated: true, username };
      } else {
        return { authenticated: false, username };
      }
    } catch (err) {
      console.error('Authentication error:', err);
      return { authenticated: false, username: null };
    }
  }
}

export default ProxyServer;