export type SendParentTurn = {
  id: string;
  parentId?: string | null;
  role?: string;
  pending?: boolean;
  lifecycle?: string;
};

/**
 * Resolve the durable branch point for a new send while leaving a rejected
 * optimistic pair visible in the transcript. A bridge-level rejection never
 * persists either optimistic turn, so its assistant id cannot be used as the
 * parent of the next request.
 */
export function durableSendParentId(
  turns: SendParentTurn[],
  activeLeafId: string,
): string | null {
  if (!activeLeafId) return null;
  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  let leaf = byId.get(activeLeafId);
  const visited = new Set<string>();
  while (
    leaf?.role === "assistant" &&
    (leaf.lifecycle === "failed" || leaf.lifecycle === "error") &&
    !visited.has(leaf.id)
  ) {
    visited.add(leaf.id);
    const optimisticUser = leaf.parentId ? byId.get(leaf.parentId) : undefined;
    const parentId = optimisticUser?.role === "user"
      ? optimisticUser.parentId ?? null
      : leaf.parentId ?? null;
    if (!parentId) return null;
    leaf = byId.get(parentId);
  }
  return leaf?.id ?? null;
}
