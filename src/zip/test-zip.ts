// test file
// load .env → call function → print whatever the integration returns

/*
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


import "dotenv/config";
import { getRequestById } from "./zip.service";

async function main() {
  const request = await getRequestById(
    "10cbc01e-ec9a-8500-89a0-1e8908b98ed6"
  );

  console.log("Single request from Zip:");
  console.log(JSON.stringify(request, null, 2));
}

main().catch(console.error);
*/

/*
import "dotenv/config";
import { executeAction } from "./zip.service";

async function main() {
  const result = await executeAction({
    type: "APPROVE",
    requestId: "10cbc01e-ec9a-8500-89a0-1e8908b98ed6",
  });

  console.log("Action result:");
  console.log(result);
}

main().catch(console.error);

*/

import "dotenv/config";
import { executeAction } from "./zip.service";

async function main() {
  const result = await executeAction({
    type: "DENY",
    requestId: "10cc3574-3442-8780-89a0-1e890a4827d2",
  });

  console.log("DENY result:");
  console.log(result);
}

main().catch(console.error);