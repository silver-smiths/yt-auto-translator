import { handleCredits } from './routes/credits.js';
import { handleTranslateChunk, handleTranslateJob, handleTranslateJobPatch } from './routes/translate.js';
import { handleWebhook } from './routes/webhook.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      let response;

      if (path === '/credits' && request.method === 'GET') {
        response = await handleCredits(request, env);
      } else if (path === '/translate/job' && request.method === 'POST') {
        response = await handleTranslateJob(request, env);
      } else if (path.match(/^\/translate\/job\/[\w-]+$/) && request.method === 'PATCH') {
        const jobId = path.split('/').pop();
        response = await handleTranslateJobPatch(request, env, jobId);
      } else if (path === '/translate/chunk' && request.method === 'POST') {
        response = await handleTranslateChunk(request, env);
      } else if (path === '/webhook/portone' && request.method === 'POST') {
        response = await handleWebhook(request, env);
      } else {
        response = new Response('Not Found', { status: 404 });
      }

      // CORS 헤더 추가
      const headers = new Headers(response.headers);
      Object.entries(CORS).forEach(([k, v]) => headers.set(k, v));
      return new Response(response.body, { status: response.status, headers });

    } catch (err) {
      console.error('[Worker] Unhandled error:', err);
      return new Response(
        JSON.stringify({ error: 'Internal Server Error' }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } }
      );
    }
  }
};
