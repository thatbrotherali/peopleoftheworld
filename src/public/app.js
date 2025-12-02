
// EasyKey Music Converter (Browser-only)
// Supports: MIDI (.mid, .midi), MusicXML (.musicxml, .xml), Compressed MusicXML (.mxl)
// Render: Classic EasyKey (per-semitone columns, black-key shading, diamond envelope, 16th clock-hands)

const fileInput = document.getElementById('fileInput');
const drop = document.getElementById('drop');
const statusEl = document.getElementById('status');
const svgWrap = document.getElementById('svgWrap');
const downloadSvgBtn = document.getElementById('downloadSvgBtn');
const downloadJsonBtn = document.getElementById('downloadJsonBtn');
const clearBtn = document.getElementById('clearBtn');

let lastSVG = null;
let lastEKJ = null;

function setStatus(msg) { statusEl.textContent = msg; }
function isBlackKey(midi) { return [1,3,6,8,10].includes(midi % 12); }
function midiToNoteName(midi) {
  const names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  const n = names[midi%12]; const oct = Math.floor(midi/12) - 1; return n + oct;
}

function enableDownloads() { downloadSvgBtn.disabled = !lastSVG; downloadJsonBtn.disabled = !lastEKJ; }
clearBtn.addEventListener('click', () => { svgWrap.innerHTML = ""; lastSVG = null; lastEKJ = null; setStatus("Cleared."); enableDownloads(); });

// ---------- MIDI Path ----------
function detectCellPerQuarterFromMIDI(midi) {
  const ppq = midi.header.ppq || 480;
  const durs = [];
  midi.tracks.forEach(t => t.notes.forEach(n => durs.push(n.durationTicks || 0)));
  const minDur = durs.length ? Math.max(1, Math.min(...durs)) : ppq/4;
  return (minDur < ppq/4) ? 2 : 1; // use 32nd grid if necessary
}

function midiArrayBufferToEKJ(arrayBuf) {
  const midi = new Midi(arrayBuf);
  const ppq = midi.header.ppq || 480;
  const tempo = (midi.header.tempos[0] && midi.header.tempos[0].bpm) || 120;
  const ts = midi.header.timeSignatures[0] || [4,4];
  const [num, den] = ts;

  const cellPerQuarter = detectCellPerQuarterFromMIDI(midi);
  const tickToCells = (ticks)=> (ticks/ppq) * cellPerQuarter;

  let minPitch = 127, maxPitch = 0;
  midi.tracks.forEach(t=> t.notes.forEach(n=>{ minPitch = Math.min(minPitch, n.midi); maxPitch = Math.max(maxPitch, n.midi); }));
  if (minPitch>maxPitch) { minPitch=60; maxPitch=72; }

  const columns = [];
  for (let p=minPitch; p<=maxPitch; p++) columns.push({ midi:p, label:midiToNoteName(p), shade:isBlackKey(p) });

  const tracks = midi.tracks.map(t => ({
    name: t.name || "Track",
    color: "#888",
    events: t.notes.map(n => ({
      type: "note",
      pitch: n.midi,
      start: (n.ticks/ppq) * cellPerQuarter,
      dur: ((n.durationTicks || Math.round(n.duration*ppq))/ppq) * cellPerQuarter,
      vel: Math.round((n.velocity||0.7)*127)
    }))
  }));

  const ekj = {
    metadata: { title: "MIDI Import", composer: "", tempo_bpm: tempo, time_signature: [num,den], ppq, transpose_semitones: 0 },
    layout: { mode:"classic", pitch_min:minPitch, pitch_max:maxPitch, cell_per_quarter:cellPerQuarter, columns },
    tracks, annotations: { pedal:[], markers:[], dynamics:[] }
  };
  addEnvelopesAndSubcells(ekj);
  return ekj;
}

// ---------- MusicXML / MXL Path ----------
async function musicXmlTextToEKJ(xmlText, name="MusicXML Import") {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");

  // Time signature
  let num = 4, den = 4;
  const beats = doc.querySelector("attributes time beats");
  const beatType = doc.querySelector("attributes time beat-type");
  if (beats && beatType) { num = parseInt(beats.textContent||"4",10); den = parseInt(beatType.textContent||"4",10); }

  // Divisions
  let divisions = 480;
  const divNode = doc.querySelector("attributes divisions");
  if (divNode) divisions = parseInt(divNode.textContent||"480",10);

  // Tempo
  let tempo = 120;
  const sound = doc.querySelector("sound[tempo]");
  if (sound) tempo = parseFloat(sound.getAttribute("tempo"));

  const parts = Array.from(doc.querySelectorAll("part"));
  const tracks = [];
  let globalMin = 127, globalMax = 0;
  let needs32nd = false;
  let maxEndCells = 0;

  for (const part of parts) {
    let timeCells = 0;
    const events = [];
    const measures = Array.from(part.querySelectorAll("measure"));
    const tieOpen = new Map();

    for (const meas of measures) {
      const notes = Array.from(meas.querySelectorAll("note"));
      for (const n of notes) {
        const isRest = !!n.querySelector("rest");
        let pitchMidi = null;
        if (!isRest) {
          const step = n.querySelector("pitch step")?.textContent || "C";
          const alter = parseInt(n.querySelector("pitch alter")?.textContent || "0", 10);
          const octave = parseInt(n.querySelector("pitch octave")?.textContent || "4", 10);
          const stepMap = {C:0,D:2,E:4,F:5,G:7,A:9,B:11};
          pitchMidi = (octave + 1)*12 + stepMap[step] + alter;
          globalMin = Math.min(globalMin, pitchMidi);
          globalMax = Math.max(globalMax, pitchMidi);
        }

        const durDiv = parseInt(n.querySelector("duration")?.textContent || "0", 10);
        if (durDiv > 0 && durDiv < divisions/4) needs32nd = true;
        const durCells = durDiv / divisions;
        const isChordTone = !!n.querySelector("chord");
        const start = timeCells;
        if (!isChordTone) timeCells += durCells;

        if (isRest) continue;

        const ev = { type:"note", pitch:pitchMidi, start, dur:durCells, vel:96 };
        const tieStart = n.querySelector("tie[start]") || n.querySelector('tie[type="start"]');
        const tieStop  = n.querySelector("tie[stop]")  || n.querySelector('tie[type="stop"]');
        const pKey = String(pitchMidi);
        if (tieStart) tieOpen.set(pKey, ev);
        if (tieStop && tieOpen.has(pKey)) {
          const first = tieOpen.get(pKey);
          first.dur += ev.dur;
          // mark merged (renderer already shows only first/last diamonds by duration)
          tieOpen.delete(pKey);
        }
        events.push(ev);
        maxEndCells = Math.max(maxEndCells, start + durCells);
      }
    }

    tracks.push({ name: part.getAttribute("id") || "Part", color:"#888", events });
  }

  if (globalMin>globalMax) { globalMin=60; globalMax=72; }
  const columns = [];
  for (let p=globalMin; p<=globalMax; p++) columns.push({ midi:p, label:midiToNoteName(p), shade:isBlackKey(p) });

  const ekj = {
    metadata: { title: name, composer:"", tempo_bpm: tempo, time_signature:[num,den], ppq: divisions, transpose_semitones: 0 },
    layout: { mode:"classic", pitch_min:globalMin, pitch_max:globalMax, cell_per_quarter: needs32nd ? 2 : 1, columns },
    tracks, annotations: { pedal:[], markers:[], dynamics:[] }
  };
  addEnvelopesAndSubcells(ekj);
  return ekj;
}

// ---------- Common Post-Process ----------
function addEnvelopesAndSubcells(ekj) {
  const cpq = ekj.layout.cell_per_quarter || 1;
  ekj.tracks.forEach(tr => {
    tr.events.forEach(ev => {
      if (ev.type !== "note") return;
      const startCell = Math.floor(ev.start * cpq) / cpq;
      const endCell = Math.floor((ev.start + ev.dur - 1e-6) * cpq) / cpq;
      ev._startCell = startCell;
      ev._endCell = endCell;
      ev.envelope = "diamond";
      const frac = (ev.start % 1 + 1) % 1;
      const slot = Math.min(3, Math.max(0, Math.round(frac * 4)));
      ev.subcells = [slot];
    });
  });
}

// ---------- Renderer (Classic) ----------
function renderEKJ(ekj) {
  const cols = ekj.layout.columns;
  const [num, den] = ekj.metadata.time_signature || [4,4];
  const quartersPerMeasure = num * (4/den);

  const colW = 22;
  const cellH = 26;

  let maxCell = 0;
  ekj.tracks.forEach(tr => tr.events.forEach(ev => { maxCell = Math.max(maxCell, ev.start + ev.dur); }));
  const totalCells = Math.ceil(maxCell);

  const width = cols.length * colW + 80;
  const height = totalCells * cellH + 60;

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.style.background = "#0b0d10";

  const gBG = document.createElementNS(svgNS, "g");
  gBG.setAttribute("transform", "translate(60,20)");
  svg.appendChild(gBG);

  cols.forEach((c, i) => {
    const x = i*colW;
    const rect = document.createElementNS(svgNS, "rect");
    rect.setAttribute("x", x); rect.setAttribute("y", 0);
    rect.setAttribute("width", colW); rect.setAttribute("height", height-60);
    rect.setAttribute("fill", c.shade ? "#0f1620" : "#0c1118");
    gBG.appendChild(rect);

    const t = document.createElementNS(svgNS, "text");
    t.setAttribute("x", x + colW/2); t.setAttribute("y", -4);
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("fill", "#9fb0c3"); t.setAttribute("font-size", "10");
    t.textContent = c.label;
    gBG.appendChild(t);
  });

  const gGrid = document.createElementNS(svgNS, "g");
  gGrid.setAttribute("transform", "translate(60,20)");
  svg.appendChild(gGrid);

  const cellsPerMeasure = quartersPerMeasure * (ekj.layout.cell_per_quarter || 1);
  for (let yCell=0; yCell<=totalCells; yCell++) {
    const y = yCell * cellH;
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", 0); line.setAttribute("y1", y);
    line.setAttribute("x2", cols.length*colW); line.setAttribute("y2", y);
    line.setAttribute("stroke", (yCell % cellsPerMeasure === 0) ? "var(--measure)" : "var(--gridline)");
    line.setAttribute("stroke-width", (yCell % cellsPerMeasure === 0) ? "1.5" : "1");
    gGrid.appendChild(line);
  }

  const gNotes = document.createElementNS(svgNS, "g");
  gNotes.setAttribute("transform", "translate(60,20)");
  svg.appendChild(gNotes);

  function pitchToIndex(midi) { return midi - ekj.layout.pitch_min; }

  ekj.tracks.forEach(tr => {
    tr.events.forEach(ev => {
      if (ev.type !== "note") return;
      const x = pitchToIndex(ev.pitch) * colW;
      const start = ev.start;
      const dur = ev.dur;
      const startCell = Math.floor(start);
      const endCell = Math.floor(start + dur - 1e-6);

      // interior sustain squares
      for (let cell=startCell; cell<=endCell; cell++) {
        const isFirst = cell === startCell;
        const isLast  = cell === endCell;
        const interiorFull = (!isFirst && !isLast);
        if (interiorFull) {
          const rect = document.createElementNS(svgNS, "rect");
          rect.setAttribute("x", x+3);
          rect.setAttribute("y", cell*26+3);
          rect.setAttribute("width", 22-6);
          rect.setAttribute("height", 26-6);
          rect.setAttribute("rx", "4");
          rect.setAttribute("fill", "var(--square)");
          rect.setAttribute("opacity", "0.85");
          gNotes.appendChild(rect);
        }
      }

      // Diamonds at first/last centers
      function drawDiamond(cellIndex) {
        const cx = x + 22/2;
        const cy = (cellIndex+0.5)*26;
        const size = Math.min(22,26)*0.42;
        const pts = [[cx,cy-size],[cx+size,cy],[cx,cy+size],[cx-size,cy]].map(p=>p.join(",")).join(" ");
        const poly = document.createElementNS(svgNS, "polygon");
        poly.setAttribute("points", pts);
        poly.setAttribute("fill", "var(--diamond)");
        poly.setAttribute("opacity", "0.95");
        gNotes.appendChild(poly);
      }
      drawDiamond(startCell);
      if (endCell !== startCell) drawDiamond(endCell);

      // 16th clock-hands at onset slot
      if (Array.isArray(ev.subcells)) {
        ev.subcells.forEach(slot => {
          const cx = x + 22/2;
          const cy = (startCell+0.5)*26;
          const len = Math.min(22,26)*0.44;
          let dx=0, dy=0;
          if (slot===0) { dx=-len*0.8; dy=-len*0.8; }
          else if (slot===1) { dx= len*0.8; dy=-len*0.8; }
          else if (slot===2) { dx= len*0.8; dy= len*0.8; }
          else if (slot===3) { dx=-len*0.8; dy= len*0.8; }
          const line = document.createElementNS(svgNS, "line");
          line.setAttribute("x1", cx); line.setAttribute("y1", cy);
          line.setAttribute("x2", cx+dx); line.setAttribute("y2", cy+dy);
          line.setAttribute("stroke", "var(--hand)");
          line.setAttribute("stroke-width", "2.2");
          line.setAttribute("stroke-linecap", "round");
          gNotes.appendChild(line);
        });
      }
    });
  });

  svgWrap.innerHTML = "";
  svgWrap.appendChild(svg);
  lastSVG = svg;
  lastEKJ = ekj;
  enableDownloads();
}

function downloadSVG() {
  if (!lastSVG) return;
  const s = new XMLSerializer().serializeToString(lastSVG);
  const blob = new Blob([s], {type: "image/svg+xml"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = "easykey-render.svg"; a.click();
  URL.revokeObjectURL(url);
}
function downloadJSON() {
  if (!lastEKJ) return;
  const blob = new Blob([JSON.stringify(lastEKJ, null, 2)], {type: "application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = "easykey-score.ekj.json"; a.click();
  URL.revokeObjectURL(url);
}
downloadSvgBtn.addEventListener('click', downloadSVG);
downloadJsonBtn.addEventListener('click', downloadJSON);

// ---------- FILE HANDLERS ----------
fileInput.addEventListener('change', async (e) => {
  const files = e.target.files ? Array.from(e.target.files) : [];
  for (const f of files) await handleFile(f);
  fileInput.value = "";
});

;['dragenter','dragover'].forEach(evt => drop.addEventListener(evt, e=>{
  e.preventDefault(); e.stopPropagation(); drop.classList.add('dragover');
}));
;['dragleave','drop'].forEach(evt => drop.addEventListener(evt, e=>{
  e.preventDefault(); e.stopPropagation(); drop.classList.remove('dragover');
}));
drop.addEventListener('drop', async (e) => {
  const files = e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
  for (const f of files) await handleFile(f);
});

async function handleFile(file) {
  setStatus(`Loading ${file.name}…`);
  try {
    const ext = file.name.toLowerCase().split('.').pop();
    if (ext === "mid" || ext === "midi") {
      const buf = await file.arrayBuffer();
      const ekj = midiArrayBufferToEKJ(buf);
      renderEKJ(ekj);
      setStatus(`Loaded MIDI: ${file.name}`);
    } else if (ext === "musicxml" || ext === "xml") {
      const text = await file.text();
      const ekj = await musicXmlTextToEKJ(text, file.name);
      renderEKJ(ekj);
      setStatus(`Loaded MusicXML: ${file.name}`);
    } else if (ext === "mxl") {
      const buf = await file.arrayBuffer();
      const zip = await JSZip.loadAsync(buf);
      let xmlPath = null;
      if (zip.files["META-INF/container.xml"]) {
        const containerText = await zip.files["META-INF/container.xml"].async("text");
        const dom = new DOMParser().parseFromString(containerText, "application/xml");
        const rootfile = dom.querySelector("rootfile");
        xmlPath = rootfile?.getAttribute("full-path");
      }
      if (!xmlPath) {
        const cand = Object.keys(zip.files).find(k => k.toLowerCase().endsWith(".xml"));
        xmlPath = cand;
      }
      if (!xmlPath) throw new Error("No MusicXML found inside .mxl");
      const xmlText = await zip.files[xmlPath].async("text");
      const ekj = await musicXmlTextToEKJ(xmlText, file.name);
      renderEKJ(ekj);
      setStatus(`Loaded MXL: ${file.name}`);
    } else {
      setStatus(`Unsupported file type: ${file.name}`);
    }
  } catch (err) {
    console.error(err);
    setStatus('Failed to import file. See console.');
  }
}
