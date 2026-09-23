if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js");
}
(() => {
  "use strict";

  const STORAGE_KEY = "cricket-scorer-state-v1";
  const WICKET_TYPES = ["Bowled", "Caught", "LBW", "Run out", "Stumped", "Hit wicket"];

  // ---------------- State ----------------
  function freshState() {
    return {
      phase: "setup",           // setup -> openers -> playing -> innings-break -> result
      oversLimit: 0,
      teamA: { name: "", players: {} },
      teamB: { name: "", players: {} },
      battingFirstKey: null,    // "A" or "B"
      innings: [],              // list of innings objects
      striker: null, nonStriker: null, bowler: null,
      lastOverBowlerKey: null,
      setupDraft: { teamA: "", teamB: "", overs: "0", chosen: null },
      openerDraft: { striker: "", nonStriker: "", bowler: "" },
      pendingModal: null,       // { type: 'newBatsman'|'newBowler'|'wicket'|'extraRuns', ... }
    };
  }

  let state = loadState() || freshState();
  let history = [];

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  }
  function snapshot() {
    history.push(JSON.stringify(state));
    if (history.length > 400) history.shift();
  }
  function undo() {
    if (!history.length) return;
    state = JSON.parse(history.pop());
    persist(); render();
  }

  // ---------------- Model helpers ----------------
  function teamObj(key) { return key === "A" ? state.teamA : state.teamB; }
  function otherKey(key) { return key === "A" ? "B" : "A"; }

  function getPlayer(teamKey, name) {
    const team = teamObj(teamKey);
    const id = name.trim().toLowerCase();
    if (!team.players[id]) {
      team.players[id] = {
        name: name.trim(), runs: 0, balls: 0, fours: 0, sixes: 0, out: false, outDesc: "",
        ballsBowled: 0, runsConceded: 0, wickets: 0,
      };
    }
    return team.players[id];
  }

  function currentInnings() {
    return state.innings.find(i => !i.isComplete) || null;
  }
  function battingKey(inn) { return inn.battingTeam === "A" ? "A" : "B"; }
  function bowlingKey(inn) { return inn.bowlingTeam === "A" ? "A" : "B"; }

  function legalBalls(inn) {
    let n = 0;
    inn.overs.forEach(o => o.deliveries.forEach(d => { if (isLegal(d)) n++; }));
    return n;
  }
  function isLegal(d) { return d.extraType !== "wide" && d.extraType !== "no_ball"; }
  function totalRuns(inn) {
    let r = 0;
    inn.overs.forEach(o => o.deliveries.forEach(d => { r += d.runs + d.extraRuns; }));
    return r;
  }
  function oversStr(inn) {
    const b = legalBalls(inn);
    return `${Math.floor(b / 6)}.${b % 6}`;
  }
  function runRate(inn) {
    const b = legalBalls(inn);
    return b ? (totalRuns(inn) / b * 6).toFixed(2) : "0.00";
  }
  function requiredRunRate(inn) {
    if (inn.target == null) return null;
    const ballsLeft = inn.oversLimit * 6 - legalBalls(inn);
    if (ballsLeft <= 0) return null;
    const needed = inn.target - totalRuns(inn);
    return (Math.max(needed, 0) / ballsLeft * 6).toFixed(2);
  }

  function startInnings(battingKey, bowlingKey, target) {
    state.innings.push({
      battingTeam: battingKey, bowlingTeam: bowlingKey, oversLimit: state.oversLimit,
      overs: [], wickets: 0, maxWickets: 10, isComplete: false, target: target ?? null,
    });
    state.striker = null; state.nonStriker = null; state.bowler = null;
  }

  function recordBall({ runs = 0, extraType = null, extraRuns = 0, isWicket = false, wicketType = null, playerOut = null }) {
    snapshot();
    const inn = currentInnings();
    if (!inn) return;

    if (!inn.overs.length || legalCount(inn.overs[inn.overs.length - 1]) >= 6) {
      inn.overs.push({ number: inn.overs.length + 1, deliveries: [] });
    }
    const over = inn.overs[inn.overs.length - 1];
    const delivery = {
      bowler: state.bowler, batsman: state.striker, runs, extraType, extraRuns,
      isWicket, wicketType, playerOut: playerOut || (isWicket ? state.striker : null),
    };
    over.deliveries.push(delivery);

    applyStats(inn, delivery);

    // Only physical runs run between the wickets rotate strike
    let physicalRuns = delivery.runs;
    if (delivery.extraType === "wide" || delivery.extraType === "no_ball") {
      physicalRuns += Math.max(0, delivery.extraRuns - 1);
    } else if (delivery.extraType === "bye" || delivery.extraType === "leg_bye") {
      physicalRuns = delivery.extraRuns;
    }

    // Boundaries (4 or 6) do not swap ends
    if (delivery.runs !== 4 && delivery.runs !== 6 && physicalRuns % 2 === 1) {
      [state.striker, state.nonStriker] = [state.nonStriker, state.striker];
    }

    if (isWicket) {
      inn.wickets += 1;
      if (delivery.playerOut === state.striker) state.striker = null;
      else if (delivery.playerOut === state.nonStriker) state.nonStriker = null;
    }

    if (legalCount(over) === 6 && isLegal(delivery)) {
      [state.striker, state.nonStriker] = [state.nonStriker, state.striker];
      state.lastOverBowlerKey = state.bowler;
      state.bowler = null;
    }

    checkInningsComplete(inn);
    persist();
  }

  function legalCount(over) { return over.deliveries.filter(isLegal).length; }

  function applyStats(inn, d) {
    const bKey = battingKey(inn), wKey = bowlingKey(inn);
    const bowler = getPlayer(wKey, d.bowler);
    if (isLegal(d)) bowler.ballsBowled += 1;
    
    // Byes and Leg byes are fielding extras, not charged to the bowler
    if (d.extraType !== "bye" && d.extraType !== "leg_bye") {
      bowler.runsConceded += d.runs + d.extraRuns;
    } else {
      bowler.runsConceded += d.runs; // only runs off the bat (if any)
    }

    if (d.extraType !== "wide") {
      const bat = getPlayer(bKey, d.batsman);
      bat.balls += 1;
      if (d.extraType !== "bye" && d.extraType !== "leg_bye") {
        bat.runs += d.runs;
        if (d.runs === 4) bat.fours += 1;
        if (d.runs === 6) bat.sixes += 1;
      }
    }
    if (d.isWicket && d.wicketType !== "Run out") bowler.wickets += 1;
    if (d.isWicket) {
      const out = getPlayer(bKey, d.playerOut);
      out.out = true;
      out.outDesc = `${d.wicketType} b ${d.bowler}`;
    }
  }

  function checkInningsComplete(inn) {
    const oversDone = legalBalls(inn) >= inn.oversLimit * 6;
    const allOut = inn.wickets >= inn.maxWickets;
    const targetReached = inn.target != null && totalRuns(inn) >= inn.target;
    if (oversDone || allOut || targetReached) {
      inn.isComplete = true;
      // Snapshot who was at the crease/bowling, since state.striker/nonStriker/bowler get
      // wiped when the next innings starts - without this, a not-out batter who
      // never faced a ball (e.g. last-wicket-down partner) or a bowler who was
      // selected but never got to bowl a delivery disappears from the scorecard
      // once the next innings begins.
      inn.finalStriker = state.striker;
      inn.finalNonStriker = state.nonStriker;
      inn.finalBowler = state.bowler;
    }
  }

  function matchResult() {
    if (state.innings.length < 2) return null;
    const [first, second] = state.innings;
    const t1 = totalRuns(first), t2 = totalRuns(second);
    const nameOf = k => teamObj(k).name;
    if (t2 > t1) return `${nameOf(second.battingTeam)} won by ${10 - second.wickets} wicket(s)`;
    if (t1 > t2) return `${nameOf(first.battingTeam)} won by ${t1 - t2} run(s)`;
    return "Match tied";
  }

  // ---------------- Rendering ----------------
  const app = document.getElementById("app");
  function render() {
    let html = topbar();
    if (state.phase === "setup") html += renderSetup();
    else if (state.phase === "openers") html += renderOpeners();
    else if (state.phase === "playing") html += renderPlaying();
    else if (state.phase === "innings-break") html += renderInningsBreak();
    else if (state.phase === "result") html += renderResult();
    app.innerHTML = html;
    bindEvents();
    if (state.pendingModal) renderModal();
    persist();
  }

  function topbar() {
    const showScorecard = state.innings.length > 0;
    return `<div class="topbar">
      <div class="brand">&#127951; <span>MAD CricTrack</span><br />Match &middot; Analytics &middot; Data</div>
      <div style="display:flex; gap:8px; flex-shrink:0;">
        ${showScorecard ? `<button class="icon-btn" id="btn-scorecard">Scorecard</button>` : ""}
        ${state.phase !== "setup" ? `<button class="icon-btn" id="btn-reset">New match</button>` : ""}
      </div>
    </div>`;
  }

  function liveScorecardHTML() {
    if (!state.innings.length) return `<p class="sub">No innings started yet.</p>`;
    return state.innings.map((inn) => {
      const bKey = battingKey(inn), wKey = bowlingKey(inn);
      const battingTeam = teamObj(bKey), bowlingTeam = teamObj(wKey);
      const statusTag = inn.isComplete ? "" : `<span class="sc-progress">In progress</span>`;
      // While live, "who's at the crease" comes from the global striker/non-striker.
      // Once the innings is complete, those globals have been reset for the next
      // innings, so fall back to the snapshot taken the moment it finished.
      const activeStriker = inn.isComplete ? inn.finalStriker : state.striker;
      const activeNonStriker = inn.isComplete ? inn.finalNonStriker : state.nonStriker;
      const activeBowler = inn.isComplete ? inn.finalBowler : state.bowler;
      const battingRows = Object.values(battingTeam.players).filter(p =>
        p.balls > 0 || p.out || p.name === activeStriker || p.name === activeNonStriker
      );
      const bowlingRows = Object.values(bowlingTeam.players).filter(p => p.ballsBowled > 0 || p.name === activeBowler);
      return `<div class="sc-block">
        <h3>${esc(battingTeam.name)} &mdash; ${totalRuns(inn)}/${inn.wickets} <span style="font-weight:400;color:var(--ink-soft);">(${oversStr(inn)} ov)</span>${statusTag}</h3>
        ${inn.target != null ? `<div class="sc-subhead">Target: ${inn.target} &middot; Run Rate: ${runRate(inn)}${!inn.isComplete ? ` &middot; Req.RR: ${requiredRunRate(inn) ?? "&ndash;"}` : ""}</div>` : ""}
        <table class="score-table"><thead><tr>
          <th>Batter</th><th class="num">R</th><th class="num">B</th><th class="num">4s</th><th class="num">6s</th><th class="num">SR</th>
        </tr></thead><tbody>
        ${battingRows.length ? battingRows.map(p => {
          // Standard scorecard convention: an asterisk marks a batter who is not out,
          // whether they're still batting live or the innings ended with them unbeaten.
          const tag = p.out ? "" : ' <span class="tag">*</span>';
          return `<tr>
            <td>${esc(p.name)}${tag}</td>
            <td class="num">${p.runs}</td><td class="num">${p.balls}</td><td class="num">${p.fours}</td><td class="num">${p.sixes}</td>
            <td class="num">${p.balls ? (p.runs/p.balls*100).toFixed(1) : "0.0"}</td>
          </tr>`;
        }).join("") : `<tr><td colspan="6" style="color:var(--ink-soft);">No batter has faced a ball yet.</td></tr>`}
        </tbody></table>
        <div class="sc-subhead">Bowling</div>
        <table class="score-table"><thead><tr>
          <th>Bowler</th><th class="num">O</th><th class="num">R</th><th class="num">W</th><th class="num">Econ</th>
        </tr></thead><tbody>
        ${bowlingRows.length ? bowlingRows.map(p => `<tr>
          <td>${esc(p.name)}</td>
          <td class="num">${Math.floor(p.ballsBowled/6)}.${p.ballsBowled%6}</td>
          <td class="num">${p.runsConceded}</td><td class="num">${p.wickets}</td>
          <td class="num">${p.ballsBowled ? (p.runsConceded/(p.ballsBowled/6)).toFixed(2) : "0.00"}</td>
        </tr>`).join("") : `<tr><td colspan="5" style="color:var(--ink-soft);">No bowler has bowled yet.</td></tr>`}
        </tbody></table>
      </div>`;
    }).join("");
  }

  function renderSetup() {
    const d = state.setupDraft;
    const teamATrimmed = d.teamA.trim();
    const teamBTrimmed = d.teamB.trim();
    const bothTeamsEntered = Boolean(teamATrimmed && teamBTrimmed);

    return `<div class="screen">
      <h1 class="title">Set up the match</h1>      
      <div id="setup-error" class="form-error"></div>

      <label class="field">
        <span>Host Team Name <strong class="required-mark">*</strong></span>
        <input type="text" id="in-teamA" value="${esc(d.teamA)}" placeholder="e.g. India" required>
      </label>
      
      <label class="field">
        <span>Visiting Team Name <strong class="required-mark">*</strong></span>
        <input type="text" id="in-teamB" value="${esc(d.teamB)}" placeholder="e.g. Pakistan" required>
      </label>
      
      <label class="field">
        <span>Overs per innings <strong class="required-mark">*</strong></span>
        <input type="number" id="in-overs" value="${esc(d.overs)}" min="1" max="50" required>
      </label>
      
      ${bothTeamsEntered ? `
        <label class="field"><span>Batting first <strong class="required-mark">*</strong></span></label>
        <div class="choice-row">
          <div class="choice ${d.chosen === 'A' ? 'selected' : ''}" id="choose-A">${esc(teamATrimmed)}</div>
          <div class="choice ${d.chosen === 'B' ? 'selected' : ''}" id="choose-B">${esc(teamBTrimmed)}</div>
        </div>
      ` : ''}
      
      <button class="primary-btn" id="btn-start-setup">Start match</button>
    </div>`;
  }

  function renderOpeners() {
    const inn = currentInnings();
    const battingName = teamObj(battingKey(inn)).name;
    const d = state.openerDraft;
    return `<div class="screen">
      <h1 class="title">${esc(battingName)} Batting Innings</h1>
      <label class="field"><b>Striker</b><input type="text" id="in-striker" value="${esc(d.striker)}" placeholder="Batter name - Striker"></label>
      <label class="field"><b>Non-striker</b><input type="text" id="in-nonstriker" value="${esc(d.nonStriker)}" placeholder="Batter name - Non-Striker"></label>
      <label class="field"><b>Bowler name</b><input type="text" id="in-bowler" value="${esc(d.bowler)}" placeholder="Opening Bowler"></label>
      <button class="primary-btn" id="btn-start-openers">Begin innings</button>
    </div>`;
  }

  function renderPlaying() {
    const inn = currentInnings();
    if (!inn) return "";
    const bKey = battingKey(inn), wKey = bowlingKey(inn);
    const battingName = teamObj(bKey).name;
    const rrr = requiredRunRate(inn);

    let jumbo = `<div class="jumbotron">
      <div class="innings-label">Innings ${state.innings.indexOf(inn) + 1} of ${Math.min(state.innings.length + (inn.isComplete?0:1),2)}</div>
      
      <div class="jumbotron-main-row">
        <div class="score-row">
          ${esc(battingName)} : 
          <div class="score">${totalRuns(inn)}/${inn.wickets}</div>
          <div class="overs">(${oversStr(inn)} / ${inn.oversLimit} ov)</div>
        </div>

        <div class="jumbotron-right-stats">
          <div class="stat-pill">Run Rate: ${runRate(inn)}</div>
          ${inn.target != null ? `<div class="stat-pill target-pill">Target: ${inn.target}</div>` : ""}
        </div>
      </div>

      ${inn.target != null ? `<div class="target-line">Need ${Math.max(inn.target - totalRuns(inn),0)} runs off ${Math.max(inn.oversLimit*6 - legalBalls(inn),0)} balls &middot; Req.RR: ${rrr ?? "&ndash;"}</div>` : ""}
    </div>`;

    const striker = state.striker ? getPlayer(bKey, state.striker) : null;
    const nonStriker = state.nonStriker ? getPlayer(bKey, state.nonStriker) : null;
    const bowler = state.bowler ? getPlayer(wKey, state.bowler) : null;

    let battingCard = `
      <div class="section-card">
        <table class="batting-table">
          <thead>
            <tr>
              <th>Batters</th>
              <th>Runs</th>
              <th>Balls</th>
              <th>4s</th>
              <th>6s</th>
              <th>SR</th>
            </tr>
          </thead>
          <tbody>
            ${batterTableRow(striker, true)}
            ${batterTableRow(nonStriker, false)}
          </tbody>
        </table>
      </div>
    `;

    let bowlingCard = `
	  <div class="section-card">
		<table class="batting-table">
		  <thead>
			<tr>
			  <th>Bowler</th>
			  <th>Overs</th>
			  <th>Runs</th>
			  <th>Wickets</th>
			  <th>Economy</th>
			</tr>
		  </thead>
		  <tbody>
			${bowlerRow(bowler)}
		  </tbody>
		</table>
	  </div>
	`;

    const overNow = inn.overs[inn.overs.length - 1];
    let dots = "";
    if (overNow) {
      dots = `<div class="over-strip" style="align-items: center;"><span style="font-size: 13px; font-weight: 600; color: var(--ink-soft); white-space: nowrap;">This Over:</span>` + overNow.deliveries.map(dotFor).join("") + `</div>`;
    }

    const canWicket = !!state.striker;
    const canBat = !!state.striker;

    let actions = `<div class="action-section">
      <div class="action-label">Runs off the bat</div>
      <div class="grid runs-grid">
        <button class="run-btn" data-run="0" ${canBat?"":"disabled"}>0</button>
        <button class="run-btn" data-run="1" ${canBat?"":"disabled"}>1</button>
        <button class="run-btn" data-run="2" ${canBat?"":"disabled"}>2</button>
        <button class="run-btn" data-run="3" ${canBat?"":"disabled"}>3</button>
        <button class="run-btn four" data-run="4" ${canBat?"":"disabled"}>4</button>
        <button class="run-btn" data-run="5" ${canBat?"":"disabled"}>5</button>
        <button class="run-btn six" data-run="6" ${canBat?"":"disabled"}>6</button>
      </div>
      <div class="action-label">Extras</div>
      <div class="grid extras-grid">
        <button class="ex-btn" data-extra="wide">Wide</button>
        <button class="ex-btn" data-extra="no_ball">No ball</button>
        <button class="ex-btn" data-extra="bye">Bye</button>
        <button class="ex-btn" data-extra="leg_bye">Leg bye</button>
      </div>
      <div class="action-label">Batter Controls</div>
      <div class="grid two-col-action">
        <button class="control-btn" id="btn-swap-strike" ${state.striker && state.nonStriker ? "" : "disabled"}>⇄ Strike Swap</button>
        <button class="control-btn" id="btn-retire-hurt" ${state.striker || state.nonStriker ? "" : "disabled"}>Retire Hurt</button>
      </div>
      <div class="action-label">&nbsp;</div>
      <div class="grid two-col-action">
        <button class="wicket-btn" id="btn-wicket" ${canWicket?"":"disabled"}>Wicket</button>
        <button class="undo-btn" id="btn-undo" ${history.length?"":"disabled"}>Undo</button>
      </div>
    </div>`;

    return jumbo + battingCard + bowlingCard + dots + actions;
  }

  function batterTableRow(p, isStriker) {
  if (!p || p.runs === "-") {
    return `<tr>
      <td style="color: var(--ink-soft); font-style: italic; text-align: left;">
        ${esc(p?.name || "Selecting batter...")} ${isStriker ? '<span class="tag">*</span>' : ''}
      </td>
      <td>&ndash;</td>
      <td>&ndash;</td>
      <td>&ndash;</td>
      <td>&ndash;</td>
      <td>&ndash;</td>
    </tr>`;
  }
  
    const runs = p.runs || 0;
    const balls = p.balls || 0;
    const fours = p.fours || 0;
    const sixes = p.sixes || 0;
    const sr = balls > 0 ? ((runs / balls) * 100).toFixed(1) : "0.0";

    return `<tr>
      <td>${esc(p.name)} ${isStriker ? '<span class="tag">*</span>' : ''}</td>
      <td><strong>${runs}</strong></td>
      <td>${balls}</td>
      <td>${fours}</td>
      <td>${sixes}</td>
      <td>${sr}</td>
    </tr>`;
  }

  function bowlerRow(p) {
	  if (!p) {
		return `<tr>
		  <td colspan="5" style="cursor: pointer; color: var(--gold); font-weight: 600; text-align: left !important;" id="row-select-bowler">
			+ Select Bowler for this over
		  </td>
		</tr>`;
	  }
	  const overs = `${Math.floor(p.ballsBowled / 6)}.${p.ballsBowled % 6}`;
	  const econ = p.ballsBowled > 0 ? (p.runsConceded / (p.ballsBowled / 6)).toFixed(2) : "0.00";
	  return `<tr>
		<td style="text-align: left !important; font-weight: 600;">${esc(p.name)}</td>
		<td><strong>${overs}</strong></td>
		<td>${p.runsConceded}</td>
		<td>${p.wickets}</td>
		<td>${econ}</td>
	  </tr>`;
	}

  function dotFor(d) {
    if (d.isWicket) return `<div class="ball-dot wicket">W</div>`;
    if (d.extraType === "wide") return `<div class="ball-dot extra">wd${d.extraRuns>1?'+'+(d.extraRuns-1):''}</div>`;
    if (d.extraType === "no_ball") return `<div class="ball-dot extra">nb${d.extraRuns>1?'+'+(d.extraRuns-1):''}</div>`;
    if (d.extraType === "bye") return `<div class="ball-dot extra">${d.extraRuns}b</div>`;
    if (d.extraType === "leg_bye") return `<div class="ball-dot extra">${d.extraRuns}lb</div>`;
    if (d.runs === 4 || d.runs === 6) return `<div class="ball-dot boundary">${d.runs}</div>`;
    return `<div class="ball-dot">${d.runs}</div>`;
  }

  function renderInningsBreak() {
    const inn = state.innings[0];
    const bName = teamObj(battingKey(inn)).name;
    return `<div class="screen">
      <h1 class="title">Innings break</h1>
      <p class="sub">${esc(bName)} finished on ${totalRuns(inn)}/${inn.wickets} in ${oversStr(inn)} overs. ${esc(teamObj(otherKey(battingKey(inn))).name)} need ${totalRuns(inn)+1} to win.</p>
      <button class="primary-btn" id="btn-start-second">Start second innings</button>
    </div>`;
  }

  function renderResult() {
    const result = matchResult();
    let out = `<div class="result-banner">${esc(result)}</div>`;
    
    // Add Share and Download PDF action buttons
    out += `
      <div class="result-actions">
        <button class="share-btn" id="btn-share-result">&#128228; Share Result</button>
        <button class="download-btn" id="btn-download-pdf">&#128196; Download PDF</button>
      </div>
    `;

    state.innings.forEach((inn, idx) => {
      const bKey = battingKey(inn), wKey = bowlingKey(inn);
      const battingTeam = teamObj(bKey), bowlingTeam = teamObj(wKey);
      const activeStriker = inn.isComplete ? inn.finalStriker : state.striker;
      const activeNonStriker = inn.isComplete ? inn.finalNonStriker : state.nonStriker;
      const activeBowler = inn.isComplete ? inn.finalBowler : state.bowler;
      out += `<div class="card-block">
        <h3>${esc(battingTeam.name)} &mdash; ${totalRuns(inn)}/${inn.wickets} (${oversStr(inn)} ov)</h3>
        <table class="score-table"><thead><tr>
          <th>Batter</th><th class="num">R</th><th class="num">B</th><th class="num">4s</th><th class="num">6s</th><th class="num">SR</th>
        </tr></thead><tbody>
        ${Object.values(battingTeam.players).filter(p=>p.balls>0||p.out||p.name===activeStriker||p.name===activeNonStriker).map(p => `<tr>
          <td>${esc(p.name)}${p.out ? '' : ' *'}</td>
          <td class="num">${p.runs}</td><td class="num">${p.balls}</td><td class="num">${p.fours}</td><td class="num">${p.sixes}</td>
          <td class="num">${p.balls ? (p.runs/p.balls*100).toFixed(1) : "0.0"}</td>
        </tr>`).join("")}
        </tbody></table>
      </div>
      <div class="card-block">
        <h3>${esc(bowlingTeam.name)} bowling</h3>
        <table class="score-table"><thead><tr>
          <th>Bowler</th><th class="num">O</th><th class="num">R</th><th class="num">W</th><th class="num">Econ</th>
        </tr></thead><tbody>
        ${Object.values(bowlingTeam.players).filter(p=>p.ballsBowled>0||p.name===activeBowler).map(p => `<tr>
          <td>${esc(p.name)}</td>
          <td class="num">${Math.floor(p.ballsBowled/6)}.${p.ballsBowled%6}</td>
          <td class="num">${p.runsConceded}</td><td class="num">${p.wickets}</td>
          <td class="num">${p.ballsBowled ? (p.runsConceded/(p.ballsBowled/6)).toFixed(2) : "0.00"}</td>
        </tr>`).join("")}
        </tbody></table>
      </div>`;
    });
    
    // Bottom section uses disabled "Close" button
    return `<div class="screen" style="padding-left:0;padding-right:0;">
      ${out}
      <div style="padding:0 20px;">
        <button class="ghost-btn" id="btn-close-result" style="width:100%; opacity:0.4; cursor:not-allowed;" disabled>Close</button>
      </div>
    </div>`;
  }

  // ---------------- Modals ----------------
  function renderModal() {
    const m = state.pendingModal;
    let inner = "";
    if (m.type === "newBatsman") {
      inner = `<h2>Next batsman ${m.slot === 'striker' ? 'on strike' : '(non-striker)'}</h2>
        <label class="field"><input type="text" id="modal-input" placeholder="Batsman name" autofocus></label>
        <button class="primary-btn" id="modal-confirm">Confirm</button>`;
    } else if (m.type === "newBowler") {
      inner = `<h2>Bowler for the next over</h2>
        <label class="field"><input type="text" id="modal-input" placeholder="Bowler name" autofocus></label>
        <button class="primary-btn" id="modal-confirm">Confirm</button>`;
    } else if (m.type === "extraRuns") {
      inner = `<h2>${m.label}</h2>
        <div class="row-btns">
          ${m.options.map(v => `<div class="opt ${m.value===v?'selected':''}" data-val="${v}">${m.optionLabel(v)}</div>`).join("")}
        </div>
        <div class="modal-actions-row">
          <button class="ghost-btn" id="modal-cancel" style="margin-top:8px; flex:1;">Cancel</button>
          <button class="primary-btn" id="modal-confirm" style="margin-top:8px; flex:1;" ${m.value===null?"disabled":""}>Confirm</button>
        </div>`;
    } else if (m.type === "wicket") {
      inner = `<h2>How did the batsman get out?</h2>
        <div class="row-btns">
          ${WICKET_TYPES.map(t => `<div class="opt ${m.wicketType===t?'selected':''}" data-type="${t}">${t}</div>`).join("")}
        </div>
        <h2>Who's out?</h2>
        <div class="row-btns">
          <div class="opt ${m.who==='striker'?'selected':''}" data-who="striker">${esc(state.striker)} (striker)</div>
          ${state.nonStriker ? `<div class="opt ${m.who==='nonStriker'?'selected':''}" data-who="nonStriker">${esc(state.nonStriker)} (non-striker)</div>` : ""}
        </div>
        <button class="primary-btn" id="modal-confirm" ${m.wicketType?"":"disabled"}>Confirm wicket</button>`;
    } else if (m.type === "fullScorecard") {
      inner = `<h2>Full scorecard</h2>${liveScorecardHTML()}<button class="ghost-btn" id="modal-close">Close</button>`;
    } else if (m.type === "retireHurt") {
      inner = `<h2>Who is retiring hurt?</h2>
        <div class="row-btns">
          ${state.striker ? `<div class="opt ${m.who==='striker'?'selected':''}" data-who="striker">${esc(state.striker)} (striker)</div>` : ""}
          ${state.nonStriker ? `<div class="opt ${m.who==='nonStriker'?'selected':''}" data-who="nonStriker">${esc(state.nonStriker)} (non-striker)</div>` : ""}
        </div>
        <div class="modal-actions-row">
          <button class="ghost-btn" id="modal-cancel" style="margin-top:8px; flex:1;">Cancel</button>
          <button class="primary-btn" id="modal-confirm" style="margin-top:8px; flex:1;" ${m.who ? "" : "disabled"}>Confirm</button>
        </div>`;
	} else if (m.type === "matchCompletionConfirm") {
      const inn1 = state.innings[0];
      const inn2 = state.innings[1];
      const team1Name = teamObj(battingKey(inn1)).name;
      const team2Name = teamObj(battingKey(inn2)).name;

      inner = `<h2>Confirm Match Completion</h2>
        <div style="background:var(--pitch); color:#F3EDE0; border-radius:10px; padding:12px 14px; margin-bottom:14px; font-weight:700; font-size:15px; text-align:center;">
          ${esc(m.result)}
        </div>
        <div style="background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:10px 14px; margin-bottom:16px; font-size:13.5px; line-height:1.6;">
          <div><strong>${esc(team1Name)}:</strong> ${totalRuns(inn1)}/${inn1.wickets} (${oversStr(inn1)} ov)</div>
          <div><strong>${esc(team2Name)}:</strong> ${totalRuns(inn2)}/${inn2.wickets} (${oversStr(inn2)} ov)</div>
        </div>
        <p style="font-size:13px; color:var(--ink-soft); margin-bottom:16px;">
          Are you sure you want to end this match and generate the final scorecard?
        </p>
        <div class="modal-actions-row">
          <button class="ghost-btn" id="modal-match-cancel" style="flex:1; margin-top:0;">Undo / Back</button>
          <button class="primary-btn" id="modal-match-confirm" style="flex:1; margin-top:0;">Confirm & Finish</button>
        </div>`;
    }
    const wrap = document.createElement("div");
    wrap.className = "sheet-overlay";
    wrap.id = "sheet-overlay";
    wrap.innerHTML = `<div class="sheet">${inner}</div>`;
    document.body.appendChild(wrap);
    if (m.type === "fullScorecard") {
      wrap.onclick = (e) => { if (e.target === wrap) { closeModal(); render(); } };
    }
    bindModalEvents();
  }

  function closeModal() {
    const el = document.getElementById("sheet-overlay");
    if (el) el.remove();
    state.pendingModal = null;
  }

  function bindModalEvents() {
    const m = state.pendingModal;
    document.querySelectorAll("[data-val]").forEach(el => {
      el.onclick = () => { m.value = Number(el.dataset.val); renderModalRefresh(); };
    });
    document.querySelectorAll("[data-type]").forEach(el => {
      el.onclick = () => { m.wicketType = el.dataset.type; renderModalRefresh(); };
    });
    document.querySelectorAll("[data-who]").forEach(el => {
      el.onclick = () => { m.who = el.dataset.who; renderModalRefresh(); };
    });
    const confirmBtn = document.getElementById("modal-confirm");
    if (confirmBtn) confirmBtn.onclick = () => resolveModal();
    const closeBtn = document.getElementById("modal-close");
    if (closeBtn) closeBtn.onclick = () => { closeModal(); render(); };
	const cancelBtn = document.getElementById("modal-cancel");
    if (cancelBtn) cancelBtn.onclick = () => { closeModal(); render(); };
	
	const matchConfirmBtn = document.getElementById("modal-match-confirm");
    if (matchConfirmBtn) {
      matchConfirmBtn.onclick = () => {
        closeModal();
        state.phase = "result";
        persist();
        render();
      };
    }

    const matchCancelBtn = document.getElementById("modal-match-cancel");
    if (matchCancelBtn) {
      matchCancelBtn.onclick = () => {
        closeModal();
        undo(); // undoes the last delivery so scorer can adjust if mistaken
      };
    }
  }
  function renderModalRefresh() {
    const el = document.getElementById("sheet-overlay");
    if (el) el.remove();
    renderModal();
  }

  function resolveModal() {
    const m = state.pendingModal;
    if (m.type === "newBatsman") {
      const name = (document.getElementById("modal-input").value || "Batsman").trim();
      snapshot();
      if (m.slot === "striker") state.striker = name; else state.nonStriker = name;
      closeModal(); render();
    } else if (m.type === "newBowler") {
      const name = (document.getElementById("modal-input").value || "Bowler").trim();
      snapshot();
      state.bowler = name;
      closeModal(); render(); advanceIfNeeded();
    } else if (m.type === "extraRuns") {
      closeModal();
      m.onConfirm(m.value);
      render(); advanceIfNeeded();
    } else if (m.type === "wicket") {
      const who = m.who === "nonStriker" ? state.nonStriker : state.striker;
      closeModal();
      recordBall({ runs: 0, isWicket: true, wicketType: m.wicketType, playerOut: who });
      render(); advanceIfNeeded();
    } else if (m.type === "retireHurt") {
      snapshot();
      const inn = currentInnings();
      const bKey = battingKey(inn);
      const whoName = m.who === "nonStriker" ? state.nonStriker : state.striker;
      const player = getPlayer(bKey, whoName);
      player.out = false;
      player.outDesc = "retired hurt";

      if (m.who === "striker") {
        state.striker = null;
      } else {
        state.nonStriker = null;
      }
      closeModal();
      render();
      advanceIfNeeded();
    }
  }

  // ---------------- Flow control ----------------
  function advanceIfNeeded() {
    const inn = currentInnings();
    if (!inn) {
      // an innings just completed
      if (state.innings.length === 1) { 
        state.phase = "innings-break"; 
        render(); 
        return; 
      }
      if (state.innings.length === 2) { 
        // Trigger confirmation modal instead of going directly to result
        const resultText = matchResult();
        openModal({
          type: "matchCompletionConfirm",
          result: resultText,
        });
        return; 
      }
    }
    if (state.phase === "playing" && inn) {
      if (!state.striker) { openModal({ type: "newBatsman", slot: "striker" }); return; }
      if (!state.nonStriker) { openModal({ type: "newBatsman", slot: "nonStriker" }); return; }
      if (!state.bowler) { openModal({ type: "newBowler" }); return; }
    }
    render();
  }
  function openModal(m) { state.pendingModal = m; render(); }

  // ---------------- Event binding ----------------
  function bindEvents() {
    const byId = id => document.getElementById(id);
    
	if (byId("btn-close-result")) {
      byId("btn-close-result").onclick = (e) => {
        if (e.target.disabled) return;
        state = freshState(); 
        history = []; 
        persist(); 
        render();
      };
    }
	
    if (byId("btn-scorecard")) byId("btn-scorecard").onclick = () => {
      openModal({ type: "fullScorecard" });
    };

    const bowlerRowEl = byId("row-select-bowler");
    if (bowlerRowEl) {
      bowlerRowEl.onclick = () => {
        openModal({ type: "newBowler" });
      };
    }
    
    if (byId("btn-reset")) byId("btn-reset").onclick = () => {
      if (confirm("Start a brand new match? Current progress will be lost.")) {
        state = freshState(); history = []; persist(); render();
      }
    };
    if (byId("btn-new-match")) byId("btn-new-match").onclick = () => {
      state = freshState(); history = []; persist(); render();
    };

    if (byId("in-teamA")) byId("in-teamA").oninput = e => {
      state.setupDraft.teamA = e.target.value;
      render();
      const el = byId("in-teamA");
      if (el) { el.focus(); el.selectionStart = el.selectionEnd = el.value.length; }
    };

    if (byId("in-teamB")) byId("in-teamB").oninput = e => {
      state.setupDraft.teamB = e.target.value;
      render();
      const el = byId("in-teamB");
      if (el) { el.focus(); el.selectionStart = el.selectionEnd = el.value.length; }
    };
	
	if (byId("btn-swap-strike")) {
      byId("btn-swap-strike").onclick = () => {
        if (!state.striker || !state.nonStriker) return;
        snapshot();
        [state.striker, state.nonStriker] = [state.nonStriker, state.striker];
        persist();
        render();
      };
    }

    if (byId("btn-retire-hurt")) {
      byId("btn-retire-hurt").onclick = () => {
        openModal({ type: "retireHurt", who: state.striker ? "striker" : "nonStriker" });
      };
    }

    if (byId("in-overs")) byId("in-overs").oninput = e => state.setupDraft.overs = e.target.value;
    if (byId("choose-A")) byId("choose-A").onclick = () => { state.setupDraft.chosen = "A"; render(); };
    if (byId("choose-B")) byId("choose-B").onclick = () => { state.setupDraft.chosen = "B"; render(); };
    
    if (byId("btn-start-setup")) byId("btn-start-setup").onclick = () => {
      const d = state.setupDraft;
      const errorEl = byId("setup-error");
      const showError = (msg) => {
        if (errorEl) {
          errorEl.textContent = msg;
          errorEl.style.display = "block";
        } else {
          alert(msg);
        }
      };

      if (!d.teamA.trim()) {
        showError("Host Team Name is required.");
        byId("in-teamA")?.focus();
        return;
      }
      if (!d.teamB.trim()) {
        showError("Visiting Team Name is required.");
        byId("in-teamB")?.focus();
        return;
      }

      const parsedOvers = parseInt(d.overs, 10);
      if (!(parsedOvers > 0)) {
        showError("Overs per innings must be greater than 0.");
        byId("in-overs")?.focus();
        return;
      }

      if (!d.chosen) {
        showError("Please select which team bats first.");
        return;
      }

      if (errorEl) errorEl.style.display = "none";

      state.teamA.name = d.teamA.trim();
      state.teamB.name = d.teamB.trim();
      state.oversLimit = parsedOvers;
      state.battingFirstKey = d.chosen;
      startInnings(d.chosen, otherKey(d.chosen), null);
      state.phase = "openers";
      render();
    };

    if (byId("in-striker")) byId("in-striker").oninput = e => state.openerDraft.striker = e.target.value;
    if (byId("in-nonstriker")) byId("in-nonstriker").oninput = e => state.openerDraft.nonStriker = e.target.value;
    if (byId("in-bowler")) byId("in-bowler").oninput = e => state.openerDraft.bowler = e.target.value;
    if (byId("btn-start-openers")) byId("btn-start-openers").onclick = () => {
      const d = state.openerDraft;
      if (!d.striker.trim() || !d.nonStriker.trim() || !d.bowler.trim()) { alert("Fill in all three names."); return; }
      state.striker = d.striker.trim(); state.nonStriker = d.nonStriker.trim(); state.bowler = d.bowler.trim();
      state.openerDraft = { striker: "", nonStriker: "", bowler: "" };
      state.phase = "playing";
      render();
    };

    if (byId("btn-start-second")) byId("btn-start-second").onclick = () => {
      const first = state.innings[0];
      const target = totalRuns(first) + 1;
      startInnings(otherKey(battingKey(first)), battingKey(first), target);
      state.phase = "openers";
      render();
    };

    document.querySelectorAll("[data-run]").forEach(el => {
      el.onclick = () => {
        recordBall({ runs: Number(el.dataset.run) });
        advanceIfNeeded();
      };
    });

    document.querySelectorAll("[data-extra]").forEach(el => {
      el.onclick = () => {
        const type = el.dataset.extra;
        if (type === "wide") {
          openModal({
            type: "extraRuns", 
            label: "Wide — additional runs run?",
            options: [0, 1, 2, 3, 4], 
            value: 0, 
            optionLabel: v => v === 0 ? "Wide only (+1)" : `+${v} runs`,
            onConfirm: (v) => recordBall({ runs: 0, extraType: "wide", extraRuns: 1 + v }),
          });
        } else if (type === "no_ball") {
          openModal({
            type: "extraRuns", 
            label: "No Ball — runs off bat / extras run?",
            options: [0, 1, 2, 3, 4, 6], 
            value: 0, 
            optionLabel: v => v === 0 ? "NB only (+1)" : `${v} runs + 1 NB`,
            onConfirm: (v) => recordBall({ runs: v, extraType: "no_ball", extraRuns: 1 }),
          });
        } else {
          openModal({
            type: "extraRuns", 
            label: type === "bye" ? "Bye runs" : "Leg bye runs",
            options: [1, 2, 3, 4], 
            value: 1, 
            optionLabel: v => String(v),
            onConfirm: (v) => recordBall({ runs: 0, extraType: type, extraRuns: v }),
          });
        }
      };
    });

    if (byId("btn-wicket")) byId("btn-wicket").onclick = () => {
      openModal({ type: "wicket", wicketType: null, who: "striker" });
    };
    if (byId("btn-undo")) byId("btn-undo").onclick = () => undo();
	
	// Download as PDF (native print preview dialog configured for PDF saving)
    if (byId("btn-download-pdf")) {
      byId("btn-download-pdf").onclick = () => {
        window.print();
      };
    }

    // Share Match Summary
    if (byId("btn-share-result")) {
      byId("btn-share-result").onclick = async () => {
        const resultText = matchResult();
        let summary = `*MAD CricTrack Match Result*\n${resultText}\n\n`;
        state.innings.forEach(inn => {
          const team = teamObj(battingKey(inn)).name;
          summary += `${team}:${totalRuns(inn)}/${inn.wickets} (${oversStr(inn)} ov)\n`;
        });

        if (navigator.share) {
          try {
            await navigator.share({
              title: "Cricket Match Result",
              text: summary,
            });
          } catch (err) {
            // User cancelled share dialog
          }
        } else if (navigator.clipboard) {
          await navigator.clipboard.writeText(summary);
          alert("Match summary copied to clipboard!");
        } else {
          alert("Sharing not supported on this browser.");
        }
      };
    }
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }

  render();
})();
