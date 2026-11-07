import type { AudioRecord, Book } from '../types';

const DB_NAME = 'livrevox-db';
const DB_VERSION = 3;
const BOOKS = 'books';
const AUDIO = 'audio';
const SPEECH_SEGMENTS = 'speech_segments';
const SUMMARY_SEGMENTS = 'summary_segments';

export type SavedSummarySegment = {
  id: string;
  bookId: string;
  chapterId: string;
  stage: number;
  index: number;
  textHash: string;
  text: string;
};

export type SavedSpeechSegment = {
  id: string;
  bookId: string;
  chapterId: string;
  voiceId: string;
  index: number;
  textHash: string;
  blob: Blob;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BOOKS))
        db.createObjectStore(BOOKS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(AUDIO)) {
        const store = db.createObjectStore(AUDIO, { keyPath: 'id' });
        store.createIndex('bookId', 'bookId', { unique: false });
      }
      if (!db.objectStoreNames.contains(SPEECH_SEGMENTS)) {
        const store = db.createObjectStore(SPEECH_SEGMENTS, { keyPath: 'id' });
        store.createIndex('bookId', 'bookId', { unique: false });
        store.createIndex('chapterId', 'chapterId', { unique: false });
      }
      if (!db.objectStoreNames.contains(SUMMARY_SEGMENTS)) {
        const store = db.createObjectStore(SUMMARY_SEGMENTS, { keyPath: 'id' });
        store.createIndex('bookId', 'bookId', { unique: false });
        store.createIndex('chapterId', 'chapterId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error ?? new Error('Impossible d’ouvrir le stockage local.')
      );
  });
}

function requestAsPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('Erreur de stockage local.'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error('Transaction locale échouée.'));
    tx.onabort = () =>
      reject(tx.error ?? new Error('Transaction locale annulée.'));
  });
}

export async function getBooks(): Promise<Book[]> {
  const db = await openDb();
  const tx = db.transaction(BOOKS, 'readonly');
  const result = await requestAsPromise(
    tx.objectStore(BOOKS).getAll() as IDBRequest<Book[]>
  );
  db.close();
  return result.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function putBook(book: Book): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(BOOKS, 'readwrite');
  tx.objectStore(BOOKS).put(book);
  await transactionDone(tx);
  db.close();
}

export async function deleteBook(bookId: string): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction([BOOKS, AUDIO, SPEECH_SEGMENTS, SUMMARY_SEGMENTS], 'readwrite');
    const finished = transactionDone(tx);
    tx.objectStore(BOOKS).delete(bookId);

    function removeByBook(storeName: string): Promise<void> {
      const cursorRequest = tx.objectStore(storeName)
        .index('bookId').openCursor(IDBKeyRange.only(bookId));
      return new Promise<void>((resolve, reject) => {
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return resolve();
          cursor.delete();
          cursor.continue();
        };
        cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('Suppression audio échouée.'));
      });
    }
    // Queue both cursor operations before the IndexedDB transaction commits.
    await Promise.all([removeByBook(AUDIO), removeByBook(SPEECH_SEGMENTS), removeByBook(SUMMARY_SEGMENTS)]);
    await finished;
  } finally {
    db.close();
  }
}

export async function putAudio(record: AudioRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(AUDIO, 'readwrite');
  tx.objectStore(AUDIO).put(record);
  await transactionDone(tx);
  db.close();
}

export async function getAudio(
  bookId: string,
  chapterId: string
): Promise<AudioRecord | undefined> {
  const db = await openDb();
  const tx = db.transaction(AUDIO, 'readonly');
  const result = await requestAsPromise(
    tx.objectStore(AUDIO).get(`${bookId}:${chapterId}`) as IDBRequest<
      AudioRecord | undefined
    >
  );
  db.close();
  return result;
}

export async function getBookAudio(bookId: string): Promise<AudioRecord[]> {
  const db = await openDb();
  const tx = db.transaction(AUDIO, 'readonly');
  const index = tx.objectStore(AUDIO).index('bookId');
  const result = await requestAsPromise(
    index.getAll(IDBKeyRange.only(bookId)) as IDBRequest<AudioRecord[]>
  );
  db.close();
  return result;
}

export async function deleteAudio(
  bookId: string,
  chapterId: string
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(AUDIO, 'readwrite');
  tx.objectStore(AUDIO).delete(`${bookId}:${chapterId}`);
  await transactionDone(tx);
  db.close();
}

/** Save each successfully generated Gemini segment before requesting the next. */
export async function saveSpeechSegment(segment: SavedSpeechSegment): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(SPEECH_SEGMENTS, 'readwrite');
    tx.objectStore(SPEECH_SEGMENTS).put(segment);
    await transactionDone(tx);
  } finally {
    db.close();
  }
}

export async function getSpeechSegments(bookId: string, chapterId: string): Promise<SavedSpeechSegment[]> {
  const db = await openDb();
  try {
    const tx = db.transaction(SPEECH_SEGMENTS, 'readonly');
    return await requestAsPromise(
      tx.objectStore(SPEECH_SEGMENTS).index('chapterId')
        .getAll(IDBKeyRange.only(chapterId)) as IDBRequest<SavedSpeechSegment[]>
    ).then(segments => segments.filter(s => s.bookId === bookId));
  } finally {
    db.close();
  }
}

export async function clearSpeechSegments(bookId: string, chapterId: string): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(SPEECH_SEGMENTS, 'readwrite');
    const finished = transactionDone(tx);
    const store = tx.objectStore(SPEECH_SEGMENTS);
    const cursorReq = store.index('chapterId').openCursor(IDBKeyRange.only(chapterId));
    await new Promise<void>((resolve, reject) => {
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return resolve();
        if ((cursor.value as SavedSpeechSegment).bookId === bookId) cursor.delete();
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error ?? new Error('Suppression segments impossible.'));
    });
    await finished;
  } finally {
    db.close();
  }
}

/** Durable chapter notes: a slow final merge never discards completed analysis. */
export async function getSummarySegments(bookId: string, chapterId: string): Promise<SavedSummarySegment[]> {
  const db = await openDb();
  try {
    const tx = db.transaction(SUMMARY_SEGMENTS, 'readonly');
    const values = await requestAsPromise(
      tx.objectStore(SUMMARY_SEGMENTS).index('chapterId')
        .getAll(IDBKeyRange.only(chapterId)) as IDBRequest<SavedSummarySegment[]>
    );
    return values.filter(item => item.bookId === bookId);
  } finally {
    db.close();
  }
}

export async function saveSummarySegment(segment: SavedSummarySegment): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(SUMMARY_SEGMENTS, 'readwrite');
    tx.objectStore(SUMMARY_SEGMENTS).put(segment);
    await transactionDone(tx);
  } finally {
    db.close();
  }
}

export async function clearSummarySegments(bookId: string, chapterId: string): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(SUMMARY_SEGMENTS, 'readwrite');
    const complete = transactionDone(tx);
    const cursors = tx.objectStore(SUMMARY_SEGMENTS).index('chapterId').openCursor(IDBKeyRange.only(chapterId));
    await new Promise<void>((resolve, reject) => {
      cursors.onsuccess = () => {
        const cursor = cursors.result;
        if (!cursor) { resolve(); return; }
        if ((cursor.value as SavedSummarySegment).bookId === bookId) cursor.delete();
        cursor.continue();
      };
      cursors.onerror = () => reject(cursors.error || new Error('Erreur de nettoyage de la fiche.'));
    });
    await complete;
  } finally {
    db.close();
  }
}
