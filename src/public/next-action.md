# The nextAction contract

Every swap and bridge tool result, errors included, carries a machine-readable `nextAction`, `terminal` (no tool call
can move the result on any more) and, once a sent swap or bridge has ended, its `outcome`: `succeeded`, `sent` (the relay
sent a bridge on to a chain this server can't follow to its end, whose explorer shows the arrival), `cancelled`,
`refunding`, `failed` (nothing was swapped or bridged), `held` (the deposit is safe on chain and SODAX recovers it) or
`unknown`. `nextStep` says the same in a sentence: both come from one decision, so they don't disagree. Each type's
fields are in the JSON Schema the server serves as the MCP resource `sodax://next-action/schema`.

| `type` | Who acts | What the runtime does |
|---|---|---|
| `call_tool` | the agent | calls `tool` after `afterSec`, with `args` (on top of the last call's arguments when `sameArgs`); with `until` or `maxAttempts` it repeats while the result asks again, counting per `retryKey` across the workflow (only calls in a row when `consecutive`), then follows `onExhausted` |
| `choose` | the user | picks one of `options`, whose `args` go into `next` |
| `provide` | the user | gives `fields`, by name, for `next`; declining follows `onDecline` where there is one |
| `confirm` | the user, or the wallet when `by: "wallet"` | agrees to `summary` (`kind`: `swap`, `bridge`, `cancel`, `amount`, or `unsent_cancel`: that cancel can never land), then `next` |
| `execute` | the wallet | sends the result's `steps` (or its `batch`) in order, each receipt a success before the next; once the last is broadcast, makes the `afterSend` call with its hash. A bounded `afterSend` is counted before anything is signed, and past its bound nothing is |
| `external` | the user, outside these tools | sees `reason`; `next`, if there is one, once they say they've done it; if they don't, `onDecline` where there is one |
| `none` | nobody | the workflow is over |

What a runtime keeps to:

- **Arguments.** A result that found the swap gives complete `args`; everything else reuses the arguments of the call
  that returned it (`sameArgs`), with only the named fields replaced. The server never writes back a value it refused.
- **Sending.** Don't start an `execute` past its `expiresAt`: prepare and confirm again. Save `afterSend`'s arguments
  and the hash the moment the last step is broadcast, and make the call even if the quote just expired or the receipt
  then fails (a NEAR tx can fail after its deposit ran). From a batch, save the batch id at once and track the hash
  `wallet_getCallsStatus` reports: a resumed session reads it again and never resends the batch. Save every track
  call's arguments before making it, so a session resumed after the user corrected a hash or a chain uses theirs.
- **Bounds.** A call goes unbounded only when the server's clock forces a new answer (past a deadline) or it hands
  over to another tool's bounded actions. A call a person's answer leads back to is bounded too, under a key the
  answers don't change, so an agent answering for the user still stops: before a send the workflow then ends, after
  one it goes to the help desk. A workflow is one swap; keep its counts with what was sent.
- **Cancels.** A cancel already sent is followed, never sent again. Any cancel call carrying a `cancelTxHash` (from
  the wallet, the user or the start) makes it pending: a resumed session reads it with that hash first, a `confirm`
  of a cancel re-reads it, and once it's relayed (`cancel_relayed`) its own bounded track takes over. A cancel's
  retries carry its hash. A new cancel replaces a pending one only once the wallet's own record shows it can never
  land (`confirm` of `unsent_cancel`, `by: "wallet"`): its nonce went to another transaction, or its blockhash
  expired. An agent's yes isn't that record. One swap gets at most three cancels, however they failed. A cancel the swap
  service has no record of is retried, then handed to track with the same arguments, which submits nothing in that
  state: it says what holds the deposit and alerts on it.
- **Handoffs.** A person declining ends the loop; the saved hash resumes it later. An unknown `type` goes to a person.
  On a terminal `external`, show it before stopping.
- **No contract.** A result with no `nextAction` came from the MCP SDK refusing the arguments before the tool ran, or
  its output after: fix the arguments only when the message says the input was invalid, otherwise hand off, keeping
  any hash already sent.
