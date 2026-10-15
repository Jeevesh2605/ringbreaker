// Load data/out/graph.json into FalkorDB (graph name from FALKORDB_GRAPH, default "ring").
// Wipes the graph first, so re-running always yields the same demo state.
//
// Usage: npm run generate && npm run seed
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGraph, writeQuery, close } from '../server/src/db.js';
import { ensureIndexes } from '../server/src/schema.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(readFileSync(join(ROOT, 'data', 'out', 'graph.json'), 'utf8'));
const BATCH = 1000;

// Each row list is sent as ONE parameter ($rows) and expanded server-side with UNWIND.
// Values never touch the query text, so names/handles cannot inject Cypher.
async function inBatches(rows, cypher) {
  for (let i = 0; i < rows.length; i += BATCH) {
    await writeQuery(cypher, { rows: rows.slice(i, i + BATCH) });
  }
}

const NODE_QUERIES = {
  Account: `UNWIND $rows AS r
            CREATE (:Account {id: r.id, holder: r.holder, created_at: r.created_at,
                              kyc_level: r.kyc_level, status: r.status, balance: r.balance})`,
  VPA: `UNWIND $rows AS r CREATE (:VPA {handle: r.handle})`,
  Device: `UNWIND $rows AS r CREATE (:Device {id: r.id, os: r.os})`,
  Phone: `UNWIND $rows AS r CREATE (:Phone {number: r.number})`,
  Alert: `UNWIND $rows AS r
          CREATE (:Alert {id: r.id, type: r.type, created_at: r.created_at, summary: r.summary})`,
};

// Edges: look up both endpoints by their indexed key, then CREATE the relationship.
const EDGE_QUERIES = {
  HAS_VPA: `UNWIND $rows AS r
            MATCH (a:Account {id: r.from}), (v:VPA {handle: r.to})
            CREATE (a)-[:HAS_VPA]->(v)`,
  USES_DEVICE: `UNWIND $rows AS r
                MATCH (a:Account {id: r.from}), (d:Device {id: r.to})
                CREATE (a)-[:USES_DEVICE {last_seen: r.last_seen}]->(d)`,
  LINKED_PHONE: `UNWIND $rows AS r
                 MATCH (a:Account {id: r.from}), (p:Phone {number: r.to})
                 CREATE (a)-[:LINKED_PHONE]->(p)`,
  SENT: `UNWIND $rows AS r
         MATCH (a:Account {id: r.from}), (b:Account {id: r.to})
         CREATE (a)-[:SENT {txn_id: r.txn_id, amount: r.amount, ts: r.ts}]->(b)`,
  ABOUT: `UNWIND $rows AS r
          MATCH (al:Alert {id: r.from}), (a:Account {id: r.to})
          CREATE (al)-[:ABOUT]->(a)`,
};

const t0 = Date.now();
const graph = await getGraph();
await graph.delete().catch(() => {}); // fine if the graph does not exist yet
await ensureIndexes();                // indexes BEFORE edges, so the MATCH lookups are fast

for (const [label, q] of Object.entries(NODE_QUERIES)) await inBatches(data.nodes[label], q);
for (const [type, q] of Object.entries(EDGE_QUERIES)) await inBatches(data.edges[type], q);

// Sanity check: counts in the DB must equal counts in the file.
const nodeCounts = await writeQuery('MATCH (n) RETURN labels(n)[0] AS label, count(*) AS n ORDER BY label');
const edgeCounts = await writeQuery('MATCH ()-[r]->() RETURN type(r) AS type, count(*) AS n ORDER BY type');
let ok = true;
for (const { label, n } of nodeCounts) if (n !== data.nodes[label].length) ok = false;
for (const { type, n } of edgeCounts) if (n !== data.edges[type].length) ok = false;
console.table(nodeCounts);
console.table(edgeCounts);
console.log(`seeded in ${Date.now() - t0} ms; counts match file: ${ok}`);
await close();
if (!ok) process.exit(1);
