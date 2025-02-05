import { parentPort, workerData } from "worker_threads";
import Database from "./database";
import { fetchBlockHashAndDaaScore } from "./fetchBlockDetails";
import Monitoring from "../monitoring";

const monitoring = new Monitoring();

const main = async () => {
  if (!workerData) {
    monitoring.error("No data provided to worker");
    process.exit(1);
  }

  const { txnId, minerReward, poolAddress } = workerData;

  try {
    let { reward_block_hash, block_hash, daaScoreF } =
      await fetchBlockHashAndDaaScore(txnId);
      
    const database = new Database(process.env.DATABASE_URL || "");
    await database.addBlockDetails(
      block_hash,
      "",
      reward_block_hash,
      "",
      daaScoreF,
      poolAddress,
      minerReward
    );

    // Notify the main thread of success
    parentPort?.postMessage({ success: true });
  } catch (error) {
    monitoring.error(`Worker error: ${error}`);
    // Notify the main thread of failure
    parentPort?.postMessage({ success: false, error: error, txnId, minerReward, daaScoreF :'0' });
  }
};

main();
