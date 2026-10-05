import { describe, expect, it } from "vitest";
import { parseSpokenNumber } from "../index.js";

describe("parseSpokenNumber (English)", () => {
  it.each([
    ["zero", 0],
    ["seven", 7],
    ["fourteen", 14],
    ["thirty-eight", 38],
    ["thirty eight", 38],
    ["ninety nine", 99],
    ["one hundred", 100],
    ["a hundred", 100],
    ["hundred", 100],
    ["one hundred and five", 105],
    ["twenty four hundred", 2400],
    ["two thousand four hundred", 2400],
    ["two thousand four hundred and fifty", 2450],
    ["a thousand", 1000],
    ["a grand", 1000],
    ["1.5 k", 1500],
    ["2k", 2000],
    ["38", 38],
    ["19.99", 19.99],
    ["1,299", 1299],
    ["2,400", 2400],
    ["1,50,000", 150000],
  ])("%s -> %d", (phrase, value) => {
    expect(parseSpokenNumber(phrase)).toBe(value);
  });

  it.each(["fourteen thirty eight", "thirty forty", "k", "dress", "", "two smalls", "$38"])("%s is not one number", (phrase) => {
    expect(parseSpokenNumber(phrase)).toBeUndefined();
  });
});

describe("parseSpokenNumber (Hindi)", () => {
  const hindi = { hindi: true };
  it.each([
    ["24 sau", 2400],
    ["chaubees sau", undefined],
    ["do hazaar", 2000],
    ["do hazaar paanch sau", 2500],
    ["teen hazaar", 3000],
    ["dhai hazaar", 2500],
    ["dedh lakh", 150000],
    ["saade teen hazaar", 3500],
    ["sava do sau", 225],
    ["paune do sau", 175],
    ["sava lakh", 125000],
    ["paune hazaar", 750],
    ["1.5 lakh", 150000],
    ["two lakh", 200000],
  ])("%s -> %s", (phrase, value) => {
    expect(parseSpokenNumber(phrase, hindi)).toBe(value);
  });

  it("Hindi words are ignored outside Indian mode", () => {
    expect(parseSpokenNumber("do hazaar")).toBeUndefined();
    expect(parseSpokenNumber("dhai hazaar")).toBeUndefined();
  });

  it("a lone Hindi word is not a number, so 'do' (two) never collides with English 'do'", () => {
    expect(parseSpokenNumber("do", hindi)).toBeUndefined();
    expect(parseSpokenNumber("teen", hindi)).toBeUndefined();
  });

  it("English multipliers still work in Indian mode", () => {
    expect(parseSpokenNumber("two thousand four hundred", hindi)).toBe(2400);
  });
});
