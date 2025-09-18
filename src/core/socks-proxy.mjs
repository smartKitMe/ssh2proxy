import { SocksClient } from 'socks';

class Socks5Proxy {
  constructor(tunnel) {
    this.tunnel = tunnel;
  }

  async handleRequest(socket, data) {
    try {
      // SOCKS5握手过程
      // 第一个字节是协议版本（0x05）
      // 第二个字节是认证方法数量
      if (data[0] !== 0x05) {
        socket.end();
        return;
      }

      const authMethodsCount = data[1];
      const authMethods = data.slice(2, 2 + authMethodsCount);

      // 检查是否支持无认证（0x00）或用户名/密码认证（0x02）
      let authMethod = 0xFF; // 默认不支持
      if (authMethods.includes(0x00)) {
        authMethod = 0x00; // 无认证
      } else if (authMethods.includes(0x02)) {
        authMethod = 0x02; // 用户名/密码认证
      }

      // 发送服务器选择的认证方法
      socket.write(Buffer.from([0x05, authMethod]));

      if (authMethod === 0xFF) {
        // 不支持的认证方法
        socket.end();
        return;
      }

      if (authMethod === 0x02) {
        // 处理用户名/密码认证
        socket.once('data', (authData) => {
          this.handleAuth(socket, authData);
        });
      } else {
        // 无认证，等待连接请求
        socket.once('data', (requestData) => {
          this.handleConnect(socket, requestData);
        });
      }
    } catch (err) {
      console.error('SOCKS5 handshake error:', err);
      socket.end();
    }
  }

  async handleAuth(socket, data) {
    try {
      // TODO: 实现用户名/密码认证
      // 简化实现，接受任何用户名/密码
      socket.write(Buffer.from([0x01, 0x00])); // 认证成功
      
      // 等待连接请求
      socket.once('data', (requestData) => {
        this.handleConnect(socket, requestData);
      });
    } catch (err) {
      console.error('SOCKS5 auth error:', err);
      socket.write(Buffer.from([0x01, 0x01])); // 认证失败
      socket.end();
    }
  }

  async handleConnect(socket, data) {
    try {
      // 解析连接请求
      if (data[0] !== 0x05) {
        socket.end();
        return;
      }

      const command = data[1]; // 0x01: CONNECT, 0x02: BIND, 0x03: UDP ASSOCIATE
      const addressType = data[3];

      if (command !== 0x01) {
        // 不支持BIND和UDP ASSOCIATE
        socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
        socket.end();
        return;
      }

      let host, port;
      
      if (addressType === 0x01) {
        // IPv4
        host = `${data[4]}.${data[5]}.${data[6]}.${data[7]}`;
        port = data.readUInt16BE(8);
      } else if (addressType === 0x03) {
        // 域名
        const domainLength = data[4];
        host = data.slice(5, 5 + domainLength).toString();
        port = data.readUInt16BE(5 + domainLength);
      } else if (addressType === 0x04) {
        // IPv6
        // 简化处理，实际应该解析IPv6地址
        socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
        socket.end();
        return;
      } else {
        // 不支持的地址类型
        socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
        socket.end();
        return;
      }

      // 通过SSH隧道建立连接
      const stream = await this.tunnel.forwardOut(
        'localhost',
        0,
        host,
        port
      );

      // 发送成功响应
      // 构造响应数据，这里简化处理，返回0.0.0.0:0
      const response = Buffer.from([0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
      socket.write(response);

      // 双向管道传输数据
      socket.pipe(stream, { end: true });
      stream.pipe(socket, { end: true });

      socket.on('error', (err) => {
        console.error('SOCKS5 socket error:', err);
        stream.end();
      });

      stream.on('error', (err) => {
        console.error('SOCKS5 stream error:', err);
        socket.end();
      });
    } catch (err) {
      console.error('SOCKS5 connect error:', err);
      // 发送失败响应
      socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
      socket.end();
    }
  }
}

export default Socks5Proxy;