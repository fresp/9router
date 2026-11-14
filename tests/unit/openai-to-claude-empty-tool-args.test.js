// An OpenAI-format client replays the assistant turn it received. For a tool that takes no
// arguments the replayed `function.arguments` is "" (that is what the Claude→OpenAI stream
// emits), and for a cut-off stream it is broken JSON. Both used to be forwarded to Claude as a
// string and the whole request was rejected:
//   400 messages.N.content.0.tool_use.input: Input should be an object
import { describe, it, expect } from "vitest";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";

const request = (args) => ({
  messages: [
    { role: "user", content: "list the files" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "list_files", arguments: args } }] },
    { role: "tool", tool_call_id: "call_1", content: "a.js" },
  ],
  tools: [{ type: "function", function: { name: "list_files", description: "List files", parameters: { type: "object", properties: {} } } }],
});

const toolUseInput = (args) => {
  const out = openaiToClaudeRequest("claude-opus-5-5", request(args), true);
  const block = out.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.type === "tool_use");
  return block.input;
};

describe("openaiToClaudeRequest — tool_use input is always an object", () => {
  it("turns empty arguments into an empty object", () => {
    expect(toolUseInput("")).toEqual({});
  });
  it("turns unparseable arguments into an empty object", () => {
    expect(toolUseInput('{"path": "a')).toEqual({});
  });
  it("turns non-object JSON into an empty object", () => {
    expect(toolUseInput('"text"')).toEqual({});
    expect(toolUseInput("[1]")).toEqual({});
  });
  it("keeps valid arguments", () => {
    expect(toolUseInput('{"path":"a.js"}')).toEqual({ path: "a.js" });
  });
});
