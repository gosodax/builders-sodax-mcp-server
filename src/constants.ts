/**
 * Constants for the SODAX Builders MCP Server
 */

// SODAX API Base URL (Backend API)
export const SODAX_API_BASE_URL = "https://api.sodax.com/v1/be";

// SODAX Solver API Base URL (intent oracle + quote)
export const SODAX_SOLVER_BASE_URL = "https://api.sodax.com/v1/intent";

// SODAX Intent Relay API Base URL (xCall relay hosted by ICON)
export const SODAX_RELAY_BASE_URL = "https://xcall-relay.nw.iconblockchain.xyz";

// Cache duration in milliseconds (2 minutes for live data)
export const CACHE_DURATION_MS = 2 * 60 * 1000;

// Spoke chain keys excluded from the public "integrated networks" count.
// Values are chain-key strings as returned by /config/spoke/chains (not numeric
// chain IDs). ICON (0x1.icon) is being wound down, so it's filtered out — this
// mirrors the frontend's stats.ts fetchIntegratedNetworksCount() source of truth.
export const NETWORK_COUNT_EXCLUDED_CHAIN_KEYS: readonly string[] = ["0x1.icon"];

// Single source of truth for chain metadata, keyed by the canonical chain key
// as returned by /config/spoke/chains. `name` is the human display name;
// `aliases` are extra tickers/spellings a user might type that are NOT already
// derivable from the key itself — resolveChainKey automatically matches the
// key, its dotted suffix ("base" in "0x2105.base"), its Cosmos slug
// ("injective" in "injective-1") and the display `name` ("Avalanche" for
// "0xa86a.avax"), so those need not be listed here. Support is
// always confirmed against the LIVE registry, so entries here only aid display
// and name resolution and cannot themselves make a chain look (un)supported.
export const CHAINS: Readonly<Record<string, { name: string; aliases: readonly string[] }>> = {
  sonic: { name: "Sonic", aliases: ["s"] },
  ethereum: { name: "Ethereum", aliases: ["eth", "ether"] },
  "0xa4b1.arbitrum": { name: "Arbitrum", aliases: ["arb", "arbitrum one"] },
  "0x2105.base": { name: "Base", aliases: [] },
  "0x38.bsc": { name: "BNB Chain", aliases: ["bnb", "bnb chain", "binance", "binance smart chain"] },
  "0xa86a.avax": { name: "Avalanche", aliases: ["avax"] },
  "0xa.optimism": { name: "Optimism", aliases: ["op"] },
  "0x89.polygon": { name: "Polygon", aliases: ["matic", "pol"] },
  "injective-1": { name: "Injective", aliases: ["inj"] },
  "0x1.icon": { name: "ICON", aliases: ["icx"] },
  sui: { name: "Sui", aliases: [] },
  solana: { name: "Solana", aliases: ["sol"] },
  stellar: { name: "Stellar", aliases: ["xlm"] },
  hyper: { name: "HyperEVM", aliases: ["hyperevm", "hyperliquid", "hype"] },
  lightlink: { name: "LightLink", aliases: [] },
  near: { name: "NEAR", aliases: [] },
  bitcoin: { name: "Bitcoin", aliases: ["btc"] },
  redbelly: { name: "Redbelly", aliases: ["rbnt"] },
  "0x2019.kaia": { name: "Kaia", aliases: ["klaytn", "klay"] },
  stacks: { name: "Stacks", aliases: ["stx"] },
  hedera: { name: "Hedera", aliases: ["hbar", "hashgraph"] },
  robinhood: { name: "Robinhood", aliases: ["hood"] },
};

// Ticker/spelling → chain-key aliases, derived from CHAINS so the two can't drift.
// The lower-cased display name is always included: a key whose suffix differs
// from its name (e.g. "0xa86a.avax" / "Avalanche") is otherwise unresolvable by
// the very name sodax_get_supported_chains shows.
export const CHAIN_ALIASES: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  Object.entries(CHAINS).map(([key, v]) => [key, [v.name.toLowerCase(), ...v.aliases]]),
);

/**
 * Human-readable name for a chain key. Falls back to deriving one from the key
 * (the segment after a dot for EVM keys, or the slug before a Cosmos `-<n>`
 * suffix, capitalised) so a newly launched chain still reads sensibly before
 * it's added to CHAINS.
 */
export function chainDisplayName(key: string): string {
  const known = CHAINS[key]?.name;
  if (known) return known;
  const base = key.includes(".") ? (key.split(".").pop() ?? key) : key.replace(/-\d+$/, "");
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : key;
}

// SODAX Brand Colors (for reference)
export const BRAND_COLORS = {
  cherry: "#E53935",
  cream: "#FFF8E7",
  espresso: "#1A1A1A",
  accent: "#FFD54F",
} as const;
