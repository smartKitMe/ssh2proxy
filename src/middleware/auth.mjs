import crypto from 'crypto';

class AuthMiddleware {
  constructor(config) {
    this.config = config;
  }

  // HTTP基本认证中间件
  basicAuth(req, res, next) {
    // 如果未启用认证，则直接通过
    if (!this.config.auth.enabled) {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="Proxy Server"'
      });
      res.end('Unauthorized');
      return;
    }

    try {
      const base64Credentials = authHeader.split(' ')[1];
      const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
      const [username, password] = credentials.split(':');

      if (username === this.config.auth.username && password === this.config.auth.password) {
        next();
      } else {
        res.writeHead(401, {
          'WWW-Authenticate': 'Basic realm="Proxy Server"'
        });
        res.end('Unauthorized');
      }
    } catch (err) {
      console.error('Authentication error:', err);
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="Proxy Server"'
      });
      res.end('Unauthorized');
    }
  }

  // 生成随机密码
  generateRandomPassword(length = 16) {
    return crypto.randomBytes(length).toString('hex').slice(0, length);
  }

  // 生成管理端点凭证
  generateAdminCredentials() {
    if (this.config.admin.username && this.config.admin.password) {
      return {
        username: this.config.admin.username,
        password: this.config.admin.password
      };
    }

    // 自动生成凭证
    const username = `admin_generated_${crypto.randomBytes(4).toString('hex')}`;
    const password = this.generateRandomPassword(20);
    
    return { username, password };
  }
}

export default AuthMiddleware;