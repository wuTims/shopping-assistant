import { initOverlays } from "./overlay";

export function onExecute() {
  console.log("[Shopping Assistant] Content script loaded");
  initOverlays();
}
