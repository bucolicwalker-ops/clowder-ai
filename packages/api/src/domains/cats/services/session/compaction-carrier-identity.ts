/**
 * #1542: in-process carrier-identity binding for managed compaction callbacks.
 *
 * When invoke-single-cat hands a launch plan to a Claude spawn, the expected
 * carrier identity is bound to the invocationId. `/api/sessions/seal` consults
 * the binding BEFORE recordCompressionEvent so a legacy shell hook firing
 * alongside the canonical Node carrier can never produce a second logical
 * observation (maintainer direction on #1542, guard 4).
 *
 * Deliberately in-process: the binding lives exactly as long as the process
 * that performed the spawn. After an API restart mid-invocation the binding is
 * gone and the seal falls back to its remaining fail-closed checks (callback
 * auth, session ownership, active status, applied policy) — an invocation that
 * outlives its launching process is already outside the managed journey.
 * Entries are pruned by insertion order; they are tiny and non-secret.
 */

const MAX_BINDINGS = 1000;

const bindings = new Map<string, { identity: string; boundAt: number }>();

/** Bind the carrier identity a launch plan handed to one invocation's spawn. */
export function bindInvocationCompactionCarrier(invocationId: string, identity: string): void {
  if (bindings.size >= MAX_BINDINGS) {
    const oldest = [...bindings.entries()].sort((a, b) => a[1].boundAt - b[1].boundAt);
    for (let i = 0; i < Math.floor(oldest.length / 2); i++) bindings.delete(oldest[i][0]);
  }
  bindings.set(invocationId, { identity, boundAt: Date.now() });
}

/** The carrier identity this invocation's spawn actually launched, if any. */
export function expectedCompactionCarrierFor(invocationId: string): string | undefined {
  return bindings.get(invocationId)?.identity;
}

/** Test seam: drop every binding. */
export function resetInvocationCompactionCarrierBindings(): void {
  bindings.clear();
}
