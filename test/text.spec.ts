import { describe, expect, it } from "vitest";
import { MAX_UTTERANCE_CHARS } from "../src/protocol";
import { normalizeSpeech, normalizeUtterance } from "../src/text";

describe("normalizeUtterance", () => {
  it("folds every line break into a single line", () => {
    expect(normalizeUtterance("első\nmásodik\r\nharmadik")).toBe("első második harmadik");
    expect(normalizeUtterance("tab\tés sorelválasztó")).toBe("tab és sorelválasztó");
  });

  it("keeps accented characters intact", () => {
    expect(normalizeUtterance("Árvíztűrő tükörfúrógép")).toBe("Árvíztűrő tükörfúrógép");
  });

  it("strips control characters and collapses whitespace", () => {
    expect(normalizeUtterance("a\u0000b   c ")).toBe("ab c");
  });

  it("returns null for anything with no content", () => {
    expect(normalizeUtterance("")).toBeNull();
    expect(normalizeUtterance("   \n\t ")).toBeNull();
  });

  it("caps the length", () => {
    expect(normalizeUtterance("x".repeat(MAX_UTTERANCE_CHARS + 500))!.length).toBe(MAX_UTTERANCE_CHARS);
  });
});

describe("normalizeSpeech", () => {
  it("keeps line breaks, because the phone only reads it out", () => {
    expect(normalizeSpeech("Első mondat.\nMásodik mondat.")).toBe("Első mondat.\nMásodik mondat.");
  });

  it("returns null for empty input", () => {
    expect(normalizeSpeech("\n \t")).toBeNull();
  });
});
