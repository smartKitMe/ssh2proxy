import http from 'http';

// 创建一个简单的HTTP服务器用于测试
const server = http.createServer((req, res) => {
  console.log('Received request:', req.method, req.url);
  console.log('Headers:', req.headers);
  
  res.writeHead(200, {
    'Content-Type': 'text/plain',
    'Server': 'TestServer'
  });
  res.end('Hello from test server!');
});

server.listen(8000, '127.0.0.1', () => {
  console.log('Test server running on http://127.0.0.1:8000');
});