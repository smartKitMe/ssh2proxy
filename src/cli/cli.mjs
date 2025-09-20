#!/usr/bin/env node

import { Command } from 'commander';
import fs from 'fs/promises';
import path from 'path';
import defaultConfig from '../config/default.config.mjs';
import { mergeConfig } from '../utils/helpers.mjs';

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

// 加载配置文件
async function loadConfig(configPath) {
  try {
    const configFile = await fs.readFile(configPath, 'utf8');
    const userConfig = JSON.parse(configFile);
    return mergeConfig(defaultConfig, userConfig);
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

async function main() {
  const program = new Command();
  
  const version = await getVersion();
  
  program
    .name('ssh2proxy')
    .description('SSH隧道代理服务器')
    .version(version)
    .option('-c, --config <path>', '配置文件路径')
    .option('-p, --port <port>', '代理端口')
    .option('--http-port <port>', 'HTTP代理端口')
    .option('--socks-port <port>', 'SOCKS5代理端口')
    .option('--pac-port <port>', 'PAC服务端口')
    .option('--pac-file-path <path>', 'PAC文件路径')
    .option('--ssh-private-key-path <path>', 'SSH私钥文件路径')
    .option('-v, --verbose', '详细日志输出')
    .action(async (options) => {
      console.log('Starting SSH2Proxy with options:', options);
      
      let config = { ...defaultConfig };
      
      // 加载配置文件
      if (options.config) {
        config = await loadConfig(options.config);
      }
      
      // 如果指定了私钥文件路径，则读取私钥内容
      if (options.sshPrivateKeyPath) {
        config.ssh.privateKey = await readPrivateKeyFile(options.sshPrivateKeyPath);
      }
      
      // 命令行参数覆盖配置文件
      if (options.port) {
        config.proxy.httpPort = parseInt(options.port);
      }
      
      if (options.httpPort) {
        config.proxy.httpPort = parseInt(options.httpPort);
      }
      
      if (options.socksPort) {
        config.proxy.socksPort = parseInt(options.socksPort);
      }
      
      if (options.pacPort) {
        config.proxy.pacPort = parseInt(options.pacPort);
      }
      
      // 添加PAC文件路径支持
      if (options.pacFilePath) {
        config.pac.filePath = options.pacFilePath;
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

// 如果直接运行此文件，则执行main函数
main().catch(console.error);

export default main;