require('dotenv').config();
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = 3001;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

const systemPrompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf-8');

const app = express();
app.use(express.static('public'));
const server = app.listen(PORT, () => {
  console.log(`Server Express in ascolto sulla porta ${PORT}`);
});

const wss = new WebSocketServer({ server });

wss.on('connection', (clientWs) => {
  console.log('Client connesso.');

  const geminiWs = new WebSocket(GEMINI_WS_URL);

  geminiWs.on('open', () => {
    console.log('Connessione a Gemini aperta.');

    const setupMessage = {
      setup: {
        model: 'models/gemini-3.1-flash-live-preview',
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: 'Aoede',
              },
            },
          },
        },
        realtimeInputConfig: {
          automaticActivityDetection: { disabled: true },
        },
        systemInstruction: {
          parts: [{ text: systemPrompt }],
        },
        tools: [
          {
            functionDeclarations: [
              {
                name: 'current_time',
                description: 'Restituisce la data e l\'ora corrente in formato ISO 8601.',
                parameters: {
                  type: 'OBJECT',
                  properties: {},
                  required: [],
                },
              },
              {
                name: 'send_whatsapp_data',
                description: 'Invia link via WhatsApp. Usa "booking" per stanze/asset, "map" per la posizione, "audit" per consulenza AI.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    request_type: {
                      type: 'STRING',
                      enum: ['booking', 'map', 'audit'],
                      description: 'Tipo di richiesta: "booking", "map", o "audit".',
                    },
                    customer_name: {
                      type: 'STRING',
                      description: 'Nome dell\'utente (Obbligatorio).',
                    },
                    alternative_phone: {
                      type: 'STRING',
                      description: 'WhatsApp con prefisso internazionale (Obbligatorio).',
                    },
                    asset_type: {
                      type: 'STRING',
                      description: 'Esempio: server_room, podcast_room, deep_work.',
                    },
                    check_in: {
                      type: 'STRING',
                      description: 'Data di check-in formato YYYY-MM-DD.',
                    },
                    check_out: {
                      type: 'STRING',
                      description: 'Data di check-out formato YYYY-MM-DD.',
                    },
                    guests: {
                      type: 'INTEGER',
                      description: 'Numero di persone.',
                    },
                  },
                  required: ['customer_name', 'alternative_phone', 'request_type'],
                },
              },
            ],
          },
        ],
      },
    };

    geminiWs.send(JSON.stringify(setupMessage));
  });

  // Client → Gemini
  clientWs.on('message', (data) => {
    if (geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.send(data);
    }
  });

  // Gemini → Client (con intercettazione FunctionCall)
  geminiWs.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // setupComplete → pronto a ricevere audio dal frontend
      if (msg?.setupComplete !== undefined) {
        console.log('setupComplete ricevuto — in attesa audio dal client.');
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(data.toString());
        }
        return;
      }

      if (msg?.serverContent?.modelTurn) {
        const parts = msg.serverContent.modelTurn.parts || [];
        const hasAudio = parts.some(p => p?.inlineData?.mimeType?.startsWith('audio/'));
        console.log(`serverContent.modelTurn ricevuto — ${parts.length} part(s), audio: ${hasAudio}`);
      }

      const toolCall = msg?.toolCall;
      if (toolCall && Array.isArray(toolCall.functionCalls)) {
        for (const fnCall of toolCall.functionCalls) {
          console.log(`FunctionCall ricevuta: ${fnCall.name}`, fnCall.args);

          if (fnCall.name === 'current_time') {
            const now = new Date().toISOString();
            const response = {
              toolResponse: {
                functionResponses: [
                  {
                    id: fnCall.id,
                    name: 'current_time',
                    response: { result: now },
                  },
                ],
              },
            };
            if (geminiWs.readyState === WebSocket.OPEN) {
              geminiWs.send(JSON.stringify(response));
            }
          } else if (fnCall.name === 'send_whatsapp_data') {
            let success = false;
            let errorMsg = '';

            try {
              const res = await fetch(N8N_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(fnCall.args),
              });
              success = res.ok;
              if (!res.ok) errorMsg = `HTTP ${res.status}`;
            } catch (err) {
              errorMsg = err.message;
            }

            console.log(`send_whatsapp_data → webhook ${success ? 'OK' : 'ERRORE: ' + errorMsg}`);

            const response = {
              toolResponse: {
                functionResponses: [
                  {
                    id: fnCall.id,
                    name: 'send_whatsapp_data',
                    response: {
                      result: success ? 'success' : `error: ${errorMsg}`,
                    },
                  },
                ],
              },
            };
            if (geminiWs.readyState === WebSocket.OPEN) {
              geminiWs.send(JSON.stringify(response));
            }
          }
        }
        return;
      }

      // Messaggio non è una FunctionCall: inoltra al client come stringa di testo
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data.toString());
      }
    } catch {
      // Non-JSON: inoltra come stringa
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data.toString());
      }
    }
  });

  geminiWs.on('error', (err) => {
    console.error('Errore WebSocket Gemini:', err.message);
    clientWs.close();
  });

  geminiWs.on('close', (code, reason) => {
    console.log(`Connessione Gemini chiusa (${code}): ${reason}`);
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });

  clientWs.on('error', (err) => {
    console.error('Errore WebSocket client:', err.message);
    geminiWs.close();
  });

  clientWs.on('close', () => {
    console.log('Client disconnesso.');
    if (geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
  });
});
