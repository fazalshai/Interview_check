import React, { useState, useRef, useEffect, useCallback } from "react";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: import.meta.env.VITE_OPENAI_API_KEY,
  dangerouslyAllowBrowser: true,
});

const SYSTEM_PROMPT = `You are Fazal, an elite AI and Computer Vision Engineer. 
Answer the interviewer's exact question instantly with zero filler, zero fluff, and no textbook definitions.

CRITICAL RULES:
1. Direct Answers Only: Answer exactly what is asked. If asked your name, give your name. If asked a technical concept, explain the underlying engineering mechanism immediately.
2. Structure: Break down complex topics into raw architectural key points, focusing on latency, throughput, bottlenecks, or computational efficiency when relevant.
3. Length: Strict maximum of 2 sentences. Get straight to the point.
4. No Hardcoded Context: Do not mention any specific projects, models, or datasets unless the interviewer explicitly asks you about your past work or experience.`;

const normalizeKey = (text) => text.trim().toLowerCase().replace(/\s+/g, " ");

export default function App() {
  const [isHolding, setIsHolding]   = useState(false);  // PTT active?
  const [liveTranscript, setLiveTranscript] = useState("");
  const [history, setHistory]       = useState([]);
  const [streamingId, setStreamingId] = useState(null);
  const [micReady, setMicReady]     = useState(false);  // mic permission granted?

  const dgWebSocketRef  = useRef(null);
  const audioContextRef = useRef(null);
  const processorRef    = useRef(null);
  const streamRef       = useRef(null);
  const historyEndRef   = useRef(null);
  const holdingRef      = useRef(false);       // sync ref for callbacks
  const capturedTextRef = useRef("");          // accumulates transcript during one hold

  const cacheRef      = useRef({});
  const queueRef      = useRef([]);
  const processingRef = useRef(false);

  // ── Auto-scroll ───────────────────────────────────────────────────────────
  useEffect(() => {
    historyEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history, streamingId]);

  // ── Keyboard shortcut: Space = PTT ───────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.code === "Space" && e.target === document.body && !holdingRef.current) {
        e.preventDefault();
        startCapture();
      }
    };
    const onKeyUp = (e) => {
      if (e.code === "Space" && holdingRef.current) {
        e.preventDefault();
        stopCapture();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup",   onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup",   onKeyUp);
    };
  }, []); // eslint-disable-line

  // ── Page-visibility guard ─────────────────────────────────────────────────
  // If the tab is backgrounded mid-hold, release cleanly
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden && holdingRef.current) {
        stopCapture();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []); // eslint-disable-line

  // ── History helpers ────────────────────────────────────────────────────────
  const addHistoryEntry = (question) => {
    const id = Date.now() + Math.random();
    setHistory((prev) => [...prev, { id, question, answer: "" }]);
    return id;
  };

  const appendToEntry = (id, token) => {
    setHistory((prev) =>
      prev.map((e) => (e.id === id ? { ...e, answer: e.answer + token } : e))
    );
  };

  const setEntryAnswer = (id, answer) => {
    setHistory((prev) =>
      prev.map((e) => (e.id === id ? { ...e, answer } : e))
    );
  };

  // ── Queue processor ────────────────────────────────────────────────────────
  const processQueue = useCallback(async () => {
    if (processingRef.current || queueRef.current.length === 0) return;
    processingRef.current = true;

    const question = queueRef.current.shift();
    const cacheKey = normalizeKey(question);
    const id = addHistoryEntry(question);
    setStreamingId(id);

    if (cacheRef.current[cacheKey]) {
      setEntryAnswer(id, cacheRef.current[cacheKey]);
      setStreamingId(null);
      processingRef.current = false;
      processQueue();
      return;
    }

    let fullAnswer = "";
    try {
      const stream = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: question },
        ],
        stream: true,
        max_tokens: 120,
        temperature: 0.4,
      });

      for await (const chunk of stream) {
        const token = chunk.choices[0]?.delta?.content || "";
        fullAnswer += token;
        appendToEntry(id, token);
      }

      cacheRef.current[cacheKey] = fullAnswer;
    } catch (err) {
      console.error("OpenAI error:", err);
      appendToEntry(id, "[Error generating response]");
    }

    setStreamingId(null);
    processingRef.current = false;
    processQueue();
  }, []);

  const enqueueQuestion = useCallback(
    (q) => { queueRef.current.push(q); processQueue(); },
    [processQueue]
  );

  // ── Mic initialisation (once, on first press) ──────────────────────────────
  const ensureMic = async () => {
    if (streamRef.current) return true; // already have mic track
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setMicReady(true);
      return true;
    } catch (err) {
      console.error("Mic permission denied:", err);
      return false;
    }
  };

  // ── PTT Start ─────────────────────────────────────────────────────────────
  const startCapture = async () => {
    if (holdingRef.current) return;
    holdingRef.current = true;
    setIsHolding(true);
    capturedTextRef.current = "";
    setLiveTranscript("Listening...");

    const ok = await ensureMic();
    if (!ok) { holdingRef.current = false; setIsHolding(false); return; }

    // Open Deepgram socket
    const dgKey = import.meta.env.VITE_DEEPGRAM_API_KEY;
    const url =
      "wss://api.deepgram.com/v1/listen?model=nova-3&language=en-US" +
      "&encoding=linear16&sample_rate=16000&channels=1&interim_results=true";

    const ws = new WebSocket(url, ["token", dgKey]);
    dgWebSocketRef.current = ws;

    ws.onopen = () => {
      console.log("🟩 DG open — hold active");

      // Fresh AudioContext per capture (avoids stale-state issues)
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)(
        { sampleRate: 16000 }
      );

      const source = audioContextRef.current.createMediaStreamSource(
        streamRef.current
      );
      processorRef.current = audioContextRef.current.createScriptProcessor(
        2048, 1, 1
      );

      source.connect(processorRef.current);
      processorRef.current.connect(audioContextRef.current.destination);

      processorRef.current.onaudioprocess = (e) => {
        if (!holdingRef.current) return; // safety gate
        if (ws.readyState !== WebSocket.OPEN) return;
        const data = e.inputBuffer.getChannelData(0);
        const buf  = new Int16Array(data.length);
        for (let i = 0; i < data.length; i++) {
          buf[i] = Math.min(1, Math.max(-1, data[i])) * 0x7fff;
        }
        ws.send(buf.buffer);
      };
    };

    ws.onmessage = (msg) => {
      const payload = JSON.parse(msg.data);
      const text    = payload.channel?.alternatives?.[0]?.transcript || "";
      const isFinal = payload.is_final;

      if (text.trim()) {
        // Show interim transcript live
        setLiveTranscript(text);
        // Accumulate only finals so we don't double-count
        if (isFinal) {
          capturedTextRef.current =
            (capturedTextRef.current + " " + text).trim();
        }
      }
    };

    ws.onerror = (e) => console.error("DG error:", e);
  };

  // ── PTT Stop ──────────────────────────────────────────────────────────────
  const stopCapture = () => {
    if (!holdingRef.current) return;
    holdingRef.current = false;
    setIsHolding(false);

    // Disconnect audio pipeline
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    // Gracefully close DG — it will flush any pending transcript
    if (dgWebSocketRef.current) {
      // Send close-stream signal so DG returns final transcript
      if (dgWebSocketRef.current.readyState === WebSocket.OPEN) {
        dgWebSocketRef.current.send(JSON.stringify({ type: "CloseStream" }));
      }

      // Give DG 600 ms to respond with the last final transcript, then enqueue
      setTimeout(() => {
        dgWebSocketRef.current?.close();
        dgWebSocketRef.current = null;

        const question = capturedTextRef.current.trim();
        setLiveTranscript(question || "");
        if (question) enqueueQuestion(question);
        capturedTextRef.current = "";
      }, 600);
    }
  };

  const clearHistory = () => {
    setHistory([]);
    setLiveTranscript("");
    cacheRef.current   = {};
    queueRef.current   = [];
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <div style={styles.logo}>🧠</div>
          <div>
            <div style={styles.title}>AI Interview Assistant</div>
            <div style={styles.subtitle}>Hold-to-Capture · Cached · Serverless</div>
          </div>
        </div>
        <div style={styles.headerRight}>
          {history.length > 0 && (
            <button onClick={clearHistory} style={styles.clearBtn}>
              Clear Session
            </button>
          )}
          <div style={styles.statusDot(isHolding)} />
          <span style={styles.statusLabel}>
            {isHolding ? "Capturing" : "Idle"}
          </span>
        </div>
      </div>

      {/* PTT Control */}
      <div style={styles.controlBar}>
        <button
          onMouseDown={startCapture}
          onMouseUp={stopCapture}
          onMouseLeave={isHolding ? stopCapture : undefined}
          onTouchStart={(e) => { e.preventDefault(); startCapture(); }}
          onTouchEnd={(e)   => { e.preventDefault(); stopCapture();  }}
          style={styles.pttBtn(isHolding)}
          aria-label="Hold to capture interviewer question"
        >
          <span style={styles.btnIcon}>{isHolding ? "🔴" : "🎤"}</span>
          {isHolding ? "Release to Process" : "Hold to Capture Question"}
        </button>

        <div style={styles.hint}>
          or hold <kbd style={styles.kbd}>Space</kbd>
        </div>

        {isHolding && (
          <div style={styles.liveChip}>
            <span style={styles.chipDot} />
            {liveTranscript !== "Listening..." && liveTranscript
              ? liveTranscript
              : "Listening…"}
          </div>
        )}

        {queueRef.current.length > 0 && (
          <div style={styles.queueBadge}>{queueRef.current.length} queued</div>
        )}
      </div>

      {/* How-to banner (only when no history yet) */}
      {history.length === 0 && (
        <div style={styles.howTo}>
          <div style={styles.step}>
            <span style={styles.stepNum}>1</span>
            <span>Interviewer asks a question</span>
          </div>
          <div style={styles.stepArrow}>→</div>
          <div style={styles.step}>
            <span style={styles.stepNum}>2</span>
            <span>You <strong>hold</strong> the button while they speak</span>
          </div>
          <div style={styles.stepArrow}>→</div>
          <div style={styles.step}>
            <span style={styles.stepNum}>3</span>
            <span><strong>Release</strong> → AI answers instantly</span>
          </div>
          <div style={styles.stepArrow}>→</div>
          <div style={styles.step}>
            <span style={styles.stepNum}>4</span>
            <span>You answer — mic is completely <strong>OFF</strong></span>
          </div>
        </div>
      )}

      {/* Conversation Feed */}
      <div style={styles.feed}>
        {history.map((entry, idx) => (
          <div key={entry.id} style={styles.card}>
            <div style={styles.questionRow}>
              <div style={styles.avatarQ}>Q</div>
              <div style={styles.questionBubble}>{entry.question}</div>
              {cacheRef.current[normalizeKey(entry.question)] &&
                streamingId !== entry.id && (
                  <span style={styles.cacheBadge} title="Served from cache">
                    ⚡ cached
                  </span>
                )}
            </div>

            <div style={styles.answerRow}>
              <div style={styles.avatarA}>F</div>
              <div style={styles.answerBubble}>
                {entry.answer ? (
                  <>
                    {entry.answer}
                    {streamingId === entry.id && <span style={styles.cursor} />}
                  </>
                ) : (
                  <span style={styles.thinking}>
                    <span style={styles.dot1}>●</span>
                    <span style={styles.dot2}>●</span>
                    <span style={styles.dot3}>●</span>
                  </span>
                )}
              </div>
            </div>

            {idx < history.length - 1 && <div style={styles.divider} />}
          </div>
        ))}
        <div ref={historyEndRef} />
      </div>

      <style>{animations}</style>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const c = {
  bg:        "#0f1117",
  surface:   "#181c27",
  card:      "#1e2336",
  border:    "#2a2f45",
  accent:    "#7c6bff",
  accentGlow:"rgba(124,107,255,0.25)",
  green:     "#22c55e",
  red:       "#ef4444",
  text:      "#e8eaf0",
  muted:     "#8892aa",
  qBubble:   "#252b42",
  aBubble:   "#1a2240",
  aBorder:   "#3b4a7a",
};

const styles = {
  page: {
    minHeight: "100vh",
    background: c.bg,
    fontFamily: "'Inter','Segoe UI',system-ui,sans-serif",
    display: "flex",
    flexDirection: "column",
    color: c.text,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "18px 32px",
    borderBottom: `1px solid ${c.border}`,
    background: c.surface,
    position: "sticky",
    top: 0,
    zIndex: 10,
  },
  headerLeft: { display: "flex", alignItems: "center", gap: "14px" },
  logo:       { fontSize: "28px" },
  title:      { fontSize: "17px", fontWeight: 700, letterSpacing: "-0.3px" },
  subtitle:   { fontSize: "11px", color: c.muted, marginTop: "2px", letterSpacing: "0.5px" },
  headerRight:{ display: "flex", alignItems: "center", gap: "10px" },

  statusDot: (active) => ({
    width: "9px", height: "9px", borderRadius: "50%",
    background: active ? c.red : c.muted,
    boxShadow:  active ? `0 0 8px ${c.red}` : "none",
    animation:  active ? "pulse 1s ease-in-out infinite" : "none",
  }),
  statusLabel: { fontSize: "13px", color: c.muted, fontWeight: 500 },

  clearBtn: {
    background: "transparent",
    border: `1px solid ${c.border}`,
    color: c.muted,
    borderRadius: "8px",
    padding: "5px 13px",
    fontSize: "12px",
    cursor: "pointer",
  },

  controlBar: {
    display: "flex",
    alignItems: "center",
    gap: "16px",
    padding: "20px 32px",
    borderBottom: `1px solid ${c.border}`,
    flexWrap: "wrap",
  },

  pttBtn: (holding) => ({
    background: holding
      ? `linear-gradient(135deg, ${c.red}, #b91c1c)`
      : `linear-gradient(135deg, ${c.accent}, #5b4fd4)`,
    color:        "#fff",
    border:       "none",
    borderRadius: "14px",
    padding:      "14px 32px",
    fontSize:     "15px",
    fontWeight:   700,
    cursor:       "pointer",
    display:      "flex",
    alignItems:   "center",
    gap:          "10px",
    userSelect:   "none",
    WebkitUserSelect: "none",
    boxShadow:    holding
      ? `0 4px 24px rgba(239,68,68,0.4)`
      : `0 4px 24px ${c.accentGlow}`,
    transform:    holding ? "scale(0.97)" : "scale(1)",
    transition:   "all 0.12s ease",
  }),
  btnIcon: { fontSize: "18px" },

  hint: {
    fontSize: "13px",
    color: c.muted,
    display: "flex",
    alignItems: "center",
    gap: "6px",
  },
  kbd: {
    background: "#252b42",
    border: `1px solid ${c.border}`,
    borderRadius: "5px",
    padding: "2px 8px",
    fontSize: "12px",
    fontFamily: "monospace",
    color: c.text,
  },

  liveChip: {
    display: "flex", alignItems: "center", gap: "8px",
    background: "rgba(239,68,68,0.1)",
    border: "1px solid rgba(239,68,68,0.3)",
    borderRadius: "999px",
    padding: "6px 16px",
    fontSize: "13px",
    color: c.red,
    maxWidth: "420px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  chipDot: {
    display: "inline-block", width: "7px", height: "7px",
    borderRadius: "50%", background: c.red, flexShrink: 0,
    animation: "pulse 0.9s ease-in-out infinite",
  },
  queueBadge: {
    background: "rgba(124,107,255,0.15)",
    border: "1px solid rgba(124,107,255,0.35)",
    borderRadius: "999px",
    padding: "5px 14px",
    fontSize: "12px",
    color: "#a89eff",
    fontWeight: 600,
  },

  // How-to strip
  howTo: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "18px 32px",
    background: "rgba(124,107,255,0.06)",
    borderBottom: `1px solid ${c.border}`,
    flexWrap: "wrap",
  },
  step: {
    display: "flex", alignItems: "center", gap: "8px",
    fontSize: "13px", color: c.muted,
  },
  stepNum: {
    background: c.accent,
    color: "#fff",
    borderRadius: "50%",
    width: "20px", height: "20px",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: "11px", fontWeight: 700, flexShrink: 0,
  },
  stepArrow: { color: c.border, fontSize: "18px", flexShrink: 0 },

  feed: {
    flex: 1,
    overflowY: "auto",
    padding: "32px",
    display: "flex",
    flexDirection: "column",
    gap: "0px",
    maxWidth: "860px",
    width: "100%",
    margin: "0 auto",
    boxSizing: "border-box",
  },

  card:        { display: "flex", flexDirection: "column", gap: "12px", paddingBottom: "24px" },
  questionRow: { display: "flex", alignItems: "flex-start", gap: "12px" },
  answerRow:   { display: "flex", alignItems: "flex-start", gap: "12px", paddingLeft: "4px" },

  avatarQ: {
    width: "34px", height: "34px", borderRadius: "10px",
    background: "rgba(180,180,200,0.12)",
    border: `1px solid ${c.border}`,
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: "13px", fontWeight: 700, color: c.muted, flexShrink: 0,
  },
  avatarA: {
    width: "34px", height: "34px", borderRadius: "10px",
    background: `linear-gradient(135deg, ${c.accent}, #5b4fd4)`,
    boxShadow: `0 0 12px ${c.accentGlow}`,
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: "13px", fontWeight: 700, color: "#fff", flexShrink: 0,
  },

  questionBubble: {
    background: c.qBubble, border: `1px solid ${c.border}`,
    borderRadius: "0 12px 12px 12px",
    padding: "12px 16px", fontSize: "15px",
    color: c.text, lineHeight: 1.6, flex: 1,
  },
  answerBubble: {
    background: c.aBubble, border: `1px solid ${c.aBorder}`,
    borderRadius: "0 12px 12px 12px",
    padding: "12px 16px", fontSize: "15px",
    color: "#c7d2ff", lineHeight: 1.7, flex: 1,
    whiteSpace: "pre-wrap", fontWeight: 450,
  },
  cacheBadge: {
    alignSelf: "center",
    background: "rgba(250,204,21,0.12)",
    border: "1px solid rgba(250,204,21,0.25)",
    color: "#facc15",
    borderRadius: "999px",
    padding: "3px 10px", fontSize: "11px", fontWeight: 600,
    whiteSpace: "nowrap", flexShrink: 0,
  },

  thinking: { display: "flex", gap: "6px", alignItems: "center", color: c.muted, fontSize: "18px" },
  dot1: { animation: "blink 1.2s ease-in-out 0.0s infinite" },
  dot2: { animation: "blink 1.2s ease-in-out 0.2s infinite" },
  dot3: { animation: "blink 1.2s ease-in-out 0.4s infinite" },

  cursor: {
    display: "inline-block", width: "2px", height: "16px",
    background: c.accent, marginLeft: "2px",
    verticalAlign: "middle",
    animation: "blink-cursor 0.7s step-end infinite",
  },

  divider: {
    height: "1px", background: c.border,
    margin: "8px 0 12px 0", opacity: 0.5,
  },
};

const animations = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

  @keyframes pulse {
    0%,100% { opacity:1; transform:scale(1); }
    50%      { opacity:0.45; transform:scale(0.8); }
  }
  @keyframes blink {
    0%,100% { opacity:0.2; }
    50%      { opacity:1; }
  }
  @keyframes blink-cursor {
    0%,100% { opacity:1; }
    50%      { opacity:0; }
  }
`;