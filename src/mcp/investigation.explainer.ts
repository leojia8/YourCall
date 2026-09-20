import { generateJson } from "../gemini/gemini.service";
import type { GeminiSchema } from "../gemini/gemini.types";
import type { PurchaseRequest } from "../types";
import type { ZipInvestigation } from "./investigator";

const EXPLANATION_SCHEMA = {
  type: "object",
  properties: {
    explanation: {
      type: "string",
    },
  },
  required: ["explanation"],
  additionalProperties: false,
} as const;

interface ExplanationResponse {
  explanation: string;
}

export async function explainZipInvestigation(
  request: PurchaseRequest,
  investigation: ZipInvestigation,
  deterministicReason?: string
): Promise<string> {
  const prompt = `
You are YourCall, an enterprise procurement assistant communicating over iMessage.

Explain why this purchase request needs attention, or whether it actually does.

Rules:
- Be concise and conversational.
- Use only the provided data.
- Do not invent missing facts.
- Do not decide, approve, deny, or recommend an action.
- If the Zip approval data shows the request is already completed or approved,
  clearly say that it does not currently need approval.
- Prefer 1-3 short sentences suitable for a text message.

NORMALIZED REQUEST:
${JSON.stringify(request)}

DETERMINISTIC ATTENTION REASON:
${deterministicReason ?? "None provided"}

ZIP MCP REQUEST CONTEXT:
${JSON.stringify(investigation.request)}

ZIP MCP APPROVAL CONTEXT:
${JSON.stringify(investigation.approvals)}
`;

  const EXPLANATION_SCHEMA = {
    type: "OBJECT",
    properties: {
        explanation: {
        type: "STRING",
        },
    },
    required: ["explanation"],
    } satisfies GeminiSchema;

  const raw = await generateJson(prompt, EXPLANATION_SCHEMA);
  const parsed = JSON.parse(raw) as ExplanationResponse;

  if (
    typeof parsed.explanation !== "string" ||
    parsed.explanation.trim() === ""
  ) {
    throw new Error("Gemini returned an invalid investigation explanation");
  }

  return parsed.explanation.trim();
}