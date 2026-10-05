import type { AudioRecord, Book } from '../types';

const DB_NAME = 'livrevox-db';
const DB_VERSION = 1;
const BOOKS = 'books';
const AUDIO = 'audio';

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
  const tx = db.transaction([BOOKS, AUDIO], 'readwrite');
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
