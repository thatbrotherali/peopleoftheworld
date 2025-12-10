// backend/http-functions.js
import { ok, badRequest, notFound, serverError } from 'wix-http-functions';
import wixData from 'wix-data';

const COLLECTION = 'DecisionGameScores';

const baseHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*'
};

// Allowed modes, including 'infinite'
const ALLOWED_MODES = ['short', 'long', 'infinite'];

/**
 * Compare scores to see if "a" is better than "b"
 *
 * short/long:
 *   1) fewer mistakes (questions - correct)
 *   2) lower totalTime
 *   3) lower avgReaction
 *
 * infinite:
 *   1) higher correct
 *   2) lower avgReaction
 *   3) lower totalTime
 */
function isScoreBetter(a, b) {
  const mode = a.mode;

  if (mode === 'infinite') {
    // Infinite: more correct, then lower avg time, then lower total time
    if (a.correct !== b.correct) return a.correct > b.correct;
    if (a.avgReaction !== b.avgReaction) return a.avgReaction < b.avgReaction;
    return a.totalTime < b.totalTime;
  } else {
    // Short/Long: fewest mistakes, then lowest total time, then lowest avg time
    const aMistakes = a.questions - a.correct;
    const bMistakes = b.questions - b.correct;

    if (aMistakes !== bMistakes) return aMistakes < bMistakes;
    if (a.totalTime !== b.totalTime) return a.totalTime < b.totalTime;
    return a.avgReaction < b.avgReaction;
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
 *   "questions": number,
 *   "totalTime": number,
 *   "avgReaction": number
 * }
 *
 * For each (initials, mode) pair we store only the BEST score.
 */
export async function post_decisionGame(request) {
  const pathSeg = (request.path && request.path[0]) || '';

  // Only handle /_functions/decisionGame/saveScore
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
      questions,
      totalTime,
      avgReaction
    } = data;

    // Validation
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
      typeof questions !== 'number' ||
      typeof totalTime !== 'number' ||
      typeof avgReaction !== 'number'
    ) {
      return badRequest({
        headers: baseHeaders,
        body: JSON.stringify({ error: 'Score fields must be numbers' })
      });
    }

    const normInitials = initials.toUpperCase().slice(0, 3);

    // See if there is an existing score for this initials+mode
    const existing = await wixData.query(COLLECTION)
      .eq('initials', normInitials)
      .eq('mode', mode)
      .find();

    const newScore = {
      initials: normInitials,
      mode,
      correct,
      questions,
      totalTime,
      avgReaction
    };

    const now = new Date();

    if (existing.items.length === 0) {
      // No existing: insert new
      await wixData.insert(COLLECTION, {
        ...newScore,
        bestDate: now,
        createdAt: now,
        updatedAt: now
      });
    } else {
      const current = existing.items[0];
      const currentScore = {
        initials: current.initials,
        mode: current.mode,
        correct: current.correct,
        questions: current.questions,
        totalTime: current.totalTime,
        avgReaction: current.avgReaction
      };

      if (isScoreBetter(newScore, currentScore)) {
        // New score is better → update
        current.correct = correct;
        current.questions = questions;
        current.totalTime = totalTime;
        current.avgReaction = avgReaction;
        const now = new Date();
        current.bestDate = now;
        current.updatedAt = now;
        await wixData.update(COLLECTION, current);
      }
      // If not better, do nothing (keep the existing best run)
    }

    return ok({
      headers: baseHeaders,
      body: JSON.stringify({ success: true })
    });

  } catch (err) {
    console.error('Error in post_decisionGame/saveScore:', err);
    return serverError({
      headers: baseHeaders,
      body: JSON.stringify({ error: 'Internal error', details: String(err) })
    });
  }
}

/**
 * GET /_functions/decisionGame/leaderboard?mode=short|long|infinite
 *
 * Returns top 100 scores for the requested mode.
 */
export async function get_decisionGame(request) {
  const pathSeg = (request.path && request.path[0]) || '';

  // Only handle /_functions/decisionGame/leaderboard
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
      .limit(1000)
      .find();

    let scores = (result.items || []).map(item => ({
      initials: item.initials,
      mode: item.mode,
      correct: item.correct,
      questions: item.questions,
      totalTime: item.totalTime,
      avgReaction: item.avgReaction,
      date: item.bestDate || item.updatedAt || item.createdAt || null
    }));

    // Sort using same logic as isScoreBetter, best → worst
    scores.sort((a, b) => {
      if (isScoreBetter(a, b)) return -1;
      if (isScoreBetter(b, a)) return 1;
      return 0;
    });

    const top = scores.slice(0, 100).map((s, idx) => ({
      rank: idx + 1,
      initials: s.initials,
      correct: s.correct,
      questions: s.questions,
      totalTime: s.totalTime,
      avgReaction: s.avgReaction,
      date: s.date
    }));

    return ok({
      headers: baseHeaders,
      body: JSON.stringify({ mode, results: top })
    });

  } catch (err) {
    console.error('Error in get_decisionGame/leaderboard:', err);
    return serverError({
      headers: baseHeaders,
      body: JSON.stringify({ error: 'Internal error', details: String(err) })
    });
  }
}
