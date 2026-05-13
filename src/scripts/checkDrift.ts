#!/usr/bin/env node
/**
 * CLI entrypoint for the API drift check.
 * Exits 0 if spec and tools are in sync, 1 if any drift is detected.
 * Wire into CI / pre-deploy gates via `pnpm check:drift`.
 */

import { checkApiDrift } from '../services/apiDriftCheck.js';

const report = await checkApiDrift();
process.exit(report.hasDrift ? 1 : 0);
