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

// Normalize question text for cache key
const normalizeKey = (text) => text.trim().toLowerCase().replace(/\s+/g, " ");

export default function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [history, setHistory] = useState([]); // [{question, answer, id}]
  const [streamingId, setStreamingId] = useState(null); // which history id is currently streaming

  const dgWebSocketRef = useRef(null);
  const audioContextRef = useRef(null);
  const processorRef = useRef(null);
  const streamRef = useRef(null);
  const historyEndRef = useRef(null);

  // Cache: normalizedQuestion -> answer string
  const cacheRef = useRef({});
  // Queue: array of question strings waiting to be processed
  const queueRef = useRef([]);
  // Whether a stream is currently in flight
  const processingRef = useRef(false);

  // Auto-scroll to bottom when history grows
  useEffect(() => {
    historyEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history, streamingId]);

  const addHistoryEntry = (question) => {
    const id = Date.now() + Math.random();
    setHistory((prev) => [...prev, { id, question, answer: "" }]);
    return id;
  };

  const appendToEntry = (id, token) => {
    setHistory((prev) =>
      prev.map((entry) =>
        entry.id === id ? { ...entry, answer: entry.answer + token } : entry
      )
    );
  };

  const setEntryAnswer = (id, answer) => {
    setHistory((prev) =>
      prev.map((entry) =>
        entry.id === id ? { ...entry, answer } : entry
      )
    );
  };

  // Process next item in queue
  const processQueue = useCallback(async () => {
    if (processingRef.current || queueRef.current.length === 0) return;
    processingRef.current = true;

    const question = queueRef.current.shift();
    const cacheKey = normalizeKey(question);
    const id = addHistoryEntry(question);
    setStreamingId(id);

    // Cache hit → instant answer
    if (cacheRef.current[cacheKey]) {
      setEntryAnswer(id, cacheRef.current[cacheKey]);
      setStreamingId(null);
      processingRef.current = false;
      processQueue(); // next in queue
      return;
    }

    // Cache miss → stream from OpenAI
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

      // Store in cache
      cacheRef.current[cacheKey] = fullAnswer;
    } catch (err) {
      console.error("OpenAI stream error:", err);
      appendToEntry(id, "[Error generating response]");
    }

    setStreamingId(null);
    processingRef.current = false;
    processQueue(); // next in queue
  }, []);

  const enqueueQuestion = useCallback(
    (question) => {
      queueRef.current.push(question);
      processQueue();
    },
    [processQueue]
  );

  // ── Deepgram Pipeline ──────────────────────────────────────────────
  const startInterviewNode = async () => {
    setLiveTranscript("Listening...");
    setIsRecording(true);

    const deepgramKey = import.meta.env.VITE_DEEPGRAM_API_KEY;
    const url =
      "wss://api.deepgram.com/v1/listen?model=nova-3&language=en-US&encoding=linear16&sample_rate=16000&channels=1&interim_results=false";

    dgWebSocketRef.current = new WebSocket(url, ["token", deepgramKey]);

    dgWebSocketRef.current.onopen = async () => {
      console.log("🟩 Deepgram Pipeline Active");
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;

        audioContextRef.current = new (window.AudioContext ||
          window.webkitAudioContext)({ sampleRate: 16000 });
        const source = audioContextRef.current.createMediaStreamSource(stream);
        processorRef.current = audioContextRef.current.createScriptProcessor(
          2048,
          1,
          1
        );

        source.connect(processorRef.current);
        processorRef.current.connect(audioContextRef.current.destination);

        processorRef.current.onaudioprocess = (e) => {
          if (dgWebSocketRef.current?.readyState !== WebSocket.OPEN) return;
          const inputData = e.inputBuffer.getChannelData(0);
          const l16Buffer = new Int16Array(inputData.length);
          for (let i = 0; i < inputData.length; i++) {
            l16Buffer[i] = Math.min(1, Math.max(-1, inputData[i])) * 0x7fff;
          }
          dgWebSocketRef.current.send(l16Buffer.buffer);
        };
      } catch (err) {
        console.error("Mic error:", err);
        stopInterviewNode();
      }
    };

    dgWebSocketRef.current.onmessage = (message) => {
      const data = JSON.parse(message.data);
      const text = data.channel?.alternatives?.[0]?.transcript || "";
      if (text.trim()) {
        setLiveTranscript(text);
        enqueueQuestion(text);
      }
    };
  };

  const stopInterviewNode = () => {
    setIsRecording(false);
    setLiveTranscript("");
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current.onaudioprocess = null;
    }
    if (
      audioContextRef.current &&
      audioContextRef.current.state !== "closed"
    ) {
      audioContextRef.current.close();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
    }
    if (dgWebSocketRef.current) {
      dgWebSocketRef.current.close();
    }
  };

  const clearHistory = () => {
    setHistory([]);
    setLiveTranscript("");
    cacheRef.current = {};
    queueRef.current = [];
  };

  const queueLength = queueRef.current.length;

  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <div style={styles.logo}>🧠</div>
          <div>
            <div style={styles.title}>AI Interview Assistant</div>
            <div style={styles.subtitle}>Real-time · Serverless · Cached</div>
          </div>
        </div>
        <div style={styles.headerRight}>
          {history.length > 0 && (
            <button onClick={clearHistory} style={styles.clearBtn}>
              Clear Session
            </button>
          )}
          <div style={styles.statusDot(isRecording)} />
          <span style={styles.statusLabel}>
            {isRecording ? "Live" : "Idle"}
          </span>
        </div>
      </div>

      {/* Control Bar */}
      <div style={styles.controlBar}>
        {!isRecording ? (
          <button onClick={startInterviewNode} style={styles.startBtn}>
            <span style={styles.btnIcon}>🎤</span> Start Talking
          </button>
        ) : (
          <button onClick={stopInterviewNode} style={styles.stopBtn}>
            <span style={styles.btnIcon}>🛑</span> Stop
          </button>
        )}

        {isRecording && liveTranscript && liveTranscript !== "Listening..." && (
          <div style={styles.liveChip}>
            <span style={styles.chipDot} />
            {liveTranscript}
          </div>
        )}

        {queueRef.current.length > 0 && (
          <div style={styles.queueBadge}>
            {queueRef.current.length} queued
          </div>
        )}
      </div>

      {/* Conversation History */}
      <div style={styles.feed}>
        {history.length === 0 && (
          <div style={styles.empty}>
            <div style={styles.emptyIcon}>💬</div>
            <div style={styles.emptyText}>No questions yet — hit Start and ask away.</div>
          </div>
        )}

        {history.map((entry, idx) => (
          <div key={entry.id} style={styles.card}>
            {/* Question bubble */}
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

            {/* Answer bubble */}
            <div style={styles.answerRow}>
              <div style={styles.avatarA}>F</div>
              <div style={styles.answerBubble}>
                {entry.answer ? (
                  <>
                    {entry.answer}
                    {streamingId === entry.id && (
                      <span style={styles.cursor} />
                    )}
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
const colors = {
  bg: "#0f1117",
  surface: "#181c27",
  card: "#1e2336",
  border: "#2a2f45",
  accent: "#7c6bff",
  accentGlow: "rgba(124, 107, 255, 0.25)",
  green: "#22c55e",
  red: "#ef4444",
  textPrimary: "#e8eaf0",
  textMuted: "#8892aa",
  qBubble: "#252b42",
  aBubble: "#1a2240",
  aBorder: "#3b4a7a",
  cacheBadge: "rgba(250, 200, 50, 0.15)",
  cacheText: "#facc15",
};

const styles = {
  page: {
    minHeight: "100vh",
    background: colors.bg,
    fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
    display: "flex",
    flexDirection: "column",
    color: colors.textPrimary,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "20px 32px",
    borderBottom: `1px solid ${colors.border}`,
    background: colors.surface,
    backdropFilter: "blur(12px)",
    position: "sticky",
    top: 0,
    zIndex: 10,
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: "14px",
  },
  logo: {
    fontSize: "28px",
    lineHeight: 1,
  },
  title: {
    fontSize: "18px",
    fontWeight: 700,
    color: colors.textPrimary,
    letterSpacing: "-0.3px",
  },
  subtitle: {
    fontSize: "12px",
    color: colors.textMuted,
    marginTop: "2px",
    letterSpacing: "0.5px",
  },
  headerRight: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
  },
  statusDot: (active) => ({
    width: "9px",
    height: "9px",
    borderRadius: "50%",
    background: active ? colors.green : colors.textMuted,
    boxShadow: active ? `0 0 8px ${colors.green}` : "none",
    animation: active ? "pulse 1.5s ease-in-out infinite" : "none",
  }),
  statusLabel: {
    fontSize: "13px",
    color: colors.textMuted,
    fontWeight: 500,
  },
  clearBtn: {
    background: "transparent",
    border: `1px solid ${colors.border}`,
    color: colors.textMuted,
    borderRadius: "8px",
    padding: "6px 14px",
    fontSize: "13px",
    cursor: "pointer",
    transition: "all 0.15s",
  },
  controlBar: {
    display: "flex",
    alignItems: "center",
    gap: "14px",
    padding: "20px 32px",
    borderBottom: `1px solid ${colors.border}`,
    flexWrap: "wrap",
  },
  startBtn: {
    background: `linear-gradient(135deg, ${colors.green}, #16a34a)`,
    color: "#fff",
    border: "none",
    borderRadius: "12px",
    padding: "12px 28px",
    fontSize: "15px",
    fontWeight: 700,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    boxShadow: `0 4px 20px rgba(34, 197, 94, 0.3)`,
    transition: "transform 0.15s, box-shadow 0.15s",
  },
  stopBtn: {
    background: `linear-gradient(135deg, ${colors.red}, #b91c1c)`,
    color: "#fff",
    border: "none",
    borderRadius: "12px",
    padding: "12px 28px",
    fontSize: "15px",
    fontWeight: 700,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    boxShadow: `0 4px 20px rgba(239, 68, 68, 0.3)`,
    animation: "pulseBtn 2s ease-in-out infinite",
  },
  btnIcon: {
    fontSize: "18px",
  },
  liveChip: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    background: "rgba(34,197,94,0.1)",
    border: "1px solid rgba(34,197,94,0.3)",
    borderRadius: "999px",
    padding: "6px 16px",
    fontSize: "13px",
    color: colors.green,
    maxWidth: "500px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  chipDot: {
    display: "inline-block",
    width: "7px",
    height: "7px",
    borderRadius: "50%",
    background: colors.green,
    flexShrink: 0,
    animation: "pulse 1s ease-in-out infinite",
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
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    flex: 1,
    paddingTop: "80px",
    gap: "14px",
  },
  emptyIcon: {
    fontSize: "52px",
    opacity: 0.3,
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: "15px",
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    paddingBottom: "24px",
  },
  questionRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: "12px",
  },
  avatarQ: {
    width: "34px",
    height: "34px",
    borderRadius: "10px",
    background: "rgba(180,180,200,0.12)",
    border: `1px solid ${colors.border}`,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "13px",
    fontWeight: 700,
    color: colors.textMuted,
    flexShrink: 0,
  },
  questionBubble: {
    background: colors.qBubble,
    border: `1px solid ${colors.border}`,
    borderRadius: "0 12px 12px 12px",
    padding: "12px 16px",
    fontSize: "15px",
    color: colors.textPrimary,
    lineHeight: 1.6,
    flex: 1,
  },
  cacheBadge: {
    alignSelf: "center",
    background: colors.cacheBadge,
    border: "1px solid rgba(250,204,21,0.25)",
    color: colors.cacheText,
    borderRadius: "999px",
    padding: "3px 10px",
    fontSize: "11px",
    fontWeight: 600,
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  answerRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: "12px",
    paddingLeft: "4px",
  },
  avatarA: {
    width: "34px",
    height: "34px",
    borderRadius: "10px",
    background: `linear-gradient(135deg, ${colors.accent}, #5b4fd4)`,
    boxShadow: `0 0 12px ${colors.accentGlow}`,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "13px",
    fontWeight: 700,
    color: "#fff",
    flexShrink: 0,
  },
  answerBubble: {
    background: colors.aBubble,
    border: `1px solid ${colors.aBorder}`,
    borderRadius: "0 12px 12px 12px",
    padding: "12px 16px",
    fontSize: "15px",
    color: "#c7d2ff",
    lineHeight: 1.7,
    flex: 1,
    whiteSpace: "pre-wrap",
    fontWeight: 450,
  },
  thinking: {
    display: "flex",
    gap: "6px",
    alignItems: "center",
    color: colors.textMuted,
    fontSize: "18px",
  },
  dot1: { animation: "blink 1.2s ease-in-out 0s infinite" },
  dot2: { animation: "blink 1.2s ease-in-out 0.2s infinite" },
  dot3: { animation: "blink 1.2s ease-in-out 0.4s infinite" },
  cursor: {
    display: "inline-block",
    width: "2px",
    height: "16px",
    background: colors.accent,
    marginLeft: "2px",
    verticalAlign: "middle",
    animation: "blink-cursor 0.7s step-end infinite",
  },
  divider: {
    height: "1px",
    background: colors.border,
    margin: "8px 0 12px 0",
    opacity: 0.5,
  },
};

const animations = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(0.85); }
  }
  @keyframes pulseBtn {
    0%, 100% { box-shadow: 0 4px 20px rgba(239,68,68,0.3); }
    50% { box-shadow: 0 4px 30px rgba(239,68,68,0.55); }
  }
  @keyframes blink {
    0%, 100% { opacity: 0.2; }
    50% { opacity: 1; }
  }
  @keyframes blink-cursor {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }

  button:hover { filter: brightness(1.1); }
`;