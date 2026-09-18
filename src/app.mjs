import cors from 'cors';
import crypto from 'crypto';
import express from 'express';
import helmet from 'helmet';
import http from 'http';
import net from 'net';
import ConnectionInitializer from './core/connection-initializer.mjs';
import LoadBalancedConnectionPool from './core/load-balanced-connection-pool.mjs';
import PacService from './core/pac-service.mjs';
import Socks5Proxy from './core/socks-proxy.mjs';
import WorkerManager from './core/worker-manager.mjs';
import AuthMiddleware, { parseBasicCredentials } from './middleware/auth.mjs';
import LoggerMiddleware from './middleware/logger.mjs';
import RateLimitMiddleware from './middleware/rate-limit.mjs';
import { mergeConfig, validateConfig } from './utils/helpers.mjs';

// 凭据的常量时间比较（F9，安全）：原实现用 `===` 比较用户名/密码，属非恒定时间比较，
// 存在时序侧信道（攻击者可逐字节推断凭据）。改用 HMAC-SHA256 把任意长度输入归一为定长摘要后再
// `crypto.timingSafeEqual`：既规避 `timingSafeEqual` 对长度不等的 throw，也不泄漏长度差异
// （与 C3 在 src/core/socks-proxy.mjs 的 SOCKS5 认证同构，此处为独立实现，未改动 C3 文件）。
const CREDENTIAL_DIGEST_KEY = Buffer.from('ssh2proxy:credential-constant-time-compare:v1');

/**
 * 常量时间字符串相等比较
 * @param {*} a - 待比较值（null/undefined 视为空串，不抛异常）
 * @param {*} b - 待比较值
 * @returns {boolean} 是否相等
 */
function constantTimeEqual(a, b) {
  const digestA = crypto.createHmac('sha256', CREDENTIAL_DIGEST_KEY).update(String(a ?? '')).digest();
  const digestB = crypto.createHmac('sha256', CREDENTIAL_DIGEST_KEY).update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

/**
 * 有效凭据判据（fail-closed）：用户名与口令均须为非空字符串。
 *
 * 语义与 `src/middleware/auth.mjs#hasValidCredentials`、`src/core/socks-proxy.mjs#hasValidCredentials` **完全对齐**，
 * 三处 MUST 保持同义（本次 D-1 缺陷即因 HTTP 侧漏了这条判据）。
 *
 * 为什么 MUST 在比较**之前**判定：`constantTimeEqual('', '')` 为 true，若配置里 username/password 为空字符串，
 * 则客户端用**空凭据**（`Proxy-Authorization: Basic Og==`）即可通过认证 ⇒ 认证面 fail-open。
 * 配置不合法属于**部署错误**，唯一安全的选择是拒绝一切入站认证，而不是「谁都能进」。
 *
 * @param {*} auth - 认证配置对象
 * @returns {boolean} 凭据是否有效（可据此放行）
 */
export function hasValidCredentials(auth) {
  if (!auth) return false;
  const username = auth.username == null ? '' : String(auth.username);
  const password = auth.password == null ? '' : String(auth.password);
  return username.length > 0 && password.length > 0;
}

/**
 * 解析 Basic 凭据（base64 原文）——**重新导出唯一真源**（D7-truth，T-2 + T-4）。
 *
 * **口径唯一来源**：实现体已迁移至 `src/middleware/auth.mjs` 的 `parseBasicCredentials()` ——
 *   `Buffer.from(x, 'base64').toString('utf8')` + **首个** `':'` 切分（用户名 = 首个 `':'` 之前，口令 = **其余全部**）。
 * 本文件仅**重新导出**，供既有调用方与测试按原路径 import；口径由**实现唯一化**强制（三处共同消费同一函数），
 * 不再靠注释维系。
 *
 * 为什么唯一真源落在 `src/middleware/auth.mjs` 而不是本文件：本文件已 `import AuthMiddleware from
 * './middleware/auth.mjs'`，反向 import 会造成循环依赖；中间件是认证语义基准面，故真源落于彼处。
 *
 * 语义依据 RFC 7617 §2.1（`charset="UTF-8"`）。历史实现在本文件的两处用 `toString('ascii')`：
 * `'ascii'` 逐字节 `& 0x7F` 截为 7 位（实测：`'ü'` 的 UTF-8 字节 `0xC3 0xBC` ⇒ 两个字符 `'C'`+`'<'`，
 * 即 `"üser:pä:ss"` ⇒ `"C<ser:pC$:ss"`）⇒ 非 ASCII 凭据在
 * 代理面/管理端点被判错、而在 Express `basicAuth`（`'utf8'`）被放行 ⇒ **跨面漂移**。
 * 该行为修正是**有意的**；ASCII 凭据（0x00–0x7F）行为逐字不变。
 *
 * @param {string} base64Credentials - base64 编码的 `user:pass` 原文（不含 `Basic ` 前缀）
 * @returns {{username: string, password: string}|null} 解析结果；无分隔符时为 null（不可解析 ⇒ 调用方 fail-closed）
 */
export { parseBasicCredentials };

/**
 * 构造转发到上游的请求行与 Host 头（纯函数，便于探针断言各端口/路径形态）
 *
 * 其一：WHATWG `URL` **没有 `.path` 属性**（`urlObject.path` 恒为 `undefined`）——历史实现写作
 * `urlObject.path || '/'`，使所有普通 HTTP 转发请求的请求行退化为 `GET / HTTP/1.1`，**路径与查询串全部丢失**
 * （已由回环 echo 探针复现：客户端请求 `/echo-path?x=1`，上游实收 `GET /`）。此处 MUST 用 `pathname + search`。
 *
 * 其二：Host 头 MUST 指向「上游目标 host[:port]」——虚主机（vhost）路由依赖它；端口为协议默认值时不重复写入。
 * `urlObject.port` 的类型是**字符串**（显式非默认端口如 `'8080'`），故本函数把默认端口也写成字符串
 * （`'80'`/`'443'`）再比较，不让字符串与数字混比。另：WHATWG `URL` 已把**协议默认端口归一为空串**
 * （实测 `new URL('http://h.example:80/p').port === ''`），故 `urlObject.port || defaultPort` 只在
 * **显式非默认端口**时取到端口；默认端口落到 `defaultPort` ⇒ `port === defaultPort` ⇒ Host 内不重复写端口。
 *
 * @param {URL} urlObject - 已解析的目标 URL
 * @param {string} method - 请求方法
 * @returns {{requestLine: string, hostHeader: string}} 请求行与 Host 头
 */
export function buildForwardRequest(urlObject, method) {
  const defaultPort = urlObject.protocol === 'https:' ? '443' : '80';
  const port = urlObject.port || defaultPort;
  const hostHeader = port === defaultPort ? urlObject.hostname : `${urlObject.hostname}:${port}`;
  const target = `${urlObject.pathname}${urlObject.search}`;

  return {
    requestLine: `${method} ${target} HTTP/1.1\r\n`,
    hostHeader
  };
}

class ProxyServer {
  constructor(config) {
    this.config = config;
    // 构造期配置校验（RD-12 接线点：validateConfig 的真实消费者之一）
    this.assertStartableConfig();
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
    // 日志级别：config.logging.level 优先，其次 -v/--verbose（debug），缺省 info
    // （消费 C3 冻结的 LoggerMiddleware level 注入契约；旧版中间件忽略该参数，行为退化为 info）
    this.loggerMiddleware = new LoggerMiddleware({ level: this.resolveLogLevel() });
    // 限流阈值来自 config.rateLimit（键与默认值见 src/config/default.config.mjs 的 rateLimit 段）
    this.rateLimitMiddleware = new RateLimitMiddleware(config.rateLimit || {});

    // 初始化各代理组件
    this.pacService = new PacService(config);

    // Worker 池（C5 契约：start()→{size,threadIds} / assignTask() / getStats() / close()）
    // 当前基线（C5 未合并）的实现忽略构造参数且无 start/getStats，接线按接口预留并防御式降级
    this.workerManager = new WorkerManager({ size: (config.proxy && config.proxy.workerPoolSize) ?? 2 });
    this.workerPoolInfo = null;
    this.workerAssignCount = 0;

    // 初始化Express应用：PAC 服务与管理端点使用各自独立实例，
    // 避免管理端点（/api/*）暴露在 PAC 端口上、PAC 路由混入管理端口。
    this.app = express();
    this.adminApp = express();
    for (const app of [this.app, this.adminApp]) {
      app.use(helmet());
      app.use(cors());
      app.use(this.loggerMiddleware.logHttpRequest.bind(this.loggerMiddleware));
      // 限流中间件真实挂载点（D-106）：C3 交付的 limit(req,res,next) 在此生效
      app.use(this.rateLimitMiddleware.limit.bind(this.rateLimitMiddleware));
    }
    // 代理认证中间件真实挂载点（D-106 / RD-12 Q2）：范围限定为非 /api、非 /pac/、非 /proxy.pac，
    // 避免与 PAC 探测（A6）与管理端点探测（A9）相互干扰；代理连接面的认证在 httpServer 路径按 config.auth 校验。
    this.app.use((req, res, next) => {
      if (req.path === '/proxy.pac' || req.path.startsWith('/pac/') || req.path.startsWith('/api/')) {
        next();
        return;
      }
      this.authMiddleware.basicAuth(req, res, next);
    });
  }

  /**
   * 构造期配置校验（RD-12 接线点：validateConfig 的真实消费者之一）
   * 端口一类的非法值属致命错误 → fail-fast；其余（如 SSH 凭据缺失）按告警处理
   * （默认配置本身只有 host/username 而无口令，硬退会让「仅启动 PAC/管理端点」的合法用法不可用，
   * 见 README-zh「### 配置校验」/ README「### Configuration validation」）
   * @returns {string[]} 校验错误列表
   */
  assertStartableConfig() {
    if (!this.config || !this.config.ssh || !this.config.proxy) {
      return [];
    }

    const errors = validateConfig(this.config);
    const fatalErrors = errors.filter((message) => /port/i.test(message));

    if (fatalErrors.length > 0) {
      throw new Error(`Invalid configuration: ${fatalErrors.join('; ')}`);
    }

    if (errors.length > 0 && !this.config.testingMode) {
      console.warn(`Configuration warnings: ${errors.join('; ')}`);
    }

    return errors;
  }

  /**
   * 详细日志（-v/--verbose 的真实输出点）：级别为 debug 时输出
   * 双通道：console（不依赖 middleware 版本，行数可观测）+ winston debug（C3 的 level 注入契约）
   * @param {string} message - 消息
   * @param {Object} meta - 结构化附加信息
   */
  logVerbose(message, meta = {}) {
    if (this.resolveLogLevel() !== 'debug') {
      return;
    }

    const hasMeta = Object.keys(meta).length > 0;
    console.log(`[verbose] ${message}${hasMeta ? ' ' + JSON.stringify(meta) : ''}`);

    const logger = this.loggerMiddleware && this.loggerMiddleware.logger;
    if (logger && typeof logger.debug === 'function') {
      logger.debug(message, meta);
    }
  }

  /**
   * 启动 Worker 池（C5 冻结契约：start() → {size, threadIds}）
   * testingMode 下跳过；旧版 WorkerManager（无 start）同样跳过，MUST NOT 因此报错
   * @returns {Promise<{size:number,threadIds:number[]}|null>} 池信息或 null
   */
  async startWorkerPool() {
    if (this.config.testingMode || !this.workerManager || typeof this.workerManager.start !== 'function') {
      this.logVerbose('worker pool skipped', { testingMode: Boolean(this.config.testingMode) });
      return null;
    }

    this.workerPoolInfo = await this.workerManager.start();
    this.logVerbose('worker pool started', this.workerPoolInfo || {});
    return this.workerPoolInfo;
  }

  /**
   * 热路径：把 PAC 渲染投递到 Worker 池（A21 的真实消费点）
   *
   * H3-S304 修法：payload MUST 携带**按配置解析好的内容或归一化代理串**——
   * 端口/内容只有一个真源（`PacService.resolvePacRender()`），worker 不再自行推断端口。
   * 因此 `config.pac.content` / `pac.filePath` / `pac.directory` / `pac.files` / `pac.defaultProxy`
   * 与 `config.proxy.socksPort` 在 worker 路径上与此前的主线程回退路径**完全同源**。
   * Worker 池不可用或结果不合规时返回 null，由调用方回落主线程渲染（MUST NOT 因可选用能力阻断 PAC 服务）。
   * @param {string|null} name - PAC 名
   * @returns {Promise<string|null>} 渲染结果或 null
   */
  async renderPacViaWorker(name) {
    if (!this.workerManager || typeof this.workerManager.assignTask !== 'function') {
      return null;
    }

    this.workerAssignCount += 1;
    this.logVerbose('assigning renderPac task to worker pool', { name, count: this.workerAssignCount });

    try {
      // 内容解析与主线程回退路径同源（同一个 PacService）：未命中 → null（调用方 404，不冒充默认内容）
      const resolved = await this.pacService.resolvePacRender(name);
      if (!resolved) {
        return null;
      }

      // 待发给 worker 的 payload 形状（worker 与主线程降级共用同一 handler 表 → 结果同形同值）
      const payload = resolved.kind === 'content'
        ? { name: name ?? null, content: resolved.content }
        : { name: name ?? null, renderProxy: resolved.proxy };

      const rendered = await this.workerManager.assignTask({ type: 'renderPac', payload });
      // 严格校验：仅接受可用的 PAC 文本，避免未实现该任务类型的池返回脏值
      if (typeof rendered === 'string' && rendered.includes('FindProxyForURL')) {
        return rendered;
      }
      return null;
    } catch (err) {
      this.logVerbose('worker renderPac fallback to main thread', { error: err.message });
      return null;
    }
  }

  /**
   * Worker 池统计（C5 契约 getStats()；旧版实现无该方法时返回 null）
   * @returns {Object|null} 池统计
   */
  getWorkerStats() {
    if (this.workerManager && typeof this.workerManager.getStats === 'function') {
      return this.workerManager.getStats();
    }
    return null;
  }

  /**
   * 生效的日志级别（-v/--verbose 的真实消费点）
   * @returns {string} winston 日志级别
   */
  resolveLogLevel() {
    const configured = this.config.logging && this.config.logging.level;
    if (configured) {
      return configured;
    }
    return this.config.verbose ? 'debug' : 'info';
  }

  /**
   * 管理端点凭证的唯一生成点（D-110：启动日志打印值与 /api/* 校验值 MUST 同源）
   * @returns {{username: string, password: string}}
   */
  getAdminCredentials() {
    if (!this.adminCredentials) {
      this.adminCredentials = this.authMiddleware.generateAdminCredentials();
    }
    return this.adminCredentials;
  }

  /**
   * 服务状态（消费 C2 冻结契约 LoadBalancedConnectionPool.getStatus() = {available,used,total}）
   * @returns {Object} 状态对象（含 available/used/total 与池明细 poolStatus）
   */
  getStatus() {
    const poolStatus = this.connectionPool && typeof this.connectionPool.getStatus === 'function'
      ? this.connectionPool.getStatus()
      : { available: 0, used: 0, total: 0 };

    return {
      sshConnected: Boolean(this.connectionPool) && !this.config.testingMode,
      activeConnections: poolStatus.used,
      totalConnections: poolStatus.total,
      availableConnections: poolStatus.available,
      available: poolStatus.available,
      used: poolStatus.used,
      total: poolStatus.total,
      poolStatus,
      workerPool: this.getWorkerStats(),
      uptime: process.uptime()
    };
  }

  /**
   * 深合并更新配置（D-013：`docs/node-proxy-server-design.md` 声称的 ProxyServer.updateConfig）
   * @param {Object} newConfig - 增量配置
   * @returns {Object} 更新后的配置
   */
  updateConfig(newConfig) {
    if (!newConfig || typeof newConfig !== 'object' || Array.isArray(newConfig)) {
      throw new TypeError('updateConfig expects a plain object');
    }

    this.config = mergeConfig(this.config, newConfig);

    // 热更新：依赖 config 的组件同步到新配置（引用替换，非就地改写）
    this.authMiddleware.config = this.config;
    this.pacService.config = this.config;

    const level = this.resolveLogLevel();
    if (this.loggerMiddleware.logger && this.loggerMiddleware.logger.level !== level) {
      this.loggerMiddleware.logger.level = level;
    }

    return this.config;
  }

  /**
   * 配置快照（管理端点回显用；敏感字段脱敏）
   * @returns {Object} 脱敏后的配置副本
   */
  describeConfig() {
    const snapshot = mergeConfig({}, this.config);
    if (snapshot.ssh) {
      snapshot.ssh = {
        ...snapshot.ssh,
        password: snapshot.ssh.password ? '[HIDDEN]' : '',
        privateKey: snapshot.ssh.privateKey ? '[PRIVATE KEY CONTENT HIDDEN]' : ''
      };
    }
    if (snapshot.admin) {
      snapshot.admin = { ...snapshot.admin, password: snapshot.admin.password ? '[HIDDEN]' : '' };
    }
    if (snapshot.upstreamSocks5) {
      snapshot.upstreamSocks5 = {
        ...snapshot.upstreamSocks5,
        password: snapshot.upstreamSocks5.password ? '[HIDDEN]' : ''
      };
    }
    return snapshot;
  }

  /**
   * 监听参数：config.proxy.host 为单一来源（-h/--host 的消费点）；未配置时保持 Node 默认行为
   * @param {number} port - 端口
   * @returns {Array} listen 参数
   */
  listenOptions(port) {
    return this.config.proxy.host ? [port, this.config.proxy.host] : [port];
  }

  /**
   * 实际监听端口（监听尚未完成时回落到配置值）
   * @param {http.Server} server - 服务器实例
   * @param {number} configuredPort - 配置端口
   * @returns {number} 端口
   */
  listenPort(server, configuredPort) {
    const address = server && typeof server.address === 'function' ? server.address() : null;
    return address && address.port ? address.port : configuredPort;
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

      // 启动 Worker 池（C5 契约）；testingMode 或旧版实现无 start() 时跳过
      await this.startWorkerPool();

      // 启动HTTPS(CONNECT)代理服务器（README:43 声称的 --https-port 的真实消费点）
      if (this.config.proxy.httpsPort) {
        this.startHttpsProxy();
      }

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

      console.log(`HTTP Proxy listening on port ${this.listenPort(this.httpServer, this.config.proxy.httpPort)}`);
      this.logVerbose('http proxy started', { port: this.listenPort(this.httpServer, this.config.proxy.httpPort) });
      if (this.httpsServer) {
        console.log(`HTTPS Proxy listening on port ${this.listenPort(this.httpsServer, this.config.proxy.httpsPort)}`);
        this.logVerbose('https proxy started', { port: this.listenPort(this.httpsServer, this.config.proxy.httpsPort) });
      }
      console.log(`SOCKS5 Proxy listening on port ${this.config.proxy.socksPort}`);
      this.logVerbose('socks5 proxy started', { port: this.config.proxy.socksPort });

      if (this.config.pac.enabled) {
        console.log(`PAC Service listening on port ${this.listenPort(this.pacServer, this.config.proxy.pacPort)}`);
        this.logVerbose('pac service started', { port: this.listenPort(this.pacServer, this.config.proxy.pacPort) });
      }

      if (this.config.admin.enabled && this.adminServer) {
        // 打印值与 /api/* 校验值同源（D-110）
        const credentials = this.getAdminCredentials();
        console.log(`Admin Service listening on port ${this.listenPort(this.adminServer, this.config.proxy.adminPort)}`);
        console.log(`Admin credentials: ${credentials.username}/${credentials.password}`);
        this.logVerbose('admin service started', { port: this.listenPort(this.adminServer, this.config.proxy.adminPort) });
      }
    } catch (err) {
      this.loggerMiddleware.logError(err, 'Failed to start proxy server');
      throw err;
    }
  }

  /**
   * 创建 HTTP/HTTPS(CONNECT) 代理服务器实例（两类端口共用同一处理逻辑）
   * @returns {http.Server} 未监听的服务器实例
   */
  createHttpProxyServer() {
    const server = http.createServer();

    // 处理HTTPS CONNECT请求
    server.on('connect', async (req, clientSocket, head) => {
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
    server.on('request', async (req, res) => {
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

    // 监听失败（如端口被占用）记录而非静默崩溃
    server.on('error', (err) => {
      this.loggerMiddleware.logError(err, 'HTTP proxy listener error');
    });

    return server;
  }

  startHttpProxy() {
    this.httpServer = this.createHttpProxyServer();
    this.httpServer.listen(...this.listenOptions(this.config.proxy.httpPort));
  }

  /**
   * 启动 HTTPS(CONNECT) 代理端口（README:43 声称的 --https-port → config.proxy.httpsPort 的消费点）
   */
  startHttpsProxy() {
    this.httpsServer = this.createHttpProxyServer();
    this.httpsServer.listen(...this.listenOptions(this.config.proxy.httpsPort));
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
    const startedAt = Date.now();
    const target = `${remoteHost}:${port}`;

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

      // 隧道事件日志（消费 C3 的 logSshEvent；路径 1/3：HTTPS CONNECT）
      this.loggerMiddleware.logSshEvent('connect', { target, via: 'https-connect' });
      // 性能指标（消费 C3 的 logPerformance）
      this.loggerMiddleware.logPerformance('https_connect_setup_ms', Date.now() - startedAt, { target });

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
        this.releaseTunnel(tunnel, 'https-connect');
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
      this.loggerMiddleware.logSshEvent('error', { target, via: 'https-connect', error: err.message });
      this.releaseTunnel(tunnel, 'https-connect');
      this.handleProxyError(err, clientSocket, 'HTTPS proxy error');
    }
  }

  /**
   * 处理普通HTTP请求
   * @param {http.IncomingMessage} req - 请求对象
   * @param {http.ServerResponse} res - 响应对象
   */
  async handleHttpRequest(req, res) {
    const startedAt = Date.now();
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

      // 隧道事件日志（消费 C3 的 logSshEvent；路径 2/3：HTTP request）
      this.loggerMiddleware.logSshEvent('connect', { target: `${targetHost}:${targetPort}`, via: 'http-request' });
      // 性能指标（消费 C3 的 logPerformance）
      this.loggerMiddleware.logPerformance('http_request_forward_ms', Date.now() - startedAt, { target: `${targetHost}:${targetPort}` });
      this.logVerbose('forward stream created', { target: `${targetHost}:${targetPort}`, via: 'http-request' });

      // 重新构建HTTP请求：请求行取 pathname+search（URL 无 .path 属性），Host 取上游目标 host[:port]
      const { requestLine, hostHeader } = buildForwardRequest(urlObject, req.method);
      let headers = '';

      // 添加必要的headers
      const reqHeaders = { ...req.headers };
      reqHeaders.host = hostHeader;

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
        this.releaseTunnel(tunnel, 'http-request');
      };

      // 连接关闭时释放连接
      res.socket.on('close', releaseTunnel);
      stream.on('close', releaseTunnel);

      // 添加错误处理
      res.socket.on('error', releaseTunnel);
      stream.on('error', releaseTunnel);
    } catch (err) {
      // 确保在出现错误时释放连接
      this.loggerMiddleware.logSshEvent('error', { target: `${targetHost}:${targetPort}`, via: 'http-request', error: err.message });
      this.releaseTunnel(tunnel, 'http-request');
      this.handleProxyError(err, res, 'HTTP proxy error');
    }
  }

  /**
   * 记录连接池状态
   * D-111：只输出数值字段，不再打印整个状态对象；D-112：判定基于 config.testingMode，else 分支可达
   * @param {string} context - 上下文信息
   */
  logPoolStatus(context) {
    const status = !this.config.testingMode && this.connectionPool && typeof this.connectionPool.getStatus === 'function'
      ? this.connectionPool.getStatus()
      : null;

    if (status) {
      console.log(`Acquiring connection from pool for ${context}:`);
      console.log(`  Available tunnels: ${status.available}, in use: ${status.used}, total: ${status.total}`);
      // 池数值指标（消费 C3 的 logPerformance）
      this.loggerMiddleware.logPerformance('pool_available_tunnels', status.available, {
        context,
        used: status.used,
        total: status.total
      });
      this.logVerbose('pool status', { context, available: status.available, used: status.used, total: status.total });
    } else {
      console.log('Using direct connection in testing mode');
    }
  }

  /**
   * 获取SSH隧道连接
   * @returns {Promise<Object|null>} 隧道连接对象
   */
  async acquireTunnel() {
    if (!this.connectionPool || typeof this.connectionPool.acquire !== 'function') {
      return null;
    }

    const tunnel = await this.connectionPool.acquire();

    // 隧道事件日志（消费 C3 的 logSshEvent）
    if (tunnel) {
      this.loggerMiddleware.logSshEvent('acquired', { phase: 'acquire' });
    }
    this.logVerbose('tunnel acquired', { hasTunnel: Boolean(tunnel) });

    return tunnel;
  }

  /**
   * 释放隧道连接（统一出口：池释放 + 事件日志，跨 HTTPS/HTTP/SOCKS 三条路径）
   * @param {Object|null} tunnel - 隧道对象
   * @param {string} context - 释放来源
   */
  releaseTunnel(tunnel, context = 'unknown') {
    if (!tunnel || !this.connectionPool || typeof this.connectionPool.release !== 'function') {
      return;
    }

    this.connectionPool.release(tunnel);
    this.loggerMiddleware.logSshEvent('released', { via: context });
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
      // HTTP响应错误处理：headersSent 判定（D-108）
      const res = responseOrSocket;
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
      }
      // 写保护：已结束的响应不再重复写（避免 ERR_STREAM_WRITE_AFTER_END）
      if (!res.writableEnded) {
        res.end('Proxy Error');
      }
    } else {
      // Socket错误处理：net.Socket 上没有 headersSent（D-108 的原缺陷），按可写状态判定
      const socket = responseOrSocket;
      if (socket.writable && !socket.destroyed && socket.bytesWritten === 0) {
        socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      }
      if (!socket.destroyed) {
        socket.end();
      }
    }
  }

  startSocksProxy() {
    this.socksServer = net.createServer(async (socket) => {
      let tunnel = null;
      try {
        // 连接池状态日志（D-112：testingMode 判定统一在 logPoolStatus 内，else 分支可达）
        this.logPoolStatus('SOCKS');

        tunnel = await this.acquireTunnel();
        // 认证配置注入（C3 契约：第二参数可选，缺省保持原行为）
        const socksProxy = new Socks5Proxy(tunnel, { auth: this.config.auth });
        const handshakeStartedAt = Date.now();

        // 处理SOCKS5握手
        socket.once('data', async (data) => {
          try {
            await socksProxy.handleRequest(socket, data);
            // 性能指标（消费 C3 的 logPerformance；路径 3/3：SOCKS5 握手）
            this.loggerMiddleware.logPerformance('socks5_handshake_ms', Date.now() - handshakeStartedAt, { via: 'socks' });
          } catch (err) {
            this.loggerMiddleware.logError(err, 'SOCKS5 handshake error');
            // 如果握手失败，确保释放连接
            if (tunnel) {
              this.releaseTunnel(tunnel, 'socks-handshake');
              tunnel = null;
            }
            socket.end();
          }
        });

        // 确保在所有情况下都能释放连接
        const releaseTunnel = () => {
          if (tunnel) {
            this.releaseTunnel(tunnel, 'socks');
            tunnel = null;
          }
        };

        socket.on('close', releaseTunnel);
        socket.on('error', (err) => {
          this.loggerMiddleware.logError(err, 'SOCKS5 socket error');
          this.loggerMiddleware.logSshEvent('error', { via: 'socks', error: err.message });
          releaseTunnel();
        });

        // 添加超时处理，防止连接长时间占用
        const idleTimeout = (this.config.connectionPool && this.config.connectionPool.idleTimeout) || 60000;
        socket.setTimeout(idleTimeout, () => {
          console.log('SOCKS5 socket timeout, releasing connection');
          releaseTunnel();
          socket.end();
        });
      } catch (err) {
        this.loggerMiddleware.logError(err, 'SOCKS5 proxy error');
        this.loggerMiddleware.logSshEvent('error', { via: 'socks', error: err.message });
        // 如果获取连接失败或出现其他错误，确保释放已获取的连接
        this.releaseTunnel(tunnel, 'socks-error');
        socket.end();
      }
    });

    this.socksServer.listen(...this.listenOptions(this.config.proxy.socksPort));
  }

  startPacService() {
    // PAC 路由：/proxy.pac 走默认内容；/pac/:name 按名取文件（D-015/D-105）
    // 两条路由均先经 Worker 池投递（A21 热路径消费），失败/不可用时回落主线程 PacService
    this.app.get('/proxy.pac', async (req, res) => {
      const rendered = await this.renderPacViaWorker(null);
      if (rendered) {
        res.writeHead(200, {
          'Content-Type': 'application/x-ns-proxy-autoconfig',
          'Content-Length': Buffer.byteLength(rendered)
        });
        res.end(rendered);
        return;
      }
      this.pacService.handleRequest(req, res);
    });
    this.app.get('/pac/:name', async (req, res) => {
      const rendered = await this.renderPacViaWorker(req.params.name);
      if (rendered) {
        res.writeHead(200, {
          'Content-Type': 'application/x-ns-proxy-autoconfig',
          'Content-Length': Buffer.byteLength(rendered)
        });
        res.end(rendered);
        return;
      }
      this.pacService.handleRequest(req, res);
    });

    this.pacServer = this.app.listen(...this.listenOptions(this.config.proxy.pacPort));
  }

  startAdminService() {
    // adminPort 唯一来源为配置（D-116 / plan R-2）：缺键时不得静默兜底，改为不监听 + 可解释日志
    if (!this.config.proxy.adminPort) {
      // D7-truth（T-3）：原字符串**只写文件名、不带任何 `tasks/.../handoff/` 路径**（仓库内不存在同名文件）
      // ⇒ 进程会输出一条指向不存在文件的提示。改为**存在**登记文件的**成立锚点**：
      // `tasks/D4-docs/handoff/cross_chunk_request.md` 的 CC-D4-8 即本运行时字符串的权威登记条目
      //（该条原文标注「本块不可改」⇒ 由 D7-truth 落地修复）。**仅提示文本变更，无逻辑变更**。
      console.warn('Admin endpoint is enabled but proxy.adminPort is not configured: admin endpoint NOT listening (awaiting config key, see tasks/D4-docs/handoff/cross_chunk_request.md CC-D4-8)');
      return;
    }

    // 管理凭证的唯一生成点（D-110）：日志打印与 /api/* 校验共用同一实例值
    const credentials = this.getAdminCredentials();

    // 添加认证中间件
    this.adminApp.use('/api/*', (req, res, next) => {
      const authHeader = req.headers.authorization;

      // D-1 防御性固化（兄弟路径排查）：管理凭据为空时同样是「空===空」的 fail-open 形态。
      // 当前 `getAdminCredentials()` 只会返回「配置值」或「随机生成值」，两条路径都非空，
      // 故这是**防御性**判据而非在修复现存缺陷；一旦未来生成逻辑退化或配置校验前移，
      // 它保证管理端点仍然 fail-closed（拒绝一切）而不是「谁都能进」。
      const adminRejectsAnonymous = !hasValidCredentials(credentials);
      if (adminRejectsAnonymous) {
        if (!this.adminConfigWarned) {
          console.warn('Admin auth warning: admin credentials are empty or invalid — all /api/* requests are denied (fail-closed)');
          this.adminConfigWarned = true;
        }
        res.writeHead(401, {
          'WWW-Authenticate': 'Basic realm="Admin Service"'
        });
        res.end('Unauthorized');
        return;
      }

      if (!authHeader || !authHeader.startsWith('Basic ')) {
        res.writeHead(401, {
          'WWW-Authenticate': 'Basic realm="Admin Service"'
        });
        res.end('Unauthorized');
        return;
      }

      const base64Credentials = authHeader.split(' ')[1];
      // D7-truth（T-2）：解码 + 切分统一消费唯一真源 parseBasicCredentials（base64 原文入参，utf8 解码）。
      // 本处原为 `Buffer.from(base64Credentials, 'base64').toString('ascii')` —— `'ascii'` 逐字节
      // `& 0x7F` 截为 7 位 ⇒ 非 ASCII 管理凭据被静默改写（跨面漂移）；切分原为 `split(':')`（D5 已收敛）。
      // 入参 MUST 是 base64 原文（不是已解码明文）：前任改写此处时误删了上面这行声明 ⇒ ReferenceError（500）。
      const parsed = parseBasicCredentials(base64Credentials);

      // 不可解析（无 ':'）⇒ fail-closed 拒绝，不放行也不抛异常
      if (!parsed) {
        res.writeHead(401, {
          'WWW-Authenticate': 'Basic realm="Admin Service"'
        });
        res.end('Unauthorized');
        return;
      }

      const { username, password } = parsed;

      // 校验值来自唯一生成点；F9：常量时间比较（两个比较都执行，不做短路）
      const usernameMatches = constantTimeEqual(username, credentials.username);
      const passwordMatches = constantTimeEqual(password, credentials.password);

      if (usernameMatches && passwordMatches) {
        next();
      } else {
        res.writeHead(401, {
          'WWW-Authenticate': 'Basic realm="Admin Service"'
        });
        res.end('Unauthorized');
      }
    });

    this.registerAdminRoutes(this.adminApp);

    // adminPort 唯一来源为配置（D-116：不再有端口硬编码兜底）
    this.adminServer = this.adminApp.listen(...this.listenOptions(this.config.proxy.adminPort));
  }

  /**
   * 注册管理端点（D-012/D-013：真读写配置 + 真状态）
   * @param {import('express').Express} app - 管理端点 Express 实例
   */
  registerAdminRoutes(app) {
    app.use(express.json());

    app.post('/api/config', (req, res) => {
      try {
        // 真读写：深合并进 this.config（非空壳响应）
        this.updateConfig(req.body || {});
        const validationErrors = validateConfig(this.config);

        res.json({
          message: 'Configuration updated',
          config: this.describeConfig(),
          validation: { valid: validationErrors.length === 0, errors: validationErrors }
        });
      } catch (err) {
        res.status(400).json({
          message: 'Failed to update configuration',
          error: err.message
        });
      }
    });

    app.get('/api/status', (req, res) => {
      // 状态来自池的真实契约 getStatus()（D-107：不再读池上不存在的字段）
      res.json(this.getStatus());
    });
  }

  async stop() {
    // 关闭所有服务器
    if (this.httpServer) {
      this.httpServer.close();
    }

    if (this.httpsServer) {
      this.httpsServer.close();
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

    // 关闭连接池（testingMode 的占位池没有 close，须守卫）
    if (this.connectionPool && typeof this.connectionPool.close === 'function') {
      await this.connectionPool.close();
    }

    // RT-02/X5：停止维护定时器（H3-S302 的可达性前提）——必须在池 close 之后调用，
    // 否则 refill 建连在途时关闭池，维护路径仍会尝试向已关闭的池注入隧道。
    // stopMaintenance() 幂等（定时器数组清空后再调用是 no-op），故重复 stop() 安全。
    if (this.connectionInitializer && typeof this.connectionInitializer.stopMaintenance === 'function') {
      this.connectionInitializer.stopMaintenance();
    }

    // 释放中间件资源（C3 契约提供 stop/close；旧版无该方法时跳过）
    if (typeof this.rateLimitMiddleware.stop === 'function') {
      this.rateLimitMiddleware.stop();
    } else if (typeof this.rateLimitMiddleware.close === 'function') {
      this.rateLimitMiddleware.close();
    }

    // 关闭 Worker 池（C5 契约 close() → Promise<void>；旧版同步 close 亦可）
    if (this.workerManager && typeof this.workerManager.close === 'function') {
      await this.workerManager.close();
    }
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

    // D-1（H1-S401）：凭据有效性前置判据 —— 必须在比较之前（fail-closed）。
    // 配置里 username/password 任一为空时，`constantTimeEqual('', '')` 会返回 true，
    // 使客户端用空凭据（Basic Og==）或仅用户名（Basic dTo=）即被放行并真实转发。
    // 配置不合法 ⇒ 拒绝一切入站认证，且不回退到「谁都能进」。
    if (!hasValidCredentials(this.config.auth)) {
      if (!this.authConfigWarned) {
        console.warn('Proxy auth warning: auth.enabled=true but auth.username/auth.password is missing or empty — all inbound proxy authentication is denied (fail-closed)');
        this.authConfigWarned = true;
      }
      return { authenticated: false, username: null };
    }

    try {
      const base64Credentials = authHeader.split(' ')[1];
      // D7-truth（T-2）：解码 + 切分统一消费唯一真源 parseBasicCredentials（base64 原文入参，utf8 解码）。
      // 原实现 `Buffer.from(credentials, 'base64').toString('ascii')` 会逐字节 `& 0x7F` 截为 7 位
      // ⇒ 非 ASCII 代理凭据在代理面被判错，而 Express basicAuth（utf8）放行 ⇒ **跨面漂移**（有意修正）。
      // 切分原为 `credentials.split(':')`（D5 已收敛为「首个 ':' 前为用户名、其余全部为口令」）。
      const parsed = parseBasicCredentials(base64Credentials);
      if (!parsed) {
        // 无 ':' ⇒ 凭据不可解析：fail-closed 拒绝（不得回退为「谁都能进」）
        return { authenticated: false, username: null };
      }
      const { username, password } = parsed;

      // F9：常量时间比较；两个比较都执行（不做短路），避免泄漏「用户名是否正确」的时序。
      // 注意：上面已用 hasValidCredentials 保证配置侧两值非空，故这里的比较结果不会出现「空===空」的假通过。
      const usernameMatches = constantTimeEqual(username, this.config.auth.username);
      const passwordMatches = constantTimeEqual(password, this.config.auth.password);

      if (usernameMatches && passwordMatches) {
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