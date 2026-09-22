import { betterAlternativeRule } from '../shared/review-summary';

// What the course panel sends the model, kept out of the content script (whose
// top level boots the page UI) so web/evals/bjjfanatics.ts runs exactly this.
export const SUMMARY_PROMPT = `Analyze these reviews of a BJJ instructional course. Ignore shipping, delivery, packaging, or seller issues — focus ONLY on the course content and instruction.

ONLY include points mentioned by 2+ reviewers. Rank by frequency (most mentioned first). Each bullet should be one concrete point, e.g. "Volume 3 (back attacks chapter) — most actionable".

BE AS SPECIFIC AS POSSIBLE. Cite concrete volumes, parts, chapters, sections, positions, techniques, sweeps, submissions, or drills by name when reviewers mention them. Generic praise like "great instruction" or generic complaints like "too long" are useless — skip them. Aim for: which volume/part is most valuable, which specific techniques reviewers say worked for them in rolling, which chapters reviewers say to skip or revisit, and which positions get the deepest coverage.

Surface the actual takeaways — what reviewers say they learned, what mental models or principles changed how they roll, what details unlocked a position, what technique they immediately added to their game. The single most important thing reviewers say a viewer should walk away with belongs in the conclusion.

Each review may be prefixed with [Ranking: BLUE | How old are you?: 33-40 | How many years have you been training BJJ?: 1-3]. Use this to note which skill levels found which sections useful.

${betterAlternativeRule('other course or instructor')}

The conclusion is the most important field — write it like a buying verdict, not an essay. Lead with the bottom line: buy or skip, and for whom. Then the single most important takeaway reviewers walked away with, what to watch first, and what this course doesn't deliver so the reader knows when to pass. Be punchy and decisive, cite specific techniques and volumes by name, no hedging like "many reviewers say". Make the most important takeaway concrete — name the specific technique, sweep, grip, or detail a reviewer actually credited (a sweep someone hit, the cue that unlocked a position), not a generic "systematic approach". The verdict may spotlight one such vivid, named detail even if only one reviewer mentions it, as long as you attribute it honestly — the 2+ threshold governs the ranked bullets, not the verdict's specifics. Use the course contents only to turn a vague reviewer reference ("the darce part") into its real named chapter; never rank or recommend sections reviewers didn't single out, invent chapter contents, or claim the course omits something reviewers didn't say it omits. Format however reads best — a few short paragraphs or short bullets. Use **bold** only on concrete specifics, never on connecting phrases.`;

// The official volume/chapter breakdown scraped from the page, appended to the
// prompt (and every Ask) so vague reviewer mentions map to named chapters.
export const courseContext = (courseContent: string) =>
  `COURSE CONTENTS — the official volume/part/chapter breakdown. Use it to translate vague reviewer references ("the leg lock part", "volume 3") into specific named chapters, and to judge which advertised sections reviewers actually praise or skip:\n\n${courseContent}`;
