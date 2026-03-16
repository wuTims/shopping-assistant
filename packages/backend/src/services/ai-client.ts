import { GoogleGenAI } from "@google/genai";

export const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
export const geminiModel = process.env.GEMINI_MODEL || "gemini-2.5-flash";
export const embeddingModel = "gemini-embedding-2-preview";
export const liveModel =
  process.env.GEMINI_LIVE_MODEL || "gemini-2.5-flash-native-audio-preview-12-2025";
