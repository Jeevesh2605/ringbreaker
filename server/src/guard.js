// Read-only Cypher guard for run_readonly_cypher (SPEC 8.3). Free-form Cypher comes from the
// LLM, so we treat it as untrusted input. Three layers of defence:
//   1. This guard rejects write/procedure keywords and multi-statement input, and enforces a LIMIT.
//   2. The query then runs via readQuery() = GRAPH.RO_QUERY, which FalkorDB itself refuses
//      to execute if it would write. Even if layer 1 missed something, nothing is written.
//   3. readQuery() passes a server-side TIMEOUT, so a runaway traversal is killed.

export const MAX_LIMIT = 100;

// Matched as whole words, case-insensitive, anywhere in the text, including inside string
// literals and comments. That can reject a harmless query that mentions 'SET' in a string;
// we accept those false positives because the opposite error would be unsafe.
const FORBIDDEN = ['CREATE', 'MERGE', 'DELETE', 'SET', 'REMOVE', 'DROP', 'CALL', 'LOAD', 'FOREACH'];
const FORBIDDEN_RE = new RegExp(`\\b(${FORBIDDEN.join('|')})\\b`, 'i');

// Returns { ok: true, query } with a LIMIT guaranteed on the final clause, or { ok: false, reason }.
export function guardCypher(input) {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, reason: 'query must be a non-empty string' };
  if (input.length > 2000) return { ok: false, reason: 'query too long (max 2000 chars)' };

  let query = input.trim().replace(/;\s*$/, ''); // a single trailing ; is harmless; strip it
  if (query.includes(';')) return { ok: false, reason: 'multiple statements are not allowed' };

  const bad = query.match(FORBIDDEN_RE);
  if (bad) return { ok: false, reason: `forbidden keyword: ${bad[1].toUpperCase()}` };
  if (!/\bRETURN\b/i.test(query)) return { ok: false, reason: 'query must RETURN something' };

  // LIMIT on the final clause: cap it if it's a number, reject it if it's anything else
  // (e.g. $param), add one if there is none.
  const tail = query.match(/\bLIMIT\s+(\S+)\s*$/i);
  if (tail) {
    const n = Number(tail[1]);
    if (!Number.isInteger(n) || n < 0) return { ok: false, reason: 'final LIMIT must be a literal integer' };
    if (n > MAX_LIMIT) query = query.slice(0, tail.index) + `LIMIT ${MAX_LIMIT}`;
  } else {
    query = `${query} LIMIT ${MAX_LIMIT}`;
  }
  return { ok: true, query };
}
