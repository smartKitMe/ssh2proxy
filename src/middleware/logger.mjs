import winston from 'winston';

// 默认级别：verbose 通路（C4 负责 CLI 的 -v/--verbose 到本构造点的接线，本类只提供注入能力）
const DEFAULT_LEVEL = 'info';

class LoggerMiddleware {
  // options.level 注入级别（缺省 info）；options.silent / options.transports 可供测试与调用方覆盖
  constructor(options = {}) {
    this.level = options.level || DEFAULT_LEVEL;
    this.logger = winston.createLogger({
      level: this.level,
      silent: options.silent === true,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      defaultMeta: { service: 'ssh2proxy' },
      transports: options.transports || [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          )
        })
      ]
    });
  }

  // 当前生效级别（供 CLI/测试读取，A10 的公开读取点；以 winston 实例为准，避免读到假值）
  getLevel() {
    return this.logger.level;
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
      // 请求耗时落性能指标（本类内的真实消费者）
      this.logPerformance('http_request_duration_ms', duration, {
        method: req.method,
        statusCode: res.statusCode
      });
    });

    next();
  }

  // 记录隧道/代理事件（event 由调用方给出）
  // 待接线（C4）：app.mjs 的隧道 connect/close/error 路径（见 handoff/known_issues.md §5）
  // F2 复审裁定：前缀恢复原名 `SSH`（无功能理由的命名变更属噪音，已回退 logSshEvent 的 `Tunnel` 改动）
  logSshEvent(event, data) {
    this.logger.info(`SSH ${event}`, data);
  }

  // 记录错误
  logError(error, context = '') {
    this.logger.error(context, { error: error.message, stack: error.stack });
  }

  // 记录性能指标（当前真实调用点：本文件 logHttpRequest 的 finish 回调）
  logPerformance(metric, value, meta = {}) {
    this.logger.info('Performance', { metric, value, ...meta });
  }

  // 清理：关闭 winston transports，便于进程/测试收尾
  close() {
    this.logger.close();
  }
}

export default c3RenameProbe;
