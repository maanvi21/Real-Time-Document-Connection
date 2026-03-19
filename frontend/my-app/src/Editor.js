import React, { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import io from 'socket.io-client';

const SOCKET_URL = 'http://localhost:4000';
const socket = io(SOCKET_URL);

// Get document ID
const urlParams = new URLSearchParams(window.location.search);
const docId = urlParams.get('doc') || 'test123';

// Yjs setup
const ydoc = new Y.Doc();
const ytext = ydoc.getText('content');

// Awareness
const awareness = new awarenessProtocol.Awareness(ydoc);

awareness.setLocalState({
  name: `User-${Math.floor(Math.random() * 10000)}`,
  color: '#' + Math.floor(Math.random() * 16777215).toString(16),
  online: true
});

function Editor() {
  const textareaRef = useRef(null);
  const [content, setContent] = useState('');
  const [users, setUsers] = useState([]);

  useEffect(() => {
    socket.emit('join-doc', docId);

    // ✅ Receive initial sync
    socket.on('sync', (update) => {
      Y.applyUpdate(ydoc, new Uint8Array(update), 'remote');
    });

    // ✅ Receive incremental updates
    socket.on('doc-update', (update) => {
      Y.applyUpdate(ydoc, new Uint8Array(update), 'remote');
    });

    // ✅ Receive awareness
    socket.on('awareness-update', (update) => {
      awarenessProtocol.applyAwarenessUpdate(
        awareness,
        new Uint8Array(update),
        socket.id
      );
    });

    // ✅ Send Yjs updates (ONLY diffs, not full state)
    ydoc.on('update', (update, origin) => {
      if (origin !== 'remote') {
        socket.emit('doc-update', docId, update);
      }
    });

    // ✅ Observe text changes → update UI
    const observer = () => {
      setContent(ytext.toString());
    };
    ytext.observe(observer);

    // ✅ Handle typing
    const handleInput = (e) => {
      const value = e.target.value;

      ydoc.transact(() => {
        ytext.delete(0, ytext.length);
        ytext.insert(0, value);
      });
    };

    textareaRef.current.addEventListener('input', handleInput);

    // ✅ Awareness send on change
    awareness.on('update', ({ added, updated, removed }) => {
      const changed = [...added, ...updated, ...removed];

      if (changed.length > 0) {
        const update = awarenessProtocol.encodeAwarenessUpdate(
          awareness,
          changed
        );
        socket.emit('awareness-update', docId, update.buffer);
      }
    });

    // ✅ Update user list
    const updateUsers = () => {
      const states = awareness.getStates();
      const list = [];

      states.forEach((s) => {
        if (s?.name && s?.online) list.push(s.name);
      });

      setUsers(list);
    };

    awareness.on('update', updateUsers);
    updateUsers();

    return () => {
      ytext.unobserve(observer);
      awareness.off('update', updateUsers);
      textareaRef.current?.removeEventListener('input', handleInput);

      socket.off('sync');
      socket.off('doc-update');
      socket.off('awareness-update');
    };
  }, []);

  return (
    <div style={{ padding: 24, maxWidth: 900, margin: 'auto' }}>
      <h1>Collaborative Editor</h1>
      <h3>Document: {docId}</h3>

      <div style={{ marginBottom: 10 }}>
        Online: {users.length === 0 ? 'Only you' : users.join(', ')}
      </div>

      <textarea
        ref={textareaRef}
        value={content}
        onChange={() => {}}
        style={{
          width: '100%',
          minHeight: 400,
          padding: 12,
          fontSize: 16
        }}
      />
    </div>
  );
}

export default Editor;