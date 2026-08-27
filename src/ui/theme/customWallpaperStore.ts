const DATABASE_NAME = 'televecha-preferences';
const DATABASE_VERSION = 1;
const STORE_NAME = 'assets';
const WALLPAPER_KEY = 'custom-wallpaper';
const TELEGRAM_WALLPAPER_KEY = 'telegram-wallpaper';
export const MAX_CUSTOM_WALLPAPER_BYTES = 12 * 1024 * 1024;

function openWallpaperDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('Could not open appearance storage.'));
  });
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Appearance storage failed.'));
  });
}

async function loadWallpaper(key: string) {
  const database = await openWallpaperDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    return await requestResult(
      transaction.objectStore(STORE_NAME).get(key) as IDBRequest<Blob | undefined>,
    );
  } finally {
    database.close();
  }
}

export function loadCustomWallpaper() {
  return loadWallpaper(WALLPAPER_KEY);
}

export function loadTelegramWallpaper() {
  return loadWallpaper(TELEGRAM_WALLPAPER_KEY);
}

export async function saveCustomWallpaper(file: File) {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
  if (file.size > MAX_CUSTOM_WALLPAPER_BYTES) {
    throw new Error('The background image must be smaller than 12 MB.');
  }
  const database = await openWallpaperDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    await requestResult(transaction.objectStore(STORE_NAME).put(file, WALLPAPER_KEY));
  } finally {
    database.close();
  }
}

export async function saveTelegramWallpaper(blob: Blob) {
  const database = await openWallpaperDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    await requestResult(transaction.objectStore(STORE_NAME).put(blob, TELEGRAM_WALLPAPER_KEY));
  } finally {
    database.close();
  }
}

export async function deleteCustomWallpaper() {
  const database = await openWallpaperDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    await requestResult(transaction.objectStore(STORE_NAME).delete(WALLPAPER_KEY));
  } finally {
    database.close();
  }
}
