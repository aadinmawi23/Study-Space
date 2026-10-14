(function () {
  "use strict";

  const state = {
    screen: "lobby",
    roomCode: "",
    playerName: "You",
    playerCount: 2,
    subject: "",
    topic: "",
    selectedAnswer: null,
    dice: null,
    questionIndex: 0
  };

  const colours = [
    { key: "red", name: "Coral", hex: "#d17978" },
    { key: "blue", name: "Blue", hex: "#709bc4" },
    { key: "green", name: "Sage", hex: "#77a686" },
    { key: "yellow", name: "Gold", hex: "#d6b04f" }
  ];

  function getBanks() {
    try {
      if (typeof banks !== "undefined" && Array.isArray(banks)) return banks;
    } catch (_) {}
    return Array.isArray(window.questionBanks) ? window.questionBanks : [];
  }

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
  }

  function unique(values) {
    return [...new Set(values.filter(value => typeof value === "string" && value.trim()))]
      .sort((a, b) => a.localeCompare(b));
  }

  function getSubjects() {
    return unique(getBanks().map(bank => bank.subject));
  }

  function getTopics(subject) {
    return unique(getBanks()
      .filter(bank => bank.subject === subject)
      .map(bank => bank.topic));
  }

  function selectedBank() {
    return getBanks().find(bank =>
      bank.subject === state.subject && bank.topic === state.topic
    );
  }

  function pageHeader(eyebrow, title, description, badge = "PRIVATE ROOMS") {
    return `
      <div class="ludo-topline">
        <div>
          <div class="ludo-eyebrow">${eyebrow}</div>
          <h1 class="ludo-heading">${title}</h1>
          <p class="ludo-subtitle">${description}</p>
        </div>
        <span class="ludo-pill">${badge}</span>
      </div>`;
  }

  function rulesPanel() {
    return `
      <section class="ludo-card">
        <div class="ludo-eyebrow">HOW TO PLAY</div>
        <h3>A little strategy. A little studying.</h3>
        <p class="ludo-muted">Classic Ludo movement, with study questions woven into each turn.</p>
        <div class="ludo-feature-list">
          <div class="ludo-feature"><div class="ludo-feature-mark">🎲</div><div><strong>Roll to move</strong><span>Roll a six to bring a token out of base. Choose which token to move when you have options.</span></div></div>
          <div class="ludo-feature"><div class="ludo-feature-mark">✎</div><div><strong>Answer to earn your move</strong><span>Answer the selected subject and topic question correctly to make the move. A wrong answer forfeits the turn.</span></div></div>
          <div class="ludo-feature"><div class="ludo-feature-mark">↗</div><div><strong>Capture and race home</strong><span>Capture opponents on eligible squares, use safe squares, and bring all four tokens home first.</span></div></div>
        </div>
        <div class="ludo-page-note">Rooms are designed for 2–4 players. The question picker uses the topics in your loaded question banks.</div>
      </section>`;
  }

  function renderLobby() {
    const subjectOptions = getSubjects();
    const firstSubject = state.subject || subjectOptions[0] || "";
    if (firstSubject !== state.subject) state.subject = firstSubject;
    const topics = getTopics(state.subject);
    if (!topics.includes(state.topic)) state.topic = topics[0] || "";

    return `
      <div class="ludo-page">
        ${pageHeader("THE STUDY ARCADE", "Ludo, but make it learning.", "Invite your people into a private room. Roll the dice, answer questions, and race your tokens home.")}
        <div class="ludo-layout">
          <section class="ludo-card">
            <div class="ludo-eyebrow">YOUR NEXT MATCH</div>
            <h3>Where shall we play?</h3>
            <p class="ludo-muted">Create a private room for your group or enter a room code you've been given.</p>
            <div class="ludo-choice-grid">
              <button class="ludo-choice" onclick="ludoOpen('create')">
                <div class="ludo-choice-icon">＋</div>
                <strong>Create a room</strong>
                <span>Host a private match and share its room code.</span>
              </button>
              <button class="ludo-choice" onclick="ludoOpen('join')">
                <div class="ludo-choice-icon">↗</div>
                <strong>Join a room</strong>
                <span>Have a code? Enter it to join your friends.</span>
              </button>
            </div>
            <div class="ludo-field">
              <label for="ludoSubject">QUESTION SUBJECT</label>
              <select id="ludoSubject" onchange="ludoSubjectChanged(this.value)" ${subjectOptions.length ? "" : "disabled"}>
                ${subjectOptions.length
                  ? subjectOptions.map(subject => `<option value="${escapeHTML(subject)}" ${subject === state.subject ? "selected" : ""}>${escapeHTML(subject)}</option>`).join("")
                  : `<option value="">No loaded question banks found</option>`}
              </select>
            </div>
            <div class="ludo-field">
              <label for="ludoTopic">QUESTION TOPIC</label>
              <select id="ludoTopic" onchange="ludoSetTopic(this.value)" ${topics.length ? "" : "disabled"}>
                ${topics.length
                  ? topics.map(topic => `<option value="${escapeHTML(topic)}" ${topic === state.topic ? "selected" : ""}>${escapeHTML(topic)}</option>`).join("")
                  : `<option value="">No topics available</option>`}
              </select>
            </div>
            <div class="ludo-page-note">${selectedBank()
              ? `${selectedBank().questions?.length || 0} questions available in this topic. Questions should be shuffled without repeats within a match.`
              : "Load question banks on the dashboard to select a subject and topic here."}</div>
          </section>
          ${rulesPanel()}
        </div>
      </div>`;
  }

  function renderCreate() {
    const subjects = getSubjects();
    const topics = getTopics(state.subject);
    return `
      <div class="ludo-page">
        <button class="ludo-page-back" onclick="ludoOpen('lobby')">← Back to Ludo</button>
        ${pageHeader("NEW PRIVATE MATCH", "Set up your room.", "Choose your match settings. You can invite 1–3 other players.")}
        <div class="ludo-layout">
          <section class="ludo-card">
            <div class="ludo-eyebrow">ROOM SETTINGS</div>
            <h3>Host a match</h3>
            <div class="ludo-field"><label for="ludoPlayerName">YOUR DISPLAY NAME</label><input id="ludoPlayerName" maxlength="24" value="${escapeHTML(state.playerName)}" placeholder="Enter your name"></div>
            <div class="ludo-field"><label for="ludoPlayerCount">PLAYERS</label><select id="ludoPlayerCount" onchange="ludoSetPlayerCount(this.value)">${[2,3,4].map(n => `<option value="${n}" ${n === state.playerCount ? "selected" : ""}>${n} players</option>`).join("")}</select></div>
            <div class="ludo-field"><label for="ludoCreateSubject">QUESTION SUBJECT</label><select id="ludoCreateSubject" onchange="ludoSubjectChanged(this.value)">${subjects.length ? subjects.map(s => `<option value="${escapeHTML(s)}" ${s === state.subject ? "selected" : ""}>${escapeHTML(s)}</option>`).join("") : `<option value="">No question banks loaded</option>`}</select></div>
            <div class="ludo-field"><label for="ludoCreateTopic">QUESTION TOPIC</label><select id="ludoCreateTopic" onchange="ludoSetTopic(this.value)">${topics.length ? topics.map(t => `<option value="${escapeHTML(t)}" ${t === state.topic ? "selected" : ""}>${escapeHTML(t)}</option>`).join("") : `<option value="">No topics available</option>`}</select></div>
            <div class="ludo-actions"><button class="ludo-button" onclick="ludoCreateRoom()">Create private room</button><button class="ludo-button secondary" onclick="ludoOpen('lobby')">Cancel</button></div>
            <p class="ludo-muted" style="margin-top:14px">Room creation on this screen is currently a local visual prototype; online room hosting will be connected in the multiplayer phase.</p>
          </section>
          ${rulesPanel()}
        </div>
      </div>`;
  }

  function renderJoin() {
    return `
      <div class="ludo-page">
        <button class="ludo-page-back" onclick="ludoOpen('lobby')">← Back to Ludo</button>
        ${pageHeader("JOIN YOUR GROUP", "Enter a room code.", "Private rooms are accessed by code. Ask the host to share theirs with you.")}
        <div class="ludo-layout">
          <section class="ludo-card">
            <div class="ludo-eyebrow">ROOM ACCESS</div>
            <h3>Meet you at the board.</h3>
            <div class="ludo-field"><label for="ludoJoinName">YOUR DISPLAY NAME</label><input id="ludoJoinName" maxlength="24" value="${escapeHTML(state.playerName)}" placeholder="Enter your name"></div>
            <div class="ludo-field"><label for="ludoJoinCode">ROOM CODE</label><input id="ludoJoinCode" class="ludo-code-input" maxlength="6" placeholder="ABC123" autocomplete="off" oninput="this.value=this.value.toUpperCase().replace(/[^A-Z0-9]/g,'')"></div>
            <div class="ludo-actions"><button class="ludo-button" onclick="ludoJoinRoom()">Continue</button><button class="ludo-button secondary" onclick="ludoOpen('lobby')">Cancel</button></div>
            <p id="ludoJoinMessage" class="ludo-muted" style="margin-top:14px">Online room-code validation will be connected in the multiplayer phase.</p>
          </section>
          ${rulesPanel()}
        </div>
      </div>`;
  }

  function boardCell(row, col) {
    const isIn = (r1, c1, r2, c2) => row >= r1 && row <= r2 && col >= c1 && col <= c2;
    let cls = "ludo-cell";
    if (isIn(0,0,5,5)) cls += " home-red";
    else if (isIn(0,9,5,14)) cls += " home-green";
    else if (isIn(9,0,14,5)) cls += " home-blue";
    else if (isIn(9,9,14,14)) cls += " home-yellow";

    const track = (row >= 6 && row <= 8) || (col >= 6 && col <= 8);
    if (track && !((row >= 6 && row <= 8) && (col >= 6 && col <= 8))) cls += " track";
    if ((row === 7 && col === 1) || (row === 1 && col === 7) || (row === 7 && col === 13) || (row === 13 && col === 7)) cls += " safe";

    const lane =
      (col === 7 && row >= 1 && row <= 5) ? " lane-green" :
      (row === 7 && col >= 9 && col <= 13) ? " lane-yellow" :
      (col === 7 && row >= 9 && row <= 13) ? " lane-blue" :
      (row === 7 && col >= 1 && col <= 5) ? " lane-red" : "";
    cls += lane;

    let content = "";
    if (row === 7 && col === 7) content = `<div class="ludo-centre">F1</div>`;
    else if (row === 0 && col === 0) content = yard("red");
    else if (row === 0 && col === 9) content = yard("green");
    else if (row === 9 && col === 0) content = yard("blue");
    else if (row === 9 && col === 9) content = yard("yellow");

    return `<div class="${cls}">${content}</div>`;
  }

  function yard(colour) {
    return `<div class="ludo-yard">${[1,2,3,4].map(() => `<span class="ludo-token ${colour}"></span>`).join("")}</div>`;
  }

  function renderGame() {
    const players = Array.from({length: state.playerCount}, (_, i) => ({
      name: i === 0 ? (state.playerName || "You") : `Player ${i + 1}`,
      colour: colours[i]
    }));
    const bank = selectedBank();
    const qs = bank?.questions || [];
    const q = qs.length ? qs[state.questionIndex % qs.length] : null;
    const questionText = q?.question || q?.text || q?.prompt || "Your selected topic's questions will appear here when the quiz bank format is connected.";
    const options = Array.isArray(q?.options) ? q.options : Array.isArray(q?.choices) ? q.choices : [];
    return `
      <div class="ludo-page">
        <button class="ludo-page-back" onclick="ludoOpen('lobby')">← Leave preview</button>
        <div class="ludo-game-header">
          <div><div class="ludo-eyebrow">PRIVATE ROOM</div><h1 class="ludo-heading" style="font-size:34px;margin:0">Ludo match</h1><div class="ludo-muted">${escapeHTML(state.subject || "Study questions")} · ${escapeHTML(state.topic || "Choose a topic")}</div></div>
          <div class="ludo-room-code"><span>ROOM CODE</span><strong>${escapeHTML(state.roomCode)}</strong><button class="ludo-button secondary" style="padding:8px 10px" onclick="ludoCopyCode()">Copy</button></div>
        </div>
        <div class="ludo-game-layout">
          <section>
            <div class="ludo-board-shell"><div class="ludo-board">${Array.from({length:225}, (_, i) => boardCell(Math.floor(i/15), i%15)).join("")}</div></div>
            <p class="ludo-muted ludo-mobile-hint" style="margin:10px 3px">Board preview: the full playable token track and movement logic will be added next.</p>
            <div class="ludo-player-list">${players.map((p,i) => `<div class="ludo-player"><span class="ludo-player-dot" style="background:${p.colour.hex}"></span><div class="ludo-player-info"><strong>${escapeHTML(p.name)}</strong><span>${p.colour.name} tokens · 0 home</span></div>${i === 0 ? `<span class="ludo-turn">YOUR TURN</span>` : `<span class="ludo-muted">Waiting</span>`}</div>`).join("")}</div>
          </section>
          <section class="ludo-card">
            <div class="ludo-eyebrow">YOUR TURN</div><h3>Roll, think, move.</h3><p class="ludo-muted">Answer a question to earn your move. Sixes earn a bonus turn in the full rules.</p>
            <div class="ludo-dice-row"><div id="ludoDie" class="ludo-die">${state.dice || "⚄"}</div><div class="ludo-dice-copy"><strong>${state.dice ? `You rolled ${state.dice}` : "Ready to roll?"}</strong><span>Dice interaction preview</span></div><button class="ludo-button" onclick="ludoRoll()">Roll dice</button></div>
            <div class="ludo-question"><div class="ludo-question-tag">STUDY QUESTION · ${escapeHTML(state.topic || "TOPIC")}</div><h4>${escapeHTML(questionText)}</h4>
              <div class="ludo-answer-list">${options.length ? options.map((option,i) => `<button class="ludo-answer ${state.selectedAnswer === i ? "selected" : ""}" onclick="ludoSelectAnswer(${i})"><span class="ludo-answer-key">${String.fromCharCode(65+i)}</span>${escapeHTML(typeof option === "string" ? option : option.text || option.label || JSON.stringify(option))}</button>`).join("") : `<p class="ludo-muted">The question renderer will adapt to your bank's answer format during the game-logic phase.</p>`}</div>
              <div class="ludo-actions"><button class="ludo-button" onclick="ludoSubmitAnswer()" ${state.selectedAnswer === null ? "disabled" : ""}>Submit answer</button></div>
              <div id="ludoGameStatus" class="ludo-game-status">This is a visual preview. Moves are not yet synchronised across players.</div>
            </div>
          </section>
        </div>
      </div>`;
  }

  function root() {
    return document.getElementById("main");
  }

  window.renderLudoPage = function () {
    const el = root();
    if (!el) return;
    if (state.screen === "create") el.innerHTML = renderCreate();
    else if (state.screen === "join") el.innerHTML = renderJoin();
    else if (state.screen === "game") el.innerHTML = renderGame();
    else el.innerHTML = renderLobby();
  };

  window.ludoOpen = function (screen) {
    state.screen = screen;
    if (typeof floPageHistory !== "undefined" && floCurrentPage() !== "ludo") {
      floPageHistory.push(floCurrentPage());
    }
    if (typeof history !== "undefined") history.replaceState({}, "", "#ludo");
    window.renderLudoPage();
    document.querySelectorAll("[data-page]").forEach(button => {
      button.classList.toggle("active", button.dataset.page === "ludo");
    });
  };

  window.ludoSubjectChanged = function (subject) {
    state.subject = subject;
    state.topic = getTopics(subject)[0] || "";
    window.renderLudoPage();
  };

  window.ludoSetTopic = function (topic) {
    state.topic = topic;
  };

  window.ludoSetPlayerCount = function (count) {
    state.playerCount = Math.max(2, Math.min(4, Number(count) || 2));
  };

  window.ludoCreateRoom = function () {
    const name = document.getElementById("ludoPlayerName")?.value.trim();
    if (!name) { alert("Enter your display name first."); return; }
    if (!state.subject || !state.topic) { alert("Choose a subject and topic with loaded questions."); return; }
    state.playerName = name;
    state.roomCode = Math.random().toString(36).slice(2, 8).toUpperCase();
    state.screen = "game";
    state.dice = null;
    state.selectedAnswer = null;
    state.questionIndex = 0;
    window.renderLudoPage();
  };

  window.ludoJoinRoom = function () {
    const name = document.getElementById("ludoJoinName")?.value.trim();
    const code = document.getElementById("ludoJoinCode")?.value.trim().toUpperCase();
    const message = document.getElementById("ludoJoinMessage");
    if (!name || !code || code.length !== 6) {
      if (message) message.textContent = "Enter your name and a six-character room code.";
      return;
    }
    if (message) message.textContent = "Room-code validation is not connected yet. Joining online rooms will be implemented in the multiplayer phase.";
  };

  window.ludoCopyCode = async function () {
    try {
      await navigator.clipboard.writeText(state.roomCode);
      const status = document.getElementById("ludoGameStatus");
      if (status) status.textContent = "Room code copied.";
    } catch (_) {
      alert("Room code: " + state.roomCode);
    }
  };

  window.ludoRoll = function () {
    state.dice = Math.floor(Math.random() * 6) + 1;
    const die = document.getElementById("ludoDie");
    if (die) die.textContent = ["⚀","⚁","⚂","⚃","⚄","⚅"][state.dice - 1];
    const status = document.getElementById("ludoGameStatus");
    if (status) status.textContent = `You rolled ${state.dice}. Answer the question to earn your move.`;
  };

  window.ludoSelectAnswer = function (index) {
    state.selectedAnswer = index;
    const gameStatus = document.getElementById("ludoGameStatus");
    document.querySelectorAll(".ludo-answer").forEach((button, i) => button.classList.toggle("selected", i === index));
    if (gameStatus) gameStatus.textContent = "Answer selected. Submit when ready.";
    const submit = document.querySelector(".ludo-question .ludo-button");
    if (submit) submit.disabled = false;
  };

  window.ludoSubmitAnswer = function () {
    const status = document.getElementById("ludoGameStatus");
    if (status) status.textContent = "Answer submission is a visual placeholder. Correct-answer checking, token selection and valid movement are the next implementation step.";
    state.questionIndex++;
    state.selectedAnswer = null;
    const bank = selectedBank();
    const qs = bank?.questions || [];
    if (qs.length) {
      const q = qs[state.questionIndex % qs.length];
      const heading = document.querySelector(".ludo-question h4");
      if (heading) heading.textContent = q.question || q.text || q.prompt || "Next question";
      const options = Array.isArray(q.options) ? q.options : Array.isArray(q.choices) ? q.choices : [];
      const list = document.querySelector(".ludo-answer-list");
      if (list) list.innerHTML = options.length
        ? options.map((option,i) => `<button class="ludo-answer" onclick="ludoSelectAnswer(${i})"><span class="ludo-answer-key">${String.fromCharCode(65+i)}</span>${escapeHTML(typeof option === "string" ? option : option.text || option.label || JSON.stringify(option))}</button>`).join("")
        : `<p class="ludo-muted">No multiple-choice options were found for this question format.</p>`;
      const submit = document.querySelector(".ludo-question .ludo-button");
      if (submit) submit.disabled = true;
    }
  };
})();
