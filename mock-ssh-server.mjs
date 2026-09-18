import net from 'net';

// 模拟 SSH 服务器（**能力边界，MUST 先读**）
//
// 本文件只做两件事：① 发送 SSH 版本 banner（`SSH-2.0-OpenSSH_7.9`）；② 把收到的字节原样回显。
// 它**不实现** SSH 传输层：不发送 `SSH_MSG_KEXINIT`、不做密钥交换/算法协商、不解包加密记录，
// 因此 **ssh2 客户端无法与之完成握手**（实测报 `Bad packet length`，缺陷 D-135）。
// 结论与用法：测试**不得**依赖它做端到端 SSH 隧道；`src/tests/**` 现在用「在 `connectionPool.createTunnel`
// 处注入 stub 隧道」的方式覆盖代理链路，真实 SSH 握手不在覆盖范围内。
// 保留本文件的用途：作为「纯回显对端」验证客户端的连接与 banner 解析行为（例如负向对照）。
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