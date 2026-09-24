'use client';

import { zipSync, unzipSync, strToU8 } from 'fflate';
import localforage from 'localforage';
import { closeImageDb } from '@/lib/image-db';
import {
    ensureIndexedDbSchema,
    getBackedUpIndexedDbContracts,
    getBackedUpLocalForageContracts,
    getBackedUpLocalStorageKeys,
    INDEXED_DB,
    LOCAL_STORAGE_KEYS,
    STORAGE_CONTRACT_VERSION,
    type IndexedDbContract,
} from '@/lib/storage-contract';

export interface BackupProgress {
    percent: number;
    message: string;
    values?: Record<string, string | number>;
}

export type ProgressCallback = (progress: BackupProgress) => void;

type BackupRecord = Record<string, unknown>;
type DatabaseBackup = Record<string, BackupRecord[]>;
type IndexedDBBackup = Record<string, DatabaseBackup>;
type BlobRef = { _blobRef: string; _blobMimeType: string };

function isBackupRecord(value: unknown): value is BackupRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 判断值是否为可安全逐字段递归处理的普通对象。
 * @param value 待判断的未知值。
 * @returns 普通对象或无原型对象返回 true，Date 等结构化克隆对象返回 false。
 */
function isPlainBackupRecord(value: unknown): value is BackupRecord {
    if (!isBackupRecord(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function isBlobRef(value: unknown): value is BlobRef {
    return isBackupRecord(value)
        && typeof value['_blobRef'] === 'string'
        && typeof value['_blobMimeType'] === 'string';
}

/**
 * 递归校验备份清单中的每个 Blob 引用都存在对应二进制文件。
 * @param value 当前需要扫描的备份数据节点。
 * @param unzipped 已完整解压的 ZIP 文件映射。
 * @param location 当前节点在备份中的诊断路径。
 * @returns 无返回值；发现悬空引用时立即抛出错误并阻止任何恢复写入。
 */
function validateBlobReferences(value: unknown, unzipped: Record<string, Uint8Array>, location: string): void {
    if (isBackupRecord(value) && '_blobRef' in value && !isBlobRef(value)) {
        throw new Error(`备份文件包含无效的 Blob 引用：${location}`);
    }
    if (isBlobRef(value)) {
        if (!unzipped[`blobs/${value._blobRef}`]) {
            throw new Error(`备份文件缺少 Blob 数据：${location} -> ${value._blobRef}`);
        }
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item, index) => validateBlobReferences(item, unzipped, `${location}[${index}]`));
        return;
    }
    if (!isBackupRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
        validateBlobReferences(child, unzipped, `${location}.${key}`);
    }
}

/**
 * 判断 localForage 是否因为浏览器完全没有可用驱动而失败。
 * @param error localForage 操作抛出的未知错误。
 * @returns 仅当错误明确表示没有可用存储驱动时返回 true。
 */
function isLocalForageUnavailable(error: unknown): boolean {
    return error instanceof Error && /no available storage method/i.test(error.message);
}

// 所有备份范围均由统一存储契约派生，新增存储时不再修改本模块。
const LOCAL_STORAGE_BACKUP_KEYS = getBackedUpLocalStorageKeys();
const INDEXEDDB_DATABASES = getBackedUpIndexedDbContracts();
const LOCALFORAGE_STORES = getBackedUpLocalForageContracts();

type LocalForageEntry = { key: string; value: unknown } | { key: string; _blobRef: string; _blobMimeType: string };
type LocalForageBackup = Record<string, Record<string, LocalForageEntry[]>>;

/** Blob → Uint8Array（fflate 需要 Uint8Array） */
async function blobToUint8(blob: Blob): Promise<Uint8Array> {
    const ab = await blob.arrayBuffer();
    return new Uint8Array(ab);
}

// 用于生成导出时 Blob 的唯一引用 ID
let _blobRefSeq = 0;
function nextBlobRef(): string {
    return `b${Date.now()}_${++_blobRefSeq}`;
}

/**
 * 将 JSON 数据转为 fflate 可用的 Uint8Array
 */
function jsonToU8(data: unknown): Uint8Array {
    return strToU8(JSON.stringify(data));
}

/**
 * 导出 localforage（keyless）store：保留 key；Blob 值以二进制存入 ZIP blobs/，JSON 内留引用。
 * 数据逐 store 写入 files 对象，释放引用后可被 GC 回收。
 */
async function exportLocalForage(files: Record<string, Uint8Array>): Promise<LocalForageBackup> {
    const result: LocalForageBackup = {};
    for (const cfg of LOCALFORAGE_STORES) {
        const entries: LocalForageEntry[] = [];
        const blobWrites: Promise<void>[] = [];
        try {
            const instance = localforage.createInstance({ name: cfg.name, storeName: cfg.storeName });
            await instance.iterate((value: unknown, key: string) => {
                if (value instanceof Blob) {
                    const ref = nextBlobRef();
                    // 必须等待全部二进制转换完成后再压缩 ZIP，否则大画布导出时 JSON 引用可能先于图片字节写入。
                    blobWrites.push(blobToUint8(value).then(u8 => { files[`blobs/${ref}`] = u8; }));
                    entries.push({ key, _blobRef: ref, _blobMimeType: value.type });
                } else {
                    // iterate 回调不能返回异步任务，因此先收集序列化任务，压缩前再统一等待。
                    blobWrites.push(exportBackupValue(value, files).then(serializedValue => {
                        entries.push({ key, value: serializedValue });
                    }));
                }
            });
        } catch (error) {
            // localForage 不可用时，画布状态由已纳入契约的 localStorage fallback key 兜底。
            if (isLocalForageUnavailable(error)) continue;
            throw new Error(`导出 localForage 失败：${cfg.name}/${cfg.storeName}`, { cause: error });
        }
        // 二进制转换失败意味着备份不完整，必须让导出失败，不能生成带悬空引用的 ZIP。
        await Promise.all(blobWrites);
        if (!result[cfg.name]) result[cfg.name] = {};
        result[cfg.name][cfg.storeName] = entries;
    }
    return result;
}

/**
 * 导入 localforage（keyless）store：先清空，再按 key 写回；Blob 从 ZIP 还原。
 */
async function importLocalForage(data: LocalForageBackup, unzipped: Record<string, Uint8Array>): Promise<void> {
    for (const cfg of LOCALFORAGE_STORES) {
        const entries = data[cfg.name]?.[cfg.storeName];
        try {
            const instance = localforage.createInstance({ name: cfg.name, storeName: cfg.storeName });
            // 完整恢复必须先清空所有受管 store；旧备份没有该 store 时也不能保留当前浏览器中的新数据。
            await instance.clear();
            if (!Array.isArray(entries)) continue;
            for (const entry of entries) {
                let value: unknown;
                if ('_blobRef' in entry && typeof entry._blobRef === 'string') {
                    const blobData = unzipped[`blobs/${entry._blobRef}`];
                    if (!blobData) throw new Error(`备份文件缺少 Blob 数据：${entry._blobRef}`);
                    value = new Blob([blobData as unknown as BlobPart], { type: entry._blobMimeType });
                } else {
                    value = await importBackupValue((entry as { value: unknown }).value, unzipped);
                }
                await instance.setItem(entry.key, value);
            }
        } catch (error) {
            if (isLocalForageUnavailable(error)) {
                // 无法访问驱动且备份没有该 store 数据时可以跳过；有数据时必须报告失败，禁止静默丢失画布图片。
                if (!Array.isArray(entries) || entries.length === 0) continue;
            }
            throw new Error(`恢复 localForage 失败：${cfg.name}/${cfg.storeName}`, { cause: error });
        }
    }
}

/**
 * 导出 localStorage 数据
 */
function exportLocalStorage(): Record<string, string> {
    const data: Record<string, string> = {};

    for (const key of LOCAL_STORAGE_BACKUP_KEYS) {
        try {
            const value = localStorage.getItem(key);
            if (value !== null) data[key] = value;
        } catch (error) {
            throw new Error(`读取 localStorage 失败：${key}`, { cause: error });
        }
    }

    return data;
}

/**
 * 按统一契约打开 IndexedDB，并在版本升级事务中补齐 store 与索引。
 * @param contract 待打开数据库的结构契约。
 * @returns 数据库连接；运行环境不支持 IndexedDB 时返回 null。
 */
function openDatabase(contract: IndexedDbContract): Promise<IDBDatabase | null> {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            resolve(null);
            return;
        }

        const request = indexedDB.open(contract.name, contract.version);

        request.onerror = () => reject(request.error || new Error(`无法打开 IndexedDB：${contract.name}`));
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (e) => {
            const requestTarget = e.target as IDBOpenDBRequest;
            const db = requestTarget.result;
            ensureIndexedDbSchema(db, requestTarget.transaction, contract);
        };
    });
}

/**
 * 将 IndexedDB 值转换为可写入备份 JSON 的结构。
 * @param value store 中读取的原始值。
 * @param files ZIP 文件集合，Blob 二进制会写入其中。
 * @returns 可序列化的值；Blob 会替换为二进制引用。
 */
async function exportBackupValue(value: unknown, files: Record<string, Uint8Array>): Promise<unknown> {
    if (value instanceof Blob) {
        const ref = nextBlobRef();
        files[`blobs/${ref}`] = await blobToUint8(value);
        return { _blobRef: ref, _blobMimeType: value.type };
    }
    if (Array.isArray(value)) {
        return Promise.all(value.map(item => exportBackupValue(item, files)));
    }
    // Date 等非普通对象交给 JSON.stringify 的原生转换处理，避免递归后变成空对象。
    if (!isPlainBackupRecord(value)) return value;

    const processed: BackupRecord = {};
    for (const [key, child] of Object.entries(value)) {
        processed[key] = await exportBackupValue(child, files);
    }
    return processed;
}

/**
 * 递归还原备份值中的 Blob 引用。
 * @param value 从备份 JSON 解析出的任意数据节点。
 * @param unzipped 已完整解压的 ZIP 文件映射。
 * @returns 与原始结构一致的值，其中所有 Blob 引用均已替换为 Blob 实例。
 */
async function importBackupValue(value: unknown, unzipped: Record<string, Uint8Array>): Promise<unknown> {
    if (isBlobRef(value)) {
        const blobData = unzipped[`blobs/${value._blobRef}`];
        if (!blobData) throw new Error(`备份文件缺少 Blob 数据：${value._blobRef}`);
        return new Blob([blobData as unknown as BlobPart], { type: value._blobMimeType });
    }
    if (Array.isArray(value)) {
        return Promise.all(value.map(item => importBackupValue(item, unzipped)));
    }
    if (!isBackupRecord(value)) return value;

    const processed: BackupRecord = {};
    for (const [key, child] of Object.entries(value)) {
        processed[key] = await importBackupValue(child, unzipped);
    }
    return processed;
}

/**
 * 导出单个 IndexedDB store 的全部记录和必要的外部 key。
 * @param db 已打开的 IndexedDB 数据库。
 * @param storeName 待导出的 store 名称。
 * @param files ZIP 文件集合。
 * @returns 可完整恢复 keyed 或 keyless store 的备份记录。
 */
async function exportStore(db: IDBDatabase, storeName: string, files: Record<string, Uint8Array>): Promise<BackupRecord[]> {
    return new Promise((resolve, reject) => {
        try {
            const transaction = db.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const recordsRequest = store.getAll();
            const keysRequest = store.getAllKeys();
            const keyless = store.keyPath === null;

            transaction.oncomplete = () => {
                void Promise.all(recordsRequest.result.map(async (record, index) => {
                    const value = await exportBackupValue(record, files);
                    if (keyless) {
                        return { _idbKey: keysRequest.result[index], _idbValue: value } as BackupRecord;
                    }
                    return isBackupRecord(value) ? value : { _idbValue: value };
                })).then(resolve, reject);
            };
            transaction.onerror = () => reject(transaction.error);
        } catch (error) {
            reject(error);
        }
    });
}

/**
 * 导出所有 IndexedDB 数据
 * 逐数据库、逐 store 顺序处理，处理完立即写入 files，降低内存峰值
 */
async function exportIndexedDB(files: Record<string, Uint8Array>, onProgress?: ProgressCallback): Promise<IndexedDBBackup> {
    const allData: IndexedDBBackup = {};
    let completedStores = 0;
    const totalStores = INDEXEDDB_DATABASES.reduce((sum, db) => sum + db.stores.length, 0);

    for (const dbConfig of INDEXEDDB_DATABASES) {
        const db = await openDatabase(dbConfig);

        if (!db) {
            continue;
        }

        const dbData: DatabaseBackup = {};
        try {
            for (const storeConfig of dbConfig.stores) {
                const storeName = storeConfig.name;
                if (!db.objectStoreNames.contains(storeName)) {
                    throw new Error(`IndexedDB 结构不完整：${dbConfig.name}/${storeName}`);
                }

                const storeData = await exportStore(db, storeName, files);
                dbData[storeName] = storeData;

                completedStores++;
                if (onProgress) {
                    const percent = 10 + Math.floor((completedStores / totalStores) * 80);
                    onProgress({
                        percent,
                        message: 'settings.backupProgressExportStore',
                        values: { store: `${dbConfig.name}/${storeName}` },
                    });
                }
            }
            allData[dbConfig.name] = dbData;
        } catch (error) {
            throw new Error(`导出 IndexedDB 失败：${dbConfig.name}`, { cause: error });
        } finally {
            db.close();
        }
    }

    return allData;
}

/**
 * 导出所有数据为 ZIP 文件
 * 使用 fflate 替代 JSZip，显著降低内存占用和处理时间
 * @param onProgress 导出进度回调函数。
 * @param appVersion 当前运行时平台版本号，写入备份元数据。
 * @returns 包含全部浏览器数据的 ZIP 文件 Blob。
 */
export async function exportAllData(onProgress?: ProgressCallback, appVersion: string = '0.0.0'): Promise<Blob> {
    if (onProgress) {
        onProgress({ percent: 0, message: 'settings.backupProgressExportStart' });
    }

    // 导出 localStorage
    if (onProgress) {
        onProgress({ percent: 5, message: 'settings.backupProgressExportStorage' });
    }
    const localStorageData = exportLocalStorage();

    // 逐 store 导出 IndexedDB，Blob 数据直接转为 Uint8Array 存入 files
    const files: Record<string, Uint8Array> = {};
    const indexedDBData = await exportIndexedDB(files, onProgress);

    // 导出 localforage 数据
    const localForageData = await exportLocalForage(files);

    // 打包元数据和 localStorage JSON
    if (onProgress) {
        onProgress({ percent: 90, message: 'settings.backupProgressPackaging' });
    }

    // 添加元数据
    files['metadata.json'] = jsonToU8({
        version: appVersion,
        storageContractVersion: STORAGE_CONTRACT_VERSION,
        exportDate: new Date().toISOString(),
        appName: 'Lynwu Image',
    });

    // 添加 localStorage 数据
    files['localStorage.json'] = jsonToU8(localStorageData);

    // 添加 IndexedDB 数据
    for (const [dbName, dbData] of Object.entries(indexedDBData)) {
        files[`indexedDB/${dbName}.json`] = jsonToU8(dbData);
    }

    // 添加 localforage（无限画布）数据
    for (const [dbName, dbData] of Object.entries(localForageData)) {
        files[`localforage/${dbName}.json`] = jsonToU8(dbData);
    }

    if (onProgress) {
        onProgress({ percent: 95, message: 'settings.backupProgressZip' });
    }

    // 使用 fflate 同步压缩（比 JSZip 快 10-20 倍，内存占用更低）
    const zipped = zipSync(files, { level: 6 });
    const blob = new Blob([zipped], { type: 'application/zip' });

    if (onProgress) {
        onProgress({ percent: 100, message: 'settings.backupProgressExportDone' });
    }

    return blob;
}

/**
 * 从 base64 字符串创建 Blob
 */
function base64ToBlob(base64: string, mimeType: string): Blob {
    const byteCharacters = atob(base64);
    const byteNumbers = new Array(byteCharacters.length);

    for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
    }

    const byteArray = new Uint8Array(byteNumbers);
    return new Blob([byteArray], { type: mimeType });
}

/**
 * 在修改现有数据前校验 localStorage 备份清单。
 * @param data 从 localStorage.json 解析出的未知值。
 * @returns 仅包含契约允许 key 且所有值均为字符串的恢复数据。
 */
function validateLocalStorageBackup(data: unknown): Record<string, string> {
    if (!isBackupRecord(data)) throw new Error('备份文件中的 localStorage.json 不是合法对象');

    const validated: Record<string, string> = {};
    const allowedKeySet = new Set(LOCAL_STORAGE_BACKUP_KEYS);
    for (const [key, value] of Object.entries(data)) {
        if (!allowedKeySet.has(key)) continue;
        if (typeof value !== 'string') throw new Error(`备份文件中的 localStorage 值不是字符串：${key}`);

        if (key === LOCAL_STORAGE_KEYS.modelRegistry) {
            try {
                const parsed = JSON.parse(value);
                if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                    throw new Error('模型注册表不是合法对象');
                }
                const record = parsed as Record<string, unknown>;
                const hasImageModels = Array.isArray(record.imageModels);
                const hasTextModels = Array.isArray(record.textModels);
                const hasDefaults = isBackupRecord(record.defaults);
                if (!hasImageModels || !hasTextModels || !hasDefaults) {
                    throw new Error('模型注册表缺少 imageModels、textModels 或 defaults');
                }
            } catch (error) {
                throw new Error('备份文件中的模型注册表无效', { cause: error });
            }
        }
        validated[key] = value;
    }
    return validated;
}

/**
 * 校验所有 IndexedDB 清单均符合“数据库 -> store -> 记录数组”的备份结构。
 * @param data 已从 ZIP 中解析出的 IndexedDB 清单集合。
 * @returns 无返回值；任何结构错误都会在清理浏览器数据前抛出。
 */
function validateIndexedDbBackup(data: IndexedDBBackup): void {
    let managedRecordCount = 0;
    for (const [dbName, dbData] of Object.entries(data)) {
        if (!isBackupRecord(dbData)) throw new Error(`备份文件中的 IndexedDB 清单不是合法对象：${dbName}`);
        for (const [storeName, records] of Object.entries(dbData)) {
            if (!Array.isArray(records) || records.some(record => !isBackupRecord(record))) {
                throw new Error(`备份文件中的 IndexedDB store 清单无效：${dbName}/${storeName}`);
            }
        }

        const contract = INDEXEDDB_DATABASES.find(item => item.name === dbName);
        if (!contract) continue;
        for (const storeContract of contract.stores) {
            const records = dbData[storeContract.name];
            if (!records) continue;
            managedRecordCount += records.length;
            for (const [index, record] of records.entries()) {
                if (storeContract.keyPath === undefined) {
                    if (!Object.prototype.hasOwnProperty.call(record, '_idbKey')
                        || !Object.prototype.hasOwnProperty.call(record, '_idbValue')) {
                        throw new Error(`备份文件中的 IndexedDB 外部主键缺失：${dbName}/${storeContract.name}[${index}]`);
                    }
                    if (!isValidBackupIndexedDbKey(record._idbKey)) {
                        throw new Error(`备份文件中的 IndexedDB 外部主键无效：${dbName}/${storeContract.name}[${index}]`);
                    }
                    continue;
                }

                const keyPaths = Array.isArray(storeContract.keyPath) ? storeContract.keyPath : [storeContract.keyPath];
                for (const keyPath of keyPaths) {
                    const keyValue = getBackupValueByKeyPath(record, keyPath);
                    if (keyValue === undefined) {
                        throw new Error(`备份文件中的 IndexedDB 主键缺失：${dbName}/${storeContract.name}[${index}].${keyPath}`);
                    }
                    if (!isValidBackupIndexedDbKey(keyValue)) {
                        throw new Error(`备份文件中的 IndexedDB 主键无效：${dbName}/${storeContract.name}[${index}].${keyPath}`);
                    }
                }
            }
        }
    }

    if (managedRecordCount > 0 && typeof indexedDB === 'undefined') {
        throw new Error('当前浏览器不支持 IndexedDB，无法恢复备份中的数据库记录');
    }
}

/**
 * 按 IndexedDB keyPath 读取备份记录中的嵌套字段。
 * @param record 待检查的备份记录。
 * @param keyPath 使用点号分隔的 IndexedDB keyPath。
 * @returns keyPath 对应的值；路径不存在时返回 undefined。
 */
function getBackupValueByKeyPath(record: BackupRecord, keyPath: string): unknown {
    let current: unknown = record;
    for (const segment of keyPath.split('.')) {
        if (!isBackupRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
        current = current[segment];
    }
    return current;
}

/**
 * 判断从 JSON 备份读取的值能否作为 IndexedDB 主键。
 * @param value 待校验的主键值。
 * @returns 字符串、有限数字或由合法主键组成的数组返回 true。
 */
function isValidBackupIndexedDbKey(value: unknown): boolean {
    if (typeof value === 'string') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    return Array.isArray(value) && value.every(isValidBackupIndexedDbKey);
}

/**
 * 校验所有 localForage 清单均包含合法 store 数组与字符串 key。
 * @param data 已从 ZIP 中解析出的 localForage 清单集合。
 * @returns 无返回值；任何结构错误都会在清理浏览器数据前抛出。
 */
function validateLocalForageBackup(data: LocalForageBackup): void {
    for (const [dbName, dbData] of Object.entries(data)) {
        if (!isBackupRecord(dbData)) throw new Error(`备份文件中的 localForage 清单不是合法对象：${dbName}`);
        for (const [storeName, entries] of Object.entries(dbData)) {
            if (!Array.isArray(entries)) {
                throw new Error(`备份文件中的 localForage store 清单无效：${dbName}/${storeName}`);
            }
            for (const entry of entries) {
                if (!isBackupRecord(entry) || typeof entry.key !== 'string') {
                    throw new Error(`备份文件中的 localForage 条目无效：${dbName}/${storeName}`);
                }
                const directBlob = isBlobRef(entry);
                if (!directBlob && !Object.prototype.hasOwnProperty.call(entry, 'value')) {
                    throw new Error(`备份文件中的 localForage 条目缺少 value：${dbName}/${storeName}/${entry.key}`);
                }
            }
        }
    }
}

/**
 * 用已校验的备份数据完整替换契约管理的 localStorage 内容。
 * @param data 已通过预检的 localStorage 键值映射。
 * @returns 无返回值；任何删除或写入失败都会抛出包含具体 key 的错误。
 */
function importLocalStorage(data: Record<string, string>): void {
    const previousData = exportLocalStorage();
    try {
        replaceManagedLocalStorage(data);
    } catch (error) {
        try {
            replaceManagedLocalStorage(previousData);
        } catch (rollbackError) {
            throw new Error('恢复 localStorage 失败，且无法回滚原有数据', { cause: rollbackError });
        }
        throw error;
    }
}

/**
 * 清空全部受管 key 后写入指定 localStorage 快照。
 * @param data 需要写入的完整受管键值映射。
 * @returns 无返回值；删除或写入失败时抛出包含具体 key 的错误。
 */
function replaceManagedLocalStorage(data: Record<string, string>): void {
    for (const key of LOCAL_STORAGE_BACKUP_KEYS) {
        try {
            localStorage.removeItem(key);
        } catch (error) {
            throw new Error(`清理 localStorage 失败：${key}`, { cause: error });
        }
    }
    for (const [key, value] of Object.entries(data)) {
        try {
            localStorage.setItem(key, value);
        } catch (error) {
            throw new Error(`恢复 localStorage 失败：${key}`, { cause: error });
        }
    }
}

/**
 * 删除完整导入前的 IndexedDB 数据库。
 * @param name 待删除的数据库名称。
 * @returns 数据库确认删除后完成的 Promise。
 */
async function deleteDatabase(name: string): Promise<void> {
    if (typeof indexedDB === 'undefined') return;

    // 图片数据库由单例连接层长期复用，删除前必须主动释放当前页连接，否则请求会持续 blocked。
    if (name === INDEXED_DB.images.name) await closeImageDb();

    return new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => {
            // 删除请求被其他页面连接阻塞时立即终止恢复，避免后续写入与旧记录混合。
            reject(new Error(`IndexedDB 数据库 ${name} 正被其他页面占用，请关闭其他标签页后重试`));
        };
    });
}

/**
 * 导入单个 store 的数据
 */
async function importStore(db: IDBDatabase, storeName: string, records: BackupRecord[], unzipped: Record<string, Uint8Array>): Promise<void> {
    // 先异步预处理记录：从解压数据提取二进制 / base64 解码
    const processedRecords = await Promise.all(
        records.map(async (record) => {
            const hydrated = await importBackupValue(record, unzipped);
            const processed = isBackupRecord(hydrated) ? hydrated : { _idbValue: hydrated };

            // 旧格式兼容：base64 字符串 + 顶层 _blobMimeType。
            if (typeof processed.blob === 'string' && typeof processed._blobMimeType === 'string') {
                processed.blob = base64ToBlob(processed.blob, processed._blobMimeType);
            }

            // 清理旧格式遗留的 _blobMimeType（新格式按字段内嵌携带）
            if ('_blobMimeType' in processed && typeof processed._blobMimeType === 'string') {
                delete processed._blobMimeType;
            }

            return processed;
        })
    );

    // 再写回 IndexedDB
    return new Promise((resolve, reject) => {
        try {
            const transaction = db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);

            for (const processedRecord of processedRecords) {
                if ('_idbKey' in processedRecord && '_idbValue' in processedRecord) {
                    // keyless store 必须显式传回原始 key，否则视频 Blob 无法按任务 ID 恢复。
                    store.put(processedRecord._idbValue, processedRecord._idbKey as IDBValidKey);
                } else {
                    store.put(processedRecord);
                }
            }

            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        } catch (error) {
            reject(error);
        }
    });
}

/**
 * 导入 IndexedDB 数据
 */
async function importIndexedDB(data: IndexedDBBackup, unzipped: Record<string, Uint8Array>, onProgress?: ProgressCallback): Promise<void> {
    let completedStores = 0;
    const totalStores = Object.values(data).reduce((sum, dbData) => sum + Object.keys(dbData).length, 0);

    for (const dbConfig of INDEXEDDB_DATABASES) {
        const dbData = data[dbConfig.name];
        // 完整导入必须先删除全部受管数据库；旧备份缺少新数据库时也不能保留当前脏数据。
        await deleteDatabase(dbConfig.name);
        if (!dbData) continue;

        // 删除后重新打开数据库，由统一契约创建全部 stores 与索引。
        const db = await openDatabase(dbConfig);
        if (!db) {
            continue;
        }

        try {
            for (const storeConfig of dbConfig.stores) {
                const storeName = storeConfig.name;
                const storeData = dbData[storeName];
                if (!storeData || !Array.isArray(storeData)) continue;

                if (!db.objectStoreNames.contains(storeName)) {
                    throw new Error(`IndexedDB 结构不完整：${dbConfig.name}/${storeName}`);
                }

                await importStore(db, storeName, storeData, unzipped);

                completedStores++;
                if (onProgress) {
                    const percent = 20 + Math.floor((completedStores / totalStores) * 70);
                    onProgress({
                        percent,
                        message: 'settings.backupProgressImportStore',
                        values: { store: `${dbConfig.name}/${storeName}` },
                    });
                }
            }
        } catch (error) {
            throw new Error(`恢复 IndexedDB 失败：${dbConfig.name}`, { cause: error });
        } finally {
            db.close();
        }
    }
}

/**
 * 从 ZIP 文件导入所有数据（覆盖现有数据）
 * 使用 fflate 解压，兼容新版和旧版（JSZip 生成的）备份格式
 */
export async function importAllData(file: File, onProgress?: ProgressCallback): Promise<void> {
    if (onProgress) {
        onProgress({ percent: 0, message: 'settings.backupProgressImportStart' });
    }

    // 解压 ZIP 文件
    if (onProgress) {
        onProgress({ percent: 5, message: 'settings.backupProgressUnzip' });
    }

    const buffer = await file.arrayBuffer();
    const unzipped = unzipSync(new Uint8Array(buffer));

    // 辅助：从解压结果读取文本
    const readText = (path: string): string | null => {
        const data = unzipped[path];
        return data ? new TextDecoder().decode(data) : null;
    };

    const metadataText = readText('metadata.json');
    if (metadataText) {
        const metadataValue = JSON.parse(metadataText);
        if (!isBackupRecord(metadataValue)) throw new Error('备份文件中的 metadata.json 不是合法对象');
        const metadata = metadataValue as Record<string, unknown>;
        if (metadata.incremental === true) {
            throw new Error('不支持导入非完整备份文件，请选择完整备份文件');
        }
        const rawContractVersion = metadata.storageContractVersion;
        const backupContractVersion = rawContractVersion === undefined ? 0 : Number(rawContractVersion);
        if (!Number.isInteger(backupContractVersion) || backupContractVersion < 0) {
            throw new Error('备份文件中的存储契约版本无效');
        }
        if (backupContractVersion > STORAGE_CONTRACT_VERSION) {
            throw new Error(`备份存储契约版本 ${backupContractVersion} 高于当前支持版本 ${STORAGE_CONTRACT_VERSION}，请升级应用后再导入`);
        }
    }

    // 在执行任何删除前完整解析备份清单，确保损坏的 JSON 不会导致现有数据被部分清空。
    const localStorageText = readText('localStorage.json');
    if (!localStorageText) throw new Error('备份文件缺少 localStorage.json，无法执行完整恢复');
    const localStorageData = validateLocalStorageBackup(JSON.parse(localStorageText));

    const indexedDBData: IndexedDBBackup = {};
    for (const [path, data] of Object.entries(unzipped)) {
        if (path.startsWith('indexedDB/') && path.endsWith('.json')) {
            const dbName = path.replace('indexedDB/', '').replace('.json', '');
            indexedDBData[dbName] = JSON.parse(new TextDecoder().decode(data));
        }
    }

    const localForageData: LocalForageBackup = {};
    for (const [path, data] of Object.entries(unzipped)) {
        if (path.startsWith('localforage/') && path.endsWith('.json')) {
            const dbName = path.replace('localforage/', '').replace('.json', '');
            localForageData[dbName] = JSON.parse(new TextDecoder().decode(data));
        }
    }
    validateIndexedDbBackup(indexedDBData);
    validateLocalForageBackup(localForageData);
    validateBlobReferences(indexedDBData, unzipped, 'indexedDB');
    validateBlobReferences(localForageData, unzipped, 'localforage');

    if (onProgress) {
        onProgress({ percent: 10, message: 'settings.backupProgressClearStorage' });
    }

    if (onProgress) {
        onProgress({ percent: 15, message: 'settings.backupProgressImportStorage' });
    }
    // 记录当前配置快照；后续数据库恢复失败时回滚，避免出现配置与历史数据不一致的半恢复状态。
    const previousLocalStorageData = exportLocalStorage();
    importLocalStorage(localStorageData);

    try {
        await importIndexedDB(indexedDBData, unzipped, onProgress);

        if (onProgress) {
            onProgress({ percent: 92, message: 'settings.backupProgressCanvas' });
        }
        await importLocalForage(localForageData, unzipped);
    } catch (error) {
        try {
            replaceManagedLocalStorage(previousLocalStorageData);
        } catch (rollbackError) {
            throw new Error('恢复数据失败，且无法回滚原有 localStorage', { cause: rollbackError });
        }
        throw error;
    }

    if (onProgress) {
        onProgress({ percent: 100, message: 'settings.backupProgressImportDone' });
    }
}

/**
 * 下载 Blob 为文件
 */
export function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Safari 需要延迟撤销，否则下载可能失败
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 生成备份文件名
 */
export function generateBackupFilename(): string {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-');
    return `flyreq-backup-${dateStr}-${timeStr}.zip`;
}
