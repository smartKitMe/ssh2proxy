class RateLimitMiddleware {
  constructor(options = {}) {
    this.windowMs = options.windowMs || 60000; // 1分钟
    this.max = options.max || 100; // 限制每个IP每分钟100个请求
    this.message = options.message || 'Too many requests, please try again later.';
    this.statusCode = options.statusCode || 429;
    
    // 存储请求计数
    this.requests = new Map();
    
    // 定期清理过期记录
    setInterval(() => {
      const now = Date.now();
      for (const [key, record] of this.requests.entries()) {
        if (now - record.resetTime > this.windowMs) {
          this.requests.delete(key);
        }
      }
    }, 60000);
  }

  limit(req, res, next) {
    const ip = req.connection.remoteAddress || req.headers['x-forwarded-for'] || 'unknown';
    const key = `${ip}:${req.method}:${req.url}`;
    const now = Date.now();
    
    if (!this.requests.has(key)) {
      this.requests.set(key, {
        count: 1,
        resetTime: now + this.windowMs
      });
      next();
      return;
    }
    
    const record = this.requests.get(key);
    
    // 检查窗口是否已过期
    if (now > record.resetTime) {
      record.count = 1;
      record.resetTime = now + this.windowMs;
      next();
      return;
    }
    
    // 增加计数
    record.count++;
    
    // 检查是否超过限制
    if (record.count > this.max) {
      res.status(this.statusCode).send(this.message);
      return;
    }
    
    next();
  }
}

export default RateLimitMiddleware;