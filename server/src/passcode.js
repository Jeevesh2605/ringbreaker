// Demo passcode for the two routes that cost something: POST /api/investigate (spends Groq
// tokens) and POST /api/actions/approve (freezes accounts). Not real auth (a non-goal in
// SPEC 2): it only stops a stranger with the public link from draining the daily LLM quota
// or freezing the demo ring before the judges see it.
//
// DEMO_PASSCODE unset -> open (local dev). Set -> header x-demo-passcode must match.
import { timingSafeEqual } from 'node:crypto';

export function passcodeOk(given, expected = process.env.DEMO_PASSCODE) {
  if (!expected) return true;
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b); // constant-time compare
}

export function requirePasscode(req, res, next) {
  if (passcodeOk(req.get('x-demo-passcode'))) return next();
  res.status(401).json({ error: 'demo passcode required', code: 'passcode' });
}
