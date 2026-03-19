// backend/models/Document.js
const mongoose = require('mongoose');

const versionSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  state: { type: Buffer, required: true }
});

const documentSchema = new mongoose.Schema({
  docId: { type: String, required: true, unique: true },
  state: { type: Buffer },
  versions: [versionSchema]
}, { timestamps: true });

module.exports = mongoose.model('Document', documentSchema);