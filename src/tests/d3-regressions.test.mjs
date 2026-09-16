/**
 * d3-regressions.test.mjs —— D3-runtime 六项修复的回归断言（可被 `npm test` 收集）
 *
 * 覆盖：
 *  ① PAC 端口单一来源（H1-S2-02 / H3-S304）：worker 侧无 1080 兜底、payload 缺配置即拒绝
 *  ② 全 dead worker → 主线程降级（H3-S303）：不再入队悬挂
 *  ③ ACQUIRE_TIMEOUT 孤儿隧道被回收（H3-S301）＋守恒式成立
 *  ④ 维护路径经公开 API 入池、关闭态不复活（H3-S302）
 *  ⑤ stopMaintenance 停止定时器且幂等（RT-02/X5）
 *  ⑥ loadBalancingStrategy 真实参与选路（H7-S307）
 */
import { describe, it } from 'mocha';
import { expect } from 'chai';
import fs from 'fs';
import path from 'path';
import LoadBalancedConnectionPool from '../core/load-balanced-connection-pool.mjs';
import ConnectionInitializer from '../core/connection-initializer.mjs';
import PacService from '../core/pac-service.mjs';
import WorkerManager, { taskHandlers } from '../core/worker-manager.mjs';
import ProxyServer from '../app.mjs';
import defaultConfig from '../config/default.config.mjs';

/** 极简 EventEmitter（stub 隧道的事件接线只需 on/emit） */
class EventEmitterShim {
  constructor() { this.handlers = new Map(); }
  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(handler);
  }
  emit(event, payload) {
    for (const handler of this.handlers.get(event) || []) handler(payload);
  }
}

/**
 * 构造一个可用池：`createTunnel()` 被 stub 覆盖（不建真连接），
 * 覆盖方式与被测类的真实契约一致（返回 `{tunnel, connectionCount, lastUsed, isActive}` 并计 createdTunnels）。
 */
function makePool(overrides = {}) {
  const config = {
    connectionPool: {
      maxSize: 10,
      minSize: 0,
      acquireTimeout: 1000,
      idleTimeout: 60000,
      maxConnectionsPerTunnel: 2,
      loadBalancingStrategy: 'least-connections',
      ...(overrides.connectionPool || {}),
    },
    tunnel: { type: 'ssh' },
    ssh: {},
  };
  const pool = new LoadBalancedConnectionPool(config);
  pool.createTunnel = async function createStubTunnel() {
    if (overrides.connectDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, overrides.connectDelayMs));
    }
    const events = new EventEmitterShim();
    const tunnel = {
      kind: 'stub',
      closed: false,
      isConnected: true,
      on: (event, handler) => events.on(event, handler),
      emit: (event, payload) => events.emit(event, payload),
      forwardOut: async () => { throw new Error('not used in these tests'); },
      close() { this.closed = true; this.isConnected = false; events.emit('close'); },
    };
    this.stats.createdTunnels += 1;
    return { tunnel, connectionCount: 0, lastUsed: Date.now(), isActive: true };
  };
  return pool;
}

/** 过滤出「可执行代码行」（排除纯注释行），用于源码级反向断言 */
function codeLinesOf(relativeUrl) {
  const source = fs.readFileSync(new URL(relativeUrl, import.meta.url), 'utf8');
  return source.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
  });
}

describe('D3-runtime regressions', () => {
  describe('① PAC 端口单一来源 (H1-S2-02 / H3-S304)', () => {
    it('pac-service 的代理串取自 config.proxy.socksPort（单一来源）', () => {
      const service = new PacService({ proxy: { socksPort: 1999, httpPort: 8080 }, pac: {} });
      expect(service.generateDefaultProxyString()).to.equal('SOCKS5 127.0.0.1:1999; SOCKS 127.0.0.1:1999; DIRECT');
    });

    it('pac.defaultProxy 模板中的历史端口被归一化到 socksPort', () => {
      const service = new PacService({
        proxy: { socksPort: 1090 },
        pac: { defaultProxy: 'SOCKS5 127.0.0.1:1080; SOCKS 127.0.0.1:1080; DIRECT' },
      });
      const proxy = service.generateDefaultProxyString();
      expect(proxy).to.contain('127.0.0.1:1090');
      expect(proxy).to.not.contain('1080');
    });

    it('resolvePacRender：默认面返回归一化模板，未命中名返回 null（不冒充默认内容）', async () => {
      const service = new PacService({ proxy: { socksPort: 1090, httpPort: 8080 }, pac: { files: {} } });
      const dflt = await service.resolvePacRender(null);
      expect(dflt.kind).to.equal('template');
      expect(dflt.proxy).to.contain('127.0.0.1:1090');
      expect(await service.resolvePacRender('does-not-exist')).to.equal(null);
    });

    it('renderPac：无 content/raw/renderProxy 时抛错（worker 不再回落 1080）', async () => {
      let thrown = null;
      try {
        await taskHandlers.renderPac({ name: null });
      } catch (err) {
        thrown = err;
      }
      expect(thrown, '缺配置时必须抛错而不是拿默认端口渲染').to.be.an('error');
      expect(thrown.message).to.contain('renderProxy');
    });

    it('renderPac：缺配置时 MUST NOT 产出 1080（旧实现的硬编码回落本体）', async () => {
      let text = null;
      try {
        text = await taskHandlers.renderPac({ name: null });
      } catch (err) {
        text = null;
      }
      expect(text, '缺配置时不得产出任何 PAC 文本（更不得指向未监听的 1080）').to.equal(null);
    });

    it('renderPac：renderProxy 原样进入模板（端口跟随传入配置）', async () => {
      const text = await taskHandlers.renderPac({ name: null, renderProxy: 'SOCKS5 127.0.0.1:1999; SOCKS 127.0.0.1:1999; DIRECT' });
      expect(text).to.contain('FindProxyForURL');
      expect(text).to.contain('127.0.0.1:1999');
      expect(text).to.not.contain('1080');
    });

    it('worker-manager 源码内不再有可执行的 1080 兜底字面量', () => {
      const offenders = codeLinesOf('../core/worker-manager.mjs').filter((line) => line.includes('1080'));
      expect(offenders, `仍存在硬编码 1080 的代码行: ${JSON.stringify(offenders)}`).to.have.length(0);
    });
  });

  describe('② 全 dead worker → 主线程降级 (H3-S303)', () => {
    it('没有存活 worker 时任务在主线程执行并 settle（不再悬挂入队）', async () => {
      const manager = new WorkerManager({ size: 2, workerPath: new URL('../core/worker-manager.mjs', import.meta.url) });
      manager.isSupported = true;
      manager.workers = [null, null];
      manager.workerStates.set(0, 'dead');
      manager.workerStates.set(1, 'dead');
      manager.inflight.set(0, []);
      manager.inflight.set(1, []);

      const settled = await Promise.race([
        manager.assignTask({ type: 'probe', payload: { value: 4 } }).then((value) => ({ value })),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 1200)),
      ]);

      expect(settled.timeout, `任务悬挂了: ${JSON.stringify(settled)}`).to.equal(undefined);
      expect(settled.value.value).to.equal(9);
      const stats = manager.getStats();
      expect(stats.mainThreadTasks).to.equal(1);
      expect(stats.queued).to.equal(0);
    });
  });

  describe('③ ACQUIRE_TIMEOUT 孤儿隧道被回收 (H3-S301)', () => {
    it('超时后建成的隧道被销毁，守恒式 created = total + closingDiscarded + orphanDiscarded 成立', async () => {
      const pool = makePool({ connectDelayMs: 150, connectionPool: { acquireTimeout: 60, maxSize: 10 } });
      const created = [];
      const original = pool.createTunnel.bind(pool);
      pool.createTunnel = async function wrapped() {
        const tunnelObject = await original();
        created.push(tunnelObject);
        return tunnelObject;
      };

      let code = null;
      try {
        await pool.acquire();
      } catch (err) {
        code = err.code;
      }
      expect(code).to.equal('ACQUIRE_TIMEOUT');

      // 等待「稍后建成」的隧道被回收
      await new Promise((resolve) => setTimeout(resolve, 300));

      const stats = pool.getStatus().stats;
      expect(created.length, '应有一次建连被发起').to.equal(1);
      expect(stats.orphanDiscarded, '超时孤儿必须被回收').to.equal(1);
      expect(created[0].tunnel.closed, '孤儿隧道 MUST 被 close()').to.equal(true);
      expect(stats.createdTunnels - stats.closingDiscarded - stats.orphanDiscarded).to.equal(pool.total());
      expect(pool.total()).to.equal(0);
    });
  });

  describe('④ 维护路径经公开 API 入池，关闭态不复活 (H3-S302)', () => {
    it('attach() 本身在池关闭后拒绝入池并销毁隧道（所有入池路径的汇聚点）', async () => {
      const pool = makePool();
      const tunnelObject = {
        tunnel: { closed: false, close() { this.closed = true; } },
        connectionCount: 0,
        lastUsed: Date.now(),
        isActive: true,
      };
      await pool.close();
      const attached = pool.attach(tunnelObject);
      expect(attached, 'attach() 在关闭态 MUST 返回 null').to.equal(null);
      expect(tunnelObject.tunnel.closed, '被拒绝的隧道 MUST 被关闭').to.equal(true);
      expect(pool.getStatus().total, '关闭后的池不得被 attach 复活').to.equal(0);
      expect(pool.getStatus().stats.closingDiscarded).to.be.greaterThan(0);
    });

    it('registerTunnel 在池关闭后拒绝并入池（隧道被关闭）', async () => {
      const pool = makePool();
      await pool.close();
      const handle = {
        closed: false,
        on() {},
        async connect() {},
        close() { this.closed = true; },
      };
      const registered = pool.registerTunnel(handle);
      expect(registered).to.equal(null);
      expect(handle.closed, '被拒绝的隧道 MUST 被关闭，不得遗留句柄').to.equal(true);
      expect(pool.getStatus().total, '关闭后的池不得被复活').to.equal(0);
    });

    it('maintainConnectionPool 不再直写 pool.pool（源码层面无绕过路径）', () => {
      const offenders = codeLinesOf('../core/connection-initializer.mjs')
        .filter((line) => /connectionPool\.pool\s*\.\s*push|\.pool\.push\(/.test(line));
      expect(offenders, `仍存在直写池内部的代码行: ${JSON.stringify(offenders)}`).to.have.length(0);
    });

    it('池关闭后维护路径中止补建（created=0 且池仍为空）', async () => {
      const pool = makePool();
      const initializer = new ConnectionInitializer(pool, { connectionPool: { minSize: 2 } });
      await pool.close();
      const result = await initializer.maintainConnectionPool();
      expect(result.created).to.equal(0);
      expect(pool.getStatus().total).to.equal(0);
      expect(pool.getStatus().closed).to.equal(true);
    });

    it('关闭态下维护补建不得创建隧道（维护路径的关闭态守护）', async () => {
      const pool = makePool();
      const initializer = new ConnectionInitializer(pool, { connectionPool: { minSize: 2 } });
      let createCalls = 0;
      initializer.createTunnelInstance = function tracked() {
        createCalls += 1;
        // 动态窗口：建连期间池被 close()（RT-02 描述的真实可达路径：
        // start() 启动维护定时器 → refill 建连在途 → stop()/pool.close()）
        return {
          on() {},
          async connect() { await pool.close(); },
          close() { this.closed = true; },
        };
      };

      const result = await initializer.maintainConnectionPool();

      expect(createCalls, '前置：维护补建确实尝试过建连（否则该对照无检验力）').to.equal(1);
      expect(result.created, '建连期间池被关闭 → 不得计入 created').to.equal(0);
      expect(pool.getStatus().total, '关闭期间建成的隧道 MUST NOT 注入已关闭的池（池不得被复活）').to.equal(0);
      expect(pool.getStatus().closed).to.equal(true);
    });
  });

  describe('⑤ stopMaintenance 停止定时器且幂等 (RT-02/X5)', () => {
    it('startMaintenance 建立的定时器被 stopMaintenance 全部清空，且重复调用安全', () => {
      const initializer = new ConnectionInitializer({ getStatus: () => ({ total: 0 }) }, { connectionPool: { minSize: 0 } });
      const timers = initializer.startMaintenance();
      expect(timers.length).to.equal(2);
      // 维护定时器不得单独拖住进程退出（A16）
      for (const timer of timers) {
        expect(timer.hasRef(), 'timer 应已 unref').to.equal(false);
      }
      initializer.stopMaintenance();
      expect(initializer.maintenanceTimers).to.have.length(0);
      expect(() => initializer.stopMaintenance()).to.not.throw();
    });

    it('ProxyServer.stop() 真的停止维护定时器（RT-02：生产可达性前提）', async () => {
      const server = new ProxyServer({
        ...defaultConfig,
        testingMode: true,
        proxy: { ...defaultConfig.proxy, host: '127.0.0.1', httpPort: 18300, socksPort: 18301, pacPort: 18302, adminPort: 0, httpsPort: 0 },
        pac: { ...defaultConfig.pac, enabled: false },
        admin: { ...defaultConfig.admin, enabled: false },
        auth: { ...defaultConfig.auth, enabled: false },
      });
      // 注入可观测的初始化器（testingMode 下构造函数不建真池），并先启动维护定时器
      const initializer = new ConnectionInitializer({ getStatus: () => ({ total: 0 }), close: async () => {} }, { connectionPool: { minSize: 0 } });
      server.connectionInitializer = initializer;
      initializer.startMaintenance();
      expect(initializer.maintenanceTimers.length, '前置：维护定时器已启动').to.equal(2);

      await server.stop();

      expect(initializer.maintenanceTimers.length, 'stop() 后维护定时器 MUST 清空').to.equal(0);
      // 幂等：重复 stop() 不抛错
      await server.stop();
      expect(initializer.maintenanceTimers.length).to.equal(0);
    });
  });

  describe('⑥ loadBalancingStrategy 真实参与选路 (H7-S307)', () => {
    it('round-robin 按游标轮转：连续 4 次选择必须严格交替（旧实现恒取同一条 ⇒ A,A,A,A）', async () => {
      const pool = makePool({ connectionPool: { maxConnectionsPerTunnel: 5, loadBalancingStrategy: 'round-robin' } });
      const a = await pool.createTunnel();
      const b = await pool.createTunnel();
      pool.attach(a);
      pool.attach(b);
      const picks = [
        pool.selectLeastLoadedTunnel(),
        pool.selectLeastLoadedTunnel(),
        pool.selectLeastLoadedTunnel(),
        pool.selectLeastLoadedTunnel(),
      ];
      expect(picks[0], '第一次应命中第一条').to.equal(a);
      expect(picks[1], '第二次必须轮转到另一条（旧实现会再次命中第一条）').to.equal(b);
      expect(picks[2], '第三次回到第一条').to.equal(a);
      expect(picks[3]).to.equal(b);
      expect(new Set(picks).size, '4 次选择必须覆盖两条隧道').to.equal(2);
    });

    it('round-robin 下 3 次 acquire 覆盖 2 条隧道（连接计数均 > 0）', async () => {
      const pool = makePool({ connectionPool: { maxConnectionsPerTunnel: 5, loadBalancingStrategy: 'round-robin' } });
      const a = await pool.createTunnel();
      const b = await pool.createTunnel();
      pool.attach(a);
      pool.attach(b);
      await pool.acquire();
      await pool.acquire();
      await pool.acquire();
      expect(a.connectionCount).to.be.greaterThan(0);
      expect(b.connectionCount).to.be.greaterThan(0);
    });

    it('未识别策略回落 least-connections（不抛错、行为与默认一致）', async () => {
      const pool = makePool({ connectionPool: { maxConnectionsPerTunnel: 5, loadBalancingStrategy: 'magic' } });
      const first = await pool.createTunnel();
      first.connectionCount = 0;
      pool.attach(first);
      const second = await pool.createTunnel();
      second.connectionCount = 3;
      pool.attach(second);
      expect(pool.selectLeastLoadedTunnel(), 'least-connections 应挑连接数最少者').to.equal(first);
    });
  });
});
