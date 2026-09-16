#!/usr/bin/env node

import { Command } from 'commander';
import fs from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';
import defaultConfig from '../config/default.config.mjs';
import { mergeConfig, validateConfig } from '../utils/helpers.mjs';

// 获取版本号
async function getVersion() {
  try {
    // 尝试多种方式获取package.json路径
    const possiblePaths = [
      path.join(process.cwd(), 'package.json'),
      path.join(process.cwd(), '../package.json'),
      path.join(process.cwd(), '../../package.json')
    ];
    
    for (const packagePath of possiblePaths) {
      try {
        const packageJson = await fs.readFile(packagePath, 'utf8');
        const pkg = JSON.parse(packageJson);
        return pkg.version;
      } catch (err) {
        // 继续尝试下一个路径
      }
    }
    
    return 'unknown';
  } catch (err) {
    return 'unknown';
  }
}

// 深拷贝默认配置：原实现 `{ ...defaultConfig }` 是浅拷贝，CLI 覆盖会就地改写 defaultConfig 的嵌套对象
function cloneDefaultConfig() {
  return mergeConfig({}, defaultConfig);
}

// 加载配置文件
async function loadConfig(configPath) {
  try {
    const configFile = await fs.readFile(configPath, 'utf8');
    const userConfig = JSON.parse(configFile);
    return mergeConfig(cloneDefaultConfig(), userConfig);
  } catch (err) {
    console.error('Failed to load config file:', err.message);
    process.exit(1);
  }
}

// 读取私钥文件内容
async function readPrivateKeyFile(privateKeyPath) {
  try {
    return await fs.readFile(privateKeyPath, 'utf8');
  } catch (err) {
    console.error('Failed to read private key file:', err.message);
    process.exit(1);
  }
}

// 端口解析（0..65535）
function toPort(value, optionName) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid value for ${optionName}: ${value}`);
  }
  return parsed;
}

// 计数/超时解析（非负整数）
function toCount(value, optionName) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid value for ${optionName}: ${value}`);
  }
  return parsed;
}

/**
 * 命令行选项 → 配置键的唯一映射实现点（D-104：杜绝「第二波幽灵选项」）
 * 完整「选项名 ↔ 配置键 ↔ 消费者」表见 handoff/known_issues.md
 * @param {Object} config - 目标配置对象（就地更新）
 * @param {Object} options - commander 解析结果
 * @returns {Object} 更新后的配置
 */
function applyCliOptions(config, options = {}) {
  // 代理监听面
  if (options.port) {
    config.proxy.httpPort = toPort(options.port, '--port');
  }
  if (options.httpPort) {
    config.proxy.httpPort = toPort(options.httpPort, '--http-port');
  }
  if (options.httpsPort) {
    config.proxy.httpsPort = toPort(options.httpsPort, '--https-port');
  }
  if (options.socksPort) {
    config.proxy.socksPort = toPort(options.socksPort, '--socks-port');
  }
  if (options.pacPort) {
    config.proxy.pacPort = toPort(options.pacPort, '--pac-port');
  }
  if (options.host) {
    config.proxy.host = options.host;
  }

  // SSH 隧道
  if (options.sshHost) {
    config.ssh.host = options.sshHost;
  }
  if (options.sshPort) {
    config.ssh.port = toPort(options.sshPort, '--ssh-port');
  }

  // PAC 服务
  if (options.enablePac) {
    config.pac.enabled = true;
  }
  if (options.pacFilePath) {
    config.pac.filePath = options.pacFilePath;
  }

  // 管理端点
  if (options.enableAdmin) {
    config.admin.enabled = true;
  }

  // 上游 SOCKS5
  if (options.upstreamSocks5Host) {
    config.upstreamSocks5.host = options.upstreamSocks5Host;
  }
  if (options.upstreamSocks5Port) {
    config.upstreamSocks5.port = toPort(options.upstreamSocks5Port, '--upstream-socks5-port');
  }
  if (options.upstreamSocks5User) {
    config.upstreamSocks5.username = options.upstreamSocks5User;
  }
  if (options.upstreamSocks5Pass) {
    config.upstreamSocks5.password = options.upstreamSocks5Pass;
  }

  // 连接池
  if (options.poolMaxSize) {
    config.connectionPool.maxSize = toCount(options.poolMaxSize, '--pool-max-size');
  }
  if (options.poolMinSize) {
    config.connectionPool.minSize = toCount(options.poolMinSize, '--pool-min-size');
  }
  if (options.poolAcquireTimeout) {
    config.connectionPool.acquireTimeout = toCount(options.poolAcquireTimeout, '--pool-acquire-timeout');
  }
  if (options.poolIdleTimeout) {
    config.connectionPool.idleTimeout = toCount(options.poolIdleTimeout, '--pool-idle-timeout');
  }

  // 详细日志（D-103：真实消费者是 app.mjs → LoggerMiddleware 的 level 注入）
  if (options.verbose) {
    config.verbose = true;
    config.logging = { ...(config.logging || {}), level: 'debug' };
  }

  return config;
}

/**
 * 启动前配置校验（RD-12 接线点：validateConfig 的真实消费者）
 * 端口一类的非法值属致命错误 → fail-fast；SSH 凭证缺失按告警处理（默认配置即无凭证，
 * 且仅启动 PAC/管理端点属合法用法），理由见 handoff/known_issues.md
 * @param {Object} config - 待校验配置
 * @returns {string[]} 校验错误列表
 */
function validateStartupConfig(config) {
  const errors = validateConfig(config);
  const fatalErrors = errors.filter((message) => /port/i.test(message));

  if (fatalErrors.length > 0) {
    throw new Error(`Invalid configuration: ${fatalErrors.join('; ')}`);
  }

  if (errors.length > 0) {
    console.warn(`Configuration warnings: ${errors.join('; ')}`);
  }

  return errors;
}

async function main() {
  const program = new Command();
  
  const version = await getVersion();
  
  program
    .name('ssh2proxy')
    .description('SSH隧道代理服务器')
    .version(version)
    // -h 在 design §10.2 中定义为 --host（D-104），故 help 的短选项重映射为 -H
    .helpOption('-H, --help', '显示帮助信息')
    .option('-c, --config <path>', '配置文件路径')
    .option('-p, --port <port>', '代理端口')
    .option('-h, --host <host>', '监听主机地址')
    .option('--http-port <port>', 'HTTP代理端口')
    .option('--https-port <port>', 'HTTPS(CONNECT)代理端口')
    .option('--socks-port <port>', 'SOCKS5代理端口')
    .option('--pac-port <port>', 'PAC服务端口')
    .option('--pac-file-path <path>', 'PAC文件路径')
    .option('--enable-pac', '启用PAC文件服务（默认不开启）')
    .option('--enable-admin', '启用管理端点服务（默认不开启）')
    .option('--ssh-host <host>', 'SSH服务器主机地址')
    .option('--ssh-port <port>', 'SSH服务器端口')
    .option('--ssh-private-key-path <path>', 'SSH私钥文件路径')
    .option('--upstream-socks5-host <host>', '上游SOCKS5代理主机地址')
    .option('--upstream-socks5-port <port>', '上游SOCKS5代理端口')
    .option('--upstream-socks5-user <username>', '上游SOCKS5代理用户名')
    .option('--upstream-socks5-pass <password>', '上游SOCKS5代理密码')
    .option('--pool-max-size <number>', '连接池最大连接数')
    .option('--pool-min-size <number>', '连接池最小连接数')
    .option('--pool-acquire-timeout <number>', '获取连接超时时间（毫秒）')
    .option('--pool-idle-timeout <number>', '连接池空闲超时时间（毫秒）')
    .option('-v, --verbose', '详细日志输出')
    .action(async (options) => {
      console.log('Starting SSH2Proxy with options:', options);
      
      let config = cloneDefaultConfig();
      
      // 加载配置文件
      if (options.config) {
        config = await loadConfig(options.config);
      }

      // 命令行参数覆盖配置文件（唯一映射实现点）
      try {
        applyCliOptions(config, options);
      } catch (err) {
        console.error('Invalid command line option:', err.message);
        process.exit(1);
      }
      
      // 如果指定了私钥文件路径，则读取私钥内容
      if (options.sshPrivateKeyPath) {
        config.ssh.privateKey = await readPrivateKeyFile(options.sshPrivateKeyPath);
      }

      // 启动前校验
      try {
        validateStartupConfig(config);
      } catch (err) {
        console.error('Configuration error:', err.message);
        process.exit(1);
      }
      
      // 为了更清晰地显示配置，我们只显示关键部分
      const displayConfig = {
        ...config,
        ssh: {
          ...config.ssh,
          // 隐藏实际的私钥内容，只显示是否提供了私钥
          privateKey: config.ssh.privateKey ? '[PRIVATE KEY CONTENT HIDDEN]' : ''
        }
      };
      
      console.log('Configuration:', JSON.stringify(displayConfig, null, 2));
      
      // 启动代理服务器
      const { default: ProxyServer } = await import('../app.mjs');
      const server = new ProxyServer(config);
      
      try {
        await server.start();
        console.log('Proxy server started successfully');
      } catch (err) {
        console.error('Failed to start proxy server:', err.message);
        process.exit(1);
      }
    });
  
  await program.parseAsync(process.argv);
}

/**
 * 入口守卫（D-109）：仅在直接执行本文件时启动服务；
 * 被 import（如 `await import('./src/cli/cli.mjs')`）时 MUST NOT 启动服务或连 SSH。
 */
const isDirectRun = (() => {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  } catch (err) {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { main, applyCliOptions, validateStartupConfig };
export default main;
