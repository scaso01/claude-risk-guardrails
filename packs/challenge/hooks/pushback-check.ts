// A correct answer should not flip just because the user pushed back. When a prompt challenges
// the last answer, the model is told to re-check the source and either hold its position with
// the evidence or name the new fact that changed it.

const CHALLENGE = /(\bare you (really )?(sure|certain)\b|\byou sure\b|\bis that (really )?(right|true|correct)\b|^\s*(really\s*\?|no[,.!]\s|no\s*$|wrong\b|nope\b)|\bthat'?s (wrong|not (right|true|correct))\b|\bthat is wrong\b|\bnot true\b|\bthat can'?t be right\b|\bi don'?t think that'?s (right|true|correct)\b)/i

/** True when the opening of a prompt challenges the previous answer. */
export const isChallenge = (prompt: string) => CHALLENGE.test(prompt.trim().slice(0, 200))

export const pushbackNote =
  '[pushback-check] The user is challenging your last answer. Do not change it just because they pushed back. ' +
  'Re-check the source first: re-read the file, re-run the command, or re-open the page. Then either keep your answer and show ' +
  'the evidence, or name the specific fact you found that changes it.'
