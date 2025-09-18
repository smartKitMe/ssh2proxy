import winston from 'winston';

class LoggerMiddleware {
  constructor() {
    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      defaultMeta: { service: 'ssh2proxy' },
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          )
        })
      ]
    });
  }

  // 记录HTTP请求
  logHttpRequest(req, res, next) {
    const start = Date.now();
    
    res.on('finish', () => {
      const duration = Date.now() - start;
      this.logger.info('HTTP Request', {
        method: req.method,
        url: req.url,
        statusCode: res.statusCode,
        duration: `${duration}ms`,
        userAgent: req.headers['user-agent'],
        ip: req.connection.remoteAddress
      });
    });
    
    next();
  }

  // 记录SSH连接事件
  logSshEvent(event, data) {
    this.logger.info(`SSH ${event}`, data);
  }

  // 记录错误
  logError(error, context = '') {
    this.logger.error(context, { error: error.message, stack: error.stack });
  }

  // 记录性能指标
  logPerformance(metric, value) {
    this.logger.info('Performance', { metric, value });
  }
}

export default LoggerMiddleware;