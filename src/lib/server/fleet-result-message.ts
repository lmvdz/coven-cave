type FleetExecutionResult = {
  status?: string;
  stderr?: string;
};

/** Convert executor-local failure evidence into bounded, secret-free UI copy. */
export function fleetExecutionFailureMessage(
  result: FleetExecutionResult | null | undefined,
  harness: string,
): string {
  if (result?.stderr && /harness\s+[`'"]?[^\s`'"]+[`'"]?\s+is not available/i.test(result.stderr)) {
    return `The selected Fleet executor cannot run the ${harness} runtime. Install and sign in to ${harness} on that device, then restart its Fleet connection.`;
  }
  if (result?.status && result.status !== "completed") {
    return `The selected Fleet executor’s ${harness} runtime exited before returning a response. Check that runtime in Cave on the executor, then retry.`;
  }
  return "The executor finished without returning an assistant response.";
}
