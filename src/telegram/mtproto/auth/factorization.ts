import { modPow } from '../bytes';
import { createMtprotoError } from '../errors';

const MIN_PQ = 15n;
const MAX_PQ = 0x7fff_ffff_ffff_ffffn;
const RHO_ATTEMPT_LIMIT = 12;
const RHO_STEPS_PER_ATTEMPT = 200_000;
const UINT64_MASK = 0xffff_ffff_ffff_ffffn;
const SPLITMIX_INCREMENT = 0x9e37_79b9_7f4a_7c15n;

// The first composite that is a strong probable prime to all twelve bases is
// above 2^63: https://doi.org/10.1090/mcom/3134
const PRIMALITY_BASES = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n] as const;

/**
 * Telegram defines pq as the product of two different odd primes and requires
 * the client to return p < q: https://core.telegram.org/mtproto/auth_key
 */
export function factorizePq(pq: bigint) {
  if (typeof pq !== 'bigint') {
    throw createMtprotoError('protocol', 'PQ must be a bigint.');
  }
  if (pq < MIN_PQ || pq > MAX_PQ) {
    throw createMtprotoError('protocol', 'PQ is outside the supported 63-bit range.');
  }
  if ((pq & 1n) === 0n) {
    throw createMtprotoError('protocol', 'PQ must be odd.');
  }

  for (const prime of PRIMALITY_BASES) {
    if (pq % prime === 0n) return finishFactorization(pq, prime);
  }
  if (isPrime(pq)) {
    throw createMtprotoError('protocol', 'PQ must be composite.');
  }
  if (isPerfectSquare(pq)) {
    throw createMtprotoError('protocol', 'PQ must contain two distinct odd prime factors.');
  }

  const factor = findFactor(pq);
  if (factor === undefined) {
    throw createMtprotoError('protocol', 'PQ factorization exceeded its work limit.');
  }
  return finishFactorization(pq, factor);
}

function finishFactorization(pq: bigint, factor: bigint) {
  if (factor <= 1n || factor >= pq || pq % factor !== 0n) {
    throw createMtprotoError('protocol', 'PQ does not have the required prime factors.');
  }

  const other = pq / factor;
  const p = factor < other ? factor : other;
  const q = factor < other ? other : factor;
  if (p === q || (p & 1n) === 0n || !isPrime(p) || !isPrime(q)) {
    throw createMtprotoError('protocol', 'PQ must contain two distinct odd prime factors.');
  }
  return Object.freeze({ p, q });
}

function isPrime(candidate: bigint) {
  if (candidate < 2n) return false;
  for (const prime of PRIMALITY_BASES) {
    if (candidate === prime) return true;
    if (candidate % prime === 0n) return false;
  }

  let oddPart = candidate - 1n;
  let powerOfTwo = 0;
  while ((oddPart & 1n) === 0n) {
    oddPart >>= 1n;
    powerOfTwo += 1;
  }

  for (const witness of PRIMALITY_BASES) {
    const base = witness % candidate;
    if (base === 0n) continue;
    let residue = modPow(base, oddPart, candidate);
    if (residue === 1n || residue === candidate - 1n) continue;

    let probablyPrime = false;
    for (let round = 1; round < powerOfTwo; round += 1) {
      residue = (residue * residue) % candidate;
      if (residue === candidate - 1n) {
        probablyPrime = true;
        break;
      }
      if (residue === 1n) break;
    }
    if (!probablyPrime) return false;
  }
  return true;
}

// Pollard's rho method: https://doi.org/10.1007/BF01933667
// The tortoise advances once and the hare twice, giving Floyd cycle detection.
function findFactor(composite: bigint) {
  let scheduleState = composite ^ SPLITMIX_INCREMENT;
  for (let attempt = 0; attempt < RHO_ATTEMPT_LIMIT; attempt += 1) {
    scheduleState = (scheduleState + SPLITMIX_INCREMENT) & UINT64_MASK;
    const start = 2n + (mix64(scheduleState) % (composite - 3n));
    scheduleState = (scheduleState + SPLITMIX_INCREMENT) & UINT64_MASK;
    const constant = 1n + (mix64(scheduleState) % (composite - 1n));

    const constantFactor = greatestCommonDivisor(constant, composite);
    if (constantFactor > 1n && constantFactor < composite) return constantFactor;

    let tortoise = start;
    let hare = start;
    for (let step = 0; step < RHO_STEPS_PER_ATTEMPT; step += 1) {
      tortoise = rhoStep(tortoise, constant, composite);
      hare = rhoStep(rhoStep(hare, constant, composite), constant, composite);
      const difference = tortoise >= hare ? tortoise - hare : hare - tortoise;
      const factor = greatestCommonDivisor(difference, composite);
      if (factor === 1n) continue;
      if (factor < composite) return factor;
      break;
    }
  }
  return undefined;
}

function rhoStep(value: bigint, constant: bigint, modulus: bigint) {
  return (value * value + constant) % modulus;
}

function greatestCommonDivisor(left: bigint, right: bigint) {
  let a = left;
  let b = right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function isPerfectSquare(value: bigint) {
  let root = 1n << BigInt(Math.ceil(value.toString(2).length / 2));
  while (true) {
    const next = (root + value / root) >> 1n;
    if (next >= root) return root * root === value;
    root = next;
  }
}

function mix64(value: bigint) {
  let mixed = value;
  mixed = ((mixed ^ (mixed >> 30n)) * 0xbf58_476d_1ce4_e5b9n) & UINT64_MASK;
  mixed = ((mixed ^ (mixed >> 27n)) * 0x94d0_49bb_1331_11ebn) & UINT64_MASK;
  return (mixed ^ (mixed >> 31n)) & UINT64_MASK;
}
