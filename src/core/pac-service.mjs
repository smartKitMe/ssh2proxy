import fs from 'fs/promises';

class PacService {
  constructor(config) {
    this.config = config;
  }

  async generatePacContent() {
    if (this.config.pac.content) {
      return this.config.pac.content;
    }

    if (this.config.pac.filePath) {
      try {
        return await fs.readFile(this.config.pac.filePath, 'utf8');
      } catch (err) {
        console.error('Failed to read PAC file:', err);
      }
    }

    // 生成默认PAC内容
    return `
function FindProxyForURL(url, host) {
  return "${this.config.pac.defaultProxy}";
}
`;
  }

  async handleRequest(req, res) {
    try {
      const pacContent = await this.generatePacContent();
      
      res.writeHead(200, {
        'Content-Type': 'application/x-ns-proxy-autoconfig',
        'Content-Length': Buffer.byteLength(pacContent)
      });
      
      res.end(pacContent);
    } catch (err) {
      console.error('PAC service error:', err);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  }
}

export default PacService;