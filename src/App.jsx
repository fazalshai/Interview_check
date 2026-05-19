import React, { useState, useRef } from "react";
import OpenAI from "openai";

// Initialize OpenAI directly in the browser using Vite variables
const openai = new OpenAI({
  apiKey: import.meta.env.VITE_OPENAI_API_KEY,
  dangerouslyAllowBrowser: true, // Required for ultra-low latency direct browser requests
});

const SYSTEM_PROMPT = `You are Fazal, an elite AI and Computer Vision Engineer. 
Answer the interviewer's exact question instantly with zero filler, zero fluff, and no textbook definitions.

CRITICAL RULES:
1. Direct Answers Only: Answer exactly what is asked. If asked your name, give your name. If asked a technical concept, explain the underlying engineering mechanism immediately.
2. Structure: Break down complex topics into raw architectural key points, focusing on latency, throughput, bottlenecks, or computational efficiency when relevant.
3. Length: Strict maximum of 2 sentences. Get straight to the point.
4. No Hardcoded Context: Do not mention any specific projects, models, or datasets unless the interviewer explicitly asks you about your past work or experience.`;

export default function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [answer, setAnswer] = useState("");

  const dgWebSocketRef = useRef(null);
  const audioContextRef = useRef(null);
  const processorRef = useRef(null);
  const streamRef = useRef(null);

  const startInterviewNode = async () => {
    setTranscript("Listening...");
    setAnswer("");
    setIsRecording(true);

    const deepgramKey = import.meta.env.VITE_DEEPGRAM_API_KEY;
    const url = "wss://api.deepgram.com/v1/listen?model=nova-3&language=en-US&encoding=linear16&sample_rate=16000&channels=1&interim_results=false";

    // Open direct socket to Deepgram
    dgWebSocketRef.current = new WebSocket(url, ["token", deepgramKey]);

    dgWebSocketRef.current.onopen = async () => {
      console.log("🟩 Deepgram Pipeline Active");
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;

        audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        const source = audioContextRef.current.createMediaStreamSource(stream);
        processorRef.current = audioContextRef.current.createScriptProcessor(2048, 1, 1);

        source.connect(processorRef.current);
        processorRef.current.connect(audioContextRef.current.destination);

        processorRef.current.onaudioprocess = (e) => {
          if (dgWebSocketRef.current?.readyState !== WebSocket.OPEN) return;
          const inputData = e.inputBuffer.getChannelData(0);
          
          // Convert to 16-bit PCM on the fly
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
        setTranscript(text);
        streamOpenAIResponse(text); // Pipe instantly into OpenAI
      }
    };
  };

  const streamOpenAIResponse = async (userText) => {
    setAnswer(""); 
    try {
      const stream = await openai.chat.completions.create({
        model: "gpt-4o-mini", // Fastest available model
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userText },
        ],
        stream: true, // Sub-second streaming chunks
        max_tokens: 100,
        temperature: 0.4,
      });

      for await (const chunk of stream) {
        const token = chunk.choices[0]?.delta?.content || "";
        setAnswer((prev) => prev + token); // Render tokens in real-time
      }
    } catch (err) {
      console.error("OpenAI stream error:", err);
    }
  };

  const stopInterviewNode = () => {
    setIsRecording(false);
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current.onaudioprocess = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.close();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
    }
    if (dgWebSocketRef.current) {
      dgWebSocketRef.current.close();
    }
  };

  return (
    <div style={{ padding: "40px", fontFamily: "system-ui, sans-serif", maxWidth: "600px", margin: "0 auto" }}>
      <h2>Pure-React AI Interviewer (Serverless Latency)</h2>
      
      <div style={{ margin: "25px 0" }}>
        {!isRecording ? (
          <button onClick={startInterviewNode} style={btnStyle("#22c55e")}>
            🎤 Start Talking
          </button>
        ) : (
          <button onClick={stopInterviewNode} style={btnStyle("#ef4444")}>
            🛑 Stop & Process
          </button>
        )}
      </div>

      <div style={{ background: "#f3f4f6", padding: "15px", borderRadius: "8px", marginBottom: "15px" }}>
        <strong>🗣️ Question Detected:</strong>
        <p style={{ color: "#374151", minHeight: "24px", margin: "5px 0 0 0" }}>{transcript}</p>
      </div>

      <div style={{ background: "#eff6ff", padding: "15px", borderRadius: "8px", border: "1px solid #bfdbfe" }}>
        <strong>🤖 Fazal's Response:</strong>
        <div style={{ whiteSpace: "pre-wrap", marginTop: "10px", lineHeight: "1.6", fontWeight: "500", color: "#1e3a8a" }}>
          {answer || "Waiting for your question..."}
        </div>
      </div>
    </div>
  );
}

const btnStyle = (color) => ({
  backgroundColor: color,
  color: "white",
  border: "none",
  padding: "14px 28px",
  fontSize: "16px",
  borderRadius: "8px",
  cursor: "pointer",
  fontWeight: "bold",
});