// 辅助函数工具

// 检查是否为IPv4地址
function isIPv4(host) {
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  return ipv4Regex.test(host);
}

// 检查是否为IPv6地址
function isIPv6(host) {
  return host.includes(':') && !host.includes('.');
}

// 解析主机和端口
function parseHostAndPort(hostHeader) {
  if (!hostHeader) return { host: '', port: 0 };
  
  const [host, portStr] = hostHeader.split(':');
  const port = portStr ? parseInt(portStr) : 80;
  
  return { host, port };
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

// 验证配置
function validateConfig(config) {
  const errors = [];
  
  // 验证SSH配置
  if (!config.ssh.host) {
    errors.push('SSH host is required');
  }
  
  if (!config.ssh.username) {
    errors.push('SSH username is required');
  }
  
  // 检查是否提供了密码或私钥（包括通过文件路径指定的私钥）
  if (!config.ssh.password && !config.ssh.privateKey) {
    errors.push('Either SSH password or private key is required');
  }
  
  // 验证代理端口配置
  if (config.proxy.httpPort <= 0 || config.proxy.httpPort > 65535) {
    errors.push('Invalid HTTP port');
  }
  
  if (config.proxy.socksPort <= 0 || config.proxy.socksPort > 65535) {
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