#!/usr/bin/env node

import Socks5Tunnel from './src/core/socks-tunnel.mjs';

// 测试连接池功能
async function testConnectionPool() {
  console.log('=== SOCKS5连接池功能测试 ===\n');

  // 创建SOCKS5隧道配置
  const config = {
    host: '127.0.0.1',
    port: 1080,
    pool: {
      maxConnections: 3,
      idleTimeout: 10000,
      connectionTimeout: 5000
    }
  };

  const tunnel = new Socks5Tunnel(config);

  try {
    // 初始化隧道
    await tunnel.connect();
    console.log('✓ SOCKS5隧道初始化成功\n');

    // 模拟多个并发连接请求
    const targets = [
      { ip: 'example.com', port: 80 },
      { ip: 'example.com', port: 80 },
      { ip: 'example.com', port: 80 },
      { ip: 'google.com', port: 443 },
      { ip: 'google.com', port: 443 }
    ];

    console.log('模拟并发连接请求...');
    const promises = targets.map(async (target, index) => {
      console.log(`请求 ${index + 1}: ${target.ip}:${target.port}`);
      try {
        // 这里会抛出连接错误，因为我们没有真实的SOCKS5服务器
        // 但我们可以测试连接池的逻辑
        await tunnel.forwardOut('127.0.0.1', 0, target.ip, target.port);
        console.log(`✓ 请求 ${index + 1} 成功`);
      } catch (error) {
        console.log(`✗ 请求 ${index + 1} 失败: ${error.message}`);
      }
    });

    await Promise.allSettled(promises);

    // 显示连接池统计信息
    console.log('\n=== 连接池统计信息 ===');
    const stats = tunnel.getPoolStats();
    console.log(`连接命中次数: ${stats.connectionHits}`);
    console.log(`连接未命中次数: ${stats.connectionMisses}`);
    console.log(`总连接数: ${stats.totalConnections}`);
    console.log(`活跃连接数: ${stats.activeConnections}`);
    console.log(`空闲连接数: ${stats.idleConnections}`);
    console.log(`等待请求数: ${stats.pendingRequests}`);

    console.log('\n✓ 连接池功能测试完成');

  } catch (error) {
    console.error('测试失败:', error);
  } finally {
    // 关闭隧道
    tunnel.close();
  }
}

// 运行测试
if (import.meta.url === `file://${process.argv[1]}`) {
  testConnectionPool().catch(console.error);
}

export { testConnectionPool };