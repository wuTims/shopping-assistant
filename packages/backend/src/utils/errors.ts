export function isLikelyTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.name.toLowerCase();
  const message = err.message.toLowerCase();
  return (
    name.includes("timeout") ||
    name === "aborterror" ||
    message.includes("timed out") ||
    message.includes("timeout")
  );
}
