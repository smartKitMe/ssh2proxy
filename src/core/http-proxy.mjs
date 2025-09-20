import http from 'http';
import https from 'https';

class HttpProxy {
  constructor(tunnel) {
    this.tunnel = tunnel;
  }

  async handleRequest(req, res) {
    let stream = null;
    try {
      // 解析目标地址
      const targetHost = req.headers.host;
      if (!targetHost) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request: Missing Host header');
        return;
      }

      const [host, portStr] = targetHost.split(':');
      const port = portStr ? parseInt(portStr) : (req.socket.encrypted ? 443 : 80);

      // 通过SSH隧道转发请求
      stream = await this.tunnel.forwardOut(
        'localhost',
        0,
        host,
        port
      );

      // 构建请求行
      let requestLine = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      
      // 复制请求头，但移除一些可能有问题的头
      const headers = { ...req.headers };
      delete headers['proxy-connection'];
      delete headers['connection'];
      
      // 发送请求行和请求头
      stream.write(requestLine);
      for (let header in headers) {
        stream.write(`${header}: ${headers[header]}\r\n`);
      }
      stream.write('\r\n');

      // 管道传输请求体
      req.pipe(stream, { end: true });

      // 处理响应
      let responseBuffer = '';
      let headersReceived = false;
      let responseHeaders = {};
      let responseStatus = 200;

      stream.on('data', (chunk) => {
        if (!headersReceived) {
          responseBuffer += chunk.toString();
          
          // 检查是否收到完整的响应头
          if (responseBuffer.includes('\r\n\r\n')) {
            headersReceived = true;
            const [headersPart, bodyPart] = responseBuffer.split('\r\n\r\n', 2);
            const headerLines = headersPart.split('\r\n');
            
            // 解析状态行
            const statusLine = headerLines.shift();
            const statusMatch = statusLine.match(/HTTP\/\d\.\d (\d+) ?(.*)?/);
            if (statusMatch) {
              responseStatus = parseInt(statusMatch[1]);
            }
            
            // 解析响应头
            headerLines.forEach(line => {
              if (line.includes(':')) {
                const [key, ...valueParts] = line.split(':');
                const value = valueParts.join(':').trim();
                if (key && value !== undefined) {
                  responseHeaders[key.trim()] = value;
                }
              }
            });
            
            // 移除一些可能有问题的头
            delete responseHeaders['connection'];
            delete responseHeaders['transfer-encoding'];
            
            // 发送响应头
            res.writeHead(responseStatus, responseHeaders);
            
            // 发送已接收的响应体部分
            if (bodyPart) {
              res.write(bodyPart);
            }
          }
        } else {
          // 已经发送响应头，直接发送响应体
          res.write(chunk);
        }
      });

      // 确保在连接关闭时释放资源
      const cleanup = () => {
        if (stream) {
          stream.end();
        }
      };

      stream.on('end', () => {
        cleanup();
        if (!res.finished) {
          res.end();
        }
      });

      stream.on('error', (err) => {
        console.error('Stream error:', err);
        cleanup();
        if (!res.headersSent && !res.finished) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end('Proxy Error');
        }
      });

      req.on('close', cleanup);
      req.on('error', cleanup);
      res.on('close', cleanup);
      res.on('error', cleanup);

    } catch (err) {
      console.error('Proxy error:', err);
      if (stream) {
        stream.end();
      }
      if (!res.headersSent && !res.finished) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
      }
      if (!res.finished) {
        res.end('Proxy Error');
      }
    }
  }

  async handleConnect(req, socket) {
    let stream = null;
    try {
      const [host, port] = req.url.split(':');
      
      // 通过SSH隧道建立连接
      stream = await this.tunnel.forwardOut(
        'localhost',
        0,
        host,
        parseInt(port)
      );

      // 响应客户端CONNECT请求 - 正确的响应格式
      socket.write('HTTP/1.1 200 Connection Established\r\n');
      socket.write('Proxy-Agent: SSH2Proxy\r\n');
      socket.write('\r\n'); // 空行表示响应头结束

      // 双向管道传输数据
      socket.pipe(stream, { end: true });
      stream.pipe(socket, { end: true });

      // 确保在连接关闭时释放资源
      const cleanup = () => {
        if (stream) {
          stream.end();
        }
        socket.end();
      };

      socket.on('close', cleanup);
      socket.on('error', cleanup);
      stream.on('close', cleanup);
      stream.on('error', cleanup);

    } catch (err) {
      console.error('HTTPS proxy error:', err);
      if (stream) {
        stream.end();
      }
      // 发送错误响应
      if (socket.writable) {
        socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      }
      socket.end();
    }
  }
}

export default HttpProxy;