// Call one tool from the terminal (Day 1 acceptance tests).
//
// Usage: npm run tool -- <tool_name> '<json args>' [--full]
//   npm run tool -- get_alert '{"alert_id":"ALT001"}'
//   npm run tool -- money_trail '{"account_id":"ACC1833","direction":"forward","max_hops":4,"since":"2026-10-12"}'
// Prints the Cypher, summary and touched IDs; --full also prints the data payload.
import { tools } from '../server/src/tools/index.js';
import { close } from '../server/src/db.js';

const [name, rawArgs = '{}', flag] = process.argv.slice(2);
if (!tools[name]) {
  console.error(`unknown tool "${name}". Available: ${Object.keys(tools).join(', ')}`);
  process.exit(1);
}
try {
  const res = await tools[name].run(JSON.parse(rawArgs));
  console.log(`--- ${name} ---\nCypher:${res.cypher}\nparams: ${JSON.stringify(res.params)}`);
  console.log(`summary: ${res.summary}`);
  console.log(`nodes (${res.nodes.length}): ${res.nodes.join(' ')}`);
  console.log(`edges (${res.edges.length}): ${res.edges.slice(0, 40).join(' ')}${res.edges.length > 40 ? ' ...' : ''}`);
  if (flag === '--full') console.dir(res.data, { depth: null, maxArrayLength: null });
} catch (e) {
  console.error(`tool error: ${e.message}`);
  process.exitCode = 1;
} finally {
  await close();
}
