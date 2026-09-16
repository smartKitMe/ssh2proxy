# SSH2Proxy

## Language

[English](README.md) | [简体中文](README-zh.md)

High-performance SSH tunnel proxy server with HTTP, HTTPS, and SOCKS5 support.

## Features

- Secure proxy connections over SSH tunnels
- HTTP/HTTPS proxy protocol support (`httpsPort` is a separate HTTP CONNECT listener, see below)
- SOCKS5 proxy protocol support (ATYP-based IPv4 / domain / IPv6 target handling)
- PAC file service for automatic proxy configuration, including multiple named PAC files (`pac.directory` / `pac.files`)
- HTTP, HTTPS(CONNECT) and SOCKS5 client connections served concurrently by one Node.js process
- Upstream SOCKS5 proxy (with authentication) as an alternative to SSH tunnel
- Connection pool optimizations to reduce latency caused by network overhead
- Multi-threading through a real `node:worker_threads` pool (used for the PAC render hot path); the pool capacity comes from `proxy.workerPoolSize` (default `2`)
- Load-balanced connection pool allowing multiple connections to share SSH tunnels
- SOCKS5 connection pool with connection reuse, wait queue, health checks, per-target prewarm, upstream failover and dynamic size adjustment

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

#### CLI options

The list below is the complete option set of `node src/cli/cli.mjs --help` on this revision.

| Option | Config key | Meaning |
|--------|-----------|---------|
| `-V, --version` | - | Print version and exit |
| `-c, --config <path>` | - | Config file path |
| `-p, --port <port>` | `proxy.httpPort` | Proxy port (`--http-port` wins if both are given) |
| `-h, --host <host>` | `proxy.host` | Listen host (note: `-h` is **host**, not help) |
| `-H, --help` | - | Show help |
| `--http-port <port>` | `proxy.httpPort` | HTTP proxy port |
| `--https-port <port>` | `proxy.httpsPort` | Separate HTTPS(CONNECT) proxy port (see semantics below) |
| `--socks-port <port>` | `proxy.socksPort` | SOCKS5 proxy port |
| `--pac-port <port>` | `proxy.pacPort` | PAC service port |
| `--pac-file-path <path>` | `pac.filePath` | PAC file path |
| `--enable-pac` | `pac.enabled` | Enable the PAC service (off by default) |
| `--enable-admin` | `admin.enabled` | Enable the admin endpoints (off by default) |
| `--ssh-host <host>` | `ssh.host` | SSH server host |
| `--ssh-port <port>` | `ssh.port` | SSH server port |
| `--ssh-private-key-path <path>` | `ssh.privateKey` | Read the private key from a file |
| `--upstream-socks5-host <host>` | `upstreamSocks5.host` | Upstream SOCKS5 host |
| `--upstream-socks5-port <port>` | `upstreamSocks5.port` | Upstream SOCKS5 port |
| `--upstream-socks5-user <username>` | `upstreamSocks5.username` | Upstream SOCKS5 username |
| `--upstream-socks5-pass <password>` | `upstreamSocks5.password` | Upstream SOCKS5 password |
| `--pool-max-size <number>` | `connectionPool.maxSize` | Pool maximum connections |
| `--pool-min-size <number>` | `connectionPool.minSize` | Pool minimum connections |
| `--pool-acquire-timeout <number>` | `connectionPool.acquireTimeout` | Acquire timeout (ms) |
| `--pool-idle-timeout <number>` | `connectionPool.idleTimeout` | Idle timeout (ms) |
| `-v, --verbose` | `config.verbose` / `logging.level` | Verbose (debug) logging |

`--https-port` semantics (three points, matching the implementation):

1. It is a **separate listening port** for the HTTPS(CONNECT) proxy (`src/app.mjs` `start()` → `startHttpsProxy()`).
2. It performs **no TLS termination**: the port serves the same plain-HTTP CONNECT/request handling as the HTTP port. There is no certificate handling anywhere in the server.
3. When the key is missing or `0` (the default, `proxy.httpsPort: 0`), the port is simply **not listened on**.

Port values outside `0..65535` are rejected by the CLI before startup and the process exits with code `1`; other configuration problems are handled as described in [Configuration validation](#configuration-validation).

### As a Module

```javascript
import { ProxyServer } from 'ssh2proxy';

// Configure SSH tunnel proxy
const config = {
  // Tunnel type: 'ssh' (default) or 'socks5'
  tunnel: {
    type: 'ssh'
  },
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
    pacPort: 8013,      // defaults to 8013; only used when pac.enabled is true
    adminPort: 8081,    // defaults to 8081; only used when admin.enabled is true
    httpsPort: 0,       // defaults to 0 = the HTTPS(CONNECT) port is not listened on
    workerPoolSize: 2   // worker pool threads for PAC rendering (default 2)
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

### Notable configuration keys

`src/config/default.config.mjs` is the single source of truth for defaults. The keys below are read by the implementation and are easy to miss:

| Key | Default | Consumed by |
|-----|---------|-------------|
| `proxy.adminPort` | `8081` | `ProxyServer.startAdminService()`; if the key is missing the admin endpoint is **not** listened on (a warning is printed) |
| `proxy.httpsPort` | `0` | `ProxyServer.start()` → `startHttpsProxy()`; `0`/missing means "not listening", and no TLS termination happens on that port |
| `proxy.workerPoolSize` | `2` | `new WorkerManager({ size: config.proxy.workerPoolSize })` — worker pool threads used for PAC rendering |
| `testingMode` | `false` | Skips connection pool initialization and the worker pool (used by unit tests and local probes) |
| `rateLimit.windowMs` / `rateLimit.max` / `rateLimit.trustProxy` | `60000` / `100` / `false` | Rate limiting middleware; the counter key is the client IP only, and `x-forwarded-for` is ignored unless `trustProxy` is true |
| `pac.directory` / `pac.files` | `''` / `{}` | Multi-PAC loading for `GET /pac/:name` (explicit `files` mapping wins over `directory`) |

### Configuration validation

Validation splits configuration problems into two classes, and only one of them is fatal:

- **Port values** outside `0..65535` are fatal and fail fast: the CLI rejects them before the server starts (exit code `1`), and `ProxyServer` throws from its constructor.
- **Missing SSH credentials** (no host/username/password/private key) are **not** fatal: the implementation prints a warning (`console.warn`) and continues, because running only the PAC service or only the admin endpoints is a supported configuration. `default.config.mjs` itself ships without credentials.

So "the process exits on invalid configuration" is only true for the port class; every other validation message is a warning.

## Load-Balanced Connection Pool

SSH2Proxy supports a load-balanced connection pool that allows multiple connections to share a single SSH tunnel, improving resource utilization and system performance.

### Configuration Options

- `maxConnectionsPerTunnel`: Maximum connections per SSH tunnel (default: 10)
- `loadBalancingStrategy`: Load balancing strategy (default: `least-connections`)

### How It Works

1. Each SSH tunnel can be shared by multiple connections, rather than creating a new tunnel per connection
2. When allocating a tunnel, the pool compares `connectionCount` between the tunnels that are still below `maxConnectionsPerTunnel` and picks the lowest one; `lastUsed` breaks ties, so equal-load tunnels are used in oldest-first order (`src/core/load-balanced-connection-pool.mjs:219-227`)
3. If every tunnel is at the per-tunnel threshold and the pool is below `maxSize`, a new tunnel is created asynchronously and the request waits for it
4. If `maxSize` is also reached, the request is queued instead of silently overloading a tunnel; after `acquireTimeout` it is rejected with `error.code === 'POOL_AT_CAPACITY'`

### Status and shutdown semantics

- `getStatus()` returns `{ available, used, total, maxSize, minSize, maxConnectionsPerTunnel, loadBalancingStrategy, waiting, closed, usedDetails, stats }`, where `usedDetails` carries the per-tunnel `connectionCount` (`src/core/load-balanced-connection-pool.mjs:509-525`).
- After `close()` the pool is **stickily closed** (`closed === true`, never reset). The paths that are explicitly blocked and rejected with `error.code === 'POOL_CLOSED'` are: queued waiters woken by `close()`, the `acquire()` create branch (checked after `await createTunnel()`), the automatic expansion callback (checked after `await createTunnel()`), and the `initialize()` entry point. `release()` no longer returns connections to the pool while closed, and `close()` is idempotent.
- Boundaries that are **not** covered by that guarantee — do not read the above as "everything is rejected after close": a connection attempt already in flight when `close()` runs is not cancelled, so its socket may still be returned to the caller while the pool itself stays empty (`createdTunnels` keeps counting; `stats.closingDiscarded` counts discarded tunnel objects). Calling the internal methods `createTunnel()` / `attach()` / `dispatchTunnel()` / `scheduleExpansion()` directly instead of going through `acquire()` / `initialize()` is undefined behaviour and is not protected by the closed flag.

### Performance Notes

- Fewer SSH tunnels for the same number of client connections, so less process and remote-side resource usage
- Allocation is a comparison over in-memory counters, which keeps per-request overhead low
- The pool bounds concurrency per tunnel and per pool, and surfaces queueing through `getStatus().waiting` instead of silently exceeding the limits

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

SSH2Proxy implements a SOCKS5 connection pool that improves SOCKS5 tunnel performance through connection reuse.

### Pool Features

- Connection reuse: requests to the same target host reuse existing SOCKS5 connections; when several idle connections exist for a target, they are picked round-robin (idle cursor)
- Smart lifecycle management: health checks and idle connection reclamation (`reapIdleConnections`)
- Wait queue: requests enter a queue when the per-target limit is reached, bounded by `waitTimeout`
- Per-target prewarm: `prewarm` / `prewarmCount` / `prewarmTargets` open connections for known targets at tunnel `connect()` time
- Failover: `fallbackHost` / `fallbackPort` are used after the primary upstream exhausts its retries
- Dynamic size adjustment: `Socks5Tunnel#adjustPoolSize()` (delegating to `Socks5ConnectionPool#adjustPoolSize()`) moves the per-target limit by ±1 between `minConnections` and `maxConnectionsLimit`, driven by current usage and also applied automatically on each cleanup tick
- Performance monitoring: `getPoolStats()` exposes counters and current limits

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

**Where these keys are read from.** The pool configuration is resolved from three places, in this priority order (highest first):

1. `socks5Pool` — the top-level alias used in this document;
2. `upstreamSocks5.pool` — the canonical location;
3. `pool` — the historical location, kept for compatibility.

The alias wins because `upstreamSocks5.pool` always exists once defaults are merged, so a lower-priority canonical key would make the alias permanently unreachable. The merge point is the exported `resolveSocks5PoolConfig()` helper, which pushes the three sources in that order and merges them low-to-high (`src/core/socks-tunnel.mjs:39-56`); the tunnel and the pool are constructed from the resolved object at `src/core/socks-tunnel.mjs:832`.

Keys available in the pool section (defaults from `src/config/default.config.mjs`): `maxConnections` `10`, `idleTimeout` `30000`, `connectionTimeout` `10000`, `healthCheckInterval` `60000`, `waitTimeout` `10000`, `cleanupInterval` `10000`, `minConnections` `1`, `maxConnectionsLimit` `0` (`0` means `maxConnections * 4`), `prewarm` `false`, `prewarmCount` `1`, `prewarmTargets` `[]`, `retryBackoffFactor` `2`, `retryMaxDelay` `30000`, `fallbackHost` `''`, `fallbackPort` `0`.

### Performance Notes

This document deliberately publishes **no** percentage or multiplier figures for connection reuse: the earlier numbers in this section had no reproducible benchmark behind them, and the project's documentation rule is that a quantitative claim must be backed by a re-runnable measurement. The qualitative statements below follow directly from the implementation.

- Reusing an idle connection for the same target avoids a new TCP + SOCKS5 handshake, so repeat requests to a warm target skip connection setup.
- Concurrency per target is bounded by `maxConnections`; above that limit requests wait in the queue instead of creating unbounded connections.
- CPU spent on handshakes drops in proportion to the reuse ratio; the pool reports `connectionHits` / `connectionMisses` so the actual ratio can be measured per deployment.

### How It Works

1. Acquire: Check idle pool first when requesting a connection
2. Reuse: Immediately reuse an available idle connection
3. Create: If none available and under the limit, create a new connection
4. Queue: If at the limit, requests enter a wait queue
5. Release: After use, connections are released back to the pool
6. Health check: Periodically validate idle connections

### Metrics

`Socks5Tunnel#getPoolStats()` (delegating to the pool's `getStats()`) exposes the following fields among others:

- `totalConnections` – total connections created (counter)
- `activeConnections` – sum of currently active (checked-out) connections, computed at call time
- `idleConnections` – sum of idle connections held per target, computed at call time
- `pendingRequests` – requests currently queued, computed at call time
- `connectionHits` – counter of requests served from an idle connection
- `connectionMisses` – counter of requests that had to create a connection
- `avgWaitTime` – `totalWaitTime / waitedRequests`, i.e. the mean queue wait in milliseconds over requests that actually waited; it stays `0` when nothing ever queued

Additional counters and the current limits are returned as well: `waits`, `waitedRequests`, `totalWaitTime`, `prewarmed`, `retries`, `retryDelays`, `failovers`, `failures`, `healthChecks`, `healthCheckRemovals`, `dynamicAdjustments`, `idleReaped`, `releases`, `maxConnections`, `minConnections`, `maxConnectionsLimit`, `idleTimeout`, `connectionTimeout`, `healthCheckInterval`, `retryAttempts`, `retryDelay`, `closed`.

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
    "pacPort": 8013
  }
}
```

Or via CLI:
```bash
npx ssh2proxy --pac-file-path ./proxy.pac.js --pac-port 8013
```

`pacPort` defaults to `8013` (`src/config/default.config.mjs`), and the value shown above is that default. `--enable-pac` (or `pac.enabled: true`) is required before anything is listened on the PAC port; `pacPort` alone has no effect.

### Multiple PAC files

Besides a single `pac.filePath`, named PAC files are served per request name:

- `pac.files`: explicit `{ "<request name>": "<file path>" }` mapping;
- `pac.directory`: directory to load `<request name>` from (path traversal is rejected);
- `pac.filePath` still works as single-file compatibility (a request name equal to its basename hits it), and a `pac.filePath` pointing at a directory is treated as `pac.directory`.

Resolving happens in `PacService#resolvePacFile()` (`src/core/pac-service.mjs:28-83`). A name that matches nothing returns **404 `PAC file not found`** — the default PAC content is never used to fake a hit (`src/core/pac-service.mjs:149-155`).

### PAC Access Paths

- `http://[server-ip]:[pacPort]/proxy.pac` – default PAC file
- `http://[server-ip]:[pacPort]/pac/[filename]` – specified PAC file name

For example, with the default PAC port `8013`:
- `http://localhost:8013/proxy.pac`
- `http://192.168.1.100:8013/proxy.pac`

The proxy string inside a generated PAC is built from `proxy.socksPort`, not from a hard-coded port: loopback ports in `pac.defaultProxy` are normalised to the real listening SOCKS5 port (`src/core/pac-service.mjs:119-138`). When the PAC render hot path is served by the worker pool, the pool returns `null` for an unknown name (never a fabricated PAC), so the request falls back to the service above and still gets the 404 (`src/core/worker-manager.mjs:99-118`).

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

## Proxy authentication, rate limiting and address handling

### `auth.enabled` semantics

`auth.enabled` defaults to `false`, and that means the SOCKS5 server **negotiates the "no authentication" method** with the client — an anonymous inbound connection. It is not an authentication success and no credential is checked in that mode. With `auth.enabled: true` the SOCKS5 server only accepts the RFC1929 username/password method and the HTTP/HTTPS(CONNECT) side answers `407` when no credentials are presented (`src/core/socks-proxy.mjs:189-207`, `src/app.mjs:399-431`).

Credentials count as valid only when **both** the username and the password are non-empty. If `auth.enabled: true` is set while either of them is empty, the implementation is fail-closed: every authentication attempt is rejected (`01 01` plus connection close) and a warning is printed at construction time. Comparisons are constant-time on both the SOCKS5 side and the HTTP Basic side.

### Rate limiting

`rateLimit.windowMs` (default `60000`), `rateLimit.max` (default `100`) and `rateLimit.trustProxy` (default `false`) configure a fixed-window limiter. The counter key contains the **client IP only** — changing the URL or the HTTP method does not reset the window. `x-forwarded-for` is client-controlled and therefore ignored unless `trustProxy` is explicitly `true`. `windowMs <= 0` disables limiting, `max <= 0` rejects every request.

### Address handling (SOCKS5)

SOCKS5 requests are dispatched on the `ATYP` byte the client sends: `0x01` IPv4, `0x03` domain, `0x04` IPv6 (`src/core/socks-proxy.mjs:74-101`, `:312-345`). The SOCKS5 layer does not rewrite the requested address and does not map IPv6 to IPv4; literals are serialised in their standard compressed form. End-to-end IPv6 reachability still depends on the tunnel implementation behind `forwardOut()`. An unknown `ATYP` is answered with reply `0x08` (address type not supported).

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

The suite is Mocha + Chai over `src/tests/`. Integration tests inject a stub tunnel at the connection-creation seam (`connectionPool.createTunnel`) and drive the real proxy pipeline — request line and `Host` construction, a real TCP round trip to a local upstream, real pool `acquire`/`release` bookkeeping and the unreachable-upstream failure path. The real SSH handshake is **not** covered by the suite, and the repository's `mock-ssh-server.mjs` cannot complete an ssh2 handshake, so it is not used by any test.

## License

MIT