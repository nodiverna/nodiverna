// The test clock for date-bomb runs: today's UTC date plus four years at
// 00:00:00.000Z. Date.UTC rolls a 29 February into a non-leap year over to
// 1 March. Rounding to midnight keeps the date stable for a whole day.
export function futureTestNow(now = Date.now()) {
  const today = new Date(now);
  return new Date(Date.UTC(today.getUTCFullYear() + 4, today.getUTCMonth(), today.getUTCDate())).toISOString();
}
