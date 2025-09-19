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
    minSize: 2,
    acquireTimeout: 30000,
    idleTimeout: 60000,
    retryAttempts: 3,
    retryDelay: 5000
  },
  // 代理服务配置
  proxy: {
    httpPort: 8080,
    httpsPort: 8443,
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
    "minSize": 2,
    "acquireTimeout": 30000,
    "idleTimeout": 60000,
    "retryAttempts": 3,
    "retryDelay": 5000
  },
  "proxy": {
    "httpPort": 8080,
    "httpsPort": 8443,
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
  }
}
```

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