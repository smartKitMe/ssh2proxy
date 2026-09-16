// 默认配置文件
export default {
  // 隧道类型配置
  tunnel: {
    type: 'ssh' // 或 'socks5'
  },
  
  // SSH连接配置
  ssh: {
    host: 'localhost',
    port: 22,
    username: 'user',
    password: '', // 或使用私钥认证
    privateKey: '', // 私钥内容，也可以通过命令行参数--ssh-private-key-path指定私钥文件路径
    passphrase: '', // 私钥密码（如果需要）
    keepaliveInterval: 30000, // 心跳间隔
    retryAttempts: 3,     // SSH重试次数
    retryDelay: 5000         // SSH重试延迟（毫秒）
  },
  
  // 上游SOCKS5代理配置（可选，替代SSH隧道）
  upstreamSocks5: {
    host: '',
    port: 1080,
    username: '', // 可选，如果上游SOCKS5需要认证
    password: '', // 可选，如果上游SOCKS5需要认证
    // SOCKS5连接池配置
    pool: {
      maxConnections: 10,        // 每个目标最大连接数
      idleTimeout: 30000,        // 空闲超时(毫秒)
      connectionTimeout: 10000,  // 连接超时(毫秒)
      healthCheckInterval: 60000, // 健康检查间隔(毫秒)
      waitTimeout: 10000,        // 池满后的排队等待超时(毫秒)
      cleanupInterval: 10000,    // 空闲连接回收扫描间隔(毫秒)
      minConnections: 1,         // 动态调整下限(每个目标)
      maxConnectionsLimit: 0,    // 动态调整上限，0 表示 maxConnections * 4
      prewarm: false,            // 隧道 connect() 时是否预热连接
      prewarmCount: 1,           // 每个预热目标建立的连接数
      prewarmTargets: [],        // 预热目标，元素形如 'host:port' 或 {host, port}
      retryBackoffFactor: 2,     // 建连重试退避倍数（指数退避）
      retryMaxDelay: 30000,      // 建连重试最大延迟(毫秒)
      fallbackHost: '',          // 备用上游SOCKS5地址(故障转移)
      fallbackPort: 0            // 备用上游SOCKS5端口
    }
  },
  // 顶层兼容别名（README 使用的键）：与 upstreamSocks5.pool 同源，存在时优先生效
  socks5Pool: {},
  
  // 连接池配置
  connectionPool: {
    maxSize: 10,     // 连接池最大连接数
    minSize: 3,     // 连接池最小连接数
    acquireTimeout: 30000,  // 获取连接超时时间（毫秒）
    idleTimeout: 60000,     // 空闲连接超时时间（毫秒）
    retryAttempts: 3,   // 重试次数
    retryDelay: 5000,       // 重试延迟（毫秒）
    maxConnectionsPerTunnel: 10, // 每个SSH隧道最大连接数
    loadBalancingStrategy: 'least-connections' // 负载均衡策略
  },
  
  // 代理服务配置
  proxy: {
    httpPort: 8080,
    socksPort: 1080,
    pacPort: 8013 // 仅在pac.enabled为true时生效
  },
  
  // PAC配置
  pac: {
    enabled: false, // 默认false，手动设置为true开启PAC服务
    filePath: '',
    content: '',
    defaultProxy: 'SOCKS5 127.0.0.1:1080; SOCKS 127.0.0.1:1080; DIRECT'
  },
  
  // 认证配置
  auth: {
    enabled: false,
    username: '',
    password: ''
  },
  
  // 管理端点配置
  admin: {
    enabled: false, // 默认false，手动设置为true开启管理端点服务
    username: '', // 如果未指定，将自动生成
    password: ''  // 如果未指定，将自动生成
  }
};