// Synthetic data generator (SPEC section 7). ALL DATA IS SYNTHETIC: names are drawn
// from small generic lists, phone numbers use the invalid "+91-00..." range, and no
// real person or bank is represented.
//
// Seeded RNG + fixed clock => the same graph every run, so the demo is reproducible.
//
// Output:
//   data/out/graph.json    nodes + edges, consumed by scripts/seed.js
//   data/ground_truth.json ring members and the expected verdict per alert (for evals)
//
// Usage: node data/generate.js
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = 42;
// Fixed "now" instead of Date.now(), so timestamps are identical every run.
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0); // 2026-10-14 12:00 UTC
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

// ---------- seeded RNG (mulberry32: tiny, fast, deterministic) ----------
let s = SEED >>> 0;
function rand() {
  s = (s + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1)); // inclusive
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const chance = (p) => rand() < p;
function sample(arr, n) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}
// Log-uniform amount: many small payments, few large ones (like real P2P).
const amount = (lo, hi) => Math.round(Math.exp(Math.log(lo) + rand() * (Math.log(hi) - Math.log(lo))));

// ---------- builders ----------
const FIRST = ['Aarav', 'Vivaan', 'Aditya', 'Ishaan', 'Kabir', 'Rohan', 'Arjun', 'Karan', 'Rahul', 'Vikram',
  'Ananya', 'Diya', 'Priya', 'Sneha', 'Kavya', 'Meera', 'Pooja', 'Neha', 'Riya', 'Asha',
  'Suresh', 'Ramesh', 'Mahesh', 'Ganesh', 'Lakshmi', 'Sunita', 'Farhan', 'Imran', 'Ayesha', 'Zoya',
  'Harpreet', 'Gurpreet', 'Simran', 'Joseph', 'Mary', 'Thomas', 'Deepak', 'Nikhil', 'Tanvi', 'Yash'];
const LAST = ['Sharma', 'Verma', 'Patel', 'Reddy', 'Nair', 'Iyer', 'Gupta', 'Singh', 'Khan', 'Das',
  'Mehta', 'Joshi', 'Rao', 'Pillai', 'Banerjee', 'Kulkarni', 'Chopra', 'Malhotra', 'Shaikh', 'Fernandes'];
const BANKS = ['okbank', 'paysafe', 'upimint', 'ybl', 'axl'];

const accounts = [], vpas = [], devices = [], phones = [], alerts = [];
const hasVpa = [], usesDevice = [], linkedPhone = [], sent = [], about = [];
let accN = 0, devN = 0, phoneN = 0, txnN = 0, alertN = 0;
const usedHandles = new Set();

function newDevice(os) {
  const d = { id: `DEV${String(++devN).padStart(5, '0')}`, os: os || (chance(0.75) ? 'Android' : 'iOS') };
  devices.push(d);
  return d.id;
}
function newPhone() {
  // "+91-00" prefix is not a valid Indian mobile range: obviously fake by construction.
  const p = { number: `+91-00${String(100000 + ++phoneN).slice(-6)}${randInt(10, 99)}` };
  phones.push(p);
  return p.number;
}
function newAccount({ holder, createdDaysAgo, kyc, balance, device, phone, handleBase }) {
  const first = pick(FIRST), last = pick(LAST);
  const a = {
    id: `ACC${String(++accN).padStart(4, '0')}`,
    holder: holder || `${first} ${last}`,
    created_at: NOW - (createdDaysAgo ?? randInt(200, 2000)) * DAY - randInt(0, DAY),
    kyc_level: kyc || (chance(0.88) ? 'full' : 'min'),
    status: 'active',
    balance: balance ?? amount(500, 150000),
  };
  accounts.push(a);
  // One VPA per account; handle derived from the name, made unique with a counter.
  let base = (handleBase || `${first}${last}`).toLowerCase().replace(/[^a-z0-9]/g, '');
  let handle = `${base}${randInt(1, 999)}@${pick(BANKS)}`;
  while (usedHandles.has(handle)) handle = `${base}${randInt(1, 9999)}@${pick(BANKS)}`;
  usedHandles.add(handle);
  vpas.push({ handle });
  hasVpa.push({ from: a.id, to: handle });
  const dev = device || newDevice();
  usesDevice.push({ from: a.id, to: dev, last_seen: NOW - randInt(0, 5 * DAY) });
  linkedPhone.push({ from: a.id, to: phone || newPhone() });
  return a.id;
}
function txn(from, to, amt, ts) {
  sent.push({ from, to, txn_id: `TXN${String(++txnN).padStart(6, '0')}`, amount: amt, ts: Math.round(ts) });
}
function alert(type, accountId, createdAt, summary) {
  const id = `ALT${String(++alertN).padStart(3, '0')}`;
  alerts.push({ id, type, created_at: createdAt, summary });
  about.push({ from: id, to: accountId });
  return id;
}

// ---------- 1. background: normal customers ----------
const normal = [];
for (let i = 0; i < 1880; i++) {
  const id = newAccount({});
  normal.push(id);
  if (chance(0.12)) usesDevice.push({ from: id, to: newDevice(), last_seen: NOW - randInt(0, 30 * DAY) }); // second phone/tablet
}

// Ordinary merchants (kirana, pharmacy, ...): long-lived, full KYC, many small inbound payments.
const merchants = [];
for (const name of ['Sri Balaji Kirana', 'Green Leaf Pharmacy', 'City Auto Fuels', 'Annapurna Mess',
  'Metro Mobile Repairs', 'Lucky Fruits', 'Royal Tailors', 'Fresh Dairy Point']) {
  merchants.push(newAccount({ holder: name, createdDaysAgo: randInt(900, 2500), kyc: 'full',
    balance: amount(50000, 500000), handleBase: name }));
}

// BENIGN LOOK-ALIKE 1: tea-stall chain. Very high fan-in, but: years old, full KYC,
// its own device and phone, payments spread across 90 days, and the outflow is a
// weekly payout to one supplier, not a fast sweep. Must NOT be flagged.
const teaStall = newAccount({ holder: 'Chai Junction Tea Stalls', createdDaysAgo: 1800, kyc: 'full',
  balance: 320000, handleBase: 'chaijunction' });
const teaSupplier = newAccount({ holder: 'Nilgiri Tea Traders', createdDaysAgo: 2400, kyc: 'full',
  balance: 900000, handleBase: 'nilgiritea' });

// BENIGN LOOK-ALIKE 2: a family of 4 sharing one device and one phone. Old accounts,
// full KYC, small transfers among themselves and to merchants. Must NOT be flagged.
const famDevice = newDevice('Android');
const famPhone = newPhone();
const family = [];
for (const first of ['Ramesh', 'Sunita', 'Rohan', 'Priya']) {
  family.push(newAccount({ holder: `${first} Kulkarni`, createdDaysAgo: randInt(1000, 2000), kyc: 'full',
    device: famDevice, phone: famPhone }));
}

// ---------- 2. background transactions (90 days) ----------
// Each normal user has a small friend circle; P2P payments go to friends, which gives
// the graph realistic local clusters instead of uniform random noise.
const friends = new Map(normal.map((id) => [id, sample(normal, randInt(4, 12)).filter((f) => f !== id)]));
const randTs = () => NOW - rand() * 90 * DAY;
for (let i = 0; i < 13900; i++) {
  const from = pick(normal);
  txn(from, pick(friends.get(from)), amount(50, 8000), randTs());
}
for (let i = 0; i < 4200; i++) txn(pick(normal), pick(merchants), amount(20, 2500), randTs());
for (let i = 0; i < 40; i++) txn(pick(merchants), pick(normal), amount(1000, 30000), randTs()); // refunds/salaries
// Tea stall: ~1,500 tiny payments from ~450 distinct customers, spread over 90 days.
const teaCustomers = sample(normal, 450);
for (let i = 0; i < 1500; i++) txn(pick(teaCustomers), teaStall, randInt(10, 120), randTs());
for (let w = 0; w < 13; w++) txn(teaStall, teaSupplier, amount(5000, 7000), NOW - w * 7 * DAY - 10 * HOUR);
// Family: frequent small transfers inside the family and to local merchants.
for (let i = 0; i < 90; i++) {
  const [a, b] = sample(family, 2);
  txn(a, b, amount(100, 5000), randTs());
}
for (let i = 0; i < 60; i++) txn(pick(family), pick(merchants), amount(50, 3000), randTs());

// ---------- 3. RING A: layering chain ----------
// victims -> first-layer mules -> second-layer mules -> collector -> cash-out.
// Mules: created in the last few weeks, minimum KYC. Each victim's loss is split into
// chunks below a 10,000 alert threshold, and every hop forwards within minutes.
const mule = (days) => newAccount({ createdDaysAgo: days, kyc: 'min', balance: randInt(50, 900) });
const aVictims = sample(normal, 4);
const aL1 = [mule(randInt(8, 25)), mule(randInt(8, 25)), mule(randInt(8, 25))];
const aL2 = [mule(randInt(10, 30)), mule(randInt(10, 30))];
const aCollector = mule(randInt(15, 35));
const aCashout = mule(randInt(15, 35));
const scamStartA = NOW - 2 * DAY; // the scam ran two days ago

// The victims complained, so they make no further payments after the scam. Move any of
// their background payments in that window earlier; this keeps a forward money trail
// from a victim (with a `since` filter) focused on the scam.
for (const t of sent) {
  if (aVictims.includes(t.from) && t.ts >= scamStartA - HOUR) t.ts -= 20 * DAY;
}

let l1Inbound = new Map(aL1.map((id) => [id, 0]));
aVictims.forEach((v, vi) => {
  let ts = scamStartA + vi * randInt(25, 50) * MIN;
  for (let k = 0; k < randInt(2, 4); k++) {   // 2-4 split payments per victim
    const target = pick(aL1);
    const amt = randInt(4000, 9900);
    txn(v, target, amt, ts);
    l1Inbound.set(target, l1Inbound.get(target) + amt);
    ts += randInt(3, 12) * MIN;
  }
});
// Each first-layer mule forwards ~95-98% of what it received to the second layer, in chunks.
let l2Inbound = new Map(aL2.map((id) => [id, 0]));
let tsA = scamStartA + 3 * HOUR;
for (const m of aL1) {
  let left = Math.floor(l1Inbound.get(m) * (0.95 + rand() * 0.03));
  while (left > 0) {
    const amt = Math.min(left, randInt(5000, 9800));
    const target = pick(aL2);
    txn(m, target, amt, (tsA += randInt(2, 9) * MIN));
    l2Inbound.set(target, l2Inbound.get(target) + amt);
    left -= amt;
  }
}
let collected = 0;
for (const m of aL2) {
  let left = Math.floor(l2Inbound.get(m) * 0.97);
  while (left > 0) {
    const amt = Math.min(left, randInt(7000, 9900));
    txn(m, aCollector, amt, (tsA += randInt(3, 10) * MIN));
    collected += amt;
    left -= amt;
  }
}
// Collector -> cash-out in two bigger moves (the cash-out withdraws at an ATM, not modeled).
const half = Math.floor(collected * 0.49);
txn(aCollector, aCashout, half, (tsA += 40 * MIN));
txn(aCollector, aCashout, Math.floor(collected * 0.98) - half, (tsA += 25 * MIN));

// ---------- 4. RING B: device farm ----------
// 6 accounts operated from 2 devices and 1 phone. Each gets small payments from many
// different senders over ~3 days (a fake "task job" scam), then sweeps to one account.
const bDev = [newDevice('Android'), newDevice('Android')];
const bPhone = newPhone();
const bMules = [];
for (let i = 0; i < 6; i++) {
  bMules.push(newAccount({ createdDaysAgo: randInt(5, 20), kyc: 'min', balance: randInt(20, 500),
    device: bDev[i % 2], phone: bPhone }));
}
// Some farm accounts are logged in from BOTH devices (as farms rotate handsets).
usesDevice.push({ from: bMules[0], to: bDev[1], last_seen: NOW - 3 * HOUR });
usesDevice.push({ from: bMules[3], to: bDev[0], last_seen: NOW - 5 * HOUR });
const bSweep = mule(randInt(20, 40));
const scamStartB = NOW - 4 * DAY;
const bSenders = sample(normal.filter((id) => !aVictims.includes(id)), 100);
const bVictims = [];
for (const m of bMules) {
  let total = 0;
  for (const snd of sample(bSenders, randInt(14, 22))) {
    const amt = randInt(500, 3000);
    txn(snd, m, amt, scamStartB + rand() * 3 * DAY);
    if (!bVictims.includes(snd)) bVictims.push(snd);
    total += amt;
  }
  // Sweep almost everything out in 1-2 transfers at the end of the window.
  const first = Math.floor(total * 0.6);
  txn(m, bSweep, first, scamStartB + 3 * DAY + randInt(10, 120) * MIN);
  txn(m, bSweep, Math.floor(total * 0.97) - first, scamStartB + 3 * DAY + randInt(130, 300) * MIN);
}

// ---------- 5. RING C: decoy ----------
// 3 accounts that share one device, which looks suspicious, but they have no money link
// to each other and ordinary, low-value activity. Correct answer: weak evidence, monitor.
const cDev = newDevice('Android');
const cAccounts = [];
for (let i = 0; i < 3; i++) cAccounts.push(newAccount({ createdDaysAgo: randInt(60, 200), kyc: 'full', device: cDev }));
for (const c of cAccounts) {
  for (let i = 0; i < randInt(6, 12); i++) txn(pick(normal), c, amount(100, 3000), randTs());
  for (let i = 0; i < randInt(5, 10); i++) txn(c, pick(merchants), amount(50, 2000), randTs());
}
const cComplainant = pick(normal.filter((id) => !aVictims.includes(id) && !bVictims.includes(id)));
txn(cComplainant, cAccounts[0], 2400, NOW - 6 * DAY); // one disputed purchase

// ---------- 6. alerts ----------
const altA = alert('victim_complaint', aVictims[0], scamStartA + 6 * HOUR,
  'Customer reports paying ~25,000 to an unknown UPI ID for a fake KYC update; money moved on within hours.');
const altB = alert('victim_complaint', bVictims[0], scamStartB + 3 * DAY + 8 * HOUR,
  'Customer paid a "task job" registration fee and was promised commissions; no payout received.');
const altBFan = alert('fan_in', bMules[2], scamStartB + 3 * DAY,
  'Account received payments from 15+ distinct senders within 72 hours.');
const altC = alert('victim_complaint', cComplainant, NOW - 5 * DAY,
  'Customer says a marketplace seller did not deliver an item paid for via UPI (2,400).');
const altTea = alert('fan_in', teaStall, NOW - 1 * DAY,
  'Account received payments from 100+ distinct senders in 7 days.');
const altFam = alert('velocity', family[2], NOW - 3 * DAY,
  'Several transfers between accounts linked to the same device within one day.');
const altNoise = alert('velocity', pick(normal), NOW - 2 * DAY,
  'Unusual number of outgoing payments compared with 30-day baseline.');

// ---------- 7. write files ----------
const graph = {
  meta: { seed: SEED, now: NOW, generated_note: 'synthetic data, no real persons' },
  nodes: { Account: accounts, VPA: vpas, Device: devices, Phone: phones, Alert: alerts },
  edges: { HAS_VPA: hasVpa, USES_DEVICE: usesDevice, LINKED_PHONE: linkedPhone, SENT: sent, ABOUT: about },
};
const role = (r) => (id) => ({ account_id: id, role: r });
const groundTruth = {
  rings: {
    A: {
      type: 'layering_chain',
      victim_target: aVictims[0],   // start node for the verify query
      cashout: aCashout,            // end node for the verify query
      members: [...aVictims.map(role('victim')), ...[...aL1, ...aL2].map(role('layer')),
        role('collector')(aCollector), role('cashout')(aCashout)],
      freeze: [...aL1, ...aL2, aCollector, aCashout],
    },
    B: {
      type: 'device_farm',
      members: [...bMules.map(role('collector')), role('cashout')(bSweep)],
      freeze: [...bMules, bSweep],
      shared_devices: bDev, shared_phone: bPhone,
    },
    C: { type: 'decoy_shared_device', members: cAccounts, freeze: [] },
  },
  benign: { merchant: teaStall, family },
  alerts: {
    [altA]: { ring: 'A', expected_verdict: 'ring_confirmed' },
    [altB]: { ring: 'B', expected_verdict: 'ring_confirmed' },
    [altBFan]: { ring: 'B', expected_verdict: 'ring_confirmed' },
    [altC]: { ring: 'C', expected_verdict: 'suspicious' },
    [altTea]: { ring: null, expected_verdict: 'benign' },
    [altFam]: { ring: null, expected_verdict: 'benign' },
    [altNoise]: { ring: null, expected_verdict: 'benign' },
  },
};

mkdirSync(join(HERE, 'out'), { recursive: true });
writeFileSync(join(HERE, 'out', 'graph.json'), JSON.stringify(graph));
writeFileSync(join(HERE, 'ground_truth.json'), JSON.stringify(groundTruth, null, 2));

const count = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.length]));
console.log('nodes', count(graph.nodes));
console.log('edges', count(graph.edges));
console.log('Ring A', groundTruth.rings.A.members.length, 'members; Ring B', groundTruth.rings.B.members.length,
  '; Ring C', cAccounts.length, '; alerts', alerts.map((a) => `${a.id}:${a.type}`).join(' '));
