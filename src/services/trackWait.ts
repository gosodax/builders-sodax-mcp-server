import { errorName, logger } from "./logger.js";

/**
 * Agents can't wait between calls, so a swap or bridge track call waits briefly for it to move on: it reads again every
 * few seconds while the result waits, until its state changes or `maxMs` passes. Mutable for tests.
 */
export const trackWait = {
  stepMs: 5_000,
  maxMs: 20_000,
  sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
};

/**
 * `read`, repeated while `waiting` says so, until `stateOf` changes or `trackWait.maxMs` passes. Only the first read
 * can fail the call: a later one that fails returns what the last read found, which may have submitted already.
 */
export async function readWhileWaiting<T>(
  read: () => Promise<T>,
  waiting: (result: T) => boolean,
  stateOf: (result: T) => string,
): Promise<T> {
  const started = Date.now();
  let result = await read();
  const first = stateOf(result);
  while (waiting(result) && Date.now() - started + trackWait.stepMs <= trackWait.maxMs) {
    await trackWait.sleep(trackWait.stepMs);
    try {
      result = await read();
    } catch (error) {
      logger.warn({ "error.type": errorName(error) }, "A repeat track read failed; answering with the one before it");
      return result;
    }
    if (stateOf(result) !== first) break;
  }
  return result;
}
