/**
 * The partner fee a builder sets on its connection: an EVM address and 1–100
 * basis points. Never a tool input, so a prompt can't redirect it.
 */

import { EVM_ADDRESS_PATTERN } from "../constants.js";
import { ConnectionError, isSet } from "./profiles.js";

export interface PartnerFee {
  address: string;
  bps: number;
}

/** Both or neither; anything else refuses the connection. The values are never echoed back. */
function parsePartnerFee(address: unknown, bps: unknown): PartnerFee | undefined {
  if (!isSet(address) && !isSet(bps)) return undefined;
  const addressText = typeof address === "string" ? address.trim() : "";
  const bpsText = typeof bps === "string" ? bps.trim() : "";
  const fee = /^\d{1,3}$/.test(bpsText) ? Number(bpsText) : Number.NaN;
  if (!EVM_ADDRESS_PATTERN.test(addressText) || /^0x0{40}$/.test(addressText) || !(fee >= 1 && fee <= 100)) {
    throw new ConnectionError(
      400,
      "A partner fee needs both an EVM partner address and a whole number of basis points from 1 to 100.",
    );
  }
  return { address: addressText, bps: fee };
}

/** HTTP: the query pair if either is set (URL-only clients can only set the query), else the header pair. */
export function partnerFeeFromRequest(req: {
  query: { partnerAddress?: unknown; partnerFeeBps?: unknown };
  get(header: string): string | undefined;
}): PartnerFee | undefined {
  const { partnerAddress, partnerFeeBps } = req.query;
  if (isSet(partnerAddress) || isSet(partnerFeeBps)) return parsePartnerFee(partnerAddress, partnerFeeBps);
  return parsePartnerFee(req.get("x-sodax-partner-address"), req.get("x-sodax-partner-fee-bps"));
}

/** stdio: `SODAX_PARTNER_FEE_ADDRESS` and `SODAX_PARTNER_FEE_BPS`. */
export function partnerFeeFromEnv(env: NodeJS.ProcessEnv): PartnerFee | undefined {
  return parsePartnerFee(env.SODAX_PARTNER_FEE_ADDRESS, env.SODAX_PARTNER_FEE_BPS);
}
