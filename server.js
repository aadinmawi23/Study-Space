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

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
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

async function getAuthenticatedUser(req) {
  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    return null;
  }

  const accessToken = authHeader.slice(7);

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Supabase configuration is missing.");
  }

  const supabase = createClient(
    supabaseUrl,
    supabaseKey
  );

  const {
    data: { user },
    error
  } = await supabase.auth.getUser(accessToken);

  if (error || !user) {
    return null;
  }

  return user;
}

async function getUserSupabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Supabase configuration is missing.");
  }

  return createClient(
    supabaseUrl,
    supabaseKey
  );
}

function requireAuthenticatedUser(user, res) {
  if (!user) {
    res.status(401).json({
      error: "Authentication required."
    });
    return false;
  }

  return true;
}



app.get("/api/supabase-config", (_req, res) => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    return res.status(500).json({
      error: "Supabase configuration is missing."
    });
  }

  res.json({
    url,
    key
  });
});

app.use(express.urlencoded({ extended: true }));

/* =======================================================
   GOOGLE OAUTH DISCONNECT
   Revokes the Google provider token before Supabase logout.
======================================================= */

app.post("/api/google/revoke", async (req, res) => {

  try {

    const providerToken =
      String(req.body?.providerToken || "").trim();

    if (!providerToken) {
      return res.json({
        ok: true,
        revoked: false,
        message: "No Google provider token was available."
      });
    }

    const revokeResponse =
      await fetch(
        "https://oauth2.googleapis.com/revoke",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/x-www-form-urlencoded"
          },

          body:
            `token=${encodeURIComponent(providerToken)}`
        }
      );

    /*
      Google normally returns HTTP 200 after a successful
      revocation. A 400 can also mean that the token has
      already been revoked or is no longer valid.
    */

    if (
      !revokeResponse.ok &&
      revokeResponse.status !== 400
    ) {

      const details =
        await revokeResponse.text();

      console.error(
        "Google token revocation failed:",
        details
      );

      return res.status(502).json({
        ok: false,
        revoked: false,
        error:
          "Google token could not be revoked."
      });

    }

    return res.json({
      ok: true,
      revoked: true
    });

  } catch (error) {

    console.error(
      "Google revoke error:",
      error
    );

    /*
      Logout should still be allowed even if Google's
      revoke endpoint is temporarily unavailable.
    */

    return res.status(200).json({
      ok: false,
      revoked: false,
      error:
        error.message ||
        "Google revoke request failed."
    });

  }

});



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
   TWO-PLAYER CHALLENGE ROOM API
======================================================= */

app.get(
  "/api/challenge-rooms",
  async (req, res) => {

    try {

      const user =
        await getAuthenticatedUser(req);

      if (!requireAuthenticatedUser(user, res)) {
        return;
      }

      const supabase =
        await getUserSupabaseClient();

      const {
        data,
        error
      } = await supabase
        .from("challenge_rooms")
        .select("*")
        .or(
          `host_user_id.eq.${user.id},guest_user_id.eq.${user.id}`
        )
        .neq("status", "completed")
        .order(
          "updated_at",
          {
            ascending: false
          }
        );

      if (error) {
        throw error;
      }

      res.json(data || []);

    }

    catch (error) {

      console.error(
        "Challenge rooms load error:",
        error
      );

      res
        .status(500)
        .json({
          error:
            error.message ||
            "Could not load challenge rooms."
        });

    }

  }
);


app.get(
  "/api/challenge-rooms/:roomCode",
  async (req, res) => {

    try {

      const user =
        await getAuthenticatedUser(req);

      if (!requireAuthenticatedUser(user, res)) {
        return;
      }

      const roomCode =
        String(
          req.params.roomCode || ""
        )
        .trim()
        .toUpperCase();

      if (!roomCode) {

        return res
          .status(400)
          .json({
            error:
              "roomCode is required."
          });

      }

      const supabase =
        await getUserSupabaseClient();

      const {
        data,
        error
      } = await supabase
        .from("challenge_rooms")
        .select("*")
        .eq("room_code", roomCode)
        .or(
          `host_user_id.eq.${user.id},guest_user_id.eq.${user.id}`
        )
        .maybeSingle();

      if (error) {
        throw error;
      }

      if (!data) {

        return res
          .status(404)
          .json({
            error:
              "Challenge room not found."
          });

      }

      res.json(data);

    }

    catch (error) {

      console.error(
        "Challenge room load error:",
        error
      );

      res
        .status(500)
        .json({
          error:
            error.message ||
            "Could not load challenge room."
        });

    }

  }
);


app.post(
  "/api/challenge-rooms",
  async (req, res) => {

    try {

      const user =
        await getAuthenticatedUser(req);

      if (!requireAuthenticatedUser(user, res)) {
        return;
      }

      const {
        roomCode,
        hostUsername,
        subjectName,
        topic,
        questionIds
      } = req.body || {};

      if (
        !roomCode ||
        !hostUsername ||
        !subjectName ||
        !topic ||
        !Array.isArray(questionIds) ||
        !questionIds.length
      ) {

        return res
          .status(400)
          .json({
            error:
              "roomCode, hostUsername, subjectName, topic and questionIds are required."
          });

      }

      const supabase =
        await getUserSupabaseClient();

      const {
        data,
        error
      } = await supabase
        .from("challenge_rooms")
        .insert({

          room_code:
            String(roomCode)
              .trim()
              .toUpperCase(),

          host_user_id:
            user.id,

          host_username:
            String(hostUsername)
              .trim(),

          subject_name:
            String(subjectName),

          topic:
            String(topic),

          question_ids:
            questionIds,

          status:
            "waiting",

          last_host_seen_at:
            new Date().toISOString()

        })
        .select("*")
        .single();

      if (error) {
        throw error;
      }

      res
        .status(201)
        .json(data);

    }

    catch (error) {

      console.error(
        "Challenge room creation error:",
        error
      );

      res
        .status(500)
        .json({
          error:
            error.message ||
            "Could not create challenge room."
        });

    }

  }
);


app.post(
  "/api/challenge-rooms/:roomCode/join",
  async (req, res) => {

    try {

      const user =
        await getAuthenticatedUser(req);

      if (!requireAuthenticatedUser(user, res)) {
        return;
      }

      const roomCode =
        String(
          req.params.roomCode || ""
        )
        .trim()
        .toUpperCase();

      const {
        guestUsername
      } = req.body || {};

      if (!roomCode || !guestUsername) {

        return res
          .status(400)
          .json({
            error:
              "roomCode and guestUsername are required."
          });

      }

      const supabase =
        await getUserSupabaseClient();

      const {
        data: room,
        error: loadError
      } = await supabase
        .from("challenge_rooms")
        .select("*")
        .eq("room_code", roomCode)
        .maybeSingle();

      if (loadError) {
        throw loadError;
      }

      if (!room) {

        return res
          .status(404)
          .json({
            error:
              "Challenge room not found."
          });

      }

      if (room.host_user_id === user.id) {

        return res
          .status(400)
          .json({
            error:
              "You cannot join your own room as the second player."
          });

      }

      if (
        room.guest_user_id &&
        room.guest_user_id !== user.id
      ) {

        return res
          .status(409)
          .json({
            error:
              "This room already has two players."
          });

      }

      const {
        data,
        error
      } = await supabase
        .from("challenge_rooms")
        .update({

          guest_user_id:
            user.id,

          guest_username:
            String(guestUsername)
              .trim(),

          last_guest_seen_at:
            new Date().toISOString(),

          updated_at:
            new Date().toISOString()

        })
        .eq(
          "room_code",
          roomCode
        )
        .select("*")
        .single();

      if (error) {
        throw error;
      }

      res.json(data);

    }

    catch (error) {

      console.error(
        "Challenge room join error:",
        error
      );

      res
        .status(500)
        .json({
          error:
            error.message ||
            "Could not join challenge room."
        });

    }

  }
);


app.put(
  "/api/challenge-rooms/:roomCode",
  async (req, res) => {

    try {

      const user =
        await getAuthenticatedUser(req);

      if (!requireAuthenticatedUser(user, res)) {
        return;
      }

      const roomCode =
        String(
          req.params.roomCode || ""
        )
        .trim()
        .toUpperCase();

      const supabase =
        await getUserSupabaseClient();

      const {
        data: existingRoom,
        error: loadError
      } = await supabase
        .from("challenge_rooms")
        .select("*")
        .eq("room_code", roomCode)
        .or(
          `host_user_id.eq.${user.id},guest_user_id.eq.${user.id}`
        )
        .maybeSingle();

      if (loadError) {
        throw loadError;
      }

      if (!existingRoom) {

        return res
          .status(404)
          .json({
            error:
              "Challenge room not found."
          });

      }

      const body =
        req.body || {};

      const isHost =
        existingRoom.host_user_id === user.id;

      const updates = {

        status:
          body.status ??
          existingRoom.status,

        current_index:
          Number.isInteger(body.currentIndex)
            ? body.currentIndex
            : existingRoom.current_index,

        host_ready:
          typeof body.hostReady === "boolean"
            ? body.hostReady
            : existingRoom.host_ready,

        guest_ready:
          typeof body.guestReady === "boolean"
            ? body.guestReady
            : existingRoom.guest_ready,

        host_answers:
          body.hostAnswers ??
          existingRoom.host_answers,

        guest_answers:
          body.guestAnswers ??
          existingRoom.guest_answers,

        host_score:
          Number.isFinite(body.hostScore)
            ? body.hostScore
            : existingRoom.host_score,

        guest_score:
          Number.isFinite(body.guestScore)
            ? body.guestScore
            : existingRoom.guest_score,

        host_correct:
          Number.isFinite(body.hostCorrect)
            ? body.hostCorrect
            : existingRoom.host_correct,

        guest_correct:
          Number.isFinite(body.guestCorrect)
            ? body.guestCorrect
            : existingRoom.guest_correct,

        updated_at:
          new Date().toISOString()

      };

      if (isHost) {

        updates.last_host_seen_at =
          new Date().toISOString();

      } else {

        updates.last_guest_seen_at =
          new Date().toISOString();

      }

      const {
        data,
        error
      } = await supabase
        .from("challenge_rooms")
        .update(updates)
        .eq(
          "room_code",
          roomCode
        )
        .select("*")
        .single();

      if (error) {
        throw error;
      }

      res.json(data);

    }

    catch (error) {

      console.error(
        "Challenge room save error:",
        error
      );

      res
        .status(500)
        .json({
          error:
            error.message ||
            "Could not save challenge room."
        });

    }

  }
);


app.post(
  "/api/challenge-rooms/:roomCode/leave",
  async (req, res) => {

    try {

      const user =
        await getAuthenticatedUser(req);

      if (!requireAuthenticatedUser(user, res)) {
        return;
      }

      const roomCode =
        String(
          req.params.roomCode || ""
        )
        .trim()
        .toUpperCase();

      const supabase =
        await getUserSupabaseClient();

      const {
        data: room,
        error: loadError
      } = await supabase
        .from("challenge_rooms")
        .select("*")
        .eq("room_code", roomCode)
        .or(
          `host_user_id.eq.${user.id},guest_user_id.eq.${user.id}`
        )
        .maybeSingle();

      if (loadError) {
        throw loadError;
      }

      if (!room) {

        return res
          .status(404)
          .json({
            error:
              "Challenge room not found."
          });

      }

      const isHost =
        room.host_user_id === user.id;

      const updates = {

        updated_at:
          new Date().toISOString()

      };

      if (isHost) {

        updates.host_ready = false;
        updates.last_host_seen_at =
          new Date().toISOString();

      } else {

        updates.guest_ready = false;
        updates.last_guest_seen_at =
          new Date().toISOString();

      }

      const {
        data,
        error
      } = await supabase
        .from("challenge_rooms")
        .update(updates)
        .eq(
          "room_code",
          roomCode
        )
        .select("*")
        .single();

      if (error) {
        throw error;
      }

      res.json(data);

    }

    catch (error) {

      console.error(
        "Challenge room leave error:",
        error
      );

      res
        .status(500)
        .json({
          error:
            error.message ||
            "Could not leave challenge room."
        });

    }

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
  async (req, res) => {

    try {

      const user =
        await getAuthenticatedUser(req);

      if (!requireAuthenticatedUser(user, res)) {
        return;
      }

      const supabase =
        await getUserSupabaseClient();

      const {
        data,
        error
      } = await supabase
        .from("question_performance")
        .select("*")
        .eq("user_id", user.id);

      if (error) {
        throw error;
      }

      const performance = {};

      (data || []).forEach(row => {

        performance[row.question_id] = {

          attempts: row.attempts,
          correct: row.correct,
          wrong: row.wrong,
          unknown: row.unknown,
          streak: row.streak,
          mastery: row.mastery,
          lastAttempted: row.last_attempted,
          nextReview: row.next_review,
          interval: row.interval,
          normalInterval: row.normal_interval,
          normalNextReview: row.normal_next_review,
          recovery: row.recovery,
          history: row.history || []

        };

      });

      res.json(performance);

    }

    catch (error) {

      console.error(
        "Performance load error:",
        error
      );

      res
        .status(500)
        .json({
          error:
            error.message ||
            "Could not load performance."
        });

    }

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

      const user =
        await getAuthenticatedUser(req);

      if (!requireAuthenticatedUser(user, res)) {
        return;
      }

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

      const supabase =
        await getUserSupabaseClient();

      const {
        data: existingRow,
        error: loadError
      } = await supabase
        .from("question_performance")
        .select("*")
        .eq("user_id", user.id)
        .eq("question_id", questionId)
        .maybeSingle();

      if (loadError) {
        throw loadError;
      }

      const performance = {};

      if (existingRow) {

        performance[questionId] = {

          attempts: existingRow.attempts,
          correct: existingRow.correct,
          wrong: existingRow.wrong,
          unknown: existingRow.unknown,
          streak: existingRow.streak,
          mastery: existingRow.mastery,
          lastAttempted: existingRow.last_attempted,
          nextReview: existingRow.next_review,
          interval: existingRow.interval,
          normalInterval: existingRow.normal_interval,
          normalNextReview: existingRow.normal_next_review,
          recovery: existingRow.recovery,
          history: existingRow.history || []

        };

      }

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

          normalInterval: 0,

          normalNextReview: null,

          recovery: false,

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
         NORMAL REVIEW SCHEDULE

         3 days
         1 week
         2 weeks
         3 weeks
         4 weeks
         monthly
      ------------------------------------------- */

      if (
        result === "correct"
      ) {

        p.correct += 1;

        p.streak += 1;

        /*
         * Recovery questions return to the
         * normal review schedule they were
         * following before becoming unlearnt.
         */

        if (p.recovery) {

          p.recovery = false;

          /*
           * The question has been learnt again.
           * Resume its normal review progression
           * from the interval it had before recovery.
           */

          const nextInterval = {

            0: 3,

            3: 7,

            7: 14,

            14: 21,

            21: 28,

            28: 30,

            30: 30

          };

          p.interval =
            nextInterval[
              p.normalInterval || 0
            ] ?? 3;

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

          p.normalInterval =
            p.interval;

          p.normalNextReview =
            p.nextReview;

        }

        else {

          const nextInterval = {

            0: 3,

            3: 7,

            7: 14,

            14: 21,

            21: 28,

            28: 30,

            30: 30

          };

          p.interval =
            nextInterval[
              p.interval
            ] ?? 3;

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

          p.normalInterval =
            p.interval;

          p.normalNextReview =
            p.nextReview;

        }

      }

      /* -------------------------------------------
         WRONG / UNKNOWN

         Always return tomorrow.

         Repeated failure keeps the question
         in next-day recovery until it is learnt.
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

        /*
         * Preserve the normal topic schedule
         * before entering next-day recovery.
         */
        if (!p.recovery) {

          p.normalInterval =
            p.interval || 3;

          p.normalNextReview =
            p.nextReview || null;

        }

        /*
         * Mark this question as recovery.
         * It will be reviewed tomorrow.
         */
        p.recovery = true;

        p.interval = 0;

        const tomorrow =
          new Date();

        tomorrow.setDate(
          tomorrow.getDate() + 1
        );

        p.nextReview =
          tomorrow
            .toISOString()
            .slice(
              0,
              10
            );

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

      const {
        error: saveError
      } = await supabase
        .from("question_performance")
        .upsert({
          user_id: user.id,
          question_id: questionId,
          attempts: p.attempts,
          correct: p.correct,
          wrong: p.wrong,
          unknown: p.unknown,
          streak: p.streak,
          mastery: p.mastery,
          last_attempted: p.lastAttempted,
          next_review: p.nextReview,
          interval: p.interval,
          normal_interval: p.normalInterval,
          normal_next_review: p.normalNextReview,
          recovery: p.recovery,
          history: p.history,
          updated_at: new Date().toISOString()
        });

      if (saveError) {
        throw saveError;
      }

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
  async (req, res) => {

    try {

      const user =
        await getAuthenticatedUser(req);

      if (!requireAuthenticatedUser(user, res)) {
        return;
      }

      const database =
        await loadQuestionBanks();

      const questions =
        flattenBanks(
          database
        );

      const supabase =
        await getUserSupabaseClient();

      const {
        data,
        error
      } = await supabase
        .from("question_performance")
        .select("*")
        .eq("user_id", user.id);

      if (error) {
        throw error;
      }

      const performance = {};

      (data || []).forEach(row => {

        performance[row.question_id] = {

          attempts: row.attempts,
          correct: row.correct,
          wrong: row.wrong,
          unknown: row.unknown,
          streak: row.streak,
          mastery: row.mastery,
          lastAttempted: row.last_attempted,
          nextReview: row.next_review,
          interval: row.interval,
          normalInterval: row.normal_interval,
          normalNextReview: row.normal_next_review,
          recovery: row.recovery,
          history: row.history || []

        };

      });

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

    catch (error) {

      console.error(
        "Review error:",
        error
      );

      res
        .status(500)
        .json({

          error:
            error.message ||
            "Could not load review data."

        });

    }

  }
);

/* =======================================================
   CALENDAR REVIEW API
======================================================= */

app.get(
  "/api/review-calendar",
  async (req, res) => {

    try {

      const user =
        await getAuthenticatedUser(req);

      if (!requireAuthenticatedUser(user, res)) {
        return;
      }

      const database =
        await loadQuestionBanks();

      const questions =
        flattenBanks(
          database
        );

      const supabase =
        await getUserSupabaseClient();

      const {
        data,
        error
      } = await supabase
        .from("question_performance")
        .select("*")
        .eq("user_id", user.id);

      if (error) {
        throw error;
      }

      const performance = {};

      (data || []).forEach(row => {

        performance[row.question_id] = {

          attempts: row.attempts,
          correct: row.correct,
          wrong: row.wrong,
          unknown: row.unknown,
          streak: row.streak,
          mastery: row.mastery,
          lastAttempted: row.last_attempted,
          nextReview: row.next_review,
          interval: row.interval,
          normalInterval: row.normal_interval,
          normalNextReview: row.normal_next_review,
          recovery: row.recovery,
          history: row.history || []

        };

      });

      const calendar = {};

    /*
     * Group questions by topic and subject.
     * Each question contributes its current
     * review date to the calendar.
     */

    questions.forEach(question => {

      const p =
        performance[
          question.id
        ];

      if (!p || !p.nextReview) {
        return;
      }

      const date =
        p.nextReview;

      if (!calendar[date]) {
        calendar[date] = [];
      }

      calendar[date].push({

        subject:
          question.subject || "Uncategorised",

        topic:
          question.topic || "Uncategorised",

        questionId:
          question.id,

        recovery:
          Boolean(p.recovery)

      });

    });

    res.json({
      calendar
    });

    }

    catch (error) {

      console.error(
        "Review calendar error:",
        error
      );

      res
        .status(500)
        .json({
          error:
            error.message ||
            "Could not load review calendar."
        });

    }

  }
);

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