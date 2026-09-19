// Shared contracts between the Linq, orchestration, and Zip layers.
// DO NOT rename these fields; other teammates depend on them.

/** A message received from the user, normalized so nothing Linq-specific leaks. */
export interface IncomingMessage {
  conversationId: string;
  sender: string;
  text: string;
}

/** A message we want delivered back to the user's conversation. */
export interface OutgoingMessage {
  conversationId: string;
  text: string;
}
