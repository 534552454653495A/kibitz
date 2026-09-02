/**
 * Strips `//` and `/* *\/` comments from JSONC without touching string contents.
 *
 * Why hand-written: manifest.jsonc contains URL patterns like "https://discord.com/*" —
 * a regex-based stripper eats the "//" inside the string. A 30-line state machine is
 * cheaper to own than a dependency and is covered by tests/scripts/jsonc.test.ts.
 *
 * Trailing commas are deliberately NOT tolerated: apart from comments the source must
 * stay valid JSON so any JSON tool can read the stripped output.
 */
export function stripJsonComments(input: string): string {
  let out = "";
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        const c = input[j]!;
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === '"') break;
        j++;
      }
      if (j >= n) throw new Error(`Unterminated string at offset ${i}`);
      out += input.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "/" && input[i + 1] === "/") {
      while (i < n && input[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && input[i + 1] === "*") {
      const end = input.indexOf("*/", i + 2);
      if (end === -1) throw new Error(`Unterminated block comment at offset ${i}`);
      i = end + 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
