import axios, { AxiosError } from 'axios';
import Monitoring from "../monitoring"
import { DEBUG } from "../../index"
import config from "../../config/config.json";

const monitoring = new Monitoring();

let KASPA_BASE_URL = 'https://api.kaspa.org';

if( config.network === "testnet-10" ) {
 KASPA_BASE_URL = "https://api-tn10.kaspa.org"
} else if( config.network === "testnet-11" ) {
 KASPA_BASE_URL = "https://api-tn11.kaspa.org"
}

export async function fetchBlockHashAndDaaScore(txnId: string) {    
    let block_hash: string = 'block_hash_placeholder'
    let daaScoreF = '0' // Needs to be removed later
    let reward_block_hash = ''
    // Fetch reward hash
    try {
      const response = await axios.get(`${KASPA_BASE_URL}/transactions/${txnId}?inputs=false&outputs=false&resolve_previous_outpoints=no`, {
        timeout: 5000, // Timeout for safety
      });
      
      if (response?.status !== 200 && !response?.data) {
        monitoring.error(`Unexpected status code: ${response.status}`);
        monitoring.error(`Invalid or missing block hash in response data for transaction ${txnId}`);
      } else {
        reward_block_hash = response.data.block_hash[0] // Reward block hash
      }
    } catch (error) {
      handleError(error, `Fetching reward block hash for transaction ${txnId}`);
    }

    // Fetch actual block hash
    try {
      const response = await axios.get(`${KASPA_BASE_URL}/blocks/${reward_block_hash}?includeColor=false`, {
        timeout: 5000, // Timeout for safety
      });
      
      if (response?.status !== 200 && !response?.data) {
        monitoring.error(`Unexpected status code: ${response.status}`);
        monitoring.error(`Invalid or missing block hash in response data for transaction ${txnId}`);
      } else {
        let block_hashes = response.data.verboseData.mergeSetBluesHashes
        for (const hash of block_hashes) {
          try {
            const response = await axios.get(`${KASPA_BASE_URL}/blocks/${hash}?includeColor=false`, {
              timeout: 5000, // Timeout for safety
            });
            
            const targetPattern = /\/Katpool$/;
            if (response?.status !== 200 && !response?.data) {
              monitoring.error(`Unexpected status code: ${response.status}`);
              monitoring.error(`Invalid or missing block hash in response data for transaction ${txnId}`);
            } else if (response?.status === 200 && response?.data && targetPattern.test(response.data.extra.minerInfo)) {              
              // Fetch details for the block hash where miner info matches
              block_hash = hash
              daaScoreF = response.data.header.daaScore
              break    
            } else if (response?.status === 200 && response?.data && !targetPattern.test(response.data.extra.minerInfo)) {              
              continue
            } else {              
              monitoring.error(`Error Fetching block hash for transaction ${txnId}`)
            }
          } catch (error) {
            handleError(error, `Fetching block hash for transaction ${txnId}`);
          }      
        }
      }
    } catch (error) {
      handleError(error, `Fetching block hash for transaction ${txnId}`);
    }

  return { reward_block_hash, block_hash, daaScoreF }  
}

function handleError(error: unknown, context: string): void {
  if (error instanceof AxiosError) {
    monitoring.error(`API call failed: ${error.message}.`);
    monitoring.error(`${context}`);
    if (error.response) {
      monitoring.error(`Response status: ${error.response.status}`);
      if (DEBUG) monitoring.error(`Response data: ${JSON.stringify(error.response.data)}`);
    }
  } else {
    monitoring.error(`Unexpected error: ${error}`);
  }
} 