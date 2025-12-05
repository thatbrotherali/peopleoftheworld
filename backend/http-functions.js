// backend/http-functions.js
import { ok, badRequest, notFound, serverError } from 'wix-http-functions';
import wixData from 'wix-data';

const COLLECTION = 'DecisionGameScores';

// ---------------------------------------------
// Score Comparison Helper
// ---------------------------------------------
function isScoreBetter(a, b) {
  const mode = a.mode;

  if (mode === 'infinite') {
    // Infinite mode ranking:
    // 1) Higher correct
    // 2) Lower avgReaction
    // 3) Lower totalTime
    if (a.correct !== b.correct) return a.correct > b.correct;
    if (a.avgReaction !== b.avgReaction) return a.avgReaction < b.avgReaction;
    return a.totalTime < b.totalTime;

  } else {
    // Short & Long:
    // 1) Fewer mistakes
    // 2) Lower totalTime
    // 3) Lower avgReaction
    const aMistakes = a.questions - a.correct;
    const bMistakes = b.questions - b.correct;

    if (aMistakes !== bMistakes) return aMistakes < bMistakes;
    if (a.totalTime !== b.totalTime) return a.totalTime < b.totalTime;
    return a.avgReaction < b.avgReaction;
  }
}

// =============================================================
// POST  /_functions/decisionGame/saveScore
// =============================================================
export async function post_decisionGame(request) {
  const subPath = request.path?.[0] || "";

  if (subPath !== "saveScore") {
    return notFound({ body: "Unknown endpoint" });
  }

  try {
    const bodyText = await request.body.text();
    const data = JSON.parse(bodyText || "{}");

    const { initials, mode, correct, questions, totalTime, avgReaction } = data;

    if (!initials || !mode) {
      return badRequest({ body: "Initials and mode are required." });
    }
    if (typeof correct !== "number" ||
        typeof questions !== "number" ||
        typeof totalTime !== "number" ||
        typeof avgReaction !== "number") {
      return badRequest({ body: "Numeric fields missing or invalid." });
    }

    // Restrict valid modes
    if (!["short", "long", "infinite"].includes(mode)) {
      return badRequest({ body: "Invalid mode." });
    }

    // Check if score exists for initials+mode
    const existing = await wixData.query(COLLECTION)
      .eq("initials", initials.toUpperCase())
      .eq("mode", mode)
      .find();

    const newScore = {
      initials: initials.toUpperCase().slice(0,3),
      mode,
      correct,
      questions,
      totalTime,
      avgReaction
    };

    if (existing.items.length === 0) {
      // First time score
      await wixData.insert(COLLECTION, newScore);
    } else {
      // Compare to existing score
      const old = existing.items[0];
      const oldScore = {
        initials: old.initials,
        mode: old.mode,
        correct: old.correct,
        questions: old.questions,
        totalTime: old.totalTime,
        avgReaction: old.avgReaction
      };

      if (isScoreBetter(newScore, oldScore)) {
        // Replace with better score
        old.correct = correct;
        old.questions = questions;
        old.totalTime = totalTime;
        old.avgReaction = avgReaction;
        await wixData.update(COLLECTION, old);
      }
      // If not better → do nothing
    }

    return ok({
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: true })
    });

  } catch (err) {
    console.error("Error in saveScore:", err);
    return serverError({
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal error" })
    });
  }
}

// =============================================================
// GET /_functions/decisionGame/leaderboard?mode=short|long|infinite
// =============================================================
export async function get_decisionGame(request) {
  const subPath = request.path?.[0] || "";

  if (subPath !== "leaderboard") {
    return notFound({ body: "Unknown endpoint" });
  }

  try {
    const modeRaw = request.query?.mode || "short";
    const mode = ["short", "long", "infinite"].includes(modeRaw.toLowerCase())
      ? modeRaw.toLowerCase()
      : "short";

    const result = await wixData.query(COLLECTION)
      .eq("mode", mode)
      .limit(1000)
      .find();

    let scores = result.items.map(s => ({
      initials: s.initials,
      mode: s.mode,
      correct: s.correct,
      questions: s.questions,
      totalTime: s.totalTime,
      avgReaction: s.avgReaction
    }));

    // Sort in descending "better first" order
    scores.sort((a, b) => {
      if (isScoreBetter(a, b)) return -1;
      if (isScoreBetter(b, a)) return 1;
      return 0;
    });

    const top100 = scores.slice(0, 100).map((s, index) => ({
      rank: index + 1,
      initials: s.initials,
      correct: s.correct,
      questions: s.questions,
      totalTime: s.totalTime,
      avgReaction: s.avgReaction
    }));

    return ok({
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, results: top100 })
    });

  } catch (err) {
    console.error("Error in leaderboard:", err);
    return serverError({
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal error" })
    });
  }
}
