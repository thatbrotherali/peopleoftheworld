// backend/http-functions.js
import { ok, badRequest, notFound, serverError } from 'wix-http-functions';
import wixData from 'wix-data';

// Name of your Data Collection in Wix
const COLLECTION = 'DecisionGameScores';

// Basic headers + CORS so external origins (e.g. GitHub Pages) can call this API
const baseHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*'
};

// Allowed game modes
const ALLOWED_MODES = ['short', 'long', 'infinite'];

/**
 * Helper: compare scores to see if "a" is better than "b"
 * Uses the agreed ranking rules:
 *
 * short/long:
 *   1) fewer mistakes (totalQuestions - correct)
 *   2) lower totalTimeMs
 *   3) lower avgTimeMs
 *
 * infinite:
 *   1) higher correct
 *   2) lower avgTimeMs
 *   3) lower totalTimeMs
 */
function isScoreBetter(a, b) {
  const mode = a.mode;

  if (mode === 'infinite') {
    // Infinite: more correct is better, then lower avg time, then lower total time
    if (a.correct !== b.correct) return a.correct > b.correct;
    if (a.avgTimeMs !== b.avgTimeMs) return a.avgTimeMs < b.avgTimeMs;
    return a.totalTimeMs < b.totalTimeMs;
  } else {
    // Short/Long: fewest mistakes, then lowest total time, then lowest avg time
    const aMistakes = a.totalQuestions - a.correct;
    const bMistakes = b.totalQuestions - b.correct;

    if (aMistakes !== bMistakes) return aMistakes < bMistakes;
    if (a.totalTimeMs !== b.totalTimeMs) return a.totalTimeMs < b.totalTimeMs;
    return a.avgTimeMs < b.avgTimeMs;
  }
}

/**
 * POST /_functions/decisionGame/saveScore
 *
 * Body JSON:
 * {
 *   "initials": "ALI",
 *   "mode": "short" | "long" | "infinite",
 *   "correct": number,
 *   "totalQuestions": number,
 *   "totalTimeMs": number,
 *   "avgTimeMs": number
 * }
 *
 * Behavior:
 * - Validates input
 * - For each (initials, mode) pair, only keeps the BEST score
 *   according to isScoreBetter(...)
 */
export async function post_decisionGame(request) {
  const pathSeg = (request.path && request.path[0]) || '';

  // We only handle /_functions/decisionGame/saveScore here
  if (pathSeg !== 'saveScore') {
    return notFound({
      headers: baseHeaders,
      body: JSON.stringify({ error: 'Unknown endpoint' })
    });
  }

  try {
    const bodyText = await request.body.text();
    const data = JSON.parse(bodyText || '{}');

    const {
      initials,
      mode,
      correct,
      totalQuestions,
      totalTimeMs,
      avgTimeMs
    } = data;

    // Basic validation
    if (!initials || typeof initials !== 'string') {
      return badRequest({
        headers: baseHeaders,
        body: JSON.stringify({ error: 'Initials are required' })
      });
    }

    if (!mode || !ALLOWED_MODES.includes(mode)) {
      return badRequest({
        headers: baseHeaders,
        body: JSON.stringify({ error: 'Invalid or missing mode' })
      });
    }

    if (
      typeof correct !== 'number' ||
      typeof totalQuestions !== 'number' ||
      typeof totalTimeMs !== 'number' ||
      typeof avgTimeMs !== 'number'
    ) {
      return badRequest({
        headers: baseHeaders,
        body: JSON.stringify({ error: 'Score fields must be numbers' })
      });
    }

    const normalizedInitials = initials.toUpperCase().slice(0, 3);

    // Check if we already have a score for this initials+mode
    const existing = await wixData.query(COLLECTION)
      .eq('initials', normalizedInitials)
      .eq('mode', mode)
      .find();

    const newScore = {
      initials: normalizedInitials,
      mode,
      correct,
      totalQuestions,
      totalTimeMs,
      avgTimeMs
    };

    if (existing.items.length === 0) {
      // No existing score: insert new
      await wixData.insert(COLLECTION, {
        ...newScore,
        createdAt: new Date()
      });
    } else {
      const current = existing.items[0];
      const currentScore = {
        initials: current.initials,
        mode: current.mode,
        correct: current.correct,
        totalQuestions: current.totalQuestions,
        totalTimeMs: current.totalTimeMs,
        avgTimeMs: current.avgTimeMs
      };

      if (isScoreBetter(newScore, currentScore)) {
        // New score is better → update existing entry
        current.correct = correct;
        current.totalQuestions = totalQuestions;
        current.totalTimeMs = totalTimeMs;
        current.avgTimeMs = avgTimeMs;
        current.updatedAt = new Date();
        await wixData.update(COLLECTION, current);
      }
      // If not better, we do nothing (keep best run only)
    }

    return ok({
      headers: baseHeaders,
      body: JSON.stringify({ success: true })
    });

  } catch (err) {
    console.error('Error in saveScore:', err);
    return serverError({
      headers: baseHeaders,
      body: JSON.stringify({ error: 'Internal error', details: String(err) })
    });
  }
}

/**
 * GET /_functions/decisionGame/leaderboard?mode=short|long|infinite
 *
 * Returns top 100 scores for given mode, sorted by the same rules
 * as isScoreBetter (best → worst).
 */
export async function get_decisionGame(request) {
  const pathSeg = (request.path && request.path[0]) || '';

  // We only handle /_functions/decisionGame/leaderboard here
  if (pathSeg !== 'leaderboard') {
    return notFound({
      headers: baseHeaders,
      body: JSON.stringify({ error: 'Unknown endpoint' })
    });
  }

  try {
    const rawMode = request.query.mode || 'short';
    const mode = rawMode.toLowerCase();

    if (!ALLOWED_MODES.includes(mode)) {
      return badRequest({
        headers: baseHeaders,
        body: JSON.stringify({
          error: 'mode query param must be "short", "long", or "infinite"'
        })
      });
    }

    const result = await wixData.query(COLLECTION)
      .eq('mode', mode)
      .limit(1000) // enough to sort/slice
      .find();

    let scores = (result.items || []).map(item => ({
      initials: item.initials,
      mode: item.mode,
      correct: item.correct,
      totalQuestions: item.totalQuestions,
      totalTimeMs: item.totalTimeMs,
      avgTimeMs: item.avgTimeMs
    }));

    // Sort using isScoreBetter logic (descending "goodness")
    scores.sort((a, b) => {
      if (isScoreBetter(a, b)) return -1;
      if (isScoreBetter(b, a)) return 1;
      return 0;
    });

    // Top 100 with rank
    const top = scores.slice(0, 100).map((s, idx) => ({
      rank: idx + 1,
      initials: s.initials,
      correct: s.correct,
      totalQuestions: s.totalQuestions,
      totalTimeMs: s.totalTimeMs,
      avgTimeMs: s.avgTimeMs
    }));

    return ok({
      headers: baseHeaders,
      body: JSON.stringify({ mode, results: top })
    });

  } catch (err) {
    console.error('Error in leaderboard:', err);
    return serverError({
      headers: baseHeaders,
      body: JSON.stringify({ error: 'Internal error', details: String(err) })
    });
  }
}
