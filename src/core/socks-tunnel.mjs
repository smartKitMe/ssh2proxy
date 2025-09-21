import { SocksClient } from 'socks';
import { EventEmitter } from 'events';

class Socks5Tunnel extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.client = null;
    this.isConnected = true; // SOCKS5隧道始终认为是"已连接"的，因为每次forwardOut都会创建新连接
    this.retryCount = 0;
    
    // 添加默认的错误事件监听器，防止未捕获的错误导致进程退出
    this.on('error', (err) => {
      console.warn('SOCKS5 tunnel error (handled silently):', err.message);
      // 不做任何处理，防止错误向上冒泡导致进程退出
    });
  }

  async connect() {
    // 对于SOCKS5隧道，连接总是成功的，因为我们会在每次forwardOut时创建新连接
    console.log('SOCKS5 tunnel initialized (connectionless mode)');
    this.isConnected = true;
    this.emit('connect');
    return Promise.resolve();
  }

  forwardOut(srcIP, srcPort, dstIP, dstPort) {
    return new Promise((resolve, reject) => {
      console.log(`SOCKS5 forwardOut called: ${srcIP}:${srcPort} -> ${dstIP}:${dstPort}`);
      console.log(`SOCKS5 connection status: isConnected=${this.isConnected}`);
      
      // 检查隧道是否配置正确
      if (!this.config || !this.config.host || !this.config.port) {
        const error = new Error('SOCKS5 tunnel not properly configured');
        console.error('SOCKS5 forwardOut error:', error.message);
        reject(error);
        return;
      }

      // 创建一个新的SOCKS5连接用于转发
      const options = {
        proxy: {
          host: this.config.host,
          port: this.config.port,
          type: 5 // SOCKS v5
        },
        command: 'connect',
        destination: {
          host: dstIP,
          port: dstPort
        }
      };

      // 如果配置了认证信息，则添加认证
      if (this.config.username && this.config.password) {
        options.proxy.userId = this.config.username;
        options.proxy.password = this.config.password;
      }

      console.log('Creating SOCKS5 connection with options:', JSON.stringify(options, null, 2));
      
      // 使用 async/await 来更好地处理错误
      SocksClient.createConnection(options)
        .then((info) => {
          console.log('SOCKS5 connection created successfully for forwarding');
          resolve(info.socket);
        })
        .catch((err) => {
          console.error('SOCKS5 connection creation failed:', err);
          // 直接拒绝Promise，不发出错误事件，防止未捕获的异常
          reject(new Error(`SOCKS5 connection failed: ${err.message}`));
        });
    });
  }

  close() {
    // 对于SOCKS5隧道，没有需要关闭的持久连接
    console.log('SOCKS5 tunnel closed (no persistent connection to close)');
    this.isConnected = false;
  }
}

export default Socks5Tunnel;