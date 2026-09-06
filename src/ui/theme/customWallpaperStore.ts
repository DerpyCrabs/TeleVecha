import { Effect, Schema } from 'effect';
import { type DBSchema, type IDBPDatabase, openDB } from 'idb';

const DATABASE_NAME = 'televecha-preferences';
const DATABASE_VERSION = 1;
const STORE_NAME = 'assets';
const WALLPAPER_KEY = 'custom-wallpaper';
const TELEGRAM_WALLPAPER_KEY = 'telegram-wallpaper';
export const MAX_CUSTOM_WALLPAPER_BYTES = 12 * 1024 * 1024;

interface AppearanceSchema extends DBSchema {
  assets: { key: string; value: Blob };
}

const StorageOperation = Schema.Literals(['open', 'load', 'save', 'delete']);
type StorageOperation = typeof StorageOperation.Type;

export class WallpaperStorageError extends Schema.TaggedError<WallpaperStorageError>()(
  'WallpaperStorageError',
  { operation: StorageOperation, message: Schema.String, cause: Schema.Defect() },
) {}

export class WallpaperValidationError extends Schema.TaggedError<WallpaperValidationError>()(
  'WallpaperValidationError',
  { message: Schema.String },
) {}

const operationMessages: Record<StorageOperation, string> = {
  open: 'Could not open appearance storage.',
  load: 'Could not load the saved background.',
  save: 'Could not save the background.',
  delete: 'Could not delete the saved background.',
};

const storageError = (operation: StorageOperation, cause: unknown): WallpaperStorageError =>
  new WallpaperStorageError({ operation, message: operationMessages[operation], cause });

const validationError = (message: string): WallpaperValidationError =>
  new WallpaperValidationError({ message });

const openWallpaperDatabase = Effect.callback<
  IDBPDatabase<AppearanceSchema>,
  WallpaperStorageError
>((resume) => {
  let settled = false;
  let databaseConnection: IDBPDatabase<AppearanceSchema> | undefined;
  let opening: PromiseLike<IDBPDatabase<AppearanceSchema>>;
  try {
    opening = openDB<AppearanceSchema>(DATABASE_NAME, DATABASE_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
      },
    });
  } catch (cause) {
    settled = true;
    resume(Effect.fail(storageError('open', cause)));
    return Effect.void;
  }
  void opening.then(
    (database) => {
      databaseConnection = database;
      if (settled) database.close();
      else {
        settled = true;
        resume(Effect.succeed(database));
      }
    },
    (cause) => {
      if (settled) return;
      settled = true;
      resume(Effect.fail(storageError('open', cause)));
    },
  );
  return Effect.sync(() => {
    settled = true;
    databaseConnection?.close();
  });
});

const useDatabase = <A>(
  operation: Exclude<StorageOperation, 'open'>,
  use: (database: IDBPDatabase<AppearanceSchema>) => Effect.Effect<A, WallpaperStorageError>,
) =>
  Effect.acquireUseRelease(openWallpaperDatabase, use, (database) =>
    Effect.sync(() => database.close()),
  ).pipe(
    Effect.mapError((error) =>
      error._tag === 'WallpaperStorageError' ? error : storageError(operation, error),
    ),
  );

const request = <A>(operation: Exclude<StorageOperation, 'open'>, evaluate: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => storageError(operation, cause) });

const loadWallpaper = (key: string) =>
  useDatabase('load', (database) => request('load', () => database.get(STORE_NAME, key)));

export const loadCustomWallpaper = loadWallpaper(WALLPAPER_KEY);
export const loadTelegramWallpaper = loadWallpaper(TELEGRAM_WALLPAPER_KEY);

export const saveCustomWallpaper = (
  file: File,
): Effect.Effect<void, WallpaperStorageError | WallpaperValidationError> => {
  if (!file.type.startsWith('image/')) return Effect.fail(validationError('Choose an image file.'));
  if (file.size > MAX_CUSTOM_WALLPAPER_BYTES) {
    return Effect.fail(validationError('The background image must be smaller than 12 MB.'));
  }
  return useDatabase('save', (database) =>
    request('save', () => database.put(STORE_NAME, file, WALLPAPER_KEY)).pipe(Effect.asVoid),
  );
};

export const saveTelegramWallpaper = (blob: Blob) =>
  useDatabase('save', (database) =>
    request('save', () => database.put(STORE_NAME, blob, TELEGRAM_WALLPAPER_KEY)).pipe(
      Effect.asVoid,
    ),
  );

export const deleteCustomWallpaper = useDatabase('delete', (database) =>
  request('delete', () => database.delete(STORE_NAME, WALLPAPER_KEY)),
);
