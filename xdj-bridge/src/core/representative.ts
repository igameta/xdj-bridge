import type { DeckState, Field, RepresentativeState, Snapshot } from './types.js';

const none = (): RepresentativeState => ({ deckId: null, publicDeckId: null, reason: 'none' });
const knownFresh = (field: Field<unknown> | undefined): boolean => Boolean(field && field.value !== null && field.quality !== 'unknown' && field.freshness === 'fresh' && typeof field.observedAt === 'number' && Number.isFinite(field.observedAt));
const publicId = (deck: DeckState): deck is DeckState & { publicDeckId: string } => typeof deck.publicDeckId === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(deck.publicDeckId);
const compareDecks = (a: DeckState, b: DeckState): number => (a.logicalDeck ?? Infinity) - (b.logicalDeck ?? Infinity)
  || String(a.publicDeckId).localeCompare(String(b.publicDeckId), 'en', { numeric: true })
  || a.deckId.localeCompare(b.deckId, 'en');

/** Select from the current session only. Equal-priority candidates retain the
 * previous deck so ordinary status ordering cannot make the output oscillate.
 * A confirmed tempo master remains authoritative while paused or with an
 * unknown BPM; each forwarded field still carries its own validity. */
export function selectRepresentative(snapshot: Pick<Snapshot, 'session' | 'decks'>, previousDeckId?: string | null): RepresentativeState {
  if (snapshot.session.mode === 'idle' || !['online', 'degraded'].includes(snapshot.session.state)) return none();
  const counts = new Map<string, number>();
  for (const deck of snapshot.decks) if (deck.sessionId === snapshot.session.id && publicId(deck)) counts.set(deck.publicDeckId, (counts.get(deck.publicDeckId) ?? 0) + 1);
  const eligible = snapshot.decks.filter(deck => deck.sessionId === snapshot.session.id && publicId(deck) && counts.get(deck.publicDeckId) === 1);
  const masters = eligible.filter(deck => knownFresh(deck.tempoMaster) && deck.tempoMaster.quality === 'observed' && deck.tempoMaster.value === true);
  const candidates = masters.length ? masters : eligible.filter(deck => knownFresh(deck.playbackState)
    && ['playing', 'looping', 'cue_playing'].includes(String(deck.playbackState.value))
    && knownFresh(deck.effectiveBpm) && typeof deck.effectiveBpm.value === 'number' && Number.isFinite(deck.effectiveBpm.value) && deck.effectiveBpm.value > 0);
  const selected = candidates.find(deck => deck.deckId === previousDeckId) ?? [...candidates].sort(compareDecks)[0];
  return selected ? { deckId: selected.deckId, publicDeckId: selected.publicDeckId, reason: masters.length ? 'tempo-master' : 'playing' } : none();
}
