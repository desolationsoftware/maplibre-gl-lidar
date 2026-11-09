import { createLazPerf } from 'laz-perf';
import LazDecodeWorker from './lazDecode.worker?worker&inline';
import { decodeLazPoints, type DecodeReply, type DecodeRequest, lazPerfLoader, PointBuffers } from './lazDecode';

const MAX_WORKERS = 4;
/** How long a worker with pending decodes may go without replying before it's replaced. */
const STALL_TIMEOUT_MS = 30_000;

interface PendingDecode {
  resolve: (decoded: PointBuffers) => void;
  reject: (error: Error) => void;
}

interface PooledWorker {
  worker: Worker;
  pending: Map<number, PendingDecode>;
  stallTimer: ReturnType<typeof setTimeout> | null;
}

let workers: PooledWorker[] | null = null;
let nextRequestId = 0;

/**
 * Returns the laz-perf instance for decoding on the main thread.
 */
export const getLazPerf = lazPerfLoader(createLazPerf);

function startWorkers(): PooledWorker[] {
  // Ensure the browser supports web workers
  if (typeof Worker === 'undefined') {
    return [];
  }
  const count = Math.max(1, Math.min(MAX_WORKERS, (navigator.hardwareConcurrency || 2) - 1));
  const started: PooledWorker[] = [];
  try {
    for (let i = 0; i < count; i++) {
      started.push(startWorker());
    }
  } catch (error) {
    console.warn('Failed to start LAZ decode workers, decoding on the main thread:', error);
    started.forEach(({ worker }) => worker.terminate());
    return [];
  }
  return started;
}

function startWorker(): PooledWorker {
  const pooled: PooledWorker = { worker: new LazDecodeWorker(), pending: new Map(), stallTimer: null };
  // Called when the worker has finished decoding, from the call to postMessage in lazDecode.worker.ts
  pooled.worker.onmessage = (event: MessageEvent<DecodeReply>) => {
    const reply = event.data;
    // Settle the pending Promise in the `pending` map, resuming decodeLaz
    const pending = pooled.pending.get(reply.id);
    pooled.pending.delete(reply.id);
    if ('decoded' in reply) {
      pending?.resolve(reply.decoded);
    } else {
      pending?.reject(new Error(reply.error));
    }
    clearStallTimer(pooled);
    armStallTimer(pooled);
  };
  // Only fires when the worker itself can't run, e.g. its script failed to load
  pooled.worker.onerror = (event) => {
    event.preventDefault();
    console.warn('LAZ decode worker failed, decoding on the main thread:', event.message);
    stopWorkers();
  };
  return pooled;
}

/**
 * Starts the stall timer if the worker has pending decodes and the timer isn't already running.
 */
function armStallTimer(pooled: PooledWorker): void {
  if (pooled.stallTimer === null && pooled.pending.size > 0) {
    pooled.stallTimer = setTimeout(() => replaceStalledWorker(pooled), STALL_TIMEOUT_MS);
  }
}

function clearStallTimer(pooled: PooledWorker): void {
  if (pooled.stallTimer !== null) {
    clearTimeout(pooled.stallTimer);
    pooled.stallTimer = null;
  }
}

/**
 * Terminates a worker, failing the requests it holds.
 */
function stopWorker(pooled: PooledWorker, reason: string): void {
  clearStallTimer(pooled);
  pooled.worker.terminate();
  pooled.pending.forEach(({ reject }) => reject(new Error(reason)));
  pooled.pending.clear();
}

/**
 * Replaces a worker that stopped replying, e.g. one that is wedged or lost a reply.
 */
function replaceStalledWorker(stalled: PooledWorker): void {
  console.warn('LAZ decode worker stopped replying, restarting it');
  stopWorker(stalled, 'LAZ decode worker stopped replying');
  const index = workers?.indexOf(stalled) ?? -1;
  if (index === -1) {
    return;
  }
  try {
    workers![index] = startWorker();
  } catch (error) {
    console.warn('Failed to restart LAZ decode worker:', error);
    workers!.splice(index, 1);
  }
}

/**
 * Stops the workers for good, failing the requests they hold.
 */
function stopWorkers(): void {
  const stopped = workers ?? [];
  workers = [];
  stopped.forEach((pooled) => stopWorker(pooled, 'LAZ decode worker stopped before replying'));
}

async function decodeOnMainThread(request: DecodeRequest): Promise<PointBuffers> {
  return decodeLazPoints(request, await getLazPerf());
}

/**
 * Decodes LAZ point data in a worker, or on the main thread when workers are unavailable.
 *
 * @param request - What to decode. Its bytes must fill their whole buffer, which is
 *   transferred to the worker, so the caller can't use it afterwards.
 * @returns The decoded points
 */
export async function decodeLaz(request: DecodeRequest): Promise<PointBuffers> {
  workers ??= startWorkers();
  if (workers.length === 0) {
    return decodeOnMainThread(request);
  }
  // Find the PooledWorker with the least pending operations. Remember, target.worker is running lazDecode.worker.ts.
  const target = workers.reduce((least, pooled) => (pooled.pending.size < least.pending.size ? pooled : least));
  const id = nextRequestId++;
  // Set an un-resolved Promise for this decode request in the PooledWorker's pending queue. It will be resolved when we receive a message from the worker
  // with the decoded data, see StartWorker()
  const replied = new Promise<PointBuffers>((resolve, reject) => target.pending.set(id, { resolve, reject }));
  try {
    // Kick off the LAZ decode on the Worker
    // This runs onMessage in lazDecode.worker.ts
    target.worker.postMessage({ id, request }, [ request.source.bytes.buffer as ArrayBuffer ]);
  } catch (error) {
    target.pending.delete(id);
    throw error;
  }
  armStallTimer(target);

  return replied;
}
