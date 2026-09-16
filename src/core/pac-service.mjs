import fs from 'fs/promises';
import path from 'path';

const PAC_CONTENT_TYPE = 'application/x-ns-proxy-autoconfig';

/**
 * PAC 服务：默认 PAC 内容 + 多 PAC 文件按名装载（D-015/D-105）
 *
 * 多 PAC 入口键（MUST 与 known_issues.md 一致）：
 *   ① `config.pac.files`：`{ '<请求名>': '<文件路径>' }` 显式映射；
 *   ② `config.pac.directory`：目录 + 请求名拼路径（含路径穿越防护）；
 *   ③ `config.pac.filePath`：单文件兼容（请求名等于其 basename 时命中）；指向目录时按 ② 处理。
 * 未命中即 404（MUST NOT 用默认内容冒充，D-105 的原症状正是任意名返回同一份）。
 *
 * 内容端口（D-119 / co-002）：PAC 中的回环代理端口 MUST 取自 `config.proxy.socksPort`（单一来源），
 * 模板中的历史端口（见 default.config.mjs 的 defaultProxy 默认值）一律归一化到真实监听端口，避免与实际入站端口漂移。
 */
class PacService {
  constructor(config) {
    this.config = config;
  }

  /**
   * 按名解析 PAC 文件绝对路径
   * @param {string|null} name - `/pac/:name` 的路径参数
   * @returns {Promise<string|null>} 文件绝对路径；未命中返回 null
   */
  async resolvePacFile(name) {
    const pac = (this.config && this.config.pac) || {};
    if (!name) {
      return null;
    }

    const requested = String(name);

    // 路径穿越防护：只接受单段文件名
    if (requested.includes('/') || requested.includes('\\') || requested.includes('..') || requested.includes('\0')) {
      return null;
    }

    // ① 显式映射
    if (pac.files && typeof pac.files === 'object' && !Array.isArray(pac.files)) {
      const mapped = pac.files[requested];
      if (typeof mapped === 'string' && mapped) {
        const resolved = path.resolve(mapped);
        if (await this.isFile(resolved)) {
          return resolved;
        }
        return null;
      }
    }

    // ② 目录装载（pac.directory，或 pac.filePath 指向目录时）
    const directories = [];
    if (typeof pac.directory === 'string' && pac.directory) {
      directories.push(pac.directory);
    }
    if (typeof pac.filePath === 'string' && pac.filePath && (await this.isDirectory(pac.filePath))) {
      directories.push(pac.filePath);
    }

    for (const directory of directories) {
      const base = path.resolve(directory);
      const candidate = path.resolve(base, requested);
      // 二次防护：解析结果 MUST 仍在 base 之内
      if (!candidate.startsWith(base + path.sep)) {
        continue;
      }
      if (await this.isFile(candidate)) {
        return candidate;
      }
    }

    // ③ 单文件兼容
    if (typeof pac.filePath === 'string' && pac.filePath && !(await this.isDirectory(pac.filePath))) {
      const resolved = path.resolve(pac.filePath);
      if (path.basename(resolved) === requested && (await this.isFile(resolved))) {
        return resolved;
      }
    }

    return null;
  }

  /**
   * 生成 PAC 内容
   * @param {string|null} name - 请求的 PAC 名（无则返回默认 PAC）
   * @returns {Promise<string|null>} 内容；按名未命中返回 null（由调用方回 404）
   */
  async generatePacContent(name = null) {
    const pac = (this.config && this.config.pac) || {};

    if (name) {
      const file = await this.resolvePacFile(name);
      if (!file) {
        return null;
      }
      return await fs.readFile(file, 'utf8');
    }

    if (pac.content) {
      return pac.content;
    }

    if (pac.filePath && !(await this.isDirectory(pac.filePath))) {
      const resolved = path.resolve(pac.filePath);
      if (await this.isFile(resolved)) {
        return await fs.readFile(resolved, 'utf8');
      }
    }

    return this.buildDefaultPacContent();
  }

  /**
   * 默认 PAC 内容：代理串由 config.proxy.socksPort 动态生成
   * @returns {string} PAC 文件内容
   */
  buildDefaultPacContent() {
    const host = '127.0.0.1';
    const proxy = (this.config && this.config.proxy) || {};
    const socksPort = proxy.socksPort;
    const template = (this.config && this.config.pac && this.config.pac.defaultProxy)
      ? this.config.pac.defaultProxy
      : `SOCKS5 ${host}:${socksPort}; SOCKS ${host}:${socksPort}; DIRECT`;

    const proxyList = String(template)
      .replace(/\{socksPort\}/g, String(socksPort))
      .replace(/\{httpPort\}/g, String(proxy.httpPort))
      .replace(/\{host\}/g, host)
      .replace(/127\.0\.0\.1:\d+/g, `${host}:${socksPort}`);

    return `
function FindProxyForURL(url, host) {
  return "${proxyList}";
}
`;
  }

  /**
   * Express 路由处理器（/proxy.pac 与 /pac/:name 共用）
   * @param {import('express').Request} req - 请求对象（/:name 路由下 req.params.name 为 PAC 名）
   * @param {import('express').Response} res - 响应对象
   */
  async handleRequest(req, res) {
    const name = req && req.params ? req.params.name : null;

    try {
      const pacContent = await this.generatePacContent(name);

      if (pacContent === null) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('PAC file not found');
        return;
      }

      res.writeHead(200, {
        'Content-Type': PAC_CONTENT_TYPE,
        'Content-Length': Buffer.byteLength(pacContent)
      });

      res.end(pacContent);
    } catch (err) {
      console.error('PAC service error:', err);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  }

  async isFile(target) {
    try {
      const stats = await fs.stat(target);
      return stats.isFile();
    } catch (err) {
      return false;
    }
  }

  async isDirectory(target) {
    try {
      const stats = await fs.stat(target);
      return stats.isDirectory();
    } catch (err) {
      return false;
    }
  }
}

export default PacService;
