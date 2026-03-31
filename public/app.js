(() => {
  // ── CONFIG ──────────────────────────────────────────────────────────────────
  const wsProtocol    = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const WS_URL        = `${wsProtocol}//${location.host}`;
  const SAMPLE_RATE   = 16000;   // Gemini richiede PCM 16kHz
  const CHUNK_MS      = 50;      // intervallo di invio chunk audio
  const OUT_SAMPLE    = 24000;   // Gemini output: 24kHz PCM16 LE

  // ── DOM ─────────────────────────────────────────────────────────────────────
  const btn       = document.getElementById('btn');
  const btnLabel  = document.getElementById('btn-label');
  const statusEl  = document.getElementById('status');
  const canvas    = document.getElementById('visualizer');
  const ctx2d     = canvas.getContext('2d');

  // ── STATE ───────────────────────────────────────────────────────────────────
  let ws              = null;
  let audioCtxIn      = null;   // per cattura mic
  let audioCtxOut     = null;   // per riproduzione
  let micStream       = null;
  let processorNode   = null;
  let analyserNode    = null;
  let animFrameId     = null;
  let isActive        = false;
  let nextPlayTime    = 0;      // scheduling riproduzione senza gap
  let agentSpeaking   = false;  // true mentre l'agente riproduce audio → mic muto
  let silenceTimer    = null;   // VAD client-side: timer per rilevare fine parlato
  let isTalking       = false;  // true mentre l'utente sta parlando
  const SILENCE_MS    = 400;   // ms di silenzio prima di segnalare activityEnd

  // ── UI HELPERS ──────────────────────────────────────────────────────────────
  function setState(state, text) {
    document.body.className = state ? `state-${state}` : '';
    statusEl.textContent    = text || '';
    switch (state) {
      case 'listening':
        btnLabel.innerHTML = 'In ascolto…<br><small>tocca per terminare</small>';
        btn.disabled = false;
        break;
      case 'speaking':
        btnLabel.innerHTML = 'Il Concierge<br>sta parlando';
        btn.disabled = false;
        break;
      case 'error':
        btnLabel.innerHTML = 'Parla con<br>il Concierge';
        btn.disabled = false;
        break;
      default:
        btnLabel.innerHTML = 'Parla con<br>il Concierge';
        btn.disabled = false;
    }
  }

  // ── VISUALIZER ──────────────────────────────────────────────────────────────
  function drawVisualizer() {
    if (!analyserNode) return;
    const W = canvas.width, H = canvas.height;
    const data = new Uint8Array(analyserNode.frequencyBinCount);
    analyserNode.getByteFrequencyData(data);

    ctx2d.clearRect(0, 0, W, H);
    const barW  = 3;
    const gap   = 2;
    const total = barW + gap;
    const bars  = Math.floor(W / total);
    const step  = Math.floor(data.length / bars);
    const isBody = document.body.classList.contains('state-speaking');
    const color  = isBody ? '#c8a96e' : '#4a9eff';

    for (let i = 0; i < bars; i++) {
      const val  = data[i * step] / 255;
      const barH = Math.max(2, val * H);
      const x    = i * total;
      const y    = (H - barH) / 2;
      ctx2d.fillStyle = color;
      ctx2d.globalAlpha = 0.3 + val * 0.7;
      ctx2d.beginPath();
      ctx2d.roundRect(x, y, barW, barH, 2);
      ctx2d.fill();
    }
    ctx2d.globalAlpha = 1;
    animFrameId = requestAnimationFrame(drawVisualizer);
  }

  function startVisualizer(sourceNode) {
    if (!audioCtxIn) return;
    analyserNode = audioCtxIn.createAnalyser();
    analyserNode.fftSize = 256;
    sourceNode.connect(analyserNode);
    if (animFrameId) cancelAnimationFrame(animFrameId);
    drawVisualizer();
  }

  // ── PCM HELPERS ─────────────────────────────────────────────────────────────
  // Float32 [-1,1] → Int16 PCM
  function floatTo16BitPCM(float32Array) {
    const buf = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      buf[i] = s < 0 ? s * 32768 : s * 32767;
    }
    return buf.buffer;
  }

  // Int16 PCM → Float32 per Web Audio
  function pcm16ToFloat32(buffer) {
    const int16 = new Int16Array(buffer);
    const float  = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float[i] = int16[i] / 32768;
    }
    return float;
  }

  // Invia chunk audio a Gemini tramite il server (formato Multimodal Live)
  function sendAudioChunk(pcmBuffer) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const b64 = arrayBufferToBase64(pcmBuffer);
    const msg = {
      realtimeInput: {
        audio: {
          data: b64,
          mimeType: 'audio/pcm;rate=16000',
        },
      },
    };
    ws.send(JSON.stringify(msg));
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  // ── AUDIO OUTPUT ────────────────────────────────────────────────────────────
  function playPCM16Base64(b64) {
    if (!audioCtxOut) return;

    const binaryString = atob(b64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
    const int16Array = new Int16Array(bytes.buffer);
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) float32Array[i] = int16Array[i] / 32768.0;

    if (float32Array.length < 10) return; // scarta chunk vuoti

    const now = audioCtxOut.currentTime;

    // Reset SOLO se siamo nel passato (silenzio tra turni).
    // NON resettare se siamo nel futuro: i chunk sono in coda e stanno suonando correttamente.
    if (nextPlayTime < now) {
      nextPlayTime = now + 0.02;
    }

    const audioBuffer = audioCtxOut.createBuffer(1, float32Array.length, 24000);
    audioBuffer.getChannelData(0).set(float32Array);
    const source = audioCtxOut.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioCtxOut.destination);
    source.start(nextPlayTime);

    console.log(`[audio] ctx:${audioCtxOut.sampleRate}Hz state:${audioCtxOut.state} schedAt:${nextPlayTime.toFixed(3)} now:${now.toFixed(3)} dur:${audioBuffer.duration.toFixed(3)} samples:${float32Array.length}`);

    nextPlayTime += audioBuffer.duration;
  }

  // ── MICROFONO ───────────────────────────────────────────────────────────────
  async function startMic() {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: {
      sampleRate: SAMPLE_RATE,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    }});

    audioCtxIn = new AudioContext({ sampleRate: SAMPLE_RATE });
    const source = audioCtxIn.createMediaStreamSource(micStream);

    // ScriptProcessor per compatibilità massima (worklet in futuro)
    const bufferSize = Math.round(SAMPLE_RATE * CHUNK_MS / 1000);
    processorNode = audioCtxIn.createScriptProcessor(4096, 1, 1);

    let accumulated = new Float32Array(0);

    processorNode.onaudioprocess = (e) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (agentSpeaking) return; // mic muto mentre l'agente parla (anti-echo)
      const chunk = e.inputBuffer.getChannelData(0);

      // Noise gate: calcola RMS e scarta se sotto la soglia (rumore di fondo)
      let sumSq = 0;
      for (let i = 0; i < chunk.length; i++) sumSq += chunk[i] * chunk[i];
      const rms = Math.sqrt(sumSq / chunk.length);
      if (rms < 0.005) {
        return; // rumore di fondo: non inviare, non resettare il timer
      }

      // Chunk vocale valido: segnala inizio attività se non già attivo
      if (!isTalking) {
        isTalking = true;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
          console.log('[vad] inizio parlato → activityStart');
        }
      }

      // Resetta il timer di silenzio
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      silenceTimer = setTimeout(() => {
        // Silenzio rilevato: segnala fine attività a Gemini
        isTalking = false;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
          console.log('[vad] fine parlato → activityEnd');
        }
        silenceTimer = null;
      }, SILENCE_MS);
      const merged = new Float32Array(accumulated.length + chunk.length);
      merged.set(accumulated);
      merged.set(chunk, accumulated.length);
      accumulated = merged;

      // Drena tutto il buffer accumulato (while, non if) per evitare backlog
      while (accumulated.length >= bufferSize) {
        sendAudioChunk(floatTo16BitPCM(accumulated.slice(0, bufferSize)));
        accumulated = accumulated.slice(bufferSize);
      }
    };

    source.connect(processorNode);
    processorNode.connect(audioCtxIn.destination);
    startVisualizer(source);
  }

  function stopMic() {
    if (silenceTimer)  { clearTimeout(silenceTimer); silenceTimer = null; }
    if (processorNode) { processorNode.disconnect(); processorNode = null; }
    if (micStream)     { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (audioCtxIn)    { audioCtxIn.close(); audioCtxIn = null; }
    if (animFrameId)   { cancelAnimationFrame(animFrameId); animFrameId = null; }
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    analyserNode = null;
  }

  // ── WEBSOCKET ───────────────────────────────────────────────────────────────
  function connectWS() {
    ws = new WebSocket(WS_URL);
    ws.binaryType = 'arraybuffer';

    ws.onopen = async () => {
      agentSpeaking = false;
      isTalking     = false;
      nextPlayTime  = 0;
      setState('listening', 'Connesso — in ascolto');
      try {
        await startMic();
      } catch (err) {
        console.error('startMic fallito:', err);
        setState('error', 'Microfono non disponibile: ' + err.message);
        ws.close();
      }
    };

    ws.onmessage = (event) => {
      // Dati testuali → JSON da Gemini
      try {
        const msg = JSON.parse(event.data);

        // Audio in base64 nella risposta server-content
        const parts = msg?.serverContent?.modelTurn?.parts;
        if (Array.isArray(parts)) {
          let hasAudio = false;
          for (const part of parts) {
            if (part?.inlineData?.mimeType?.startsWith('audio/') && part.inlineData.data) {
              hasAudio = true;
              playPCM16Base64(part.inlineData.data);
            }
          }
          if (hasAudio) {
            agentSpeaking = true;
            setState('speaking', 'Il Concierge sta parlando');
          }
        }

        // Turn completato → riattiva il mic e torna in ascolto
        if (msg?.serverContent?.turnComplete === true) {
          // Calcola quanto manca alla fine dell'ultimo chunk schedulato
          const remaining = audioCtxOut
            ? Math.max(0, (nextPlayTime - audioCtxOut.currentTime) * 1000 + 200)
            : 200;
          nextPlayTime = 0;
          setTimeout(() => {
            agentSpeaking = false;
            if (isActive) setState('listening', 'In ascolto…');
          }, remaining);
        }

        // Setup completato
        if (msg?.setupComplete !== undefined) {
          setState('listening', 'In ascolto…');
        }

      } catch {
        // non JSON, ignora
      }
    };

    ws.onerror = (err) => {
      console.error('WebSocket error', err);
      setState('error', 'Errore di connessione');
    };

    ws.onclose = () => {
      stopMic();
      if (isActive) {
        isActive = false;
        setState(null, 'Connessione chiusa');
      }
    };
  }

  function disconnectWS() {
    stopMic();
    if (ws) { ws.close(); ws = null; }
    if (audioCtxOut) { audioCtxOut.close(); audioCtxOut = null; }
    nextPlayTime = 0;
  }

  // ── PULSANTE ────────────────────────────────────────────────────────────────
  btn.addEventListener('click', async () => {
    if (isActive) {
      isActive = false;
      disconnectWS();
      setState(null, 'Pronto');
      return;
    }

    isActive = true;
    setState(null, 'Connessione in corso…');

    // Sblocco forzato — prima istruzione obbligatoria dentro il gestore click
    // Non forzare sampleRate: il browser usa il suo nativo (44100/48000) e
    // fa il resample dai buffer a 24000Hz in modo corretto e senza glitch
    if (!audioCtxOut) {
      audioCtxOut = new AudioContext();
    }
    if (audioCtxOut.state === 'suspended') {
      await audioCtxOut.resume();
    }
    nextPlayTime = audioCtxOut.currentTime + 0.02;

    try {
      connectWS();
    } catch (err) {
      isActive = false;
      setState('error', 'Errore: ' + err.message);
    }
  });

})();
