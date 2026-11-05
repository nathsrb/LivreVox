import type { AudioRecord, Book } from '../types';

const DB_NAME = 'livrevox-db';
const DB_VERSION = 2;
const BOOKS = 'books';
const AUDIO = 'audio';
const SPEECH_SEGMENTS = 'speech_segments';

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
  const tx = db.transaction([BOOKS, AUDIO, SPEECH_SEGMENTS], 'readwrite');
  tx.objectStore(BOOKS).delete(bookId);
  const audioStore = tx.objectStore(AUDIO);
  const index = audioStore.index('bookId');
  const cursorRequest = index.openCursor(IDBKeyRange.only(bookId));
  await new Promise<void>((resolve, reject) => {
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        resolve();
        return;
      }
      cursor.delete();
      cursor.continue();
    };
    cursorRequest.onerror = () =>
      reject(cursorRequest.error ?? new Error('Suppression audio échouée.'));
  });
  // Remove temporary audio segments when deleting an entire book.
  const segmentRequest = tx.objectStore(SPEECH_SEGMENTS)
    .index('bookId').openCursor(IDBKeyRange.only(bookId));
  await new Promise<void>((resolve, reject) => {
    segmentRequest.onsuccess = () => {
      const cursor = segmentRequest.result;
      if (!cursor) return resolve();
      cursor.delete();
      cursor.continue();
    };
    segmentRequest.onerror = () => reject(segmentRequest.error ?? new Error('Nettoyage audio incomplet.'));
  });
  await transactionDone(tx);
  db.close();
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
    await transactionDone(tx);
  } finally {
    db.close();
  }
}
