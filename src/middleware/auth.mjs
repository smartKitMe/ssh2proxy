import crypto from 'crypto';

/**
 * AuthMiddleware · HTTP 基本认证与管理端点凭证
 *
 * C3-07 接线状态登记（逐项处置见 handoff/known_issues.md §5）。
 * 未接线项的接线点在 `src/app.mjs`（C3 的禁区，不得越界改动）：
 *   - `basicAuth`                 → 已由 C4 接线（审查门 F6 裁定；接线点 app.mjs 的 HTTP 挂载链）
 *   - `generateAdminCredentials`  → **已接线**（C4 完成）：app.mjs:76、app.mjs:372 已真实调用
 *   - `generateRandomPassword`    → **已接线**：本文件 `generateAdminCredentials` 内部消费者
 *
 * F10（2026-09-16 复审）：凭据比较改为**恒定时间**（HMAC-SHA256 归一 + `crypto.timingSafeEqual`），
 * 与 SOCKS5 侧同一口径；并修复「口令含 ':' 被截断」与「空配置凭据 fail-open」两处同类缺陷。
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

      const base64Credentials = authHeader.slice('Basic '.length).trim();
      const credentials = Buffer.from(base64Credentials, 'base64').toString('utf8');

      // 只在**第一个** ':' 处切分：口令本身含 ':' 时不再被截断（原实现 split(':') 会丢尾部）
      const separatorIndex = credentials.indexOf(':');
      if (separatorIndex === -1) {
        this.sendUnauthorized(res);
        return;
      }
      const username = credentials.slice(0, separatorIndex);
      const password = credentials.slice(separatorIndex + 1);

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
