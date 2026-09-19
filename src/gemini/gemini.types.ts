// Types private to the Gemini layer. Shared team contracts live in src/types.

/**
 * Real names seen in current Zip data, passed to Gemini so it can return the
 * exact spelling Zip uses (e.g. "AI" -> "Artificial Intelligence").
 * Matching in orchestration stays exact; these are only hints.
 */
export interface IntentContext {
  knownVendors?: string[];
  knownCategories?: string[];
}

/** Minimal subset of Gemini's OpenAPI-style response schema that we use. */
export interface GeminiSchema {
  type: "OBJECT" | "STRING" | "NUMBER" | "BOOLEAN" | "ARRAY";
  description?: string;
  enum?: string[];
  nullable?: boolean;
  properties?: Record<string, GeminiSchema>;
  items?: GeminiSchema;
  required?: string[];
  propertyOrdering?: string[];
}

/** Minimal subset of the generateContent response body that we read. */
export interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
    finishReason?: string;
  }>;
}
