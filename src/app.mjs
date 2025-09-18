import http from 'http';
import https from 'https';
import net from 'net';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import SSHTunnel from './core/ssh-tunnel.mjs';
import HttpProxy from './core/http-proxy.mjs';
import Socks5Proxy from './core/socks-proxy.mjs';
import PacService from './core/pac-service.mjs';
import ConnectionPool from './core/connection-pool.mjs';
import ConnectionInitializer from './core/connection-initializer.mjs';
import AuthMiddleware from './middleware/auth.mjs';
import LoggerMiddleware from './middleware/logger.mjs';
import RateLimitMiddleware from './middleware/rate-limit.mjs';

class ProxyServer {
  constructor(config) {
    this.config = config;
    this.connectionPool = new ConnectionPool(config);
    this.connectionInitializer = new ConnectionInitializer(this.connectionPool, config);
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
      // 初始化连接池
      await this.connectionInitializer.initializeConnections();
      this.connectionInitializer.startMaintenance();
      
      // 启动HTTP代理服务器
      this.startHttpProxy();
      
      // 启动HTTPS代理服务器
      this.startHttpsProxy();
      
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
      console.log(`HTTPS Proxy listening on port ${this.config.proxy.httpsPort}`);
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
    this.httpServer = http.createServer(async (req, res) => {
      try {
        // 应用认证中间件
        if (this.config.auth.enabled) {
          const authHeader = req.headers.authorization;
          if (!authHeader || !authHeader.startsWith('Basic ')) {
            res.writeHead(401, {
              'WWW-Authenticate': 'Basic realm="Proxy Server"'
            });
            res.end('Unauthorized');
            return;
          }
          
          const base64Credentials = authHeader.split(' ')[1];
          const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
          const [username, password] = credentials.split(':');
          
          if (username !== this.config.auth.username || password !== this.config.auth.password) {
            res.writeHead(401, {
              'WWW-Authenticate': 'Basic realm="Proxy Server"'
            });
            res.end('Unauthorized');
            return;
          }
        }
        
        // 处理CONNECT方法（HTTPS）
        if (req.method === 'CONNECT') {
          const [host, port] = req.url.split(':');
          const tunnel = await this.connectionPool.acquire();
          
          try {
            const stream = await tunnel.forwardOut(
              'localhost',
              0,
              host,
              parseInt(port)
            );
            
            // 响应客户端CONNECT请求
            res.writeHead(200, { 'Connection': 'keep-alive' });
            res.write('\r\n');
            
            // 双向管道传输数据
            res.socket.pipe(stream, { end: true });
            stream.pipe(res.socket, { end: true });
            
            // 连接关闭时释放连接
            res.socket.on('close', () => {
              this.connectionPool.release(tunnel);
            });
            
            stream.on('close', () => {
              this.connectionPool.release(tunnel);
            });
          } catch (err) {
            this.connectionPool.release(tunnel);
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end('Proxy Error');
          }
        } else {
          // 处理普通HTTP请求
          const tunnel = await this.connectionPool.acquire();
          const httpProxy = new HttpProxy(tunnel);
          
          try {
            await httpProxy.handleRequest(req, res);
          } finally {
            this.connectionPool.release(tunnel);
          }
        }
      } catch (err) {
        this.loggerMiddleware.logError(err, 'HTTP proxy error');
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
        }
        res.end('Proxy Error');
      }
    });
    
    this.httpServer.listen(this.config.proxy.httpPort);
  }

  startHttpsProxy() {
    // HTTPS代理与HTTP代理使用相同端口处理CONNECT方法
    // 这里可以添加HTTPS服务器特定的逻辑
  }

  startSocksProxy() {
    this.socksServer = net.createServer(async (socket) => {
      try {
        const tunnel = await this.connectionPool.acquire();
        const socksProxy = new Socks5Proxy(tunnel);
        
        // 处理SOCKS5握手
        socket.once('data', async (data) => {
          try {
            await socksProxy.handleRequest(socket, data);
          } finally {
            // 注意：SOCKS5连接在握手完成后需要保持打开状态
            // 连接池的释放将在连接关闭时进行
          }
        });
        
        socket.on('close', () => {
          this.connectionPool.release(tunnel);
        });
        
        socket.on('error', (err) => {
          this.loggerMiddleware.logError(err, 'SOCKS5 socket error');
          this.connectionPool.release(tunnel);
        });
      } catch (err) {
        this.loggerMiddleware.logError(err, 'SOCKS5 proxy error');
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
}

export default ProxyServer;