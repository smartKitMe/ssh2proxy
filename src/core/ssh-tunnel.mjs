import { Client } from 'ssh2';
import { EventEmitter } from 'events';

class SSHTunnel extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.client = new Client();
    this.isConnected = false;
    this.retryCount = 0;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.client.on('ready', () => {
        this.isConnected = true;
        this.retryCount = 0;
        this.emit('connect');
        resolve();
      });

      this.client.on('error', (err) => {
        this.isConnected = false;
        this.emit('error', err);
        
        // 实现重试机制
        if (this.retryCount < this.config.retryAttempts) {
          this.retryCount++;
          setTimeout(() => {
            this.connect().then(resolve).catch(reject);
          }, this.config.retryDelay);
        } else {
          reject(err);
        }
      });

      this.client.on('close', () => {
        this.isConnected = false;
        this.emit('close');
      });

      this.client.on('end', () => {
        this.isConnected = false;
        this.emit('end');
      });

      try {
        this.client.connect({
          host: this.config.host,
          port: this.config.port,
          username: this.config.username,
          password: this.config.password || undefined,
          privateKey: this.config.privateKey || undefined,
          passphrase: this.config.passphrase || undefined,
          keepaliveInterval: this.config.keepaliveInterval
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  forwardOut(srcIP, srcPort, dstIP, dstPort) {
    return new Promise((resolve, reject) => {
      if (!this.isConnected) {
        reject(new Error('SSH connection is not established'));
        return;
      }

      this.client.forwardOut(srcIP, srcPort, dstIP, dstPort, (err, stream) => {
        if (err) {
          reject(err);
        } else {
          resolve(stream);
        }
      });
    });
  }

  close() {
    if (this.client) {
      this.client.end();
    }
    this.isConnected = false;
  }
}

export default SSHTunnel;