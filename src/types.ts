/**
 * TypeScript types for the Builders SODAX MCP Server
 */

export enum ResponseFormat {
  JSON = "json",
  MARKDOWN = "markdown"
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
export interface VolumeData {
  totalVolumeUsd: number;
  swapVolumeUsd: number;
  bridgeVolumeUsd: number;
  tradeCount: number;
  uniqueUsers: number;
  period: string;
  chainBreakdown?: {
    chainId: string;
    volumeUsd: number;
    tradeCount: number;
  }[];
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
