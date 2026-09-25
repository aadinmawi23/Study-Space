/**
 * Flo's Study Space — server.js
 *
 * Responsibilities:
 * 1. Serve index.html and static assets.
 * 2. Automatically scan /question-banks for every .json MCQ bank.
 * 3. Validate and normalize MCQ JSON files.
 * 4. Expose the question database through API endpoints.
 * 5. Allow new JSON banks to be imported from the Settings page.
 * 6. Persist study performance in /data/performance.json.
 */

import express from "express";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const ROOT = __dirname;
const QUESTION_BANK_DIR = path.join(ROOT, "question-banks");
const DATA_DIR = path.join(ROOT, "data");
const PERFORMANCE_FILE = path.join(DATA_DIR, "performance.json");

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

/* =======================================================
   BASIC HELPERS
======================================================= */

const today = () => new Date().toISOString().slice(0, 10);

function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
}

function safeFilename(filename) {
  const cleaned = path
    .basename(String(filename || "question-bank.json"))
    .replace(/[^\w.\- ]+/g, "")
    .replace(/\s+/g, "-");

  return cleaned.toLowerCase().endsWith(".json")
    ? cleaned
    : `${cleaned || "question-bank"}.json`;
}

function slugify(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function makeQuestionId(fileName, index, questionText) {
  const base = `${fileName}:${index}:${questionText}`;

  const hash = crypto
    .createHash("sha1")
    .update(base)
    .digest("hex")
    .slice(0, 10);

  return `q_${hash}`;
}

/* =======================================================
   DIRECTORIES + PERFORMANCE STORAGE
======================================================= */

async function ensureDirectories() {
  await fs.mkdir(QUESTION_BANK_DIR, { recursive: true });
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    await fs.access(PERFORMANCE_FILE);
  } catch {
    await fs.writeFile(
      PERFORMANCE_FILE,
      "{}\n",
      "utf8"
    );
  }
}

async function readPerformance() {
  try {
    const raw = await fs.readFile(
      PERFORMANCE_FILE,
      "utf8"
    );

    const parsed = JSON.parse(raw || "{}");

    return parsed && typeof parsed === "object"
      ? parsed
      : {};
  } catch {
    return {};
  }
}

async function writePerformance(performance) {
  const temp = `${PERFORMANCE_FILE}.tmp`;

  await fs.writeFile(
    temp,
    JSON.stringify(performance, null, 2),
    "utf8"
  );

  await fs.rename(
    temp,
    PERFORMANCE_FILE
  );
}

/* =======================================================
   MCQ VALIDATION
======================================================= */

function validateQuestion(rawQuestion, index, fileName) {
  const errors = [];

  if (
    !rawQuestion ||
    typeof rawQuestion !== "object" ||
    Array.isArray(rawQuestion)
  ) {
    return {
      valid: false,
      errors: [
        `Question ${index + 1}: question must be an object.`
      ]
    };
  }

  const question = normalizeText(
    rawQuestion.question
  );

  if (!question) {
    errors.push(
      `Question ${index + 1}: missing "question".`
    );
  }

  const rawOptions = rawQuestion.options;

  if (
    !rawOptions ||
    typeof rawOptions !== "object" ||
    Array.isArray(rawOptions)
  ) {
    errors.push(
      `Question ${index + 1}: "options" must contain A, B, C and D.`
    );
  }

  const options = {
    A: normalizeText(rawOptions?.A),
    B: normalizeText(rawOptions?.B),
    C: normalizeText(rawOptions?.C),
    D: normalizeText(rawOptions?.D)
  };

  for (const letter of ["A", "B", "C", "D"]) {
    if (!options[letter]) {
      errors.push(
        `Question ${index + 1}: option ${letter} is missing.`
      );
    }
  }

  let answer = normalizeText(
    rawQuestion.answer
  ).toUpperCase();

  if (
    !answer &&
    rawQuestion.correctAnswer
  ) {
    answer = normalizeText(
      rawQuestion.correctAnswer
    ).toUpperCase();
  }

  if (!["A", "B", "C", "D"].includes(answer)) {
    errors.push(
      `Question ${index + 1}: answer must be A, B, C or D.`
    );
  }

  if (errors.length) {
    return {
      valid: false,
      errors
    };
  }

  const id =
    normalizeText(rawQuestion.id) ||
    makeQuestionId(
      fileName,
      index,
      question
    );

  return {
    valid: true,

    question: {
      id,

      question,

      options,

      answer,

      explanation:
        normalizeText(
          rawQuestion.explanation
        ),

      subtopic:
        normalizeText(
          rawQuestion.subtopic
        ),

      difficulty:
        normalizeText(
          rawQuestion.difficulty
        ),

      source:
        normalizeText(
          rawQuestion.source
        ) || fileName
    }
  };
}

/* =======================================================
   QUESTION BANK NORMALIZATION

   Supported format:

   {
     "subject": "Indian History",
     "topic": "Maurya Period",
     "subtopic": "Sources",
     "questions": [...]
   }

   OR an array of question objects.
======================================================= */

function normalizeBank(raw, fileName) {
  const errors = [];

  let subject = "";
  let topic = "";
  let subtopic = "";

  let questions = [];

  /* -----------------------------------------------
     Array format
  ------------------------------------------------ */

  if (Array.isArray(raw)) {
    questions = raw;
  }

  /* -----------------------------------------------
     Object format
  ------------------------------------------------ */

  else if (
    raw &&
    typeof raw === "object"
  ) {
    subject = normalizeText(
      raw.subject
    );

    topic = normalizeText(
      raw.topic
    );

    subtopic = normalizeText(
      raw.subtopic
    );

    if (Array.isArray(raw.questions)) {
      questions = raw.questions;
    }

    else if (Array.isArray(raw.mcqs)) {
      questions = raw.mcqs;
    }

    else if (Array.isArray(raw.data)) {
      questions = raw.data;
    }

    else {
      errors.push(
        `"${fileName}": no "questions" array was found.`
      );
    }
  }

  else {
    errors.push(
      `"${fileName}": JSON must contain an object or array.`
    );
  }

  /* -----------------------------------------------
     Allow first question to provide classification
  ------------------------------------------------ */

  if (
    !subject &&
    questions[0]?.subject
  ) {
    subject = normalizeText(
      questions[0].subject
    );
  }

  if (
    !topic &&
    questions[0]?.topic
  ) {
    topic = normalizeText(
      questions[0].topic
    );
  }

  if (!subject) {
    errors.push(
      `"${fileName}": missing subject.`
    );
  }

  if (!topic) {
    errors.push(
      `"${fileName}": missing topic.`
    );
  }

  const validQuestions = [];

  /* -----------------------------------------------
     Validate every question
  ------------------------------------------------ */

  questions.forEach(
    (rawQuestion, index) => {

      const result =
        validateQuestion(
          rawQuestion,
          index,
          fileName
        );

      if (!result.valid) {
        errors.push(
          ...result.errors
        );

        return;
      }

      const normalized =
        result.question;

      /* Question-level metadata
         overrides bank metadata */

      normalized.subject =
        normalizeText(
          rawQuestion.subject
        ) || subject;

      normalized.topic =
        normalizeText(
          rawQuestion.topic
        ) || topic;

      normalized.subtopic =
        normalizeText(
          rawQuestion.subtopic
        ) || subtopic;

      if (!normalized.subject) {
        errors.push(
          `Question ${index + 1}: missing subject.`
        );

        return;
      }

      if (!normalized.topic) {
        errors.push(
          `Question ${index + 1}: missing topic.`
        );

        return;
      }

      validQuestions.push(
        normalized
      );
    }
  );

  return {
    valid:
      errors.length === 0 &&
      validQuestions.length > 0,

    bank: {
      subject,

      topic,

      subtopic,

      source: fileName,

      file: fileName,

      questions:
        validQuestions
    },

    errors,

    questionCount:
      validQuestions.length
  };
}

/* =======================================================
   LOAD EVERY JSON FILE AUTOMATICALLY
======================================================= */

async function loadQuestionBanks() {
  await ensureDirectories();

  const files =
    (
      await fs.readdir(
        QUESTION_BANK_DIR
      )
    )
      .filter(
        file =>
          file
            .toLowerCase()
            .endsWith(".json")
      )
      .sort(
        (a, b) =>
          a.localeCompare(b)
      );

  const banks = [];

  const errors = [];

  const seenIds = new Map();

  for (
    const fileName of files
  ) {

    const fullPath =
      path.join(
        QUESTION_BANK_DIR,
        fileName
      );

    try {

      const rawText =
        await fs.readFile(
          fullPath,
          "utf8"
        );

      const raw =
        JSON.parse(rawText);

      const result =
        normalizeBank(
          raw,
          fileName
        );

      if (
        result.bank.questions.length
      ) {

        for (
          const question
          of result.bank.questions
        ) {

          if (
            seenIds.has(
              question.id
            )
          ) {

            const previous =
              seenIds.get(
                question.id
              );

            errors.push(
              `Duplicate question ID "${question.id}" in ${fileName}; already used by ${previous}.`
            );

          }

          else {

            seenIds.set(
              question.id,
              fileName
            );
          }
        }

        banks.push(
          result.bank
        );
      }

      if (
        result.errors.length
      ) {
        errors.push(
          ...result.errors
        );
      }

    }

    catch (error) {

      errors.push(
        `${fileName}: ${error.message}`
      );

    }
  }

  return {

    banks,

    errors,

    files,

    totalQuestions:
      banks.reduce(
        (total, bank) =>
          total +
          bank.questions.length,
        0
      )
  };
}

/* =======================================================
   FLATTEN QUESTION BANKS
======================================================= */

function flattenBanks(database) {

  return database.banks.flatMap(
    bank =>

      bank.questions.map(
        question => ({

          ...question,

          subject:
            question.subject ||
            bank.subject,

          topic:
            question.topic ||
            bank.topic,

          subtopic:
            question.subtopic ||
            bank.subtopic ||
            "",

          source:
            question.source ||
            bank.source

        })
      )
  );
}

/* =======================================================
   HEALTH
======================================================= */

app.get(
  "/api/health",
  async (_req, res) => {

    const database =
      await loadQuestionBanks();

    res.json({

      ok: true,

      app:
        "Flo's Study Space",

      questionBanks:
        database.files.length,

      questions:
        database.totalQuestions,

      date:
        today()

    });
  }
);

/* =======================================================
   QUESTION BANK API
======================================================= */

app.get(
  "/api/question-banks",
  async (_req, res) => {

    const database =
      await loadQuestionBanks();

    res.json({

      banks:
        database.banks,

      errors:
        database.errors,

      files:
        database.files,

      totalQuestions:
        database.totalQuestions

    });
  }
);

/* =======================================================
   ALL QUESTIONS
======================================================= */

app.get(
  "/api/questions",
  async (req, res) => {

    const database =
      await loadQuestionBanks();

    let questions =
      flattenBanks(
        database
      );

    const subject =
      normalizeKey(
        req.query.subject
      );

    const topic =
      normalizeKey(
        req.query.topic
      );

    const subtopic =
      normalizeKey(
        req.query.subtopic
      );

    if (subject) {

      questions =
        questions.filter(
          q =>
            normalizeKey(
              q.subject
            ) === subject
        );

    }

    if (topic) {

      questions =
        questions.filter(
          q =>
            normalizeKey(
              q.topic
            ) === topic
        );

    }

    if (subtopic) {

      questions =
        questions.filter(
          q =>
            normalizeKey(
              q.subtopic
            ) === subtopic
        );

    }

    res.json({

      questions,

      count:
        questions.length,

      errors:
        database.errors

    });
  }
);

/* =======================================================
   SUBJECT + TOPIC SUMMARY
======================================================= */

app.get(
  "/api/subjects",
  async (_req, res) => {

    const database =
      await loadQuestionBanks();

    const questions =
      flattenBanks(
        database
      );

    const subjectMap =
      new Map();

    for (
      const q of questions
    ) {

      const subjectKey =
        normalizeKey(
          q.subject
        );

      if (
        !subjectMap.has(
          subjectKey
        )
      ) {

        subjectMap.set(
          subjectKey,
          {

            subject:
              q.subject,

            questions:
              0,

            topics:
              new Map()

          }
        );

      }

      const subject =
        subjectMap.get(
          subjectKey
        );

      subject.questions++;

      const topicKey =
        normalizeKey(
          q.topic
        );

      if (
        !subject.topics.has(
          topicKey
        )
      ) {

        subject.topics.set(
          topicKey,
          {

            topic:
              q.topic,

            questions:
              0

          }
        );

      }

      subject.topics.get(
        topicKey
      ).questions++;

    }

    const subjects =
      [...subjectMap.values()]
        .map(
          subject => ({

            subject:
              subject.subject,

            questions:
              subject.questions,

            topics:
              [
                ...subject
                  .topics
                  .values()
              ]

          })
        );

    res.json({

      subjects,

      errors:
        database.errors

    });
  }
);

/* =======================================================
   IMPORT JSON FROM SETTINGS
======================================================= */

app.post(
  "/api/question-banks/import",
  async (req, res) => {

    try {

      await ensureDirectories();

      const filename =
        safeFilename(
          req.body?.filename
        );

      const data =
        req.body?.data;

      if (
        !data ||
        typeof data !== "object"
      ) {

        return res
          .status(400)
          .json({

            error:
              "No valid JSON data was supplied."

          });

      }

      const result =
        normalizeBank(
          data,
          filename
        );

      if (
        !result.bank.questions.length
      ) {

        return res
          .status(400)
          .json({

            error:
              "The JSON does not contain any valid MCQ questions.",

            details:
              result.errors

          });

      }

      if (
        result.errors.length
      ) {

        return res
          .status(400)
          .json({

            error:
              "The JSON contains validation errors.",

            details:
              result.errors

          });

      }

      const destination =
        path.join(
          QUESTION_BANK_DIR,
          filename
        );

      await fs.writeFile(

        destination,

        JSON.stringify(
          data,
          null,
          2
        ) + "\n",

        "utf8"

      );

      const database =
        await loadQuestionBanks();

      res.json({

        ok: true,

        filename,

        questionCount:
          result.questionCount,

        totalQuestions:
          database.totalQuestions

      });

    }

    catch (error) {

      console.error(
        "Import error:",
        error
      );

      res
        .status(500)
        .json({

          error:
            error.message ||
            "Could not import question bank."

        });

    }

  }
);

/* =======================================================
   PERFORMANCE API
======================================================= */

app.get(
  "/api/performance",
  async (_req, res) => {

    res.json(
      await readPerformance()
    );

  }
);

app.put(
  "/api/performance",
  async (req, res) => {

    try {

      if (
        !req.body ||
        typeof req.body !== "object" ||
        Array.isArray(req.body)
      ) {

        return res
          .status(400)
          .json({

            error:
              "Performance payload must be an object."

          });

      }

      await writePerformance(
        req.body
      );

      res.json({

        ok: true

      });

    }

    catch (error) {

      res
        .status(500)
        .json({

          error:
            error.message

        });

    }

  }
);

/* =======================================================
   RECORD ONE ANSWER
======================================================= */

app.post(
  "/api/performance/answer",
  async (req, res) => {

    try {

      const {
        questionId,
        answer,
        result,
        timestamp
      } = req.body || {};

      if (!questionId) {

        return res
          .status(400)
          .json({

            error:
              "questionId is required."

          });

      }

      if (
        ![
          "correct",
          "wrong",
          "unknown"
        ].includes(result)
      ) {

        return res
          .status(400)
          .json({

            error:
              "result must be correct, wrong or unknown."

          });

      }

      const database =
        await loadQuestionBanks();

      const question =
        flattenBanks(
          database
        ).find(
          q =>
            q.id === questionId
        );

      if (!question) {

        return res
          .status(404)
          .json({

            error:
              `Question "${questionId}" was not found.`

          });

      }

      const performance =
        await readPerformance();

      if (
        !performance[questionId]
      ) {

        performance[questionId] = {

          attempts: 0,

          correct: 0,

          wrong: 0,

          unknown: 0,

          streak: 0,

          mastery: 0,

          lastAttempted: null,

          nextReview: null,

          interval: 0,

          history: []

        };

      }

      const p =
        performance[
          questionId
        ];

      p.attempts += 1;

      /* -------------------------------------------
         CORRECT
      ------------------------------------------- */

      if (
        result === "correct"
      ) {

        p.correct += 1;

        p.streak += 1;

        const nextInterval = {

          0: 1,

          1: 3,

          3: 7,

          7: 14,

          14: 30,

          30: 30

        };

        p.interval =
          nextInterval[
            p.interval
          ] ?? 30;

        const next =
          new Date();

        next.setDate(
          next.getDate() +
          p.interval
        );

        p.nextReview =
          next
            .toISOString()
            .slice(
              0,
              10
            );

      }

      /* -------------------------------------------
         WRONG / UNKNOWN
      ------------------------------------------- */

      else {

        if (
          result === "wrong"
        ) {
          p.wrong += 1;
        }

        if (
          result === "unknown"
        ) {
          p.unknown += 1;
        }

        p.streak = 0;

        p.interval = 0;

        /*
         * Wrong and unknown questions
         * immediately become review items.
         */

        p.nextReview =
          today();

      }

      /* -------------------------------------------
         MASTERY
      ------------------------------------------- */

      const accuracy =
        p.correct /
        Math.max(
          1,
          p.attempts
        );

      const repetition =
        Math.min(
          1,
          p.streak / 5
        );

      p.mastery =
        Math.round(

          (
            accuracy * 0.7 +
            repetition * 0.3
          ) * 100

        );

      p.lastAttempted =
        timestamp ||
        new Date()
          .toISOString();

      /* -------------------------------------------
         HISTORY
      ------------------------------------------- */

      p.history.push({

        timestamp:
          p.lastAttempted,

        answer:
          answer || null,

        result,

        correctAnswer:
          question.answer

      });

      await writePerformance(
        performance
      );

      res.json({

        ok: true,

        questionId,

        performance:
          p

      });

    }

    catch (error) {

      console.error(
        "Answer event error:",
        error
      );

      res
        .status(500)
        .json({

          error:
            error.message

        });

    }

  }
);

/* =======================================================
   REVIEW API
======================================================= */

app.get(
  "/api/review",
  async (_req, res) => {

    const database =
      await loadQuestionBanks();

    const questions =
      flattenBanks(
        database
      );

    const performance =
      await readPerformance();

    const todayKey =
      today();

    const due =
      questions

        .map(
          question => ({

            question,

            performance:
              performance[
                question.id
              ] || null

          })
        )

        .filter(
          item =>

            item.performance?.nextReview &&

            item.performance.nextReview <=
              todayKey
        );

    res.json({

      today:
        todayKey,

      due,

      dueCount:
        due.length,

      overdueCount:

        due.filter(

          item =>
            item.performance
              .nextReview <
            todayKey

        ).length

    });

  }
);
/* =======================================================
   CALENDAR REVIEW API
======================================================= */

app.get("/api/review-calendar", async (_req, res) => {

  const database = await loadQuestionBanks();
  const questions = flattenBanks(database);
  const performance = await readPerformance();

  const calendar = {};

  questions.forEach(question => {

    const p = performance[question.id];

    if (!p || !p.nextReview) {
      return;
    }

    const date = p.nextReview;

    if (!calendar[date]) {
      calendar[date] = [];
    }

    calendar[date].push({
      subject: question.subject || "Uncategorised",
      topic: question.topic || "Uncategorised",
      questionId: question.id,
      recovery: Boolean(p.recovery)
    });

  });

  res.json({
    calendar
  });

});

/* =======================================================
   STATIC FILES
======================================================= */

app.use(
  express.static(ROOT)
);

app.get(
  "/",
  (_req, res) => {

    res.sendFile(
      path.join(
        ROOT,
        "index.html"
      )
    );

  }
);

/* =======================================================
   ERROR HANDLING
======================================================= */

app.use(
  (
    error,
    _req,
    res,
    _next
  ) => {

    console.error(
      error
    );

    res
      .status(500)
      .json({

        error:
          error.message ||
          "Internal server error."

      });

  }
);

/* =======================================================
   START SERVER
======================================================= */

async function start() {

  await ensureDirectories();

  const database =
    await loadQuestionBanks();

  app.listen(
    PORT,
    () => {

      console.log("");

      console.log(
        "========================================"
      );

      console.log(
        "       Flo's Study Space"
      );

      console.log(
        "========================================"
      );

      console.log(
        `       http://localhost:${PORT}`
      );

      console.log("");

      console.log(
        `       Question banks : ${database.files.length}`
      );

      console.log(
        `       Questions      : ${database.totalQuestions}`
      );

      console.log(
        `       Bank folder    : ${QUESTION_BANK_DIR}`
      );

      console.log("");

      if (
        database.errors.length
      ) {

        console.log(
          "       JSON warnings/errors:"
        );

        database.errors.forEach(
          error =>
            console.log(
              `       - ${error}`
            )
        );

        console.log("");

      }

      console.log(
        "       Server ready."
      );

      console.log(
        "========================================"
      );

      console.log("");

    }
  );

}

start().catch(
  error => {

    console.error(
      "Could not start Flo's Study Space:"
    );

    console.error(
      error
    );

    process.exit(1);

  }
);