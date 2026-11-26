// The first customer is created by migration 0029 and owns every device and
// device group that does not name another customer. It has no runtime imports,
// so the Drizzle schema can use it as the column default.
export const defaultCustomerId='00000000-0000-4000-8000-000000000100';
