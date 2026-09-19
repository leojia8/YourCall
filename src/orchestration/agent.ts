import type { IncomingMessage } from "../types";

// TEMPORARY DEV STUB (added by Person 1 so the Linq layer can be tested alone).
// PERSON 3: overwrite this whole file with the real handleMessage(); keep the
// signature below, since src/linq/linq.routes.ts imports it from here.
export async function handleMessage(message: IncomingMessage): Promise<string> {
  // The Linq layer delivers a thumbs-down tapback as the text "reject".
  if (message.text === "reject") return "i hate you";
  return "hello back";
}
