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

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.8-flash";

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
   AI FILL-IN-THE-BLANK RESPONSE SCHEMA
   ========================================================= */

const AI_FIB_RESPONSE_SCHEMA = {
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

          answer: {
            type: "string"
          },

          accepted_answers: {
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
          "accepted_answers",
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
   AI PROMPT
   ========================================================= */

function buildFibGenerationPrompt({
  subject,
  topic,
  count,
  difficulty,
  customPrompt = ""
}) {
  return `
You are the study-question generation engine for a psychology student's
study website.

SOURCE MATERIAL:
You will receive ONE uploaded PDF. The PDF is the ONLY authoritative
source for generating questions.

SUBJECT:
${subject}

TOPIC:
${topic}

NUMBER OF QUESTIONS:
Generate approximately ${count} high-quality questions.

TARGET DIFFICULTY:
${difficulty}

USER CUSTOM INSTRUCTIONS:
${customPrompt
  ? customPrompt
  : "No additional custom instructions were provided. Follow the generation rules below."}

IMPORTANT:
The user's custom instructions are preferences for how to generate the questions.
They must NOT override the source-material rule.

If the custom instructions request information, facts, examples, terminology,
or answers that are not supported by the uploaded PDF, do NOT invent them.
Use only what the PDF supports.

CORE RULE:
Use ONLY information explicitly contained in the uploaded PDF.

Do NOT introduce facts from your own knowledge.
Do NOT add information that is not supported by the PDF.
Do NOT silently correct, update, reinterpret, or replace information
contained in the PDF.

The purpose is active recall and long-term retention.

QUESTION TYPE:
Generate FILL-IN-THE-BLANK questions.

Every question MUST contain:
_____

Example:

"The minimum duration required for the symptoms is _____."

The blank should represent information that the learner must actively
retrieve.

QUALITY REQUIREMENTS:

1. Cover the important information from the PDF.
2. Do not focus only on headings or obvious definitions.
3. Include concepts, terminology, definitions, distinctions,
   mechanisms, relationships, classifications, examples,
   sequences, characteristics, criteria, and important details
   when they appear in the PDF.
4. Avoid unnecessary repetition.
5. Do not generate duplicate questions.
6. Questions should test meaningful recall.
7. Avoid questions where the answer can be guessed easily from
   surrounding wording.
8. Make the question itself clear enough that there is one intended
   answer.
9. Accepted answers must genuinely mean the same thing as the answer.
10. Do not put multiple unrelated blanks into one question.
11. Use a mixture of short and longer answers.
12. Some answers may be one word.
13. Some answers may be a phrase.
14. Some answers may be an entire sentence or multi-part statement
    when that is necessary to test the information accurately.
15. Do NOT make every blank a single word.
16. Use different sentence structures.
17. Avoid simply copying the same sentence repeatedly.
18. Preserve terminology used in the source material.

DIFFICULTY:

Easy:
Basic factual retrieval, terminology, straightforward definitions.

Medium:
Requires remembering a relationship, distinction, characteristic,
classification, sequence, or explanation.

Difficult:
Requires meaningful retrieval and discrimination between closely
related concepts, mechanisms, categories, criteria, or details.

If difficulty is "mixed", create a mixture of all three.

RETENTION FOCUS:

The questions should help the learner remember the material rather
than merely recognize it.

Prefer questions such as:

- "_____ refers to..."
- "According to the source, _____ is characterized by..."
- "The distinction between X and Y is that _____..."
- "The process begins with _____ and is followed by..."
- "One important feature of X is _____..."
- "X differs from Y because _____..."
- "The three components identified in the source are _____..."
- "The condition requires _____..."
- "The theory proposes that _____..."

But do NOT mechanically use these templates.

EXPLANATIONS:

For every question, provide a concise explanation based ONLY on
the PDF. The explanation should reinforce the information being
tested.

SUBTOPIC:

Identify the specific subtopic/concept tested by the question.

ACCEPTED ANSWERS:

Include the main answer and only genuinely equivalent answers.

Do not add broad alternatives that would make an incorrect answer
appear correct.

FINAL CHECK:

Before returning each question, verify:

- It is supported by the PDF.
- It contains _____.
- It has a clear intended answer.
- The answer actually fits the blank.
- The accepted answers are genuinely equivalent.
- It is not a duplicate.
- It contributes useful retention practice.
- Its difficulty is appropriate.
- The explanation is supported by the PDF.

Return ONLY the requested structured JSON.
`;
}

/* =========================================================
   GEMINI PDF GENERATION
   ========================================================= */

async function generateFibBankFromPdf({
  pdfBuffer,
  originalFilename,
  subject,
  topic,
  count,
  difficulty,
  customPrompt = ""
}) {
  const ai = getGeminiClient();

  let uploadedFile = null;

  try {
    /*
     * Upload the PDF to Gemini Files API.
     */
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

    /*
     * Wait until Gemini has finished processing the PDF.
     */
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

    /*
     * Generate structured JSON.
     */
    let response;

    try {
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
                text: buildFibGenerationPrompt({
                  subject,
                  topic,
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
          responseSchema: AI_FIB_RESPONSE_SCHEMA,

          maxOutputTokens: Math.min(
            30000,
            Math.max(
              6000,
              count * 500
            )
          )
        }
      });

    } catch (error) {
      console.error("\n===== GEMINI GENERATION ERROR =====");
      console.error("Name:", error?.name);
      console.error("Message:", error?.message);
      console.error("Status:", error?.status);
      console.error("Code:", error?.code);
      console.error("Details:", error?.details);
      console.error("Full error:", error);
      console.error("===================================\n");

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
        "Gemini response did not contain a questions array."
      );
    }

    return parsed.questions;

  } finally {
    /*
     * Remove temporary Gemini file after generation.
     */
    if (uploadedFile?.name) {
      try {
        await ai.files.delete({
          name: uploadedFile.name
        });
      } catch (deleteError) {
        console.warn(
          "Could not delete temporary Gemini file:",
          deleteError?.message || deleteError
        );
      }
    }
  }
}

/* =========================================================
   FIB VALIDATION
   ========================================================= */

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

  const normalizedQuestions =
    questions
      .map((question, index) => {
        const detectedMode =
          cleanString(question?.mode) ||
          bankMode ||
          (
            question?.accepted_answers ||
            question?.answer
          )
            ? "fill_in_the_blanks"
            : "";

        if (
          detectedMode ===
          "fill_in_the_blanks"
        ) {
          return normalizeFillInTheBlankQuestion(
            question,
            {
              subject,
              topic,
              source: filename,
              index,
              filename
            }
          );
        }

        return question;
      })
      .filter(Boolean);

  if (!normalizedQuestions.length) {
    return null;
  }

  const detectedMode =
    normalizedQuestions.every(
      question =>
        question.mode ===
        "fill_in_the_blanks"
    )
      ? "fill_in_the_blanks"
      : bankMode;

  return {
    subject,
    topic,
    mode: detectedMode,
    source: filename,
    questions: normalizedQuestions
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
   QUESTION BANK API
   ========================================================= */

app.get(
  "/api/question-banks",
  async (_req, res) => {
    try {
      const banks =
        await loadQuestionBanks();

      res.json({
        banks
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

      console.log(
        `AI FIB generation started: ${req.file.originalname}`
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
        await generateFibBankFromPdf({
          pdfBuffer:
            req.file.buffer,

          originalFilename:
            req.file.originalname,

          subject,

          topic,

          count,

          difficulty,

          customPrompt
        });

      /*
       * Convert AI output into the exact
       * structure already used by the
       * existing question-bank system.
       */
      const normalizedQuestions =
        generatedQuestions
          .map(
            (
              question,
              index
            ) =>
              normalizeFillInTheBlankQuestion(
                {
                  ...question,

                  mode:
                    "fill_in_the_blanks",

                  subject,

                  topic,

                  source:
                    req.file.originalname
                },
                {
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
          "AI generated no valid fill-in-the-blank questions."
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

        mode:
          "fill_in_the_blanks",

        generated_by:
          "gemini",

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
        `AI FIB generation complete: ${filename}`
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
        bank
      } = req.body || {};

      if (
        !filename ||
        !bank
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
          bank,
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
          bank,
          null,
          2
        ),
        "utf8"
      );

      res.json({
        success: true,
        filename:
          safeFilename,
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