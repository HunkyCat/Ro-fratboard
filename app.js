(() => {
  "use strict";

  const NOTE_NAMES_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const BASE_NOTE_TO_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const NOTE_PATTERN = /^\s*([A-Ga-g])([#b]?)(-?\d*)\s*$/;

  const CAGED_STAGE_WINDOWS = {
    C: [-3, 1],
    A: [-1, 3],
    G: [1, 5],
    E: [4, 8],
    D: [6, 10],
  };

  const SCALE_INTERVALS = {
    "Major": [0, 2, 4, 5, 7, 9, 11],
    "Natural Minor": [0, 2, 3, 5, 7, 8, 10],
    "Harmonic Minor": [0, 2, 3, 5, 7, 8, 11],
    "Melodic Minor": [0, 2, 3, 5, 7, 9, 11],
    "Major Pentatonic": [0, 2, 4, 7, 9],
    "Minor Pentatonic": [0, 3, 5, 7, 10],
    "Blues": [0, 3, 5, 6, 7, 10],
    "Dorian": [0, 2, 3, 5, 7, 9, 10],
    "Phrygian": [0, 1, 3, 5, 7, 8, 10],
    "Lydian": [0, 2, 4, 6, 7, 9, 11],
    "Mixolydian": [0, 2, 4, 5, 7, 9, 10],
    "Locrian": [0, 1, 3, 5, 6, 8, 10],
  };

  const TUNING_PRESETS = {
    "Standard (E)": ["E2", "A2", "D3", "G3", "B3", "E4"],
    "D Standard": ["D2", "G2", "C3", "F3", "A3", "D4"],
    "Drop D": ["D2", "A2", "D3", "G3", "B3", "E4"],
    "Open G": ["D2", "G2", "D3", "G3", "B3", "D4"],
    "Open D": ["D2", "A2", "D3", "F#3", "A3", "D4"],
  };

  const STRING_COLORS = ["#dc2626", "#facc15", "#2563eb", "#f97316", "#16a34a", "#7c3aed"];
  const INLAY_FRETS = new Set([3, 5, 7, 9, 12]);
  const STANDARD_STRING_MIDI = [40, 45, 50, 55, 59, 64];
  const STANDARD_STRING_OCTAVE = [2, 2, 3, 3, 3, 4];

  const rootSelect = document.getElementById("root");
  const scaleSelect = document.getElementById("scale");
  const tuningSelect = document.getElementById("tuning");
  const customTuningInput = document.getElementById("custom_tuning");
  const modeSelect = document.getElementById("mode");
  const cagedStageSelect = document.getElementById("caged_stage");
  const fretsInput = document.getElementById("frets");
  const statusEl = document.getElementById("status");
  const modeHintEl = document.getElementById("modeHint");
  const controlsPanel = document.getElementById("controlsPanel");
  const menuToggle = document.getElementById("menuToggle");
  const randomRiffBtn = document.getElementById("randomRiffBtn");
  const riffStatusEl = document.getElementById("riffStatus");
  const canvas = document.getElementById("fretboardCanvas");

  let renderTimeout = null;
  let audioCtx = null;
  let pickNoiseBuffer = null;
  let riffCleanupTimer = null;
  let currentHighlight = null;
  const riffVisualTimers = [];
  const activeRiffNodes = [];

  const DISTORTION_CURVE = buildDistortionCurve(420);
  const RIFF_BANK = buildRiffBank();

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function populateSelect(select, values, selected) {
    select.innerHTML = "";
    for (const value of values) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      option.selected = value === selected;
      select.appendChild(option);
    }
  }

  function populateControls() {
    populateSelect(rootSelect, NOTE_NAMES_SHARP, "C");
    populateSelect(scaleSelect, Object.keys(SCALE_INTERVALS), "Major");
    populateSelect(tuningSelect, [...Object.keys(TUNING_PRESETS), "Custom"], "Standard (E)");
    modeSelect.value = "full";
    cagedStageSelect.value = "C";
    fretsInput.value = "12";
  }

  function isMobileView() {
    return window.matchMedia("(max-width: 1100px)").matches;
  }

  function setPanelOpen(open) {
    controlsPanel.dataset.open = open ? "true" : "false";
    menuToggle.setAttribute("aria-expanded", String(open));
  }

  function syncPanelWithViewport() {
    setPanelOpen(!isMobileView());
  }

  function toggleCustomTuning() {
    const isCustom = tuningSelect.value === "Custom";
    customTuningInput.disabled = !isCustom;
    if (!isCustom) customTuningInput.value = "";
  }

  function toggleCagedControls() {
    cagedStageSelect.disabled = modeSelect.value !== "caged";
  }

  function updateModeHint(state) {
    const mode = state ? state.mode : modeSelect.value;
    if (mode === "caged") {
      const stage = state ? state.cagedStage : cagedStageSelect.value;
      modeHintEl.textContent = `CAGED ${stage}`;
      return;
    }
    modeHintEl.textContent = "Полная";
  }

  function noteToPitchClass(note) {
    const match = String(note || "").match(NOTE_PATTERN);
    if (!match) throw new Error(`Неподдерживаемый формат ноты: ${note}`);

    const letter = match[1].toUpperCase();
    const accidental = match[2].toLowerCase();
    let pitchClass = BASE_NOTE_TO_PC[letter];
    if (accidental === "#") pitchClass += 1;
    if (accidental === "b") pitchClass -= 1;
    return ((pitchClass % 12) + 12) % 12;
  }

  function normalizeNoteName(note) {
    return NOTE_NAMES_SHARP[noteToPitchClass(note)];
  }

  function parseCustomTuning(raw) {
    const tokens = String(raw || "").trim().split(/[\s,;/]+/).filter(Boolean);
    if (tokens.length !== 6) throw new Error("Свой строй: ровно 6 нот (пример: D G C F A D)");
    return {
      rawNotes: tokens,
      displayNotes: tokens.map((token) => normalizeNoteName(token)),
    };
  }

  function resolveTuning(tuningName, customRaw) {
    if (tuningName === "Custom") return parseCustomTuning(customRaw);
    const preset = TUNING_PRESETS[tuningName] || TUNING_PRESETS["Standard (E)"];
    return {
      rawNotes: [...preset],
      displayNotes: preset.map((token) => normalizeNoteName(token)),
    };
  }

  function scalePitchClasses(rootNote, scaleName) {
    const rootPc = noteToPitchClass(rootNote);
    const intervals = SCALE_INTERVALS[scaleName] || SCALE_INTERVALS["Major"];
    return new Set(intervals.map((interval) => (rootPc + interval) % 12));
  }

  function clampFrets(rawFrets) {
    const parsed = Number.parseInt(rawFrets, 10);
    return Number.isFinite(parsed) ? clamp(parsed, 12, 24) : 12;
  }

  function normalizeViewMode(rawMode) {
    return String(rawMode || "").toLowerCase() === "caged" ? "caged" : "full";
  }

  function normalizeCagedStage(rawStage) {
    const stage = String(rawStage || "C").toUpperCase();
    return Object.prototype.hasOwnProperty.call(CAGED_STAGE_WINDOWS, stage) ? stage : "C";
  }

  function cagedStageVisibility(rootPc, tuningNotes, stage, frets) {
    const rootPositions = tuningNotes.map((openNote) => ((rootPc - noteToPitchClass(openNote)) % 12 + 12) % 12);
    const anchorFret = Math.min(...rootPositions);
    const [offsetStart, offsetEnd] = CAGED_STAGE_WINDOWS[stage];
    const clippedStart = Math.max(0, anchorFret + offsetStart);
    const clippedEnd = Math.min(frets, anchorFret + offsetEnd);

    if (clippedStart > clippedEnd) {
      return { visibleFrets: new Set(), windows: [] };
    }

    const visibleFrets = new Set();
    for (let fret = clippedStart; fret <= clippedEnd; fret += 1) visibleFrets.add(fret);
    return { visibleFrets, windows: [[clippedStart, clippedEnd]] };
  }

  function parseNoteToMidi(note, stringIndex) {
    const match = String(note || "").match(NOTE_PATTERN);
    if (!match) return STANDARD_STRING_MIDI[stringIndex];

    const pitchClass = noteToPitchClass(`${match[1]}${match[2]}`);
    const octaveRaw = match[3];
    const octave = octaveRaw === "" ? STANDARD_STRING_OCTAVE[stringIndex] : Number.parseInt(octaveRaw, 10);
    if (!Number.isFinite(octave)) return STANDARD_STRING_MIDI[stringIndex];

    return ((octave + 1) * 12) + pitchClass;
  }

  function midiToFrequency(midi) {
    return 440 * (2 ** ((midi - 69) / 12));
  }

  function fitFretToVisibleRange(fret, maxFrets) {
    let value = Math.max(0, Number.parseInt(fret, 10) || 0);
    while (value > maxFrets && value - 12 >= 0) value -= 12;
    return clamp(value, 0, maxFrets);
  }

  function getCurrentState() {
    const root = NOTE_NAMES_SHARP.includes(rootSelect.value) ? rootSelect.value : "C";
    const scale = Object.prototype.hasOwnProperty.call(SCALE_INTERVALS, scaleSelect.value) ? scaleSelect.value : "Major";
    const tuningName = tuningSelect.value;
    const frets = clampFrets(fretsInput.value);
    const mode = normalizeViewMode(modeSelect.value);
    const cagedStage = normalizeCagedStage(cagedStageSelect.value);

    if (String(fretsInput.value) !== String(frets)) fretsInput.value = String(frets);

    const tuning = resolveTuning(tuningName, customTuningInput.value.trim());
    return {
      root,
      rootPc: noteToPitchClass(root),
      scale,
      tuningName,
      rawTuningNotes: tuning.rawNotes,
      tuningDisplayNotes: tuning.displayNotes,
      frets,
      mode,
      cagedStage,
    };
  }

  function applyFretResponsiveLayout() {
    const frets = clampFrets(fretsInput.value);
    const extraFrets = Math.max(3, frets - 12);
    const extraWidth = extraFrets * 34;
    const stageHeight = Math.min(600, 500 + (extraFrets * 7));
    document.documentElement.style.setProperty("--fret-extra-width", `${extraWidth}px`);
    document.documentElement.style.setProperty("--fret-stage-height", `${stageHeight}px`);
  }

  function prepareCanvas() {
    const rect = canvas.getBoundingClientRect();
    const cssWidth = Math.max(1, Math.floor(rect.width));
    const cssHeight = Math.max(1, Math.floor(rect.height));
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const pixelWidth = Math.floor(cssWidth * dpr);
    const pixelHeight = Math.floor(cssHeight * dpr);

    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    return { ctx, width: cssWidth, height: cssHeight };
  }

  function roundedRectPath(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }

  function drawFitText(ctx, text, x, y, maxWidth, baseSize, color, weight = 700) {
    let size = baseSize;
    while (size > 10) {
      ctx.font = `${weight} ${size}px Rajdhani, Segoe UI, sans-serif`;
      if (ctx.measureText(text).width <= maxWidth) break;
      size -= 1;
    }
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x, y);
  }

  function computeLayout(width, height, frets) {
    const topBand = clamp(height * 0.12, 44, 62);
    const bottomBand = clamp(height * 0.14, 50, 70);
    const leftBand = clamp(width * 0.055, 44, 74);
    const rightBand = clamp(width * 0.16, 130, 230);

    let plotLeft = leftBand;
    let plotRight = width - rightBand;
    if (plotRight - plotLeft < 320) {
      plotLeft = 24;
      plotRight = width - 100;
    }

    const plotTop = topBand;
    const plotBottom = height - bottomBand;
    const fretWidth = (plotRight - plotLeft) / Math.max(1, frets);
    const stringTop = plotTop + clamp((plotBottom - plotTop) * 0.09, 16, 36);
    const stringBottom = plotBottom - clamp((plotBottom - plotTop) * 0.08, 16, 32);
    const stringGap = (stringBottom - stringTop) / 5;

    return {
      plotLeft,
      plotRight,
      plotTop,
      plotBottom,
      fretWidth,
      stringTop,
      stringBottom,
      stringGap,
      boardLeft: Math.max(8, plotLeft - (fretWidth * 0.6)),
      boardRight: plotRight,
      boardTop: stringTop - (stringGap * 0.52),
      boardBottom: stringBottom + (stringGap * 0.52),
    };
  }

  function xForFretLine(layout, fret) {
    return layout.plotLeft + (fret * layout.fretWidth);
  }

  function xForNote(layout, fret) {
    return fret === 0 ? layout.plotLeft - (layout.fretWidth * 0.26) : layout.plotLeft + ((fret - 0.5) * layout.fretWidth);
  }

  function yForStringIndex(layout, stringIndex) {
    return layout.stringTop + (layout.stringGap * stringIndex);
  }

  function drawPlaceholder(message) {
    const { ctx, width, height } = prepareCanvas();
    const bg = ctx.createLinearGradient(0, 0, 0, height);
    bg.addColorStop(0, "#0b1220");
    bg.addColorStop(1, "#111827");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);
    drawFitText(ctx, message, width / 2, height / 2, width - 40, 24, "#fca5a5", 700);
  }

  function renderFretboard() {
    try {
      const state = getCurrentState();
      statusEl.textContent = "";
      updateModeHint(state);

      const { ctx, width, height } = prepareCanvas();
      const layout = computeLayout(width, height, state.frets);
      const scalePcs = scalePitchClasses(state.root, state.scale);

      let visibleFrets = null;
      let cagedWindows = [];
      if (state.mode === "caged") {
        const caged = cagedStageVisibility(state.rootPc, state.tuningDisplayNotes, state.cagedStage, state.frets);
        visibleFrets = caged.visibleFrets;
        cagedWindows = caged.windows;
      }

      const pageBg = ctx.createLinearGradient(0, 0, 0, height);
      pageBg.addColorStop(0, "#0b1220");
      pageBg.addColorStop(1, "#111827");
      ctx.fillStyle = pageBg;
      ctx.fillRect(0, 0, width, height);

      roundedRectPath(ctx, layout.boardLeft, layout.boardTop, layout.boardRight - layout.boardLeft, layout.boardBottom - layout.boardTop, 14);
      ctx.save();
      ctx.clip();

      const boardGradient = ctx.createLinearGradient(layout.boardLeft, layout.boardTop, layout.boardRight, layout.boardBottom);
      boardGradient.addColorStop(0, "#0f172a");
      boardGradient.addColorStop(0.45, "#111827");
      boardGradient.addColorStop(1, "#1e293b");
      ctx.fillStyle = boardGradient;
      ctx.fillRect(layout.boardLeft, layout.boardTop, layout.boardRight - layout.boardLeft, layout.boardBottom - layout.boardTop);

      for (let fret = 0; fret < state.frets; fret += 1) {
        if (fret % 2 === 1) {
          const x0 = xForFretLine(layout, fret);
          const x1 = xForFretLine(layout, fret + 1);
          ctx.fillStyle = "rgba(147, 197, 253, 0.035)";
          ctx.fillRect(x0, layout.boardTop, x1 - x0, layout.boardBottom - layout.boardTop);
        }
      }

      for (const [start, end] of cagedWindows) {
        const left = Math.max(layout.boardLeft, xForFretLine(layout, start) - (layout.fretWidth * 0.5));
        const right = Math.min(layout.boardRight, xForFretLine(layout, end) + (layout.fretWidth * 0.5));
        ctx.fillStyle = "rgba(245, 158, 11, 0.09)";
        ctx.fillRect(left, layout.boardTop, right - left, layout.boardBottom - layout.boardTop);
      }

      ctx.restore();

      for (let stringIndex = 0; stringIndex < 6; stringIndex += 1) {
        const y = yForStringIndex(layout, stringIndex);
        ctx.strokeStyle = STRING_COLORS[stringIndex];
        ctx.lineWidth = 2.9;
        ctx.globalAlpha = 0.95;
        ctx.beginPath();
        ctx.moveTo(xForFretLine(layout, 0), y);
        ctx.lineTo(xForFretLine(layout, state.frets), y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      const fretLineTop = layout.stringTop - (layout.stringGap * 0.44);
      const fretLineBottom = layout.stringBottom + (layout.stringGap * 0.44);

      for (let fret = 0; fret <= state.frets; fret += 1) {
        const x = xForFretLine(layout, fret);
        ctx.strokeStyle = fret === 0 ? "#e2e8f0" : "#94a3b8";
        ctx.lineWidth = fret === 0 ? 4.4 : 1.4;
        ctx.beginPath();
        ctx.moveTo(x, fretLineTop);
        ctx.lineTo(x, fretLineBottom);
        ctx.stroke();

        if (INLAY_FRETS.has(fret) && fret !== 12) {
          const markerX = xForNote(layout, fret);
          const markerY = (layout.stringTop + layout.stringBottom) / 2;
          ctx.fillStyle = "rgba(56, 189, 248, 0.24)";
          ctx.beginPath();
          ctx.arc(markerX, markerY, 9, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "rgba(248, 250, 252, 0.72)";
          ctx.beginPath();
          ctx.arc(markerX, markerY, 4.2, 0, Math.PI * 2);
          ctx.fill();
        }

        if (fret === 12) {
          const markerX = xForNote(layout, fret);
          const topY = (layout.stringTop + layout.stringBottom) / 2 - layout.stringGap;
          const bottomY = (layout.stringTop + layout.stringBottom) / 2 + layout.stringGap;
          for (const markerY of [topY, bottomY]) {
            ctx.fillStyle = "rgba(56, 189, 248, 0.24)";
            ctx.beginPath();
            ctx.arc(markerX, markerY, 9, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "rgba(248, 250, 252, 0.72)";
            ctx.beginPath();
            ctx.arc(markerX, markerY, 4.2, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      const baseRadius = clamp(Math.min(layout.fretWidth, layout.stringGap) * 0.3, 10, 16);
      const noteFontSize = clamp(baseRadius * 1.02, 11, 15);

      for (let stringIndex = 0; stringIndex < 6; stringIndex += 1) {
        const y = yForStringIndex(layout, stringIndex);
        const openPc = noteToPitchClass(state.tuningDisplayNotes[stringIndex]);
        for (let fret = 0; fret <= state.frets; fret += 1) {
          const currentPc = (openPc + fret) % 12;
          if (!scalePcs.has(currentPc)) continue;
          if (visibleFrets && !visibleFrets.has(fret)) continue;

          const x = xForNote(layout, fret);
          const noteLabel = NOTE_NAMES_SHARP[currentPc];
          const isRoot = currentPc === state.rootPc;

          if (isRoot) {
            ctx.fillStyle = "rgba(245, 158, 11, 0.2)";
            ctx.beginPath();
            ctx.arc(x, y, baseRadius + 6.5, 0, Math.PI * 2);
            ctx.fill();
          }

          ctx.fillStyle = isRoot ? "#f59e0b" : "#1f2937";
          ctx.strokeStyle = isRoot ? "#fde68a" : "#93c5fd";
          ctx.lineWidth = isRoot ? 2.3 : 1.8;
          ctx.beginPath();
          ctx.arc(x, y, isRoot ? baseRadius + 2 : baseRadius, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = isRoot ? "#111827" : "#e5e7eb";
          ctx.font = `700 ${noteFontSize}px Rajdhani, Segoe UI, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(noteLabel, x, y);
        }
      }
      if (currentHighlight) {
        const stringNum = clamp(Number.parseInt(currentHighlight.string, 10) || 1, 1, 6);
        const stringIndex = 6 - stringNum;
        if (stringIndex >= 0 && stringIndex < 6) {
          const fret = fitFretToVisibleRange(currentHighlight.fret, state.frets);
          const x = xForNote(layout, fret);
          const y = yForStringIndex(layout, stringIndex);
          const openPc = noteToPitchClass(state.tuningDisplayNotes[stringIndex]);
          const noteLabel = NOTE_NAMES_SHARP[(openPc + fret) % 12];

          const glow = ctx.createRadialGradient(x, y, 2, x, y, baseRadius + 18);
          glow.addColorStop(0, "rgba(220, 38, 38, 0.68)");
          glow.addColorStop(0.65, "rgba(251, 146, 60, 0.24)");
          glow.addColorStop(1, "rgba(251, 146, 60, 0)");
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(x, y, baseRadius + 18, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = "#dc2626";
          ctx.strokeStyle = "#fde68a";
          ctx.lineWidth = 2.6;
          ctx.beginPath();
          ctx.arc(x, y, baseRadius + 2.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = "#fef3c7";
          ctx.font = `700 ${clamp(noteFontSize + 1, 12, 16)}px Rajdhani, Segoe UI, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(noteLabel, x, y);
        }
      }

      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      for (let stringIndex = 0; stringIndex < 6; stringIndex += 1) {
        const y = yForStringIndex(layout, stringIndex);
        const stringNum = 6 - stringIndex;
        ctx.fillStyle = STRING_COLORS[stringIndex];
        ctx.font = `700 ${clamp(layout.stringGap * 0.46, 11, 15)}px Rajdhani, Segoe UI, sans-serif`;
        ctx.fillText(`${stringNum} (${state.tuningDisplayNotes[stringIndex]})`, layout.plotRight + 10, y);
      }

      ctx.textAlign = "center";
      ctx.fillStyle = "#cbd5e1";
      ctx.font = "600 13px Rajdhani, Segoe UI, sans-serif";
      for (let fret = 1; fret <= state.frets; fret += 1) {
        ctx.fillText(String(fret), xForNote(layout, fret), layout.plotBottom + 20);
      }

      ctx.fillStyle = "#cbd5e1";
      ctx.font = "600 20px Rajdhani, Segoe UI, sans-serif";
      ctx.fillText("Frets", (layout.plotLeft + layout.plotRight) / 2, height - 14);

      const modeSuffix = state.mode === "caged" ? `Mode: CAGED ${state.cagedStage}` : "Mode: Full Scale";
      const title = `${state.root} ${state.scale} | ${modeSuffix} | Tuning (6->1): ${state.tuningDisplayNotes.join(" ")}`;
      drawFitText(ctx, title, width / 2, layout.plotTop - 20, width - 30, 24, "#f8fafc", 700);
    } catch (error) {
      statusEl.textContent = error instanceof Error ? error.message : "Ошибка рендера";
      drawPlaceholder("Проверь строй и параметры");
    }
  }

  function scheduleRender() {
    if (renderTimeout) clearTimeout(renderTimeout);
    renderTimeout = setTimeout(renderFretboard, 120);
  }

  function randomFloat(min, max) {
    return min + (Math.random() * (max - min));
  }

  function pickEdgePoint(side) {
    if (side === 0) return { x: randomFloat(-26, 126), y: -28 };
    if (side === 1) return { x: 126, y: randomFloat(-20, 110) };
    if (side === 2) return { x: randomFloat(-26, 126), y: 112 };
    return { x: -30, y: randomFloat(-20, 110) };
  }

  function initWorldMotion() {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) return;

    const allItems = Array.from(document.querySelectorAll(".world-layer .world-item"));
    if (allItems.length === 0) return;

    const batItems = allItems.filter((item) => item.classList.contains("bat-fly"));
    const decoItems = allItems.filter((item) => !item.classList.contains("bat-fly"));

    function moveDeco(item, startX, startY) {
      const midX = randomFloat(-22, 110);
      const midY = randomFloat(-22, 108);
      const endX = randomFloat(-22, 110);
      const endY = randomFloat(-22, 108);
      const r0 = randomFloat(-8, 8);
      const r1 = randomFloat(-12, 12);
      const r2 = randomFloat(-10, 10);
      const s0 = randomFloat(0.9, 1.08);
      const s1 = randomFloat(0.92, 1.12);
      const s2 = randomFloat(0.9, 1.08);
      const o0 = randomFloat(0.3, 0.55);
      const o1 = randomFloat(0.36, 0.65);
      const o2 = randomFloat(0.3, 0.55);
      const duration = randomFloat(9000, 21000);
      const delay = randomFloat(0, 1400);

      const anim = item.animate([
        { transform: `translate(${startX}vw, ${startY}vh) rotate(${r0}deg) scale(${s0})`, opacity: o0 },
        { transform: `translate(${midX}vw, ${midY}vh) rotate(${r1}deg) scale(${s1})`, opacity: o1, offset: 0.5 },
        { transform: `translate(${endX}vw, ${endY}vh) rotate(${r2}deg) scale(${s2})`, opacity: o2 },
      ], {
        duration,
        delay,
        easing: "ease-in-out",
        fill: "forwards",
      });

      anim.onfinish = () => moveDeco(item, endX, endY);
    }

    function moveBat(item) {
      const startSide = Math.floor(randomFloat(0, 4));
      let endSide = Math.floor(randomFloat(0, 4));
      if (endSide === startSide) endSide = (startSide + 2) % 4;

      const start = pickEdgePoint(startSide);
      const end = pickEdgePoint(endSide);
      const mid = { x: randomFloat(-22, 116), y: randomFloat(-22, 108) };
      const facing = end.x >= start.x ? 1 : -1;
      const s0 = randomFloat(0.92, 1.28);
      const s1 = randomFloat(0.96, 1.34);
      const s2 = randomFloat(0.9, 1.22);
      const peak = randomFloat(0.48, 0.78);
      const duration = randomFloat(9000, 18000);
      const delay = randomFloat(300, 2800);

      const anim = item.animate([
        { transform: `translate(${start.x}vw, ${start.y}vh) scaleX(${facing}) scale(${s0})`, opacity: 0 },
        { opacity: peak, offset: 0.1 },
        { transform: `translate(${mid.x}vw, ${mid.y}vh) scaleX(${facing}) scale(${s1})`, opacity: peak, offset: 0.52 },
        { transform: `translate(${end.x}vw, ${end.y}vh) scaleX(${facing}) scale(${s2})`, opacity: 0 },
      ], {
        duration,
        delay,
        easing: "linear",
        fill: "forwards",
      });

      anim.onfinish = () => moveBat(item);
    }

    decoItems.forEach((item) => moveDeco(item, randomFloat(-20, 106), randomFloat(-20, 104)));
    batItems.forEach((item) => moveBat(item));
  }

  function buildDistortionCurve(amount) {
    const samples = 44100;
    const curve = new Float32Array(samples);
    const deg = Math.PI / 180;
    for (let i = 0; i < samples; i += 1) {
      const x = (i * 2) / samples - 1;
      curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
    }
    return curve;
  }
  function buildRiffBank() {
    const N = (string, fret, duration, accent = false, palmMute = true) => ({ rest: false, string, fret, duration, accent, palmMute });
    const R = (duration) => ({ rest: true, duration });

    const roots = [
      { label: "E", offset: 0 },
      { label: "F", offset: 1 },
      { label: "G", offset: 3 },
      { label: "A", offset: 5 },
      { label: "B", offset: 7 },
    ];

    const templates = [
      { name: "Pattern 01", bpm: 84, steps: [N(6, 0, 0.34, true, false), N(6, 3, 0.34, false, false), N(6, 5, 0.42, true, false), R(0.12), N(5, 5, 0.32, false, false), N(6, 1, 0.36, true, false), N(6, 0, 0.46, true, false)] },
      { name: "Pattern 02", bpm: 96, steps: [N(6, 0, 0.26, true, false), N(6, 0, 0.22, false, true), N(6, 3, 0.3, true, false), N(6, 2, 0.22, false, false), N(6, 5, 0.34, true, false), R(0.1), N(5, 5, 0.28, false, false), N(6, 0, 0.34, true, false)] },
      { name: "Pattern 03", bpm: 212, steps: [N(6, 0, 0.09, true), N(6, 0, 0.09), N(6, 0, 0.09), N(6, 0, 0.09), N(6, 3, 0.18, true), N(6, 0, 0.09), N(6, 0, 0.09), N(6, 5, 0.2, true), N(5, 5, 0.18), N(6, 3, 0.18), R(0.08)] },
      { name: "Pattern 04", bpm: 198, steps: [N(6, 0, 0.1, true), N(6, 0, 0.1), N(6, 3, 0.16, true), N(6, 0, 0.1), N(6, 0, 0.1), N(6, 5, 0.18, true), N(6, 0, 0.1), N(5, 3, 0.16, false, false), N(5, 5, 0.16, false, false), N(6, 0, 0.22, true)] },
      { name: "Pattern 05", bpm: 186, steps: [N(6, 0, 0.12, true), N(6, 3, 0.12), N(6, 5, 0.12), N(5, 3, 0.14, false, false), N(5, 5, 0.14, false, false), N(6, 0, 0.12, true), N(6, 3, 0.12), N(6, 0, 0.12, true), N(6, 1, 0.16, false, false), N(6, 0, 0.2, true)] },
      { name: "Pattern 06", bpm: 178, steps: [N(6, 0, 0.12, true), N(5, 2, 0.12, false, false), N(5, 3, 0.12, false, false), N(5, 5, 0.14, true, false), N(4, 2, 0.12, false, false), N(4, 4, 0.12, false, false), N(5, 5, 0.16, true, false), N(6, 0, 0.16, true), N(5, 3, 0.16, false, false), N(6, 3, 0.2, true)] },
      { name: "Pattern 07", bpm: 192, steps: [N(6, 0, 0.1, true), N(5, 2, 0.1, false, false), N(5, 3, 0.1, false, false), N(5, 5, 0.1, false, false), N(4, 2, 0.1, false, false), N(4, 4, 0.1, false, false), N(4, 5, 0.12, true, false), N(5, 3, 0.1, false, false), N(6, 0, 0.14, true), R(0.08)] },
      { name: "Pattern 08", bpm: 172, steps: [N(6, 0, 0.14, true), N(6, 1, 0.14, false, false), N(6, 4, 0.16, true, false), N(5, 3, 0.16, false, false), N(5, 6, 0.18, true, false), N(4, 5, 0.16, false, false), N(5, 3, 0.16, false, false), N(6, 1, 0.16, false, false), N(6, 0, 0.22, true)] },
      { name: "Pattern 09", bpm: 182, steps: [N(6, 0, 0.11, true), N(6, 0, 0.11), N(6, 3, 0.16, true), N(5, 2, 0.12, false, false), N(5, 5, 0.16, true, false), N(6, 0, 0.11, true), N(6, 5, 0.16, true), N(5, 3, 0.14, false, false), N(6, 1, 0.16, false, false), N(6, 0, 0.2, true)] },
      { name: "Pattern 10", bpm: 110, steps: [N(6, 0, 0.24, true, false), N(6, 0, 0.24, false, true), N(6, 3, 0.3, true, false), N(5, 5, 0.32, false, false), N(6, 5, 0.3, true, false), N(6, 3, 0.26, false, false), N(6, 1, 0.26, false, false), N(6, 0, 0.42, true, false)] },
    ];

    const riffs = [];
    let riffId = 1;

    for (const template of templates) {
      for (const root of roots) {
        const targetSeconds = 3.0 + (((riffId + 2) % 5) * 0.65);
        const events = [];
        let total = 0;

        while (total < targetSeconds) {
          for (const step of template.steps) {
            if (total >= targetSeconds) break;
            if (step.rest) {
              events.push({ rest: true, duration: step.duration });
              total += step.duration;
              continue;
            }

            const fret = Math.max(0, step.fret + root.offset);
            events.push({
              rest: false,
              duration: step.duration,
              accent: Boolean(step.accent),
              palmMute: Boolean(step.palmMute),
              string: step.string,
              fret,
            });
            total += step.duration;
          }
        }

        riffs.push({ id: riffId, name: `${template.name} ${root.label}`, bpm: template.bpm, duration: total, events });
        riffId += 1;
      }
    }

    return riffs.slice(0, 50);
  }

  function ensureAudioContext() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  function ensurePickNoiseBuffer(ctx) {
    if (pickNoiseBuffer) return pickNoiseBuffer;
    const length = Math.floor(ctx.sampleRate * 0.06);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < length; i += 1) {
      const t = i / length;
      const env = Math.exp(-8 * t);
      data[i] = ((Math.random() * 2) - 1) * env;
    }

    pickNoiseBuffer = buffer;
    return buffer;
  }

  function stopRiffPlayback(clearStatus = false, resetHighlight = false) {
    if (riffCleanupTimer) {
      clearTimeout(riffCleanupTimer);
      riffCleanupTimer = null;
    }

    while (riffVisualTimers.length > 0) clearTimeout(riffVisualTimers.pop());

    while (activeRiffNodes.length > 0) {
      const node = activeRiffNodes.pop();
      try {
        if (typeof node.stop === "function") node.stop();
      } catch (_ignored) {}
      try {
        if (typeof node.disconnect === "function") node.disconnect();
      } catch (_ignored) {}
    }

    if (clearStatus) riffStatusEl.textContent = "";
    if (resetHighlight && currentHighlight !== null) {
      currentHighlight = null;
      renderFretboard();
    }
  }

  function scheduleSynthVoice(ctx, chainInput, noteStart, freq, note, gainScale = 1) {
    const main = ctx.createOscillator();
    const fifth = ctx.createOscillator();
    const sub = ctx.createOscillator();
    const tone = ctx.createBiquadFilter();
    const voice = ctx.createGain();

    main.type = "sawtooth";
    fifth.type = "sawtooth";
    sub.type = "triangle";

    main.frequency.setValueAtTime(freq, noteStart);
    fifth.frequency.setValueAtTime(freq * 1.498307, noteStart);
    sub.frequency.setValueAtTime(freq * 0.5, noteStart);

    main.detune.setValueAtTime(note.accent ? 3 : 2, noteStart);
    fifth.detune.setValueAtTime(note.accent ? -5 : -3, noteStart);
    sub.detune.setValueAtTime(1, noteStart);

    tone.type = "lowpass";
    tone.frequency.setValueAtTime(note.palmMute ? 1450 : 3000, noteStart);
    tone.Q.setValueAtTime(note.palmMute ? 0.85 : 0.68, noteStart);

    const noteLen = Math.max(0.12, note.duration * (note.palmMute ? 0.9 : 1.08));
    const release = note.palmMute ? 0.09 : 0.2;
    const peak = (note.accent ? 0.32 : 0.24) * gainScale;
    const sustain = (note.palmMute ? 0.095 : 0.17) * gainScale;

    voice.gain.setValueAtTime(0.0001, noteStart);
    voice.gain.linearRampToValueAtTime(peak, noteStart + 0.005);
    voice.gain.exponentialRampToValueAtTime(sustain, noteStart + noteLen * 0.68);
    voice.gain.exponentialRampToValueAtTime(0.0001, noteStart + noteLen + release);

    main.connect(tone);
    fifth.connect(tone);
    sub.connect(tone);
    tone.connect(voice);
    voice.connect(chainInput);

    main.start(noteStart);
    fifth.start(noteStart);
    sub.start(noteStart);

    const stopAt = noteStart + noteLen + release + 0.03;
    main.stop(stopAt);
    fifth.stop(stopAt);
    sub.stop(stopAt);

    const pickNoise = ctx.createBufferSource();
    pickNoise.buffer = ensurePickNoiseBuffer(ctx);
    const pickGain = ctx.createGain();
    const pickTone = ctx.createBiquadFilter();

    pickTone.type = "bandpass";
    pickTone.frequency.setValueAtTime(note.palmMute ? 1600 : 2300, noteStart);
    pickTone.Q.setValueAtTime(0.8, noteStart);
    pickGain.gain.setValueAtTime(note.accent ? 0.018 : 0.012, noteStart);
    pickGain.gain.exponentialRampToValueAtTime(0.0001, noteStart + 0.013);

    pickNoise.connect(pickTone);
    pickTone.connect(pickGain);
    pickGain.connect(chainInput);

    pickNoise.start(noteStart);
    pickNoise.stop(noteStart + 0.014);

    activeRiffNodes.push(main, fifth, sub, tone, voice, pickNoise, pickGain, pickTone);
  }

  function scheduleRiffNote(ctx, chainInput, noteStart, note) {
    scheduleSynthVoice(ctx, chainInput, noteStart, note.freq, note, 1.0);
    if (note.accent && !note.palmMute) {
      scheduleSynthVoice(ctx, chainInput, noteStart + 0.0015, note.freq * 2.0, note, 0.28);
    }
  }

  async function playRandomRiff() {
    let state;
    try {
      state = getCurrentState();
      statusEl.textContent = "";
    } catch (error) {
      statusEl.textContent = error instanceof Error ? error.message : "Проверь параметры";
      return;
    }

    const ctx = ensureAudioContext();
    await ctx.resume();
    stopRiffPlayback(false, true);

    const riff = RIFF_BANK[Math.floor(Math.random() * RIFF_BANK.length)];
    const maxFrets = state.frets;
    const openMidis = state.rawTuningNotes.map((note, idx) => parseNoteToMidi(note, idx));
    const startAt = ctx.currentTime + 0.04;

    const preHighpass = ctx.createBiquadFilter();
    preHighpass.type = "highpass";
    preHighpass.frequency.value = 48;

    const body = ctx.createBiquadFilter();
    body.type = "peaking";
    body.frequency.value = 180;
    body.Q.value = 0.9;
    body.gain.value = 5.2;

    const preDrive = ctx.createGain();
    preDrive.gain.value = 1.9;

    const drive = ctx.createWaveShaper();
    drive.curve = DISTORTION_CURVE;
    drive.oversample = "4x";

    const bite = ctx.createBiquadFilter();
    bite.type = "peaking";
    bite.frequency.value = 1450;
    bite.Q.value = 1.0;
    bite.gain.value = 2.1;

    const cab = ctx.createBiquadFilter();
    cab.type = "lowpass";
    cab.frequency.value = 3200;
    cab.Q.value = 0.72;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -25;
    comp.knee.value = 18;
    comp.ratio.value = 4.5;
    comp.attack.value = 0.004;
    comp.release.value = 0.18;

    const master = ctx.createGain();
    master.gain.value = 0.15;

    preHighpass.connect(body);
    body.connect(preDrive);
    preDrive.connect(drive);
    drive.connect(bite);
    bite.connect(cab);
    cab.connect(comp);
    comp.connect(master);
    master.connect(ctx.destination);

    activeRiffNodes.push(preHighpass, body, preDrive, drive, bite, cab, comp, master);

    let t = startAt;
    for (const note of riff.events) {
      if (!note.rest) {
        const stringNum = clamp(Number.parseInt(note.string, 10) || 6, 1, 6);
        const stringIndex = 6 - stringNum;
        const fittedFret = fitFretToVisibleRange(note.fret, maxFrets);
        const midi = openMidis[stringIndex] + fittedFret;

        const playable = {
          ...note,
          string: stringNum,
          fret: fittedFret,
          freq: midiToFrequency(midi),
        };

        scheduleRiffNote(ctx, preHighpass, t, playable);

        const delayMs = Math.max(0, Math.round((t - startAt) * 1000));
        const timerId = setTimeout(() => {
          currentHighlight = { string: playable.string, fret: playable.fret };
          renderFretboard();
        }, delayMs);
        riffVisualTimers.push(timerId);
      }
      t += note.duration;
    }

    riffStatusEl.textContent = `Riff ${riff.id}/50: ${riff.name} - ${riff.duration.toFixed(1)}s`;

    const clearTimer = setTimeout(() => {
      currentHighlight = null;
      renderFretboard();
    }, Math.ceil((riff.duration + 0.12) * 1000));
    riffVisualTimers.push(clearTimer);

    riffCleanupTimer = setTimeout(() => {
      stopRiffPlayback(true, true);
    }, Math.ceil((riff.duration + 0.5) * 1000));
  }

  function onControlsChanged(mutatedEl) {
    if (mutatedEl === tuningSelect) toggleCustomTuning();
    if (mutatedEl === modeSelect) toggleCagedControls();
    updateModeHint();
    if (mutatedEl === fretsInput) applyFretResponsiveLayout();
    scheduleRender();
  }

  menuToggle.addEventListener("click", () => {
    const nextOpen = controlsPanel.dataset.open !== "true";
    setPanelOpen(nextOpen);
  });

  randomRiffBtn.addEventListener("click", async () => {
    try {
      await playRandomRiff();
    } catch (_error) {
      riffStatusEl.textContent = "Браузер заблокировал аудио";
    }
  });

  [rootSelect, scaleSelect, tuningSelect, modeSelect, cagedStageSelect, fretsInput].forEach((el) => {
    el.addEventListener("input", () => onControlsChanged(el));
    el.addEventListener("change", () => onControlsChanged(el));
  });

  customTuningInput.addEventListener("input", scheduleRender);
  customTuningInput.addEventListener("change", scheduleRender);

  window.addEventListener("resize", () => {
    if (!isMobileView()) setPanelOpen(true);
    applyFretResponsiveLayout();
    scheduleRender();
  });

  populateControls();
  syncPanelWithViewport();
  toggleCustomTuning();
  toggleCagedControls();
  updateModeHint();
  applyFretResponsiveLayout();
  initWorldMotion();
  renderFretboard();
})();
