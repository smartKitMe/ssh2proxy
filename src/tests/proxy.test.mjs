import { describe, it } from 'mocha';
import { expect } from 'chai';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import ProxyServer from '../app.mjs';
import defaultConfig from '../config/default.config.mjs';
import { mergeConfig } from '../utils/helpers.mjs';

// 获取当前文件的目录路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('SSH2Proxy', () => {
  describe('ProxyServer', () => {
    it('should be able to create a ProxyServer instance', () => {
      const server = new ProxyServer(defaultConfig);
      expect(server).to.be.an.instanceOf(ProxyServer);
    });
    
    it('should have required properties', () => {
      const server = new ProxyServer(defaultConfig);
      expect(server).to.have.property('config');
      expect(server).to.have.property('connectionPool');
      expect(server).to.have.property('start');
      expect(server).to.have.property('stop');
    });
  });
  
  describe('Configuration', () => {
    it('should have default configuration', () => {
      expect(defaultConfig).to.be.an('object');
      expect(defaultConfig).to.have.property('ssh');
      expect(defaultConfig).to.have.property('proxy');
      expect(defaultConfig).to.have.property('pac');
    });
    
    it('should have valid proxy ports', () => {
      expect(defaultConfig.proxy.httpPort).to.be.a('number');
      expect(defaultConfig.proxy.socksPort).to.be.a('number');
    });
    
    it('should merge configurations correctly', () => {
      const userConfig = {
        ssh: {
          host: 'test-server.com',
          port: 2222
        },
        proxy: {
          httpPort: 9090
        }
      };
      
      const merged = mergeConfig(defaultConfig, userConfig);
      
      // 应该保留默认值
      expect(merged.ssh.username).to.equal(defaultConfig.ssh.username);
      
      // 应该使用用户配置的值
      expect(merged.ssh.host).to.equal('test-server.com');
      expect(merged.ssh.port).to.equal(2222);
      expect(merged.proxy.httpPort).to.equal(9090);
    });
  });
  
  describe('SSH Private Key', () => {
    it('should read private key from file', async () => {
      // 创建一个临时的私钥文件用于测试
      const testKeyPath = `${__dirname}/test-key`;
      const testKeyContent = '-----BEGIN OPENSSH PRIVATE KEY-----\ntest-key-content\n-----END OPENSSH PRIVATE KEY-----';
      
      try {
        // 写入测试私钥文件
        await fs.writeFile(testKeyPath, testKeyContent);
        
        // 模拟CLI中的私钥读取功能
        const readPrivateKeyFile = async (privateKeyPath) => {
          try {
            return await fs.readFile(privateKeyPath, 'utf8');
          } catch (err) {
            throw new Error(`Failed to read private key file: ${err.message}`);
          }
        };
        
        // 读取私钥内容
        const keyContent = await readPrivateKeyFile(testKeyPath);
        
        // 验证读取的内容
        expect(keyContent).to.equal(testKeyContent);
      } finally {
        // 清理测试文件
        try {
          await fs.unlink(testKeyPath);
        } catch (err) {
          // 忽略删除错误
        }
      }
    });
    
    it('should handle non-existent private key file gracefully', async () => {
      const readPrivateKeyFile = async (privateKeyPath) => {
        try {
          return await fs.readFile(privateKeyPath, 'utf8');
        } catch (err) {
          throw new Error(`Failed to read private key file: ${err.message}`);
        }
      };
      
      try {
        await readPrivateKeyFile(`${__dirname}/non-existent-key`);
        // 如果没有抛出错误，测试失败
        expect.fail('Expected to throw an error for non-existent file');
      } catch (err) {
        expect(err.message).to.include('Failed to read private key file');
      }
    });
  });
});