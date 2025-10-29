# SSH2Proxy

## Language

[English](README.md) | [简体中文](README-zh.md)

High-performance SSH tunnel proxy server with HTTP, HTTPS, and SOCKS5 support.

## Features

- Secure proxy connections over SSH tunnels
- HTTP/HTTPS proxy protocol support
- SOCKS5 proxy protocol support
- PAC file service for automatic proxy configuration
- High-performance concurrent processing
- Upstream SOCKS5 proxy (with authentication) as an alternative to SSH tunnel
- Connection pool optimizations to reduce latency caused by network overhead
- Multi-threading to improve server performance and throughput
- Load-balanced connection pool allowing multiple connections to share SSH tunnels
- SOCKS5 connection pool optimization for significantly improved SOCKS5 tunnel performance

## Installation

```bash
npm install ssh2proxy
```

## Usage

### CLI

```bash
# Show help
npx ssh2proxy --help

# Show version
npx ssh2proxy --version

# Start with a config file
npx ssh2proxy --config config.json

# Specify ports
npx ssh2proxy --http-port 8080 --https-port 8443 --socks-port 1080

# Use SSH private key for authentication
npx ssh2proxy --ssh-private-key-path ~/.ssh/id_rsa

# Specify PAC file path
npx ssh2proxy --pac-file-path ./proxy.pac.js
```

### As a Module

```javascript
import { ProxyServer } from 'ssh2proxy';

// Configure SSH tunnel proxy
const config = {
  // SSH connection configuration
  ssh: {
    host: 'your-ssh-server.com',
    port: 22,
    username: 'your-username',
    password: 'your-password' // or use privateKey
  },
  // Connection pool configuration
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
  // Proxy service configuration
  proxy: {
    httpPort: 8080,
    socksPort: 1080,
    pacPort: 8090
  },
  // PAC configuration
  pac: {
    enabled: true,
    filePath: './proxy.pac.js', // PAC file path
    defaultProxy: 'SOCKS5 127.0.0.1:1080; SOCKS 127.0.0.1:1080; DIRECT'
  },
  // Authentication configuration (optional)
  auth: {
    enabled: false,
    username: '',
    password: ''
  },
  // Admin endpoint configuration (optional)
  admin: {
    enabled: true
  }
};

// Create and start the proxy server
const server = new ProxyServer(config);

server.start()
  .then(() => {
    console.log('SSH2Proxy server started successfully');
  })
  .catch((err) => {
    console.error('Failed to start SSH2Proxy server:', err);
  });

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down SSH2Proxy server...');
  await server.stop();
  process.exit(0);
});
```

## Configuration

Configuration files use JSON. Detailed options:

```json
{
  "tunnel": {
    "type": "ssh" // or "socks5"
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

## Load-Balanced Connection Pool

SSH2Proxy supports a load-balanced connection pool that allows multiple connections to share a single SSH tunnel, improving resource utilization and system performance.

### Configuration Options

- `maxConnectionsPerTunnel`: Maximum connections per SSH tunnel (default: 10)
- `loadBalancingStrategy`: Load balancing strategy (default: `least-connections`)

### How It Works

1. Each SSH tunnel can be shared by multiple connections, rather than creating a new tunnel per connection
2. When allocating tunnels, the system selects the one with the lowest utilization
3. If all tunnels reach the connection threshold and max tunnel count isn’t reached, a new tunnel is created
4. If the max tunnel count is reached, the least-utilized tunnel is assigned even if it exceeds the threshold

### Performance Benefits

- Significantly fewer SSH tunnels, reducing system resource usage
- Faster connection allocation, reducing request latency
- Better resource utilization, especially under high concurrency

## SOCKS5 Tunnel Support

SSH2Proxy supports using an upstream SOCKS5 proxy as the transport instead of an SSH tunnel, which is useful in specific network environments or multi-layer proxy setups.

### Configure SOCKS5 Tunnel

To use a SOCKS5 tunnel, set the tunnel type in your configuration:

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

### SOCKS5 vs SSH Tunnel

| Feature | SSH Tunnel | SOCKS5 Tunnel |
|--------|------------|---------------|
| Security | High (encrypted transport) | Depends on upstream proxy |
| Performance | Medium | High (less protocol overhead) |
| Configuration Complexity | High (requires SSH server) | Low (requires SOCKS5 proxy) |
| Authentication Support | Multiple methods | Username/Password |

### Use Cases

- When direct access to an SSH server isn’t possible
- When leveraging existing SOCKS5 proxy infrastructure
- High-performance scenarios
- Multi-layer proxy architectures

## SOCKS5 Connection Pool Optimization

SSH2Proxy implements a high-performance SOCKS5 connection pool that significantly improves SOCKS5 tunnel performance through connection reuse.

### Pool Features

- Connection reuse: Requests to the same target host reuse existing SOCKS5 connections
- Smart lifecycle management: Health checks and idle connection reclamation
- Wait queue: Requests enter a queue when the pool reaches its limit
- Performance monitoring: Detailed pool status and metrics

### Configuration

Add the SOCKS5 pool configuration to your settings:

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

### Performance Improvements

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Connection setup time | 100–500ms each | 100–500ms first, <1ms subsequent | 99%+ |
| Concurrency | Limited by setup | Limited by pool size | 5–10x |
| CPU usage | High (frequent handshakes) | Low (connection reuse) | 60–80% lower |

### How It Works

1. Acquire: Check idle pool first when requesting a connection
2. Reuse: Immediately reuse an available idle connection
3. Create: If none available and under the limit, create a new connection
4. Queue: If at the limit, requests enter a wait queue
5. Release: After use, connections are released back to the pool
6. Health check: Periodically validate idle connections

### Metrics

The pool exposes the following metrics:

- `totalConnections` – total connections
- `activeConnections` – active connections
- `idleConnections` – idle connections
- `pendingRequests` – queued requests
- `connectionHits` – reuse count
- `connectionMisses` – new connection count
- `avgWaitTime` – average wait time

## PAC File Service

SSH2Proxy provides a PAC (Proxy Auto-Configuration) file service to automatically configure browsers or other clients.

### Enable PAC Service

Set the following configuration:

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

Or via CLI:
```bash
npx ssh2proxy --pac-file-path ./proxy.pac.js --pac-port 8090
```

### PAC Access Paths

- `http://[server-ip]:[pacPort]/proxy.pac` – default PAC file
- `http://[server-ip]:[pacPort]/pac/[filename]` – specified PAC file name

For example, with PAC port `8090`:
- `http://localhost:8090/proxy.pac`
- `http://192.168.1.100:8090/proxy.pac`

### PAC Example

```javascript
function FindProxyForURL(url, host) {
    // Direct for local addresses
    if (isPlainHostName(host) || 
        shExpMatch(host, "*.local") || 
        isInNet(dnsResolve(host), "10.0.0.0", "255.0.0.0") || 
        isInNet(dnsResolve(host), "172.16.0.0", "255.240.0.0") || 
        isInNet(dnsResolve(host), "192.168.0.0", "255.255.0.0") || 
        isInNet(dnsResolve(host), "127.0.0.0", "255.255.255.0")) {
        return "DIRECT";
    }
    
    // Default to SOCKS5
    return "SOCKS5 127.0.0.1:1080; SOCKS 127.0.0.1:1080; DIRECT";
}
```

## SSH Private Key Authentication

SSH2Proxy supports SSH authentication with private keys in two ways:

1. Provide the private key content directly in the config:
   ```json
   {
     "ssh": {
       "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\n......\n-----END OPENSSH PRIVATE KEY-----"
     }
   }
   ```

2. Use a CLI parameter to specify the private key path:
   ```bash
   npx ssh2proxy --ssh-private-key-path ~/.ssh/id_rsa
   ```

## Development

### Install Dependencies

```bash
npm install
```

### Build

```bash
npm run build
```

### Test

```bash
npm test
```

## License

MIT