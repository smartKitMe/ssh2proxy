# SSH2Proxy

高性能SSH隧道代理服务器，支持HTTP、HTTPS、SOCKS5代理协议。

## 语言

[English](README.md) | [简体中文](README-zh.md)

## 功能特性

- 基于SSH隧道的安全代理连接
- 支持HTTP/HTTPS代理协议（`httpsPort` 为独立的 HTTP CONNECT 监听端口，详见下文）
- 支持SOCKS5代理协议（按 ATYP 分流处理 IPv4 / 域名 / IPv6 目标）
- PAC文件服务，支持自动代理配置，并支持多份按名装载的 PAC（`pac.directory` / `pac.files`）
- HTTP、HTTPS(CONNECT) 与 SOCKS5 客户端连接由同一 Node.js 进程并发处理
- 支持上游SOCKS5代理（带认证）作为替代ssh隧道
- 网络连接池优化，降低网络开销引起的延迟
- 多线程支持：基于 `node:worker_threads` 的真实 worker 池（用于 PAC 渲染热路径），池容量由 `proxy.workerPoolSize` 决定（默认 `2`）
- 负载均衡连接池，允许多个连接共享SSH隧道，提高资源利用率
- SOCKS5连接池：连接复用、等待队列、健康检查、按目标预热、上游故障转移与动态容量调整

## 安装

```bash
npm install ssh2proxy
```

## 使用方法

### 作为命令行工具使用

```bash
# 显示帮助信息
npx ssh2proxy --help

# 显示版本信息
npx ssh2proxy --version

# 使用配置文件启动
npx ssh2proxy --config config.json

# 指定端口启动
npx ssh2proxy --http-port 8080 --https-port 8443 --socks-port 1080

# 使用私钥文件进行SSH认证
npx ssh2proxy --ssh-private-key-path ~/.ssh/id_rsa

# 指定PAC文件路径
npx ssh2proxy --pac-file-path ./proxy.pac.js
```

#### 命令行选项

下表为本修订版 `node src/cli/cli.mjs --help` 的完整选项集合。

| 选项 | 配置键 | 说明 |
|------|--------|------|
| `-V, --version` | - | 显示版本号并退出 |
| `-c, --config <path>` | - | 配置文件路径 |
| `-p, --port <port>` | `proxy.httpPort` | 代理端口（与 `--http-port` 同时给出时后者生效） |
| `-h, --host <host>` | `proxy.host` | 监听主机地址（注意：`-h` 是 **host**，不是 help） |
| `-H, --help` | - | 显示帮助信息 |
| `--http-port <port>` | `proxy.httpPort` | HTTP代理端口 |
| `--https-port <port>` | `proxy.httpsPort` | 独立的 HTTPS(CONNECT) 代理端口（语义见下） |
| `--socks-port <port>` | `proxy.socksPort` | SOCKS5代理端口 |
| `--pac-port <port>` | `proxy.pacPort` | PAC服务端口 |
| `--pac-file-path <path>` | `pac.filePath` | PAC文件路径 |
| `--enable-pac` | `pac.enabled` | 启用PAC文件服务（默认不开启） |
| `--enable-admin` | `admin.enabled` | 启用管理端点服务（默认不开启） |
| `--ssh-host <host>` | `ssh.host` | SSH服务器主机地址 |
| `--ssh-port <port>` | `ssh.port` | SSH服务器端口 |
| `--ssh-private-key-path <path>` | `ssh.privateKey` | 从文件读取私钥内容 |
| `--upstream-socks5-host <host>` | `upstreamSocks5.host` | 上游SOCKS5代理主机地址 |
| `--upstream-socks5-port <port>` | `upstreamSocks5.port` | 上游SOCKS5代理端口 |
| `--upstream-socks5-user <username>` | `upstreamSocks5.username` | 上游SOCKS5代理用户名 |
| `--upstream-socks5-pass <password>` | `upstreamSocks5.password` | 上游SOCKS5代理密码 |
| `--pool-max-size <number>` | `connectionPool.maxSize` | 连接池最大连接数 |
| `--pool-min-size <number>` | `connectionPool.minSize` | 连接池最小连接数 |
| `--pool-acquire-timeout <number>` | `connectionPool.acquireTimeout` | 获取连接超时时间（毫秒） |
| `--pool-idle-timeout <number>` | `connectionPool.idleTimeout` | 空闲连接超时时间（毫秒） |
| `-v, --verbose` | `config.verbose` / `logging.level` | 详细日志输出（debug 级别） |

`--https-port` 的语义（三点，与实现逐条对应）：

1. 它是 HTTPS(CONNECT) 代理的**独立监听端口**（`src/app.mjs` 的 `start()` → `startHttpsProxy()`）。
2. 它**不做 TLS 终止**：该端口与 HTTP 端口一样走明文 HTTP 的 CONNECT/普通请求处理，服务端没有任何证书处理逻辑。
3. 当该键缺失或为 `0`（默认值 `proxy.httpsPort: 0`）时，该端口**不监听**。

端口值超出 `0..65535` 时 CLI 会在启动前拒绝并以退出码 `1` 结束；其余配置问题的处理见[配置校验](#配置校验)。

### 作为模块使用

```javascript
import { ProxyServer } from 'ssh2proxy';

// 配置SSH隧道代理
const config = {
  // 隧道类型：'ssh'（默认）或 'socks5'
  tunnel: {
    type: 'ssh'
  },
  // SSH连接配置
  ssh: {
    host: 'your-ssh-server.com',
    port: 22,
    username: 'your-username',
    password: 'your-password' // 或使用privateKey
  },
  // 连接池配置
  connectionPool: {
    maxSize: 10,
    minSize: 3,
    acquireTimeout: 30000,
    idleTimeout: 60000,
    retryAttempts: 3,
    retryDelay: 5000,
    maxConnectionsPerTunnel: 10,
    loadBalancingStrategy: "least-connections"
  },
  // 代理服务配置
  proxy: {
    httpPort: 8080,
    socksPort: 1080,
    pacPort: 8013,      // 默认 8013；仅在 pac.enabled 为 true 时生效
    adminPort: 8081,    // 默认 8081；仅在 admin.enabled 为 true 时生效
    httpsPort: 0,       // 默认 0 = HTTPS(CONNECT) 端口不监听
    workerPoolSize: 2   // PAC 渲染的 Worker 池线程数（默认 2）
  },
  // PAC配置
  pac: {
    enabled: true,
    filePath: './proxy.pac.js', // PAC文件路径
    defaultProxy: 'SOCKS5 127.0.0.1:1080; SOCKS 127.0.0.1:1080; DIRECT'
  },
  // 认证配置（可选）
  auth: {
    enabled: false,
    username: '',
    password: ''
  },
  // 管理端点配置（可选）
  admin: {
    enabled: true
  }
};

// 创建并启动代理服务器
const server = new ProxyServer(config);

server.start()
  .then(() => {
    console.log('SSH2Proxy server started successfully');
  })
  .catch((err) => {
    console.error('Failed to start SSH2Proxy server:', err);
  });

// 优雅关闭
process.on('SIGINT', async () => {
  console.log('Shutting down SSH2Proxy server...');
  await server.stop();
  process.exit(0);
});
```

## 配置说明

配置文件支持JSON格式，详细配置项如下：

```json
{
  "tunnel": {
    "type": "ssh" // 或 "socks5"
  },
  "ssh": {
    "host": "localhost",
    "port": 22,
    "username": "user",
    "password": "",
    "privateKey": "",
    "passphrase": "",
    "keepaliveInterval": 30000,
    "retryAttempts": 3,
    "retryDelay": 5000
  },
  "upstreamSocks5": {
    "host": "",
    "port": 1080,
    "username": "",
    "password": ""
  },
  "connectionPool": {
    "maxSize": 10,
    "minSize": 3,
    "acquireTimeout": 30000,
    "idleTimeout": 60000,
    "retryAttempts": 3,
    "retryDelay": 5000,
    "maxConnectionsPerTunnel": 10,
    "loadBalancingStrategy": "least-connections"
  },
  "proxy": {
    "httpPort": 8080,
    "socksPort": 1080,
    "pacPort": 8013,
    "adminPort": 8081,
    "httpsPort": 0,
    "workerPoolSize": 2
  },
  "testingMode": false,
  "rateLimit": {
    "windowMs": 60000,
    "max": 100,
    "trustProxy": false
  },
  "pac": {
    "enabled": false,
    "filePath": "",
    "content": "",
    "directory": "",
    "files": {},
    "defaultProxy": "SOCKS5 127.0.0.1:1080; SOCKS 127.0.0.1:1080; DIRECT"
  },
  "auth": {
    "enabled": false,
    "username": "",
    "password": ""
  },
  "admin": {
    "enabled": false,
    "username": "",
    "password": ""
  },
  "socks5Pool": {
    "maxConnections": 10,
    "idleTimeout": 30000,
    "connectionTimeout": 10000,
    "healthCheckInterval": 60000
  }
}
```

### 容易被忽略的配置键

`src/config/default.config.mjs` 是默认值的唯一来源。下表列出实现会读取、但文档容易漏记的键：

| 键 | 默认值 | 消费点 |
|----|--------|--------|
| `proxy.adminPort` | `8081` | `ProxyServer.startAdminService()`；键缺失时管理端点**不监听**（打印一条告警） |
| `proxy.httpsPort` | `0` | `ProxyServer.start()` → `startHttpsProxy()`；`0`/缺键表示「不监听」，该端口不做 TLS 终止 |
| `proxy.workerPoolSize` | `2` | `new WorkerManager({ size: config.proxy.workerPoolSize })`，PAC 渲染所用的 worker 池线程数 |
| `testingMode` | `false` | 为 `true` 时跳过连接池初始化与 Worker 池（供单元测试与本地探针使用） |
| `rateLimit.windowMs` / `rateLimit.max` / `rateLimit.trustProxy` | `60000` / `100` / `false` | 限流中间件；计数键只含客户端 IP，`trustProxy` 为 false 时不采信 `x-forwarded-for` |
| `pac.directory` / `pac.files` | `''` / `{}` | `GET /pac/:name` 的多 PAC 装载（`files` 显式映射优先于 `directory`） |

### 配置校验

校验把配置问题分成两类，只有一类是致命的：

- **端口值**超出 `0..65535` 属致命错误，fail-fast：CLI 在服务启动前拒绝（退出码 `1`），`ProxyServer` 构造期抛错。当前 `validateConfig()` 只校验两个端口 —— `proxy.httpPort` 与 `proxy.socksPort`；`proxy.httpsPort`、`proxy.pacPort`、`proxy.adminPort` **不在该校验器覆盖范围内**。
- **SSH 凭证缺失**（无 password 且无私钥）**不致命**：实现只打印告警（`console.warn`）后继续，因为「只启动 PAC 服务」或「只启动管理端点」是受支持的用法。默认配置本身带 `ssh.host: 'localhost'` 与 `ssh.username: 'user'`，而 `ssh.password` 与 `ssh.privateKey` 为空 —— 这正是默认启动会触凭证告警的原因。

也就是说，「配置非法就退出」只对端口这一类成立，其余校验信息都是告警。

## 负载均衡连接池

SSH2Proxy现在支持负载均衡连接池，允许多个连接共享同一个SSH隧道，从而提高资源利用率和系统性能。

### 配置项说明

- `maxConnectionsPerTunnel`: 每个SSH隧道最大连接数，默认为10
- `loadBalancingStrategy`: 负载均衡策略 —— `least-connections`（默认）比较 `connectionCount`，平手按 `lastUsed`；`round-robin` 在合格隧道间按游标轮转；未识别的取值回落 `least-connections`

### 工作原理

1. 每个SSH隧道可以被多个连接共享，而不是每个连接都创建一个新的SSH隧道
2. 请求隧道分配时，池按 `loadBalancingStrategy` 分派：默认的 `least-connections` 在「未达 `maxConnectionsPerTunnel`」的隧道之间比较 `connectionCount` 并选取最小者（平手按 `lastUsed`）；`round-robin` 则在合格隧道间按游标轮转（`selectLeastLoadedTunnel()`，`src/core/load-balanced-connection-pool.mjs`）
3. 如果所有隧道都达到每隧道连接阈值且池未达 `maxSize`，则异步创建新隧道，当前请求等待该隧道就绪
4. 如果 `maxSize` 也已达到，请求进入等待队列（不静默超限）；超过 `acquireTimeout` 后以 `error.code === 'POOL_AT_CAPACITY'` 拒绝

### 状态与关闭语义

- `getStatus()` 返回 `{ available, used, total, maxSize, minSize, maxConnectionsPerTunnel, loadBalancingStrategy, waiting, closed, usedDetails, stats }`，其中 `usedDetails` 携带每条隧道的 `connectionCount`（`src/core/load-balanced-connection-pool.mjs` 的 `getStatus()`）。
- `close()` 之后池进入**粘性关闭态**（`closed === true`，不再复位）。**真正抛 `error.code === 'POOL_CLOSED'` 的只有三条路径**：被 `close()` 唤醒的排队者、`acquire()` 的新建分支（`await createTunnel()` 之后校验）、`initialize()` 入口（`throwIfClosed()`）。**自动扩容回调不抛**：`await createTunnel()` 之后若已关闭，它把新隧道对象丢弃并直接返回，隧道不会入池。关闭态下 `release()` 不再回填池，`close()` 幂等。
- **在途建连也已封堵**：`close()` 之后才建成的 socket 会被销毁、计入 `stats.lateDiscarded`，并以 `POOL_CLOSED` 拒绝，不再返回给调用方（`createNewConnection()` 主分支与故障转移分支同形处理，`src/core/socks-tunnel.mjs`）。
- 另需注意：绕过 `acquire()` / `initialize()` 直接调用内部方法（`createTunnel()` / `attach()` / `dispatchTunnel()` / `scheduleExpansion()`）属未定义行为，不受 `closed` 标志保护。

### 性能说明

- 相同客户端连接数下 SSH 隧道数量更少，进程与远端资源占用更低
- 分配是在内存计数器上做比较，单次请求开销小
- 池对每隧道与整池并发设上限，排队情况经 `getStatus().waiting` 可观测，而不是静默超限

## SOCKS5隧道支持

SSH2Proxy支持使用上游SOCKS5代理作为替代SSH隧道的传输方式。这对于某些网络环境或需要多层代理的场景非常有用。

### 配置SOCKS5隧道

要使用SOCKS5隧道而不是SSH隧道，需要在配置中设置隧道类型：

```json
{
  "tunnel": {
    "type": "socks5"
  },
  "upstreamSocks5": {
    "host": "socks5-proxy.example.com",
    "port": 1080,
    "username": "your-username",
    "password": "your-password"
  }
}
```

### SOCKS5隧道与SSH隧道的对比

| 特性 | SSH隧道 | SOCKS5隧道 |
|------|---------|------------|
| 安全性 | 高（加密传输） | 取决于上游代理 |
| 性能 | 中等 | 高（较少协议开销） |
| 配置复杂度 | 高（需要SSH服务器） | 低（只需SOCKS5代理） |
| 认证支持 | 多种方式 | 用户名/密码 |

### 使用场景

- 当无法直接访问SSH服务器时
- 当需要使用现有的SOCKS5代理基础设施时
- 在对性能要求较高的场景中
- 多层代理架构中

## SOCKS5连接池优化

SSH2Proxy 实现了 SOCKS5 连接池，通过连接复用降低 SOCKS5 隧道的建连开销。

### 连接池特性

- **连接复用**：相同目标主机的请求复用已建立的SOCKS5连接；同一目标存在多条空闲连接时按轮询游标选取
- **智能管理**：自动管理连接生命周期，包括健康检查和空闲超时回收（`reapIdleConnections`）
- **等待队列**：达到每目标上限时，请求进入等待队列，等待时间受 `waitTimeout` 约束
- **按目标预热**：`prewarm` / `prewarmCount` / `prewarmTargets` 可在隧道 `connect()` 时为目标预建连接
- **故障转移**：主上游重试耗尽后使用 `fallbackHost` / `fallbackPort` 备用上游
- **动态调整**：`Socks5Tunnel#adjustPoolSize()`（委托 `Socks5ConnectionPool#adjustPoolSize()`）按当前使用情况在 `minConnections` 与 `maxConnectionsLimit` 之间做 ±1 调整，并在每个清理 tick 自动生效
- **性能监控**：`getPoolStats()` 提供计数器与当前上限

### 配置选项

在配置文件中添加SOCKS5连接池配置：

```json
{
  "socks5Pool": {
    "maxConnections": 10,
    "idleTimeout": 30000,
    "connectionTimeout": 10000,
    "healthCheckInterval": 60000
  }
}
```

**这些键从哪里读。** 池配置按以下优先级（高 → 低）从三处解析：

1. `socks5Pool` —— 顶层兼容别名（即本文档使用的键）；
2. `upstreamSocks5.pool` —— 规范位置；
3. `pool` —— 历史读取点，保留兼容。

之所以别名优先：默认值合并后 `upstreamSocks5.pool` 永远存在，若规范键优先则别名将永久不可达。合并点是导出的 `resolveSocks5PoolConfig()`，它按上述顺序压入三个来源并自低向高合并；`Socks5Tunnel` 把解析结果存入 `this.poolConfig` 并交给 `new Socks5ConnectionPool(config, poolConfig)`（`src/core/socks-tunnel.mjs`）。

池段可用键（默认值取自 `src/config/default.config.mjs`）：`maxConnections` `10`、`idleTimeout` `30000`、`connectionTimeout` `10000`、`healthCheckInterval` `60000`、`waitTimeout` `10000`、`cleanupInterval` `10000`、`minConnections` `1`、`maxConnectionsLimit` `0`（`0` 表示 `maxConnections * 4`）、`prewarm` `false`、`prewarmCount` `1`、`prewarmTargets` `[]`、`retryBackoffFactor` `2`、`retryMaxDelay` `30000`、`fallbackHost` `''`、`fallbackPort` `0`。

### 性能说明

本文档**不给出**任何连接复用的百分比或倍数：此前该节的数字没有可复现的基准支撑，而本项目的文档纪律是「量化声称必须配可复跑的实测」。以下定性结论直接来自实现。

- 复用同一目标的空闲连接可以省掉一次 TCP + SOCKS5 握手，因此对已预热目标的重复请求不需要建连开销。
- 每目标并发由 `maxConnections` 限制；超过上限的请求进入队列等待，而不是无上限地新建连接。
- 握手占用的 CPU 随复用比例下降；池提供 `connectionHits` / `connectionMisses` 计数器，可在具体部署中实测该比例。

### 工作原理

1. **连接获取**：请求连接时，首先检查空闲连接池
2. **连接复用**：如果有可用空闲连接，立即复用
3. **新建连接**：如果没有可用连接且未达上限，创建新连接
4. **等待队列**：如果达到连接上限，请求进入等待队列
5. **自动释放**：连接使用完毕后自动释放回连接池
6. **健康检查**：定期检查空闲连接的有效性

### 监控指标

连接池提供以下监控指标：

- `totalConnections` - 总连接数
- `activeConnections` - 活跃连接数
- `idleConnections` - 空闲连接数
- `pendingRequests` - 等待请求数
- `connectionHits` - 连接复用次数
- `connectionMisses` - 新建连接次数
- `avgWaitTime` - 平均等待时间 = `totalWaitTime / waitedRequests`（未发生排队时为 `0`）

`Socks5Tunnel#getPoolStats()` 还会返回：`waits`、`waitedRequests`、`totalWaitTime`、`prewarmed`、`retries`、`retryDelays`、`failovers`、`failures`、`healthChecks`、`healthCheckRemovals`、`dynamicAdjustments`、`idleReaped`、`releases`、`lateDiscarded`（关闭后在途建连被销毁的计数）、`maxConnections`、`minConnections`、`maxConnectionsLimit`、`idleTimeout`、`connectionTimeout`、`healthCheckInterval`、`retryAttempts`、`retryDelay`、`closed`。**合计 30 个键**，即 `getPoolStats()` 的完整键集。

## PAC文件服务

SSH2Proxy支持PAC（Proxy Auto-Configuration）文件服务，可以自动配置浏览器或其他客户端的代理设置。

### 启用PAC服务

要启用PAC服务，需要在配置中设置：

```json
{
  "pac": {
    "enabled": true,
    "filePath": "./proxy.pac.js",
    "defaultProxy": "SOCKS5 127.0.0.1:1080; SOCKS 127.0.0.1:1080; DIRECT"
  },
  "proxy": {
    "pacPort": 8013
  }
}
```

或者使用命令行参数：
```bash
npx ssh2proxy --pac-file-path ./proxy.pac.js --pac-port 8013
```

`pacPort` 默认 `8013`（`src/config/default.config.mjs`），上面的取值就是该默认值。必须先 `--enable-pac`（或 `pac.enabled: true`）才会在 PAC 端口上监听；只写 `pacPort` 不生效。

### 多份PAC文件

除单个 `pac.filePath` 外，还支持按请求名装载多份 PAC：

- `pac.files`：显式映射 `{ "<请求名>": "<文件路径>" }`；
- `pac.directory`：从该目录按请求名装载（已做路径穿越防护）；
- `pac.filePath` 仍作为单文件兼容入口（请求名等于其 basename 时命中）；`pac.filePath` 指向目录时按 `pac.directory` 处理。

解析在 `PacService#resolvePacFile()`。**未命中任何来源时返回 404 `PAC file not found`**，绝不会用默认内容冒充命中（`handleRequest()`，`src/core/pac-service.mjs`）。

### PAC文件访问路径

启用PAC服务后，可以通过以下URL访问PAC文件：

- `http://[server-ip]:[pacPort]/proxy.pac` - 默认PAC文件路径
- `http://[server-ip]:[pacPort]/pac/[filename]` - 指定名称的PAC文件

例如，PAC端口为默认值8013时，可以通过以下URL访问：
- `http://localhost:8013/proxy.pac`
- `http://192.168.1.100:8013/proxy.pac`

端口与内容是**单一真源**：`PacService#generateDefaultProxyString()` 负责生成代理串（替换 `{socksPort}` / `{httpPort}` / `{host}` 占位符，并把 `pac.defaultProxy` 里历史遗留的 `127.0.0.1:<端口>` 归一化为真实的 `proxy.socksPort`）。主线程经 `generatePacContent()` 取用，worker 热路径经 `PacService#resolvePacRender()` 取用并作为 payload 下发（`renderPacViaWorker()`，`src/app.mjs`）；**worker 不再自行推断端口**——payload 既无 `content`/`raw` 又无配置派生的 `renderProxy` 时 `renderPac()` 直接抛错，不再静默回落 1080（`src/core/worker-manager.mjs`）。按名未装载时 `resolvePacRender()` 返回 `null`，请求回落到主线程处理器并同样得到 404。

### PAC文件示例

```javascript
function FindProxyForURL(url, host) {
    // 本地地址直连
    if (isPlainHostName(host) || 
        shExpMatch(host, "*.local") || 
        isInNet(dnsResolve(host), "10.0.0.0", "255.0.0.0") || 
        isInNet(dnsResolve(host), "172.16.0.0", "255.240.0.0") || 
        isInNet(dnsResolve(host), "192.168.0.0", "255.255.0.0") || 
        isInNet(dnsResolve(host), "127.0.0.0", "255.255.255.0")) {
        return "DIRECT";
    }
    
    // 默认使用SOCKS5代理
    return "SOCKS5 127.0.0.1:1080; SOCKS 127.0.0.1:1080; DIRECT";
}
```

## SSH私钥认证

SSH2Proxy支持使用私钥进行SSH认证，有两种方式：

1. 在配置文件中直接提供私钥内容：
   ```json
   {
     "ssh": {
       "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\n......\n-----END OPENSSH PRIVATE KEY-----"
     }
   }
   ```

2. 使用命令行参数指定私钥文件路径：
   ```bash
   npx ssh2proxy --ssh-private-key-path ~/.ssh/id_rsa
   ```

## 代理认证、限流与地址处理

### `auth.enabled` 的语义

`auth.enabled` 默认 `false`，含义是 SOCKS5 服务端与客户端**协商出「无认证」方法**，即匿名入站；这**不是**「认证成功」，该模式下不校验任何凭据。`auth.enabled: true` 时 SOCKS5 侧只接受 RFC1929 用户名/口令方法，HTTP/HTTPS(CONNECT) 侧在无凭据时回 `407`（方法协商与 `handleAuth` / `handleConnect` 分派在 `src/core/socks-proxy.mjs` 的 `Socks5Proxy#handleRequest()`；HTTP 面的 `407` —— CONNECT 分支与普通请求分支各一处 —— 由 `ProxyServer#createHttpProxyServer()` 下发）。

> 此处**故意不写行号**：行号会随代码移动而漂移，故本文档只引用文件与符号。

有效凭据的判据是**用户名与口令均非空**。若 `auth.enabled: true` 而其中任意一项为空，实现按 fail-closed 处理：拒绝一切认证尝试（回 `01 01` 并断开），并在构造期打印告警。SOCKS5 侧与 HTTP Basic 侧的凭据比较均为恒定时间。

### 限流

`rateLimit.windowMs`（默认 `60000`）、`rateLimit.max`（默认 `100`）、`rateLimit.trustProxy`（默认 `false`）配置固定窗口限流。计数键**只含客户端 IP**：换 URL 或换 HTTP 方法不会重置窗口。`x-forwarded-for` 是客户端可控头，只有在显式设置 `trustProxy: true` 时才采信。`windowMs <= 0` 表示不限流，`max <= 0` 表示全部拒绝。

### 地址处理（SOCKS5）

SOCKS5 请求按客户端声明的 `ATYP` 字节分流：`0x01` IPv4、`0x03` 域名、`0x04` IPv6（`src/core/socks-proxy.mjs:74-101`、`:312-345`）。SOCKS5 层不改写请求地址，也不做 IPv6 到 IPv4 的映射；字面量按标准压缩形式序列化。端到端 IPv6 连通性仍取决于 `forwardOut()` 之后的隧道实现。未知 `ATYP` 以应答码 `0x08`（地址类型不支持）拒绝。

## 开发

### 安装依赖

```bash
npm install
```

### 构建项目

```bash
npm run build
```

### 运行测试

```bash
npm test
```

测试为 Mocha + Chai，位于 `src/tests/`。集成测试在建连接缝（`connectionPool.createTunnel`）注入 stub 隧道，被测链路真实执行——请求行与 `Host` 构造、到本地上游的真实 TCP 往返、真实池 `acquire`/`release` 记账，以及上游不可达的失败路径。**真实 SSH 握手不在覆盖范围内**；仓库中的 `mock-ssh-server.mjs` 无法完成 ssh2 握手，因此没有任何测试使用它。

## 许可证

MIT