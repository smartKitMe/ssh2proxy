import crypto from 'crypto';
import { isIPv4, isIPv6, mergeConfig } from '../utils/helpers.mjs';

// SOCKS5 协议常量（RFC1928）
const SOCKS_VERSION = 0x05;
const AUTH_VERSION = 0x01; // RFC1929 子协商版本
const METHOD_NO_AUTH = 0x00;
const METHOD_USERPASS = 0x02;
const METHOD_NO_ACCEPTABLE = 0xFF;

const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;

const REP_SUCCEEDED = 0x00;
const REP_CONNECTION_REFUSED = 0x05;
const REP_COMMAND_NOT_SUPPORTED = 0x07;
const REP_ATYP_NOT_SUPPORTED = 0x08;

// 响应的 BND.ADDR/BND.PORT（IPv4 0.0.0.0:0，保持既有行为，不新增字面量端口）
const BND_IPV4_ANY = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

// 认证默认关闭：与 src/config/default.config.mjs 的 auth.enabled:false 一致。
// 关闭时不强制凭据，但仍按 RFC1928 与客户端真实协商方法；开启时强制 RFC1929 用户名/密码。
const DEFAULT_AUTH = { enabled: false, username: 'admin', password: '' };

// 以 HMAC-SHA256 把任意长度输入归一为定长摘要，再常量时间比较。
// 这样 length 不等也绝不抛异常（规避 timingSafeEqual 的长度前置条件），且不泄漏长度差异。
const DIGEST_KEY = Buffer.from('ssh2proxy:socks5-constant-time-compare:v1');
function constantTimeEqual(a, b) {
  const digestA = crypto.createHmac('sha256', DIGEST_KEY).update(a).digest();
  const digestB = crypto.createHmac('sha256', DIGEST_KEY).update(b).digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

// 16 字节 → RFC5952 形态字符串（含 :: 压缩与 IPv4-mapped 可读形式）
function serializeIPv6(bytes) {
  const words = [];
  for (let i = 0; i < 16; i += 2) {
    words.push((bytes[i] << 8) | bytes[i + 1]);
  }
  // ::ffff:a.b.c.d（IPv4-mapped）保留点分可读形式，避免下游被改写成十六进制形态
  if (
    words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 &&
    words[4] === 0 && words[5] === 0xffff
  ) {
    const ipv4 = [words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff].join('.');
    return `::ffff:${ipv4}`;
  }
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  for (let i = 0; i <= words.length; i += 1) {
    if (i < words.length && words[i] === 0) {
      if (runStart === -1) runStart = i;
    } else if (runStart !== -1) {
      const runLen = i - runStart;
      if (runLen > bestLen) {
        bestLen = runLen;
        bestStart = runStart;
      }
      runStart = -1;
    }
  }
  if (bestLen < 2) {
    return words.map((word) => word.toString(16)).join(':');
  }
  const head = words.slice(0, bestStart).map((word) => word.toString(16)).join(':');
  const tail = words.slice(bestStart + bestLen).map((word) => word.toString(16)).join(':');
  return `${head}::${tail}`;
}

// 按客户端声明的 ATYP 字节分流（禁止用 host.split(':') / 字面量猜测判型）
// 返回 null 表示报文不完整或地址非法
function parseAddress(data) {
  const atyp = data[3];
  if (atyp === ATYP_IPV4) {
    if (data.length < 10) return null;
    const host = `${data[4]}.${data[5]}.${data[6]}.${data[7]}`;
    if (!isIPv4(host)) return null;
    return { atyp, host, port: data.readUInt16BE(8) };
  }
  if (atyp === ATYP_DOMAIN) {
    if (data.length < 5) return null;
    const domainLength = data[4];
    if (domainLength === 0) return null;
    if (data.length < 5 + domainLength + 2) return null;
    const host = data.slice(5, 5 + domainLength).toString('utf8');
    if (!host) return null;
    return { atyp, host, port: data.readUInt16BE(5 + domainLength) };
  }
  if (atyp === ATYP_IPV6) {
    if (data.length < 22) return null;
    // 固定 16 字节地址 + 2 字节端口；不做 IPv4 映射归一化改写（原文透传给隧道）
    const host = serializeIPv6(data.slice(4, 20));
    // 语义校验走 helpers 的真实调用点（net.isIPv6）
    if (!isIPv6(host)) return null;
    return { atyp, host, port: data.readUInt16BE(20) };
  }
  return { atyp, host: null, port: 0 };
}

function buildReply(rep) {
  return Buffer.concat([Buffer.from([SOCKS_VERSION, rep, 0x00, ATYP_IPV4]), BND_IPV4_ANY]);
}

// 凭据有效性（F1 fail-closed 判据）：用户名与口令均非空才算「有效凭据」。
// auth.enabled=true 但凭据无效时 → 拒绝一切认证尝试（绝不 fail-open）。
function hasValidCredentials(auth) {
  const user = auth && auth.username != null ? String(auth.username) : '';
  const pass = auth && auth.password != null ? String(auth.password) : '';
  return user.length > 0 && pass.length > 0;
}

// 认证失败的诊断转写：只给长度与偏移，**绝不包含任何口令字节**（F5，brief §5.5 边界）
function authFrameShape(ulen, plen, total) {
  return `sub-negotiation VER/ULEN/PLEN ok; usernameLen=${ulen} passwordLen=${plen} msgBytes=${total}; payload masked (no credential bytes logged)`;
}

// 增量报文读取（F4 修复）：把 socket 收到的数据累积到 socket.readBuffer，
// 按「声明长度」精确取字节；同段 TCP 粘连（greeting+auth / auth+CONNECT 同一 chunk）不再丢字节。
function socketReader(socket) {
  if (!socket.readBuffer) socket.readBuffer = Buffer.alloc(0);
  return {
    get pending() {
      return Buffer.from(socket.readBuffer);
    },
    take(need) {
      const out = socket.readBuffer.subarray(0, need);
      socket.readBuffer = socket.readBuffer.subarray(need);
      return out;
    },
    waitData(timeoutMs = 30000) {
      return Promise.race([
        new Promise((resolve) => socket.once('data', resolve)),
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), timeoutMs);
          if (typeof timer.unref === 'function') timer.unref();
        })
      ]);
    },
    async readExact(need, timeoutMs = 30000) {
      while (socket.readBuffer.length < need) {
        const chunk = await this.waitData(timeoutMs);
        if (chunk === null) return null; // 超时：调用方按「报文不完整」处理并关闭连接
        socket.readBuffer = Buffer.concat([socket.readBuffer, chunk]);
      }
      return this.take(need);
    }
  };
}

class Socks5Proxy {
  // 第二参数可选（接口契约：缺省保持 new Socks5Proxy(tunnel) 的既有行为）
  constructor(tunnel, options = {}) {
    this.tunnel = tunnel;
    this.auth = mergeConfig(DEFAULT_AUTH, options.auth || {});
    // F1 fail-closed 告警：开启认证但凭据无效时，明确告知已拒绝全部入站认证
    if (this.auth.enabled && !hasValidCredentials(this.auth)) {
      console.warn(
        'SOCKS5 告警: auth.enabled=true 但 username/password 未配置（空凭据）—— 已拒绝全部入站认证（fail-closed）'
      );
    }
  }

  async handleRequest(socket, data) {
    try {
      const reader = socketReader(socket);
      if (data && data.length) {
        socket.readBuffer = Buffer.concat([socket.readBuffer, data]);
      }

      // SOCKS5 握手：VER(0x05) NMETHODS METHODS...（按 NMETHODS 精确读取，容忍半包）
      const head = await reader.readExact(2);
      if (head === null || head[0] !== SOCKS_VERSION) {
        socket.end();
        return;
      }

      const authMethodsCount = head[1];
      const authMethods = authMethodsCount > 0 ? await reader.readExact(authMethodsCount) : Buffer.alloc(0);
      if (authMethods === null) {
        socket.end();
        return;
      }

      // 方法选择（RD-C3-01）：0x00 是「服务端不要求认证」的协商结果，不是「认证成功」
      //   auth.enabled=true  → 仅接受客户端 offer 的 0x02；未 offer 则 0xFF
      //   auth.enabled=false → 仅接受客户端 offer 的 0x00；未 offer 则 0xFF
      let authMethod = METHOD_NO_ACCEPTABLE;
      if (this.auth.enabled) {
        if (authMethods.includes(METHOD_USERPASS)) authMethod = METHOD_USERPASS;
      } else if (authMethods.includes(METHOD_NO_AUTH)) {
        authMethod = METHOD_NO_AUTH;
      }

      socket.write(Buffer.from([SOCKS_VERSION, authMethod]));

      if (authMethod === METHOD_NO_ACCEPTABLE) {
        // 无可接受的方法：按 RFC1928 关闭连接（不得留下半开 socket）
        socket.end();
        return;
      }

      // F4：不再用 once('data') 直接消费整块，改为按长度读取（见 handleAuth / handleConnect 内的 readExact）
      await (authMethod === METHOD_USERPASS ? this.handleAuth(socket) : this.handleConnect(socket));
    } catch (err) {
      console.error('SOCKS5 handshake error:', err.message);
      socket.end();
    }
  }

  // 校验 RFC1929 用户名/密码：先判「凭据是否已配置」（F1 fail-closed），再做常量时间比较
  verifyCredentials(username, password) {
    // enabled=true 但配置的凭据无效（任一为空）→ 拒绝一切尝试，绝不 fail-open
    if (!hasValidCredentials(this.auth)) return false;

    const expectedUser = String(this.auth.username);
    const expectedPass = String(this.auth.password);
    const userOk = constantTimeEqual(Buffer.from(username, 'utf8'), Buffer.from(expectedUser, 'utf8'));
    const passOk = constantTimeEqual(Buffer.from(password, 'utf8'), Buffer.from(expectedPass, 'utf8'));
    return userOk && passOk;
  }

  async handleAuth(socket) {
    try {
      const reader = socketReader(socket);

      // RFC1929 子协商：VER(0x01) ULEN UNAME PLEN PASSWD（分步按长度读取）
      const authHead = await reader.readExact(2);
      // F8：子协商层 VER 非法 → 回 01 01（0x08 属 SOCKS 请求层错误码，层次不对）
      if (authHead === null || authHead[0] !== AUTH_VERSION) {
        console.warn(`SOCKS5 auth failed: bad sub-negotiation VER=${authHead ? authHead[0] : 'no-data'} reply=01 01`);
        this.rejectAuth(socket);
        return;
      }

      const ulen = authHead[1];
      const userBytes = ulen > 0 ? await reader.readExact(ulen) : Buffer.alloc(0);
      if (userBytes === null) {
        console.warn(`SOCKS5 auth failed: incomplete username (declaredLen=${ulen}) reply=01 01`);
        this.rejectAuth(socket);
        return;
      }
      const username = userBytes.toString('utf8');

      const plenByte = await reader.readExact(1);
      if (plenByte === null) {
        console.warn('SOCKS5 auth failed: missing PLEN reply=01 01');
        this.rejectAuth(socket);
        return;
      }
      const plen = plenByte[0];
      const passBytes = plen > 0 ? await reader.readExact(plen) : Buffer.alloc(0);
      if (passBytes === null) {
        console.warn(`SOCKS5 auth failed: incomplete password (declaredLen=${plen}) reply=01 01`);
        this.rejectAuth(socket);
        return;
      }
      const password = passBytes.toString('utf8');

      // 诊断只记录长度与掩码说明（F5）：MUST NOT 记录任何口令字节
      console.info(`SOCKS5 auth frame: ${authFrameShape(ulen, plen, 2 + ulen + 1 + plen)}`);

      // 日志只记录用户名与结果码；MUST NOT 落明文口令
      if (!this.verifyCredentials(username, password)) {
        console.warn(`SOCKS5 auth failed: user="${username}" reply=01 01 (connection closed, fail-closed)`);
        this.rejectAuth(socket);
        return;
      }

      console.info(`SOCKS5 auth ok: user="${username}" reply=01 00`);
      socket.write(Buffer.from([AUTH_VERSION, 0x00]));

      // 认证通过后进入连接请求阶段（同段粘连的 CONNECT 字节已在 readBuffer 中，不会被丢）
      await this.handleConnect(socket);
    } catch (err) {
      console.error('SOCKS5 auth error:', err.message);
      this.rejectAuth(socket);
    }
  }

  // 认证/协商失败统一路径（RD-C3-02）：先确保 01 01 两字节 flush，再优雅 end()
  // 禁止未 flush 就 destroy()：那会发 RST，客户端可能读到 ECONNRESET 而非 01 01
  rejectAuth(socket) {
    socket.on('error', () => {});
    socket.write(Buffer.from([AUTH_VERSION, 0x01]), () => {
      socket.end();
    });
  }

  async handleConnect(socket) {
    try {
      const reader = socketReader(socket);

      // 解析连接请求：VER CMD RSV ATYP DST.ADDR DST.PORT（按 ATYP 分步读，F4）
      const head = await reader.readExact(4);
      if (head === null || head[0] !== SOCKS_VERSION) {
        socket.end();
        return;
      }

      const command = head[1]; // 0x01: CONNECT, 0x02: BIND, 0x03: UDP ASSOCIATE

      if (command !== CMD_CONNECT) {
        // 不支持 BIND 与 UDP ASSOCIATE
        socket.end(buildReply(REP_COMMAND_NOT_SUPPORTED));
        return;
      }

      const atyp = head[3];
      let addressBytes = null;
      let portBytes = null;
      if (atyp === ATYP_IPV4) {
        addressBytes = await reader.readExact(4);
        portBytes = await reader.readExact(2);
      } else if (atyp === ATYP_DOMAIN) {
        const lenByte = await reader.readExact(1);
        if (lenByte !== null && lenByte[0] > 0) {
          const domainBody = await reader.readExact(lenByte[0]);
          if (domainBody !== null) {
            addressBytes = Buffer.concat([lenByte, domainBody]);
            portBytes = await reader.readExact(2);
          }
        }
      } else if (atyp === ATYP_IPV6) {
        addressBytes = await reader.readExact(16);
        portBytes = await reader.readExact(2);
      }

      if (addressBytes === null || portBytes === null) {
        // 报文不完整或地址非法
        socket.end(buildReply(REP_ATYP_NOT_SUPPORTED));
        return;
      }

      const request = Buffer.concat([head, addressBytes, portBytes]);
      const target = parseAddress(request);
      if (!target || !target.host) {
        // ATYP 不受支持才回 0x08（仅对真正不支持的地址类型生效）
        socket.end(buildReply(REP_ATYP_NOT_SUPPORTED));
        return;
      }

      // 隧道抽象：按配置注入的隧道类型（SSH / 上游 SOCKS5）建立连接，地址按 ATYP 解析结果原文透传
      const stream = await this.tunnel.forwardOut('localhost', 0, target.host, target.port);

      // 发送成功响应（BND.ADDR=0.0.0.0:0）
      socket.write(buildReply(REP_SUCCEEDED));

      // 双向管道传输数据
      socket.pipe(stream, { end: true });
      stream.pipe(socket, { end: true });

      // 添加连接关闭事件处理，确保资源释放
      let socketClosed = false;
      let streamClosed = false;

      const closeHandler = () => {
        if (!socketClosed) {
          socketClosed = true;
          socket.end();
        }
        if (!streamClosed) {
          streamClosed = true;
          stream.end();
        }
      };

      socket.on('close', closeHandler);
      stream.on('close', closeHandler);
      socket.on('error', closeHandler);
      stream.on('error', closeHandler);

    } catch (err) {
      console.error('SOCKS5 connect error:', err.message);
      // 发送失败响应（沿用 0x05 连接被拒绝口径）
      socket.end(buildReply(REP_CONNECTION_REFUSED));
    }
  }
}

export default Socks5Proxy;
