# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SSH2Proxy is a high-performance SSH tunnel proxy server that supports HTTP, HTTPS, and SOCKS5 proxy protocols. It can use either SSH tunnels or upstream SOCKS5 proxies as transport mechanisms.

## Development Commands

### Build and Development
- `npm run build` - Clean, lint, build with Vite, and build CLI
- `npm run build-cli` - Build CLI tool only
- `npm run dev` - Start development server with Vite
- `npm run clean` - Remove dist directory

### Code Quality
- `npm run lint` - Run ESLint with auto-fix
- `npm test` - Run Mocha tests

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
- HTTP/HTTPS proxy - Built-in HTTP server handling CONNECT and regular requests

**Connection Management:**
- `LoadBalancedConnectionPool` (`src/core/load-balanced-connection-pool.mjs`) - Manages SSH tunnel connections with load balancing
- `Socks5ConnectionPool` (`src/core/socks-tunnel.mjs`) - Connection pooling for SOCKS5 tunnels
- `ConnectionInitializer` (`src/core/connection-initializer.mjs`) - Handles connection pool initialization and maintenance

**Additional Services:**
- `PacService` (`src/core/pac-service.mjs`) - Proxy Auto-Configuration file service
- `WorkerManager` (`src/core/worker-manager.mjs`) - Multi-threading support

### Configuration System

Configuration is managed through `src/config/default.config.mjs` with support for:
- SSH connection settings
- SOCKS5 upstream proxy settings
- Connection pool configuration
- Proxy service ports
- PAC service settings
- Authentication settings
- Admin interface settings

### Key Design Patterns

1. **Connection Pooling**: Both SSH and SOCKS5 tunnels use connection pooling to improve performance
2. **Load Balancing**: SSH tunnels use least-connections strategy for load distribution
3. **Event-Driven Architecture**: Uses Node.js EventEmitter for component communication
4. **Middleware Pattern**: Authentication, logging, and rate limiting implemented as middleware

## Important Implementation Details

### Tunnel Abstraction
Both SSH and SOCKS5 tunnels implement the same interface:
- `connect()` - Establish tunnel connection
- `forwardOut(srcIP, srcPort, dstIP, dstPort)` - Create forwarding stream
- `close()` - Close tunnel connection

### Connection Pool Strategy
- SSH tunnels: Load-balanced pool with configurable max connections per tunnel
- SOCKS5 tunnels: Per-destination connection pool with idle timeout and health checks

### Error Handling
- All tunnel operations include comprehensive error handling
- Connection pool includes retry mechanisms
- Graceful degradation when connections fail

### Security Features
- SSH private key authentication support
- HTTP basic authentication for proxy access
- SOCKS5 authentication support
- Helmet.js for HTTP security headers

## Testing

Tests are located in `src/tests/` using Mocha and Chai:
- Unit tests for individual components
- Integration tests for end-to-end functionality
- Test files follow naming pattern `*.test.mjs`

## CLI Tool

The CLI is built separately in `scripts/build-cli.mjs` and uses Commander.js for argument parsing. Main entry point is `src/cli/cli.mjs`.

## Build System

- Uses Vite for building the main library
- CLI is built separately using Node.js scripts
- ES modules throughout the codebase
- Target: Node.js environment