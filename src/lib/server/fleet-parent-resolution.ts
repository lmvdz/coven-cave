export type FleetParentResolution =
  | { ok: true; parentTurnId: string | null }
  | { ok: false };

/** Resolve browser parent intent against the hub's canonical transcript. */
export function resolveFleetParentTurnId(args: {
  turnIds: ReadonlySet<string>;
  activeLeafId?: string;
  requestedParentTurnId: string | null;
  allowCanonicalFallback: boolean;
}): FleetParentResolution {
  if (!args.requestedParentTurnId || args.turnIds.has(args.requestedParentTurnId)) {
    return { ok: true, parentTurnId: args.requestedParentTurnId };
  }
  if (!args.allowCanonicalFallback) return { ok: false };
  if (!args.activeLeafId || !args.turnIds.has(args.activeLeafId)) return { ok: false };
  return { ok: true, parentTurnId: args.activeLeafId };
}
