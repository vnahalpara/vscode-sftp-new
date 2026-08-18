// The token arrives once on the opening URL as ?t=… . We stash it in
// sessionStorage and strip it from the address bar so it does not sit in
// browser history, then send it as a header on every call.
const KEY = 'sftp-manage-server-token';

export function getToken() {
  const fromUrl = new URLSearchParams(location.search).get('t');
  if (fromUrl) {
    sessionStorage.setItem(KEY, fromUrl);
    history.replaceState(null, '', location.pathname);
    return fromUrl;
  }
  return sessionStorage.getItem(KEY) || '';
}

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-sftp-token': getToken(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(text || `${res.status} ${res.statusText}`);
  }
  return text ? JSON.parse(text) : null;
}

export const apiGet = path => request('GET', path);
export const apiPost = (path, body) => request('POST', path, body || {});

// EventSource cannot send headers, so the stream carries the token in the query
// string. Returns a close function.
export function openStream(handlers) {
  const source = new EventSource(`/api/stream?t=${encodeURIComponent(getToken())}`);
  Object.keys(handlers).forEach(name => {
    if (name === 'onError') {
      source.onerror = handlers.onError;
      return;
    }
    source.addEventListener(name, e => handlers[name](JSON.parse(e.data)));
  });
  return () => source.close();
}
