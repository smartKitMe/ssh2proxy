import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';

class WorkerManager {
  constructor() {
    this.workers = [];
    this.taskQueue = [];
    this.isSupported = typeof Worker !== 'undefined';
  }

  isWorkerSupported() {
    return this.isSupported;
  }

  // 创建工作线程
  createWorker(workerPath) {
    if (!this.isSupported) {
      throw new Error('Worker threads are not supported in this environment');
    }

    const worker = new Worker(workerPath);
    this.workers.push(worker);
    return worker;
  }

  // 分配任务给工作线程
  assignTask(taskData) {
    return new Promise((resolve, reject) => {
      if (!this.isSupported || this.workers.length === 0) {
        // 如果不支持多线程或没有工作线程，则在主线程中执行
        reject(new Error('No workers available'));
        return;
      }

      // 简单的负载均衡：选择第一个可用的工作线程
      const worker = this.workers[0];
      
      // 为任务创建唯一ID
      const taskId = Date.now() + Math.random();
      
      // 监听工作线程的消息
      const handleMessage = (message) => {
        if (message.taskId === taskId) {
          worker.removeListener('message', handleMessage);
          worker.removeListener('error', handleError);
          resolve(message.result);
        }
      };
      
      const handleError = (error) => {
        worker.removeListener('message', handleMessage);
        worker.removeListener('error', handleError);
        reject(error);
      };
      
      worker.on('message', handleMessage);
      worker.on('error', handleError);
      
      // 发送任务到工作线程
      worker.postMessage({ taskId, ...taskData });
    });
  }

  // 关闭所有工作线程
  close() {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
  }
}

// 工作线程中的消息处理
if (!isMainThread) {
  parentPort.on('message', (data) => {
    // 这里应该根据任务类型处理不同的任务
    // 由于这是一个示例，我们只是简单地回传数据
    parentPort.postMessage({
      taskId: data.taskId,
      result: `Processed: ${JSON.stringify(data)}`
    });
  });
}

export default WorkerManager;