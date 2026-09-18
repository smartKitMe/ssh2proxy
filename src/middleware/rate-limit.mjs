/**
 * RateLimitMiddleware · 固定窗口限流（按客户端 IP 粒度）
 *
 * 键粒度（A7 / C3-04）：计数键**只含客户端 IP**，不含 method / url —— 与「每个 IP 每 windowMs
 * 最多 max 个请求」的语义一致；同 IP 换 URL 或换方法无法绕过。
 * options.keyGenerator 可自定义粒度，默认实现仍返回纯 IP（不是 method/url 组合）。
 *
 * 阈值来源（A8 / C3-03，RD-C3-04 第 5 条）：
 *   ① 依据本类注释语义「每个 IP 每分钟 100 个请求」；
 *   ② 可被 options 完整覆盖（windowMs / max / message / statusCode / trustProxy / cleanupIntervalMs / keyGenerator）；
 *   ③ 配置键来源：src/config/default.config.mjs 的 config.rateLimit.{windowMs,max,trustProxy}
 *      由 C4 落地（RD-10 已把该文件 owner 移交 C4，X1）；键缺失时退回下列默认值，行为可解释。
 *   MUST NOT 留无出处的孤岛数值。
 *
 *   | 选项              | 默认值    | 说明                                                       |
 *   |-------------------|-----------|------------------------------------------------------------|
 *   | windowMs          | 60000 ms  | 固定窗口长度（1 分钟）                                      |
 *   | max               | 100       | 每 IP 每窗口上限                                            |
 *   | message           | ...       | 超限响应体（保持原实现文案）                                 |
 *   | statusCode        | 429       | HTTP「Too Many Requests」                                   |
 *   | trustProxy        | false     | 默认不信任 x-forwarded-for（安全加固，只信显式 trustProxy=true） |
 *   | cleanupIntervalMs | windowMs  | 兜底清理周期；必须 unref（A9 / RD-09）                       |
 *   | keyGenerator      | 纯 IP     | 调用方可自定义粒度                                          |
 */
class RateLimitMiddleware {
  constructor(options = {}) {
    // F7：一律用 `??`（而非 `||`）取值，避免吞掉合法的 0 值。
    // 语义约定（R5 已与实现对齐，见 limit() 首行判定）：
    //   windowMs <= 0 → **不限制**（直接 next()，同毫秒连发也全放行）；
    //   max <= 0      → 不放过任何请求（计数前即 429）；
    //   两者均为调用方显式表达，不再被当作「未设置」。
    this.windowMs = options.windowMs ?? 60000; // 1分钟（可经 options 注入覆盖）
    this.max = options.max ?? 100; // 每 IP 每窗口上限（可经 options 注入覆盖）
    this.message = options.message ?? 'Too many requests, please try again later.';
    this.statusCode = options.statusCode ?? 429;
    // x-forwarded-for 是客户端可控头：默认不信任，仅 trustProxy=true 时取首段
    this.trustProxy = options.trustProxy === true;
    this.keyGenerator = typeof options.keyGenerator === 'function'
      ? options.keyGenerator
      : (req) => RateLimitMiddleware.clientIp(req, this.trustProxy);

    // 存储请求计数（键 = 客户端 IP）
    this.requests = new Map();

    // 定期清理过期记录；窗口过期在 limit() 内也会即时判定，本定时器只兜底限制 Map 增长。
    // MUST unref：构造函数内的 ref 定时器会拖住进程退出（RD-09 判定的 npm test 挂起根因）。
    // cleanupIntervalMs 缺省跟随 windowMs；显式传 0 时回落到 1ms，避免 setInterval(0) 空转刷 CPU。
    const requestedCleanupMs = options.cleanupIntervalMs ?? this.windowMs;
    const cleanupIntervalMs = requestedCleanupMs > 0 ? requestedCleanupMs : 1;
    this.cleanupTimer = setInterval(() => this.cleanup(), cleanupIntervalMs);
    if (typeof this.cleanupTimer.unref === 'function') {
      this.cleanupTimer.unref();
    }
  }

  // 客户端 IP：socket → connection → req.ip → 'unknown'；x-forwarded-for 仅 trustProxy 时采信
  static clientIp(req, trustProxy = false) {
    if (trustProxy && req.headers && req.headers['x-forwarded-for']) {
      const first = String(req.headers['x-forwarded-for']).split(',')[0].trim();
      if (first) return first;
    }
    if (req.socket && req.socket.remoteAddress) return req.socket.remoteAddress;
    if (req.connection && req.connection.remoteAddress) return req.connection.remoteAddress;
    if (req.ip) return req.ip;
    return 'unknown';
  }

  // 清理过期记录（也可手动调用，便于测试与显式回收）
  cleanup(now = Date.now()) {
    let removed = 0;
    for (const [key, record] of this.requests.entries()) {
      if (now > record.resetTime) {
        this.requests.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  // 停止定时器并清空计数（进程退出/测试收尾的清理路径；可重复调用，幂等）
  stop() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.requests.clear();
  }

  // stop() 的别名，兼容不同调用方习惯
  close() {
    this.stop();
  }

  limit(req, res, next) {
    // R5（审查门）：windowMs <= 0 表示「窗口为 0 = 不限制」——直接放行。
    // 位置在计数之前：避免「同一毫秒内多次请求因 now 相等而被拦」与文档语义不符（实测 5 连发曾为 1 放行 4 拦）。
    if (this.windowMs <= 0) {
      next();
      return;
    }

    const ip = this.keyGenerator(req);
    const key = `${ip}`;
    const now = Date.now();

    // F7 语义：max<=0 表示「不放过任何请求」——必须在计数前判定，
    // 否则第 1 次请求会以 count=1 先被 next() 放行（0 值语义被稀释）
    if (this.max <= 0) {
      res.status(this.statusCode).send(this.message);
      return;
    }

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

    // 检查是否超过限制（被拦时 MUST NOT 调 next()）
    if (record.count > this.max) {
      res.status(this.statusCode).send(this.message);
      return;
    }

    next();
  }
}

export default RateLimitMiddleware;
