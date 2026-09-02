import { describe, expect, it } from "vitest";
import { stripJsonComments } from "../../scripts/jsonc";

// Failure mode defended: a naive stripper corrupts "https://discord.com/*" match patterns,
// which would silently produce a manifest that injects into nothing.
describe("stripJsonComments", () => {
  it("removes line and block comments but keeps // inside strings", () => {
    const src = `{
      // leading comment
      "matches": ["https://discord.com/*"], /* inline */
      "note": "a // b /* c */"
    }`;
    const parsed = JSON.parse(stripJsonComments(src));
    expect(parsed).toEqual({ matches: ["https://discord.com/*"], note: "a // b /* c */" });
  });

  it("keeps escaped quotes inside strings intact", () => {
    const src = `{"s": "say \\"hi\\" // not a comment"}`;
    expect(JSON.parse(stripJsonComments(src))).toEqual({ s: 'say "hi" // not a comment' });
  });

  it("rejects an unterminated block comment instead of emitting truncated JSON", () => {
    expect(() => stripJsonComments(`{"a": 1 /* oops`)).toThrow(/Unterminated block comment/);
  });
});
