/**
 * A runnable demonstration: `pnpm verify`.
 *
 * Boots the deterministic engine over the real content and plays a battle from a seed, printing the
 * turn-by-turn log — the same log the C# reference produces, which the conformance corpus asserts
 * byte-for-byte. Then it replays the identical seed to show the outcome is reproducible. No database
 * or network is needed; this is the core the whole service is built on.
 */

import { GameData } from '../src/content/gamedata.ts';
import { replayBattle, type BattleSpec } from '../src/engine/replay.ts';

const data = GameData.loadFromDirectory();
const errors = data.validate();
if (errors.length > 0) {
  console.error('content invalid:\n', errors.join('\n'));
  process.exit(1);
}
console.log(`content ok: ${data.dex.length} Kin, ${data.moves.size} moves, ${data.types.elements.length} types, ${data.campaign.regions.length} regions.\n`);

const spec: BattleSpec = {
  seed: 2024n,
  player: { name: 'Warden', isWild: false, party: [{ species: 'cinderpyre', level: 40, resonance: 100, temperament: 60, nickname: 'Blaze' }] },
  enemy: { name: 'Wild', isWild: true, party: [{ species: 'bramblejaw', level: 38 }] },
  script: [{ kind: 'art' }, { kind: 'move', slot: 0 }, { kind: 'move', slot: 0 }, { kind: 'move', slot: 0 }],
  maxTurns: 40,
};

const a = replayBattle(data, spec);
console.log('=== battle log (seed 2024) ===');
for (const line of a.log) console.log('  ' + line);
console.log(`\noutcome: ${a.outcome} in ${a.turns} turns.`);

const b = replayBattle(data, spec);
const identical = JSON.stringify(a.log) === JSON.stringify(b.log) && a.outcome === b.outcome;
console.log(`\nreplay determinism: ${identical ? 'IDENTICAL' : 'DIVERGED'} (same seed => same battle).`);
if (!identical) process.exit(1);
