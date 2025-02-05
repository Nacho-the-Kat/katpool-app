import Monitoring from "../monitoring";

interface QueueItem {
  txnId: string;
  minerReward: bigint;
  poolAddress: string;
  retries: number;
}

const monitoring = new Monitoring();

class TransactionQueue {
  private queue: QueueItem[] = [];
  private processingSet = new Set<string>(); // Track active transactions

  add(txnId: string, minerReward: bigint, poolAddress: string) {
    if (!this.processingSet.has(txnId)) {
      this.queue.push({ txnId, minerReward, poolAddress, retries: 0 }); // Start with 0 retries
      this.processingSet.add(txnId);
    }
  }

  getBatch(batchSize: number) {
    if (this.queue.length === 0) {
      monitoring.log("Queue is empty. Waiting...");
      return [];
    }

    const batch = this.queue.splice(0, batchSize);
    batch.forEach(({ txnId }) => this.processingSet.delete(txnId)); // Remove from tracking on fetch
    return batch;
  }

  incrementRetry(txnId: string): boolean {
    const item = this.queue.find(item => item.txnId === txnId);
    if (item) {
      item.retries++;
      if (item.retries >= 5) { // Maximum retries
        monitoring.log(`Max retries reached for ${txnId}. Removing from queue.`);
        this.remove(txnId);
        return false; // No more retries allowed
      }
      return true; // Retry allowed
    }
    return false;
  }

  remove(txnId: string) {
    this.queue = this.queue.filter(item => item.txnId !== txnId);
    this.processingSet.delete(txnId);
  }

  isEmpty() {
    return this.queue.length === 0;
  }
}

export const txnQueue = new TransactionQueue();
