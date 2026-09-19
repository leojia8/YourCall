// The ONLY place orchestration gets Zip from.
// TODO(integration): when Person 2's service is ready, replace "./mock.zip" with
// "../zip/zip.service" (adjusting names if their exports differ). No schema changes needed.
export { getPendingRequests, getRequestById, executeAction } from "./mock.zip";
