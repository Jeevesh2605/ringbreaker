// FalkorDB connection + query helpers. ALL database access goes through this file.
//
// Two helpers, on purpose:
//   - readQuery():  uses GRAPH.RO_QUERY. FalkorDB itself rejects any write in a
//                   read-only query, so read tools physically cannot mutate the graph,
//                   even if a bug or a prompt-injected query slipped past our guard.
//   - writeQuery(): uses GRAPH.QUERY. Only seed/schema scripts and action tools may call it.
// Both always take a params object: queries are parameterized, never string-concatenated.
import { FalkorDB } from 'falkordb';

const DEFAULT_TIMEOUT_MS = 5000; // server-side query timeout (FalkorDB TIMEOUT arg)

let dbPromise = null;

function connect() {
  if (!dbPromise) {
    dbPromise = FalkorDB.connect({
      socket: {
        host: process.env.FALKORDB_HOST || 'localhost',
        port: Number(process.env.FALKORDB_PORT || 6379),
      },
      username: process.env.FALKORDB_USERNAME || undefined,
      password: process.env.FALKORDB_PASSWORD || undefined,
    });
  }
  return dbPromise;
}

export async function getGraph() {
  const db = await connect();
  return db.selectGraph(process.env.FALKORDB_GRAPH || 'ring');
}

export async function readQuery(cypher, params = {}, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const graph = await getGraph();
  const res = await graph.roQuery(cypher, { params, TIMEOUT: timeout });
  return res.data ?? []; // array of row objects keyed by RETURN alias
}

export async function writeQuery(cypher, params = {}, { timeout = 30000 } = {}) {
  const graph = await getGraph();
  const res = await graph.query(cypher, { params, TIMEOUT: timeout });
  return res.data ?? [];
}

export async function close() {
  if (dbPromise) {
    const db = await dbPromise;
    await db.close();
    dbPromise = null;
  }
}
