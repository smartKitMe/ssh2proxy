import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import http from 'http';
import net from 'net';
import { EventEmitter } from 'events';
import ProxyServer from '../../app.mjs';
import defaultConfig from '../../config/default.config.mjs';

/**
 * 集成测试：真实 HTTP 代理请求 → ProxyServer 真实链路（handleHttpRequest → buildForwardRequest →
 * 隧道 forwardOut → 上游）→ 本地 echo 服务器。
 *
 * ## 为什么用 stub 隧道（A10/A11 覆盖边界登记）
 *
 * 本用例集**不验证真实 SSH 握手**：真实握手需要一个可用的 SSH 服务端，而仓库根目录的
 * `mock-ssh-server.mjs` 实测无法完成 ssh2 握手（D-135 坐实：`Bad packet length`，负向对照见
 * `tasks/C6-tests/artifacts/a11-mock-ssh-negative-control.log`）。
 *
 * **替代覆盖手段**：stub 隧道只替换「建连 + forwardOut 的传输层」，被测链路本身全部真实执行——
 *   - 真实 `ProxyServer` 实例与真实 `connectionPool.acquire()/release()` 记账；
 *   - 真实 `handleHttpRequest()`（URL 解析、请求行/Host 重建、双向管道）；
 *   - 真实 `buildForwardRequest()`（D-138 修复后的契约：`pathname + search`、Host 带非默认端口）；
 *   - 真实 TCP 往返：`forwardOut` 真实 `net.connect()` 到本地 echo，断言 echo **实收**的字节。
 * 断言指向「上游实收的请求行与 Host」这一产品链路副作用，而非对象类型或构造器身份。
 *
 * 覆盖边界的权威登记见 `tasks/C6-tests/handoff/known_issues.md`。
 */

/** 只替换建连的桩隧道：forwardOut 真实转发到目标（本地 echo）。 */
class ForwardingStubTunnel extends EventEmitter {
  constructor() {
    super();
    this.isConnected = false;
    this.forwardOutCalls = [];
    this.closeCount = 0;
  }

  async connect() {
    this.isConnected = true;
    this.emit('connect');
  }

  close() {
    this.closeCount++;
    this.isConnected = false;
    this.emit('close');
  }

  forwardOut(srcIP, srcPort, dstIP, dstPort) {
    this.forwardOutCalls.push({ srcIP, srcPort, dstIP, dstPort });
    // 真实建立到目标的 TCP 连接（本地回环 echo），使「产品链路副作用」可被真实观测
    return Promise.resolve(net.connect(dstPort, dstIP));
  }
}

/** 把真实池的建连替换为桩隧道；池自身的 acquire/release/记账逻辑保持产品实现。 */
function stubOutCreateTunnel(pool) {
  const created = [];
  pool.createTunnel = async function createTunnel() {
    const tunnel = new ForwardingStubTunnel();
    this.wireTunnelEvents(tunnel);
    await tunnel.connect();
    created.push(tunnel);
    this.stats.createdTunnels++;
    return { tunnel, connectionCount: 0, lastUsed: Date.now(), isActive: true };
  };
  return created;
}

/** 本地 echo：记录上游实收的请求行与 Host，并在响应体中回显路径，供断言上游响应体确实到达客户端。 */
function startEchoServer() {
  const received = [];
  const server = http.createServer((req, res) => {
    received.push({ method: req.method, url: req.url, host: req.headers.host });
    const body = `ECHO_FROM_UPSTREAM ${req.url}`;
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, received, port: server.address().port }));
  });
}

/** 取一个当前空闲的回环端口（先占后放，避免与 8080/8013 等他人端口冲突）。 */
function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/**
 * 经代理端口发一次普通 HTTP 代理请求。
 *
 * 必须用**裸 TCP** 而不是 `http.request`：产品在 HTTP 转发路径上用 `stream.pipe(res)`
 * （`src/app.mjs` 的 `handleHttpRequest()` 内）把**上游整条原始响应字节**（含上游状态行、头与 chunked 分帧）
 * 当作 **body** 灌进客户端的 `http.ServerResponse` ⇒ 客户端读到的是「响应套响应」：
 * 外层是 Node 生成的状态行 + `Transfer-Encoding: chunked`，body 里再嵌一条完整的上游响应
 * （本席独立复跑：`STATUS_LINE_COUNT=2`、`HAS_CHUNKED=true`，`http.request` 的 body 以上游状态行开头）。
 *
 * 故这里**不是**「逐字节透传」：上游响应体（echo 的 `ECHO_FROM_UPSTREAM <path>`）确实到达了客户端，
 * 但它被**包在外层 HTTP 响应与 chunked 分帧之内**。用 `http.request` 只会再多包一层 chunked 解析，
 * 观测不到链路的原始字节形态；裸 TCP 读回的字节才能直接断言「上游响应体确实到得了客户端」。
 */
function rawProxyGet(proxyPort, absoluteUrl, hostHeader, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, '127.0.0.1');
    let buf = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* 已关闭 */ }
      resolve(buf);
    };
    sock.setEncoding('binary');
    sock.on('connect', () => {
      // absolute-form 请求行是 HTTP 代理的标准形态
      sock.write(`GET ${absoluteUrl} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`);
    });
    sock.on('data', (d) => { buf += d; });
    sock.on('end', finish);
    // 上游不可达时链路可能不产生任何响应字节、也不触发 end ⇒ 用超时收敛，
    // 返回「已收到的字节」（可能为空串），由断言判定不得为 200。
    sock.setTimeout(timeoutMs, finish);
    sock.on('error', (err) => { if (settled) return; settled = true; reject(err); });
  });
}

describe('Socks5Tunnel Integration', () => {
  let echo;
  let server;
  let proxyPort;

  before(async function () {
    this.timeout(15000);
    echo = await startEchoServer();

    const config = JSON.parse(JSON.stringify(defaultConfig));
    config.proxy.host = '127.0.0.1';
    // 全部用「当前空闲的回环随机端口」——禁绑 8080/8013（A13）。
    // 注意不能用 0：产品侧 validateConfig 要求端口 > 0，0 会被判非法配置。
    config.proxy.httpPort = await freeLoopbackPort();
    config.proxy.httpsPort = 0;
    config.proxy.socksPort = await freeLoopbackPort();
    config.proxy.pacPort = await freeLoopbackPort();
    config.pac.enabled = false;
    config.admin.enabled = false;
    config.auth.enabled = false;
    config.connectionPool.minSize = 1;
    config.connectionPool.maxSize = 3;
    config.connectionPool.maxConnectionsPerTunnel = 5;
    config.connectionPool.acquireTimeout = 2000;

    server = new ProxyServer(config);
    // 注入点：替换建连（传输层），其余产品链路真实执行
    server.stubTunnels = stubOutCreateTunnel(server.connectionPool);
    await server.connectionPool.initialize();

    server.httpServer = server.createHttpProxyServer();
    await new Promise((resolve, reject) => {
      server.httpServer.once('error', reject);
      server.httpServer.listen(0, '127.0.0.1', resolve);
    });
    proxyPort = server.httpServer.address().port;
    expect(proxyPort).to.be.greaterThan(0);
  });

  after(async function () {
    this.timeout(10000);
    if (server && server.httpServer) {
      await new Promise((resolve) => server.httpServer.close(resolve));
    }
    if (server && server.connectionPool && typeof server.connectionPool.close === 'function') {
      await server.connectionPool.close();
    }
    if (echo && echo.server) {
      await new Promise((resolve) => echo.server.close(resolve));
    }
  });

  it('should forward a real HTTP request through the proxy with correct request-line and Host', async function () {
    this.timeout(10000);
    const before = echo.received.length;

    // 经真实代理端口发真实 HTTP 请求，目标是本地 echo
    const raw = await rawProxyGet(proxyPort, `http://127.0.0.1:${echo.port}/echo-path?x=1`, `127.0.0.1:${echo.port}`);

    // 可失败条件：链路任一处退化（如 D-138 的 `urlObject.path` 恒为 '/'）→ 下面断言即变红。
    expect(raw).to.include('HTTP/1.1 200 OK');
    expect(raw).to.include('ECHO_FROM_UPSTREAM /echo-path?x=1');

    // 「上游实收」独立取证：echo 侧记录的请求行与 Host（不依赖客户端读到的响应）
    expect(echo.received.length).to.equal(before + 1);
    const got = echo.received[echo.received.length - 1];
    expect(got.method).to.equal('GET');
    expect(got.url).to.equal('/echo-path?x=1');
    expect(got.host).to.equal(`127.0.0.1:${echo.port}`);
  });

  it('should exercise the real connection pool acquire/release bookkeeping', async function () {
    this.timeout(10000);
    const statusBefore = server.connectionPool.getStatus();

    const raw = await rawProxyGet(proxyPort, `http://127.0.0.1:${echo.port}/second`, `127.0.0.1:${echo.port}`);
    expect(raw).to.include('ECHO_FROM_UPSTREAM /second');

    const statusAfter = server.connectionPool.getStatus();

    // 真实池副作用：stub 覆写只替换建连，acquire 记账由产品实现完成。
    // 可失败条件：链路未走 connectionPool.acquire（acquires 不增长）或未在释放时回填（used 不回落到 0）。
    expect(statusAfter.stats.acquires).to.be.greaterThan(statusBefore.stats.acquires);
    expect(statusAfter.total).to.equal(statusBefore.total);
    expect(statusAfter.used).to.equal(0);
    expect(server.stubTunnels.length).to.be.greaterThan(0);
    const calls = server.stubTunnels.flatMap((t) => t.forwardOutCalls);
    expect(calls.length).to.be.greaterThan(0);
    expect(calls.every((c) => c.dstIP === '127.0.0.1' && c.dstPort === echo.port)).to.equal(true);
  });

  it('should reject and surface an error when the upstream target is unreachable', async function () {
    this.timeout(10000);
    // 负向对照：目标端口无监听 → 产品链路必须给出失败，而不是静默返回 200。
    const closedPort = await freeLoopbackPort();

    const raw = await rawProxyGet(proxyPort, `http://127.0.0.1:${closedPort}/nope`, `127.0.0.1:${closedPort}`);

    // 可失败条件：上游不可达却被当作成功转发（回包是 200）。
    expect(raw).to.not.include('HTTP/1.1 200 OK');
  });

  it('should build request line and Host per the frozen D-138 contract', async () => {
    // 直接对纯函数取真值（产品导出的 buildForwardRequest），逐形态核对契约。
    const { buildForwardRequest } = await import('../../app.mjs');

    const cases = [
      { url: 'http://example.com/a/b?c=d', method: 'GET', line: 'GET /a/b?c=d HTTP/1.1\r\n', host: 'example.com' },
      { url: 'http://example.com:8080/x', method: 'POST', line: 'POST /x HTTP/1.1\r\n', host: 'example.com:8080' },
      { url: 'http://example.com:80/y', method: 'GET', line: 'GET /y HTTP/1.1\r\n', host: 'example.com' },
      { url: 'https://example.com:443/z', method: 'GET', line: 'GET /z HTTP/1.1\r\n', host: 'example.com' },
      { url: 'http://example.com/', method: 'GET', line: 'GET / HTTP/1.1\r\n', host: 'example.com' }
    ];

    for (const c of cases) {
      const { requestLine, hostHeader } = buildForwardRequest(new URL(c.url), c.method);
      // 可失败条件：回退为 `urlObject.path || '/'`（路径丢失）或端口规范化错误。
      expect(requestLine, `requestLine for ${c.url}`).to.equal(c.line);
      expect(hostHeader, `hostHeader for ${c.url}`).to.equal(c.host);
    }
  });
});
