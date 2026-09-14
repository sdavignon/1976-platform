import { hash } from "./migration.js";
export const CUTOVER_GATES = [
  "backupRestore",
  "dataParity",
  "identityContinuity",
  "authorization",
  "media",
  "functions",
  "workflows",
  "agents",
  "webhooks",
  "rollbackRehearsal",
] as const;
export type Gate = (typeof CUTOVER_GATES)[number];
export interface CutoverEvidence {
  gate: Gate;
  passed: boolean;
  reference: string;
  checkedAt: string;
}
export interface CutoverPlan {
  appId: string;
  source: string;
  target: string;
  evidence: CutoverEvidence[];
  writesFrozen: boolean;
}
/** Evidence gate, not an assertion that arbitrary URLs were verified by the library. */
export function assessCutover(
  plan: CutoverPlan,
  now = Date.now(),
  maxAgeMs = 3600000,
) {
  const blockers: string[] = [];
  if (
    !plan.appId ||
    !plan.source ||
    !plan.target ||
    plan.source === plan.target
  )
    blockers.push("Distinct verified source/target and app identity required");
  if (!plan.writesFrozen)
    blockers.push(
      "Source writes must be frozen or a reconciled replication boundary established",
    );
  for (const gate of CUTOVER_GATES) {
    const items = plan.evidence.filter((e) => e.gate === gate);
    const evidence = items[0],
      at = Date.parse(evidence?.checkedAt ?? "");
    if (
      items.length !== 1 ||
      !evidence?.passed ||
      !evidence.reference ||
      !Number.isFinite(at) ||
      at > now ||
      now - at > maxAgeMs
    )
      blockers.push(`Missing, failed or stale gate: ${gate}`);
  }
  return { ready: blockers.length === 0, blockers, digest: hash(plan) };
}
/** Executes only caller-supplied traffic operations, with rollback on failed target checks. */
export async function executeCutover(
  plan: CutoverPlan,
  approvedDigest: string,
  operations: {
    switchTraffic: () => Promise<void>;
    verifyTarget: () => Promise<boolean>;
    restoreTraffic: () => Promise<void>;
    verifySource: () => Promise<boolean>;
  },
) {
  const assessment = assessCutover(plan);
  if (!assessment.ready || assessment.digest !== approvedDigest)
    throw new Error("Cutover blocked or approved plan changed");
  try {
    await operations.switchTraffic();
    if (!(await operations.verifyTarget()))
      throw new Error("Target verification failed");
    return { status: "verified" as const, digest: assessment.digest };
  } catch {
    try {
      await operations.restoreTraffic();
      if (!(await operations.verifySource()))
        return {
          status: "recovery_required" as const,
          digest: assessment.digest,
        };
      return { status: "rolled_back" as const, digest: assessment.digest };
    } catch {
      return {
        status: "recovery_required" as const,
        digest: assessment.digest,
      };
    }
  }
}
