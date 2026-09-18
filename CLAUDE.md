# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SSH2Proxy is a high-performance SSH tunnel proxy server that supports HTTP, HTTPS, and SOCKS5 proxy protocols. It can use either SSH tunnels or upstream SOCKS5 proxies as transport mechanisms.

## Development Commands

### Build and Development
- `npm run build` - Clean, lint, build with Vite, build CLI, and verify externals in strict mode
- `npm run build-cli` - Build CLI tool only
- `npm run check-externals` - Verify the Rollup external list against real import sites
- `npm run dev` - Start development server with Vite
- `npm run clean` - Remove dist directory
- `npm start` - Run the built CLI (`node dist/cli.js`)

### Code Quality
- `npm run lint` - Run ESLint with auto-fix over `src/` and `scripts/`
- `npm test` - Run Mocha tests (`mocha --recursive src/tests/`)

### Publishing
- `npm run prepublishOnly` - Build before publishing

## Architecture Overview

### Core Components

**Tunnel Types:**
- `SSHTunnel` (`src/core/ssh-tunnel.mjs`) - SSH-based tunneling using ssh2 library
- `Socks5Tunnel` (`src/core/socks-tunnel.mjs`) - SOCKS5 proxy tunneling with connection pooling

**Proxy Services:**
- `ProxyServer` (`src/app.mjs`) - Main server orchestrating all proxy services
- `Socks5Proxy` (`src/core/socks-proxy.mjs`) - SOCKS5 protocol implementation
- HTTP/HTTPS(CONNECT) proxy - Inline in `src/app.mjs`: the listener is created by `ProxyServer#createHttpProxyServer()` and started by `startHttpProxy()` / `startHttpsProxy()`. There is no separate module file for it; those method names are not module paths
- `PacService` (`src/core/pac-service.mjs`) - PAC file service, single file plus multi-PAC (`pac.directory` / `pac.files`), 404 for unknown names
- Admin endpoints - Inline in `src/app.mjs` (`startAdminService()` / `registerAdminRoutes()`), listening on `proxy.adminPort`

**Connection Management:**
- `LoadBalancedConnectionPool` (`src/core/load-balanced-connection-pool.mjs`) - Manages SSH tunnel connections with load balancing
- `Socks5ConnectionPool` (`src/core/socks-tunnel.mjs`) - Connection pooling for SOCKS5 tunnels
- `ConnectionInitializer` (`src/core/connection-initializer.mjs`) - Handles connection pool initialization and maintenance

**Additional Services:**
- `WorkerManager` (`src/core/worker-manager.mjs`) - Real `node:worker_threads` pool (multi-threading); it is started from `ProxyServer.start()` and serves the PAC render hot path, with main-thread fallback through the same handler table
- `resolveSocks5PoolConfig` (`src/core/socks-tunnel.mjs`) - Resolves SOCKS5 pool settings from `socks5Pool` > `upstreamSocks5.pool` > `pool`

### Configuration System

Configuration is managed through `src/config/default.config.mjs` with support for:
- SSH connection settings
- SOCKS5 upstream proxy settings, including the per-target pool section
- Connection pool configuration
- Proxy service ports
- PAC service settings
- Authentication settings
- Admin interface settings
- Rate limiting settings
- Worker pool capacity and the `testingMode` switch

Keys that are read by the implementation but are easy to miss (defaults in parentheses):

| Key | Default | Consumed by |
|-----|---------|-------------|
| `proxy.adminPort` | `8081` | `startAdminService()`; missing key means the admin endpoint is not listened on (warning printed) |
| `proxy.httpsPort` | `0` | `start()` → `startHttpsProxy()`; `0`/missing means "not listening"; no TLS termination |
| `proxy.workerPoolSize` | `2` | `new WorkerManager({ size: config.proxy.workerPoolSize })` |
| `testingMode` | `false` | Skips connection pool initialization and the worker pool |
| `rateLimit.windowMs` / `.max` / `.trustProxy` | `60000` / `100` / `false` | Rate limiting middleware (counter key is the client IP only) |
| `pac.directory` / `pac.files` | `''` / `{}` | Multi-PAC loading for `GET /pac/:name` |
| `proxy.host` | *absent from `default.config.mjs`* | CLI `-h`/`--host` → `config.proxy.host` → the listening arguments (`host` is passed to `listen()` only when set); without it Node binds to its own default. Adding a default key would change behaviour |
| `ssh.retryBackoffFactor` / `ssh.retryMaxDelay` | *absent from the `ssh` section* | Read by `src/core/ssh-tunnel.mjs` (`DEFAULT_RETRY`); the same names do exist under `upstreamSocks5.pool`. Adding them to the `ssh` section would change behaviour |

Configuration validation has two classes: invalid **port** values fail fast (the CLI exits with code `1` before startup and the `ProxyServer` constructor throws), while missing **SSH credentials** only produce a `console.warn` and do not abort startup — running PAC-only or admin-only is supported. The port class covers exactly `proxy.httpPort` and `proxy.socksPort`: `validateConfig()` does not validate `proxy.httpsPort`, `proxy.pacPort` or `proxy.adminPort`.

### Key Design Patterns

1. **Connection Pooling**: Both SSH and SOCKS5 tunnels use connection pooling to improve performance
2. **Load Balancing**: SSH tunnels dispatch on `connectionPool.loadBalancingStrategy` — `least-connections` (default, compares `connectionCount` with `lastUsed` as tie-breaker) or `round-robin` (cursor over the eligible tunnels); unrecognised values fall back to `least-connections`
3. **Event-Driven Architecture**: Uses Node.js EventEmitter for component communication
4. **Middleware Pattern**: Authentication, logging, and rate limiting implemented as middleware

## Important Implementation Details

### Tunnel Abstraction
Both SSH and SOCKS5 tunnels implement the same interface:
- `connect()` - Establish tunnel connection
- `forwardOut(srcIP, srcPort, dstIP, dstPort)` - Create forwarding stream
- `close()` - Close tunnel connection

### Connection Pool Strategy
- SSH tunnels: load-balanced pool that dispatches on `loadBalancingStrategy` (`least-connections` compares `connectionCount` with `lastUsed` as tie-breaker; `round-robin` rotates a cursor over the eligible tunnels; unrecognised values fall back to `least-connections`); requests queue at `maxSize` and are rejected with `POOL_AT_CAPACITY` after `acquireTimeout`. `close()` is sticky and exactly **three** paths throw `POOL_CLOSED` — waiters woken by `close()`, the `acquire()` create branch after `await createTunnel()`, and the `initialize()` entry (`throwIfClosed()`); the automatic expansion callback does **not** throw, it discards the new tunnel object and returns. A connection attempt already in flight is not handed to the caller either: the late socket is destroyed, counted in `stats.lateDiscarded`, and rejected with `POOL_CLOSED`
- SOCKS5 tunnels: per-destination connection pool with idle timeout, health checks, round-robin idle selection, bounded wait queue (`waitTimeout`), prewarm (`prewarmTargets`), upstream failover (`fallbackHost`/`fallbackPort`) and dynamic size adjustment via `adjustPoolSize()`

### Error Handling
- All tunnel operations include comprehensive error handling
- Connection pool includes retry mechanisms (SOCKS5 connect retries come from `connectionPool.retryAttempts` / `retryDelay` with exponential backoff capped by `retryMaxDelay`)
- Graceful degradation when connections fail

### Security Features
- SSH private key authentication support
- HTTP basic authentication for proxy access, with constant-time credential comparison
- SOCKS5 authentication support (RFC1929), constant-time comparison, fail-closed when `auth.enabled` is true but the username or password is empty
- `auth.enabled: false` (the default) means the SOCKS5 server negotiates the no-auth method, i.e. anonymous inbound — it is not an authentication success
- Helmet.js and CORS applied to the PAC and admin Express apps

## Testing

Tests are located in `src/tests/` using Mocha and Chai:
- Unit tests for individual components (`socks-tunnel.test.mjs`, `load-balanced-connection-pool.test.mjs`, `proxy.test.mjs`)
- `src/tests/integration/socks5-tunnel.integration.test.mjs` drives the real proxy pipeline but injects a stub tunnel at the connection-creation seam (`connectionPool.createTunnel`): request line / `Host` construction, a real TCP round trip to a local upstream, real pool `acquire` / `release` bookkeeping and the unreachable-upstream failure path
- Test files follow naming pattern `*.test.mjs`
- `npm test` runs `mocha --recursive src/tests/` (no `--exit`: the suite exits naturally)
- Coverage boundaries: the real SSH handshake is **not** exercised, `supertest` is not used and is not a dependency, and the repository's `mock-ssh-server.mjs` cannot complete an ssh2 handshake so no test uses it

## CLI Tool

The CLI is built separately in `scripts/build-cli.mjs` and uses Commander.js for argument parsing. Main entry point is `src/cli/cli.mjs`, where `applyCliOptions()` is the one place that maps **option groups** to config keys (`validateStartupConfig()` performs the pre-start validation). The single exception is `--ssh-private-key-path`, which cannot be a pure key mapping: `main()` reads the file content and assigns `config.ssh.privateKey`.

Short flags follow the implementation, not intuition: `-c` = `--config`, `-p` = `--port`, **`-h` = `--host`**, `-H` = `--help`, `-v` = `--verbose`, `-V` = `--version`. `--https-port <port>` selects a separate listening port for the HTTPS(CONNECT) proxy; it does **not** terminate TLS, and the port is not listened on when `proxy.httpsPort` is missing or `0`.

## Build System

- Uses Vite for building the main library (ESM `dist/index.mjs` + CJS `dist/index.cjs`) and a separate Node script for the CLI (`dist/cli.js`)
- `npm run build` = `clean` + `lint` + `vite build` + `build-cli` + `check-externals --strict`; it does not run the test suite
- ES modules throughout the codebase
- Target: Node.js environment