/**
 * Supabase REST API 클라이언트 (경량 fetch 기반)
 * Workers 환경에서 npm 패키지 없이 동작
 */
export function getSupabase(env) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;

  const headers = {
    'Content-Type': 'application/json',
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Prefer': 'return=representation',
  };

  function buildQuery(table) {
    return new QueryBuilder(url, key, headers, table);
  }

  return {
    from: (table) => buildQuery(table),
    rpc: (fn, params) => callRpc(url, headers, fn, params),
  };
}

class QueryBuilder {
  constructor(url, key, headers, table) {
    this._url    = `${url}/rest/v1/${table}`;
    this._headers = { ...headers };
    this._filters = [];
    this._select  = '*';
    this._single  = false;
    this._upsert  = false;
    this._upsertOpts = {};
    this._method  = 'GET';
    this._body    = null;
    this._update  = false;
    this._insert  = false;
  }

  select(cols = '*') { this._select = cols; return this; }
  single()           { this._single = true; return this; }

  eq(col, val) {
    this._filters.push(`${col}=eq.${val}`);
    return this;
  }

  insert(data) {
    this._method = 'POST';
    this._body   = JSON.stringify(data);
    return this;
  }

  upsert(data, opts = {}) {
    this._method    = 'POST';
    this._body      = JSON.stringify(data);
    this._upsert    = true;
    this._upsertOpts = opts;
    return this;
  }

  update(data) {
    this._method = 'PATCH';
    this._body   = JSON.stringify(data);
    return this;
  }

  async _execute() {
    let url = this._url;
    const params = new URLSearchParams({ select: this._select });
    this._filters.forEach(f => params.append(f.split('=')[0], f.split('=').slice(1).join('=')));
    url += '?' + params.toString();

    const headers = { ...this._headers };
    if (this._single) headers['Accept'] = 'application/vnd.pgrst.object+json';
    if (this._upsert) {
      headers['Prefer'] = this._upsertOpts.onConflict
        ? `resolution=merge-duplicates,return=representation`
        : 'return=representation';
    }

    const res = await fetch(url, { method: this._method, headers, body: this._body });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;

    if (!res.ok) return { data: null, error: data };
    return { data, error: null };
  }

  then(resolve, reject) {
    return this._execute().then(resolve, reject);
  }
}

async function callRpc(baseUrl, headers, fn, params) {
  const res = await fetch(`${baseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) return { data: null, error: data };
  return { data, error: null };
}
