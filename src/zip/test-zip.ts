// test file
// load .env → call function → print whatever the integration returns

import "dotenv/config";
import { getPendingRequests } from "./zip.service";

async function main() {
  try {
    const requests = await getPendingRequests();

    console.log("Purchase requests from Zip:");
    console.log(JSON.stringify(requests, null, 2));
  } catch (error) {
    console.error("Failed to fetch Zip requests:");
    console.error(error);
  }
}

main();