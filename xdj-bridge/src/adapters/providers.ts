import type { StateStore } from '../core/store.js';
import type { DeckState, TrackRef } from '../core/types.js';

export interface MetadataRequest {
  deckId: string;
  loadGeneration: number;
  trackRef: TrackRef;
}
export interface MetadataProvider {
  id: string;
  supports(deck: DeckState): boolean;
  fetch(request: MetadataRequest, signal: AbortSignal): Promise<{ title?: string; artist?: string }>;
}

/** Session-wide bounded scheduler. An uncooperative timed-out provider retains
 * its concurrency slot until it settles; timeouts never create orphan floods. */
export class ProviderScheduler {
  private active = 0;
  private stopped = false;
  private queue: Array<() => void> = [];
  private controllers = new Set<AbortController>();
  constructor(private concurrency = 2, private timeoutMs = 2500, private maxQueue = 32) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid provider scheduler limits');
  }
  run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.stopped || this.queue.length >= this.maxQueue) return Promise.reject(new Error('Provider scheduler stopped or queue full'));
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        if (this.stopped) { reject(new Error('Provider scheduler stopped')); return; }
        this.active++;
        const controller = new AbortController(); this.controllers.add(controller);
        const abort = () => reject(controller.signal.reason ?? new Error('Provider request aborted'));
        controller.signal.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => controller.abort(new Error('Provider request timed out')), this.timeoutMs);
        Promise.resolve().then(() => operation(controller.signal)).then(value => {
          if (!controller.signal.aborted) resolve(value);
        }, reject).finally(() => {
          clearTimeout(timer); controller.signal.removeEventListener('abort', abort);
          this.controllers.delete(controller); this.active--;
          this.queue.shift()?.();
        });
      };
      if (this.active < this.concurrency) start(); else this.queue.push(start);
    });
  }
  close(): void {
    this.stopped = true;
    for (const controller of this.controllers) controller.abort(new Error('Provider scheduler stopped'));
    for (const start of this.queue.splice(0)) start();
  }
}

/** One finite attempt per load generation. A media change/reconnect creates a
 * new generation; failure leaves status reception running. No local DJ library. */
export function attachMetadataProvider(store: StateStore, provider: MetadataProvider, scheduler = new ProviderScheduler()): () => void {
  const requested = new Set<string>();
  let closed = false;
  const unsubscribe = store.subscribe(snapshot => {
    for (const deck of snapshot.decks) {
      if (!deck.trackRef || deck.playbackState.freshness === 'stale' || !provider.supports(deck)) continue;
      const key = `${deck.deckId}:${deck.loadGeneration}:${deck.trackRef.mediaGeneration}`;
      if (requested.has(key)) continue;
      requested.add(key);
      if (requested.size > 1024) requested.delete(requested.values().next().value!);
      const request = { deckId: deck.deckId, loadGeneration: deck.loadGeneration, trackRef: { ...deck.trackRef } };
      store.setCapability(deck.deckId, 'metadata', { availability: 'idle', reason: `${provider.id}: finite request in progress`, source: provider.id });
      void scheduler.run(signal => provider.fetch(request, signal)).then(result => {
        if (closed) return;
        if (!result.title && !result.artist) throw new Error('Provider returned no title or artist');
        store.applyMetadata({ ...result, deckId: request.deckId, loadGeneration: request.loadGeneration, mediaGeneration: request.trackRef.mediaGeneration }, store.snapshot().session.now);
      }).catch(error => {
        if (closed) return;
        const current = store.snapshot().decks.find(x => x.deckId === request.deckId);
        if (current?.loadGeneration !== request.loadGeneration || current.trackRef?.mediaGeneration !== request.trackRef.mediaGeneration) return;
        store.setCapability(request.deckId, 'metadata', { availability: 'unavailable', lastFailureAt: store.snapshot().session.now,
          reason: `${provider.id}: ${error instanceof Error ? error.message : String(error)}; retry after a new load or media generation.`, source: provider.id });
      });
    }
  });
  return () => { closed = true; unsubscribe(); scheduler.close(); };
}
