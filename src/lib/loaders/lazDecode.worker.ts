import { createLazPerf } from 'laz-perf/lib/worker/index.js';
import { decodedTransferables, decodeLazPoints, type DecodeMessage, type DecodeReply, lazPerfLoader } from './lazDecode';

const getLazPerf = lazPerfLoader(createLazPerf);

// The DOM lib types `self` as a Window, so describe the worker scope this uses.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<DecodeMessage>) => void) | null;
  postMessage(message: DecodeReply, transfer?: Transferable[]): void;
};

scope.onmessage = async (event) => {
  const { id, request } = event.data;
  try {
    const decoded = await decodeLazPoints(request, await getLazPerf());
    // Transfer the decoded buffers back to the main thread, instead of copying
    scope.postMessage({ id, decoded }, decodedTransferables(decoded));
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
