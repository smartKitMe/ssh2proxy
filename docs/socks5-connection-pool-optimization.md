# SOCKS5连接池优化方案

> **文档性质（MUST 先读）**：本文是 SOCKS5 连接池的**设计期方案存档**。它描述的「每个请求新建连接」的旧现状已在当前实现中修复——现在 `forwardOut()` 走连接池。**能力的唯一权威是代码**：本文与实现不一致处均以实现为准，逐项落地对照见文末「实现落地对照」。

## 概述

本文档记录 SOCKS5 连接池优化方案的设计思路，该方案针对的是设计期内 `src/core/socks-tunnel.mjs` 中「每个请求都需要建立新连接」的性能问题。当前实现已按本方案落地连接池（`Socks5Tunnel` + `Socks5ConnectionPool`），因此下文「当前问题分析」「设计方案」两节均为**历史设计材料**，不代表现在的行为。

## 历史问题分析（设计期）

### 当时实现的写法

在设计期的 `src/core/socks-tunnel.mjs` 中，每个 `forwardOut` 调用都会创建一个新的SOCKS5连接：

```javascript
// 设计期实现 - 每次请求都创建新连接
SocksClient.createConnection(options)
  .then((info) => {
    resolve(info.socket);
  })
```

**当时的问题**：
- 每个请求都需要完整的TCP握手和SOCKS5认证流程
- 无法复用已建立的连接
- 连接建立开销影响性能
- 频繁连接建立可能导致网络波动

**当前行为**：上述问题已由连接池解决——`forwardOut()` 先取空闲连接、未命中再建连，并对每个目标限制并发上限、排队、回收与健康检查（实现入口 `src/core/socks-tunnel.mjs` 的 `getConnection()` / `createWithReservation()` / `reapIdleConnections()`）。

## 设计方案（历史草案）

### 1. 核心架构

#### 连接池组件关系

```
Socks5Tunnel (现有类)
    ↓
Socks5ConnectionPool (新增类)
    ├── activeConnections  (活跃连接映射)
    ├── idleConnections    (空闲连接池)
    └── pendingRequests    (等待队列)
```

### 2. 连接池实现（设计草图，非当前代码）

> 下面这段 `Socks5ConnectionPool` 是设计期的**草图**，用于说明数据结构和流程；它与当前实现不完全相同（例如真实实现多了建连预留计数 `creatingConnections`、轮询游标 `idleCursor`、等待队列超时 `waitTimeout`、动态调整与健康检查统计等）。**以 `src/core/socks-tunnel.mjs` 为准。**

#### Socks5ConnectionPool 类

```javascript
class Socks5ConnectionPool {
  constructor(config, maxConnections = 10, idleTimeout = 30000) {
    this.config = config;
    this.maxConnections = maxConnections;
    this.idleTimeout = idleTimeout;

    // 连接池状态
    this.activeConnections = new Map(); // host:port -> Set<socket>
    this.idleConnections = new Map();   // host:port -> Array<{socket, lastUsed}>
    this.pendingRequests = new Map();   // host:port -> Array<{resolve, reject}>

    // 启动空闲连接清理
    this.startIdleCleanup();
  }

  /**
   * 获取连接（复用或创建）
   * @param {string} dstIP - 目标IP
   * @param {number} dstPort - 目标端口
   * @returns {Promise<Socket>} - SOCKS5连接socket
   */
  async getConnection(dstIP, dstPort) {
    const key = `${dstIP}:${dstPort}`;

    // 1. 检查空闲连接
    if (this.idleConnections.has(key)) {
      const idlePool = this.idleConnections.get(key);
      if (idlePool.length > 0) {
        const { socket } = idlePool.pop();
        this.addToActive(key, socket);
        return socket;
      }
    }

    // 2. 检查是否达到最大连接数
    const activeCount = this.activeConnections.get(key)?.size || 0;
    if (activeCount >= this.maxConnections) {
      // 等待其他连接释放
      return this.waitForConnection(key);
    }

    // 3. 创建新连接
    return this.createNewConnection(dstIP, dstPort);
  }

  /**
   * 释放连接回连接池
   * @param {Socket} socket - 要释放的socket
   * @param {string} dstIP - 目标IP
   * @param {number} dstPort - 目标端口
   */
  releaseConnection(socket, dstIP, dstPort) {
    const key = `${dstIP}:${dstPort}`;

    // 从活跃连接中移除
    this.removeFromActive(key, socket);

    // 如果socket仍然可用，放入空闲池
    if (!socket.destroyed && socket.writable) {
      this.addToIdle(key, socket);

      // 检查是否有等待的请求
      this.checkPendingRequests(key);
    } else {
      // 连接已损坏，直接销毁
      socket.destroy();
    }
  }

  /**
   * 创建新的SOCKS5连接
   */
  async createNewConnection(dstIP, dstPort) {
    const key = `${dstIP}:${dstPort}`;
    const options = {
      proxy: {
        host: this.config.host,
        port: this.config.port,
        type: 5
      },
      command: 'connect',
      destination: {
        host: dstIP,
        port: dstPort
      }
    };

    // 添加认证信息
    if (this.config.username && this.config.password) {
      options.proxy.userId = this.config.username;
      options.proxy.password = this.config.password;
    }

    try {
      const info = await SocksClient.createConnection(options);
      this.addToActive(key, info.socket);
      return info.socket;
    } catch (error) {
      throw new Error(`SOCKS5 connection failed: ${error.message}`);
    }
  }

  /**
   * 等待连接释放
   */
  waitForConnection(key) {
    return new Promise((resolve, reject) => {
      if (!this.pendingRequests.has(key)) {
        this.pendingRequests.set(key, []);
      }
      this.pendingRequests.get(key).push({ resolve, reject });
    });
  }

  /**
   * 检查并处理等待的请求
   */
  checkPendingRequests(key) {
    if (this.pendingRequests.has(key) && this.pendingRequests.get(key).length > 0) {
      const request = this.pendingRequests.get(key).shift();

      // 尝试获取连接
      this.getConnection(...key.split(':')).then(
        socket => request.resolve(socket),
        error => request.reject(error)
      );
    }
  }

  /**
   * 启动空闲连接清理
   */
  startIdleCleanup() {
    setInterval(() => {
      const now = Date.now();
      for (const [key, connections] of this.idleConnections) {
        const activeConnections = [];
        const expiredConnections = [];

        connections.forEach(conn => {
          if (now - conn.lastUsed < this.idleTimeout) {
            activeConnections.push(conn);
          } else {
            expiredConnections.push(conn);
          }
        });

        this.idleConnections.set(key, activeConnections);

        // 关闭超时的连接
        expiredConnections.forEach(conn => {
          conn.socket.destroy();
        });
      }
    }, 10000); // 每10秒检查一次
  }

  // 辅助方法
  addToActive(key, socket) {
    if (!this.activeConnections.has(key)) {
      this.activeConnections.set(key, new Set());
    }
    this.activeConnections.get(key).add(socket);
  }

  removeFromActive(key, socket) {
    if (this.activeConnections.has(key)) {
      this.activeConnections.get(key).delete(socket);
      if (this.activeConnections.get(key).size === 0) {
        this.activeConnections.delete(key);
      }
    }
  }

  addToIdle(key, socket) {
    if (!this.idleConnections.has(key)) {
      this.idleConnections.set(key, []);
    }
    this.idleConnections.get(key).push({
      socket,
      lastUsed: Date.now()
    });
  }
}
```

### 3. 修改Socks5Tunnel类（同样为设计草图）

```javascript
class Socks5Tunnel extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.connectionPool = new Socks5ConnectionPool(config);
    this.isConnected = true;
  }

  async forwardOut(srcIP, srcPort, dstIP, dstPort) {
    try {
      // 从连接池获取连接
      const socket = await this.connectionPool.getConnection(dstIP, dstPort);
      // 监听连接关闭事件，自动释放
      // ...
      return socket;
    } catch (error) {
      console.error('SOCKS5 forwardOut error:', error);
      throw error;
    }
  }
}
```

> 真实实现的两处语义差异（设计草图未体现）：构造后 `isConnected === false`（连接前不自称已连接），`connect()` 返回预热连接数；`forwardOut()` 失败路径除 Promise 拒绝外还会 `emit('error')`（构造期已装默认监听器）。

## 配置选项

### 连接池配置（默认值取自 `src/config/default.config.mjs`）

```javascript
const poolConfig = {
  maxConnections: 10,        // 每个目标最大连接数
  idleTimeout: 30000,        // 空闲超时(毫秒)
  connectionTimeout: 10000,  // 连接超时
  healthCheckInterval: 60000, // 健康检查间隔
  waitTimeout: 10000,        // 池满后排队等待上限
  cleanupInterval: 10000,    // 空闲回收扫描间隔
  minConnections: 1,         // 动态调整下限
  maxConnectionsLimit: 0,    // 动态调整上限（0 表示 maxConnections * 4）
  prewarm: false,
  prewarmCount: 1,
  prewarmTargets: [],
  retryBackoffFactor: 2,
  retryMaxDelay: 30000,
  fallbackHost: '',
  fallbackPort: 0
};
```

### 使用示例

```javascript
// 创建带连接池的SOCKS5隧道
const tunnel = new Socks5Tunnel({
  host: 'proxy.example.com',
  port: 1080,
  username: 'user',
  password: 'pass',
  pool: poolConfig  // 连接池配置（也可放在 upstreamSocks5.pool 或顶层 socks5Pool）
});

await tunnel.connect();
const socket = await tunnel.forwardOut('127.0.0.1', 8080, 'target.com', 80);
```

## 性能优化特性

### 1. 连接复用策略

- **相同目标复用**：相同主机和端口的请求复用连接（键为 `host:port`）
- **轮询选取**：同一目标有多条空闲连接时按游标轮询使用（`idleCursor`）
- **未实现项**：不支持通配符/模式匹配目标（设计草案中的「智能匹配」未落地，不作为声称）

### 2. 连接生命周期管理

- **健康检查**：定期验证空闲连接的有效性
- **自动回收**：超时空闲连接自动销毁
- **优雅关闭**：连接池关闭时清理所有资源

### 3. 高级特性

- **连接预热**：`prewarm` 为 true 时在隧道 `connect()` 阶段按 `prewarmTargets` 预建连接（未配置目标则不建）
- **动态调整**：`adjustPoolSize()` 按当前使用情况在 `minConnections` 与 `maxConnectionsLimit` 之间做 ±1 调整，并在每个清理 tick 自动生效
- **故障转移**：主上游重试耗尽后使用 `fallbackHost` / `fallbackPort`

## 预期效果

### 性能说明（不发布无据数字）

本节曾给出一张「优化前后 + 提升幅度」的数字表，但这些数字没有任何可复现的基准支撑，已按文档纪律删除。需要量化时，请用池自带的计数器在目标环境实测：

```javascript
const stats = tunnel.getPoolStats();
console.log(stats.connectionHits, stats.connectionMisses, stats.avgWaitTime);
```

文档不发布无法复跑的百分比或倍数。

### 资源优化

- **内存使用**：减少重复的连接对象创建
- **网络开销**：减少TCP握手和SOCKS5认证
- **稳定性**：避免频繁连接建立导致的网络波动

## 向后兼容性

### 保持兼容的特性

- 配置格式向后兼容（原 4 个池键默认值未变，`pool` 历史读取点仍被识别）
- 错误处理机制以事件 + Promise 拒绝双通道对外
- 日志输出格式统一

### 语义变更（调用方需知）

- `Socks5Tunnel` 构造后 `isConnected === false`；`connect()` 返回预热连接数（原为 `undefined`）
- `Socks5Tunnel.close()` / `SSHTunnel.close()` 会 `emit('close')`，连接池据此把隧道移出池（幂等）
- `forwardOut()` 失败路径除拒绝 Promise 外还会 `emit('error')`
- `createNewConnection` 的重试优先级：`pool 显式键 > 扁平键（来自 connectionPool）> 内置默认`

### 新增特性

- 连接池配置选项（含预热、等待超时、动态上下限、故障转移）
- 性能监控指标（`getPoolStats()`）
- 连接池状态查询（`getStatus()` 与 `adjustPoolSize()`）

## 实施计划（历史存档，已完成）

### 第一阶段：核心实现 —— 已完成
1. 实现 `Socks5ConnectionPool` 类（`src/core/socks-tunnel.mjs`）
2. 修改 `Socks5Tunnel` 类集成连接池（`forwardOut()` → `getConnection()`）
3. 添加基础测试用例（`src/tests/socks-tunnel.test.mjs`）

### 第二阶段：高级特性 —— 已完成
1. 实现连接健康检查（`startHealthCheck()` / `runHealthCheck()`）
2. 添加性能监控（`getStats()`）
3. 实现动态配置调整（`adjustPoolSize()`）

### 第三阶段：优化完善
1. 性能测试和调优：**未执行**，仓库内无基准脚本，文档因此不发布性能数字
2. 文档完善：本文与 README 的 SOCKS5 连接池章节
3. 生产环境部署：不在本仓库范围内

## 监控和调试

### 监控指标（`getPoolStats()` 的字段子集）

```javascript
// 连接池状态监控
const poolStats = {
  totalConnections: 0,    // 建连总数（计数器）
  activeConnections: 0,   // 当前活跃连接数（调用时计算）
  idleConnections: 0,     // 当前空闲连接数（调用时计算）
  pendingRequests: 0,     // 当前排队请求数（调用时计算）
  connectionHits: 0,      // 连接复用次数
  connectionMisses: 0,    // 新建连接次数
  avgWaitTime: 0          // 平均等待时间 = totalWaitTime / waitedRequests（未发生排队时为 0）
};
```

完整键集另含 `waits`、`waitedRequests`、`totalWaitTime`、`prewarmed`、`retries`、`retryDelays`、`failovers`、`failures`、`healthChecks`、`healthCheckRemovals`、`dynamicAdjustments`、`idleReaped`、`releases`、`lateDiscarded`、`maxConnections`、`minConnections`、`maxConnectionsLimit`、`idleTimeout`、`connectionTimeout`、`healthCheckInterval`、`retryAttempts`、`retryDelay`、`closed`。**合计 30 个键**，即 `getPoolStats()` 的完整键集。

### 调试工具

- 连接池状态查询：`tunnel.getPoolStats()`（对等 `connectionPool.getStats()`）与 `tunnel.adjustPoolSize()`
- 日志：池的关键路径（建连/重试/动态调整/关闭等）直接输出到控制台 —— `src/core/socks-tunnel.mjs` 当前**未引用** `verbose` 或 logger 抽象（实测：`verbose` 0 处、`logger` 0 处、无条件 `console.*` 26 处），因此 `-v/--verbose` **不会**改变该文件的日志详细程度
- **未实现项**：不存在「性能分析报告」生成器（设计草案中的该项未落地，不作为声称）

## 总结

SOCKS5 连接池通过连接复用降低了建连开销与资源占用，保持了配置格式的向后兼容，并提供可观测的计数器与当前上限。本文为设计期存档，实现细节与当前行为均以 `src/core/socks-tunnel.mjs` 为准。

## 实现落地对照

| 设计要素 | 实现位置 | 状态 |
|---|---|---|
| `Socks5ConnectionPool` 类 | `src/core/socks-tunnel.mjs`（含 `creatingConnections` 预留、`idleCursor` 轮询） | 已落地 |
| 复用优先 / 未命中建连 | `getConnection()` / `createWithReservation()` / `createNewConnection()` | 已落地 |
| 等待队列与超时 | `waitForConnection()`（`waitTimeout` 默认 10000） | 已落地 |
| 空闲回收 | `reapIdleConnections()`（`cleanupInterval` 默认 10000） | 已落地 |
| 健康检查 | `startHealthCheck()` / `runHealthCheck()`（属性判定 + 周期剔除） | 已落地（无主动 SOCKS5 探针握手） |
| 预热 | `prewarmPool()`（按 `prewarmTargets`） | 已落地 |
| 动态调整 | `adjustPoolSize()`（±1，上下限可配） | 已落地 |
| 故障转移 | `createNewConnection()` 的 `fallbackHost`/`fallbackPort` 分支 | 已落地 |
| 重试与退避 | `retryAttempts`/`retryDelay`/`retryBackoffFactor`/`retryMaxDelay` | 已落地 |
| 通配符/模式匹配目标 | - | **未落地**（已从声称中移除） |
| 性能数字（百分比/倍数） | - | **已删除**（无实测支撑） |
| 性能分析报告生成器 | - | **未落地**（已从声称中移除） |