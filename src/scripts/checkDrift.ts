#!/usr/bin/env node
/**
 * CLI entrypoint for the API drift check.
 * Exits 0 if spec and tools are in sync, 1 if any drift is detected.
 * Wire into CI / pre-deploy gates via `pnpm check:drift`.
 */

import { SODAX_ENV_ERROR } from "../constants.js";
import { checkApiDrift } from "../services/apiDriftCheck.js";

// Like main(): a bad SODAX_ENV must not fall back to checking production.
if (SODAX_ENV_ERROR) throw new Error(SODAX_ENV_ERROR);

// notify: false — the CLI must stay side-effect-free (no Discord POST) on
// developer machines; the runtime notifier is opt-in at server startup only.
const report = await checkApiDrift({ notify: false });
process.exit(report.hasDrift ? 1 : 0);
