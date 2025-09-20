import net from 'net';

// 创建一个模拟的SSH服务器用于测试
const server = net.createServer((socket) => {
  console.log('SSH client connected');
  
  // 发送SSH版本信息
  socket.write('SSH-2.0-OpenSSH_7.9\r\n');
  
  socket.on('data', (data) => {
    console.log('Received data from client:', data.toString());
    // 简单回显所有数据
    socket.write(data);
  });
  
  socket.on('close', () => {
    console.log('SSH client disconnected');
  });
  
  socket.on('error', (err) => {
    console.error('SSH socket error:', err);
  });
});

server.listen(2222, '127.0.0.1', () => {
  console.log('Mock SSH server running on ssh://127.0.0.1:2222');
});