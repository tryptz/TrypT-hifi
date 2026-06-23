// Zero-dependency IndexedDB wrapper for the in-app music library.
//
// Downloaded audio normally exits the app via `saveAs()` and is discarded. When
// the user enables "Save to library", the processed audio Blob is also persisted
// here so it can be played back later from the player/playlist — durable across
// page reloads. Blobs are stored as IDB Blob handles (backed by disk), so listing
// metadata does not pull every track's bytes into memory.

export type LibraryTrack = {
    id: number; // Qobuz track id — primary key
    title: string;
    artist: string;
    album: string;
    albumId?: string;
    artworkUrl: string;
    duration: number; // seconds
    codec: string; // 'FLAC' | 'WAV' | 'ALAC' | 'MP3' | 'AAC' | 'OPUS'
    mimeType: string; // for <audio> playback
    extension: string;
    hires: boolean;
    bitDepth: number;
    sampleRate: number;
    trackNumber: number;
    source: 'single' | 'album';
    size: number; // blob byte length
    addedAt: number; // epoch ms
    blob: Blob;
};

/** Library metadata without the heavy audio Blob — what UI lists render from. */
export type LibraryTrackMeta = Omit<LibraryTrack, 'blob'>;

const DB_NAME = 'trypt-hifi-library';
const STORE = 'tracks';
const DB_VERSION = 1;

/** Map an output codec to a MIME type the browser <audio> element understands. */
export const codecMimeMap: Record<string, string> = {
    FLAC: 'audio/flac',
    WAV: 'audio/wav',
    ALAC: 'audio/mp4', // ALAC in m4a — limited browser support (Safari)
    MP3: 'audio/mpeg',
    AAC: 'audio/mp4',
    OPUS: 'audio/ogg'
};

/** Codecs that browsers generally cannot decode in an <audio> element. */
export const unplayableCodecs = new Set(['ALAC']);

let dbPromise: Promise<IDBDatabase> | null = null;

function isAvailable(): boolean {
    return typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
}

function openDB(): Promise<IDBDatabase> {
    if (!isAvailable()) return Promise.reject(new Error('IndexedDB is not available in this environment'));
    if (dbPromise) return dbPromise;
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE)) {
                const store = db.createObjectStore(STORE, { keyPath: 'id' });
                store.createIndex('addedAt', 'addedAt', { unique: false });
                store.createIndex('albumId', 'albumId', { unique: false });
            }
        };
        request.onsuccess = () => {
            const db = request.result;
            // If the connection closes (version change elsewhere, eviction, or an
            // unexpected close), drop the cached promise so the next call reopens.
            db.onversionchange = () => {
                db.close();
                dbPromise = null;
            };
            db.onclose = () => {
                dbPromise = null;
            };
            resolve(db);
        };
        request.onerror = () => reject(request.error ?? new Error('Failed to open library database'));
    });
    return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return openDB().then(
        (db) =>
            new Promise<T>((resolve, reject) => {
                const transaction = db.transaction(STORE, mode);
                const request = fn(transaction.objectStore(STORE));
                transaction.oncomplete = () => resolve(request.result);
                transaction.onabort = () => reject(transaction.error ?? new Error('Library transaction aborted'));
                transaction.onerror = () => reject(transaction.error ?? new Error('Library transaction failed'));
            })
    );
}

/** Persist a track (overwrites any existing track with the same id). */
export async function putLibraryTrack(track: LibraryTrack): Promise<void> {
    await tx('readwrite', (store) => store.put(track));
}

/** Read a single full track record (including its Blob) by id. */
export async function getLibraryTrack(id: number): Promise<LibraryTrack | undefined> {
    if (!isAvailable()) return undefined;
    return tx<LibraryTrack | undefined>('readonly', (store) => store.get(id) as IDBRequest<LibraryTrack | undefined>);
}

/** List all tracks as metadata (Blobs stripped), newest first. */
export async function listLibraryTracks(): Promise<LibraryTrackMeta[]> {
    if (!isAvailable()) return [];
    const all = await tx<LibraryTrack[]>('readonly', (store) => store.getAll() as IDBRequest<LibraryTrack[]>);
    return all
        .map((track) => {
            // Strip the heavy audio Blob; UI lists only need metadata.
            const meta = { ...track } as Partial<LibraryTrack>;
            delete meta.blob;
            return meta as LibraryTrackMeta;
        })
        .sort((a, b) => b.addedAt - a.addedAt);
}

export async function deleteLibraryTrack(id: number): Promise<void> {
    await tx('readwrite', (store) => store.delete(id));
}

export async function clearLibrary(): Promise<void> {
    await tx('readwrite', (store) => store.clear());
}

/** Whether a track id already exists in the library. */
export async function hasLibraryTrack(id: number): Promise<boolean> {
    if (!isAvailable()) return false;
    const key = await tx<IDBValidKey | undefined>('readonly', (store) => store.getKey(id) as IDBRequest<IDBValidKey | undefined>);
    return key !== undefined;
}

/** Total bytes used by saved tracks (summed from stored sizes; no Blob reads). */
export async function getLibrarySize(): Promise<number> {
    const meta = await listLibraryTracks();
    return meta.reduce((sum, t) => sum + (t.size || 0), 0);
}

/** Best-effort browser storage estimate (used vs. quota). */
export async function getStorageEstimate(): Promise<{ usage: number; quota: number } | null> {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
    try {
        const { usage = 0, quota = 0 } = await navigator.storage.estimate();
        return { usage, quota };
    } catch {
        return null;
    }
}
