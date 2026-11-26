// Preload for date-bomb checks, not a test of its own:
//   node --import <file URL of this file> tests/<folder>/<name>.mjs
// Shifts Date.now() and argument-less new Date()/Date() to SERVERDESK_TEST_NOW
// (default futureTestNow(): today's UTC date plus four years, see
// tests/support/clock.mjs). The clock keeps running from there, so
// code that measures elapsed time still works. Date.parse, Date.UTC and
// new Date(<value>) are untouched. A Proxy keeps Date.prototype and instanceof.
import {futureTestNow} from './clock.mjs';

const RealDate = Date;
const realNow = RealDate.now;
const requested = process.env.SERVERDESK_TEST_NOW ?? futureTestNow();
const start = RealDate.parse(requested);
if (!Number.isFinite(start)) {
  console.error(`fixed-clock: SERVERDESK_TEST_NOW is not a valid date: ${JSON.stringify(requested)}`);
  process.exit(1);
}
const offset = start - realNow();
const shiftedNow = () => realNow() + offset;

RealDate.now = shiftedNow;
globalThis.Date = new Proxy(RealDate, {
  construct(target, args, newTarget) {
    return Reflect.construct(target, args.length ? args : [shiftedNow()], newTarget);
  },
  apply() {
    return new RealDate(shiftedNow()).toString();
  },
});
