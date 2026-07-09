import app from '../src/index.js';

// Node.js 서버리스 (maxDuration 60s — vercel.json 설정)
// 기본 배포 리전: iad1 (미국 동부) → Gemini API 지역 차단 없음
export default async function handler(req, res) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const url   = `${proto}://${host}${req.url}`;

  // 요청 바디 읽기
  let body = undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks);
  }

  const webReq = new Request(url, {
    method:  req.method,
    headers: new Headers(req.headers),
    body,
  });

  const response = await app.fetch(webReq, process.env);

  res.status(response.status);
  for (const [key, value] of response.headers.entries()) {
    res.setHeader(key, value);
  }
  const buf = await response.arrayBuffer();
  res.end(Buffer.from(buf));
}
