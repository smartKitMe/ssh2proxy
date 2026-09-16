import { describe, it } from 'mocha';
import { expect } from 'chai';
import { EventEmitter } from 'events';
import Socks5Tunnel from '../core/socks-tunnel.mjs';

/**
 * 本文件**不需要**可用的 SOCKS5 代理服务器：能力用例（connect / forwardOut）通过产品自带的
 * 注入点 `poolConfig.createConnection`（`src/core/socks-tunnel.mjs:128-130`）注入建连桩，
 * 属产品契约内的用法，不改产品代码、不依赖真实上游。
 *
 * 覆盖边界登记：不验证与真实 SOCKS5 服务端的协议握手；协议层与连接池行为由
 * `src/tests/integration/socks5-tunnel.integration.test.mjs` 的真实链路用例覆盖。
 */
class StubSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writable = true;
    this.readable = true;
    this.readyState = 'open';
  }

  destroy() {
    this.destroyed = true;
    this.writable = false;
    this.readable = false;
    this.emit('close');
  }

  end() {
    this.emit('end');
  }
}

/** 构造一个注入建连桩的隧道；返回 {tunnel, factoryCalls} */
function makeTunnel(overrides = {}) {
  const factoryCalls = [];
  const config = {
    host: '127.0.0.1',
    port: 18013,
    retryAttempts: 0,
    retryDelay: 1,
    ...overrides
  };
  const tunnel = new Socks5Tunnel(config, {
    pool: {
      healthCheckInterval: 0,
      cleanupInterval: 100000,
      idleTimeout: 5000,
      connectionTimeout: 500,
      createConnection: async (options) => {
        factoryCalls.push(options);
        return { socket: new StubSocket() };
      }
    }
  });
  return { tunnel, factoryCalls, config };
}

describe('Socks5Tunnel', () => {
  it('should create a Socks5Tunnel instance', () => {
    const config = {
      host: '127.0.0.1',
      port: 1080,
      retryAttempts: 3,
      retryDelay: 1000
    };

    const tunnel = new Socks5Tunnel(config);
    expect(tunnel).to.be.an.instanceOf(Socks5Tunnel);
    expect(tunnel.config).to.equal(config);
    expect(tunnel.retryCount).to.equal(0);
    // A8（D-124）：实现真值是「构造后 isConnected === false」
    // （`socks-tunnel.mjs:829` 构造置 false；`:870` connect() 成功后才置 true；`:945` close() 置回 false），
    // 与 `ssh-tunnel.mjs:16/62/171` 同构 ⇒ 断言 false 与实现一致。
    expect(tunnel.isConnected).to.be.false;
    tunnel.close();
  });

  it('should have the same interface as SSHTunnel', () => {
    const { tunnel } = makeTunnel();

    // 检查是否存在必要的方法
    expect(tunnel).to.respondTo('connect');
    expect(tunnel).to.respondTo('forwardOut');
    expect(tunnel).to.respondTo('close');

    // 检查是否存在必要的属性
    expect(tunnel).to.have.property('isConnected');
    expect(tunnel).to.have.property('retryCount');

    tunnel.close();
  });

  it('should flip isConnected across the connect/close lifecycle', async () => {
    const { tunnel } = makeTunnel();

    // 构造后（未连接）
    expect(tunnel.isConnected).to.be.false;

    // 可失败条件：connect() 不再置位 isConnected（或位点被移到别处）→ 变红。
    await tunnel.connect();
    expect(tunnel.isConnected).to.be.true;

    // 可失败条件：close() 不再复位 isConnected → 变红。
    tunnel.close();
    expect(tunnel.isConnected).to.be.false;
  });

  it('should connect to a SOCKS5 proxy and forward through the pool', async () => {
    const { tunnel, factoryCalls } = makeTunnel();

    try {
      await tunnel.connect();
      expect(tunnel.isConnected).to.be.true;

      // 真实的协议层转发链路：forwardOut → 连接池 getConnection → 注入的建连桩
      const stream = await tunnel.forwardOut('127.0.0.1', 0, '10.0.0.9', 53);

      // 可失败条件：forwardOut 未返回连接池下发的 socket（或链路被短路）→ 变红。
      expect(stream).to.be.an.instanceOf(StubSocket);
      expect(factoryCalls.length).to.equal(1);
      expect(factoryCalls[0].command).to.equal('connect');
      expect(factoryCalls[0].proxy).to.deep.equal({ host: '127.0.0.1', port: 18013, type: 5 });
      expect(factoryCalls[0].destination).to.deep.equal({ host: '10.0.0.9', port: 53 });

      // 连接池记账必须真实发生
      const stats = tunnel.getPoolStats();
      expect(stats.totalConnections).to.equal(1);
      expect(stats.connectionMisses).to.equal(1);
      expect(stats.activeConnections).to.equal(1);

      // 复用语义：同一目标再取一次应命中空闲池，不再建连
      // （先释放，使连接回到空闲池）
      tunnel.connectionPool.releaseConnection(stream, '10.0.0.9', 53);
      const again = await tunnel.forwardOut('127.0.0.1', 0, '10.0.0.9', 53);
      expect(again).to.equal(stream);
      expect(factoryCalls.length).to.equal(1);
      expect(tunnel.getPoolStats().connectionHits).to.equal(1);
    } finally {
      tunnel.close();
    }
  });

  it('should reject forwardOut when the tunnel is not configured', async () => {
    const tunnel = new Socks5Tunnel({});
    // 错误事件必须有消费者（产品 emit('error')），否则 EventEmitter 会抛出
    tunnel.on('error', () => {});

    let code = null;
    try {
      await tunnel.forwardOut('127.0.0.1', 0, '10.0.0.9', 53);
    } catch (err) {
      code = err.code;
    }

    // 可失败条件：未配置校验被移除 → 不再抛错。
    expect(code).to.equal('SOCKS5_NOT_CONFIGURED');
    tunnel.close();
  });

  it('should reject with POOL_CLOSED after close', async () => {
    const { tunnel } = makeTunnel();
    await tunnel.connect();
    tunnel.on('error', () => {});
    tunnel.close();

    let code = null;
    try {
      await tunnel.forwardOut('127.0.0.1', 0, '10.0.0.9', 53);
    } catch (err) {
      code = err.code;
    }

    // 可失败条件：关闭后仍可建连（池复活）→ 不抛错。
    expect(code).to.equal('POOL_CLOSED');
  });
});
