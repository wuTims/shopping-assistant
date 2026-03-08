import { describe, it, expect } from "vitest";
import { parsePrice } from "../brave.js";

describe("parsePrice", () => {
  it("parses USD with $ symbol", () => {
    expect(parsePrice("$29.99")).toEqual({ price: 29.99, currency: "USD" });
  });

  it("parses GBP with £ symbol", () => {
    expect(parsePrice("£15.00")).toEqual({ price: 15.0, currency: "GBP" });
  });

  it("parses EUR with € symbol", () => {
    expect(parsePrice("€42")).toEqual({ price: 42, currency: "EUR" });
  });

  it("parses CNY/JPY with ¥ symbol", () => {
    expect(parsePrice("¥1280")).toEqual({ price: 1280, currency: "CNY" });
  });

  it("parses ¥ with decimals", () => {
    expect(parsePrice("¥99.50")).toEqual({ price: 99.5, currency: "CNY" });
  });

  it("parses CNY currency code", () => {
    expect(parsePrice("CNY 580")).toEqual({ price: 580, currency: "CNY" });
  });

  it("parses JPY currency code", () => {
    expect(parsePrice("JPY 1500")).toEqual({ price: 1500, currency: "JPY" });
  });

  it("returns null for no price", () => {
    expect(parsePrice("no price here")).toEqual({ price: null, currency: null });
  });

  it("returns null for null input", () => {
    expect(parsePrice(null)).toEqual({ price: null, currency: null });
  });
});
