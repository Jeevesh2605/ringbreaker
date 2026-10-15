// Agent loop (SPEC 8.1): the model picks tool calls, we run them, return results, repeat.
// LLM provider: Groq (OpenAI-style chat completions with function calling), model from MODEL.
//
// We write this loop by hand so every safety limit is explicit and visible in one place:
//   - MAX_STEPS model turns (10). On the LAST turn the model is offered only submit_verdict
//     and must call a tool, so a run can't end without a verdict just by running out of steps.
//   - TIMEOUT_MS wall clock for the whole run (aborts the in-flight API request too).
//   - TOKEN_CAP total tokens across all turns (protects the daily token quota).
//   - CONTEXT_BUDGET: Groq's free/dev tiers allow only ~8K tokens PER MINUTE, and every turn
//     re-sends the whole conversation. When the conversation grows past the budget, the
//     oldest tool results are replaced by their one-line summaries (see trimContext).
//   - Each tool call emits a trace event (tool, args, cypher, summary, touched ids).
//   - The run ends only through submit_verdict + validateVerdict (one retry if invalid).
//   - Only READ tools are offered. The agent can recommend a freeze but has no tool to do it.
import Groq from 'groq-sdk';
import { tools } from '../tools/index.js';
import { SYSTEM_PROMPT, userMessage } from './prompt.js';
import { SUBMIT_VERDICT_TOOL, validateVerdict } from './verdict.js';

export const MAX_STEPS = 10;
export const TIMEOUT_MS = 600_000;       // at 8K tokens/min a 10-step run needs ~5-7 minutes
export const TOKEN_CAP = 120_000;        // per investigation
const CONTEXT_BUDGET_TOKENS = 5_500;      // estimated prompt size we try to stay under
const MAX_RESULT_CHARS = 4_000;           // ~1.1K tokens: cap for a single tool result
const MAX_COMPLETION_TOKENS = 3_000;      // includes hidden reasoning tokens on reasoning models

// Tool definitions in OpenAI/Groq "function" format.
const API_TOOLS = [
  ...Object.entries(tools).map(([name, t]) => ({ name, description: t.description, input_schema: t.input_schema })),
  SUBMIT_VERDICT_TOOL,
].map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
const SUBMIT_ONLY = API_TOOLS.filter((t) => t.function.name === 'submit_verdict');

// Rough token estimate (~4 chars per token). Good enough to decide when to trim.
const estimateTokens = (messages) =>
  Math.ceil((JSON.stringify(messages).length + JSON.stringify(API_TOOLS).length) / 4);

// Shorten ISO timestamps ("2026-10-12T12:00:00.000Z" -> "2026-10-12T12:00Z") and drop nulls:
// cuts ~25% off tool results without losing anything the model needs.
const ISO_RE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d):\d\d\.\d{3}Z$/;
function toModelText(res) {
  const text = JSON.stringify({ summary: res.summary, data: res.data }, (k, v) =>
    (v === null ? undefined : typeof v === 'string' && ISO_RE.test(v) ? v.replace(ISO_RE, '$1Z') : v));
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}... [truncated; use a narrower query or a later since]`
    : text;
}

// Replace the oldest full tool results with their summaries until the prompt fits the
// budget. The newest result is never trimmed. Trimmed text keeps the summary, so the
// model still knows what it learned, and the full data stays in the trace.
function trimContext(messages, summaries) {
  const toolMsgs = messages.filter((m) => m.role === 'tool' && !m.trimmed);
  for (const m of toolMsgs.slice(0, -1)) {
    if (estimateTokens(messages) <= CONTEXT_BUDGET_TOKENS) return;
    m.content = `[older result trimmed to save context] ${summaries.get(m.tool_call_id)}`;
    m.trimmed = true;
  }
}
// `trimmed` is our own bookkeeping flag; strip it before sending.
const forApi = (messages) => messages.map(({ trimmed, ...m }) => m);

function parseArgs(raw) {
  try { return { args: JSON.parse(raw || '{}') }; } catch { return { error: 'arguments were not valid JSON' }; }
}
// Groq rejects a turn with 400 when the model's output can't be parsed into a tool call:
// tool_use_failed (malformed call) or output_parse_failed (e.g. it wrote its reasoning as
// plain text). Both are sampling failures, so we re-sample the same turn.
const MALFORMED_CODES = ['tool_use_failed', 'output_parse_failed'];
const isMalformedOutput = (e) => e instanceof Groq.BadRequestError &&
  MALFORMED_CODES.includes(e.error?.error?.code ?? e.error?.code);
const MAX_MALFORMED_RETRIES = 2;

export async function investigate(alertId, { onEvent = () => {} } = {}) {
  const model = process.env.MODEL;
  if (!model) throw new Error('MODEL env var is not set');
  const client = new Groq({ maxRetries: 4 }); // reads GROQ_API_KEY; retries 429s honouring Retry-After

  const started = Date.now();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMessage(alertId) },
  ];
  const summaries = new Map(); // tool_call_id -> one-line summary (used when trimming)
  const trace = [];
  const touchedNodes = new Set();
  const touchedEdges = new Set();
  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  let verdictRetryUsed = false;
  let malformedRetries = 0;

  try {
    for (let step = 1; step <= MAX_STEPS; step++) {
      trimContext(messages, summaries);
      const lastStep = step === MAX_STEPS;
      let response;
      try {
        response = await client.chat.completions.create(
          { model, messages: forApi(messages),
            // Last turn: only submit_verdict is offered and a tool call is required.
            tools: lastStep ? SUBMIT_ONLY : API_TOOLS, tool_choice: lastStep ? 'required' : 'auto',
            max_completion_tokens: MAX_COMPLETION_TOKENS, temperature: 0.2 },
          { signal: abort.signal },
        );
      } catch (e) {
        if (isMalformedOutput(e) && malformedRetries < MAX_MALFORMED_RETRIES) {
          malformedRetries++;
          onEvent({ type: 'retry', step, reason: `model output could not be parsed (${e.error?.error?.code ?? e.error?.code})` });
          step--; // the failed sample doesn't count as a step
          continue;
        }
        throw e;
      }

      usage.prompt_tokens += response.usage?.prompt_tokens ?? 0;
      usage.completion_tokens += response.usage?.completion_tokens ?? 0;
      if (usage.prompt_tokens + usage.completion_tokens > TOKEN_CAP) {
        throw new Error(`token cap exceeded (${usage.prompt_tokens + usage.completion_tokens} > ${TOKEN_CAP})`);
      }
      const choice = response.choices[0];
      if (choice.finish_reason === 'length') throw new Error('response hit max_completion_tokens');

      // Keep only content + tool_calls (drop any reasoning text: it costs tokens on every turn).
      const msg = choice.message;
      const calls = msg.tool_calls ?? [];
      messages.push({ role: 'assistant', content: msg.content ?? '', ...(calls.length ? { tool_calls: calls } : {}) });

      // Model stopped without any tool call: nudge it to submit (shares the single retry).
      if (!calls.length) {
        if (verdictRetryUsed) throw new Error('model stopped without submitting a verdict');
        verdictRetryUsed = true;
        messages.push({ role: 'user', content: 'Call submit_verdict now with your conclusion.' });
        continue;
      }

      // 1) The final answer.
      const submit = calls.find((c) => c.function.name === 'submit_verdict');
      if (submit) {
        const { args, error } = parseArgs(submit.function.arguments);
        const check = error ? { ok: false, errors: [error] } : validateVerdict(args, touchedNodes);
        if (check.ok) {
          const verdict = { ...check.verdict, touched: { nodes: [...touchedNodes], edges: [...touchedEdges] } };
          onEvent({ type: 'verdict', step, verdict });
          return { verdict, trace, usage, steps: step, ms: Date.now() - started };
        }
        if (verdictRetryUsed) throw new Error(`invalid verdict after retry: ${check.errors.join('; ')}`);
        verdictRetryUsed = true;
        onEvent({ type: 'verdict_rejected', step, errors: check.errors });
        messages.push({ role: 'tool', tool_call_id: submit.id, name: 'submit_verdict',
          content: `Verdict rejected, fix and resubmit: ${check.errors.join('; ')}` });
      }

      // 2) Read tools, run in parallel when the model asks for several. A failing tool becomes
      //    an error result the model can react to (bad args, guard rejection, timeout).
      const readCalls = calls.filter((c) => c.function.name !== 'submit_verdict');
      const executed = await Promise.all(readCalls.map(async (call) => {
        const t0 = Date.now();
        const { args, error: argError } = parseArgs(call.function.arguments);
        const tool = tools[call.function.name];
        try {
          if (argError) throw new Error(argError);
          if (!tool) throw new Error(`unknown tool ${call.function.name}`);
          return { call, args, res: await tool.run(args), ms: Date.now() - t0 };
        } catch (e) {
          return { call, args, error: e.message, ms: Date.now() - t0 };
        }
      }));
      for (const { call, args, res, error, ms } of executed) {
        const summary = error ? `error: ${error}` : res.summary;
        const event = {
          type: 'tool', step, tool: call.function.name, args, ms,
          cypher: res?.cypher ?? null, summary, nodes: res?.nodes ?? [], edges: res?.edges ?? [],
        };
        event.nodes.forEach((n) => touchedNodes.add(n));
        event.edges.forEach((e) => touchedEdges.add(e));
        trace.push(event);
        onEvent(event);
        summaries.set(call.id, `${call.function.name}: ${summary}`);
        messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name,
          content: error ? `Error: ${error}` : toModelText(res) });
      }

      if (step === MAX_STEPS - 1) {
        messages.push({ role: 'user', content: 'Step limit reached: your next turn is the last one. Call submit_verdict with what you have.' });
      }
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
