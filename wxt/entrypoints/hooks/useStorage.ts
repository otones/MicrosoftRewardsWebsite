import {useState, useEffect} from "react";
import {StorageValues} from "@/entrypoints/enums/storageValues.ts"
import { storage } from '#imports';
import {StorageItem} from "@/entrypoints/types/storageItem.ts";

// Matches WXT's branded storage-key type. StorageValues values are exactly
// local/session/sync/managed, so the runtime string always satisfies this shape.
type StorageItemKey = `local:${string}` | `session:${string}` | `sync:${string}` | `managed:${string}`;

export function useStorage<T>(key: string, defaultValue: T, storageType: StorageValues = StorageValues.LOCAL) {
    const storageKey = `${storageType}:${key}` as StorageItemKey;
    const [value, setValue] = useState<T>(defaultValue);
    // What storage holds right now, so a value the hook merely read back can be
    // told apart from an edit by the user. Writing the read-back value again meant
    // one needless write per setting per popup open — nine of them, every one of
    // which wakes the service worker.
    const [stored, setStored] = useState<T | null>(null);
    const [isInitialized, setIsInitialized] = useState(false);

    useEffect(() => {
        storage.getItem(storageKey).then((fetched: any) => {
            const initial = fetched ?? defaultValue;
            setValue(initial);
            setStored(initial);
            setIsInitialized(true);
        });
    }, [storageKey]);

    // Nothing is written while the value already matches storage — including a key
    // that was never set, whose default is now used rather than persisted. Every
    // reader treats a missing key as the default (DEFAULTS, and the background's
    // `?? DEFAULTS.x` fallbacks), so persisting it bought nothing.
    //
    // The comparison is by identity, which is right for the settings this hook
    // holds (booleans, numbers, strings).
    useEffect(() => {
        if (!isInitialized || Object.is(value, stored)) return;
        void storage.setItem(storageKey, value).then(() => setStored(value));
    }, [storageKey, value, stored, isInitialized]);

    return [value, setValue] as const;
}

export async function getStorageItem<T = any>(key: string, storageType: StorageValues = StorageValues.LOCAL): Promise<T | null> {
    const storageKey = `${storageType}:${key}` as StorageItemKey;
    return await storage.getItem<T>(storageKey);
}

export async function setStorageItem(key: string, value: any, storageType: StorageValues = StorageValues.LOCAL) {
    const storageKey = `${storageType}:${key}` as StorageItemKey;
    await storage.setItem(storageKey, value);
}

export async function setStorageItems(items: Record<string, any>, storageType: StorageValues = StorageValues.LOCAL) {
    const storageItems = Object.entries(items).map(([key, value]) => ({
        key: `${storageType}:${key}` as StorageItemKey,
        value
    }));
    await storage.setItems(storageItems);
}

export async function getStorageItems(keys: string[], storageType: StorageValues = StorageValues.LOCAL) {
    const storageKeys: StorageItemKey[] = keys.map((key: string) => `${storageType}:${key}` as StorageItemKey);
    const items = await storage.getItems(storageKeys);
    return items.reduce((acc: { [x: string]: any; }, item: StorageItem) => {
        const shortKey = item.key.split(":")[1];
        acc[shortKey] = item.value;
        return acc;
    }, {});
}

function asAppendItems<T>(v: T | T[]): T[] {
    return Array.isArray(v) ? v : [v];
}

export async function mergeIntoStorageItem<T>(
    key: string,
    newValue: T | T[],
    storageType: StorageValues = StorageValues.LOCAL
) {
    const storageKey = `${storageType}:${key}` as StorageItemKey;
    const existingValue = await storage.getItem(storageKey);

    let updatedValue: unknown;

    if (existingValue == null) {
        updatedValue = asAppendItems(newValue);
    } else if (Array.isArray(existingValue)) {
        updatedValue = existingValue.concat(asAppendItems(newValue));
    } else if (typeof existingValue === 'string') {
        updatedValue = existingValue + String(newValue);
    } else if (typeof existingValue === 'number') {
        updatedValue = (existingValue as number) + (newValue as any);
    } else {
        throw new Error('mergeIntoStorageItem: Unsupported data type for appending.');
    }

    await storage.setItem(storageKey, updatedValue);
}
