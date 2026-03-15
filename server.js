import 'dotenv/config';
import express from "express";
import { GoogleGenAI, Modality } from "@google/genai";
import PDFDocument from "pdfkit";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

// ─────────────────────────────────────────────────────────────
// /ask  — Standard chat (gemini-2.5-flash-lite, free tier)
// ─────────────────────────────────────────────────────────────
app.post("/ask", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ reply: "Ask me something!" });
    const result = await ai.models.generateContent({
      model: "gemini-2.5-flash-lite",
      contents: prompt
    });
    res.json({ reply: result.text });
  } catch (err) {
    console.error("AI ERROR:", err.message);
    const msg = err.message.includes("429")
      ? "Quota exceeded — wait 60 seconds and try again."
      : "Error talking to AI.";
    res.status(500).json({ reply: msg });
  }
});

// ─────────────────────────────────────────────────────────────
// /ask-grounded — Gemini + Google Search with smart fallback
// ─────────────────────────────────────────────────────────────
let flash20BlockedUntil = 0;

app.post("/ask-grounded", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ reply: "No prompt." });

  const now = Date.now();
  const flash20Available = now > flash20BlockedUntil;

  if (flash20Available) {
    try {
      const result = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: prompt,
        config: { tools: [{ googleSearch: {} }] }
      });
      flash20BlockedUntil = 0;
      return res.json({ reply: result.text });
    } catch (err) {
      const is429 = err.message.includes("429") || err.message.includes("RESOURCE_EXHAUSTED");
      if (is429) {
        const retryMatch = err.message.match(/retry.*?(\d+)s/i);
        const waitMs = retryMatch ? parseInt(retryMatch[1]) * 1000 : 60_000;
        flash20BlockedUntil = Date.now() + waitMs;
        console.log(`[grounded] 2.0-flash quota hit. Falling back for ${Math.round(waitMs/1000)}s.`);
      } else {
        console.error("[grounded] Unexpected error:", err.message);
      }
    }
  }

  try {
    const fallback = await ai.models.generateContent({
      model: "gemini-2.5-flash-lite",
      contents: prompt
    });
    return res.json({ reply: fallback.text });
  } catch (fallbackErr) {
    console.error("[grounded] Fallback failed:", fallbackErr.message);
    return res.status(500).json({ reply: "Research failed. Try again in a minute." });
  }
});

// ─────────────────────────────────────────────────────────────
// /export-pdf — Build and stream a branded PDF
// ─────────────────────────────────────────────────────────────
app.post("/export-pdf", async (req, res) => {
  try {
    const { ideaName, tabs, saved } = req.body;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition",
      `attachment; filename="${(ideaName || "idea").replace(/\s+/g, "-")}-IdeaForgr.pdf"`);

    const doc = new PDFDocument({
      margin: 50, size: "A4",
      info: { Title: `${ideaName} — IdeaForgr AI`, Author: "IdeaForgr AI" },
      bufferPages: true
    });
    doc.pipe(res);

    const divider = () => {
      doc.moveDown(0.4)
         .moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y)
         .strokeColor("#2a2a4a").lineWidth(0.5).stroke()
         .moveDown(0.4);
    };

    doc.rect(0, 0, doc.page.width, doc.page.height).fill("#04040c");
    doc.rect(0, 0, doc.page.width, 3).fill("#6366f1");
    doc.rect(0, 0, doc.page.width, 200).fill("#0a0a22");
    doc.fillColor("#6366f1").fontSize(9).font("Helvetica-Bold")
       .text("IDEAFORGR AI", 50, 60, { characterSpacing: 4 });
    doc.fillColor("#eef0ff").fontSize(30).font("Helvetica-Bold")
       .text(ideaName || "Untitled Idea", 50, 80, { width: doc.page.width - 100 });
    doc.fillColor("#4e536b").fontSize(9).font("Helvetica")
       .text(new Date().toLocaleDateString("en-US", { year:"numeric", month:"long", day:"numeric" }), 50, 150);

    for (const [tabName, messages] of Object.entries(tabs || {})) {
      if (!messages?.length) continue;
      doc.addPage();
      doc.rect(0, 0, doc.page.width, doc.page.height).fill("#04040c");
      doc.rect(0, 0, doc.page.width, 3).fill("#6366f1");
      doc.fillColor("#818cf8").fontSize(8).font("Helvetica-Bold")
         .text(tabName.toUpperCase(), 50, 28, { characterSpacing: 2.5 });
      doc.fillColor("#eef0ff").fontSize(18).font("Helvetica-Bold").text(tabName, 50, 42);
      divider();
      for (const msg of messages) {
        if (!msg.text?.trim()) continue;
        if (msg.role === "user") {
          doc.fillColor("#4e536b").fontSize(7.5).font("Helvetica-Bold").text("YOU", { align:"right" });
          doc.fillColor("#9399b2").fontSize(10).font("Helvetica")
             .text(msg.text, { align:"right", width: doc.page.width - 100 });
        } else {
          doc.fillColor("#818cf8").fontSize(7.5).font("Helvetica-Bold").text("IDEAFORGR AI");
          doc.fillColor("#eef0ff").fontSize(10).font("Helvetica")
             .text(msg.text, { width: doc.page.width - 100 });
        }
        doc.moveDown(0.5);
      }
    }

    if (saved?.length) {
      doc.addPage();
      doc.rect(0, 0, doc.page.width, doc.page.height).fill("#04040c");
      doc.rect(0, 0, doc.page.width, 3).fill("#ff7a1a");
      doc.fillColor("#ff7a1a").fontSize(8).font("Helvetica-Bold")
         .text("APPENDIX", 50, 28, { characterSpacing: 2.5 });
      doc.fillColor("#eef0ff").fontSize(18).font("Helvetica-Bold").text("Saved Results", 50, 42);
      divider();
      for (const item of saved) {
        doc.fillColor("#818cf8").fontSize(9).font("Helvetica-Bold").text(`${item.title}  ·  ${item.time}`);
        doc.fillColor("#9399b2").fontSize(9).font("Helvetica")
           .text(item.text || "", { width: doc.page.width - 100 });
        doc.moveDown(0.8); divider();
      }
    }

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      doc.fillColor("#2a2a4a").fontSize(7.5).font("Helvetica")
         .text(`IdeaForgr AI  ·  Page ${i + 1} of ${range.count}`,
               50, doc.page.height - 28, { align:"center", width: doc.page.width - 100 });
    }
    doc.end();
  } catch (err) {
    console.error("PDF ERROR:", err.message);
    if (!res.headersSent) res.status(500).json({ error: "PDF generation failed." });
  }
});

// ─────────────────────────────────────────────────────────────
// GEMINI LIVE — WebSocket proxy
//
// Architecture:
//   Browser  ──(WebSocket)──▶  Our server  ──(ai.live.connect)──▶  Gemini Live API
//
// Why a proxy and not a direct browser connection?
//   The @google/genai SDK is a Node.js package — it cannot run in
//   the browser. More importantly, keeping the API key server-side
//   is the correct security posture for any real deployment.
//
// Protocol (messages sent over the browser↔server WebSocket):
//
//   Browser → Server:
//     { type:"start", ideaContext:"..." }   — begin a Live session
//     { type:"audio", data:"<base64 PCM>" } — stream microphone audio
//     { type:"text",  text:"..." }          — send a text turn
//     { type:"end_turn" }                   — signal end of user turn
//     { type:"stop" }                       — close the session
//
//   Server → Browser:
//     { type:"ready" }                      — Gemini session is open
//     { type:"audio", data:"<base64 PCM>" } — Gemini's voice response
//     { type:"transcript_in",  text:"..." } — what the user said (STT)
//     { type:"transcript_out", text:"..." } — what Gemini said (TTS)
//     { type:"turn_complete" }              — Gemini finished speaking
//     { type:"error", message:"..." }       — something went wrong
//     { type:"closed" }                     — session ended
// ─────────────────────────────────────────────────────────────

// We share a single HTTP server so WebSocket and Express run on same port
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/live" });

wss.on("connection", (browserWs) => {
  console.log("[live] Browser connected");

  // geminiSession holds the active ai.live session for this browser connection
  let geminiSession = null;
  // Buffer of audio chunks queued before the session is ready
  let audioQueue    = [];
  let sessionActive = false;

  // Helper: safely send JSON to the browser, ignoring errors if socket closed
  const send = (obj) => {
    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(JSON.stringify(obj));
    }
  };

  // ── Handle messages from the browser ──
  browserWs.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { return; }

    switch (msg.type) {

      // ── START: open a Gemini Live session ──
      case "start": {
        if (geminiSession) {
          // Already have a session — close it before opening a new one
          try { geminiSession.close(); } catch {}
          geminiSession = null;
        }

        const ideaContext = msg.ideaContext || "";
        const systemInstruction =
          `You are IdeaForgr AI — an energetic, expert startup coach having a LIVE voice conversation. ` +
          `Keep responses concise and conversational (2–4 sentences max per turn). ` +
          `Be warm, direct, and insightful. Never say you are an AI model — just be the coach. ` +
          (ideaContext
            ? `\n\nCURRENT IDEA CONTEXT:\n${ideaContext}\n\nUse this context to give specific, ` +
              `relevant advice rather than generic startup tips.`
            : "");

        try {
          // Connect to Gemini Live.
          // - MODEL: gemini-2.0-flash-live-001 is the stable Live model on AI Studio free tier.
          //   gemini-2.5-flash-native-audio-preview-12-2025 is newer but may have tighter quotas.
          // - MODALITIES: we want audio back (Gemini speaks) + text transcripts for both directions
          //   so we can show captions in the UI.
          // - VOICE: "Aoede" is a warm, natural-sounding female voice. Other options:
          //   "Charon", "Fenrir", "Kore", "Puck".
          geminiSession = await ai.live.connect({
            model: "gemini-2.0-flash-live-001",
            config: {
              responseModalities: [Modality.AUDIO],
              inputAudioTranscription:  {},   // transcribe what the user says
              outputAudioTranscription: {},   // transcribe what Gemini says
              systemInstruction: { parts: [{ text: systemInstruction }] },
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } }
              }
            },
            callbacks: {
              // Session opened successfully
              onopen: () => {
                console.log("[live] Gemini session opened");
                sessionActive = true;
                send({ type: "ready" });
                // Drain any audio chunks that arrived before we were ready
                for (const chunk of audioQueue) {
                  geminiSession.sendRealtimeInput({ audio: { data: chunk, mimeType: "audio/pcm;rate=16000" } });
                }
                audioQueue = [];
              },

              // Message from Gemini — can contain audio, transcripts, or turn_complete
              onmessage: (message) => {
                const sc = message.serverContent;
                if (!sc) return;

                // Audio chunk — forward raw PCM to browser as base64
                if (sc.modelTurn?.parts) {
                  for (const part of sc.modelTurn.parts) {
                    if (part.inlineData?.data) {
                      send({ type: "audio", data: part.inlineData.data });
                    }
                  }
                }

                // User speech transcript (what Gemini heard you say)
                if (sc.inputTranscription?.text) {
                  send({ type: "transcript_in", text: sc.inputTranscription.text });
                }

                // Gemini's own response transcript (captions for the voice)
                if (sc.outputTranscription?.text) {
                  send({ type: "transcript_out", text: sc.outputTranscription.text });
                }

                // Gemini finished its current turn
                if (sc.turnComplete) {
                  send({ type: "turn_complete" });
                }
              },

              onerror: (e) => {
                console.error("[live] Gemini error:", e.message);
                send({ type: "error", message: e.message });
              },

              onclose: (e) => {
                console.log("[live] Gemini session closed:", e.reason || "normal");
                sessionActive = false;
                send({ type: "closed" });
              }
            }
          });

        } catch (err) {
          console.error("[live] Failed to open session:", err.message);
          send({ type: "error", message: "Could not start Live session: " + err.message });
        }
        break;
      }

      // ── AUDIO: stream PCM from browser mic to Gemini ──
      case "audio": {
        if (!msg.data) break;
        if (sessionActive && geminiSession) {
          // Send directly — this is the hot path, must be fast
          geminiSession.sendRealtimeInput({
            audio: { data: msg.data, mimeType: "audio/pcm;rate=16000" }
          });
        } else {
          // Queue it — session might still be opening
          audioQueue.push(msg.data);
          if (audioQueue.length > 200) audioQueue.shift(); // cap queue
        }
        break;
      }

      // ── TEXT: send a text message to Gemini (for typed Live chat) ──
      case "text": {
        if (!msg.text || !geminiSession) break;
        geminiSession.sendRealtimeInput({ text: msg.text });
        break;
      }

      // ── END_TURN: tell Gemini the user has finished speaking ──
      case "end_turn": {
        if (geminiSession) {
          try { geminiSession.sendRealtimeInput({ activityEnd: {} }); } catch {}
        }
        break;
      }

      // ── STOP: close the session cleanly ──
      case "stop": {
        if (geminiSession) {
          try { geminiSession.close(); } catch {}
          geminiSession = null;
        }
        sessionActive = false;
        send({ type: "closed" });
        break;
      }
    }
  });

  // ── Browser disconnected — clean up Gemini session ──
  browserWs.on("close", () => {
    console.log("[live] Browser disconnected");
    if (geminiSession) {
      try { geminiSession.close(); } catch {}
      geminiSession = null;
    }
    sessionActive = false;
    audioQueue = [];
  });

  browserWs.on("error", (err) => {
    console.error("[live] Browser WebSocket error:", err.message);
  });
});

// ─────────────────────────────────────────────────────────────
// Start — use httpServer (not app.listen) so WS shares the port
// ─────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`\n🔥 IdeaForgr AI  →  http://localhost:${PORT}`);
  console.log(`   /ask              Standard Gemini chat`);
  console.log(`   /ask-grounded     Gemini + live Google Search`);
  console.log(`   /export-pdf       PDF export`);
  console.log(`   ws://…/live       Gemini Live voice session\n`);
});