// backend/server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const Y = require('yjs');
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');

const Document = require('./models/Document');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',           // ← change to your frontend domain in production
    methods: ['GET', 'POST']
  }
});

// ────────────────────────────────────────────────
// MongoDB Connection (Atlas or local)
// ────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// In-memory active documents (docId → { ydoc, saveTimeout, lastSaved })
const docs = new Map();

// ────────────────────────────────────────────────
// Redis Cloud connection (TLS required - rediss://)
// ────────────────────────────────────────────────
const pubClient = createClient({
  url: process.env.REDIS_URL   // should be: rediss://default:YOUR_PASSWORD@host:port
});

const subClient = pubClient.duplicate();

Promise.all([pubClient.connect(), subClient.connect()])
  .then(() => {
    io.adapter(createAdapter(pubClient, subClient));
    console.log('Redis Cloud adapter connected (TLS enabled)');
  })
  .catch(err => {
    console.error('Redis Cloud connection failed:', err.message);
    process.exit(1); // optional: stop if Redis is critical
  });

// Basic error logging
pubClient.on('error', err => console.error('Redis Pub client error:', err.message));
subClient.on('error', err => console.error('Redis Sub client error:', err.message));

// ────────────────────────────────────────────────
// Helper: Get or create Y.Doc + load from MongoDB
// ────────────────────────────────────────────────
async function getOrCreateYDoc(docId) {
  if (docs.has(docId)) {
    return docs.get(docId).ydoc;
  }

  const ydoc = new Y.Doc();

  try {
    const dbDoc = await Document.findOne({ docId });
    if (dbDoc?.state?.buffer) {  // make sure we have valid Buffer
      Y.applyUpdate(ydoc, new Uint8Array(dbDoc.state.buffer));
    }
  } catch (err) {
    console.error(`Error loading document ${docId} from MongoDB:`, err);
  }

  docs.set(docId, {
    ydoc,
    lastSaved: Date.now(),
    saveTimeout: null
  });

  return ydoc;
}

// ────────────────────────────────────────────────
// Socket.IO main logic
// ────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('join-doc', async (docId) => {
    if (!docId || typeof docId !== 'string') return;

    socket.join(`doc:${docId}`);

    try {
      const ydoc = await getOrCreateYDoc(docId);
      const fullState = Y.encodeStateAsUpdate(ydoc);
      socket.emit('sync', fullState);
      socket.emit('joined', docId);
    } catch (err) {
      console.error('Error on join-doc:', err);
      socket.emit('error', 'Failed to load document');
    }
  });

  socket.on('doc-update', async (docId, update) => {
  if (!docs.has(docId) || !update) return;

  const entry = docs.get(docId);
  const { ydoc } = entry;

  try {
    // ✅ Normalize all incoming formats safely
    let uint8;

    if (update instanceof ArrayBuffer) {
      uint8 = new Uint8Array(update);
    } else if (Array.isArray(update)) {
      uint8 = new Uint8Array(update);
    } else if (Buffer.isBuffer(update)) {
      uint8 = new Uint8Array(update);
    } else {
      console.error('Invalid update format');
      return;
    }

    // ✅ Apply update safely
    Y.applyUpdate(ydoc, uint8);

    // ✅ Debounced save
    clearTimeout(entry.saveTimeout);
    entry.saveTimeout = setTimeout(async () => {
      try {
        const encoded = Y.encodeStateAsUpdate(ydoc);

        await Document.updateOne(
          { docId },
          {
            $set: { state: Buffer.from(encoded) },
            $push: {
              versions: {
                $each: [{ timestamp: new Date(), state: Buffer.from(encoded) }],
                $slice: -30
              }
            }
          },
          { upsert: true }
        );

        entry.lastSaved = Date.now();
        console.log(`Saved ${docId}`);
      } catch (err) {
        console.error('Save failed:', err);
      }
    }, 1200);

    // ✅ Broadcast EXACT SAME binary
    io.to(`doc:${docId}`).emit('doc-update', uint8);

  } catch (err) {
    console.error('Apply update failed:', err);
  }
});

  // Awareness / presence
socket.on('awareness-update', (docId, update) => {
  if (!docId || !update) return;

  let uint8;

  if (update instanceof ArrayBuffer) {
    uint8 = new Uint8Array(update);
  } else if (Array.isArray(update)) {
    uint8 = new Uint8Array(update);
  } else if (Buffer.isBuffer(update)) {
    uint8 = new Uint8Array(update);
  } else {
    return;
  }

  io.to(`doc:${docId}`).emit('awareness-update', uint8);
});

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// ────────────────────────────────────────────────
// Optional: API to list versions
// ────────────────────────────────────────────────
app.get('/doc/:id/versions', async (req, res) => {
  try {
    const doc = await Document.findOne({ docId: req.params.id });
    if (!doc) return res.json([]);
    res.json(doc.versions.map(v => ({ timestamp: v.timestamp.toISOString() })));
  } catch (err) {
    console.error('Versions endpoint error:', err);
    res.status(500).json({ error: 'Failed to fetch versions' });
  }
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});