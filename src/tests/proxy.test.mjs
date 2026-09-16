import { describe, it } from 'mocha';
import { expect } from 'chai';
import ProxyServer from '../app.mjs';
import defaultConfig from '../config/default.config.mjs';
import { mergeConfig, validateConfig } from '../utils/helpers.mjs';
import { applyCliOptions, validateStartupConfig } from '../cli/cli.mjs';

describe('SSH2Proxy', () => {
  describe('ProxyServer', () => {
    it('should be able to create a ProxyServer instance', () => {
      const server = new ProxyServer(defaultConfig);
      expect(server).to.be.an.instanceOf(ProxyServer);
      // 真实消费者判据（不止「构造器身份」）：构造必须装配出 express 应用与配置。
      // 注意 express app 本身是函数（带路由方法），不能用 `to.be.an('object')` 断言。
      expect(typeof server.app).to.equal('function');
      expect(typeof server.app.use).to.equal('function');
      expect(server.config).to.equal(defaultConfig);
    });

    it('should expose start and stop as callable methods', () => {
      const server = new ProxyServer(defaultConfig);
      // 可失败条件：方法被删除或改名 → 断言变红。
      expect(typeof server.start).to.equal('function');
      expect(typeof server.stop).to.equal('function');
      expect(server.connectionPool).to.not.equal(undefined);
    });
  });

  describe('Configuration', () => {
    it('should have default configuration', () => {
      // 逐键取值断言（纯类型断言不构成检验力，故不断言 `to.be.an('object')`）。
      // 可失败条件：默认配置缺失/改名任一被断言的结构。
      expect(defaultConfig.ssh).to.be.an('object');
      expect(defaultConfig.proxy).to.be.an('object');
      expect(defaultConfig.pac).to.be.an('object');
      expect(typeof defaultConfig.ssh.host).to.equal('string');
      expect(typeof defaultConfig.proxy.httpPort).to.equal('number');
      expect(defaultConfig.pac.enabled).to.be.a('boolean');
    });

    it('should have valid proxy ports', () => {
      // 取值域断言（而非 `to.be.a('number')` 纯类型）：端口必须落在合法区间。
      // 可失败条件：默认端口被改成 0、负数或 >65535。
      for (const key of ['httpPort', 'socksPort', 'pacPort', 'adminPort']) {
        const value = defaultConfig.proxy[key];
        expect(Number.isInteger(value), `${key} should be an integer`).to.equal(true);
        expect(value, `${key} should be > 0`).to.be.greaterThan(0);
        expect(value, `${key} should be <= 65535`).to.be.at.most(65535);
      }
    });

    it('should merge configurations correctly', () => {
      const userConfig = {
        ssh: {
          host: 'test-server.com',
          port: 2222
        },
        proxy: {
          httpPort: 9090
        }
      };

      const merged = mergeConfig(defaultConfig, userConfig);

      // 应该保留默认值
      expect(merged.ssh.username).to.equal(defaultConfig.ssh.username);

      // 应该使用用户配置的值
      expect(merged.ssh.host).to.equal('test-server.com');
      expect(merged.ssh.port).to.equal(2222);
      expect(merged.proxy.httpPort).to.equal(9090);

      // 不得就地污染默认配置（可失败条件：mergeConfig 退化为浅合并/Object.assign）
      expect(defaultConfig.ssh.host).to.not.equal('test-server.com');
      expect(defaultConfig.proxy.httpPort).to.not.equal(9090);
    });

    it('should report port violations from validateConfig', () => {
      const config = JSON.parse(JSON.stringify(defaultConfig));
      config.proxy.httpPort = 0;
      config.proxy.socksPort = 70000;

      const errors = validateConfig(config);

      // 可失败条件：validateConfig 不再校验端口 → errors 为空。
      expect(errors).to.include('Invalid HTTP port');
      expect(errors).to.include('Invalid SOCKS port');
    });
  });

  /**
   * A5（D-125/D-028）：原用例在测试文件内**内联重写**了一个 `readPrivateKeyFile` 副本并自测该副本，
   * 与 `src/cli/cli.mjs:54` 的产品实现语义相反（产品失败时 `process.exit(1)`，副本 `throw`）。
   *
   * 处置：走 brief A5 的「删除 + 登记替代覆盖」分支 —— 产品实现是 CLI 模块内**未导出**的私有函数
   * （`grep` 实测：`:54` 定义 / `:242` 调用 / 无 `export`），测试无法 import 真实实现；
   * 且其进程退出语义不可在进程内安全断言。
   *
   * 替代覆盖：改为断言**导出的真实 CLI 映射实现** `applyCliOptions` / `validateStartupConfig` 的行为，
   * 即私钥能力在配置链路上的真实入口。权威登记见 handoff/known_issues.md（含 CC-4 → C4）。
   */
  describe('CLI option mapping', () => {
    it('should apply CLI options onto the configuration', () => {
      const config = JSON.parse(JSON.stringify(defaultConfig));

      applyCliOptions(config, {
        sshHost: 'cli-host.example',
        sshPort: '2222',
        port: '18080',
        poolMaxSize: '7'
      });

      // 可失败条件：任一选项不再映射到配置键（「幽灵选项」回归）。
      expect(config.ssh.host).to.equal('cli-host.example');
      expect(config.ssh.port).to.equal(2222);
      expect(config.proxy.httpPort).to.equal(18080);
      expect(config.connectionPool.maxSize).to.equal(7);
    });

    it('should reject out-of-range ports from CLI options', () => {
      const config = JSON.parse(JSON.stringify(defaultConfig));

      // 可失败条件：端口边界校验被移除 → 不再抛错。
      expect(() => applyCliOptions(config, { port: '70000' })).to.throw(/Invalid value for --port/);
      expect(() => applyCliOptions(config, { port: '-1' })).to.throw(/Invalid value for --port/);
    });

    it('should treat port violations as fatal but credentials as warnings', () => {
      const bad = JSON.parse(JSON.stringify(defaultConfig));
      bad.proxy.httpPort = 0;
      // 可失败条件：端口非法不再 fail-fast（致非法配置被启动）。
      expect(() => validateStartupConfig(bad)).to.throw(/Invalid HTTP port/);

      const noCreds = JSON.parse(JSON.stringify(defaultConfig));
      noCreds.ssh.privateKey = '';
      noCreds.ssh.password = '';
      // 可失败条件：凭证缺失被升级为致命错误（会打破「仅启 PAC」的合法用法）。
      expect(() => validateStartupConfig(noCreds)).to.not.throw();
      expect(validateStartupConfig(noCreds)).to.be.an('array');
    });
  });
});
