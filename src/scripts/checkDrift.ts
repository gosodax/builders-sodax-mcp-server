#!/usr/bin/env node
/**
 * CLI entrypoint for the API drift check.
 *
 * Exit codes:
 *   0 — the check ran and spec/tools are in sync
 *   1 — the check ran and drift was detected
 *   2 — the check COULD NOT RUN (spec unreachable, timed out, or unparseable)
 *
 * A gate that cannot run must not report success, so a fetch/parse failure is
 * a hard failure here — unlike the server-startup call, which stays
 * fire-and-forget so a docs outage never blocks boot.
 *
 * Wire into CI / pre-deploy gates via `pnpm check:drift`.
 */

import { checkApiDrift } from "../services/apiDriftCheck.js";

// notify: false — the CLI must stay side-effect-free (no Discord POST) on
// developer machines; the runtime notifier is opt-in at server startup only.
const report = await checkApiDrift({ notify: false });

if (!report.ran) {
  console.error("");
  console.error("❌ API drift check DID NOT RUN — this is a failure, not a pass.");
  console.error(`   Reason: ${report.reason ?? "unknown"}`);
  console.error("   The OpenAPI spec could not be fetched or parsed, so no comparison was made.");
  console.error("   Next steps: check SODAX API availability / network egress from this runner,");
  console.error("   then re-run `pnpm check:drift`.");
  console.error("");
  process.exit(2);
}

process.exit(report.hasDrift ? 1 : 0);
