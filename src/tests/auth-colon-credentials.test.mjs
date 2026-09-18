/**
 * D5-auth-colon：Basic 凭据解析的**跨面语义漂移**修复（RFC 7617）
 *
 * 缺陷（D1 审查门 §9-1 + D1 sdet 独立命中，两方同源）：`src/app.mjs#validateAuth()` 用
 * `credentials.split(':')` 解析 Basic 凭据明文 ⇒ 只取第 2 段做口令。Basic 凭据是
 * `base64(user:pass)`，**口令本身允许含 `':'`** ⇒ 配置 `username='u'`、`password='p:q'` 时，
 * 客户端发**正确**凭据仍被判错（**fail-closed，非安全绕过，但功能不正确**）：
 *   实测配置 `u:p:q` ⇒ 代理面 **407**、Express `basicAuth`（管理/PAC 面）**200** ⇒ 同一语义两处实现不一致。
 *   且修复前的副本同样 407 ⇒ **属既有缺陷，非 D1 引入**。
 *
 * 修复：新增唯一口径的纯函数 `parseBasicCredentials()`（首个 `':'` 前为用户名，**其余全部**为口令），
 * 代理面 `validateAuth()` 与管理端点 `'/api/*'` **两处共同消费**；与 `src/middleware/auth.mjs#basicAuth`
 * 的 `indexOf(':')` + `slice` 逐字同义。
 *
 * 本文件是**可失败测试**：修复前「含冒号口令的正例」实测 407 ⇒ 变红，且断言消息携带实际状态行
 * 与实际口令长度（可看出是**凭据被截断**导致，而非其它错误）。pre-fix 变红日志见
 * `artifacts/negative-control/`。观测手段与 D1/C6 同源：裸 TCP 经真实代理端口，转发与否由**上游实收**独立取证。
 */

import { describe, it, before, after, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import net from 'node:net';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import ProxyServer, { parseBasicCredentials } from '../app.mjs';
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

/**
 * 经代理端口发一次普通 HTTP 代理请求（absolute-form），可带 Proxy-Authorization 头。裸 TCP。
 * @returns {Promise<{statusLine: string, raw: string}>} 同时给出可读状态行与原响应
 */
function rawProxyGet(proxyPort, absoluteUrl, hostHeader, proxyAuthHeader, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, '127.0.0.1');
    let buf = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* 已关闭 */ }
      const statusLine = (buf.split('\r\n')[0] || '<no response>').trim();
      resolve({ statusLine, raw: buf });
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

/** 经代理端口发一次 CONNECT（HTTPS 隧道）请求，看代理是否进入隧道（200）还是 407。 */
function rawProxyConnect(proxyPort, target, proxyAuthHeader, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, '127.0.0.1');
    let buf = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* 已关闭 */ }
      const statusLine = (buf.split('\r\n')[0] || '<no response>').trim();
      resolve({ statusLine, raw: buf });
    };
    sock.setEncoding('binary');
    sock.on('connect', () => {
      const authLine = proxyAuthHeader ? `Proxy-Authorization: ${proxyAuthHeader}\r\n` : '';
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${authLine}\r\n`);
    });
    sock.on('data', (d) => {
      buf += d;
      // CONNECT 成功时代理回 `HTTP/1.1 200 Connection Established` 后即进入隧道，可提前收敛
      if (buf.includes('\r\n\r\n')) finish();
    });
    sock.on('end', finish);
    sock.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    setTimeout(finish, timeoutMs);
  });
}

/** 构造一个只在 127.0.0.1 上监听、auth/admin 配置可控的服务器。 */
async function startProxy({ auth, admin }) {
  const config = mergeConfig(defaultConfig, {});
  config.proxy.httpPort = await freeLoopbackPort();
  config.proxy.httpsPort = 0;
  config.proxy.socksPort = await freeLoopbackPort();
  config.proxy.pacPort = await freeLoopbackPort();
  config.proxy.adminPort = await freeLoopbackPort();
  config.pac.enabled = false;
  config.admin.enabled = admin != null;
  config.auth = auth;
  if (admin != null) config.admin = admin;
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

  let adminPort = null;
  if (admin != null) {
    server.startAdminService();
    await new Promise((resolve, reject) => {
      server.adminServer.once('error', reject);
      if (server.adminServer.listening) return resolve();
      server.adminServer.once('listening', resolve);
    });
    adminPort = server.adminServer.address().port;
  }

  return { server, port: server.httpServer.address().port, adminPort };
}

async function stopProxy(server) {
  if (server.adminServer) await new Promise((resolve) => server.adminServer.close(resolve));
  if (server.httpServer) await new Promise((resolve) => server.httpServer.close(resolve));
  if (server.connectionPool && typeof server.connectionPool.close === 'function') {
    await server.connectionPool.close();
  }
}

/** 对 Express 管理端点发一次请求，返回状态码（同一凭据经 Express basicAuth 面的结论）。 */
function adminGet(adminPort, path, authHeader, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: adminPort, path, method: 'GET', headers: authHeader ? { authorization: authHeader } : {} },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('admin request timeout')); });
    req.end();
  });
}

// Basic 头构造（明文 → base64），使用例意图一眼可读
const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`, 'ascii').toString('base64')}`;

describe('D5-auth-colon · Basic 凭据解析口径统一（回归 + 兄弟面一致性）', () => {
  // ---------------------------------------------------------------- 纯函数层
  describe('parseBasicCredentials() 纯函数口径（唯一真源）', () => {
    it('口令含单个冒号 ⇒ 用户名取首段，其余全部为口令', () => {
      expect(parseBasicCredentials('u:p:q')).to.deep.equal({ username: 'u', password: 'p:q' });
    });

    it('口令含多个冒号 ⇒ 全部归入口令（切分点只在首个冒号）', () => {
      expect(parseBasicCredentials('u:p:q:r:s')).to.deep.equal({ username: 'u', password: 'p:q:r:s' });
    });

    it('口令以冒号开头 / 结尾 ⇒ 冒号保留在口令内（不丢字符）', () => {
      expect(parseBasicCredentials('u::q')).to.deep.equal({ username: 'u', password: ':q' });
      expect(parseBasicCredentials('u:p:')).to.deep.equal({ username: 'u', password: 'p:' });
    });

    it('无冒号 ⇒ 返回 null（不可解析 ⇒ 调用方 fail-closed）', () => {
      expect(parseBasicCredentials('no-colon')).to.equal(null);
      expect(parseBasicCredentials('')).to.equal(null);
    });

    it('无冒号回归：不含冒号的普通凭据解析结果与旧实现（split 两段）一致', () => {
      expect(parseBasicCredentials('u:p')).to.deep.equal({ username: 'u', password: 'p' });
    });
  });

  // ---------------------------------------------------------------- 代理面（validateAuth）
  describe('代理面（validateAuth，含普通请求与 CONNECT）', () => {
    let echo;
    let proxy;

    before(async function () {
      this.timeout(20000);
      echo = await startEchoServer();
    });

    after(async function () {
      this.timeout(10000);
      if (echo && echo.server) await new Promise((resolve) => echo.server.close(resolve));
    });

    describe('配置 u:p:q（口令含冒号）', () => {
      beforeEach(async function () {
        this.timeout(20000);
        proxy = await startProxy({ auth: { enabled: true, username: 'u', password: 'p:q' } });
      });
      afterEach(async function () {
        this.timeout(10000);
        await stopProxy(proxy.server);
        proxy = null;
      });

      it('正确凭据 u:p:q ⇒ 200 且上游实收（核心正例；修复前 407）', async function () {
        this.timeout(10000);
        const hitsBefore = echo.received.length;
        const { statusLine, raw } = await rawProxyGet(
          proxy.port,
          `http://127.0.0.1:${echo.port}/colon-pass`,
          `127.0.0.1:${echo.port}`,
          basic('u', 'p:q')
        );

        // 修复前实测：statusLine === 'HTTP/1.1 407 Proxy Authentication Required'（口令被截断为 'p'）
        expect(statusLine, `含冒号口令的正确凭据被判错：实际状态行=${statusLine}（口令解析应为 'p:q'，长度 3）`).to.equal('HTTP/1.1 200 OK');
        expect(raw, `响应体未包含上游 echo ⇒ 未真实转发（实际=${JSON.stringify(raw.slice(0, 120))}）`).to.include('ECHO_FROM_UPSTREAM /colon-pass');
        expect(echo.received.length).to.equal(hitsBefore + 1);
      });

      it('错误口令（截断前缀 p）⇒ 407 且不得转发', async function () {
        this.timeout(10000);
        const hitsBefore = echo.received.length;
        const { statusLine } = await rawProxyGet(
          proxy.port,
          `http://127.0.0.1:${echo.port}/colon-wrong-prefix`,
          `127.0.0.1:${echo.port}`,
          basic('u', 'p')
        );

        expect(statusLine).to.include('407');
        expect(echo.received.length).to.equal(hitsBefore);
      });

      it('错误口令（多余后缀 p:q:r）⇒ 407 且不得转发', async function () {
        this.timeout(10000);
        const hitsBefore = echo.received.length;
        const { statusLine } = await rawProxyGet(
          proxy.port,
          `http://127.0.0.1:${echo.port}/colon-wrong-suffix`,
          `127.0.0.1:${echo.port}`,
          basic('u', 'p:q:r')
        );

        expect(statusLine).to.include('407');
        expect(echo.received.length).to.equal(hitsBefore);
      });

      it('CONNECT 路径复用同一解析 ⇒ 含冒号口令的正确凭据同样放行', async function () {
        this.timeout(10000);
        const target = `127.0.0.1:${echo.port}`;
        const { statusLine } = await rawProxyConnect(proxy.port, target, basic('u', 'p:q'));

        expect(statusLine, `CONNECT 含冒号口令被拒：实际状态行=${statusLine}（口令解析应为 'p:q'）`).to.equal('HTTP/1.1 200 Connection Established');
      });

      it('CONNECT 路径错误口令 ⇒ 407', async function () {
        this.timeout(10000);
        const target = `127.0.0.1:${echo.port}`;
        const { statusLine } = await rawProxyConnect(proxy.port, target, basic('u', 'p'));

        expect(statusLine).to.include('407');
      });
    });

    describe('无冒号回归：配置 u:p（行为必须与修复前一致）', () => {
      beforeEach(async function () {
        this.timeout(20000);
        proxy = await startProxy({ auth: { enabled: true, username: 'u', password: 'p' } });
      });
      afterEach(async function () {
        this.timeout(10000);
        await stopProxy(proxy.server);
        proxy = null;
      });

      it('正确凭据 ⇒ 200 且上游实收（回归不变）', async function () {
        this.timeout(10000);
        const { statusLine } = await rawProxyGet(
          proxy.port,
          `http://127.0.0.1:${echo.port}/nocolon-ok`,
          `127.0.0.1:${echo.port}`,
          basic('u', 'p')
        );

        expect(statusLine).to.equal('HTTP/1.1 200 OK');
      });

      it('错误口令 ⇒ 407（回归不变）', async function () {
        this.timeout(10000);
        const { statusLine } = await rawProxyGet(
          proxy.port,
          `http://127.0.0.1:${echo.port}/nocolon-bad`,
          `127.0.0.1:${echo.port}`,
          basic('u', 'WRONG')
        );

        expect(statusLine).to.include('407');
      });
    });

    describe('空凭据仍 fail-closed（D1 行为不得被破坏）', () => {
      it('auth.enabled=true + 空用户名/空口令 + Basic Og== ⇒ 407 且不得转发', async function () {
        this.timeout(20000);
        const local = await startProxy({ auth: { enabled: true, username: '', password: '' } });
        try {
          const hitsBefore = echo.received.length;
          const { statusLine } = await rawProxyGet(
            local.port,
            `http://127.0.0.1:${echo.port}/empty-cred-d5`,
            `127.0.0.1:${echo.port}`,
            'Basic Og=='
          );

          expect(statusLine).to.include('407');
          expect(echo.received.length).to.equal(hitsBefore);
        } finally {
          await stopProxy(local.server);
        }
      });

      it('auth.enabled=true + 仅口令为空（u:）+ Basic dTo= ⇒ 407', async function () {
        this.timeout(20000);
        const local = await startProxy({ auth: { enabled: true, username: 'u', password: '' } });
        try {
          const { statusLine } = await rawProxyGet(
            local.port,
            `http://127.0.0.1:${echo.port}/empty-pass-d5`,
            `127.0.0.1:${echo.port}`,
            'Basic dTo='
          );

          expect(statusLine).to.include('407');
        } finally {
          await stopProxy(local.server);
        }
      });

      it('畸形凭据（无冒号，Basic bm9jb2xvbg==）⇒ 407 fail-closed（不抛异常、不放行）', async function () {
        this.timeout(20000);
        const local = await startProxy({ auth: { enabled: true, username: 'u', password: 'p:q' } });
        try {
          const { statusLine } = await rawProxyGet(
            local.port,
            `http://127.0.0.1:${echo.port}/no-colon-cred`,
            `127.0.0.1:${echo.port}`,
            'Basic bm9jb2xvbg==' // base64('nocolon')
          );

          expect(statusLine).to.include('407');
        } finally {
          await stopProxy(local.server);
        }
      });
    });
  });

  // ---------------------------------------------------------------- 一致性与兄弟面
  describe('跨面一致性：代理面（validateAuth）vs Express 管理端点（basicAuth / 管理中间件）', () => {
    let echo;
    before(async function () {
      this.timeout(20000);
      echo = await startEchoServer();
    });
    after(async function () {
      this.timeout(10000);
      if (echo && echo.server) await new Promise((resolve) => echo.server.close(resolve));
    });

    it('配置 u:p:q ⇒ 同一正确凭据两面结论一致（都放行）', async function () {
      this.timeout(20000);
      const local = await startProxy({
        auth: { enabled: true, username: 'u', password: 'p:q' },
        admin: { enabled: true, username: 'u', password: 'p:q' }
      });
      try {
        const proxyResult = await rawProxyGet(
          local.port,
          `http://127.0.0.1:${echo.port}/consistency-probe`,
          `127.0.0.1:${echo.port}`,
          basic('u', 'p:q')
        );
        const adminStatus = await adminGet(local.adminPort, '/api/status', basic('u', 'p:q'));

        expect(proxyResult.statusLine, `代理面未放行：${proxyResult.statusLine}`).to.equal('HTTP/1.1 200 OK');
        expect(adminStatus, '管理端点（/api/* 中间件）未放行含冒号口令').to.equal(200);
      } finally {
        await stopProxy(local.server);
      }
    });

    it('管理端点口令含冒号 + 错误凭据 ⇒ 401（负例，与代理面同结论）', async function () {
      this.timeout(20000);
      const local = await startProxy({
        auth: { enabled: true, username: 'u', password: 'p:q' },
        admin: { enabled: true, username: 'u', password: 'p:q' }
      });
      try {
        const adminStatus = await adminGet(local.adminPort, '/api/status', basic('u', 'p'));
        expect(adminStatus).to.equal(401);
      } finally {
        await stopProxy(local.server);
      }
    });

    it('管理端点无冒号凭据回归 ⇒ 200（行为不变）', async function () {
      this.timeout(20000);
      const local = await startProxy({
        auth: { enabled: true, username: 'u', password: 'p' },
        admin: { enabled: true, username: 'u', password: 'p' }
      });
      try {
        const adminStatus = await adminGet(local.adminPort, '/api/status', basic('u', 'p'));
        expect(adminStatus).to.equal(200);
      } finally {
        await stopProxy(local.server);
      }
    });
  });

  // ---------------------------------------------------------------- Express basicAuth（middleware/auth.mjs）
  describe('Express basicAuth（middleware/auth.mjs）口径与代理面同义', () => {
    it('basicAuth 对含冒号口令的正确凭据放行（既有实现，作为口径基准）', async function () {
      this.timeout(10000);
      const AuthMiddleware = (await import('../middleware/auth.mjs')).default;
      const express = (await import('express')).default;

      const mw = new AuthMiddleware({ auth: { enabled: true, username: 'u', password: 'p:q' } });
      const app = express();
      app.use(mw.basicAuth.bind(mw));
      app.get('/probe', (req, res) => res.status(200).send('OK'));

      const server = app.listen(0, '127.0.0.1');
      await new Promise((resolve) => server.once('listening', resolve));
      const port = server.address().port;
      try {
        const ok = await adminGet(port, '/probe', basic('u', 'p:q'));
        const bad = await adminGet(port, '/probe', basic('u', 'p'));
        expect(ok, 'basicAuth 基准：含冒号口令应放行').to.equal(200);
        expect(bad, 'basicAuth 基准：错误口令应 401').to.equal(401);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });
});
