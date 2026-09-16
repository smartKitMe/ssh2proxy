import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { EventEmitter } from 'events';
import LoadBalancedConnectionPool from '../core/load-balanced-connection-pool.mjs';
import defaultConfig from '../config/default.config.mjs';

/**
 * 可观测的桩隧道。
 *
 * 之所以必须桩化：真实 `SSHTunnel.connect()` 需要一个可用的 SSH 服务端，
 * 而仓库根目录的 `mock-ssh-server.mjs` 实测无法完成 ssh2 握手（D-135，见
 * `handoff/known_issues.md` 的负向对照证据），因此单元测试以桩隧道注入。
 *
 * 桩隧道是真实 `EventEmitter`，`close()` 会真实 `emit('close')` —— 这样产品侧
 * `wireTunnelEvents()` 注册的 close/end 消费者链路在测试中被真实触发，
 * 而不是被绕过。`createTunnel()` 覆写只做「建连」，**绝不自造池状态**
 * （产品代码没有 `tunnelUsageMap`，测试也不得凭空引用）。
 */
class StubTunnel extends EventEmitter {
  constructor() {
    super();
    this.isConnected = false;
    this.closeCount = 0;
    this.forwardOutCalls = [];
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
    this.forwardOutCalls.push([srcIP, srcPort, dstIP, dstPort]);
    return Promise.resolve({ stub: true, dstIP, dstPort });
  }
}

/**
 * 仅覆写建连的测试池：隧道对象形状严格复刻产品 `createTunnel()` 的返回契约
 * （`{tunnel, connectionCount, lastUsed, isActive}`），并复用产品的
 * `wireTunnelEvents()` / `stats.createdTunnels` 记账，不自造平行状态。
 */
class TestLoadBalancedConnectionPool extends LoadBalancedConnectionPool {
  constructor(config) {
    super(config);
    this.createdTunnels = [];
  }

  async createTunnel() {
    const tunnel = new StubTunnel();
    this.wireTunnelEvents(tunnel);
    await tunnel.connect();

    this.createdTunnels.push(tunnel);
    this.stats.createdTunnels++;

    return {
      tunnel,
      connectionCount: 0,
      lastUsed: Date.now(),
      isActive: true
    };
  }
}

describe('LoadBalancedConnectionPool', () => {
  let pool;
  let config;

  beforeEach(() => {
    config = JSON.parse(JSON.stringify(defaultConfig));
    config.connectionPool.minSize = 2;
    config.connectionPool.maxSize = 5;
    config.connectionPool.maxConnectionsPerTunnel = 3;

    pool = new TestLoadBalancedConnectionPool(config);
  });

  afterEach(async () => {
    if (pool) {
      await pool.close();
    }
  });

  describe('Initialization', () => {
    it('should initialize with correct configuration', () => {
      expect(pool.config).to.equal(config);
      expect(pool.maxSize).to.equal(config.connectionPool.maxSize);
      expect(pool.minSize).to.equal(config.connectionPool.minSize);
      expect(pool.maxConnectionsPerTunnel).to.equal(config.connectionPool.maxConnectionsPerTunnel);
    });

    it('should create minimum number of tunnels during initialization', async () => {
      await pool.initialize();
      const status = pool.getStatus();

      // 可失败条件：任一隧道建连失败 → total/available 小于 minSize（历史实现因 createTunnel 抛错、
      // initialize() 内 catch 吞掉，此处恒为 0）。
      expect(status.total).to.equal(config.connectionPool.minSize);
      expect(status.available).to.equal(config.connectionPool.minSize);
      expect(status.used).to.equal(0);
      expect(status.usedDetails).to.deep.equal([]);
    });
  });

  describe('Tunnel Acquisition', () => {
    beforeEach(async () => {
      await pool.initialize();
    });

    it('should acquire tunnel from pool', async () => {
      const tunnel = await pool.acquire();
      const status = pool.getStatus();

      // 可失败条件：acquire 返回非本池隧道对象 → instanceOf 失败。
      expect(tunnel).to.be.instanceOf(StubTunnel);
      // 负载均衡池允许同一隧道被多次使用 ⇒ 总数不变，但被占用数必须为 1。
      // 可失败条件：acquire 未记账（used 仍为 0）或误增隧道（total 变化）。
      expect(status.total).to.equal(config.connectionPool.minSize);
      expect(status.used).to.equal(1);
      expect(status.available).to.equal(config.connectionPool.minSize - 1);
      expect(status.usedDetails).to.deep.equal([{ connectionCount: 1 }]);
    });

    it('should use least connections strategy', async () => {
      const first = await pool.acquire();
      const second = await pool.acquire();
      // 两个隧道各 1 条连接；第三个连接必须落在「连接数最低且最早使用」者上。
      const third = await pool.acquire();

      // 可失败条件：策略退化为「总取同一个隧道」→ 连接数分布变 [3,0] 而非 [2,1]。
      expect(third).to.equal(first);
      expect(third).to.not.equal(second);

      const counts = pool.getStatus().usedDetails.map(d => d.connectionCount).sort();
      expect(counts).to.deep.equal([1, 2]);

      // 再取一个连接应落在连接数最低的 second 上
      const fourth = await pool.acquire();
      expect(fourth).to.equal(second);
      const counts2 = pool.getStatus().usedDetails.map(d => d.connectionCount).sort();
      expect(counts2).to.deep.equal([2, 2]);
    });

    it('should create new tunnel when threshold is reached', async () => {
      const initialTotal = pool.getStatus().total;

      // 单个隧道阈值 = maxConnectionsPerTunnel(3)；取满两轮后应触发自动扩容。
      const tunnels = [];
      for (let i = 0; i < config.connectionPool.maxConnectionsPerTunnel * initialTotal; i++) {
        tunnels.push(await pool.acquire());
      }
      // 扩容走 setImmediate 回调，等待其落地
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));

      const status = pool.getStatus();

      // 可失败条件：扩容未触发 → expansions 仍为 0、total 仍等于初始值。
      // 注意此处用严格大于（历史用例用 gte(initialTotal)，在只增设计下恒真、零检验力）。
      expect(status.stats.expansions).to.be.greaterThan(0);
      expect(status.total).to.be.greaterThan(initialTotal);
      expect(status.total).to.be.at.most(config.connectionPool.maxSize);

      // 扩容出的隧道必须可被后续 acquire 使用
      expect(pool.createdTunnels.length).to.be.greaterThan(initialTotal);
    });

    it('should respect maximum tunnel limit', async () => {
      // 该池 maxSize=5、每隧道 3 连接 ⇒ 满 15 条连接后达上限，后续 acquire 必须显式拒绝，
      // 而不是静默悬挂或无限扩容。历史用例用一个空 catch 吞掉异常再断言 lessThanOrEqual，
      // 属「通过不蕴含行为正确」，此处改为断言可识别的拒绝错误码。
      pool.acquireTimeout = 200;
      const acquired = [];
      let rejection = null;

      try {
        for (let i = 0; i < config.connectionPool.maxSize * config.connectionPool.maxConnectionsPerTunnel + 5; i++) {
          acquired.push(await pool.acquire());
        }
      } catch (err) {
        rejection = err;
      }

      // 可失败条件：达上限后仍继续扩容 → 不抛错（rejection 为 null）且 total 超过 maxSize。
      expect(rejection).to.be.instanceOf(Error);
      expect(rejection.code).to.equal('POOL_AT_CAPACITY');

      const status = pool.getStatus();
      expect(status.total).to.be.at.most(config.connectionPool.maxSize);
      expect(status.total).to.equal(config.connectionPool.maxSize);
      expect(status.stats.rejectedAcquires).to.be.greaterThan(0);
      // 溢出部分确实未被发放
      expect(acquired.length).to.equal(config.connectionPool.maxSize * config.connectionPool.maxConnectionsPerTunnel);
    });
  });

  describe('Tunnel Release', () => {
    beforeEach(async () => {
      await pool.initialize();
    });

    it('should release tunnel back to pool', async () => {
      const tunnel = await pool.acquire();
      await pool.acquire();
      const before = pool.getStatus();

      pool.release(tunnel);
      const after = pool.getStatus();

      // 可失败条件：release 未真正减记账 → used 不变；或误把隧道移出池 → total 减少。
      expect(after.used).to.equal(before.used - 1);
      expect(after.total).to.equal(before.total);
      expect(after.stats.releases).to.equal(1);
      expect(after.usedDetails.map(d => d.connectionCount).sort()).to.deep.equal([1]);
    });

    it('should handle releasing non-existent tunnel gracefully', () => {
      const stranger = new StubTunnel();
      const before = pool.getStatus();

      // 可失败条件：release 对外来隧道抛错 → not.throw 失败。
      expect(() => pool.release(stranger)).to.not.throw();

      // 更强的判据：不仅「不抛错」，还不得产生任何副作用（历史用例只断言 not.throw）。
      // 可失败条件：外来隧道被错误计入 releases 或改变了池规模。
      const after = pool.getStatus();
      expect(after.total).to.equal(before.total);
      expect(after.used).to.equal(before.used);
      expect(after.stats.releases).to.equal(0);
      expect(stranger.closeCount).to.equal(0);
    });
  });

  describe('Pool Status', () => {
    beforeEach(async () => {
      await pool.initialize();
    });

    it('should return correct status information', async () => {
      const status = pool.getStatus();

      // 冻结契约：{available, used, total, usedDetails} 键必须在（C2 契约冻结，测试不得迁就别名）。
      // 可失败条件：产品删除/改名任一冻结键。
      expect(status).to.have.property('available');
      expect(status).to.have.property('used');
      expect(status).to.have.property('total');
      expect(status).to.have.property('usedDetails');
      expect(status).to.have.property('maxSize');
      expect(status).to.have.property('minSize');
      expect(status).to.have.property('maxConnectionsPerTunnel');
      expect(status).to.have.property('loadBalancingStrategy');

      // 取值断言（存在性断言不构成检验力）：可失败条件为任一等式右侧被改错。
      expect(status.total).to.equal(status.available + status.used);
      expect(status.total).to.equal(config.connectionPool.minSize);
      expect(status.available).to.equal(config.connectionPool.minSize);
      expect(status.used).to.equal(0);
      expect(status.maxSize).to.equal(config.connectionPool.maxSize);
      expect(status.minSize).to.equal(config.connectionPool.minSize);
      expect(status.maxConnectionsPerTunnel).to.equal(config.connectionPool.maxConnectionsPerTunnel);
      expect(status.loadBalancingStrategy).to.equal('least-connections');
      expect(status.closed).to.equal(false);

      // 占用后 usedDetails 必须如实反映每条隧道的连接数
      const tunnel = await pool.acquire();
      expect(tunnel).to.be.instanceOf(StubTunnel);
      const used = pool.getStatus();
      expect(used.used).to.equal(1);
      expect(used.usedDetails).to.deep.equal([{ connectionCount: 1 }]);
    });
  });

  describe('Tunnel Lifecycle', () => {
    it('should close all tunnels when pool is closed', async () => {
      await pool.initialize();
      await pool.acquire();
      await pool.acquire();

      const liveTunnels = pool.createdTunnels.slice();
      expect(liveTunnels.length).to.be.greaterThan(0);

      await pool.close();

      // 可失败条件：close() 未清空池 → total 非 0；或未真正关闭底层隧道 → closeCount 为 0。
      expect(pool.getStatus().total).to.equal(0);
      expect(pool.getStatus().available).to.equal(0);
      expect(pool.getStatus().used).to.equal(0);
      expect(pool.getStatus().usedDetails).to.deep.equal([]);
      expect(pool.getStatus().closed).to.equal(true);
      expect(liveTunnels.every(t => t.closeCount >= 1)).to.equal(true);
      expect(liveTunnels.every(t => t.isConnected === false)).to.equal(true);
    });

    it('should cleanup idle tunnels', async () => {
      await pool.initialize();
      const before = pool.getStatus();
      expect(before.total).to.equal(config.connectionPool.minSize);

      // 空闲判据取 lastUsed（C2-05）；把阈值压到 0 保证全部超过阈值。
      pool.idleTimeout = 0;
      await new Promise(resolve => setTimeout(resolve, 5));

      const liveTunnels = pool.createdTunnels.slice();
      const reaped = pool.cleanupIdleTunnels();
      const after = pool.getStatus();

      // 可失败条件：cleanupIdleTunnels 未回收 → reaped 为 0、total 不变（历史用例零断言）。
      expect(reaped).to.equal(config.connectionPool.minSize);
      expect(after.total).to.equal(before.total - reaped);
      expect(after.total).to.equal(0);
      expect(after.stats.idleReaped).to.equal(reaped);
      expect(liveTunnels.every(t => t.closeCount >= 1)).to.equal(true);
    });

    it('should not cleanup tunnels that are still in use', async () => {
      await pool.initialize();
      // 让两条隧道都进入「使用中」（connectionCount > 0），并刷新 lastUsed。
      await pool.acquire();
      await pool.acquire();

      pool.idleTimeout = 0;
      await new Promise(resolve => setTimeout(resolve, 5));

      const inUse = pool.createdTunnels.slice();
      const reaped = pool.cleanupIdleTunnels();

      // 负向对照：cleanupIdleTunnels 的判据是「空闲」= 在 pool 数组中，
      // 在用隧道在 usedTunnels 中 ⇒ 不得被回收。可失败条件：实现误杀在用隧道。
      expect(reaped).to.equal(0);
      expect(pool.getStatus().total).to.equal(config.connectionPool.minSize);
      expect(inUse.every(t => t.closeCount === 0)).to.equal(true);
    });
  });
});
