// Session transport for route-level tests: the primary session, the
// MFA session, the MFA grant and the passkey browser travel only in
// HttpOnly cookies. Fixtures read the tokens from Set-Cookie and send them back
// as one Cookie header, never in X-ServerDesk-* headers or reply bodies.

export const cookieNames = {
  primary: '__Host-serverdesk-auth',
  session: '__Host-serverdesk-mfa',
  grant: '__Host-serverdesk-mfa-grant',
  // The cookie of the removed remembered browser; replies still clear it.
  trust: '__Host-serverdesk-mfa-trust',
  passkey: '__Host-serverdesk-passkey',
};

/** The Cookie header value for a browser {primary, session, grant, trust, passkey}; empty parts are left out. */
export function cookieHeader(browser = {}) {
  return Object.entries(cookieNames)
    .filter(([key]) => typeof browser[key] === 'string' && browser[key])
    .map(([key, name]) => `${name}=${browser[key]}`)
    .join('; ');
}

/** Headers with the Cookie of a browser, merged with extra headers (an extra Cookie is appended). */
export function sessionHeaders(browser, extra = {}) {
  const cookie = cookieHeader(browser ?? {});
  const {Cookie: extraCookie, cookie: lowerCookie, ...rest} = extra;
  const joined = [cookie, extraCookie ?? lowerCookie].filter(Boolean).join('; ');
  return {...rest, ...(joined ? {Cookie: joined} : {})};
}

/** Every Set-Cookie of a response as {name, value, attributes, raw}. */
export function setCookies(response) {
  return response.headers.getSetCookie().map(raw => {
    const [pair, ...attributes] = raw.split(';').map(part => part.trim());
    const split = pair.indexOf('=');
    return {name: pair.slice(0, split), value: pair.slice(split + 1), attributes, raw};
  });
}

/** The value a response sets for a cookie name: undefined when not set, '' when cleared. */
export function setCookieValue(response, name) {
  const found = setCookies(response).filter(cookie => cookie.name === name).at(-1);
  if (!found) return undefined;
  return found.attributes.some(attribute => /^max-age=0$/i.test(attribute)) ? '' : found.value;
}

/** The browser after a response: each session cookie the response sets replaces the old value. */
export function browserAfter(response, browser = {}) {
  const next = {...browser};
  for (const [key, name] of Object.entries(cookieNames)) {
    const value = setCookieValue(response, name);
    if (value !== undefined) next[key] = value;
  }
  return next;
}
