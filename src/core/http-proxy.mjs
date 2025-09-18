import http from 'http';
import https from 'https';

class HttpProxy {
  constructor(tunnel) {
    this.tunnel = tunnel;
  }

  async handleRequest(req, res) {
    try {
      // 解析目标地址
      const targetHost = req.headers.host;
      if (!targetHost) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request: Missing Host header');
        return;
      }

      // 通过SSH隧道转发请求
      const stream = await this.tunnel.forwardOut(
        'localhost',
        0,
        targetHost.split(':')[0],
        targetHost.split(':')[1] || (req.socket.encrypted ? 443 : 80)
      );

      // 发送请求头
      let requestLine = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      stream.write(requestLine);
      
      // 发送请求头
      for (let header in req.headers) {
        stream.write(`${header}: ${req.headers[header]}\r\n`);
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
            const statusMatch = statusLine.match(/HTTP\/\d\.\d (\d+) (.*)/);
            if (statusMatch) {
              responseStatus = parseInt(statusMatch[1]);
            }
            
            // 解析响应头
            headerLines.forEach(line => {
              const [key, value] = line.split(': ');
              if (key && value) {
                responseHeaders[key] = value;
              }
            });
            
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

      stream.on('end', () => {
        res.end();
      });

      stream.on('error', (err) => {
        console.error('Stream error:', err);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
        }
        res.end('Proxy Error');
      });
    } catch (err) {
      console.error('Proxy error:', err);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
      }
      res.end('Proxy Error');
    }
  }

  async handleConnect(req, socket) {
    try {
      const [host, port] = req.url.split(':');
      
      // 通过SSH隧道建立连接
      const stream = await this.tunnel.forwardOut(
        'localhost',
        0,
        host,
        parseInt(port)
      );

      // 响应客户端CONNECT请求
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

      // 双向管道传输数据
      socket.pipe(stream, { end: true });
      stream.pipe(socket, { end: true });

      socket.on('error', (err) => {
        console.error('Socket error:', err);
        stream.end();
      });

      stream.on('error', (err) => {
        console.error('Stream error:', err);
        socket.end();
      });
    } catch (err) {
      console.error('HTTPS proxy error:', err);
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      socket.end();
    }
  }
}

export default HttpProxy;