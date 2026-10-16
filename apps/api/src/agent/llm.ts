/**
 * Interfaz propia sobre el LLM para poder cambiar de modelo por tenant sin tocar el agente.
 * Implementación actual: Gemini (REST generateContent, function calling).
 */
export interface ToolDecl {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema (subset OpenAPI de Gemini)
}

export type Part =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

export interface Content {
  role: "user" | "model";
  parts: Part[];
}

export interface LlmResult {
  parts: Part[];
  calls: { name: string; args: Record<string, unknown> }[];
  text: string;
}

export async function generate(
  apiKey: string,
  model: string,
  system: string,
  contents: Content[],
  tools: ToolDecl[],
): Promise<LlmResult> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      tools: [{ functionDeclarations: tools }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 800 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { candidates?: { content?: { parts?: Part[] } }[] };
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  return {
    parts,
    calls: parts.flatMap((p) => ("functionCall" in p ? [p.functionCall] : [])),
    text: parts.flatMap((p) => ("text" in p ? [p.text] : [])).join("").trim(),
  };
}
