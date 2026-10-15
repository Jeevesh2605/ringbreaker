// Agent loop (SPEC 8.1): the model picks tool calls, we run them, return results, repeat.
//
// We write this loop by hand instead of using the SDK's tool runner so every safety limit is
// explicit and visible in one place:
//   - MAX_STEPS model turns (10). On the last turn the model is told to submit.
//   - TIMEOUT_MS wall clock for the whole run (aborts the in-flight API request too).
//   - TOKEN_CAP total tokens across all turns (a cost ceiling).
//   - Each tool call emits a trace event (tool, args, cypher, summary, touched ids).
//   - The run ends only through submit_verdict + validateVerdict (one retry if invalid).
//   - Only READ tools are offered. The agent can recommend a freeze but has no tool to do it.
import Anthropic from '@anthropic-ai/sdk';
import { tools } from '../tools/index.js';
import { SYSTEM_PROMPT, userMessage } from './prompt.js';
import { SUBMIT_VERDICT_TOOL, validateVerdict } from './verdict.js';

export const MAX_STEPS = 10;
export const TIMEOUT_MS = 180_000;
export const TOKEN_CAP = 600_000;
const MAX_RESULT_CHARS = 20_000; // keeps one huge tool result from flooding the context

// Tool list sent to the API. Sorted the same way on every request so the cached prefix is stable.
const API_TOOLS = [
  ...Object.entries(tools).map(([name, t]) => ({ name, description: t.description, input_schema: t.input_schema })),
  SUBMIT_VERDICT_TOOL,
];

export async function investigate(alertId, { onEvent = () => {} } = {}) {
  const model = process.env.MODEL;
  if (!model) throw new Error('MODEL env var is not set');
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

  const started = Date.now();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);

  const messages = [{ role: 'user', content: userMessage(alertId) }];
  const trace = [];
  const touchedNodes = new Set();
  const touchedEdges = new Set();
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let verdictRetryUsed = false;

  try {
    for (let step = 1; step <= MAX_STEPS; step++) {
      const response = await client.beta.messages.create(
        {
          model,
          max_tokens: 16000,
          system: SYSTEM_PROMPT,
          tools: API_TOOLS,
          messages,
          // Effort is set explicitly; the model default can differ between models.
          output_config: { effort: 'medium' },
          // Automatic prompt caching: each turn re-sends the whole conversation, so caching
          // the growing prefix makes steps 2..N much cheaper.
          cache_control: { type: 'ephemeral' },
          // If the model declines for policy reasons, the API retries on a default fallback model.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        },
        { signal: abort.signal },
      );

      for (const k of Object.keys(usage)) usage[k] += response.usage?.[k] ?? 0;
      const totalTokens = usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
      if (totalTokens > TOKEN_CAP) throw new Error(`token cap exceeded (${totalTokens} > ${TOKEN_CAP})`);
      if (response.stop_reason === 'refusal') throw new Error('model declined the request');
      if (response.stop_reason === 'max_tokens') throw new Error('response hit max_tokens');

      // Append the assistant turn unchanged (the API expects history to be append-only).
      messages.push({ role: 'assistant', content: response.content });
      const calls = response.content.filter((b) => b.type === 'tool_use');
      const results = [];

      // 1) The final answer.
      const submit = calls.find((c) => c.name === 'submit_verdict');
      if (submit) {
        const check = validateVerdict(submit.input, touchedNodes);
        if (check.ok) {
          const verdict = { ...check.verdict, touched: { nodes: [...touchedNodes], edges: [...touchedEdges] } };
          onEvent({ type: 'verdict', step, verdict });
          return { verdict, trace, usage, steps: step, ms: Date.now() - started };
        }
        if (verdictRetryUsed) throw new Error(`invalid verdict after retry: ${check.errors.join('; ')}`);
        verdictRetryUsed = true;
        onEvent({ type: 'verdict_rejected', step, errors: check.errors });
        results.push({ type: 'tool_result', tool_use_id: submit.id, is_error: true,
          content: `Verdict rejected, fix and resubmit: ${check.errors.join('; ')}` });
      }

      // 2) Read tools, run in parallel. A failing tool becomes an is_error result the model
      //    can react to (bad args, guard rejection, timeout); it never crashes the run.
      const readCalls = calls.filter((c) => c.name !== 'submit_verdict');
      const executed = await Promise.all(readCalls.map(async (call) => {
        const t0 = Date.now();
        const tool = tools[call.name];
        try {
          if (!tool) throw new Error(`unknown tool ${call.name}`);
          const res = await tool.run(call.input ?? {});
          return { call, res, ms: Date.now() - t0 };
        } catch (e) {
          return { call, error: e.message, ms: Date.now() - t0 };
        }
      }));
      for (const { call, res, error, ms } of executed) {
        const event = {
          type: 'tool', step, tool: call.name, args: call.input, ms,
          cypher: res?.cypher ?? null, summary: error ? `error: ${error}` : res.summary,
          nodes: res?.nodes ?? [], edges: res?.edges ?? [],
        };
        event.nodes.forEach((n) => touchedNodes.add(n));
        event.edges.forEach((e) => touchedEdges.add(e));
        trace.push(event);
        onEvent(event);
        let content = error ? `Error: ${error}` : JSON.stringify({ summary: res.summary, data: res.data });
        if (content.length > MAX_RESULT_CHARS) content = `${content.slice(0, MAX_RESULT_CHARS)}... [truncated; narrow the query]`;
        results.push({ type: 'tool_result', tool_use_id: call.id, content, ...(error ? { is_error: true } : {}) });
      }

      // 3) Model stopped without any tool call: nudge it to submit (shares the single retry).
      if (!calls.length) {
        if (verdictRetryUsed) throw new Error('model stopped without submitting a verdict');
        verdictRetryUsed = true;
        messages.push({ role: 'user', content: 'Call submit_verdict now with your conclusion.' });
        continue;
      }

      if (step === MAX_STEPS - 1) {
        results.push({ type: 'text', text: 'Step limit reached: your next turn must call submit_verdict with what you have.' });
      }
      messages.push({ role: 'user', content: results });
    }
    throw new Error(`no valid verdict within ${MAX_STEPS} steps`);
  } catch (e) {
    const message = abort.signal.aborted ? `timed out after ${TIMEOUT_MS} ms` : e.message;
    onEvent({ type: 'error', message });
    throw new Error(message, { cause: e });
  } finally {
    clearTimeout(timer);
  }
}
