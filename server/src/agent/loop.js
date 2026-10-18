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
//   - Model fallback: Groq's daily token quota is per MODEL. If MODEL's daily quota runs out
//     mid-run, the loop switches to FALLBACK_MODEL and continues from the same step with the
//     same conversation, so the run still finishes. Emits a model_switch trace event.
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
function trimContext(messages, summaries, budget = CONTEXT_BUDGET_TOKENS) {
  const toolMsgs = messages.filter((m) => m.role === 'tool' && !m.trimmed);
  for (const m of toolMsgs.slice(0, -1)) {
    if (estimateTokens(messages) <= budget) return;
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
// Re-sampling the identical request tends to fail the identical way. The common cause on the
// free tier: a long submit_verdict is cut off by a low output cap (the fallback model's OTPM
// limit is 1,000 tokens), so Groq receives half a tool call. Seen on Oct 17: a 7-bullet
// verdict ended mid-word. So the first retry also tells the model to send shorter arguments.
const MALFORMED_HINT = 'Your last tool call could not be parsed: it was probably cut off by the output-token limit. ' +
  'Call the tool again with SHORTER arguments: at most 5 evidence bullets of one short sentence each, and a reason of at most 8 words per action.';

// Daily quota exhausted: 429 whose message names a per-day limit, e.g. "Rate limit reached for
// model `openai/gpt-oss-120b` ... on tokens per day (TPD): Limit 200000 ...". Waiting won't
// help (resets take hours), unlike the per-minute limits (TPM/RPM) the SDK already retries.
const DAILY_LIMIT_RE = /per day \((TPD|RPD)\)/;
export const isDailyQuotaError = (e) => e instanceof Groq.RateLimitError && DAILY_LIMIT_RE.test(e.message ?? '');

// "Request too large ... per minute": some models (e.g. qwen/qwen3.8-27b) have small per-minute
// caps, and Groq rejects a single request that is over them outright (429 or 413). Waiting
// can't fix that; a smaller request can:
//   OTPM (output): "Limit 1000, Requested 1263" -> ask for at most 1000 output tokens.
//   ITPM (input):  "Limit 7000, Requested 7617" -> trim the conversation to fit.
// Returns { kind: 'input' | 'output', limit, requested }, or null.
const TOO_LARGE_RE = /Request too large[\s\S]*?(input|output) tokens per minute \([IO]TPM\): Limit (\d+), Requested (\d+)/;
export function tooLargeFromError(e) {
  const m = e instanceof Groq.APIError && TOO_LARGE_RE.exec(e.message ?? '');
  return m ? { kind: m[1], limit: Number(m[2]), requested: Number(m[3]) } : null;
}
const MAX_INPUT_SHRINKS = 2;

// For a confirmed ring with a collector/cashout: the backward money_trail that reaches every
// branch feeding it, or null if the trace already ran it (or there is no money-flow shape).
// Reach: collector <- second layer <- first layer = 3 hops; from the cashout it is one more.
function missingBacktrace(verdict, trace) {
  if (verdict.verdict !== 'ring_confirmed') return null;
  const members = verdict.ring_members;
  const collector = members.find((m) => m.role === 'collector');
  const sink = collector ?? members.find((m) => m.role === 'cashout');
  if (!sink) return null;
  const hops = collector ? 3 : 4;
  const done = trace.some((e) => e.tool === 'money_trail' && e.args?.direction === 'backward'
    && e.args?.account_id === sink.account_id && Number(e.args?.max_hops) >= hops);
  if (done) return null;
  // Reuse the incident window the agent already chose, so background payments stay filtered.
  const since = trace.find((e) => e.args?.since != null)?.args.since ?? 0;
  return { account_id: sink.account_id, direction: 'backward', max_hops: hops, since };
}

// signal (optional): cancels the run, e.g. when the browser closes the SSE stream.
// client (optional): a Groq-compatible client; tests pass a fake one so they spend no tokens.
export async function investigate(alertId, { onEvent = () => {}, signal, client } = {}) {
  if (!process.env.MODEL) throw new Error('MODEL env var is not set');
  // Models to try in order; FALLBACK_MODEL is optional.
  const models = [...new Set([process.env.MODEL, process.env.FALLBACK_MODEL].filter(Boolean))];
  let modelIdx = 0;
  const maxTokens = new Map(); // model -> lowered max_completion_tokens (see tooLargeFromError)
  let contextBudget = CONTEXT_BUDGET_TOKENS; // lowered if a model's input cap is smaller
  let inputShrinks = 0;
  const modelsUsed = [models[0]];
  client ??= new Groq({ maxRetries: 4 }); // reads GROQ_API_KEY; retries 429s honouring Retry-After

  const started = Date.now();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  signal?.addEventListener('abort', () => abort.abort(), { once: true });

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
  let backtraceNudged = false;
  let malformedRetries = 0;

  try {
    for (let step = 1; step <= MAX_STEPS; step++) {
      trimContext(messages, summaries, contextBudget);
      const lastStep = step === MAX_STEPS;
      let response;
      try {
        response = await client.chat.completions.create(
          { model: models[modelIdx], messages: forApi(messages),
            // Last turn: only submit_verdict is offered and a tool call is required.
            tools: lastStep ? SUBMIT_ONLY : API_TOOLS, tool_choice: lastStep ? 'required' : 'auto',
            max_completion_tokens: maxTokens.get(models[modelIdx]) ?? MAX_COMPLETION_TOKENS, temperature: 0.2 },
          { signal: abort.signal },
        );
      } catch (e) {
        if (isMalformedOutput(e) && malformedRetries < MAX_MALFORMED_RETRIES) {
          malformedRetries++;
          onEvent({ type: 'retry', step, reason: `model output could not be parsed (${e.error?.error?.code ?? e.error?.code}); asking for shorter arguments` });
          if (malformedRetries === 1) messages.push({ role: 'user', content: MALFORMED_HINT });
          step--; // the failed sample doesn't count as a step
          continue;
        }
        const tooLarge = tooLargeFromError(e);
        const current = maxTokens.get(models[modelIdx]) ?? MAX_COMPLETION_TOKENS;
        if (tooLarge?.kind === 'output' && tooLarge.limit < current) { // once per model; if it still fails, give up
          maxTokens.set(models[modelIdx], tooLarge.limit);
          onEvent({ type: 'retry', step, reason: `${models[modelIdx]} allows at most ${tooLarge.limit} output tokens per minute; capping output at ${tooLarge.limit}` });
          step--;
          continue;
        }
        if (tooLarge?.kind === 'input' && inputShrinks < MAX_INPUT_SHRINKS) {
          // Our estimate (chars/4) undercounts for some tokenizers: scale the budget by how far
          // over we were, with a 10% margin, then trim older results to their summaries.
          inputShrinks++;
          contextBudget = Math.floor(contextBudget * (tooLarge.limit / tooLarge.requested) * 0.9);
          onEvent({ type: 'retry', step, reason: `${models[modelIdx]} accepts at most ${tooLarge.limit} input tokens per minute (sent ${tooLarge.requested}); trimming context to ~${contextBudget} estimated tokens` });
          step--;
          continue;
        }
        if (isDailyQuotaError(e)) {
          if (modelIdx === models.length - 1) {
            throw new Error(`daily token quota exhausted for ${models.join(' and ')}`, { cause: e });
          }
          const from = models[modelIdx++];
          modelsUsed.push(models[modelIdx]);
          onEvent({ type: 'model_switch', step, from, to: models[modelIdx], reason: 'daily token quota exhausted' });
          step--; // the rejected request produced nothing; redo this step on the next model
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
        // Completeness guard: a forward trace from the alerted victim only finds the branch that
        // victim paid; mules fed by the ring's OTHER victims join further down (Ring A's ACC1895/
        // ACC1896 feed the second layer). The prompt asks for a backward trace from the collector,
        // but the model skips it or picks too few hops, so the CODE runs it once (same read-only
        // money_trail tool, emitted as a normal trace event) and hands the result back with the
        // verdict for a resubmit. Not on the last step, so a resubmit always has a turn left.
        const backArgs = check.ok && !backtraceNudged && !lastStep ? missingBacktrace(check.verdict, trace) : null;
        if (backArgs) {
          backtraceNudged = true; // separate from verdictRetryUsed: this is a completeness check, not a schema error
          onEvent({ type: 'verdict_rejected', step, errors: [`completeness check: tracing money backward from ${backArgs.account_id}`] });
          const t0 = Date.now();
          let content;
          try {
            const res = await tools.money_trail.run(backArgs);
            const event = { type: 'tool', step, tool: 'money_trail', args: backArgs, ms: Date.now() - t0,
              cypher: res.cypher, summary: res.summary, nodes: res.nodes ?? [], edges: res.edges ?? [] };
            event.nodes.forEach((n) => touchedNodes.add(n));
            event.edges.forEach((e) => touchedEdges.add(e));
            trace.push(event);
            onEvent(event);
            content = `Verdict not accepted yet: completeness check. Backward trace from ${backArgs.account_id} ` +
              `(every branch that fed it):\n${toModelText(res)}\n` +
              'Add every account on these paths to ring_members: an old, full-KYC account that only pays in is a victim (never freeze); ' +
              'a new, kyc=min account that forwards money is a layer (recommend freeze). Then resubmit.';
          } catch (e) {
            content = `Completeness check failed (${e.message}). Resubmit your verdict.`;
          }
          messages.push({ role: 'tool', tool_call_id: submit.id, name: 'submit_verdict', content });
        } else if (check.ok) {
          const verdict = { ...check.verdict, touched: { nodes: [...touchedNodes], edges: [...touchedEdges] } };
          onEvent({ type: 'verdict', step, verdict });
          return { verdict, trace, usage, steps: step, ms: Date.now() - started, models: modelsUsed };
        }
        if (!check.ok) {
          if (verdictRetryUsed) throw new Error(`invalid verdict after retry: ${check.errors.join('; ')}`);
          verdictRetryUsed = true;
          onEvent({ type: 'verdict_rejected', step, errors: check.errors });
          messages.push({ role: 'tool', tool_call_id: submit.id, name: 'submit_verdict',
            content: `Verdict rejected, fix and resubmit: ${check.errors.join('; ')}` });
        }
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
    const message = signal?.aborted ? 'cancelled by client'
      : abort.signal.aborted ? `timed out after ${TIMEOUT_MS} ms` : e.message;
    onEvent({ type: 'error', message });
    throw new Error(message, { cause: e });
  } finally {
    clearTimeout(timer);
  }
}
