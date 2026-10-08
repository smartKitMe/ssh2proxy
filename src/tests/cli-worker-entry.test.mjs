/**
 * cli-worker-entry.test.mjs —— 构建产物 CLI 入口的 worker 线程守卫回归
 *
 * 背景（本轮实测）：worker 线程的 `process.argv` 只有 `[execPath, workerFile]`，CLI 参数被丢弃
 * （实测 `new Worker(new URL(import.meta.url))` → worker 侧 `argv=["node","<workerFile>"]`）；
 * 而 `WorkerManager` 的 `workerPath` 默认是 `new URL(import.meta.url)`，在 `dist/cli.js` 形态下
 * 就等于 CLI 自身 ⇒ worker 里 `argv[1] === import.meta.url`，仅凭路径比较（isDirectRun）会判定
 * 「直接运行」，于是**每个 worker 都再启动一整套默认配置的代理服务**。实测症状：
 * `Starting SSH2Proxy with options: {}` 反复出现（10 次）、worker 抢占 `:::8080` / `:::1080`、
 * 对 `localhost:22` 反复 ECONNREFUSED（日志以 ~1.6 KB/s 增长、4000+ 行）。
 *
 * 断言（正负双向，避免「把 worker 的活一起关掉」的假修）：
 *  ① 反向：worker 加载 `dist/cli.js` 后 MUST NOT 执行 CLI 入口
 *     （无 `Starting SSH2Proxy`、无 `Proxy server started successfully`）；
 *  ② 正向：worker 仍须作为任务线程工作 —— 按 `{taskId, type, payload}` 协议请求 `renderPac`，
 *     须返回 `{taskId, ok: true, result}` 且 `result` 含 `FindProxyForURL`。
 *
 * `dist/` 缺失时跳过：未构建的干净检出上 `npm test` 仍应为绿。
 */
import { describe, it } from 'mocha';
import { expect } from 'chai';
import { once } from 'events';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const distCli = path.join(repoRoot, 'dist', 'cli.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('构建产物 CLI 入口守卫（worker 线程不得再跑一遍 CLI）', function () {
  this.timeout(60000);

  it('worker 不执行 CLI 入口，但仍响应 renderPac 任务', async function () {
    if (!fs.existsSync(distCli)) {
      this.skip();
    }

    const chunks = [];
    const worker = new Worker(distCli, { stdout: true, stderr: true });
    worker.stdout.setEncoding('utf8');
    worker.stderr.setEncoding('utf8');
    worker.stdout.on('data', (c) => chunks.push(c));
    worker.stderr.on('data', (c) => chunks.push(c));

    try {
      await once(worker, 'online');

      // 正向：worker 仍是可用任务线程（协议与 WorkerManager.dispatchToWorker 一致）
      const taskId = 1;
      const replyPromise = once(worker, 'message').then(([msg]) => msg);
      worker.postMessage({
        taskId,
        type: 'renderPac',
        payload: { name: null, renderProxy: 'SOCKS5 127.0.0.1:1999; SOCKS 127.0.0.1:1999; DIRECT' },
      });
      const reply = await replyPromise;

      // 给「误跑 CLI 入口」留出显形窗口（入口横幅在任何初始化之前就打印）
      await sleep(1500);
      const output = chunks.join('');

      // 反向：入口只属于主线程
      expect(output, `worker 不得执行 CLI 入口，实际输出：\n${output}`)
        .to.not.include('Starting SSH2Proxy with options');
      expect(output, `worker 不得启动代理服务，实际输出：\n${output}`)
        .to.not.include('Proxy server started successfully');

      // 正向断言
      expect(reply.taskId).to.equal(taskId);
      expect(reply.ok, JSON.stringify(reply)).to.equal(true);
      expect(reply.result).to.be.a('string');
      expect(reply.result).to.include('FindProxyForURL');
    } finally {
      await worker.terminate();
    }
  });
});
