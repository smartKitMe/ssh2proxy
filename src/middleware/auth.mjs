import crypto from 'crypto';

/**
 * Basic 凭据的**唯一真源**：解码（`base64` → `utf8`）+ 切分（首个 `':'`）。
 *
 * 为什么在此定义：本文件是认证语义的基准面（HTTP Basic + 管理端点凭证），且 `src/app.mjs` 已
 * `import AuthMiddleware from './middleware/auth.mjs'` ⇒ 反向 `import` 会造成循环依赖，
 * 故唯一真源落在本模块，由 `src/app.mjs` **具名导入**消费（T-4：口径由实现强制）。
 *
 * 口径（RFC 7617 §2.1，`charset="UTF-8"`）：
 *   - 解码 MUST 用 `'utf8'`（`'ascii'` 逐字节 `& 0x7F` 截为 7 位 ⇒ 非 ASCII 凭据被静默改写）；
 *   - 用户名 = **首个** `':'` 之前；口令 = **其余全部**（口令本身可含 `':'`）；
 *   - 无 `':'` / 非字符串 ⇒ 返回 `null`（不可解析 ⇒ 调用方 MUST fail-closed，不得放行）。
 *
 * 三处消费点（代理面 `validateAuth()`、管理端点 `/api/*` 中间件、本文件 `basicAuth()`）
 * MUST 共同消费本函数；**新增任何 Basic 解析点都必须消费本函数**，不得再写内联解码或 `split(':')`。
 *
 * @param {string} base64Credentials - base64 编码的 `user:pass` 原文（不含 `Basic ` 前缀）
 * @returns {{username: string, password: string}|null} 解析结果；不可解析时为 null
 */
export function parseBasicCredentials(base64Credentials) {
  if (typeof base64Credentials !== 'string') return null;
  const credentials = Buffer.from(base64Credentials, 'base64').toString('utf8');
  const separatorIndex = credentials.indexOf(':');
  if (separatorIndex === -1) return null;
  return {
    username: credentials.slice(0, separatorIndex),
    password: credentials.slice(separatorIndex + 1)
  };
}

/**
 * AuthMiddleware · HTTP 基本认证与管理端点凭证
 *
 * 接线状态（逐项实测）：
 *   - `basicAuth`                 → 已接线：`src/app.mjs` 的 HTTP 挂载链（代理认证中间件）
 *   - `generateAdminCredentials`  → 已接线：`ProxyServer#getAdminCredentials()`（`src/app.mjs`）真实调用
 *   - `generateRandomPassword`    → 已接线：本文件 `generateAdminCredentials` 内部消费者
 *
 * F10（2026-09-16 复审）：凭据比较改为**恒定时间**（HMAC-SHA256 归一 + `crypto.timingSafeEqual`），
 * 与 SOCKS5 侧同一口径；并修复「口令含 ':' 被截断」与「空配置凭据 fail-open」两处同类缺陷。
 *
 * D7-truth（T-2 + T-4）：Basic 凭据的**解码 + 切分**收敛为**唯一真源** `parseBasicCredentials()`（本文件导出）。
 * 此前三处口径不一致：`src/app.mjs` 两处用 `Buffer.from(x,'base64').toString('ascii')`，本文件用 `'utf8'` ——
 * `'ascii'` 逐字节 `& 0x7F` 截为 7 位（实测：`'ü'` 的 UTF-8 `0xC3 0xBC` ⇒ 两个字符 `'C'`+`'<'`，
 * 即 `"üser:pä:ss"` ⇒ `"C<ser:pC$:ss"`）⇒ 非 ASCII 凭据跨面漂移。现三处**共同消费**本函数，
 * 口径由**实现**强制（`import` 而非内联副本），不再靠注释维系。依据 RFC 7617 §2.1（`charset="UTF-8"`）。
 */

// 恒定时间比较：先以 HMAC-SHA256 把任意长度输入归一为定长摘要，再 timingSafeEqual。
// 好处：长度不等绝不抛异常，且不泄漏长度差异（与 src/core/socks-proxy.mjs 的 constantTimeEqual 同口径）。
const DIGEST_KEY = Buffer.from('ssh2proxy:http-basic-constant-time-compare:v1');
function constantTimeEqual(a, b) {
  const digestA = crypto.createHmac('sha256', DIGEST_KEY).update(String(a)).digest();
  const digestB = crypto.createHmac('sha256', DIGEST_KEY).update(String(b)).digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

// 有效凭据判据（fail-closed）：用户名与口令均非空
function hasValidCredentials(auth) {
  if (!auth) return false;
  const user = auth.username == null ? '' : String(auth.username);
  const pass = auth.password == null ? '' : String(auth.password);
  return user.length > 0 && pass.length > 0;
}

class AuthMiddleware {
  constructor(config) {
    this.config = config;
  }

  // Basic 认证配置（只读；缺省视为未启用）
  get authConfig() {
    return (this.config && this.config.auth) || {};
  }

  // 恒定时间校验 Basic 凭据（F10）：不抛异常，任何异常路径都返回 false
  verifyBasicCredentials(username, password) {
    const auth = this.authConfig;
    if (!hasValidCredentials(auth)) return false; // 配置无效 → 拒绝一切（fail-closed）
    const userOk = constantTimeEqual(username, auth.username);
    const passOk = constantTimeEqual(password, auth.password);
    return userOk && passOk;
  }

  // 统一 401 响应（无 WWW-Authenticate 之外的细节；不泄漏用户名/口令）
  sendUnauthorized(res) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Proxy Server"' });
    res.end('Unauthorized');
  }

  // HTTP基本认证中间件
  basicAuth(req, res, next) {
    // 如果未启用认证，则直接通过
    if (!this.authConfig.enabled) {
      next();
      return;
    }

    try {
      const authHeader = req && req.headers ? req.headers.authorization : null;

      if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Basic ')) {
        this.sendUnauthorized(res);
        return;
      }

      // 唯一真源：解码（utf8）+ 首个 ':' 切分（T-2/T-4；原为内联 6 行副本，口径靠注释维系）
      const parsed = parseBasicCredentials(authHeader.slice('Basic '.length).trim());
      if (!parsed) {
        // 无 ':'（或非字符串）⇒ 不可解析：fail-closed 拒绝，不得放行
        this.sendUnauthorized(res);
        return;
      }
      const { username, password } = parsed;

      if (this.verifyBasicCredentials(username, password)) {
        next();
      } else {
        this.sendUnauthorized(res);
      }
    } catch (err) {
      // 任何解析异常（畸形 base64 / 畸形头）都只回 401，绝不抛出到调用方
      console.error('Authentication error:', err.message);
      this.sendUnauthorized(res);
    }
  }

  // 生成随机密码
  generateRandomPassword(length = 16) {
    return crypto.randomBytes(length).toString('hex').slice(0, length);
  }

  // 生成管理端点凭证
  generateAdminCredentials() {
    const admin = (this.config && this.config.admin) || {};
    if (admin.username && admin.password) {
      return {
        username: admin.username,
        password: admin.password
      };
    }

    // 自动生成凭证
    const username = `admin_generated_${crypto.randomBytes(4).toString('hex')}`;
    const password = this.generateRandomPassword(20);
    
    return { username, password };
  }
}

// R4-a（审查门）：`constantTimeEqual` / `hasValidCredentials` **不导出**——它们只在本模块内使用，
// 改为模块内私有，避免出现「零消费者的导出」（原导出曾被 probe-exports 以 socks-proxy 的同名局部定义误判为 WIRED）。
export default AuthMiddleware;
