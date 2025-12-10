// backend/http-functions.js
import { ok, notFound } from 'wix-http-functions';

const baseHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

// CORS preflight for safety
export function options_decisionGame(request) {
  return ok({
    headers: baseHeaders,
    body: JSON.stringify({ ok: true })
  });
}

// GET /_functions/decisionGame/leaderboard?mode=short|long|infinite
export function get_decisionGame(request) {
  const pathSeg = (request.path && request.path[0]) || '';

  // We only respond on /leaderboard for now
  if (pathSeg !== 'leaderboard') {
    return notFound({
      headers: baseHeaders,
      body: JSON.stringify({ error: 'Unknown endpoint', path: request.path })
    });
  }

  const query = request.query || {};
  const mode = query.mode || 'short';

  // Minimal dummy payload – just to prove it works
  const dummyResults = [
    {
      initials: 'ALI',
      mode,
      correct: 10,
      questions: 10,
      totalTime: 12345,
      avgReaction: 1234,
      date: new Date().toISOString()
    }
  ];

  return ok({
    headers: baseHeaders,
    body: JSON.stringify({
      mode,
      results: dummyResults
    })
  });
}
