// 默认配置文件
export default {
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
    password: ''  // 可选，如果上游SOCKS5需要认证
  },
  
  // 连接池配置
  connectionPool: {
    maxSize: 10,     // 连接池最大连接数
    minSize: 2,     // 连接池最小连接数
    acquireTimeout: 30000,  // 获取连接超时时间（毫秒）
    idleTimeout: 60000,     // 空闲连接超时时间（毫秒）
    retryAttempts: 3,   // 重试次数
    retryDelay: 5000       // 重试延迟（毫秒）
  },
  
  // 代理服务配置
  proxy: {
    httpPort: 8080,
    httpsPort: 8443,
    socksPort: 1080,
    pacPort: 8090 // 仅在pac.enabled为true时生效
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