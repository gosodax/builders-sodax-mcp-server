/**
 * TypeScript types for the Builders SODAX MCP Server
 */

export enum ResponseFormat {
  JSON = "json",
  MARKDOWN = "markdown",
}

/**
 * Blockchain network supported by SODAX
 */
export interface Chain {
  id: string;
  name: string;
  chainId: number;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  rpcUrl?: string;
  explorerUrl?: string;
  iconUrl?: string;
  isTestnet?: boolean;
}

/**
 * Token available for swapping
 */
export interface SwapToken {
  address: string;
  chainId: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUrl?: string;
  priceUsd?: number;
}

/**
 * Transaction record
 */
export interface Transaction {
  txHash: string;
  chainId: string;
  status: "pending" | "completed" | "failed";
  type: "swap" | "bridge" | "deposit" | "withdraw" | "borrow" | "repay";
  fromAddress: string;
  toAddress?: string;
  tokenIn?: {
    address: string;
    symbol: string;
    amount: string;
    amountUsd?: number;
  };
  tokenOut?: {
    address: string;
    symbol: string;
    amount: string;
    amountUsd?: number;
  };
  timestamp: number;
  blockNumber?: number;
  gasUsed?: string;
  gasFee?: string;
}

/**
 * Trading volume data
 */
/**
 * A single filled intent entry from solver volume
 */
export interface FilledIntent {
  intentHash: string;
  solver: string;
  inputToken: string;
  outputToken: string;
  amount: string;
  chainId: number;
  blockNumber: number;
  txHash: string;
  logIndex: number;
  timestamp: string;
  data?: string;
}

/**
 * Paginated response for solver volume (filled intents)
 */
export interface VolumeData {
  items: FilledIntent[];
  nextCursor?: string;
  hasMore: boolean;
}

/**
 * Orderbook entry for limit orders
 */
export interface OrderbookEntry {
  orderId: string;
  chainId: string;
  maker: string;
  tokenIn: {
    address: string;
    symbol: string;
    amount: string;
  };
  tokenOut: {
    address: string;
    symbol: string;
    amount: string;
  };
  price: number;
  status: "open" | "partial" | "filled" | "cancelled";
  createdAt: number;
  expiresAt?: number;
}

/**
 * Money market asset
 */
export interface MoneyMarketAsset {
  address: string;
  chainId: string;
  symbol: string;
  name: string;
  decimals: number;
  totalSupply: string;
  totalBorrow: string;
  supplyApy: number;
  borrowApy: number;
  collateralFactor: number;
  liquidationThreshold: number;
  priceUsd: number;
}

/**
 * User's money market position
 */
export interface UserPosition {
  address: string;
  chainId?: string;
  totalSupplyUsd: number;
  totalBorrowUsd: number;
  healthFactor: number;
  netApy: number;
  supplies: {
    asset: string;
    symbol: string;
    amount: string;
    valueUsd: number;
    apy: number;
  }[];
  borrows: {
    asset: string;
    symbol: string;
    amount: string;
    valueUsd: number;
    apy: number;
  }[];
}

/**
 * Integration partner
 */
export interface Partner {
  id: string;
  name: string;
  type: "wallet" | "dex" | "bridge" | "aggregator" | "lending" | "other";
  description?: string;
  website?: string;
  logoUrl?: string;
  chains?: string[];
}

/**
 * SODA token supply info
 */
export interface TokenSupply {
  totalSupply: string;
  circulatingSupply: string;
  burnedSupply?: string;
  lockedSupply?: string;
  maxSupply?: string;
  priceUsd?: number;
  marketCapUsd?: number;
}

/**
 * Solver oracle price entry — one per (chainId, token) pair the solver tracks.
 */
export interface OraclePrice {
  address: string;
  chainId: string;
  symbol: string;
  priceUsd: number;
  decimals: number;
  updatedAt: number;
}

/**
 * Solver quote request. `quote_type` controls which side is the
 * provided amount — `exact_input` quotes the destination amount,
 * `exact_output` quotes the source amount required.
 */
export interface QuoteRequest {
  token_src: string;
  token_dst: string;
  amount: string;
  quote_type: "exact_input" | "exact_output";
}

/**
 * Solver quote response. `quoted_amount` is in the smallest unit
 * of the destination token (for exact_input) or the source token
 * (for exact_output).
 */
export interface QuoteResponse {
  quoted_amount: string;
}

/**
 * Intent Relay packet — one cross-chain message in flight.
 * `status === 'executed'` means the destination chain has applied it.
 */
export interface RelayPacketData {
  src_chain_id: number;
  src_tx_hash: string;
  src_address: string;
  status: "pending" | "validating" | "executing" | "executed";
  dst_chain_id: number;
  /**
   * Connection serial number. Wire format from the relay is numeric, but the
   * relay's *request* params (and `GetPacketParams.conn_sn`) take it as a
   * string for URL/JSON consistency. Convert via `String(packet.conn_sn)`
   * when feeding a previously-fetched packet back into a request.
   */
  conn_sn: number;
  dst_address: string;
  dst_tx_hash: string;
  signatures: string[];
  payload: string;
}

/**
 * Response for the relay `submit` action.
 */
export interface RelaySubmitResponse {
  success: boolean;
  message: string;
}

/**
 * Response for the relay `get_transaction_packets` action.
 *
 * Discriminated by `success`:
 *  - on success → `{ success: true; data: RelayPacketData[] }`
 *  - on failure → `{ success: false; message: string }` (mirrors `RelayGetPacketResponse`)
 *
 * The relay returns the failure shape with HTTP 404 (which `callRelay` parses
 * normally rather than throwing), so callers must branch on `success` before
 * touching `data`.
 */
export type RelayPacketsResponse = { success: true; data: RelayPacketData[] } | { success: false; message: string };

/**
 * Response for the relay `get_packet` action.
 * Returns a single packet by its connection serial number.
 */
export type RelayGetPacketResponse = { success: true; data: RelayPacketData } | { success: false; message: string };
