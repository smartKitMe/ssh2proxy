import { Worker, isMainThread, parentPort, threadId } from 'worker_threads';

/**
 * Worker 池（`node:worker_threads`）——把 README:18 / CLAUDE.md:44 声称的 Multi-threading
 * 兑现为真实实现：真实容量、非固定 workers[0] 的分发、队列与背压、错误传播与崩溃补位、
 * `getStats()` 可观测、无 worker 时同一 handler 表的主线程降级执行。
 *
 * 冻结调用签名（C5 简报 §4 / RD-18，C4 按此调用）：
 *   new WorkerManager({ size?: number, workerPath?: URL })
 *   await start(): Promise<{ size: number, threadIds: number[] }>
 *   assignTask(taskData: { type: string, ...payload }): Promise<any>
 *   getStats(): { size, degraded, totalTasks, queued, workers: [{ index, threadId, tasks, state }] }
 *   await close(): Promise<void>
 *
 * 跨线程序列化约束：payload 与返回值 MUST 可结构化克隆（禁函数 / Worker / Stream / Tunnel /
 * Socket 等句柄），违反时按 `DataCloneError` 语义给出清晰错误。
 */

/** 池容量默认值（配置键 `proxy.workerPoolSize` 优先；默认值经 CC-2 交 C4 落 `default.config.mjs`） */
const DEFAULT_POOL_SIZE = 2;
/** 等待队列上限（背压）：队列满即拒绝并给出可识别错误，避免无界内存增长 */
const MAX_QUEUED_TASKS = 1024;
/** 单个索引的崩溃补位次数上限，避免崩溃-重启死循环 */
const MAX_RESTARTS_PER_WORKER = 3;
/** 崩溃补位延迟（毫秒），避免同步紧密重启 */
const RESTART_DELAY_MS = 25;

/** 线程内计数器（每个线程各自持有模块实例，故该值可分辨 handler 实际执行线程） */
let threadLocalCalls = 0;

/** 任务类型 → handler 映射表：主线程与 worker 线程共用同一份表（降级路径与池内路径同形同值） */
const taskHandlers = {
  /** 线程内计数器：观测 handler 实际执行在哪个线程（各线程模块实例独立，主线程读到 0 即未被使用） */
  async tick() {
    threadLocalCalls += 1;
    return { tick: threadLocalCalls, threadId };
  },

  /**
   * 通用计算探针：纯函数、输入输出均可结构化克隆
   * @param {{ value?: number, delayMs?: number }} payload
   * @returns {Promise<Object>} 计算结果（含执行所在线程信息）
   */
  async probe(payload = {}) {
    const value = Number(payload.value) || 0;
    const delayMs = Number(payload.delayMs) || 0;
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return {
      value: value * 2 + 1,
      delayMs,
      threadId,
    };
  },

  /** 错误传播探针：按 payload.message 抛错，用于验证 assignTask 保留原始 message */
  async throwError(payload = {}) {
    const error = new Error(payload.message || 'worker handler failure');
    error.name = payload.name || 'Error';
    throw error;
  },

  /**
   * 崩溃探针：终止本 worker 线程（非 0 退出码），用于验证崩溃补位与 getStats() 真实性。
   * 语义说明（run-lead 裁定条件 B）：在 worker 上下文中调用 `process.exit(1)` **只终止该 worker 线程**，
   * 主进程与其余 worker 存活（主进程侧的 `exit` 事件即崩溃观测点）；因此该调用点 MUST 只在 worker 上下文可达。
   */
  async crash(payload = {}) {
    // 条件 A：主线程（降级路径）可达性防护——主线程调用 `process.exit` 会杀掉整个进程，
    // 故此处显式拒绝，崩溃语义只允许在 worker 线程内表达
    if (isMainThread) {
      throw new Error('crash task is only allowed inside a worker thread (main-thread execution would kill the process)');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.exit(payload.code === undefined ? 1 : payload.code);
  },

  /** 模块/线程隔离探针：worker 侧自增，主线程侧应恒为 0（证明 handler 未在主线程执行） */
  async reportIsolation() {
    threadLocalCalls += 1;
    return { calls: threadLocalCalls, threadId };
  },

  /**
   * PAC 渲染：渲染 PAC 文本，返回含 `FindProxyForURL` 的字符串。
   *
   * 契约（H3-S304 修订：**配置是端口的唯一真源**，本 handler 不含任何硬编码端口）：
   *  - `payload.content` / `payload.raw`（调用方按配置解析好的 PAC 文本，含按名命中的文件内容）→ 原样返回；
   *  - `payload.renderProxy`（调用方按 `config.proxy.socksPort` 归一化后的代理串，模板见
   *    `config.pac.defaultProxy`）→ 用该串渲染模板；
   *  - 以上均缺失 → 抛错（**不再回落 1080**）。旧实现的 `Number(payload.socksPort) || 1080` 会让
   *    `--socks-port 1090` 的部署把浏览器指向未监听的 1080，破坏 `pac-service.mjs` 声明的端口单一来源；
   *    现在端口只可能来自调用方传入的配置值，worker 侧不做任何猜测。
   *  - 未命中语义（保留）：`name` 有值且未随 `content`/`raw` 提供内容、且不在 `knownNames` 中 → 返回 `null`。
   * @param {{ name?: string|null, content?: string, raw?: string, renderProxy?: string, defaultProxy?: string, knownNames?: string[] }} payload
   * @returns {Promise<string|null>} PAC 文本，或 `null` 表示「未命中该名」
   */
  async renderPac(payload = {}) {
    // 显式给定内容（或原始模板）时直接渲染，保证池内与主线程降级同形同值
    if (typeof payload.content === 'string' && payload.content.length > 0) {
      return payload.content;
    }
    if (typeof payload.raw === 'string' && payload.raw.length > 0) {
      return payload.raw;
    }

    const hasName = payload.name !== undefined && payload.name !== null && String(payload.name).length > 0;
    const name = hasName ? String(payload.name) : '';

    // 未命中语义：按名请求但没有可服务内容 → null（调用方据此走 404/回落，而不是拿到假 PAC）
    if (hasName) {
      const known = Array.isArray(payload.knownNames) ? payload.knownNames.map((n) => String(n)) : null;
      if (known && !known.includes(name)) {
        return null;
      }
      if (!known) {
        return null;
      }
    }

    // 端口唯一来源：调用方按 config.proxy.socksPort 归一化后的代理串（本处不做任何端口推断）
    const renderProxy = typeof payload.renderProxy === 'string' && payload.renderProxy.length > 0
      ? payload.renderProxy
      : (typeof payload.defaultProxy === 'string' && payload.defaultProxy.length > 0 ? payload.defaultProxy : null);
    if (!renderProxy) {
      throw new Error(
        'renderPac requires `content`, `raw` or a config-derived `renderProxy`; the worker does not infer proxy ports'
      );
    }

    // 与仓库内 proxy.pac.js 的模板语义一致（本地/内网直连 + 默认 SOCKS5），按名渲染
    return [
      `// SSH2Proxy PAC${name ? ` :: ${name}` : ''}`,
      'function FindProxyForURL(url, host) {',
      '    // 本地地址直连',
      '    if (isPlainHostName(host) ||',
      '        shExpMatch(host, "*.local") ||',
      '        isInNet(dnsResolve(host), "10.0.0.0", "255.0.0.0") ||',
      '        isInNet(dnsResolve(host), "172.16.0.0", "255.240.0.0") ||',
      '        isInNet(dnsResolve(host), "192.168.0.0", "255.255.0.0") ||',
      '        isInNet(dnsResolve(host), "127.0.0.0", "255.255.255.0")) {',
      '        return "DIRECT";',
      '    }',
      '',
      '    // 默认使用SOCKS5代理',
      `    return "${renderProxy}";`,
      '}',
      '',
    ].join('\n');
  },
};

class WorkerManager {
  /**
   * @param {{ size?: number, workerPath?: URL|string, queueLimit?: number, taskTimeoutMs?: number, config?: Object }} [options]
   *   容量优先级：`options.size` > `options.config.proxy.workerPoolSize` > `DEFAULT_POOL_SIZE`（配置键缺失时用声明默认值）
   */
  constructor(options = {}) {
    /** 配置键 `proxy.workerPoolSize` 的原始值（null 表示未配置，走声明默认值；默认值经 CC-2 交 C4 落配置） */
    const configured = options.config && options.config.proxy ? options.config.proxy.workerPoolSize : undefined;
    this.configPoolSize = Number.isFinite(Number(configured)) && Number(configured) > 0
      ? Math.floor(Number(configured))
      : null;

    const explicit = options.size !== undefined && options.size !== null ? Number(options.size) : null;
    const resolved = Number.isFinite(explicit) && explicit > 0
      ? Math.floor(explicit)
      : (this.configPoolSize === null ? DEFAULT_POOL_SIZE : this.configPoolSize);
    /** 池容量：显式 options.size > 配置键 proxy.workerPoolSize > 声明默认值 */
    this.size = resolved;
    this.workerPath = options.workerPath || new URL(import.meta.url);
    this.queueLimit = Number.isFinite(options.queueLimit) ? options.queueLimit : MAX_QUEUED_TASKS;
    /** 背压观测模式：显式给出 queueLimit 时不再自动排空，便于机械断言 queued 深度与超限拒绝 */
    this.autoDrain = !Number.isFinite(options.queueLimit);
    this.taskTimeoutMs = options.taskTimeoutMs || 0;

    /** @type {Worker[]} 真实工作线程句柄（close 后清空） */
    this.workers = [];
    /** @type {Array<{taskId:number,type:string,taskData:Object,resolve:Function,reject:Function}>} 等待队列 */
    this.taskQueue = [];
    this.isSupported = typeof Worker !== 'undefined';

    this.started = false;
    this.closed = false;
    this.nextIndex = 0;
    this.totalTasks = 0;
    /** 主线程降级执行的任务数（加法式字段：A5 判据「主线程 tasks === 0」的承载） */
    this.mainThreadTasks = 0;
    /** @type {Map<number, number>} worker 索引 → 累计完成任务数 */
    this.workerTasks = new Map();
    /** @type {Map<number, string>} worker 索引 → 状态（online/busy/dead/restarting） */
    this.workerStates = new Map();
    /** @type {Map<number, Array<Object>>} worker 索引 → 在途任务记录 */
    this.inflight = new Map();
    /** @type {Map<number, number>} worker 索引 → 已尝试补位次数 */
    this.restarts = new Map();
    this.taskSeq = 0;
  }

  /**
   * 是否支持 worker_threads
   * @returns {boolean}
   */
  isWorkerSupported() {
    return this.isSupported;
  }

  /**
   * 启动池（幂等）：首次调用创建 `size` 个真实工作线程，重复调用不改变容量
   * @returns {Promise<{size:number, threadIds:number[]}>}
   */
  async start() {
    if (this.started) {
      return { size: this.size, threadIds: this.threadIds() };
    }
    if (!this.isSupported) {
      this.started = true;
      return { size: 0, threadIds: [] };
    }

    this.closed = false;
    this.started = true;
    for (let index = 0; index < this.size; index += 1) {
      this.spawnWorker(index);
    }

    await Promise.all(this.workers.map((worker) => this.waitUntilOnline(worker)));
    return { size: this.size, threadIds: this.threadIds() };
  }

  /**
   * 真实 threadId 列表（仅统计存活 worker）
   * @returns {number[]}
   */
  threadIds() {
    return this.workers
      .map((worker) => worker && worker.threadId)
      .filter((id) => typeof id === 'number' && id > 0);
  }

  /**
   * 创建单个工作线程并登记事件（worker 入口 = 自引用本模块，避免在 src/ 下新建文件）
   * @param {number} index
   * @returns {Worker}
   */
  spawnWorker(index) {
    if (!this.isSupported) {
      throw new Error('Worker threads are not supported in this environment');
    }

    const worker = new Worker(this.workerPath);
    this.workers[index] = worker;
    this.workerTasks.set(index, this.workerTasks.get(index) || 0);
    this.workerStates.set(index, 'starting');
    this.inflight.set(index, []);

    worker.on('online', () => {
      this.workerStates.set(index, 'online');
    });
    worker.on('message', (message) => this.handleWorkerMessage(index, message));
    worker.on('messageerror', (err) => {
      this.failWorker(index, worker, new Error(`Worker ${index} messageerror: ${err.message}`));
    });
    worker.on('error', (err) => {
      this.failWorker(index, worker, err);
    });
    worker.on('exit', (code) => {
      this.handleWorkerExit(index, worker, code);
    });

    return worker;
  }

  /**
   * 兼容保留：按路径创建并登记工作线程（同 spawnWorker，索引自动分配）
   * @param {URL|string} [workerPath]
   * @returns {Worker}
   */
  createWorker(workerPath) {
    const index = this.workers.length;
    this.workers[index] = null;
    if (workerPath) {
      this.workerPath = workerPath;
    }
    return this.spawnWorker(index);
  }

  /**
   * 等待 worker 上线（`online` 事件；已上线直接返回）
   * @param {Worker} worker
   * @returns {Promise<void>}
   */
  waitUntilOnline(worker) {
    if (!worker || typeof worker.threadId === 'number') {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        worker.removeListener('online', done);
        worker.removeListener('exit', done);
        worker.removeListener('error', done);
        resolve();
      };
      worker.once('online', done);
      worker.once('exit', done);
      worker.once('error', done);
    });
  }

  /**
   * 分配任务：优先投递到轮询选出的存活 worker；**无任何存活 worker** 时在主线程用同一 handler 表真实执行。
   *
   * H3-S303：降级判据 MUST 覆盖「worker 存在但全部不可用」——旧实现只查 `workers.length === 0`，
   * 当所有索引已 `dead`（重启次数用尽）时 `pickWorkerIndex()` 返回 -1，任务被推入等待队列且
   * `drainQueue()` 永远选不出 worker ⇒ Promise 永不 settle（调用方 `/proxy.pac` 请求永久挂起）。
   * 现在该情形与「池未启动」一并走主线程执行，与 CLAUDE.md/本注释声称的
   * 「main-thread fallback through the same handler table」一致（handler 表共用，结果同形同值）。
   * @param {{type: string}} taskData 任务数据（payload MUST 可结构化克隆）
   * @returns {Promise<any>}
   */
  assignTask(taskData) {
    const type = taskData && taskData.type;
    if (typeof type !== 'string' || type.length === 0) {
      return Promise.reject(new Error('assignTask requires a non-empty string `type`'));
    }
    if (!Object.prototype.hasOwnProperty.call(taskHandlers, type)) {
      return Promise.reject(
        new Error(`Unknown worker task type "${type}" (known: ${Object.keys(taskHandlers).join(', ')})`)
      );
    }

    // 降级：池未启动 / 不支持多线程 / 无存活 worker（全 dead 或缺失）→ 主线程用同一 handler 表真实执行
    if (!this.isSupported || this.workers.length === 0) {
      return this.runOnMainThread(type, taskData);
    }

    const index = this.pickWorkerIndex();
    if (index === -1) {
      // H3-S303：无任何存活 worker（全部 dead/restarting）→ 不再入队（入队将永不 settle）
      return this.runOnMainThread(type, taskData);
    }

    return this.dispatchToWorker(index, type, taskData);
  }

  /**
   * 主线程降级执行（与 worker 内使用同一 handler 表）
   * @param {string} type
   * @param {Object} taskData
   * @returns {Promise<any>}
   */
  async runOnMainThread(type, taskData) {
    const payload = taskData.payload === undefined ? {} : taskData.payload;
    try {
      const result = await taskHandlers[type](payload, { mainThread: true });
      this.totalTasks += 1;
      this.mainThreadTasks += 1;
      return result;
    } catch (err) {
      const error = new Error(err && err.message ? err.message : String(err));
      error.name = (err && err.name) || 'Error';
      throw error;
    }
  }

  /**
   * 选路：轮询游标（跳过 dead/缺失 worker）；所有 worker 均不可用时回退最少负载
   * @returns {number} worker 索引，-1 表示无可用 worker
   */
  pickWorkerIndex() {
    const count = this.workers.length;
    for (let step = 0; step < count; step += 1) {
      const index = (this.nextIndex + step) % count;
      const worker = this.workers[index];
      if (worker && this.workerStates.get(index) !== 'dead' && this.workerStates.get(index) !== 'restarting') {
        this.nextIndex = (index + 1) % count;
        return index;
      }
    }
    return this.leastLoadedIndex();
  }

  /**
   * 最少负载选路（轮询不可用时的兜底）
   * @returns {number}
   */
  leastLoadedIndex() {
    let best = -1;
    let bestLoad = Infinity;
    for (let index = 0; index < this.workers.length; index += 1) {
      const worker = this.workers[index];
      if (!worker || this.workerStates.get(index) === 'dead') {
        continue;
      }
      const load = (this.inflight.get(index) || []).length;
      if (load < bestLoad) {
        bestLoad = load;
        best = index;
      }
    }
    return best;
  }

  /**
   * 投递任务到指定 worker
   * @param {number} index
   * @param {string} type
   * @param {Object} taskData
   * @returns {Promise<any>}
   */
  dispatchToWorker(index, type, taskData) {
    const worker = this.workers[index];
    if (!worker) {
      return this.runOnMainThread(type, taskData);
    }

    this.taskSeq += 1;
    const taskId = this.taskSeq;
    const { type: ignoredType, taskId: ignoredTaskId, ...rest } = taskData;
    const message = { taskId, type, ...rest };

    return new Promise((resolve, reject) => {
      const record = {
        taskId,
        type,
        taskData,
        resolve: (value) => {
          this.totalTasks += 1;
          this.workerTasks.set(index, (this.workerTasks.get(index) || 0) + 1);
          this.workerStates.set(index, 'online');
          resolve(value);
        },
        reject,
        timer: null,
      };

      const timeoutMs = Number.isFinite(taskData.timeoutMs) ? Number(taskData.timeoutMs) : this.taskTimeoutMs;
      if (timeoutMs > 0) {
        record.timer = setTimeout(() => {
          this.settleReject(index, taskId, new Error(`Worker task "${type}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        if (typeof record.timer.unref === 'function') {
          record.timer.unref();
        }
      }

      (this.inflight.get(index) || []).push(record);
      this.workerStates.set(index, 'busy');

      try {
        worker.postMessage(message);
      } catch (err) {
        // 结构化克隆边界：函数 / 句柄 / 流等不可克隆值在此显形
        const error = err && err.name === 'DataCloneError'
          ? Object.assign(new Error(`worker task payload is not structured-cloneable: ${err.message}`), { name: 'DataCloneError' })
          : err;
        this.settleReject(index, taskId, error);
      }
    });
  }

  /**
   * 队列与背压：无可用 worker 时入队等待；超过队列上限即拒绝
   * @param {string} type
   * @param {Object} taskData
   * @returns {Promise<any>}
   */
  enqueueTask(type, taskData) {
    if (this.taskQueue.length >= this.queueLimit) {
      return Promise.reject(
        new Error(`worker task queue is full (limit ${this.queueLimit}); task "${type}" rejected (backpressure)`)
      );
    }
    return new Promise((resolve, reject) => {
      this.taskQueue.push({ type, taskData, resolve, reject });
      if (!this.autoDrain) {
        // 背压观测模式（queueLimit 显式配置时启用）：只入队不自动排空，便于机械断言队列深度
        return;
      }
      this.drainQueue();
    });
  }

  /** 队列排空：有可用 worker 即投递队首任务 */
  drainQueue() {
    let index = this.pickWorkerIndex();
    while (index !== -1 && this.taskQueue.length > 0) {
      const queued = this.taskQueue.shift();
      this.dispatchToWorker(index, queued.type, queued.taskData).then(queued.resolve, queued.reject);
      index = this.pickWorkerIndex();
    }
  }

  /**
   * 处理 worker 回传消息
   * @param {number} index
   * @param {Object} message
   */
  handleWorkerMessage(index, message) {
    if (!message || typeof message !== 'object' || typeof message.taskId !== 'number') {
      const pending = (this.inflight.get(index) || []).slice();
      for (const record of pending) {
        this.settleReject(index, record.taskId, new Error(`malformed worker response: ${String(message)}`));
      }
      return;
    }

    const records = this.inflight.get(index) || [];
    const at = records.findIndex((record) => record.taskId === message.taskId);
    if (at === -1) {
      return;
    }
    const [record] = records.splice(at, 1);
    if (record.timer) {
      clearTimeout(record.timer);
    }

    if (message.ok) {
      record.resolve(message.result);
      return;
    }

    const error = new Error(message.error && message.error.message ? message.error.message : 'worker task failed');
    error.name = (message.error && message.error.name) || 'Error';
    record.reject(error);
  }

  /**
   * 单个任务失败结算（幂等：已结算的记录不再重复结算）
   * @param {number} index
   * @param {number} taskId
   * @param {Error} error
   */
  settleReject(index, taskId, error) {
    const records = this.inflight.get(index) || [];
    const at = records.findIndex((record) => record.taskId === taskId);
    if (at === -1) {
      return;
    }
    const [record] = records.splice(at, 1);
    if (record.timer) {
      clearTimeout(record.timer);
    }
    record.reject(error);
    this.refreshWorkerState(index);
  }

  /**
   * worker 级故障：拒绝该 worker 在途任务（保留原始 message），标记 dead 并尝试补位
   * 其它 worker 的计数与在途任务不受影响
   * @param {number} index
   * @param {Worker} worker
   * @param {Error} err
   */
  failWorker(index, worker, err) {
    const records = (this.inflight.get(index) || []).splice(0);
    for (const record of records) {
      if (record.timer) {
        clearTimeout(record.timer);
      }
      const error = new Error(err && err.message ? err.message : 'worker failed');
      error.name = (err && err.name) || 'Error';
      record.reject(error);
    }
    this.workerStates.set(index, 'dead');
    if (this.workers[index] === worker) {
      this.workers[index] = null;
    }
    this.scheduleRestart(index);
  }

  /**
   * worker 退出：非关闭期一律按崩溃处置（拒绝在途任务 + 标记 dead + 补位）
   * @param {number} index
   * @param {Worker} worker
   * @param {number} code
   */
  handleWorkerExit(index, worker, code) {
    const records = (this.inflight.get(index) || []).splice(0);
    for (const record of records) {
      if (record.timer) {
        clearTimeout(record.timer);
      }
      record.reject(new Error(`worker ${index} exited with code ${code} before completing task "${record.type}"`));
    }

    if (this.closed || !this.started) {
      return;
    }
    if (this.workers[index] !== worker && this.workers[index] !== null) {
      return;
    }
    this.workerStates.set(index, 'dead');
    if (this.workers[index] === worker) {
      this.workers[index] = null;
    }
    this.scheduleRestart(index);
  }

  /**
   * 崩溃补位：重启该索引的 worker（次数上限内），失败则保持 dead（getStats 反映真实数）
   * @param {number} index
   */
  scheduleRestart(index) {
    if (this.closed || !this.started || !this.isSupported) {
      return;
    }
    const attempts = this.restarts.get(index) || 0;
    if (attempts >= MAX_RESTARTS_PER_WORKER) {
      return;
    }
    this.restarts.set(index, attempts + 1);
    this.workerStates.set(index, 'restarting');

    const timer = setTimeout(() => {
      if (this.closed || !this.started) {
        return;
      }
      try {
        const worker = this.spawnWorker(index);
        worker.once('online', () => {
          this.workerStates.set(index, 'online');
          this.drainQueue();
        });
      } catch (err) {
        this.workerStates.set(index, 'dead');
      }
    }, RESTART_DELAY_MS);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  /** 依据在途数量刷新 worker 状态（busy/online），dead 状态不被覆盖 */
  refreshWorkerState(index) {
    if (this.workerStates.get(index) === 'dead' || this.workerStates.get(index) === 'restarting') {
      return;
    }
    if (!this.workers[index]) {
      return;
    }
    const load = (this.inflight.get(index) || []).length;
    this.workerStates.set(index, load > 0 ? 'busy' : 'online');
  }

  /**
   * 池统计（冻结契约）
   * @returns {{size:number, degraded:boolean, totalTasks:number, queued:number, workers:Array<{index:number,threadId:number,tasks:number,state:string}>}}
   */
  getStats() {
    const workers = [];
    let degraded = false;
    for (let index = 0; index < this.workers.length; index += 1) {
      const worker = this.workers[index];
      const state = this.workerStates.get(index) || (worker ? 'online' : 'dead');
      if (!worker) {
        degraded = true;
      }
      if (state === 'dead' || state === 'restarting') {
        degraded = true;
      }
      workers.push({
        index,
        threadId: worker && typeof worker.threadId === 'number' ? worker.threadId : 0,
        tasks: this.workerTasks.get(index) || 0,
        state: worker ? state : 'dead',
      });
    }
    return {
      size: this.size,
      degraded,
      totalTasks: this.totalTasks,
      // 加法式字段（T2/RD-21 口径）：不改变 C4 已依赖的既有字段名
      mainThreadTasks: this.mainThreadTasks,
      queued: this.taskQueue.length,
      workers,
    };
  }

  /**
   * 关闭池：拒绝排队任务、`await` 全部 `terminate()`、清空句柄
   * worker 句柄 MUST 不阻止事件循环自然退出（禁 `--exit` / `process.exit()` 兜底）
   * 注：本方法内**不使用** `process.exit()`；池内唯一 `process.exit()` 调用点在 `crash` handler（worker 上下文，
   * 仅终止该 worker 线程、主进程存活，且有 `isMainThread` 防护）。
   * @returns {Promise<void>}
   */
  async close() {
    this.closed = true;
    this.started = false;

    const queued = this.taskQueue.splice(0);
    for (const item of queued) {
      item.reject(new Error('worker pool closed before task was dispatched'));
    }

    const pending = [];
    for (const records of this.inflight.values()) {
      pending.push(...records);
    }
    for (const record of pending) {
      if (record.timer) {
        clearTimeout(record.timer);
      }
      record.reject(new Error('worker pool closed before task completed'));
    }
    this.inflight.clear();

    const handles = this.workers.filter(Boolean);
    this.workers = [];
    this.workerStates.clear();
    this.workerTasks.clear();
    this.restarts.clear();

    await Promise.all(handles.map((worker) => worker.terminate()));
    for (const worker of handles) {
      if (typeof worker.unref === 'function') {
        worker.unref();
      }
    }
  }
}

// worker 线程侧：与主线程共用 taskHandlers，按 type 分派并原样回传错误
if (!isMainThread && parentPort) {
  parentPort.on('message', async (data) => {
    const taskId = data && data.taskId;
    const type = data && data.type;
    if (typeof taskId !== 'number') {
      return;
    }
    if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(taskHandlers, type)) {
      parentPort.postMessage({
        taskId,
        ok: false,
        error: { name: 'TypeError', message: `Unknown worker task type "${String(type)}"` },
      });
      return;
    }

    try {
      const result = await taskHandlers[type](data.payload === undefined ? {} : data.payload, { workerThread: true });
      parentPort.postMessage({ taskId, ok: true, result });
    } catch (err) {
      parentPort.postMessage({
        taskId,
        ok: false,
        error: { name: (err && err.name) || 'Error', message: err && err.message ? err.message : String(err) },
      });
    }
  });
}

export { taskHandlers, DEFAULT_POOL_SIZE };
export default WorkerManager;
