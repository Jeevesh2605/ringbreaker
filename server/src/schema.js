// Index creation (SPEC section 6). Run on startup and by the seed script.
// Every tool starts from a lookup like (:Account {id:$id}); without these indexes
// FalkorDB would scan all nodes of that label for each lookup.
import { writeQuery } from './db.js';

// [label, property] pairs. Label/property names are fixed constants here, never user
// input; Cypher cannot parameterize labels, so this is the one place we build the text.
const INDEXES = [
  ['Account', 'id'],
  ['Device', 'id'],
  ['Phone', 'number'],
  ['VPA', 'handle'],
  ['Alert', 'id'],
  ['Case', 'id'],
];

export async function ensureIndexes() {
  for (const [label, prop] of INDEXES) {
    try {
      // FalkorDB range-index syntax: CREATE INDEX FOR (n:Label) ON (n.prop)
      await writeQuery(`CREATE INDEX FOR (n:${label}) ON (n.${prop})`);
    } catch (e) {
      // Re-running is fine: FalkorDB errors if the index already exists.
      if (!/already indexed/i.test(e.message)) throw e;
    }
  }
}
