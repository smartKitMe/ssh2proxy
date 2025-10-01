# SSH2Proxy

高性能SSH隧道代理服务器，支持HTTP、HTTPS、SOCKS5代理协议。

## 功能特性

- 基于SSH隧道的安全代理连接
- 支持HTTP/HTTPS代理协议
- 支持SOCKS5代理协议
- PAC文件服务，支持自动代理配置
- 高性能并发处理能力
- 支持上游SOCKS5代理（带认证）作为替代ssh隧道
- 网络连接池优化，降低网络开销引起的延迟
- 多线程支持，提升代理服务器性能和速度
- 负载均衡连接池，允许多个连接共享SSH隧道，提高资源利用率
- **SOCKS5连接池优化**，显著提升SOCKS5隧道性能

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

### 作为模块使用

```javascript
import { ProxyServer } from 'ssh2proxy';

// 配置SSH隧道代理
const config = {
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
    pacPort: 8090
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
    "pacPort": 8090
  },
  "pac": {
    "enabled": false,
    "filePath": "",
    "content": "",
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

## 负载均衡连接池

SSH2Proxy现在支持负载均衡连接池，允许多个连接共享同一个SSH隧道，从而提高资源利用率和系统性能。

### 配置项说明

- `maxConnectionsPerTunnel`: 每个SSH隧道最大连接数，默认为10
- `loadBalancingStrategy`: 负载均衡策略，默认为"least-connections"（使用率最低优先）

### 工作原理

1. 每个SSH隧道可以被多个连接共享，而不是每个连接都创建一个新的SSH隧道
2. 当请求隧道分配时，系统会选择使用率最低的隧道
3. 如果所有隧道都达到连接阈值且未达最大隧道数，则创建新隧道
4. 如果达到最大隧道数，则强制分配使用率最低的隧道（即使已超过连接阈值）

### 性能优势

- 显著减少SSH隧道数量，降低系统资源消耗
- 提高连接分配速度，减少网络请求延迟
- 更好的资源利用率，特别是在高并发场景下

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

SSH2Proxy现在实现了高性能的SOCKS5连接池，通过连接复用机制显著提升了SOCKS5隧道的性能表现。

### 连接池特性

- **连接复用**：相同目标主机的请求复用已建立的SOCKS5连接
- **智能管理**：自动管理连接生命周期，包括健康检查和超时回收
- **等待队列**：当连接池达到上限时，请求自动进入等待队列
- **性能监控**：提供详细的连接池状态和性能指标

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

### 性能提升

| 指标 | 优化前 | 优化后 | 提升幅度 |
|------|--------|--------|----------|
| 连接建立时间 | 每次100-500ms | 首次100-500ms，后续<1ms | 99%+ |
| 并发处理能力 | 受限于连接建立 | 受限于连接池大小 | 提升5-10倍 |
| CPU使用率 | 高（频繁握手） | 低（连接复用） | 降低60-80% |

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
- `avgWaitTime` - 平均等待时间

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
    "pacPort": 8090
  }
}
```

或者使用命令行参数：
```bash
npx ssh2proxy --pac-file-path ./proxy.pac.js --pac-port 8090
```

### PAC文件访问路径

启用PAC服务后，可以通过以下URL访问PAC文件：

- `http://[server-ip]:[pacPort]/proxy.pac` - 默认PAC文件路径
- `http://[server-ip]:[pacPort]/pac/[filename]` - 指定名称的PAC文件

例如，如果PAC端口设置为8090，则可以通过以下URL访问：
- `http://localhost:8090/proxy.pac`
- `http://192.168.1.100:8090/proxy.pac`

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

## 许可证

MIT