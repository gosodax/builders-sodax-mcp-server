#!/usr/bin/env node
/**
 * CLI entrypoint for the API drift check.
 * Exits 0 if spec and tools are in sync, 1 if any drift is detected.
 * Wire into CI / pre-deploy gates via `pnpm check:drift`.
 */

import { writeSync } from "node:fs";
import { SODAX_ENV_ERROR } from "../constants.js";
import { checkApiDrift } from "../services/apiDriftCheck.js";

// Like main(): a bad SODAX_ENV must not fall back to checking production.
if (SODAX_ENV_ERROR) throw new Error(SODAX_ENV_ERROR);

// notify: false — the CLI must stay side-effect-free (no Discord POST) on
// developer machines; the runtime notifier is opt-in at server startup only.
const report = await checkApiDrift({ notify: false });
// The log holds the issues as one record; a person reading CI wants a line each. Synchronous, as exit follows.
if (report.hasDrift) writeSync(2, `${report.details}\n`);
process.exit(report.hasDrift ? 1 : 0);
