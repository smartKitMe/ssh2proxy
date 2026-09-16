// 辅助函数工具
import net from 'node:net';

// 检查是否为IPv4地址
// 委托 node:net（RD-C3-03 第 4 条）：'999.1.1.1' / '127.1' 等非规范形态正确为 false
// 语义变更登记见 handoff/known_issues.md（旧正则版对 '999.1.1.1' 返回 true）
function isIPv4(host) {
  if (typeof host !== 'string') return false;
  return net.isIPv4(host);
}

// 检查是否为IPv6地址
// 委托 node:net（RD-C3-03 第 3 条）：A5 期望表逐项一致，含 IPv4-mapped '::ffff:127.0.0.1' === true
// 语义变更登记见 handoff/known_issues.md（旧实现 host.includes(':') && !host.includes('.') 对 mapped 地址返回 false）
function isIPv6(host) {
  if (typeof host !== 'string') return false;
  return net.isIPv6(host);
}

// 解析主机和端口。支持的输入形态与**明确语义**：
//   1. '[::1]:1080'        → { host: '::1',        port: 1080 }   （方括号 IPv6 + 显式端口）
//   2. '[2001:db8::1]'     → { host: '2001:db8::1', port: 80 }    （方括号 IPv6，缺省端口 80）
//   3. '2001:db8::1'       → { host: '2001:db8::1', port: undefined }（裸 IPv6 字面量：冒号是地址分隔符，不是端口）
//   4. '127.0.0.1:8080'    → { host: '127.0.0.1',  port: 8080 }
//   5. '127.0.0.1'         → { host: '127.0.0.1',  port: 80 }
//   6. 'example.com:80'    → { host: 'example.com', port: 80 }
//   7. 'example.com'       → { host: 'example.com', port: 80 }
//
// 语义要点（旧实现 bug 修复）：裸 IPv6 字面量的冒号**不得**被当作端口分隔符
// （旧实现 `lastIndexOf(':')` 会把 '2001:db8::1' 切碎成 host='2001:db8:'、port=1）。
// 裸 IPv6 无端口信息，port 返回 `undefined` 让调用方决定默认值（不要静默编造端口）。
// 非字符串或空输入 → { host: '', port: 0 }（保持既有返回形态，调用方按 falsy 判空）。
function parseHostAndPort(hostHeader) {
  if (typeof hostHeader !== 'string') return { host: '', port: 0 };
  const trimmed = hostHeader.trim();
  if (!trimmed) return { host: '', port: 0 };

  // 带方括号的 IPv6 字面量：只能以 ']' 为界切端口，禁止按 ':' 切分
  if (trimmed.startsWith('[')) {
    const closing = trimmed.indexOf(']');
    if (closing === -1) return { host: trimmed, port: 80 };
    const host = trimmed.slice(1, closing);
    const rest = trimmed.slice(closing + 1);
    if (!rest.startsWith(':')) return { host, port: 80 };
    const bracketPort = Number.parseInt(rest.slice(1), 10);
    return { host, port: Number.isNaN(bracketPort) ? 80 : bracketPort };
  }

  // 裸 IPv6 字面量（无方括号）：整串即 host，冒号属于地址本身
  if (isIPv6(trimmed)) {
    return { host: trimmed, port: undefined };
  }

  const separator = trimmed.lastIndexOf(':');
  if (separator === -1) return { host: trimmed, port: 80 };

  const host = trimmed.slice(0, separator);
  const portStr = trimmed.slice(separator + 1);
  const port = portStr ? Number.parseInt(portStr, 10) : 80;

  return { host, port: Number.isNaN(port) ? 80 : port };
}

// 合并配置对象
function mergeConfig(defaultConfig, userConfig) {
  const result = { ...defaultConfig };
  
  for (const key in userConfig) {
    if (typeof userConfig[key] === 'object' && userConfig[key] !== null && !Array.isArray(userConfig[key])) {
      result[key] = mergeConfig(result[key] || {}, userConfig[key]);
    } else {
      result[key] = userConfig[key];
    }
  }
  
  return result;
}

// 验证配置：返回错误数组（空数组=通过）
// 健壮性修正：缺省段不再因 config.ssh/config.proxy 缺失而抛 TypeError
// 消费者在 CLI/app 启动路径（C4 write_paths），登记为「待接线」见 known_issues.md
function validateConfig(config) {
  const errors = [];
  const target = config || {};

  // 验证SSH配置
  const ssh = target.ssh || {};
  if (!ssh.host) {
    errors.push('SSH host is required');
  }

  if (!ssh.username) {
    errors.push('SSH username is required');
  }

  // 检查是否提供了密码或私钥（包括通过文件路径指定的私钥）
  if (!ssh.password && !ssh.privateKey) {
    errors.push('Either SSH password or private key is required');
  }

  // 验证代理端口配置
  const proxy = target.proxy || {};
  if (!(proxy.httpPort > 0 && proxy.httpPort <= 65535)) {
    errors.push('Invalid HTTP port');
  }

  if (!(proxy.socksPort > 0 && proxy.socksPort <= 65535)) {
    errors.push('Invalid SOCKS port');
  }

  return errors;
}

export {
  isIPv4,
  isIPv6,
  parseHostAndPort,
  mergeConfig,
  validateConfig
};
