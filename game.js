/* =========================================================================
   VOID SLOTS — game logic
   -------------------------------------------------------------------------
   Implements the math exactly as specified in final_rtp.ipynb:
     - Three reel strips of 22 stops each, equal-probability stop selection.
     - Wilds appear only on reel 2 (the middle reel).
     - Blanks appear only on reels 1 and 3.
     - Pay rules, in priority order:
         1) Three of a kind (matching symbol on all three payline positions).
         2) Wild substitution: exactly one wild + two matching non-wilds,
            pays the 3-of-a-kind value times WILD_MULTIPLIER.
         3) Two of a kind: exactly two matching non-wild symbols
            (lemons do not pay on 2-of-a-kind).
     - Reels resolve / stop in middle-left-right order, per the design doc.
     - Bonus feature (lossback free-spins + INVERT):
         * Each losing paid spin advances a progress bar by 1 charge.
         * At BONUS_TRIGGER_LOSSES charges the bar becomes clickable.
         * Activation resets the bar, applies INVERT (CSS photo-negative),
           and auto-plays BONUS_FREE_SPINS free spins. Free-spin losses do
           NOT advance the bar (no re-triggers, matching the notebook's
           FREE_SPINS_RETRIGGER = False setting).
   ========================================================================= */


/* =========================================================================
   Symbol table
   -------------------------------------------------------------------------
   Reels store plain integer symbol IDs — the same scheme used in
   final_rtp.ipynb. The SYMBOLS table is the single source of truth that
   maps each ID to everything we need to display or score it:
       image      — path to the symbol PNG, or null for the blank stop
       cssClass   — color/glow style applied to the cell (drives the halo)
       name       — human-readable plural for the win-message readout
       pay3       — 3-of-a-kind multiplier in units of the bet
       pay2       — 2-of-a-kind multiplier in units of the bet
                    (0 disables 2-of-a-kind for that symbol — lemons & wild)
       glowRGB    — "r, g, b" triple (CSS-ready) used by the win-burst
                    animation. The wild never pays on its own, so it has
                    no glow color — wild substitutions emit the matched
                    symbol's color instead.
   Use symbolFor(id) to look up.
   ========================================================================= */
const WILD_ID = 9;          // referenced directly by the wild-substitution rule
const WILD_MULTIPLIER = 2.0; // multiplier applied when a wild completes a line

const SYMBOLS = {
    0: { image: null,                 cssClass: "symbol-blank",   name: "Blank",    pay3:  0.0, pay2: 0.0, glowRGB: null },
    1: { image: "assets/lemon.png",   cssClass: "symbol-lemon",   name: "Lemons",   pay3:  1.5, pay2: 0.0, glowRGB: "255, 255,   0" },
    2: { image: "assets/cherry.png",  cssClass: "symbol-cherry",  name: "Cherries", pay3:  2.0, pay2: 1.5, glowRGB: "255,   0, 255" },
    3: { image: "assets/diamond.png", cssClass: "symbol-diamond", name: "Diamonds", pay3:  5.0, pay2: 2.0, glowRGB: "  0, 255, 255" },
    4: { image: "assets/star.png",    cssClass: "symbol-star",    name: "Stars",    pay3: 50.0, pay2: 5.0, glowRGB: "255, 255, 255" },
    9: { image: "assets/wild.png",    cssClass: "symbol-wild",    name: "Wild",     pay3:  0.0, pay2: 0.0, glowRGB: null },
};

/** Look up the descriptor for a symbol ID. */
function symbolFor(id) {
    return SYMBOLS[id];
}


/* ---- Reel strips -------------------------------------------------------
   Copied verbatim from final_rtp.ipynb cell 3. Each strip is 22 stops.
   Stop probability is uniform — we pick an index uniformly at random.
   Symbol IDs:  0=blank  1=lemon  2=cherry  3=diamond  4=star  9=wild
   ----------------------------------------------------------------------- */
const REELS = [
    // Reel 1 — no wilds; top symbol (4) framed by 3s; blanks spread out
    [1, 2, 2, 3, 3, 4, 3, 3, 2, 1, 0, 1, 2, 1, 0, 1, 2, 1, 3, 1, 0, 1],
    // Reel 2 — the winner-maker; wilds clustered with 4s (the 4-9-4-9 tease zone)
    [1, 2, 3, 4, 9, 4, 9, 3, 2, 1, 1, 1, 2, 1, 3, 1, 2, 1, 3, 1, 2, 1],
    // Reel 3 — the near-miss reel; 4 sandwiched as 0-3-4-3-0
    [1, 2, 1, 3, 1, 2, 1, 0, 3, 4, 3, 0, 2, 2, 1, 3, 1, 2, 1, 3, 1, 0],
];


/* ---- Tuning constants --------------------------------------------------- */
const BET = 1.0;                  // Fixed denomination per the GDD ($1 bet).
const STARTING_CREDITS = 100.0;
const ADD_CREDITS_AMOUNT = 100.0; // How much "+ $100" gives per click.

/* ---- Sound constants --------------------------------------------------- */
const BPM = 152.0; // From Radiohead's song Ful Stop
const BEAT_MS = (60 * 1000) / BPM;

// Spin animation timing. The "reels resolve middle-left-right" cadence
// is implemented by staggering when each reel's tumble interval stops.
const TUMBLE_TICK_MS = BEAT_MS / 4;        // how often the spinning reel cycles a new symbol
const STOP_DELAY_MIDDLE_MS = BEAT_MS * 2; // reel 2 (middle) stops first
const STOP_DELAY_LEFT_MS   = BEAT_MS * 4; // reel 1 (left) stops second
const STOP_DELAY_RIGHT_MS  = BEAT_MS * 6; // reel 3 (right) stops last

/* ---- Bonus (lossback free-spins) constants -----------------------------
   Mirrors the math notebook's LOSSBACK_* values exactly. The notebook
   models free spins as base-game spins played at no cost — same reels,
   same paytable, same probabilities — and that's how this implements
   them. Free-spin losses do NOT advance the lossback counter (matches
   the notebook's FREE_SPINS_RETRIGGER = False setting).
   ----------------------------------------------------------------------- */
const BONUS_TRIGGER_LOSSES   = 12;   // losses needed to fill the bar
const BONUS_FREE_SPINS       = 5;    // free spins awarded per activation
const BONUS_ENTRY_DELAY_MS   = BEAT_MS * 2;  // pause between activation and first free spin (lets INVERT register)
const FREE_SPIN_GAP_MS       = BEAT_MS * 2;  // pause between consecutive free spins
const BONUS_EXIT_DELAY_MS    = BEAT_MS * 2; // pause after last free spin before un-inverting


/* ---- Mutable game state ------------------------------------------------- */
let credits = STARTING_CREDITS;
let isSpinning = false;

// reelIndices[i] is the index into REELS[i] currently shown on the payline
// (the middle row). The cells above/below show indices (i-1) and (i+1)
// with wraparound. Initialized to zero so the display has something to show
// at page load.
let reelIndices = [0, 0, 0];

// Bonus state.
//   lossCount           — losing base spins since the last activation, 0..BONUS_TRIGGER_LOSSES.
//   isBonusReady        — true when lossCount has hit the trigger and the bar is
//                         waiting for the player to click it.
//   freeSpinsRemaining  — > 0 means we're mid-bonus. The free spin runner
//                         reads/decrements this; everything else uses it to
//                         know whether to disable the spin button etc.
//   bonusTotalWinnings  — sum of payouts across the current bonus's free
//                         spins. Reset to 0 at activation, accumulated in
//                         finishSpin, summarized in the exit branch.
let lossCount = 0;
let isBonusReady = false;
let freeSpinsRemaining = 0;
let bonusTotalWinnings = 0;


/* ---- DOM handles -------------------------------------------------------- */
const displayEl       = document.getElementById("display");
const spinButtonEl    = document.getElementById("spin-button");
const winDisplayEl    = document.getElementById("win-display");
const creditsValueEl  = document.getElementById("credits-value");
const addCreditsBtnEl = document.getElementById("add-credits-button");
const progressBarEl   = document.getElementById("progress-bar");
const progressFillEl  = document.getElementById("progress-fill");
const menuButtonEl    = document.getElementById("menu-button");
const sidebarEl       = document.getElementById("sidebar");
const sidebarTitleEl  = document.getElementById("sidebar-title");
const sidebarBackEl   = document.getElementById("sidebar-back");
const sidebarCloseEl  = document.getElementById("sidebar-close");
const sidebarMenuEl   = document.getElementById("sidebar-menu");
const sidebarPaytableEl = document.getElementById("sidebar-paytable");
const paytable3oakRowsEl = document.getElementById("paytable-3oak-rows");
const paytable2oakRowsEl = document.getElementById("paytable-2oak-rows");
const paytableWildRowsEl = document.getElementById("paytable-wild-rows");
const winAmountOverlayEl = document.getElementById("win-amount-overlay");
const toggleBgmEl     = document.getElementById("toggle-bgm");
const toggleSfxEl     = document.getElementById("toggle-sfx");


/* =========================================================================
   Rendering helpers
   ========================================================================= */

/**
 * Update a single cell (one reel column at one row) to display a symbol.
 * Sets both the letter content and the per-symbol color class.
 */
function setCell(reelIdx, rowIdx, symbolId) {
    const cell = displayEl.querySelector(
        `.cell[data-reel="${reelIdx}"][data-row="${rowIdx}"]`
    );
    const img = cell.querySelector("img");
    const sym = symbolFor(symbolId);

    // Reset all symbol classes, keep base/payline classes intact.
    cell.classList.remove(
        "symbol-blank", "symbol-lemon", "symbol-cherry",
        "symbol-diamond", "symbol-star", "symbol-wild"
    );
    cell.classList.add(sym.cssClass);

    // Update the cell's image. For blanks, we clear the src and let CSS
    // hide the element — keeping the <img> in the DOM means we don't churn
    // nodes every spin, and the cell layout stays stable.
    if (sym.image) {
        img.src = sym.image;
        img.alt = sym.name;
    } else {
        img.removeAttribute("src");
        img.alt = "";
    }
}

/**
 * Render the full vertical slice for a single reel based on the current
 * reelIndices[reelIdx]. Top row is (index-1), middle is the payline (index),
 * bottom is (index+1), all with wraparound.
 */
function renderReel(reelIdx) {
    const reel = REELS[reelIdx];
    const len  = reel.length;
    const mid  = reelIndices[reelIdx];
    const top  = (mid - 1 + len) % len;
    const bot  = (mid + 1) % len;
    setCell(reelIdx, 0, reel[top]);
    setCell(reelIdx, 1, reel[mid]);
    setCell(reelIdx, 2, reel[bot]);
}

/**
 * Trigger the white stop-flash animation on a single payline cell.
 * Used to draw the eye to a reel the instant it locks.
 *
 * The remove → reflow → add dance restarts the CSS animation cleanly
 * even when the class is already present from a previous spin. Reading
 * `offsetWidth` forces the browser to commit the class removal before
 * we re-add it, so the @keyframes restarts from 0% instead of being
 * treated as a no-op.
 */
function flashPaylineCell(reelIdx) {
    const cell = displayEl.querySelector(
        `.cell.payline[data-reel="${reelIdx}"]`
    );
    cell.classList.remove("stop-flash");
    void cell.offsetWidth;
    cell.classList.add("stop-flash");
}

/**
 * Trigger the win-burst animation on the whole 3x3 display, colored to
 * match the paying symbol.
 *
 * The color is passed into CSS via the --win-glow custom property — a
 * single @keyframes rule handles every symbol's color by reading the
 * variable rather than us having to author one keyframe per color.
 * Uses the same remove → reflow → add pattern as flashPaylineCell so the
 * animation restarts cleanly on back-to-back wins.
 */
function triggerWinBurst(rgb) {
    if (!rgb) return;  // wild/blank never pay — defensive bail
    displayEl.style.setProperty("--win-glow", rgb);
    displayEl.classList.remove("win-burst");
    void displayEl.offsetWidth;
    displayEl.classList.add("win-burst");
}

/**
 * Flash the win amount as large glowing text over the center of the
 * 3x3 display. Coloring matches the paying symbol via --win-glow (same
 * variable the win-burst halo uses). Same remove → reflow → add idiom
 * as the other animation triggers so back-to-back wins replay cleanly.
 */
function triggerWinAmount(amount, rgb) {
    if (!rgb) return;                 // wild/blank never pay
    winAmountOverlayEl.style.setProperty("--win-glow", rgb);
    winAmountOverlayEl.textContent = formatCurrency(amount);
    winAmountOverlayEl.classList.remove("show");
    void winAmountOverlayEl.offsetWidth;
    winAmountOverlayEl.classList.add("show");
}

/** Render all three reels (used at page load and on resets). */
function renderAllReels() {
    for (let i = 0; i < REELS.length; i++) renderReel(i);
}

/** Format a number as a USD currency string. */
function formatCurrency(amount) {
    return "$" + amount.toFixed(2);
}

function updateCreditsDisplay() {
    creditsValueEl.textContent = formatCurrency(credits);
}

function setWinMessage(text, hasWin) {
    // Non-breaking space keeps the line height stable when no message is shown.
    winDisplayEl.innerHTML = text || "&nbsp;";
    winDisplayEl.classList.toggle("has-win", !!hasWin);
}


/* =========================================================================
   Bonus feature (lossback free-spins + INVERT)
   -------------------------------------------------------------------------
   - Every losing base spin pushes one charge onto the progress bar.
   - When the bar fills (BONUS_TRIGGER_LOSSES charges), .ready is added and
     the bar becomes clickable.
   - Clicking the bar resets lossCount, applies the INVERT visual state to
     <body>, and auto-runs BONUS_FREE_SPINS free spins paced by the
     FREE_SPIN_GAP_MS / *_DELAY_MS constants — the player doesn't click
     anything during the bonus.
   - Free-spin losses do NOT advance lossCount (no re-trigger, matching the
     notebook's FREE_SPINS_RETRIGGER = False setting).
   ========================================================================= */

/** Repaint the progress bar to match current lossCount and isBonusReady.
 *  The fill is a single element whose height is a percentage of the bar's
 *  full height — the CSS transition on .progress-fill { height } gives a
 *  smooth growth on each loss and a smooth drain on activation. */
function renderProgressBar() {
    const pct = (lossCount / BONUS_TRIGGER_LOSSES) * 100;
    progressFillEl.style.height = pct + "%";
    progressBarEl.classList.toggle("ready", isBonusReady);
}

/** Enter INVERT mode: photographic-negative the entire page via a CSS filter. */
function enterInvertMode() {
    document.body.classList.add("inverted");
}

/** Leave INVERT mode. The 400ms CSS transition handles the visual ease-out. */
function exitInvertMode() {
    document.body.classList.remove("inverted");
}

/**
 * Player activated the bonus (clicked the full progress bar).
 * Empties the bar, kicks off the INVERT transition, and after a short
 * delay starts the free-spin chain.
 */
function activateBonus() {
    // Guard: only valid when the bar is full AND no spin is in flight AND
    // we're not already in a bonus.
    if (!isBonusReady || isSpinning || freeSpinsRemaining > 0) return;

    playSound("invert_click");

    isBonusReady = false;
    lossCount = 0;
    freeSpinsRemaining = BONUS_FREE_SPINS;
    bonusTotalWinnings = 0;            // fresh tally for this bonus
    renderProgressBar();
    enterInvertMode();

    // Spin button is locked out for the entire bonus — free spins auto-play.
    spinButtonEl.disabled = true;

    setWinMessage(`BONUS — ${BONUS_FREE_SPINS} FREE SPINS`, true);
    setTimeout(() => spin(true), BONUS_ENTRY_DELAY_MS);
}


/* =========================================================================
   Sidebar (menu + pay table)
   -------------------------------------------------------------------------
   The sidebar slides over from the right when the player clicks MENU.
   It overlays the game but does NOT block clicks beneath it — the game
   stays interactive while the menu is open.
   The sidebar holds a two-pane interior: a top-level menu list, and the
   pay-table sub-view. Only one is visible at a time (toggled via the
   [hidden] attribute). The pay-table rows are built from the SYMBOLS
   table at view-open time, so a paytable retune in one place updates
   both gameplay scoring and this readout.
   ========================================================================= */

/**
 * Build a single pay-table row: glowing symbol image + colored name +
 * payout value. The .symbol-* class on the row picks up the per-symbol
 * color/glow rules from style.css.
 *
 * `name` and `valueText` are passed explicitly so the wild row can use
 * a custom description ("WILD + ANY 2 MATCHING") and a phrase value
 * ("DOUBLES 3OAK") instead of the regular symbol-name + multiplier.
 */
function makePayTableRow(sym, name, valueText) {
    const row = document.createElement("div");
    row.className = "paytable-row " + sym.cssClass;

    const img = document.createElement("img");
    img.className = "paytable-symbol";
    img.src = sym.image;
    img.alt = sym.name;

    const nameEl = document.createElement("span");
    nameEl.className = "paytable-name";
    nameEl.textContent = name;

    const valueEl = document.createElement("span");
    valueEl.className = "paytable-value";
    valueEl.textContent = valueText;

    row.append(img, nameEl, valueEl);
    return row;
}

/** Convenience: a regular paying-symbol row whose name is the symbol's
 *  plural name and whose value is "N.N×" (one decimal, matching the
 *  design doc's "1.5x / 2.0x / 5.0x / 50.0x" style). */
function makePaySymbolRow(sym, multiplier) {
    return makePayTableRow(
        sym,
        sym.name.toUpperCase(),
        multiplier.toFixed(1) + "×"       // U+00D7
    );
}

/**
 * Populate the pay-table view from SYMBOLS. Called lazily whenever the
 * pay-table sub-view is opened (rebuild is cheap and keeps the readout
 * in lockstep with any paytable retune).
 */
function buildPayTable() {
    paytable3oakRowsEl.innerHTML = "";
    paytable2oakRowsEl.innerHTML = "";
    paytableWildRowsEl.innerHTML = "";

    // Order matters: lowest-to-highest tier reads naturally for a paytable.
    const payingSymbolIds = [1, 2, 3, 4];

    for (const id of payingSymbolIds) {
        const sym = symbolFor(id);
        // Every paying symbol has a 3-of-a-kind value.
        paytable3oakRowsEl.appendChild(makePaySymbolRow(sym, sym.pay3));
        // 2-of-a-kind: skip symbols where pay2 is 0 (lemons by design).
        if (sym.pay2 > 0) {
            paytable2oakRowsEl.appendChild(makePaySymbolRow(sym, sym.pay2));
        }
    }

    // Wild row — uses the same row layout as the regular symbols, but with
    // a descriptive name + a phrase value that captures "doubles the 3oak
    // payout" without having to pin a single multiplier number to it.
    paytableWildRowsEl.appendChild(
        makePayTableRow(
            symbolFor(WILD_ID),
            "WILD + ANY 2 MATCHING",
            "2x Winnings Multiplier"
        )
    );
}

/**
 * Switch the sidebar's interior between the top-level menu and a sub-view.
 * Updates the header (title + visibility of the back button) to match.
 */
function showSidebarView(viewName) {
    if (viewName === "menu") {
        sidebarMenuEl.hidden = false;
        sidebarPaytableEl.hidden = true;
        sidebarTitleEl.textContent = "MENU";
        sidebarBackEl.hidden = true;
    } else if (viewName === "paytable") {
        sidebarMenuEl.hidden = true;
        sidebarPaytableEl.hidden = false;
        sidebarTitleEl.textContent = "PAY TABLE";
        sidebarBackEl.hidden = false;
        buildPayTable();
    }
}

function openSidebar() {
    sidebarEl.classList.add("open");
    sidebarEl.setAttribute("aria-hidden", "false");
    showSidebarView("menu");   // always open at the top-level menu
}

function closeSidebar() {
    sidebarEl.classList.remove("open");
    sidebarEl.setAttribute("aria-hidden", "true");
}


/* =========================================================================
   Pay evaluation
   -------------------------------------------------------------------------
   Mirrors the three rule functions from the math notebook. Rules are
   evaluated in priority order; the first rule that scores claims the spin.
   ========================================================================= */

/**
 * Given the three payline symbols (one per reel), return either
 *   { payout, type, paySymbol }   if there is a win, or
 *   { payout: 0 }                 if the spin is a loss.
 */
function evaluatePayline(s1, s2, s3) {
    const symbols = [s1, s2, s3];

    // --- Rule 1: pure 3 of a kind on a paying symbol. ---
    //     A symbol "pays 3oak" iff its pay3 entry in SYMBOLS is > 0.
    if (s1 === s2 && s2 === s3 && symbolFor(s1).pay3 > 0) {
        return {
            payout:    symbolFor(s1).pay3 * BET,
            type:      "3-of-a-kind",
            paySymbol: s1,
        };
    }

    // --- Rule 2: wild substitution. Exactly one wild + two matching non-wilds. ---
    const wildCount = symbols.filter(s => s === WILD_ID).length;
    if (wildCount === 1) {
        const nonWilds = symbols.filter(s => s !== WILD_ID);
        if (nonWilds[0] === nonWilds[1] && symbolFor(nonWilds[0]).pay3 > 0) {
            return {
                payout:    symbolFor(nonWilds[0]).pay3 * WILD_MULTIPLIER * BET,
                type:      "wild substitute",
                paySymbol: nonWilds[0],
            };
        }
        // One wild but the other two don't match a paying symbol — no payout.
        return { payout: 0 };
    }

    // Two or three wilds is explicitly NOT a paying combination (per the math notebook).
    if (wildCount >= 2) return { payout: 0 };

    // --- Rule 3: two of a kind. Exactly two non-wild positions match,
    //     and the matched symbol must have a non-zero pay2 entry
    //     (so lemons & blanks are excluded). Position-agnostic. ---
    let matchedSymbol = null;
    if      (s1 === s2 && s1 !== s3) matchedSymbol = s1;
    else if (s1 === s3 && s1 !== s2) matchedSymbol = s1;
    else if (s2 === s3 && s2 !== s1) matchedSymbol = s2;

    if (matchedSymbol !== null && symbolFor(matchedSymbol).pay2 > 0) {
        return {
            payout:    symbolFor(matchedSymbol).pay2 * BET,
            type:      "2-of-a-kind",
            paySymbol: matchedSymbol,
        };
    }

    return { payout: 0 };
}


/* =========================================================================
   Spin sequencing
   ========================================================================= */

/**
 * Pick a uniformly random stop index on the given reel.
 * Equal probability per stop is exactly the model the math notebook uses.
 */
function pickRandomStop(reelIdx) {
    return Math.floor(Math.random() * REELS[reelIdx].length);
}

/**
 * Kick off one spin.
 *  - Deducts the bet up front (unless this is a free spin).
 *  - Spins all three reels visually (rapid symbol tumble).
 *  - Stops them in middle-left-right order per the GDD.
 *  - Evaluates the payline once the right reel comes to rest.
 *
 * @param {boolean} isFreeSpin  When true, no bet is deducted and losing
 *                              outcomes do not advance the lossback bar
 *                              (matches the notebook's FREE_SPINS_RETRIGGER
 *                              = False setting).
 */
function spin(isFreeSpin = false) {
    if (isSpinning) return;

    if (!isFreeSpin) {
        // Player-initiated paid spin: cost check + bet deduction.
        if (credits < BET) {
            setWinMessage("INSUFFICIENT CREDITS", false);
            return;
        }
        credits -= BET;
        updateCreditsDisplay();
        setWinMessage("", false);
    } else {
        // Free spin: show which one we're on (1-indexed for the readout).
        const idx = BONUS_FREE_SPINS - freeSpinsRemaining + 1;
        setWinMessage(`FREE SPIN ${idx} / ${BONUS_FREE_SPINS}`, true);
    }

    // Spin-click fires on both paid and free spins. The insufficient-credits
    // early return above keeps it silent on rejected paid clicks.
    playSound("spin_click");

    isSpinning = true;
    spinButtonEl.disabled = true;

    // Resolve the spin's outcome up front by picking each reel's final stop now.
    // The visual tumble is animation only — it doesn't affect the math.
    const finalStops = [pickRandomStop(0), pickRandomStop(1), pickRandomStop(2)];

    // Start each reel "tumbling" — cycling through random symbols on a tick.
    // We store the interval handles so we can stop each reel independently.
    const tumbleIntervals = REELS.map((_reel, i) => {
        return setInterval(() => {
            reelIndices[i] = pickRandomStop(i);
            renderReel(i);
        }, TUMBLE_TICK_MS);
    });

    // Helper: stop a single reel by clearing its tumble interval, locking
    // it to its predetermined final index, flashing its payline cell, and
    // playing the reel-stop sound.
    const stopReel = (reelIdx) => {
        clearInterval(tumbleIntervals[reelIdx]);
        reelIndices[reelIdx] = finalStops[reelIdx];
        renderReel(reelIdx);
        flashPaylineCell(reelIdx);
        playSound("reel_stop");
    };

    // Schedule the staggered stops in middle-left-right order.
    setTimeout(() => stopReel(1), STOP_DELAY_MIDDLE_MS);  // reel 2: middle
    setTimeout(() => stopReel(0), STOP_DELAY_LEFT_MS);    // reel 1: left
    setTimeout(() => {                                    // reel 3: right (last)
        stopReel(2);
        finishSpin(finalStops, isFreeSpin);
    }, STOP_DELAY_RIGHT_MS);
}

/**
 * After the final reel has come to rest, evaluate the payline,
 * apply payouts, and re-enable the spin button.
 */
function finishSpin(finalStops, isFreeSpin) {
    const s1 = REELS[0][finalStops[0]];
    const s2 = REELS[1][finalStops[1]];
    const s3 = REELS[2][finalStops[2]];

    const result = evaluatePayline(s1, s2, s3);
    const won = result.payout > 0;

    if (won) {
        credits += result.payout;
        updateCreditsDisplay();
        if (isFreeSpin) bonusTotalWinnings += result.payout;
        const sym = symbolFor(result.paySymbol);
        // During the bonus, prefix the win line with the free-spin index so
        // the readout still tells the player where they are in the bonus.
        const prefix = isFreeSpin
            ? `FREE SPIN ${BONUS_FREE_SPINS - freeSpinsRemaining + 1} / ${BONUS_FREE_SPINS} — `
            : "";
        setWinMessage(
            `${prefix}WIN ${formatCurrency(result.payout)} — ${result.type} (${sym.name})`,
            true
        );
        triggerWinBurst(sym.glowRGB);
        triggerWinAmount(result.payout, sym.glowRGB);
        // Win sound is keyed off the rule that scored. Three distinct cues
        // so the player hears which kind of win they landed.
        if      (result.type === "3-of-a-kind")    playSound("win_3oak");
        else if (result.type === "wild substitute") playSound("win_wild");
        else if (result.type === "2-of-a-kind")    playSound("win_2oak");
    } else if (!isFreeSpin) {
        setWinMessage("NO WIN", false);
        playSound("miss_result");
    }
    // (For a losing FREE SPIN we leave the existing "FREE SPIN N / M" message
    //  in place rather than overwriting it with "NO WIN".)

    isSpinning = false;

    // Update the bonus state machine. Losing paid spins charge the bar;
    // free-spin losses do not (no re-triggers).
    if (!isFreeSpin && !won) {
        if (lossCount < BONUS_TRIGGER_LOSSES) {
            lossCount++;
            if (lossCount >= BONUS_TRIGGER_LOSSES) {
                isBonusReady = true;
                playSound("invert_available");   // bar just filled — invite the click
            }
            renderProgressBar();
        }
    }

    // Drive the free-spin chain or exit the bonus.
    if (isFreeSpin) {
        freeSpinsRemaining--;
        if (freeSpinsRemaining > 0) {
            setTimeout(() => spin(true), FREE_SPIN_GAP_MS);
        } else {
            // Last free spin done. Let the final result breathe before reverting INVERT.
            // If the bonus paid anything in aggregate, summarize the total
            // for the player; otherwise just confirm the bonus ended.
            setTimeout(() => {
                exitInvertMode();
                if (bonusTotalWinnings > 0) {
                    setWinMessage(
                        `BONUS COMPLETE — TOTAL ${formatCurrency(bonusTotalWinnings)}`,
                        true
                    );
                } else {
                    setWinMessage("BONUS COMPLETE", false);
                }
                spinButtonEl.disabled = false;
            }, BONUS_EXIT_DELAY_MS);
        }
    } else {
        // Normal paid spin: hand control back to the player.
        spinButtonEl.disabled = false;
    }
}


/* =========================================================================
   Event wiring + initial render
   ========================================================================= */

// Paid spin trigger. spin() defaults isFreeSpin=false, which is what we want.
spinButtonEl.addEventListener("click", () => spin(false));

addCreditsBtnEl.addEventListener("click", () => {
    credits += ADD_CREDITS_AMOUNT;
    updateCreditsDisplay();
});

// The progress bar itself is the activation affordance — clicking it when
// .ready triggers the bonus. activateBonus() gates on isBonusReady so
// stray clicks before the bar is full are no-ops.
progressBarEl.addEventListener("click", activateBonus);

// Sidebar wiring. The menu-list uses event delegation so adding more
// items later only requires another <button data-view="..."> in the HTML.
menuButtonEl.addEventListener("click", openSidebar);
sidebarCloseEl.addEventListener("click", closeSidebar);
sidebarBackEl.addEventListener("click", () => showSidebarView("menu"));
sidebarMenuEl.addEventListener("click", (e) => {
    const item = e.target.closest("[data-view]");
    if (item) showSidebarView(item.dataset.view);
});

// Audio toggles. The button reads "ON" or "OFF" depending on the .on class.
// Clicking flips the class, the visible label, the aria-pressed state, and
// the underlying mute setting in sounds.js. Both default to ON.
function bindAudioToggle(buttonEl, setMutedFn) {
    buttonEl.addEventListener("click", () => {
        const turningOff = buttonEl.classList.contains("on");
        buttonEl.classList.toggle("on", !turningOff);
        buttonEl.classList.toggle("off", turningOff);
        buttonEl.textContent = turningOff ? "OFF" : "ON";
        buttonEl.setAttribute("aria-pressed", String(!turningOff));
        setMutedFn(turningOff);
    });
}
bindAudioToggle(toggleBgmEl, setMusicMuted);
bindAudioToggle(toggleSfxEl, setSfxMuted);

// First paint: show the starting credits, a default reel position, and
// the empty progress bar.
updateCreditsDisplay();
renderAllReels();
renderProgressBar();

// Start the looping background music. Browsers gate autoplay on a user
// gesture, so this initial call will be silently held until the player's
// first click (typically the spin button); Howler's auto-unlock pipes the
// queued music start through at that moment. The MUSIC_FADE_MS crossfade
// in sounds.js gives the music a smooth 600ms entry rather than a hard cut.
setMusic("bgm");
