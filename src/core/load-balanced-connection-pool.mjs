import { EventEmitter } from 'events';
import SSHTunnel from './ssh-tunnel.mjs';
import Socks5Tunnel, { resolveSocks5PoolConfig } from './socks-tunnel.mjs';

/**
 * 负载均衡连接池类
 * 允许多个连接共享同一个SSH隧道，提高资源利用率
 */
class LoadBalancedConnectionPool extends EventEmitter {
  /**
   * 构造函数
   * @param {Object} config 连接池配置
   */
  constructor(config) {
    super();
    this.config = config;
    this.pool = []; // 可用隧道池（connectionCount === 0）
    this.usedTunnels = []; // 正在使用的隧道列表（connectionCount > 0）
    const poolConfig = config.connectionPool || {};
    this.maxSize = poolConfig.maxSize;
    this.minSize = poolConfig.minSize;
    this.acquireTimeout = poolConfig.acquireTimeout;
    this.idleTimeout = poolConfig.idleTimeout;
    this.maxConnectionsPerTunnel = poolConfig.maxConnectionsPerTunnel || 10;
    this.loadBalancingStrategy = poolConfig.loadBalancingStrategy || 'least-connections';
    // 确定隧道类型，默认为ssh
    this.tunnelType = config.tunnel?.type || 'ssh';

    // 维护隧道使用率排序列表，避免每次遍历所有隧道
    this.sortedTunnelList = [];

    // 自动扩容串行化句柄（C2-16：声明在构造函数，回调结束必须复位）
    this.createTunnelTime = null;
    // 池容量等待队列（A7：达 maxSize 后的排队语义）
    this.waiters = [];
    // 瞬时标志：close() 执行期间抑制隧道关闭事件的重入处理
    this.closing = false;
    // 粘性标志（M-B）：close() 之后永久为 true，关闭期间的等待者在微任务恢复时据此拒绝，
    // 不得新建隧道把池复活
    this.closed = false;

    this.stats = {
      acquires: 0,
      releases: 0,
      createdTunnels: 0,
      expansions: 0,
      rejectedAcquires: 0,
      capacityWaits: 0,
      closedTunnels: 0,
      idleReaped: 0,
      // M-B′：关闭窗口内建成但被销毁（未入池）的隧道数
      closingDiscarded: 0
    };
    // H3-S301：ACQUIRE_TIMEOUT 后被回收的孤儿隧道数（可观测，供守恒断言使用）
    this.stats.orphanDiscarded = 0;
    // H7-S307：round-robin 游标（仅 loadBalancingStrategy === 'round-robin' 时参与选路）
    this.roundRobinCursor = 0;
  }

  /** 池上限（未配置视为不设限，保证旧调用点行为不变） */
  limitMaxSize() {
    return Number.isFinite(this.maxSize) && this.maxSize > 0 ? this.maxSize : Infinity;
  }

  total() {
    return this.pool.length + this.usedTunnels.length;
  }

  /**
   * 初始化连接池，创建最小数量的隧道连接
   */
  async initialize() {
    // M-B′：池已关闭时不得再注入隧道（外部调用属未定义行为，统一以 POOL_CLOSED 拒绝）
    this.throwIfClosed();

    console.log(`Initializing load balanced connection pool with ${this.tunnelType} tunnels...`);
    // 预初始化连接
    for (let i = 0; i < this.minSize; i++) {
      try {
        const tunnelObject = await this.createTunnel();
        // M-B″/H3-S302：attach() 在关闭态返回 null（并销毁该隧道），此时 MUST NOT 继续预建
        if (!this.attach(tunnelObject)) {
          console.warn('Pool was closed while initializing; aborting pre-fill');
          break;
        }
        console.log(`Initialized tunnel ${i + 1}/${this.minSize}`);
      } catch (err) {
        console.error('Failed to initialize tunnel:', err);
      }
    }
    // 初始化排序列表
    this.updateSortedTunnelList();
  }

  /**
   * 创建新的隧道（根据配置选择SSH或SOCKS5）
   * @returns {Promise<Object>} 隧道对象
   */
  async createTunnel() {
    let tunnel;
    console.log(`Creating tunnel of type: ${this.tunnelType}`);
    if (this.tunnelType === 'socks5') {
      // 使用SOCKS5隧道配置
      const socks5Config = this.config.upstreamSocks5 || {};
      // C2-01：池参数必须真实传给隧道构造点（原先此处不传 pool，四项参数全部失效）
      const socksPoolConfig = resolveSocks5PoolConfig(this.config);
      console.log('Using SOCKS5 configuration:', {
        host: socks5Config.host,
        port: socks5Config.port,
        username: socks5Config.username ? '***' : 'none',
        pool: socksPoolConfig
      });
      tunnel = new Socks5Tunnel({
        host: socks5Config.host,
        port: socks5Config.port,
        username: socks5Config.username,
        password: socks5Config.password,
        // C2-09：原先传入即弃的重试配置，现在由连接池真实消费
        retryAttempts: this.config.connectionPool?.retryAttempts,
        retryDelay: this.config.connectionPool?.retryDelay,
        pool: socksPoolConfig
      });
    } else {
      // 默认使用SSH隧道
      console.log('Using SSH configuration');
      tunnel = new SSHTunnel(this.config.ssh);
    }

    // 事件接线（C2-06/C2-07：connect/close/end/error 必须有真实消费者）
    this.wireTunnelEvents(tunnel);

    console.log('Connecting to tunnel...');
    await tunnel.connect();
    console.log('Tunnel connected successfully');

    const tunnelObject = {
      tunnel,
      connectionCount: 0,
      lastUsed: Date.now(),
      isActive: true
    };

    this.stats.createdTunnels++;
    return tunnelObject;
  }

  /**
   * 为隧道挂载生命周期监听器；close/end 时把隧道移出池（A9 CLOSE_WIRED）
   */
  wireTunnelEvents(tunnel) {
    if (!tunnel || typeof tunnel.on !== 'function') return;
    tunnel.on('connect', () => {
      console.log(`[pool] tunnel connected (${this.tunnelType})`);
    });
    tunnel.on('close', () => this.handleTunnelClosed(tunnel, 'close'));
    tunnel.on('end', () => this.handleTunnelClosed(tunnel, 'end'));
    tunnel.on('retry', (info) => {
      console.warn(`[pool] tunnel retry #${info?.attempt} scheduled in ${info?.delay}ms`);
    });
    tunnel.on('error', (err) => {
      console.error('[pool] tunnel error:', err && err.message ? err.message : err);
    });
  }

  /** 隧道关闭/结束 → 从池中移除并标记失效 */
  handleTunnelClosed(tunnel, reason) {
    const tunnelObject = this.findTunnelObject(tunnel);
    if (!tunnelObject || tunnelObject.isActive === false) return;

    const wasUsed = this.usedTunnels.includes(tunnelObject);
    tunnelObject.isActive = false;
    this.stats.closedTunnels++;
    this.pool = this.pool.filter(item => item !== tunnelObject);
    this.usedTunnels = this.usedTunnels.filter(item => item !== tunnelObject);
    this.updateSortedTunnelList();
    console.log(`[pool] tunnel removed from pool (reason=${reason}), total=${this.total()}`);
    this.emit('tunnelClosed', { reason, total: this.total() });

    // 容量被释放：唤醒排队者（池整体关闭时不需要唤醒，等待者会自行识别 closing）
    if (!this.closing && wasUsed) this.dispatchWaiters();
  }

  findTunnelObject(tunnel) {
    return this.pool.find(item => item.tunnel === tunnel)
      || this.usedTunnels.find(item => item.tunnel === tunnel)
      || null;
  }

  /**
   * 按当前连接数归位到 pool（空闲）或 usedTunnels（使用中）
   *
   * H3-S302：关闭态守护 MUST 覆盖本方法——它是所有「入池」路径的汇聚点
   * （acquire 新建 / initialize / 自动扩容 / 维护补建 / release 回填）。
   * 旧实现只在 acquire/initialize 入口查 closed，维护路径绕过后即可把隧道注入已关闭的池。
   * 关闭时：销毁该隧道对象（计入 closingDiscarded + closedTunnels）并返回 null，调用方据此拒绝/中止。
   * @param {Object} tunnelObject 隧道对象
   * @returns {Object|null} 入池后的隧道对象；池已关闭时返回 null（且隧道已销毁）
   */
  attach(tunnelObject) {
    if (!tunnelObject) return null;
    if (this.closed) {
      this.discardTunnelObject(tunnelObject, 'attach-after-close');
      return null;
    }
    this.pool = this.pool.filter(item => item !== tunnelObject);
    this.usedTunnels = this.usedTunnels.filter(item => item !== tunnelObject);
    if (tunnelObject.connectionCount > 0) this.usedTunnels.push(tunnelObject);
    else this.pool.push(tunnelObject);
    this.updateSortedTunnelList();
    return tunnelObject;
  }

  /**
   * 把**已建成的隧道实例**纳入池（H3-S302：为维护路径提供的公开 API）
   * 生产维护路径原先直写 `connectionPool.pool.push({...})`：既绕过关闭态守护，也不计 `stats.createdTunnels`。
   * 本方法统一承担「关闭态拒绝 + 计数 + 入池」三件事，使关闭态保证覆盖该路径。
   * @param {Object} tunnel 已连接（或即将连接）的隧道实例
   * @returns {Object|null} 入池后的隧道对象；池已关闭时返回 null（且隧道已关闭）
   */
  registerTunnel(tunnel) {
    if (!tunnel) return null;
    if (this.closed) {
      try {
        if (typeof tunnel.close === 'function') tunnel.close();
      } catch (err) {
        console.warn('Failed to close tunnel rejected by closed pool:', err && err.message ? err.message : err);
      }
      this.stats.rejectedAcquires++;
      return null;
    }
    const tunnelObject = {
      tunnel,
      connectionCount: 0,
      lastUsed: Date.now(),
      isActive: true
    };
    // 审查门登记项：registerTunnel 入池的隧道同样 MUST 挂生命周期监听器，
    // 否则其 close/end/error 不会把对象移出池（与 createTunnel 的 wireTunnelEvents 口径一致）
    this.wireTunnelEvents(tunnel);
    this.stats.createdTunnels++;
    if (!this.attach(tunnelObject)) {
      return null;
    }
    return tunnelObject;
  }

  detach(tunnelObject) {
    this.pool = this.pool.filter(item => item !== tunnelObject);
    this.usedTunnels = this.usedTunnels.filter(item => item !== tunnelObject);
    this.updateSortedTunnelList();
  }

  /**
   * 更新隧道使用率排序列表
   */
  updateSortedTunnelList() {
    const allTunnels = [...this.usedTunnels];
    this.sortedTunnelList = allTunnels.sort((a, b) => {
      return a.connectionCount - b.connectionCount;
    });
  }

  /**
   * 获取使用率最低的隧道
   * @returns {Object|null} 隧道对象或null
   */
  getLeastUsedTunnel() {
    if (this.sortedTunnelList.length === 0) {
      return null;
    }
    return this.sortedTunnelList[0];
  }

  /**
   * 选择可承接新连接的隧道（策略由 `connectionPool.loadBalancingStrategy` 决定，H7-S307）
   *
   * 支持的策略（未识别值回落 'least-connections' 并可观测）：
   *  - `'least-connections'`（默认）：比较 `connectionCount`，平手按 `lastUsed`（C2-04；
   *    且必须未达单隧道连接阈值 `maxConnectionsPerTunnel`）；
   *  - `'round-robin'`：在**合格**隧道间按游标轮转（同样排除已达阈值的隧道），
   *    使 `--load-balancing-strategy round-robin` 之类配置真正改变分派行为，而不再只是被回显。
   * @returns {Object|null} 可承接新连接的隧道对象
   */
  selectLeastLoadedTunnel() {
    const all = [...this.pool, ...this.usedTunnels].filter(item => item.isActive !== false);
    const eligible = all.filter(item => item.connectionCount < this.maxConnectionsPerTunnel);
    if (eligible.length === 0) return null;

    if (this.loadBalancingStrategy === 'round-robin') {
      const index = this.roundRobinCursor % eligible.length;
      this.roundRobinCursor = (index + 1) % Math.max(1, eligible.length);
      return eligible[index];
    }

    // 默认（含未识别值）：least-connections + lastUsed 平手判定
    eligible.sort((a, b) => (a.connectionCount - b.connectionCount) || (a.lastUsed - b.lastUsed));
    return eligible[0];
  }

  /**
   * 获取一个隧道实例用于连接
   * 语义：优先复用未达阈值的隧道 → 未达 maxSize 则新建 → 达上限则排队，超时给出可识别拒绝错误
   * @returns {Promise<Object>}
   */
  async acquire() {
    const startTime = Date.now();
    const timeout = Number.isFinite(this.acquireTimeout) ? this.acquireTimeout : 30000;
    this.throwIfClosed();

    while (true) {
      // M-B：等待者被 close() 唤醒后在此处拒绝，禁止关闭期间新建隧道（池复活）
      this.throwIfClosed();

      const tunnelObject = this.selectLeastLoadedTunnel();
      if (tunnelObject) return this.dispatchTunnel(tunnelObject, startTime);

      // 未达池上限 → 新建隧道（失败则原样抛出，保持旧调用点语义）
      if (this.total() < this.limitMaxSize()) {
        // H3-S301：超时窗口内建成的隧道不得成为孤儿（awaitTunnelWithin 负责超时后销毁）
        const created = await this.awaitTunnelWithin(this.createTunnel(), Math.max(1, timeout - (Date.now() - startTime)));
        // M-B′：await 期间池可能已被 close()，此时新隧道 MUST 销毁且不得入池（否则关闭后仍返回活隧道并复活池）
        if (this.closed) {
          this.discardTunnelObject(created, 'discarded new');
          this.throwIfClosed();
        }
        // M-B″/H3-S302：attach() 内部亦复查 closed（防关闭后经 attach 注活隧道）
        if (!this.attach(created)) {
          this.throwIfClosed();
          const error = new Error('Connection acquire rejected: pool is closed');
          error.code = 'POOL_CLOSED';
          throw error;
        }
        return this.dispatchTunnel(created, startTime);
      }

      // 池已达上限：明确的排队语义 + 可识别拒绝（A7：非静默超限）
      const remaining = timeout - (Date.now() - startTime);
      if (this.closing || this.closed || remaining <= 0) {
        this.stats.rejectedAcquires++;
        this.emit('saturated', { maxSize: this.maxSize, total: this.total() });
        const error = new Error(`Connection acquire rejected: pool at capacity (maxSize=${this.maxSize})`);
        error.code = 'POOL_AT_CAPACITY';
        throw error;
      }

      this.stats.capacityWaits++;
      await this.waitForCapacity(Math.min(remaining, 250));
    }
  }

  /** 关闭后调用 acquire()/initialize() 的统一拒绝（M-B，粘性标志；M-B′ 亦覆盖 await 窗口） */
  throwIfClosed() {
    if (!this.closed) return;
    this.stats.rejectedAcquires++;
    const error = new Error('Connection acquire rejected: pool is closed');
    error.code = 'POOL_CLOSED';
    throw error;
  }

  /**
   * 关闭窗口内已建成的隧道：立即销毁且不入池（M-B′）
   * 说明：`createTunnel()` 已执行（计入 createdTunnels），但该隧道不得进入池。
   *
   * 守恒式（H3-S301 修正）：被销毁而**从未入池**的隧道有两条来源，均须计入——
   *   ① `closingDiscarded`：关闭窗口内建成（`reason` 为关闭相关，如 `discarded new` / `attach-after-close`）；
   *   ② `orphanDiscarded`：`ACQUIRE_TIMEOUT` 后被回收的孤儿（`reason` 含 `orphaned`）。
   * 因此「净入池 = createdTunnels − closingDiscarded − orphanDiscarded」；
   * 旧注释漏掉 ②，正是 H3-S301 的资源泄漏在注释层面的体现（超时路径上的已握手隧道曾被永久孤立）。
   * @param {Object} tunnelObject 隧道对象
   * @param {string} [reason] 处置原因（用于日志与计数归类）
   */
  discardTunnelObject(tunnelObject, reason = 'discarded') {
    if (!tunnelObject) return;
    tunnelObject.isActive = false;
    // H3-S301：孤儿（超时回收）与关闭窗口丢弃分开计数，便于守恒断言区分
    if (String(reason).includes('orphan')) this.stats.orphanDiscarded++;
    else this.stats.closingDiscarded++;
    this.stats.closedTunnels++;
    try {
      tunnelObject.tunnel.close();
    } catch (err) {
      console.warn(`Failed to close ${reason} tunnel:`, err && err.message ? err.message : err);
    }
  }

  /**
   * 在超时窗口内等待建连，超时即拒绝且**不得留下孤儿隧道**（H3-S301）
   * 说明：createTunnel() 一经调用就会跑到底并 `stats.createdTunnels++`（它无法被取消），
   * 因此超时分支必须显式接管「稍后建成」的隧道对象并销毁，否则会出现
   * `createdTunnels - closingDiscarded - orphanDiscarded > total()` 的资源泄漏（已握手的隧道永不 close）。
   * 实现要点：不复用普通 `Promise.race` 超时器（它在超时后无法再捕获另一分支的兑现），
   * 而是显式挂 `then/catch`，保证「兑现即处置」。
   * @param {Promise<Object>} promise createTunnel() 的 Promise
   * @param {number} ms 允许的等待毫秒数
   * @returns {Promise<Object>} 隧道对象（仅在窗口内建成时）
   * @throws {Error} code=ACQUIRE_TIMEOUT（超时，隧道已异步处置）
   */
  async awaitTunnelWithin(promise, ms) {
    let timer = null;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error('Connection acquire timeout');
        error.code = 'ACQUIRE_TIMEOUT';
        reject(error);
      }, ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } catch (err) {
      if (err && err.code === 'ACQUIRE_TIMEOUT') {
        // 超时：接管稍后建成的隧道并立即销毁（孤儿回收），不改变本分支的拒绝结果
        promise.then(
          (created) => this.discardTunnelObject(created, 'orphaned by acquire timeout'),
          () => {}
        ).catch(() => {});
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 排队等待容量释放 */
  waitForCapacity(ms) {
    return new Promise((resolve) => {
      const waiter = {
        timer: null,
        release: null
      };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter(item => item !== waiter);
        resolve();
      }, ms);
      waiter.release = () => {
        clearTimeout(waiter.timer);
        resolve();
      };
      this.waiters.push(waiter);
    });
  }

  /** 唤醒所有排队者（释放/扩容/隧道关闭后调用） */
  dispatchWaiters() {
    if (this.waiters.length === 0) return;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.release();
  }

  /** 分配隧道：计入连接数、刷新 lastUsed，并在达阈值时触发扩容 */
  dispatchTunnel(tunnelObject, startTime) {
    tunnelObject.connectionCount++;
    // C2-05：使用即刷新空闲判据，避免 cleanupIdleTunnels 误杀在用隧道
    tunnelObject.lastUsed = Date.now();
    this.attach(tunnelObject);
    this.stats.acquires++;

    const acquireTime = Date.now() - startTime;
    if (acquireTime > 100) {
      console.warn(`Tunnel acquisition took ${acquireTime}ms, which is longer than expected`);
    }

    this.scheduleExpansion(tunnelObject);
    return tunnelObject.tunnel;
  }

  /**
   * 达单隧道阈值时自动扩容（C2-16：标志位在回调结束复位，可连续触发；
   * 且不得越过 maxSize —— 与 A7 联动）
   */
  scheduleExpansion(tunnelObject) {
    if (tunnelObject.connectionCount < this.maxConnectionsPerTunnel) return false;
    if (this.createTunnelTime) return false;
    if (this.total() >= this.limitMaxSize()) return false;

    this.createTunnelTime = setImmediate(async () => {
      try {
        // 回调内二次校验：排队期间池可能已被其他 acquire 填满，不得越过 maxSize（A7 联动）
        if (this.total() >= this.limitMaxSize()) return;
        const newTunnelObject = await this.createTunnel();
        // M-B′：await 期间池可能已被 close()，新隧道 MUST 销毁且不入池（否则形成真空闲隧道泄漏）
        if (this.closed) {
          this.discardTunnelObject(newTunnelObject, 'auto-expanded');
          return;
        }
        // M-B″/H3-S302：attach() 关闭态返回 null 且已销毁隧道，不得继续计数/唤醒
        if (!this.attach(newTunnelObject)) {
          return;
        }
        this.stats.expansions++;
        console.log(`Created new tunnel, total pool size: ${this.pool.length}, tunnelObject count: ${tunnelObject.connectionCount}`);
        this.dispatchWaiters();
      } catch (err) {
        console.error('Failed to auto-expand tunnel pool:', err && err.message ? err.message : err);
      } finally {
        // 复位标志位：否则自动扩容路径在首次触发后永久失效
        this.createTunnelTime = null;
      }
    });
    return true;
  }

  /**
   * 释放隧道连接
   * @param {Object} tunnel 要释放的隧道实例
   */
  release(tunnel) {
    // 查找隧道对象
    const tunnelObject = this.findTunnelObject(tunnel);

    if (!tunnelObject) {
      console.warn('Tried to release a tunnel that is not managed by this pool:' + tunnel);
      return;
    }

    this.stats.releases++;

    if (tunnelObject.connectionCount > 0) {
      tunnelObject.connectionCount--;
    }
    // C2-05：释放即刷新 lastUsed
    tunnelObject.lastUsed = Date.now();

    // M-B：池已关闭 → 不再回填（避免把池复活），仅关闭隧道
    if (this.closed) {
      this.detach(tunnelObject);
      try {
        tunnel.close();
      } catch (err) {
        console.warn('Failed to close released tunnel after pool close:', err && err.message ? err.message : err);
      }
      return;
    }

    if (tunnel.isConnected === false) {
      // 隧道已断开 → 移出池并关闭
      this.detach(tunnelObject);
      try {
        tunnel.close();
      } catch (err) {
        console.warn('Failed to close released tunnel:', err && err.message ? err.message : err);
      }
    } else {
      // M-B″/H3-S302：关闭态下 attach() 返回 null（隧道已销毁），不得回填
      this.attach(tunnelObject);
    }

    // 容量释放：唤醒排队者（A7）
    this.dispatchWaiters();
  }

  /**
   * 关闭所有隧道连接
   */
  async close() {
    if (this.closed) return;
    // 粘性关闭标志（M-B）：此后 acquire()/release() 一律拒绝或忽略，池不可复活
    this.closed = true;
    this.closing = true;
    if (this.createTunnelTime) {
      clearImmediate(this.createTunnelTime);
      this.createTunnelTime = null;
    }
    // 唤醒排队者：它们在微任务恢复时经 throwIfClosed() 以 POOL_CLOSED 拒绝，而不是悬挂到超时或新建隧道
    this.dispatchWaiters();

    const tunnels = [...this.pool, ...this.usedTunnels];
    this.pool = [];
    this.usedTunnels = [];
    this.sortedTunnelList = [];

    for (const tunnelObject of tunnels) {
      tunnelObject.isActive = false;
      try {
        tunnelObject.tunnel.close();
      } catch (err) {
        console.warn('Failed to close tunnel:', err && err.message ? err.message : err);
      }
    }
    // 仅复位瞬时标志；this.closed 保持 true（粘性，M-B）
    this.closing = false;
  }

  /**
   * 清理空闲隧道（判据为 lastUsed，C2-05）
   * @returns {number} 被回收的隧道数
   */
  cleanupIdleTunnels() {
    const now = Date.now();
    let reaped = 0;
    this.pool = this.pool.filter(tunnelObject => {
      if (now - tunnelObject.lastUsed > this.idleTimeout) {
        tunnelObject.isActive = false;
        reaped++;
        this.stats.idleReaped++;
        try {
          tunnelObject.tunnel.close();
        } catch (err) {
          console.warn('Failed to close idle tunnel:', err && err.message ? err.message : err);
        }
        return false;
      }
      return true;
    });

    // 更新排序列表
    this.updateSortedTunnelList();
    if (reaped > 0) this.dispatchWaiters();
    return reaped;
  }

  /**
   * 获取连接池状态信息
   * 契约冻结：继续返回 {available, used, total, usedDetails}（MUST NOT 新增 usedConnections 别名）
   * @returns {Object} 状态信息
   */
  getStatus() {
    return {
      available: this.pool.length,
      used: this.usedTunnels.length,
      total: this.pool.length + this.usedTunnels.length,
      maxSize: this.maxSize,
      minSize: this.minSize,
      maxConnectionsPerTunnel: this.maxConnectionsPerTunnel,
      loadBalancingStrategy: this.loadBalancingStrategy,
      waiting: this.waiters.length,
      closed: this.closed,
      usedDetails: this.usedTunnels.map(tunnelObject => ({
        connectionCount: tunnelObject.connectionCount
      })),
      stats: { ...this.stats }
    };
  }
}

export default LoadBalancedConnectionPool;
