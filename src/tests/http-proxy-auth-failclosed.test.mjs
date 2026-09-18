/**
 * D1-auth：HTTP 代理面认证 fail-closed 回归测试（blocker H1-S401）
 *
 * 缺陷（Round 02 S4 + 红队坐实）：`src/app.mjs#validateAuth()` 只做了恒定时间比较（F9），
 * **缺「凭据有效性」前置判据** ⇒ `auth.enabled=true` + `username=''` + `password=''` 时
 * `'' === ''` 使两个比较都返回 true ⇒ 客户端发 `Proxy-Authorization: Basic Og==`（空 user:pass）
 * 即被放行并**真实转发**（上游实收 +1）。
 *
 * 本文件是**可失败测试**：修复前「空凭据必须 407」的用例实测得 200 OK 且上游实收 +1 ⇒ 变红，
 * 证明断言能真正抓住该缺陷而非恒真（pre-fix 日志见运行根 pre-fix-newtests.log）。
 *
 * 观测手段与 C6 集成测试同源：裸 TCP 经真实代理端口发 absolute-form 请求；
 * 「是否真的转发了」由**上游实收**（真实 echo 的副作用）判定，不依赖客户端读到的响应字节
 * （产品在转发路径上用 `stream.pipe(res)` 把**上游整条原始响应字节**当作 body 灌进 `http.ServerResponse`，
 * 见 `src/app.mjs` 的 `handleHttpRequest()` 内 ⇒ 客户端读到的是「响应套响应」，**并非逐字节透传**；
 * 用 `http` 客户端只会再多包一层 chunked 解析，观测不到链路原始字节形态）。
 */

import { describe, it, before, after, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import net from 'node:net';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import ProxyServer from '../app.mjs';
import defaultConfig from '../config/default.config.mjs';
import { mergeConfig } from '../utils/helpers.mjs';

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
    this.closeCount += 1;
    this.isConnected = false;
    this.emit('close');
  }

  forwardOut(srcIP, srcPort, dstIP, dstPort) {
    this.forwardOutCalls.push({ srcIP, srcPort, dstIP, dstPort });
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

/** 本地 echo：记录上游实收的请求行与 Host，供「是否真的转发」独立取证。 */
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

/** 取一个当前空闲的回环随机端口（禁 8080/8013）。 */
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

/** 经代理端口发一次普通 HTTP 代理请求，可带 Proxy-Authorization 头。裸 TCP。 */
function rawProxyGet(proxyPort, absoluteUrl, hostHeader, proxyAuthHeader, timeoutMs = 3000) {
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
      const authLine = proxyAuthHeader ? `Proxy-Authorization: ${proxyAuthHeader}\r\n` : '';
      sock.write(`GET ${absoluteUrl} HTTP/1.1\r\nHost: ${hostHeader}\r\n${authLine}Connection: close\r\n\r\n`);
    });
    sock.on('data', (d) => { buf += d; });
    sock.on('end', finish);
    sock.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    setTimeout(finish, timeoutMs);
  });
}

/** 构造一个只在 127.0.0.1 上监听、auth 配置可控的服务器。 */
async function startProxy({ auth }) {
  const config = mergeConfig(defaultConfig, {});
  config.proxy.httpPort = await freeLoopbackPort();
  config.proxy.httpsPort = 0;
  config.proxy.socksPort = await freeLoopbackPort();
  config.proxy.pacPort = await freeLoopbackPort();
  config.proxy.adminPort = await freeLoopbackPort();
  config.pac.enabled = false;
  config.admin.enabled = false;
  config.auth = auth;
  config.connectionPool.minSize = 1;
  config.connectionPool.maxSize = 3;
  config.connectionPool.maxConnectionsPerTunnel = 5;
  config.connectionPool.acquireTimeout = 2000;

  const server = new ProxyServer(config);
  server.stubTunnels = stubOutCreateTunnel(server.connectionPool);
  await server.connectionPool.initialize();
  server.httpServer = server.createHttpProxyServer();
  await new Promise((resolve, reject) => {
    server.httpServer.once('error', reject);
    server.httpServer.listen(0, '127.0.0.1', resolve);
  });
  return { server, port: server.httpServer.address().port };
}

async function stopProxy(server) {
  if (server.httpServer) await new Promise((resolve) => server.httpServer.close(resolve));
  if (server.connectionPool && typeof server.connectionPool.close === 'function') {
    await server.connectionPool.close();
  }
}

// Basic 头构造（明文 → base64），使用例意图一眼可读
const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`, 'ascii').toString('base64')}`;

describe('D1-auth · HTTP 代理面认证 fail-closed（H1-S401）', () => {
  let echo;

  before(async function () {
    this.timeout(20000);
    echo = await startEchoServer();
  });

  after(async function () {
    this.timeout(10000);
    if (echo && echo.server) await new Promise((resolve) => echo.server.close(resolve));
  });

  describe('auth.enabled=true 且凭据配置为空 ⇒ 必须 fail-closed', () => {
    let proxy;
    beforeEach(async function () {
      this.timeout(20000);
      proxy = await startProxy({ auth: { enabled: true, username: '', password: '' } });
    });
    afterEach(async function () {
      this.timeout(10000);
      await stopProxy(proxy.server);
      proxy = null;
    });

    it('空用户名+空口令 + Basic Og== ⇒ 407 且不得转发到上游', async function () {
      this.timeout(10000);
      const hitsBefore = echo.received.length;

      // 红队原始 PoC：空 `user:pass` 的 base64 就是 `Og==`
      const raw = await rawProxyGet(proxy.port, `http://127.0.0.1:${echo.port}/empty-cred-poc`, `127.0.0.1:${echo.port}`, 'Basic Og==');

      // 可失败条件（修复前实测）：状态行是 200 OK 且上游实收 +1 ⇒ 两条断言同时变红
      expect(raw).to.include('HTTP/1.1 407');
      expect(raw).to.not.include('HTTP/1.1 200 OK');
      // 「不得转发」由上游副作用独立取证，而非只看状态行
      expect(echo.received.length).to.equal(hitsBefore);
    });

    it('无 Proxy-Authorization 头 ⇒ 407 且不得转发（负向对照，修复前后均通过）', async function () {
      this.timeout(10000);
      const hitsBefore = echo.received.length;
      const raw = await rawProxyGet(proxy.port, `http://127.0.0.1:${echo.port}/no-header`, `127.0.0.1:${echo.port}`, null);

      expect(raw).to.include('HTTP/1.1 407');
      expect(echo.received.length).to.equal(hitsBefore);
    });
  });

  describe('auth.enabled=true 且仅口令为空 ⇒ 必须 fail-closed', () => {
    let proxy;
    beforeEach(async function () {
      this.timeout(20000);
      proxy = await startProxy({ auth: { enabled: true, username: 'u', password: '' } });
    });
    afterEach(async function () {
      this.timeout(10000);
      await stopProxy(proxy.server);
      proxy = null;
    });

    it('username=u + 空口令 + Basic dTo= ⇒ 407 且不得转发到上游', async function () {
      this.timeout(10000);
      const hitsBefore = echo.received.length;
      // `u:` 的 base64 是 `dTo=`
      const raw = await rawProxyGet(proxy.port, `http://127.0.0.1:${echo.port}/empty-pass-poc`, `127.0.0.1:${echo.port}`, 'Basic dTo=');

      expect(raw).to.include('HTTP/1.1 407');
      expect(raw).to.not.include('HTTP/1.1 200 OK');
      expect(echo.received.length).to.equal(hitsBefore);
    });
  });

  describe('auth.enabled=true 且凭据有效 ⇒ 必须放行（回归防护）', () => {
    let proxy;
    beforeEach(async function () {
      this.timeout(20000);
      proxy = await startProxy({ auth: { enabled: true, username: 'u', password: 'p' } });
    });
    afterEach(async function () {
      this.timeout(10000);
      await stopProxy(proxy.server);
      proxy = null;
    });

    it('正确凭据 ⇒ 200 且上游实收请求（正例，防「一律拒绝」的过度修复）', async function () {
      this.timeout(10000);
      const hitsBefore = echo.received.length;
      const raw = await rawProxyGet(proxy.port, `http://127.0.0.1:${echo.port}/valid-cred`, `127.0.0.1:${echo.port}`, basic('u', 'p'));

      expect(raw).to.include('HTTP/1.1 200 OK');
      expect(raw).to.include('ECHO_FROM_UPSTREAM /valid-cred');
      expect(echo.received.length).to.equal(hitsBefore + 1);
      expect(echo.received[echo.received.length - 1].url).to.equal('/valid-cred');
    });

    it('错误口令 ⇒ 407 且不得转发（负向对照）', async function () {
      this.timeout(10000);
      const hitsBefore = echo.received.length;
      const raw = await rawProxyGet(proxy.port, `http://127.0.0.1:${echo.port}/wrong-pass`, `127.0.0.1:${echo.port}`, basic('u', 'WRONG'));

      expect(raw).to.include('HTTP/1.1 407');
      expect(echo.received.length).to.equal(hitsBefore);
    });
  });
});
