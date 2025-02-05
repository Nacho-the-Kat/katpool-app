import { DEBUG } from "../..";
import Monitoring from "../monitoring";
import { txnQueue } from "./queue";
import { Worker } from "worker_threads";

const monitoring = new Monitoring();

// Function to process the queue using worker threads
const processQueue = () => {
  if (txnQueue.isEmpty()) {
    monitoring.log("Queue is empty. Waiting...");
    return; // Prevents unnecessary worker creation
  }

  const batch = txnQueue.getBatch(5); // Fetch 5 transactions at a time

  batch.forEach(({ txnId, minerReward, poolAddress }) => {
    const worker = new Worker("./worker.ts", {
      workerData: { txnId, minerReward, poolAddress },
    });

    worker.on("message", (message) => {
      if (message.success) {
        if (DEBUG) monitoring.debug(`✅ Worker completed for txnId: ${txnId}`);
      } else {
        monitoring.error(`❌ Worker failed for txnId: ${txnId}, retrying...`);
        const retryAllowed = txnQueue.incrementRetry(txnId);
        if (!retryAllowed) {
          console.log(`Transaction ${txnId} removed after 5 failed attempts.`);
        }
      }
    });

    worker.on("error", (error) => {
      monitoring.error(`❌ Worker thread error: ${error.message}, for ${txnId}`);
      const retryAllowed = txnQueue.incrementRetry(txnId);
      if (!retryAllowed) {
        console.log(`Transaction ${txnId} removed after 5 failed attempts.`);
      }
    });

    worker.on("exit", (code) => {
      if (code !== 0) {
        monitoring.error(`❌ Worker stopped unexpectedly with exit code ${code}`);
        const retryAllowed = txnQueue.incrementRetry(txnId);
        if (!retryAllowed) {
          console.log(`Transaction ${txnId} removed after 5 failed attempts.`);
        }
      }
    });
  });
};

// Run the queue processor every 5 minutes
setInterval(processQueue, 300000);

// Function to add failed transactions manually (optional)
export const addTransactionToQueue = (txnId: string, minerReward: bigint, poolAddress: string) => {
  if (DEBUG) monitoring.debug(`Added to queue : ${txnId}`)
  txnQueue.add(txnId, minerReward, poolAddress);
};
