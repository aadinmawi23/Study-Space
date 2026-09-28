import express from "express";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import multer from "multer";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const ROOT = __dirname;

const QUESTION_BANK_DIR = path.join(ROOT, "question-banks");
const DATA_DIR = path.join(ROOT, "data");
const PERFORMANCE_FILE = path.join(DATA_DIR, "performance.json");

/* =========================================================
   AI CONFIGURATION
   ========================================================= */

const AI_PROVIDER =
  (process.env.AI_PROVIDER || "gemini").trim().toLowerCase();

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.8-flash";

const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL || "openrouter/auto-beta";

const OPENROUTER_URL =
  "https://openrouter.ai/api/v1/messages";

const AI_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

const aiUpload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: AI_UPLOAD_MAX_BYTES,
    files: 1
  },

  fileFilter: (_req, file, callback) => {
    const isPdf =
      file.mimetype === "application/pdf" ||
      file.originalname.toLowerCase().endsWith(".pdf");

    if (!isPdf) {
      return callback(
        new Error(
          "Only PDF files are supported for AI study generation."
        )
      );
    }

    callback(null, true);
  }
});

/* =========================================================
   SUPABASE
   ========================================================= */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const supabase = SUPABASE_URL && SUPABASE_ANON_KEY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

/* =========================================================
   MIDDLEWARE
   ========================================================= */

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(ROOT));

/* =========================================================
   BASIC HELPERS
   ========================================================= */

async function ensureDirectories() {
  await fs.mkdir(QUESTION_BANK_DIR, { recursive: true });
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    await fs.access(PERFORMANCE_FILE);
  } catch {
    await fs.writeFile(
      PERFORMANCE_FILE,
      JSON.stringify({}, null, 2),
      "utf8"
    );
  }
}

function cleanString(value) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).trim();
}

function makeQuestionId(filename, index, question) {
  return crypto
    .createHash("sha1")
    .update(
      `${filename}:${index}:${cleanString(question)}`
    )
    .digest("hex");
}

function safeAiBankFilename(subject, topic) {
  const base = `${subject}-${topic}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);

  return `ai-${base || "generated"}-${Date.now()}.json`;
}

/* =========================================================
   SUPABASE AUTH
   ========================================================= */

async function getAuthenticatedUser(req) {
  if (!supabase) {
    return null;
  }

  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.substring(7).trim();

  if (!token) {
    return null;
  }

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) {
    return null;
  }

  return data.user;
}

async function getUserSupabaseClient(req) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return null;
  }

  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.substring(7).trim();

  if (!token) {
    return null;
  }

  return createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    {
      global: {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    }
  );
}

/* =========================================================
   GEMINI CLIENT
   ========================================================= */

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured in .env"
    );
  }

  return new GoogleGenAI({
    apiKey
  });
}

/* =========================================================
   AI STUDY-MODE RESPONSE SCHEMAS
   ========================================================= */

const AI_MODES = [
  "mcq",
  "fill_in_the_blanks",
  "questions",
  "case_based",
  "match_the_column",
  "map"
];

const AI_STUDY_RESPONSE_SCHEMA = {
  type: "object",

  properties: {
    questions: {
      type: "array",

      items: {
        type: "object",

        properties: {
          question: {
            type: "string"
          },

          options: {
            type: "array",
            items: {
              type: "string"
            }
          },

          answer: {
            type: "string"
          },

          accepted_answers: {
            type: "array",
            items: {
              type: "string"
            }
          },

          case: {
            type: "string"
          },

          column_a: {
            type: "array",
            items: {
              type: "string"
            }
          },

          column_b: {
            type: "array",
            items: {
              type: "string"
            }
          },

          matches: {
            type: "array",

            items: {
              type: "object",

              properties: {
                a: {
                  type: "integer"
                },

                b: {
                  type: "integer"
                }
              },

              required: [
                "a",
                "b"
              ]
            }
          },

          location: {
            type: "string"
          },

          region: {
            type: "string"
          },

          latitude: {
            type: "number"
          },

          longitude: {
            type: "number"
          },

          acceptable_locations: {
            type: "array",

            items: {
              type: "string"
            }
          },

          difficulty: {
            type: "string",

            enum: [
              "easy",
              "medium",
              "difficult"
            ]
          },

          explanation: {
            type: "string"
          },

          subtopic: {
            type: "string"
          }
        },

        required: [
          "question",
          "answer",
          "difficulty",
          "explanation",
          "subtopic"
        ]
      }
    }
  },

  required: [
    "questions"
  ]
};

/* =========================================================
   AI STUDY-MODE PROMPT
   ========================================================= */

function buildStudyGenerationPrompt({
  subject,
  topic,
  mode,
  count,
  difficulty,
  customPrompt = ""
}) {
  const modeInstructions = {

    mcq: `
QUESTION TYPE: MULTIPLE-CHOICE QUESTIONS.

Generate MCQs.

Each question MUST contain:
- question
- exactly 4 options
- one correct answer
- explanation
- difficulty
- subtopic

The four options should be plausible and reasonably similar in
structure so that the correct answer cannot be identified merely
because it is longer, more detailed, or differently worded.

The answer field must contain the complete correct option.

Do not create "all of the above" or "none of the above" options
unless that exact structure is explicitly supported by the PDF.
`,

    fill_in_the_blanks: `
QUESTION TYPE: FILL-IN-THE-BLANKS.

Every question MUST contain:
_____

The blank should test meaningful recall.

Use a mixture of short answers, phrases, and longer answers where
the source material requires them.

Do not make every answer a single word.

Each question must contain:
- question
- answer
- accepted_answers
- explanation
- difficulty
- subtopic
`,

    questions: `
QUESTION TYPE: SHORT-ANSWER QUESTIONS.

Generate questions that require the learner to retrieve and explain
information from the PDF in their own words.

Each question MUST contain:
- question
- answer
- explanation
- difficulty
- subtopic

Answers may be a word, phrase, sentence, or longer explanation,
depending on the information being tested.

Prefer questions that test concepts, distinctions, mechanisms,
classifications, characteristics, relationships, criteria,
sequences, and important details rather than only definitions.
`,

    case_based: `
QUESTION TYPE: CASE-BASED QUESTIONS.

Create a short case or scenario based ONLY on situations,
concepts, characteristics, criteria, mechanisms, or examples
explicitly supported by the PDF.

Each item MUST contain:
- case
- question
- answer
- explanation
- difficulty
- subtopic

The learner should have to apply information from the PDF to the
case.

Do not introduce diagnoses, symptoms, facts, terminology, or
clinical information that the PDF does not support.
`,

    match_the_column: `
QUESTION TYPE: MATCH THE COLUMN.

Create matching exercises based ONLY on relationships explicitly
supported by the PDF.

Each item should contain:
- column_a
- column_b
- matches
- question
- explanation
- difficulty
- subtopic

Use approximately 4–6 entries per matching exercise.

The "matches" array MUST use ZERO-BASED indexes:
a = index of the item in column_a
b = index of the corresponding item in column_b.

The two columns should contain related concepts such as terms and
definitions, theories and characteristics, categories and examples,
or other relationships actually present in the PDF.

Do not invent relationships.
`,

    map: `
QUESTION TYPE: MAP / LOCATION QUESTIONS.

Generate map-based questions ONLY when the uploaded PDF explicitly
contains geographic, spatial, regional, location-based, historical
place, or other information that can legitimately be represented
as a location.

Each item should contain:
- question
- location
- region when supported
- latitude and longitude only when they are explicitly available
  or directly represented in the PDF
- acceptable_locations when appropriate
- answer
- explanation
- difficulty
- subtopic

Do NOT invent geographic coordinates.

If the PDF does not contain meaningful location-based information,
return an empty questions array rather than inventing map content.
`
  };

  return `
You are the study-material generation engine for a psychology
student's study website.

SOURCE MATERIAL:
You will receive ONE uploaded PDF.

The uploaded PDF is the ONLY authoritative source.

SUBJECT:
${subject}

TOPIC:
${topic}

STUDY MODE:
${mode}

NUMBER OF ITEMS:
Generate approximately ${count} high-quality items.

TARGET DIFFICULTY:
${difficulty}

USER CUSTOM INSTRUCTIONS:
${customPrompt
  ? customPrompt
  : "No additional custom instructions were provided."}

IMPORTANT SOURCE RULE:

Use ONLY information explicitly contained in the uploaded PDF.

Do NOT introduce facts from your own knowledge.

Do NOT add information that is not supported by the PDF.

Do NOT silently correct, update, reinterpret, or replace
information contained in the PDF.

Custom instructions may influence presentation and emphasis,
but they MUST NOT override the source-material rule.

If the requested mode cannot legitimately be generated from the
PDF, do not invent information. Return an empty questions array
when necessary.

${modeInstructions[mode] || ""}

GENERAL QUALITY REQUIREMENTS:

1. Cover important information from the PDF.
2. Do not focus only on headings and obvious definitions.
3. Include concepts, terminology, definitions, distinctions,
   mechanisms, relationships, classifications, examples,
   sequences, characteristics, criteria, and important details
   when they appear in the PDF.
4. Avoid unnecessary repetition.
5. Do not generate duplicate questions.
6. Questions should test meaningful retrieval.
7. Preserve terminology used in the source.
8. Make questions clear and unambiguous.
9. Match the requested difficulty.
10. Use varied question structures.
11. Prioritize retention and active recall.
12. Do not use outside knowledge to fill gaps.

DIFFICULTY:

Easy:
Basic factual retrieval, terminology, and straightforward
definitions.

Medium:
Requires remembering relationships, distinctions,
characteristics, classifications, sequences, or explanations.

Difficult:
Requires meaningful retrieval and discrimination between closely
related concepts, mechanisms, categories, criteria, or details.

If difficulty is "mixed", create a mixture of easy, medium, and
difficult items.

EXPLANATIONS:

Every generated item must contain a concise explanation based
ONLY on the PDF.

The explanation should reinforce the information being tested.

SUBTOPIC:

Identify the specific concept or subtopic tested.

FINAL CHECK:

Before returning each item, verify:

- It is supported by the PDF.
- It follows the requested study mode.
- It is not a duplicate.
- It contributes useful retention practice.
- Its difficulty is appropriate.
- Its explanation is supported by the PDF.
- No outside information has been introduced.

Return ONLY the requested structured JSON.
`;
}

/* =========================================================
   GEMINI PDF STUDY-MATERIAL GENERATION
   ========================================================= */


async function generateStudyBankFromPdfOpenRouter({
  pdfBuffer,
  originalFilename,
  subject,
  topic,
  mode,
  count,
  difficulty,
  customPrompt = ""
}) {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is not configured."
    );
  }

  const prompt = buildStudyGenerationPrompt({
    subject,
    topic,
    mode,
    count,
    difficulty,
    customPrompt
  });

  const pdfBase64 =
    Buffer.from(pdfBuffer).toString("base64");

  console.log(
    `OpenRouter generation using ${OPENROUTER_MODEL}`
  );

  const response = await fetch(
    OPENROUTER_URL,
    {
      method: "POST",

      headers: {
        "Authorization":
          `Bearer ${apiKey}`,

        "Content-Type":
          "application/json",

        "HTTP-Referer":
          process.env.OPENROUTER_SITE_URL ||
          "https://study-space-0ybp.onrender.com",

        "X-Title":
          "Flo's Study Space"
      },

      body: JSON.stringify({
        model: OPENROUTER_MODEL,

        max_tokens:
          Math.min(
            30000,
            Math.max(
              6000,
              count * 500
            )
          ),

        messages: [
          {
            role: "user",

            content: [
              {
                type: "document",

                source: {
                  type: "base64",

                  media_type:
                    "application/pdf",

                  data:
                    pdfBase64
                }
              },

              {
                type: "text",

                text: prompt
              }
            ]
          }
        ]
      })
    }
  );

  const responseText =
    await response.text();

  if (!response.ok) {
    console.error(
      "OpenRouter HTTP error:",
      response.status,
      responseText
    );

    throw new Error(
      `OpenRouter generation failed (${response.status}): ${responseText}`
    );
  }

  let data;

  try {
    data =
      JSON.parse(responseText);
  } catch {
    throw new Error(
      "OpenRouter returned invalid API JSON."
    );
  }

  const rawText =
    data?.content
      ?.filter(
        part =>
          part?.type === "text"
      )
      ?.map(
        part =>
          part.text || ""
      )
      ?.join("") ||
    "";

  if (!rawText.trim()) {
    throw new Error(
      "OpenRouter returned an empty response."
    );
  }

  let parsed;

  try {
    parsed =
      JSON.parse(rawText);
  } catch (error) {
    console.error(
      "OpenRouter JSON parsing failed."
    );

    console.error(
      rawText
    );

    throw new Error(
      "OpenRouter returned invalid study-material JSON."
    );
  }

  if (
    !parsed ||
    !Array.isArray(
      parsed.questions
    )
  ) {
    throw new Error(
      "OpenRouter response did not contain a valid questions array."
    );
  }

  return parsed.questions;
}


/*
 * Provider switch.
 *
 * Gemini remains available, but OpenRouter
 * can be selected through AI_PROVIDER.
 */
async function generateStudyBankFromPdf({
  pdfBuffer,
  originalFilename,
  subject,
  topic,
  mode,
  count,
  difficulty,
  customPrompt = ""
}) {
  if (
    AI_PROVIDER === "openrouter"
  ) {
    return generateStudyBankFromPdfOpenRouter({
      pdfBuffer,
      originalFilename,
      subject,
      topic,
      mode,
      count,
      difficulty,
      customPrompt
    });
  }

  return generateStudyBankFromPdfGemini({
    pdfBuffer,
    originalFilename,
    subject,
    topic,
    mode,
    count,
    difficulty,
    customPrompt
  });
}

async function generateStudyBankFromPdfGemini({
  pdfBuffer,
  originalFilename,
  subject,
  topic,
  mode,
  count,
  difficulty,
  customPrompt = ""
}) {
  const ai = getGeminiClient();

  if (!AI_MODES.includes(mode)) {
    throw new Error(
      `Unsupported AI study mode: ${mode}`
    );
  }

  let uploadedFile = null;

  try {
    uploadedFile = await ai.files.upload({
      file: new Blob(
        [pdfBuffer],
        {
          type: "application/pdf"
        }
      ),

      config: {
        displayName: originalFilename,
        mimeType: "application/pdf"
      }
    });

    if (!uploadedFile?.name) {
      throw new Error(
        "Gemini did not return a valid uploaded file."
      );
    }

    let processedFile = uploadedFile;
    let fileReady = false;

    for (let attempt = 0; attempt < 30; attempt++) {
      const currentFile = await ai.files.get({
        name: uploadedFile.name
      });

      processedFile = currentFile;

      const state =
        currentFile.state?.name ||
        currentFile.state ||
        "";

      console.log(
        `Gemini PDF processing attempt ${attempt + 1}/30: ${state}`
      );

      if (state === "ACTIVE") {
        fileReady = true;
        break;
      }

      if (
        state === "FAILED" ||
        state === "PROCESSING_FAILED"
      ) {
        throw new Error(
          "Gemini failed to process the uploaded PDF."
        );
      }

      await new Promise(resolve =>
        setTimeout(resolve, 2000)
      );
    }

    if (!fileReady) {
      throw new Error(
        "Gemini PDF processing timed out before the file became ACTIVE."
      );
    }

    let response;

    try {
      let lastGeminiError = null;

      for (let geminiAttempt = 1; geminiAttempt <= 4; geminiAttempt++) {
        try {
          console.log(
            `Gemini generation attempt ${geminiAttempt}/4 using ${GEMINI_MODEL}`
          );

          response = await ai.models.generateContent({
            model: GEMINI_MODEL,

            contents: [
          {
            role: "user",

            parts: [
              {
                fileData: {
                  fileUri:
                    processedFile.uri ||
                    uploadedFile.uri,

                  mimeType:
                    processedFile.mimeType ||
                    "application/pdf"
                }
              },

              {
                text: buildStudyGenerationPrompt({
                  subject,
                  topic,
                  mode,
                  count,
                  difficulty,
                  customPrompt
                })
              }
            ]
          }
        ],

        config: {
          responseMimeType: "application/json",

          responseSchema:
            AI_STUDY_RESPONSE_SCHEMA,

          maxOutputTokens: Math.min(
            30000,
            Math.max(
              6000,
              count * 500
            )
          )
        }
          });

          lastGeminiError = null;
          break;

        } catch (error) {
          lastGeminiError = error;

          const status =
            error?.status ??
            error?.code ??
            error?.response?.status;

          const isRetryable =
            status === 429 ||
            status === 500 ||
            status === 502 ||
            status === 503 ||
            status === 504 ||
            String(error?.message || "").includes("high demand") ||
            String(error?.message || "").includes("UNAVAILABLE");

          console.error(
            `Gemini attempt ${geminiAttempt}/4 failed:`,
            error?.message || error
          );

          if (!isRetryable || geminiAttempt === 4) {
            throw error;
          }

          const delay =
            Math.min(30000, 3000 * Math.pow(2, geminiAttempt - 1));

          console.log(
            `Gemini temporarily unavailable. Retrying in ${delay / 1000}s...`
          );

          await new Promise(resolve =>
            setTimeout(resolve, delay)
          );
        }
      }

      if (lastGeminiError) {
        throw lastGeminiError;
      }

    } catch (error) {
      console.error(
        "\n===== GEMINI GENERATION ERROR ====="
      );

      console.error("Name:", error?.name);
      console.error("Message:", error?.message);
      console.error("Status:", error?.status);
      console.error("Code:", error?.code);
      console.error("Details:", error?.details);
      console.error("Full error:", error);

      console.error(
        "===================================\n"
      );

      throw new Error(
        `Gemini generation failed: ${
          error?.message ||
          "Unknown Gemini API error"
        }`
      );
    }

    const rawText =
      response?.text ||
      response?.candidates?.[0]?.content?.parts
        ?.map(part => part.text || "")
        .join("") ||
      "";

    if (!rawText.trim()) {
      throw new Error(
        "Gemini returned an empty response."
      );
    }

    let parsed;

    try {
      parsed = JSON.parse(rawText);
    } catch (error) {
      console.error(
        "Gemini JSON parsing failed:",
        rawText
      );

      throw new Error(
        "Gemini returned invalid JSON."
      );
    }

    if (
      !parsed ||
      !Array.isArray(parsed.questions)
    ) {
      throw new Error(
        "Gemini response did not contain a valid questions array."
      );
    }

    return parsed.questions;

  } finally {
    if (uploadedFile?.name) {
      try {
        await ai.files.delete({
          name: uploadedFile.name
        });
      } catch (deleteError) {
        console.warn(
          "Could not delete temporary Gemini file:",
          deleteError?.message ||
          deleteError
        );
      }
    }
  }
}

function normalizeFillInTheBlankQuestion(
  question,
  {
    subject = "",
    topic = "",
    source = "",
    index = 0,
    filename = ""
  } = {}
) {
  if (!question || typeof question !== "object") {
    return null;
  }

  const text = cleanString(question.question);
  const answer = cleanString(question.answer);

  if (!text || !answer) {
    return null;
  }

  if (!text.includes("_____")) {
    return null;
  }

  let acceptedAnswers =
    Array.isArray(question.accepted_answers)
      ? question.accepted_answers
          .map(cleanString)
          .filter(Boolean)
      : [];

  if (!acceptedAnswers.includes(answer)) {
    acceptedAnswers.unshift(answer);
  }

  const difficulty =
    ["easy", "medium", "difficult"].includes(
      cleanString(question.difficulty).toLowerCase()
    )
      ? cleanString(question.difficulty).toLowerCase()
      : "medium";

  return {
    id:
      question.id ||
      makeQuestionId(
        filename || source || "ai-generated",
        index,
        text
      ),

    mode: "fill_in_the_blanks",

    subject:
      cleanString(question.subject) ||
      subject,

    topic:
      cleanString(question.topic) ||
      topic,

    subtopic:
      cleanString(question.subtopic),

    question: text,

    answer,

    accepted_answers:
      [...new Set(acceptedAnswers)],

    explanation:
      cleanString(question.explanation),

    difficulty,

    source:
      cleanString(question.source) ||
      source
  };
}

/* =========================================================
   AI QUESTION NORMALIZATION
   ========================================================= */

function normalizeAiQuestion(
  question,
  {
    mode,
    subject = "",
    topic = "",
    source = "",
    index = 0,
    filename = ""
  } = {}
) {
  if (!question || typeof question !== "object") {
    return null;
  }

  const clean = value =>
    typeof value === "string"
      ? value.trim()
      : "";

  const difficultyValue =
    clean(question.difficulty).toLowerCase();

  const difficulty =
    [
      "easy",
      "medium",
      "difficult"
    ].includes(difficultyValue)
      ? difficultyValue
      : "medium";

  const base = {
    id:
      question.id ||
      makeQuestionId(
        filename || source || "ai-generated",
        index,
        clean(question.question) ||
          `${mode}-${index}`
      ),

    mode,

    subject:
      clean(question.subject) ||
      subject,

    topic:
      clean(question.topic) ||
      topic,

    subtopic:
      clean(question.subtopic),

    question:
      clean(question.question),

    explanation:
      clean(question.explanation),

    difficulty,

    source:
      clean(question.source) ||
      source
  };

  /*
   * MCQ
   */
  if (mode === "mcq") {
    const options =
      Array.isArray(question.options)
        ? question.options
            .map(clean)
            .filter(Boolean)
        : [];

    const answer =
      clean(question.answer);

    if (
      !base.question ||
      options.length !== 4 ||
      !answer ||
      !options.includes(answer)
    ) {
      return null;
    }

    return {
      ...base,

      options,

      answer
    };
  }

  /*
   * Fill in the Blanks
   */
  if (mode === "fill_in_the_blanks") {
    const answer =
      clean(question.answer);

    if (
      !base.question ||
      !base.question.includes("_____") ||
      !answer
    ) {
      return null;
    }

    let acceptedAnswers =
      Array.isArray(
        question.accepted_answers
      )
        ? question.accepted_answers
            .map(clean)
            .filter(Boolean)
        : [];

    if (
      !acceptedAnswers.includes(answer)
    ) {
      acceptedAnswers.unshift(answer);
    }

    return {
      ...base,

      answer,

      accepted_answers:
        [...new Set(acceptedAnswers)]
    };
  }

  /*
   * Short-answer Questions
   */
  if (mode === "questions") {
    const answer =
      clean(question.answer);

    if (
      !base.question ||
      !answer
    ) {
      return null;
    }

    return {
      ...base,

      answer
    };
  }

  /*
   * Case Based
   */
  if (mode === "case_based") {
    const caseText =
      clean(question.case);

    const answer =
      clean(question.answer);

    if (
      !caseText ||
      !base.question ||
      !answer
    ) {
      return null;
    }

    return {
      ...base,

      case:
        caseText,

      answer
    };
  }

  /*
   * Match the Column
   */
  if (mode === "match_the_column") {
    const columnA =
      Array.isArray(question.column_a)
        ? question.column_a
            .map(clean)
            .filter(Boolean)
        : [];

    const columnB =
      Array.isArray(question.column_b)
        ? question.column_b
            .map(clean)
            .filter(Boolean)
        : [];

    const matches =
      Array.isArray(question.matches)
        ? question.matches
            .filter(
              match =>
                Number.isInteger(match?.a) &&
                Number.isInteger(match?.b)
            )
            .map(match => ({
              a: match.a,
              b: match.b
            }))
        : [];

    if (
      !base.question ||
      columnA.length < 2 ||
      columnB.length < 2 ||
      !matches.length
    ) {
      return null;
    }

    const validMatches =
      matches.every(
        match =>
          match.a >= 0 &&
          match.a < columnA.length &&
          match.b >= 0 &&
          match.b < columnB.length
      );

    if (!validMatches) {
      return null;
    }

    return {
      ...base,

      column_a:
        columnA,

      column_b:
        columnB,

      matches
    };
  }

  /*
   * Map
   */
  if (mode === "map") {
    const location =
      clean(question.location);

    const answer =
      clean(question.answer);

    if (
      !base.question ||
      !location ||
      !answer
    ) {
      return null;
    }

    const region =
      clean(question.region);

    const acceptableLocations =
      Array.isArray(
        question.acceptable_locations
      )
        ? question.acceptable_locations
            .map(clean)
            .filter(Boolean)
        : [];

    return {
      ...base,

      location,

      region,

      latitude:
        typeof question.latitude === "number"
          ? question.latitude
          : null,

      longitude:
        typeof question.longitude === "number"
          ? question.longitude
          : null,

      acceptable_locations:
        acceptableLocations,

      answer
    };
  }

  return null;
}

/* =========================================================
   GENERIC BANK NORMALIZATION
   ========================================================= */

function normalizeBank(
  bank,
  filename = "unknown.json"
) {
  if (!bank) {
    return null;
  }

  let questions = [];

  let subject = "";
  let topic = "";
  let bankMode = "";

  if (Array.isArray(bank)) {
    questions = bank;
  } else if (
    typeof bank === "object"
  ) {
    subject =
      cleanString(bank.subject);

    topic =
      cleanString(bank.topic);

    bankMode =
      cleanString(bank.mode);

    if (Array.isArray(bank.questions)) {
      questions = bank.questions;
    }
  }

  if (!questions.length) {
    return null;
  }

  /*
   * Normalize each question according
   * to the bank/question study mode.
   */
  const normalizedQuestions =
    questions
      .map((question, index) => {
        if (
          !question ||
          typeof question !== "object"
        ) {
          return null;
        }

        let detectedMode =
          cleanString(question.mode) ||
          bankMode;

        /*
         * Legacy Fill-in-the-Blanks banks
         * may not explicitly contain a mode.
         */
        if (!detectedMode) {
          if (
            Array.isArray(
              question.accepted_answers
            ) ||
            (
              cleanString(question.question)
                .includes("_____") &&
              cleanString(question.answer)
            )
          ) {
            detectedMode =
              "fill_in_the_blanks";
          }
        }

        /*
         * Normalize the mode aliases that
         * may exist in older banks.
         */
        if (detectedMode === "fill") {
          detectedMode =
            "fill_in_the_blanks";
        }

        if (detectedMode === "case") {
          detectedMode =
            "case_based";
        }

        if (detectedMode === "match") {
          detectedMode =
            "match_the_column";
        }

        /*
         * AI-generated / six-mode banks.
         */
        if (
          AI_MODES.includes(
            detectedMode
          )
        ) {
          return normalizeAiQuestion(
            question,
            {
              mode:
                detectedMode,

              subject,

              topic,

              source:
                filename,

              index,

              filename
            }
          );
        }

        /*
         * Preserve unknown/legacy question
         * formats exactly as they were.
         */
        return question;
      })
      .filter(Boolean);

  if (!normalizedQuestions.length) {
    return null;
  }

  /*
   * Determine the bank mode from the
   * normalized questions when possible.
   */
  const normalizedModes =
    [
      ...new Set(
        normalizedQuestions
          .map(
            question =>
              cleanString(
                question?.mode
              )
          )
          .filter(Boolean)
      )
    ];

  const detectedMode =
    normalizedModes.length === 1
      ? normalizedModes[0]
      : bankMode;

  return {
    subject,

    topic,

    mode:
      detectedMode,

    source:
      filename,

    questions:
      normalizedQuestions
  };
}

/* =========================================================
   QUESTION BANK LOADING
   ========================================================= */

async function loadQuestionBanks() {
  await ensureDirectories();

  const files =
    await fs.readdir(
      QUESTION_BANK_DIR
    );

  const jsonFiles =
    files.filter(
      filename =>
        filename.toLowerCase().endsWith(".json")
    );

  const banks = [];

  for (const filename of jsonFiles) {
    const fullPath =
      path.join(
        QUESTION_BANK_DIR,
        filename
      );

    try {
      const raw =
        await fs.readFile(
          fullPath,
          "utf8"
        );

      const parsed =
        JSON.parse(raw);

      const bank =
        normalizeBank(
          parsed,
          filename
        );

      if (bank) {
        banks.push(bank);
      }

    } catch (error) {
      console.error(
        `Failed to load ${filename}:`,
        error?.message || error
      );
    }
  }

  return banks;
}

/* =========================================================
   FLATTEN QUESTIONS
   ========================================================= */

function flattenQuestionBanks(
  banks
) {
  const questions = [];

  const seenIds =
    new Set();

  for (const bank of banks) {
    for (
      const question of
      bank.questions || []
    ) {
      const id =
        question.id ||
        makeQuestionId(
          bank.source || "bank",
          questions.length,
          question.question
        );

      if (seenIds.has(id)) {
        continue;
      }

      seenIds.add(id);

      questions.push({
        ...question,

        id,

        subject:
          question.subject ||
          bank.subject,

        topic:
          question.topic ||
          bank.topic,

        mode:
          question.mode ||
          bank.mode,

        source:
          question.source ||
          bank.source
      });
    }
  }

  return questions;
}

/* =========================================================
   SUPABASE CONFIG API
   ========================================================= */

app.get(
  "/api/supabase-config",
  (_req, res) => {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return res.status(500).json({
        error: "Supabase configuration is unavailable."
      });
    }

    res.json({
      url: SUPABASE_URL,
      key: SUPABASE_ANON_KEY
    });
  }
);

/* =========================================================
   QUESTION BANK API
   ========================================================= */

app.get(
  "/api/question-banks",
  async (_req, res) => {
    try {
      const banks =
        await loadQuestionBanks();

      const files =
        (await fs.readdir(QUESTION_BANK_DIR))
          .filter(filename =>
            filename
              .toLowerCase()
              .endsWith(".json")
          );

      res.json({
        banks,
        files,
        totalQuestions:
          banks.reduce(
            (total, bank) =>
              total +
              (bank.questions?.length || 0),
            0
          )
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Failed to load question banks."
      });
    }
  }
);

app.get(
  "/api/questions",
  async (_req, res) => {
    try {
      const banks =
        await loadQuestionBanks();

      const questions =
        flattenQuestionBanks(
          banks
        );

      res.json({
        questions
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Failed to load questions."
      });
    }
  }
);

/* =========================================================
   AI STATUS
   ========================================================= */

app.get(
  "/api/ai/status",
  (_req, res) => {
    res.json({
      configured:
        Boolean(
          process.env.GEMINI_API_KEY
        ),

      model:
        GEMINI_MODEL,

      maxPdfSizeMB:
        AI_UPLOAD_MAX_BYTES /
        (1024 * 1024)
    });
  }
);

/* =========================================================
   AI GENERATE FILL-IN-THE-BLANKS
   ========================================================= */

app.post(
  "/api/ai/generate-fib",

  aiUpload.single("pdf"),

  async (req, res) => {
    try {
      /*
       * Require authentication when Supabase
       * is configured.
       */
      if (supabase) {
        const user =
          await getAuthenticatedUser(
            req
          );

        if (!user) {
          return res.status(401).json({
            error:
              "Authentication required."
          });
        }
      }

      if (!req.file) {
        return res.status(400).json({
          error:
            "Please upload a PDF."
        });
      }

      const subject =
        cleanString(
          req.body.subject
        );

      const topic =
        cleanString(
          req.body.topic
        );

      if (!subject) {
        return res.status(400).json({
          error:
            "Subject is required."
        });
      }

      if (!topic) {
        return res.status(400).json({
          error:
            "Topic is required."
        });
      }

      let count =
        Number(
          req.body.count
        );

      if (
        !Number.isFinite(count)
      ) {
        count = 30;
      }

      count =
        Math.max(
          5,
          Math.min(
            100,
            Math.round(count)
          )
        );

      const requestedDifficulty =
        cleanString(
          req.body.difficulty
        ).toLowerCase();

      const difficulty =
        [
          "mixed",
          "easy",
          "medium",
          "difficult"
        ].includes(
          requestedDifficulty
        )
          ? requestedDifficulty
          : "mixed";

      const customPrompt =
        cleanString(
          req.body.prompt
        );

      const requestedMode =
        cleanString(
          req.body.mode
        ).toLowerCase();

      const mode =
        requestedMode ||
        "fill_in_the_blanks";

      if (!AI_MODES.includes(mode)) {
        return res.status(400).json({
          error:
            `Unsupported study mode: "${mode}".`
        });
      }

      console.log(
        `AI ${mode} generation started: ${req.file.originalname}`
      );

      console.log(
        `Subject: ${subject}`
      );

      console.log(
        `Topic: ${topic}`
      );

      console.log(
        `Questions: ${count}`
      );

      const generatedQuestions =
        await generateStudyBankFromPdf({
          pdfBuffer:
            req.file.buffer,

          originalFilename:
            req.file.originalname,

          subject,

          topic,

          mode,

          count,

          difficulty,

          customPrompt
        });

      /*
       * Convert AI output into the exact
       * structure used by the existing
       * question-bank system.
       */
      const normalizedQuestions =
        generatedQuestions
          .map(
            (
              question,
              index
            ) =>
              normalizeAiQuestion(
                question,
                {
                  mode,

                  subject,

                  topic,

                  source:
                    req.file.originalname,

                  index,

                  filename:
                    req.file.originalname
                }
              )
          )
          .filter(Boolean);

      if (
        !normalizedQuestions.length
      ) {
        throw new Error(
          `AI generated no valid ${mode} questions.`
        );
      }

      /*
       * Remove duplicates by question text.
       */
      const uniqueQuestions = [];

      const seenQuestions =
        new Set();

      for (
        const question
        of normalizedQuestions
      ) {
        const key =
          question.question
            .toLowerCase()
            .replace(/\s+/g, " ")
            .trim();

        if (
          seenQuestions.has(key)
        ) {
          continue;
        }

        seenQuestions.add(key);

        uniqueQuestions.push(
          question
        );
      }

      const bank = {
        subject,

        topic,

        mode,



        generated_by:
          AI_PROVIDER === "openrouter"
            ? "openrouter"
            : "gemini",

        source:
          req.file.originalname,

        generated_at:
          new Date().toISOString(),

        questions:
          uniqueQuestions
      };

      /*
       * Save the generated bank so the
       * existing question-bank loader can
       * immediately use it.
       */
      const filename =
        safeAiBankFilename(
          subject,
          topic
        );

      const outputPath =
        path.join(
          QUESTION_BANK_DIR,
          filename
        );

      await fs.writeFile(
        outputPath,
        JSON.stringify(
          bank,
          null,
          2
        ),
        "utf8"
      );

      console.log(
        `AI ${mode} generation complete: ${filename} using ${AI_PROVIDER}`
      );

      res.json({
        success: true,

        filename,

        subject,

        topic,

        mode:
          "fill_in_the_blanks",

        count:
          uniqueQuestions.length,

        questions:
          uniqueQuestions
      });

    } catch (error) {
      console.error(
        "AI FIB generation error:",
        error
      );

      res.status(500).json({
        error:
          error?.message ||
          "Failed to generate fill-in-the-blank questions."
      });
    }
  }
);

/* =========================================================
   JSON BANK IMPORT
   ========================================================= */

app.post(
  "/api/question-banks/import",
  async (req, res) => {
    try {
      const {
        filename,
        bank,
        data
      } = req.body || {};

      const importedBank =
        bank || data;

      if (
        !filename ||
        !importedBank
      ) {
        return res.status(400).json({
          error:
            "filename and bank are required."
        });
      }

      const safeFilename =
        path.basename(
          filename
        );

      if (
        !safeFilename
          .toLowerCase()
          .endsWith(".json")
      ) {
        return res.status(400).json({
          error:
            "Only JSON files are allowed."
        });
      }

      const normalized =
        normalizeBank(
          importedBank,
          safeFilename
        );

      if (!normalized) {
        return res.status(400).json({
          error:
            "Invalid question bank."
        });
      }

      const outputPath =
        path.join(
          QUESTION_BANK_DIR,
          safeFilename
        );

      await fs.writeFile(
        outputPath,
        JSON.stringify(
          normalized,
          null,
          2
        ),
        "utf8"
      );

      res.json({
        success: true,
        filename:
          safeFilename,
        questionCount:
          normalized.questions?.length || 0,
        bank:
          normalized
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Failed to import question bank."
      });
    }
  }
);

/* =========================================================
   PERFORMANCE STORAGE
   ========================================================= */

async function readPerformance() {
  await ensureDirectories();

  try {
    const raw =
      await fs.readFile(
        PERFORMANCE_FILE,
        "utf8"
      );

    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writePerformance(
  performance
) {
  await ensureDirectories();

  await fs.writeFile(
    PERFORMANCE_FILE,

    JSON.stringify(
      performance,
      null,
      2
    ),

    "utf8"
  );
}

/* =========================================================
   PERFORMANCE API
   ========================================================= */

app.get(
  "/api/performance",
  async (_req, res) => {
    try {
      const performance =
        await readPerformance();

      res.json(
        performance
      );

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Failed to load performance."
      });
    }
  }
);

app.post(
  "/api/performance",
  async (req, res) => {
    try {
      const performance =
        await readPerformance();

      const incoming =
        req.body || {};

      Object.assign(
        performance,
        incoming
      );

      await writePerformance(
        performance
      );

      res.json({
        success: true
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Failed to save performance."
      });
    }
  }
);

/* =========================================================
   HEALTH CHECK
   ========================================================= */

app.get(
  "/api/health",
  (_req, res) => {
    res.json({
      ok: true,
      timestamp:
        new Date().toISOString()
    });
  }
);

/* =========================================================
   FALLBACK
   ========================================================= */

app.use(async (req, res, next) => {
  if (req.method !== "GET") {
    return next();
  }

  if (req.path.startsWith("/api/")) {
    return next();
  }

  try {
    await fs.access(
      path.join(ROOT, "index.html")
    );

    res.sendFile(
      path.join(ROOT, "index.html")
    );
  } catch {
    res.status(404).send(
      "index.html not found."
    );
  }
});

/* =========================================================
   ERROR HANDLER
   ========================================================= */

app.use(
  (
    error,
    _req,
    res,
    _next
  ) => {
    console.error(
      "Server error:",
      error
    );

    if (
      error instanceof multer.MulterError
    ) {
      if (
        error.code ===
        "LIMIT_FILE_SIZE"
      ) {
        return res.status(400).json({
          error:
            "PDF is too large. Maximum size is 50 MB."
        });
      }

      return res.status(400).json({
        error:
          error.message
      });
    }

    res.status(500).json({
      error:
        error?.message ||
        "Internal server error."
    });
  }
);

/* =========================================================
   START SERVER
   ========================================================= */

await ensureDirectories();

app.listen(
  PORT,
  () => {
    console.log(
      `Study Space server running on http://localhost:${PORT}`
    );

    console.log(
      `Gemini configured: ${Boolean(
        process.env.GEMINI_API_KEY
      )}`
    );

    console.log(
      `Gemini model: ${GEMINI_MODEL}`
    );
  }
);